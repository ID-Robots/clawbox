import { NextRequest, NextResponse } from "next/server";
import { POST as configureAiModelsPost } from "@/app/setup-api/ai-models/configure/route";
import { clearClawAiSession, isClawAiSessionExpired, readClawAiSession, writeClawAiSession } from "@/lib/clawai-connect";

export const dynamic = "force-dynamic";

const CLAWBOX_AI_EXCHANGE_URL = process.env.CLAWBOX_AI_EXCHANGE_URL?.trim() || "https://openclawhardware.dev/api/clawbox-ai/exchange";

function html(status: "complete" | "error", message: string) {
  const safeMessage = message.replace(/[<>&]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
  }[char] || char));

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClawBox AI</title>
    <style>
      body { font-family: sans-serif; background: #0f1726; color: white; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { width: min(92vw, 420px); background: rgba(30,41,57,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 20px; padding: 24px; }
      .muted { color: rgba(255,255,255,.7); font-size: 14px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${status === "complete" ? "ClawBox AI connected" : "ClawBox AI connection failed"}</h1>
      <p class="muted">${safeMessage}</p>
      <p class="muted">You can return to your device now.</p>
    </div>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            type: "clawbox-clawai-auth",
            status: "${status}",
            message: "${safeMessage}",
          }, "*");
        }
      } catch {}
      setTimeout(() => { try { window.close(); } catch {} }, 250);
    </script>
  </body>
</html>`;
}

function htmlResponse(status: "complete" | "error", message: string) {
  return new NextResponse(html(status, message), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function formatUserFacingError(message: string) {
  const normalized = message.trim();
  if (/token limit reached/i.test(normalized)) {
    return "ClawBox AI could not create a new login token because your account has reached its token limit. Remove an old token in the portal or upgrade your plan, then try again.";
  }
  return normalized || "ClawBox AI login failed.";
}

async function readErrorBody(response: Response) {
  const bodyText = await response.text().catch(() => "");
  if (!bodyText) return "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
    return parsed.error || parsed.message || bodyText;
  } catch {
    return bodyText;
  }
}

export async function GET(request: NextRequest) {
  const session = await readClawAiSession();
  const state = request.nextUrl.searchParams.get("state")?.trim() || "";
  const code = request.nextUrl.searchParams.get("code")?.trim() || "";
  const error = request.nextUrl.searchParams.get("error")?.trim() || "";

  if (!session) {
    return htmlResponse("error", "No pending ClawBox AI login session was found.");
  }

  if (isClawAiSessionExpired(session)) {
    await clearClawAiSession();
    return htmlResponse("error", "ClawBox AI login expired. Please try again.");
  }

  if (!state || state !== session.state) {
    const message = "ClawBox AI login state did not match. Please try again.";
    await writeClawAiSession({ ...session, status: "error", error: message });
    return htmlResponse("error", message);
  }

  if (error) {
    await writeClawAiSession({ ...session, status: "error", error });
    return htmlResponse("error", error);
  }

  if (!code) {
    await writeClawAiSession({ ...session, status: "error", error: "Missing ClawBox AI authorization code." });
    return htmlResponse("error", "Missing ClawBox AI authorization code.");
  }

  try {
    const exchangeRes = await fetch(CLAWBOX_AI_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        state,
        redirect_uri: session.redirectUri,
        device_name: session.deviceName,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!exchangeRes.ok) {
      const errorMessage = await readErrorBody(exchangeRes) || `ClawBox AI exchange failed (${exchangeRes.status})`;
      const userFacingMessage = formatUserFacingError(errorMessage);
      console.error("[ClawBox AI] Token exchange failed", {
        status: exchangeRes.status,
        error: errorMessage,
        redirectUri: session.redirectUri,
      });
      await writeClawAiSession({ ...session, status: "error", error: userFacingMessage });
      return htmlResponse("error", userFacingMessage);
    }

    const tokenData = await exchangeRes.json() as { access_token?: string };
    if (!tokenData.access_token?.trim()) {
      const message = "No ClawBox AI token was returned.";
      await writeClawAiSession({ ...session, status: "error", error: message });
      return htmlResponse("error", message);
    }

    const configureResponse = await configureAiModelsPost(new Request("http://localhost/setup-api/ai-models/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: session.scope,
        provider: "clawai",
        apiKey: tokenData.access_token.trim(),
      }),
    }));

    if (!configureResponse.ok) {
      const configureBody = await configureResponse.text().catch(() => "");
      const userFacingMessage = formatUserFacingError(configureBody || "Failed to save ClawBox AI token.");
      console.error("[ClawBox AI] Token save failed", {
        status: configureResponse.status,
        error: configureBody || "Failed to save ClawBox AI token.",
      });
      await writeClawAiSession({ ...session, status: "error", error: userFacingMessage });
      return htmlResponse("error", userFacingMessage);
    }

    await writeClawAiSession({
      ...session,
      status: "complete",
      error: null,
      completedAt: Date.now(),
    });

    return htmlResponse("complete", "ClawBox AI is now connected on this device.");
  } catch (err) {
    const message = formatUserFacingError(err instanceof Error ? err.message : "ClawBox AI connection failed.");
    console.error("[ClawBox AI] Callback request failed", { error: message, redirectUri: session.redirectUri });
    await writeClawAiSession({ ...session, status: "error", error: message });
    return htmlResponse("error", message);
  }
}
