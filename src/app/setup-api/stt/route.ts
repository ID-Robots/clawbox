export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isDeepStrictEqual } from "util";
import { getActiveHarness } from "@/lib/harness";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";
import {
  GatewayNotReadyError,
  openclawIsAbsent,
  readConfig,
  restartGateway,
  runOpenclawConfigSetBatch,
} from "@/lib/openclaw-config";
import { hasOwnerSession } from "@/lib/owner-session";
import { localSttInstalled } from "@/lib/stt-local";
import {
  buildAudioModels,
  getSttPrimary,
  isSttEngine,
  setSttPrimary,
  sttEngineOrder,
  type SttEngine,
} from "@/lib/stt-preference";

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


/**
 * Make openclaw.json's audio chain say what the preference says. Answers
 * whether anything was written, so the caller knows whether a restart is owed.
 *
 * Skipped entirely when the file already holds this exact endpoint and list:
 * the write costs a CLI cold start and the restart drops every open channel
 * connection, and re-selecting the engine already in force must cost neither.
 * One batch, not two calls, so the endpoint and the list can never land
 * without each other.
 */
async function syncChannelAudio(order: SttEngine[], localInstalled: boolean): Promise<boolean> {
  const models = buildAudioModels(order, localInstalled);
  // OpenClaw 2: the endpoint stays under tools.media.audio, but the model
  // list lives in the SHARED tools.media.models — one list for every media
  // capability, so rows that are not ours to order (no capabilities, or
  // capabilities without "audio": vision, video, an owner's own entries)
  // must ride along untouched. Only the audio subset is this route's.
  const media = (await readConfig()).tools?.media;
  const existing = Array.isArray(media?.models) ? media.models : [];
  const isAudioRow = (row: unknown): boolean => {
    if (!row || typeof row !== "object") return false;
    const caps = (row as { capabilities?: unknown }).capabilities;
    return Array.isArray(caps) && caps.includes("audio");
  };
  const foreign = existing.filter((row) => !isAudioRow(row));
  const merged = [...foreign, ...models];
  if (media?.audio?.baseUrl === CLAWBOX_AI_PROXY_URL && isDeepStrictEqual(existing.filter(isAudioRow), models)) return false;
  await runOpenclawConfigSetBatch([
    ["tools.media.audio.baseUrl", JSON.stringify(CLAWBOX_AI_PROXY_URL), "--json"],
    ["tools.media.models", JSON.stringify(merged), "--json"],
  ]);
  return true;
}

export async function POST(req: Request) {
  // OWNER ONLY. Middleware admits every /setup-api/* call on the MCP bearer as
  // well, and the agent holds that bearer. Where a recording is sent is the
  // person's decision — off the box or not — so the agent is not allowed to
  // make it, whatever it has been told. Same helper and rule as
  // coding-agent/enable.
  if (!(await hasOwnerSession(req))) {
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
    // Gateway first, preference second, so a failed CLI write leaves the
    // stored preference describing what the box still does.
    const wrote = openclawIsAbsent() ? false : await syncChannelAudio(sttEngineOrder(primary), local.installed);
    await setSttPrimary(primary);
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
