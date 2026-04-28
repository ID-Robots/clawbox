import { NextRequest, NextResponse } from "next/server";

import { writeToken, ClawKeepError } from "@/lib/clawkeep";
import {
  clearClawKeepSession,
  isClawKeepSessionExpired,
  readClawKeepSession,
  writeClawKeepSession,
} from "@/lib/clawkeep-connect";

export const dynamic = "force-dynamic";

// Token exchange endpoint per clawkeep-plan.md §4.6.
const CLAWKEEP_EXCHANGE_URL =
  process.env.CLAWKEEP_EXCHANGE_URL?.trim() ||
  "https://openclawhardware.dev/api/portal/connect/exchange";

function escape(s: string) {
  return s.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] || c),
  );
}

function html(status: "complete" | "error", message: string) {
  const safe = escape(message);
  // For the inline <script>, interpolate via JSON.stringify so any quotes,
  // backslashes, or newlines in `message` can't break out of the JS string
  // literal — HTML-escaping alone wouldn't stop `\` or `</script>`.
  const statusLiteral = JSON.stringify(status);
  const messageLiteral = JSON.stringify(message).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClawKeep</title>
    <style>
      body { font-family: sans-serif; background: #0f1726; color: white; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { width: min(92vw, 420px); background: rgba(30,41,57,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 20px; padding: 24px; }
      .muted { color: rgba(255,255,255,.7); font-size: 14px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${status === "complete" ? "ClawKeep paired" : "ClawKeep pairing failed"}</h1>
      <p class="muted">${safe}</p>
      <p class="muted">You can return to your device now.</p>
    </div>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            type: "clawbox-clawkeep-auth",
            status: ${statusLiteral},
            message: ${messageLiteral},
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
  const session = await readClawKeepSession();
  const state = request.nextUrl.searchParams.get("state")?.trim() || "";
  const code = request.nextUrl.searchParams.get("code")?.trim() || "";
  const error = request.nextUrl.searchParams.get("error")?.trim() || "";

  if (!session) {
    return htmlResponse("error", "No pending ClawKeep pairing session was found.");
  }

  if (isClawKeepSessionExpired(session)) {
    await clearClawKeepSession();
    return htmlResponse("error", "ClawKeep pairing expired. Please try again.");
  }

  if (!state || state !== session.state) {
    const message = "ClawKeep pairing state did not match. Please try again.";
    await writeClawKeepSession({ ...session, status: "error", error: message });
    return htmlResponse("error", message);
  }

  if (error) {
    await writeClawKeepSession({ ...session, status: "error", error });
    return htmlResponse("error", error);
  }

  if (!code) {
    const message = "Missing ClawKeep authorization code.";
    await writeClawKeepSession({ ...session, status: "error", error: message });
    return htmlResponse("error", message);
  }

  try {
    const exchangeRes = await fetch(CLAWKEEP_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        state,
        device_id: session.deviceName,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!exchangeRes.ok) {
      const errMsg = (await readErrorBody(exchangeRes)) || `ClawKeep exchange failed (${exchangeRes.status})`;
      console.error("[ClawKeep] Token exchange failed", {
        status: exchangeRes.status,
        error: errMsg,
        redirectUri: session.redirectUri,
      });
      await writeClawKeepSession({ ...session, status: "error", error: errMsg });
      return htmlResponse("error", errMsg);
    }

    const tokenData = (await exchangeRes.json()) as { access_token?: string };
    const accessToken = tokenData.access_token?.trim() ?? "";
    if (!accessToken.startsWith("claw_")) {
      const message = "Portal returned malformed ClawKeep token.";
      await writeClawKeepSession({ ...session, status: "error", error: message });
      return htmlResponse("error", message);
    }

    try {
      await writeToken(accessToken);
    } catch (err) {
      const message =
        err instanceof ClawKeepError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to save ClawKeep token.";
      await writeClawKeepSession({ ...session, status: "error", error: message });
      return htmlResponse("error", message);
    }

    await writeClawKeepSession({
      ...session,
      status: "complete",
      error: null,
      completedAt: Date.now(),
    });
    return htmlResponse("complete", "This device is now paired with your portal account.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "ClawKeep pairing failed.";
    console.error("[ClawKeep] Callback failed", { error: message, redirectUri: session.redirectUri });
    await writeClawKeepSession({ ...session, status: "error", error: message });
    return htmlResponse("error", message);
  }
}
