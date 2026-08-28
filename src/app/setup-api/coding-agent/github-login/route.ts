import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { cancelDeviceLogin, pollDeviceLogin, startDeviceLogin } from "@/lib/coding-github";

export const dynamic = "force-dynamic";

/**
 * POST { action: "start" | "poll" | "cancel" } — the GitHub device-flow login
 * the Coding Agent app drives, so connecting works from a phone: the card
 * shows the one-time code with a tappable github.com link and polls here
 * until the owner approves. No terminal, and no token ever in a response —
 * the credential goes from GitHub's answer straight to gh's stdin.
 *
 * OWNER-ONLY, all three actions, like enable and the git DELETE: this route
 * changes whose GitHub credential the box holds, and the party that gains
 * push access must not be the party that can grant it.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Connecting GitHub needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const action = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { action?: unknown }).action
    : undefined;

  try {
    if (action === "start") {
      const out = await startDeviceLogin();
      if ("error" in out) return NextResponse.json(out, { status: 503 });
      console.error("[coding-agent] GitHub device login started by the owner");
      return NextResponse.json(out);
    }
    if (action === "poll") {
      const out = await pollDeviceLogin();
      if (out.status === "connected") console.error(`[coding-agent] GitHub connected as ${out.login ?? "(unknown)"}`);
      return NextResponse.json(out);
    }
    if (action === "cancel") {
      cancelDeviceLogin();
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `Unknown action: ${String(action)}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The GitHub login failed" },
      { status: 500 },
    );
  }
}
