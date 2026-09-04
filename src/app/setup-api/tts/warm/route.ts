export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { KOKORO_UNIT, readUnitState, startUserEngine } from "@/lib/local-models";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * POST /setup-api/tts/warm → ask the box's own voice to wake up.
 *
 * The Kokoro server holds the model on the GPU and stops itself after five
 * idle minutes, and nothing on the box brings it back: the first spoken reply
 * after a quiet spell pays a 13-19 s cold start, which reads as a hang and
 * usually loses the race to the cloud voice. The two surfaces that KNOW a
 * spoken reply is coming — the chat's microphone button and the Voice tab's
 * "This box" pick — call this the moment the person acts, so the model is
 * resident by the time there is anything to say.
 *
 * It starts a unit and nothing else: never `enable`, so an engine the owner
 * switched off for good stays off at the next boot (that is Local AI's switch,
 * `setEngineEnabled`), and never a unit name from the client — the one this
 * route can name is `KOKORO_UNIT`, checked again by the allow-list inside
 * `startUserEngine`.
 *
 * Owner cookie AND our own origin, the pattern `tts/speak` keeps: spawning
 * systemctl is not something another site's page may do with the cookie it
 * rides on, and the agent's MCP bearer — which the middleware also admits
 * here — is not the person.
 *
 * Deliberately NOT gated on the edition. The Kokoro unit is written by
 * install-voice.sh on every SKU and both harnesses speak through the same
 * script, so a Hermes box warms exactly the same engine; what says "there is
 * nothing to warm here" is the unit being absent, which is asked below.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json(
      { error: "Warming the voice needs a signed-in browser session.", code: "owner_only" },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json(
      { error: "Warming the voice only works from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403, headers: NO_STORE },
    );
  }
  try {
    const unit = await readUnitState(KOKORO_UNIT, "user");
    if (!unit.present) {
      return NextResponse.json(
        { error: "This box has no voice of its own to warm up.", code: "not_installed" },
        { status: 409, headers: NO_STORE },
      );
    }
    // Already up: the model is resident and the next reply is ~2 s. Answered
    // rather than started again, so a chat that presses the microphone twice
    // does not queue systemd work behind itself.
    if (unit.active) return NextResponse.json({ warm: true }, { headers: NO_STORE });
    const started = await startUserEngine(KOKORO_UNIT);
    if (!started.ok) {
      return NextResponse.json(
        { error: started.error ?? "Could not start the voice on this box.", code: "start_failed" },
        { status: 502, headers: NO_STORE },
      );
    }
    // 202: systemd has the request, the model is not loaded yet. Nothing waits
    // on this — a caller that hears nothing back still gets its reply, just
    // from a cold start or from the cloud voice.
    return NextResponse.json({ warming: true }, { status: 202, headers: NO_STORE });
  } catch (err) {
    console.warn("[setup-api/tts/warm] could not warm the voice:", err);
    return NextResponse.json(
      { error: "Could not start the voice on this box.", code: "start_failed" },
      { status: 502, headers: NO_STORE },
    );
  }
}
