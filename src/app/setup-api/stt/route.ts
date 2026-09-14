export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { resolveClawaiToken } from "@/lib/harness/credentials";
import { GatewayNotReadyError, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { clearOwnerChoice, noteOwnerChoice } from "@/lib/clawai-cloud-choice";
import { syncChannelAudio } from "@/lib/stt-channel";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { localSttInstalled } from "@/lib/stt-local";
import { getSttPrimary, isSttEngine, setSttPrimary, sttEngineOrder } from "@/lib/stt-preference";

/**
 * GET  /setup-api/stt            → which engine hears this box first, and what
 *                                  each engine can do
 * POST /setup-api/stt {primary}  → put ClawBox cloud or the box itself first
 *
 * The sibling of /setup-api/tts, for the other direction of speech. The one
 * preference reaches two surfaces: the chat microphone reads it per request
 * (src/app/setup-api/chat/transcribe), and channel voice notes get it as the
 * order of `tools.media.models[]` in openclaw.json, which is why a POST
 * here can end in a gateway restart.
 *
 * GET touches only the filesystem, plus one cached python import check. The
 * openclaw CLI costs 8-12 s of cold start on an Orin Nano and is spent only on
 * the POST that actually changes something.
 */

/**
 * The channel half runs through openclaw.json and the gateway, neither of
 * which the Hermes SKU has. The chat-mic half is edition-blind — the
 * preference is stored in ClawBox's own config and the transcribe route walks
 * it on every edition — so this is reported as a fact about one half, not
 * used to refuse the whole route. Same shape /setup-api/tts answers with.
 */
const EDITION_UNSUPPORTED = {
  supportedOnEdition: false,
  error: "Channel voice notes are an OpenClaw feature and are not part of this edition.",
} as const;

async function status() {
  const [primary, local, token] = await Promise.all([getSttPrimary(), localSttInstalled(), resolveClawaiToken()]);
  const cloudConfigured = token !== null;
  return {
    primary,
    engines: {
      cloud: { configured: cloudConfigured, label: "ClawBox cloud" },
      local: { installed: local.installed, label: "On this box", detail: local.detail },
    },
    // The engines this box can actually use, in the order it tries them. An
    // unlinked cloud or an uninstalled whisper is shown under `engines`, not
    // listed here as a step that will silently do nothing.
    chain: sttEngineOrder(primary).filter((engine) => (engine === "cloud" ? cloudConfigured : local.installed)),
    // The ACTIVE harness, not the edition — the same rule /setup-api/tts uses
    // and for the same reason: on a licensed dual box switched to Hermes,
    // `openclawIsAbsent()` is false while the gateway that serves channels is
    // not the one this box is talking through, so it reported channel voice
    // notes as working on a harness that serves none.
    channels: (await getActiveHarness()) === "openclaw" && !openclawIsAbsent()
      ? { supportedOnEdition: true as const }
      : EDITION_UNSUPPORTED,
  };
}

function noStore<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

export async function GET() {
  try {
    return noStore(await status());
  } catch (err) {
    console.warn("[setup-api/stt] could not read the transcription settings:", err);
    return NextResponse.json({ error: "Could not read the transcription settings." }, { status: 500 });
  }
}


export async function POST(req: Request) {
  // OWNER ONLY. Middleware admits every /setup-api/* call on the MCP bearer as
  // well, and the agent holds that bearer. Where a recording is sent is the
  // person's decision — off the box or not — so the agent is not allowed to
  // make it, whatever it has been told. Same helper and rule as
  // coding-agent/enable.
  //
  // AND SAME-ORIGIN. `hasOwnerSession` answers "the owner is signed in", not
  // "the owner asked for this": the session cookie is `SameSite=Lax`, which
  // stops the ordinary cross-SITE POST but not a page on a different ORIGIN of
  // the same site. This route moves where the owner's recordings are sent, so
  // it takes the same second guard the ClawKeep mutation routes take.
  if (!(await hasOwnerSession(req)) || !isSameOriginRequest(req)) {
    return NextResponse.json(
      { error: "Changing the transcription engine needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const primary = (body as { primary?: unknown } | null)?.primary;
  if (!isSttEngine(primary)) {
    return NextResponse.json({ error: "Pick ClawBox cloud or this box." }, { status: 400 });
  }

  try {
    const local = await localSttInstalled();
    // Refuse rather than write a primary the box cannot honour: an engine that
    // is not installed must read as not installed, not as a selected option
    // that never hears anything. Same call the tts route makes.
    if (primary === "local" && !local.installed) {
      return NextResponse.json({ error: local.detail }, { status: 409 });
    }
    // WHO DECIDED, beside WHAT was decided. A person pinning the engine on the
    // box is what stops the ClawBox AI cloud default from moving it back at the
    // next boot; picking the cloud hands the capability back to that default,
    // which is not the same as never having been asked (see clearOwnerChoice).
    //
    // THE PIN GOES FIRST, and only the pin. On a box whose `stt_choice_source`
    // already reads `auto` — anyone who has ever picked the cloud here — a
    // successful engine write followed by a failed `noteOwnerChoice` left that
    // `auto` standing, `ownerChoiceFrom("auto", true)` answered false, and the
    // next boot's cloud default promoted the box straight back off the engine
    // the owner had just chosen. Writing it BEFORE the engine cannot lose the
    // decision: the worst a later failure leaves is a pin over an unchanged
    // engine, which the applier reads as "leave this box alone" — the safe
    // direction. Releasing the capability back to the default is the opposite
    // case and stays AFTER its write, because a cleared pin over an engine that
    // did not move is the one that loses a decision.
    if (primary === "local") await noteOwnerChoice("stt");
    // Gateway first, preference second, so a failed CLI write leaves the
    // stored preference describing what the box still does.
    const wrote = openclawIsAbsent() ? false : await syncChannelAudio(sttEngineOrder(primary), local.installed);
    await setSttPrimary(primary);
    if (primary !== "local") await clearOwnerChoice("stt");
    if (wrote) {
      try {
        // Media-understanding config is read at gateway start, so a restart is
        // what makes the next voice note take the new order.
        await restartGateway();
      } catch (err) {
        console.warn("[setup-api/stt] gateway restart failed after the audio write:", err);
        // The preference and the config are both saved; only the switch-over
        // of channel voice notes is deferred to whenever the gateway next starts.
        //
        // A gateway that has not finished coming back answers 200, NOT 502, and
        // the status code is what decides it for the owner: this route's only
        // client is `LocalAiPanel.runAction`, which on `!res.ok` discards the
        // body — so the `warning` below would be unreachable, the panel would
        // paint its red generic "couldn't change that" over a change that
        // landed, and it would skip `applySnapshot`, leaving the row showing
        // the old engine. A 200 reaches both the amber notice and the repaint.
        //
        // A restart that was REFUSED keeps the 502: nothing is coming back on
        // its own there, and the owner does have to act.
        const pending = err instanceof GatewayNotReadyError;
        return noStore(
          {
            ...(await status()),
            restarted: false,
            warning: pending
              ? "Saved, but the gateway has not finished restarting — channel voice notes switch over once it is serving again."
              : "Saved, but the gateway restart failed — channel voice notes switch over at the next restart.",
          },
          { status: pending ? 200 : 502 },
        );
      }
    }
    return noStore(await status());
  } catch (err) {
    console.warn("[setup-api/stt] could not change the transcription engine:", err);
    return NextResponse.json({ error: "Could not change the transcription engine on this box." }, { status: 500 });
  }
}
