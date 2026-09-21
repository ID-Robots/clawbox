export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  applyClawaiCloudDefaults,
  readCloudDefaultsStatus,
} from "@/lib/clawai-cloud-defaults";
import { clearOwnerChoice } from "@/lib/clawai-cloud-choice";
import { CLOUD_CAPABILITIES, type CloudCapability } from "@/lib/clawai-cloud-defaults-state";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * GET  /setup-api/ai-cloud-defaults               → where speech out, speech in
 *                                                   and memory embeddings are
 *                                                   served from, and where the
 *                                                   subscription says they
 *                                                   should be
 * POST /setup-api/ai-cloud-defaults {capability}  → hand one capability back to
 *                                                   the ClawBox AI cloud
 *
 * The owner's decision of 2026-09-14. The GET carries no credential and no
 * endpoint — a plan word, three engine names and three reasons — so it is
 * readable the way `/setup-api/tts` is; the agent holding the MCP bearer learns
 * nothing from it that the Voice tab does not already say out loud.
 *
 * THERE IS DELIBERATELY NO "USE LOCAL" VERB HERE. Each capability already has a
 * route that moves it onto the engine on the box — `/setup-api/tts`
 * (`{action:"select",choice:"local"}`), `/setup-api/stt` (`{primary:"local"}`)
 * and `/setup-api/clawkeep/memory/provider` — and each of those records the
 * owner's pin on the way through. A second implementation here would be a
 * second set of refusals, a second harness branch and a second chance to
 * disagree with the panel about what actually happened.
 *
 * So the one thing this POST does is the thing no existing route could: take a
 * pin OFF and let the automatic default move the capability back to the cloud.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function GET() {
  try {
    return NextResponse.json(await readCloudDefaultsStatus(), { headers: NO_STORE });
  } catch (err) {
    console.warn("[setup-api/ai-cloud-defaults] could not read the cloud defaults:", err);
    return NextResponse.json({ error: "Could not read where this box runs its AI." }, { status: 500 });
  }
}

function isCapability(value: unknown): value is CloudCapability {
  return typeof value === "string" && (CLOUD_CAPABILITIES as readonly string[]).includes(value);
}

export async function POST(req: Request) {
  // OWNER ONLY, and from OUR page. Where a recording, the words this box speaks
  // and the owner's own documents are sent is the person's decision — so the
  // agent, which holds the MCP bearer the middleware also admits here, may not
  // make it, and neither may a POST another site's page fires at the box with
  // the owner's cookie riding along. The same pair `/setup-api/stt` and the
  // Memory Shard provider route keep.
  if (!(await hasOwnerSession(req))) {
    return refuse("Changing where this box runs its AI needs a signed-in browser session.", "owner_only", 403);
  }
  if (!isSameOriginRequest(req)) {
    return refuse("This only works from this ClawBox's own pages.", "cross_origin", 403);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const capability = (body as { capability?: unknown } | null)?.capability;
  if (!isCapability(capability)) {
    return refuse("Name the voice, transcription or memory.", "bad_request", 400);
  }

  try {
    // The pin comes off first: the applier reads it, so clearing it after would
    // be asking the default to move something it has just been told not to.
    await clearOwnerChoice(capability);
    const applied = await applyClawaiCloudDefaults({ trigger: "owner" });
    const failure = applied.failed.find((entry) => entry.capability === capability);
    // The status is re-read whatever happened, so the panel paints what the box
    // now does rather than what was asked for. A capability the subscription
    // does not cover is not an error: the answer simply still says `local`,
    // with the reason beside it, which is what the row renders.
    const status = await readCloudDefaultsStatus();
    return NextResponse.json(
      { ...status, moved: applied.moved.includes(capability), ...(failure ? { warning: failure.error } : {}) },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.warn("[setup-api/ai-cloud-defaults] could not hand the capability back to the cloud:", err);
    return refuse("Could not change where this box runs that.", "failed", 500);
  }
}
