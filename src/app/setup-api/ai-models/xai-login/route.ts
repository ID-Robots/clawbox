import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/same-origin";
import { logSafe } from "@/lib/log-safe";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import {
  cancelXaiLogin,
  pollXaiLogin,
  readXaiStoredProfiles,
  startXaiLogin,
} from "@/lib/xai-oauth-login";

export const dynamic = "force-dynamic";

/**
 * POST { action: "start" | "poll" | "cancel" } — the xAI (Grok) sign-in the
 * AI provider panel drives. The same verb set and shape as the Coding Agent's
 * GitHub login (`/setup-api/coding-agent/github-login`), because it is the
 * same interaction: show a one-time code with a tappable link, poll until the
 * owner approves it on another device.
 *
 * What differs is who talks to the vendor: here it is the core's bundled `xai`
 * plugin, through `openclaw models auth login` (src/lib/xai-oauth-login.ts),
 * which stores the credential itself. This route therefore ends at "the CLI
 * finished"; the browser then posts `/setup-api/ai-models/configure` with
 * `{provider: "xai", authMode: "subscription"}`, which checks the store really
 * holds the sign-in and does everything an API-key save does after the
 * credential write — primary model, config-store flags, session switch,
 * catalogue refresh, gateway restart.
 *
 * OUR PAGE ONLY, for the reason the GitHub route gives: the owner's browser
 * attaches its session cookie to a POST any site fires at the box, and this
 * starts a flow that ends with this box holding somebody's credential.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Signing in to xAI only works from this ClawBox's own pages.", kind: "cross_origin" },
      { status: 403 },
    );
  }
  if (openclawIsAbsent()) {
    return NextResponse.json(
      { error: "This provider is set up through the Hermes provider panel on this edition." },
      { status: 400 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const requested = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { action?: unknown }).action
    : undefined;
  // Drawn from the allow-list rather than compared against it — the same
  // closed-set dispatch the GitHub route uses, for the same reason.
  const ACTIONS = ["start", "poll", "cancel"] as const;
  const verb = ACTIONS.find((candidate) => candidate === requested);
  if (!verb) {
    return NextResponse.json({ error: `Unknown action: ${logSafe(String(requested))}` }, { status: 400 });
  }

  try {
    if (verb === "start") {
      // `--force` only when there is something to replace: it drops every xai
      // profile BEFORE the sign-in, so on a box holding an API key a cancelled
      // sign-in leaves no xAI credential at all — which the panel says before
      // the owner starts. An unreadable store is treated as "something there":
      // without `--force` a login onto an occupied profile id may be refused,
      // and that refusal would be the worse surprise.
      //
      // Measured on a box: a cancelled or timed-out attempt leaves no profile
      // behind, so a box with nothing stored gets no `--force` and loses
      // nothing either way.
      const stored = await readXaiStoredProfiles();
      const out = await startXaiLogin({
        replaceExisting: stored === null || stored.length > 0,
        // A sign-in already at the id cannot later prove THIS login landed;
        // the lib then waits for the CLI's own exit code.
        signInAlreadyStored: stored === null
          || stored.some((row) => row.id === "xai:default" && row.type === "oauth"),
      });
      return NextResponse.json(out, { status: out.status === "failed" ? 502 : 200 });
    }
    if (verb === "poll") {
      return NextResponse.json(pollXaiLogin());
    }
    cancelXaiLogin();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[xai-login] failed:", err instanceof Error ? logSafe(err.message) : err);
    return NextResponse.json({ status: "failed", detail: "The xAI sign-in failed. Try again." }, { status: 500 });
  }
}
