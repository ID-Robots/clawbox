export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { get as readPreference } from "@/lib/config-store";
import {
  buildTtsInventory,
  KOKORO_STAMP,
  type LocalModelEntry,
} from "@/lib/local-models";
import {
  openclawIsAbsent,
  readConfig,
  runOpenclawConfigSet,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import {
  buildVoiceOutputStatus,
  cloudSpeechTarget,
  isVoiceChoice,
  localCommandPath,
  providerIdForChoice,
  selectionError,
  type LocalVoiceProbe,
  type VoiceChoice,
  type VoiceOutputState,
  type VoiceOutputStatus,
} from "@/lib/voice-output";
import { readLocalVoice, readVoiceState, writeLocalVoice, writeVoiceState } from "@/lib/voice-output-store";
import { wireLocalVoice } from "@/lib/voice-local-wiring";
import { getVoiceAutoReply, setVoiceAutoReply, ttsAutoModeFor } from "@/lib/voice-reply";
import { hasOwnerSession } from "@/lib/owner-session";
import { isCloudVoice, isCloudVoiceFor, isLocalVoice, isVoiceLanguage } from "@/lib/voice-catalog";
import { createSerialLock } from "@/lib/serial-lock";

/**
 * GET  /setup-api/tts            → who speaks for this box
 * POST /setup-api/tts {select}   → pick Auto / On this box / ClawBox cloud
 * POST /setup-api/tts {voice}    → which voice an engine speaks with
 * POST /setup-api/tts {language} → the sample sentence's language on the Voice tab
 *
 * GET touches only the filesystem. The openclaw CLI costs 8-12 s of cold start
 * on an Orin Nano (see runOpenclawConfigSet's note), which is fine for an
 * explicit button and completely wrong for a panel the customer just opened.
 *
 * Every refusal carries a stable `code` beside its English `error`, so the
 * Voice tab can say it in the owner's language; the sentence stays for the
 * callers (and tests) that read it.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

function localProbeFrom(config: OpenClawConfig, models: LocalModelEntry[], commandPresent: boolean): LocalVoiceProbe {
  const installedTts = models.filter(m => m.kind === "tts" && m.installed);
  return {
    providerConfigured: Boolean(localCommandPath(config)),
    commandPresent,
    engineInstalled: installedTts.length > 0,
    engineNames: installedTts.map(m => m.name),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function probeBox() {
  const [config, models] = await Promise.all([readConfig(), buildTtsInventory()]);
  const command = localCommandPath(config);
  // The provider entry names a script; if that script is gone the box cannot
  // speak locally however healthy the voices look. Fall back to the installer's
  // own artefacts when no command is configured at all.
  const commandPresent = command
    ? await exists(command)
    : await exists(KOKORO_STAMP);
  return { config, probe: localProbeFrom(config, models, commandPresent) };
}

/**
 * The sample language until the owner picks one is the desktop's own: a
 * German owner opening the tab should read a German sample, not set the
 * language twice. Read here, never persisted — only `{language}` writes a
 * pick — so changing the UI language later still moves the sample with it.
 */
async function withUiLanguage(state: VoiceOutputState): Promise<VoiceOutputState> {
  if (state.language) return state;
  const ui = await readPreference("pref:ui_language").catch(() => null);
  return isVoiceLanguage(ui) ? { ...state, language: ui } : state;
}

/** The status plus the owner's switch for spoken replies (src/lib/voice-reply.ts). */
type VoiceStatusAnswer = VoiceOutputStatus & { autoReply: boolean };

async function status(): Promise<VoiceStatusAnswer> {
  const [{ config, probe }, state, localVoice, autoReply] = await Promise.all([
    probeBox(),
    readVoiceState().then(withUiLanguage),
    readLocalVoice(),
    getVoiceAutoReply(),
  ]);
  return { ...buildVoiceOutputStatus(config, probe, state, localVoice), autoReply };
}

/**
 * The switch for spoken replies. The gateway's mode first, then the store:
 * a failed CLI write must leave the stored switch describing what the box
 * still does. The boot repair (ensureVoiceAutoReplyMode) never overwrites
 * a mode that is present, so the two are brought into step here and
 * nowhere else.
 */
async function handleAutoReply(enabled: unknown) {
  if (typeof enabled !== "boolean") {
    return refuse("Say whether spoken replies are on or off.", "bad_request", 400);
  }
  if (!openclawIsAbsent()) {
    await runOpenclawConfigSet([`${await ttsConfigHome()}.auto`, ttsAutoModeFor(enabled)]);
  }
  await setVoiceAutoReply(enabled);
  return NextResponse.json(await status(), { headers: NO_STORE });
}

/**
 * Every write below runs through the openclaw CLI (`config set
 * tts.provider` for the selection, `…providers.<cloud>.voice` for the cloud
 * voice — OpenClaw 2 moved the whole block from messages.tts to a top-level
 * tts object; the readers in voice-output.ts accept both homes). The Hermes SKU ships no openclaw binary at all, so the panel
 * offered a Select the route then refused with a 409. Say the true thing once,
 * here, instead of letting the customer discover it a button at a time. Same
 * shape ClawKeep reports for the same reason (lib/clawkeep.ts).
 */
/**
 * Which home this box's speech config lives in: top-level `tts` (OpenClaw 2)
 * or the legacy `messages.tts`. Decided by where a providers map actually
 * exists — the same rule voice-output.ts reads with — so a write can never
 * land in the other generation's slot beside the real one. A box with
 * NEITHER (fresh, unconfigured) gets the v2 home: the repo pairs with the
 * 2026.8 pin.
 */
async function ttsConfigHome(): Promise<"tts" | "messages.tts"> {
  const config = await readConfig();
  const top = (config as { tts?: { providers?: unknown } }).tts;
  if (top && typeof top === "object" && top.providers) return "tts";
  const legacy = (config as { messages?: { tts?: { providers?: unknown } } }).messages?.tts;
  if (legacy && typeof legacy === "object" && legacy.providers) return "messages.tts";
  return "tts";
}

const EDITION_UNSUPPORTED = {
  supportedOnEdition: false,
  error: "Voice output is an OpenClaw feature and is not part of this edition.",
  code: "edition",
} as const;

export async function GET() {
  if (openclawIsAbsent()) {
    return NextResponse.json(EDITION_UNSUPPORTED, { headers: NO_STORE });
  }
  try {
    return NextResponse.json(await status(), { headers: NO_STORE });
  } catch (err) {
    console.warn("[setup-api/tts] could not read voice status:", err);
    return NextResponse.json({ error: "Could not read the voice settings." }, { status: 500 });
  }
}

/**
 * One writer of the voice state at a time.
 *
 * Both mutations below are "read the state, change a field, write it back",
 * and two of them can land together — two tabs, or a language pick while a
 * selection's 8-12 s CLI call is still running. Each would read the same base
 * and the second write would drop the first. Only the read-modify-write is
 * held; the openclaw CLI call stays outside it.
 */
const withVoiceState = createSerialLock();

/**
 * Which voice an engine speaks with. The on-device voice is the file the local
 * script reads, so the gateway's next utterance uses it with no restart; the
 * cloud voice is OpenClaw's own `providers.<cloud>.voice`, written the way the
 * provider itself is. Both are validated against the catalogue the engine
 * accepts, so an unknown id is refused here instead of failing at speech time.
 */
async function handleVoice(engine: unknown, voice: unknown) {
  if (engine === "local") {
    if (!isLocalVoice(voice)) {
      return refuse("That voice is not on this box.", "unknown_voice", 400);
    }
    await writeLocalVoice(voice);
  } else if (engine === "cloud") {
    if (!isCloudVoice(voice)) {
      return refuse("The cloud voice does not have that voice.", "unknown_voice", 400);
    }
    const target = cloudSpeechTarget(await readConfig());
    if (!target) {
      return refuse("That voice is not available on this box.", "not_available", 409);
    }
    // A voice some model has is not a voice THIS model has: tts-1 refuses
    // ballad and verse at speech time, which would be a saved setting that
    // never speaks.
    if (!isCloudVoiceFor(target.model, voice)) {
      return refuse(`The cloud voice's model (${target.model}) does not have that voice.`, "unknown_voice", 400);
    }
    // The DETECTED home, not a hardcoded one: writing top-level tts.* while
    // the providers still live under the legacy messages.tts would split the
    // voice from its provider definition (and the readers prefer the
    // top-level home). ttsConfigHome() keys off the same signal the readers
    // use — where the providers actually are.
    await runOpenclawConfigSet([`${await ttsConfigHome()}.providers.${target.providerId}.voice`, voice]);
  } else {
    return refuse("Pick the voice on this box or the cloud voice.", "unknown_engine", 400);
  }
  return NextResponse.json(await status(), { headers: NO_STORE });
}

async function handleLanguage(language: unknown) {
  if (!isVoiceLanguage(language)) {
    return refuse("That language is not offered.", "unknown_language", 400);
  }
  await withVoiceState(async () => {
    await writeVoiceState({ ...(await readVoiceState()), language });
  });
  return NextResponse.json(await status(), { headers: NO_STORE });
}

/**
 * Why a pick of the box's own voice could not be honoured, for the answer.
 * `not_wired` is an installed engine whose provider entry could not be
 * written; `not_installed` is no engine at all.
 */
type LocalFallbackReason = "not_installed" | "not_wired";

/**
 * Settle on Auto — the default — and say so, instead of refusing.
 *
 * The owner asked for a pick the box cannot honour to fall back to the
 * default rather than end in a red error: the box keeps speaking with
 * whatever it has, the stored choice says Auto (so nothing reads back a pick
 * that never speaks), and the answer carries `fallback` so the panel can say
 * in one amber line what happened and why.
 */
async function settleOnAuto(before: VoiceOutputStatus, requested: VoiceChoice, reason: LocalFallbackReason) {
  const providerId = providerIdForChoice("auto", before.engines);
  if (providerId && providerId !== before.activeProviderId && !openclawIsAbsent()) {
    await runOpenclawConfigSet([`${await ttsConfigHome()}.provider`, providerId]);
  }
  await withVoiceState(async () => {
    await writeVoiceState({ ...(await readVoiceState()), choice: "auto" });
  });
  return NextResponse.json({ ...(await status()), fallback: { requested, reason } }, { headers: NO_STORE });
}

async function handleSelect(choice: VoiceChoice) {
  let { config, probe } = await probeBox();

  // The box's own voice, installed but not wired: Kokoro is there (stamp,
  // unit) and only the `tts-local-cli` provider entry is missing — the state
  // install.sh leaves behind when another provider was already selected. The
  // owner's pick is the moment to write it, not a refusal to read.
  let wiringFailed = false;
  if (choice === "local" && probe.engineInstalled && !(probe.providerConfigured && probe.commandPresent)) {
    if (openclawIsAbsent()) {
      return refuse("This box cannot change the voice.", "cannot_change", 409);
    }
    const wired = await wireLocalVoice(await ttsConfigHome());
    if (wired.ok) {
      ({ config, probe } = await probeBox());
    } else {
      wiringFailed = true;
    }
  }

  const state = await readVoiceState();
  const before = buildVoiceOutputStatus(config, probe, state);

  const refusal = selectionError(choice, before.engines);
  if (refusal && choice === "local") {
    // Not a red error: the default voice stays, and the answer says why.
    return settleOnAuto(before, choice, probe.engineInstalled || wiringFailed ? "not_wired" : "not_installed");
  }
  // A cloud voice the box cannot use is still refused out loud: the cloud
  // engine has nothing on this box to install or wire, so "fall back" would
  // only hide that the box is not entitled to it.
  if (refusal) {
    return refuse(refusal, choice === "auto" ? "no_voice" : "not_available", 409);
  }
  const providerId = providerIdForChoice(choice, before.engines);
  if (!providerId) {
    return refuse("That voice is not available on this box.", "not_available", 409);
  }

  if (providerId !== before.activeProviderId) {
    if (openclawIsAbsent()) {
      return refuse("This box cannot change the voice.", "cannot_change", 409);
    }
    await runOpenclawConfigSet([`${await ttsConfigHome()}.provider`, providerId]);
  }

  // Re-read under the lock: the copy above decided the refusal, but the CLI
  // call between then and now can take 12 s, and a language picked in the
  // meantime must not be written over by the stale copy.
  await withVoiceState(async () => {
    await writeVoiceState({ ...(await readVoiceState()), choice });
  });
  return NextResponse.json(await status(), { headers: NO_STORE });
}

export async function POST(req: Request) {
  // Refuse before the body is even read: on this edition there is no binary to
  // spawn, so nothing below could land.
  if (openclawIsAbsent()) {
    return NextResponse.json(EDITION_UNSUPPORTED, { status: 409 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const { action, choice, engine, voice, language, enabled } = (body ?? {}) as Record<string, unknown>;

  if (action !== "select" && action !== "voice" && action !== "language" && action !== "autoReply") {
    return refuse("Unknown action.", "bad_request", 400);
  }
  // OWNER ONLY for the switch: whether the box answers a voice message with
  // audio — through the cloud voice, which sends the words off the box — is
  // the person's decision, and the agent holds the MCP bearer the middleware
  // also admits here. Same rule as the transcription engine (stt route).
  if (action === "autoReply" && !(await hasOwnerSession(req))) {
    return NextResponse.json(
      { error: "Changing spoken replies needs a signed-in browser session.", kind: "owner_only", code: "owner_only" },
      { status: 403, headers: NO_STORE },
    );
  }
  if (action === "select" && !isVoiceChoice(choice)) {
    return refuse("Pick Auto, this box, or ClawBox cloud.", "bad_request", 400);
  }

  // One boundary for every branch. Every step here is filesystem work or a
  // spawn: a full disk, a read-only data dir or a missing CLI must come back as
  // a message the panel can show, not as a framework error page that leaves the
  // box with nothing in its log.
  try {
    if (action === "voice") return await handleVoice(engine, voice);
    if (action === "language") return await handleLanguage(language);
    if (action === "autoReply") return await handleAutoReply(enabled);
    return await handleSelect(choice as VoiceChoice);
  } catch (err) {
    console.warn(`[setup-api/tts] ${action} failed:`, err);
    return refuse("Could not change the voice on this box.", "cannot_change", 500);
  }
}
