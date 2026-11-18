export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { readHermesSessionBytes, withHermesStateHome } from "@/lib/harness/hermes-turn-record";
import { staffHermesProfilePaths } from "@/lib/hermes-staff-profile";
import { orgMemberStrictOf } from "@/lib/org-mode-server";
import { readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { getLlamaCppServerContextSize } from "@/lib/llamacpp";
import { requireSession } from "@/lib/route-auth";

/**
 * How large a Hermes conversation is, for the chat's long-chat check on Local
 * AI (TASK-2127; the OpenClaw twin is the gateway's own `sessions.describe`).
 *
 * GET ?sessionId=<Hermes session id> → `{ tokens, window, limit }`
 *
 *  - `tokens`: an ESTIMATE — the live rows of the session in `state.db`
 *    (`readHermesSessionBytes`), a token per four bytes. The local turn's own
 *    prompt is the lean one (~1.3k characters, scripts/hermes-plugins/
 *    clawbox_local_lean), so the history is what decides. Null when the store
 *    could not be read: the chat then sends as it always did.
 *  - `window`: what llama-server serves while Hermes is the runtime
 *    (`getLlamaCppServerContextSize("hermes")`, 65536 — Hermes' own floor).
 *  - `limit`: where Hermes compresses before the local model can answer —
 *    `compression.threshold` of the window (Hermes ships 0.50), capped by
 *    `compression.threshold_tokens` when set; null with compression off.
 *
 * The id is ours to check: it reaches a SQL parameter only, but a value that is
 * not a Hermes session id has no business being asked about.
 */
const SESSION_ID = /^(?:[0-9]{8}_[0-9]{6}_[0-9a-f]{6}|local-[0-9a-f]{64})$/;

/** Hermes' shipped `compression.threshold` (its configuration guide). */
const HERMES_DEFAULT_COMPRESSION_THRESHOLD = 0.5;

/** Bytes of chat text per token, the estimate's one constant. */
const BYTES_PER_TOKEN = 4;

async function compressionLimit(window: number): Promise<number | null> {
  const [enabled, threshold, thresholdTokens] = await Promise.all([
    readHermesConfigValue("compression.enabled"),
    readHermesConfigValue("compression.threshold"),
    readHermesConfigValue("compression.threshold_tokens"),
  ]);
  if (enabled?.trim().toLowerCase() === "false") return null;
  const ratio = Number(threshold);
  const share = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : HERMES_DEFAULT_COMPRESSION_THRESHOLD;
  let limit = Math.floor(window * share);
  const cap = Number(thresholdTokens);
  if (thresholdTokens !== null && Number.isFinite(cap) && cap > 0) limit = Math.min(limit, Math.floor(cap));
  return limit;
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ tokens: null, window: null, limit: null });
  }
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!SESSION_ID.test(sessionId)) {
    return NextResponse.json({ error: "A Hermes session id is required." }, { status: 400 });
  }
  // A member of staff's conversations are in their own profile's store
  // (src/lib/hermes-staff-profile.ts), and only those are measured for them;
  // a box whose switch cannot be read measures nothing for a non-owner.
  const member = await orgMemberStrictOf(request);
  const home = member && member !== "unknown" ? staffHermesProfilePaths(member.username)?.home : undefined;
  const window = getLlamaCppServerContextSize("hermes");
  const [bytes, limit] = await Promise.all([
    member && !home ? Promise.resolve(null) : withHermesStateHome(home, () => readHermesSessionBytes(sessionId)),
    compressionLimit(window),
  ]);
  return NextResponse.json(
    { tokens: bytes === null ? null : Math.ceil(bytes / BYTES_PER_TOKEN), window, limit },
    { headers: { "Cache-Control": "no-store" } },
  );
}
