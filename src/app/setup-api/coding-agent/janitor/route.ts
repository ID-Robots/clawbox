import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  DEFAULT_RETENTION_DAYS,
  JanitorError,
  janitorPassRunning,
  MAX_REMOVALS_PER_PASS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  nextPassAt,
  planJanitorPass,
  readJanitorLog,
  readJanitorSettings,
  readJanitorState,
  runJanitorPass,
  saveJanitorSettings,
} from "@/lib/coding-folder-janitor";

export const dynamic = "force-dynamic";

/**
 * The folder janitor (src/lib/coding-folder-janitor.ts) — the Coding Agent
 * settings' "Clean up old run folders".
 *
 * GET               → { settings, limits, lastPass, nextPassAt, running, log }
 * GET ?plan=1       → the same, plus `plan`: the dry run — every candidate,
 *                     what a pass would do with it and why the rest is kept.
 *                     Changes nothing on disk.
 * POST { enabled?, retentionDays? } → the settings, validated whole (400
 *                     `invalid`), answered as { settings }.
 * POST { action: "clean" } → one pass now, even with the switch off — it is
 *                     the owner asking — answered as { result, lastPass }; 409
 *                     `busy` while another pass runs.
 *
 * WHO: the owner only (403 `owner_only` for anyone else signed in, and for
 * the agent's bearer: removing folders is the owner's call). A POST must come
 * from this ClawBox's own pages.
 */
export async function GET(request: Request) {
  const refused = await requireSession(request, { ownerOnly: true });
  if (refused) return refused;
  try {
    const wantPlan = new URL(request.url).searchParams.get("plan") === "1";
    const [settings, plan] = await Promise.all([readJanitorSettings(), wantPlan ? planJanitorPass() : Promise.resolve(null)]);
    return NextResponse.json({
      settings,
      limits: { minRetentionDays: MIN_RETENTION_DAYS, maxRetentionDays: MAX_RETENTION_DAYS, defaultRetentionDays: DEFAULT_RETENTION_DAYS, maxRemovalsPerPass: MAX_REMOVALS_PER_PASS },
      lastPass: readJanitorState().lastPass,
      nextPassAt: settings.enabled ? nextPassAt() : null,
      running: janitorPassRunning(),
      log: readJanitorLog(20),
      ...(plan ? { plan } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read the clean-up" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const refused = await requireSession(request, { ownerOnly: true });
  if (refused) return refused;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "The clean-up only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  try {
    if (body && typeof body === "object" && (body as { action?: unknown }).action === "clean") {
      const result = await runJanitorPass({ trigger: "manual", ignoreSwitch: true, throwIfBusy: true });
      return NextResponse.json({ result, lastPass: readJanitorState().lastPass });
    }
    if (body && typeof body === "object" && "action" in body) {
      return NextResponse.json({ error: "The only action is \"clean\".", kind: "invalid" }, { status: 400 });
    }
    return NextResponse.json({ settings: await saveJanitorSettings(body) });
  } catch (err) {
    if (err instanceof JanitorError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: err.kind === "busy" ? 409 : 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "The clean-up failed" }, { status: 500 });
  }
}
