export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { get as readPreference } from "@/lib/config-store";
import { speechEntitledTier } from "@/lib/hermes-tts";
import { getActiveHarness } from "@/lib/harness";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";
import {
  hermesVoiceConfigView,
  readHermesVoice,
  selectHermesEngine,
  writeHermesCloudVoice,
  HermesTtsWriteError,
} from "@/lib/hermes-tts";
import {
  buildTtsInventory,
  ffmpegPresent,
  KOKORO_STAMP,
  localTtsCommandRunnable,
  type LocalModelEntry,
} from "@/lib/local-models";
import {
  openclawIsAbsent,
  readConfig,
  runOpenclawConfigSet,
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
  type VoiceConfigView,
  type VoiceOutputState,
  type VoiceOutputStatus,
} from "@/lib/voice-output";
import { readLocalVoice, readVoiceState, writeLocalVoice, writeVoiceState } from "@/lib/voice-output-store";
import { isCloudVoice, isCloudVoiceFor, isLocalVoice, isVoiceLanguage } from "@/lib/voice-catalog";
import { createSerialLock } from "@/lib/serial-lock";
import { wireLocalVoice } from "@/lib/voice-local-wiring";
import { getVoiceAutoReply, setVoiceAutoReply, ttsAutoModeFor } from "@/lib/voice-reply";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

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

/**
 * The four things POST does, as a list rather than a chain of `!==`.
 *
 * The value the handler uses is SELECTED OUT OF THIS ARRAY, not the body's copy
 * of one of these words. Both spell the same four things and no request can
 * tell them apart — but the failure line below names the action, and a string
 * read off `request.json()` is what CodeQL reports as `js/log-injection`
 * (TASK-723). It does not recognise `logSafe` as a barrier (the note in
 * ai-models/configure/route.ts says so); a value that came out of a literal
 * array is not the request's string at all.
 */
const ACTIONS = ["select", "voice", "language", "autoReply"] as const;

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

// `VoiceConfigView`, not `OpenClawConfig`: the only thing read here is the
// local provider's command, and both harnesses' configs are projected into
// that view. `OpenClawConfig` is structurally assignable to it.
function localProbeFrom(config: VoiceConfigView, models: LocalModelEntry[], commandPresent: boolean): LocalVoiceProbe {
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

/**
 * The box's speech config, in the ONE shape the status builder reads —
 * whichever harness holds it.
 *
 * OpenClaw keeps it in openclaw.json; Hermes keeps it in its own `tts:` block
 * and `hermes-tts.ts` projects that into the same view. Everything downstream
 * (which engine is configured, what Auto resolves to, the privacy notice) is
 * then decided once, by rules neither edition can disagree about.
 *
 * The LOCAL engine is read the same way on both: `buildTtsInventory()` stats
 * Kokoro's own artefacts on this disk, and the provider entry's command has to
 * still be there. Hermes runs the same `clawbox-tts.sh` (install.sh registers
 * it as a `type: command` provider), so this half needed no edition of its own.
 */
async function readVoiceConfig(harness: Awaited<ReturnType<typeof getActiveHarness>>): Promise<VoiceConfigView> {
  if (harness !== "hermes") return await readConfig();
  const [probe, token, entitled] = await Promise.all([
    readHermesVoice(),
    resolveClawaiToken(),
    speechEntitledTier(),
  ]);
  // The endpoint only for a box whose plan includes the cloud voice; see the
  // parameter's own note for why that is said as a null URL.
  return hermesVoiceConfigView(probe, token, entitled ? CLAWBOX_AI_PROXY_URL : null);
}

async function probeBox(harness: Awaited<ReturnType<typeof getActiveHarness>>) {
  const [config, models] = await Promise.all([readVoiceConfig(harness), buildTtsInventory()]);
  const command = localCommandPath(config);
  // The provider entry names a script; if that script is gone — or is there but
  // cannot be run — the box cannot speak locally however healthy the voices
  // look. Through the shared helper, because the chat's spoken-reply capability
  // asks the same question and because the two editions spell `command`
  // differently: stat'ing Hermes' command LINE whole read every correctly
  // provisioned box on that edition as "not wired to use its voice".
  //
  // Fall back to the installer's own artefacts when no command is configured at
  // all — the stamp is a marker file, so its question is existence, not X_OK.
  const commandPresent = command
    ? await localTtsCommandRunnable(command)
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

/**
 * The half of speech that really is OpenClaw's.
 *
 * A spoken reply in WhatsApp, Telegram or Discord is the GATEWAY speaking on
 * a channel, and a Hermes box has no gateway and no channels. That is a fact
 * about one half of the feature, not a reason to refuse the whole route — the
 * Voice tab itself (which engine speaks, in which voice, and the sample) is
 * answered on every edition. Exactly the shape /setup-api/stt already uses for
 * the other direction of speech, whose comment has claimed "Same shape
 * /setup-api/tts answers with" since before it was true.
 */
const CHANNELS_UNSUPPORTED = {
  supportedOnEdition: false,
  error: "Spoken replies on channels are an OpenClaw feature and are not part of this edition.",
} as const;

/**
 * Whether the box's CHANNEL replies can be spoken.
 *
 * Keyed on the ACTIVE harness, like every write on this route, and not on the
 * edition. `openclawIsAbsent()` is only ever true for the `hermes` SKU, so on
 * a licensed DUAL box switched to Hermes it said channels work — while every
 * setting on this page was being written into Hermes' config, which serves no
 * channel at all. The panel would have confirmed a voice change that the
 * WhatsApp and Telegram replies never took.
 *
 * `voiceNoteReady` is a second fact, and it is about THIS box rather than the
 * edition: a voice note is Opus, the encoder is ffmpeg, and without it every
 * spoken channel reply comes from the cloud voice however clearly the rest of
 * this page says the box speaks for itself (see `ffmpegPresent`). Reported
 * beside `supportedOnEdition` rather than folded into it, because "this
 * edition has no channels" and "this box cannot encode a voice note" are
 * different answers with different fixes.
 */
async function channelsSpeak(harness: Awaited<ReturnType<typeof getActiveHarness>>) {
  return harness === "openclaw" && !openclawIsAbsent()
    ? { supportedOnEdition: true as const, voiceNoteReady: await ffmpegPresent() }
    : CHANNELS_UNSUPPORTED;
}

type VoiceStatusBody = VoiceOutputStatus & {
  channels: typeof CHANNELS_UNSUPPORTED | { supportedOnEdition: true; voiceNoteReady: boolean };
  /** The owner's switch for spoken replies (src/lib/voice-reply.ts). */
  autoReply: boolean;
};

async function status(): Promise<VoiceStatusBody> {
  const harness = await getActiveHarness();
  const [{ config, probe }, state, localVoice, autoReply] = await Promise.all([
    probeBox(harness),
    readVoiceState().then(withUiLanguage),
    readLocalVoice(),
    getVoiceAutoReply(),
  ]);
  return {
    ...buildVoiceOutputStatus(config, probe, state, localVoice),
    channels: await channelsSpeak(harness),
    autoReply,
  };
}

/**
 * The switch for spoken replies. The gateway's mode first, then the store:
 * a failed CLI write must leave the stored switch describing what the box
 * still does. The boot repair (ensureVoiceAutoReplyMode) never overwrites
 * a mode that is present, so the two are brought into step here and
 * nowhere else. Only the gateway has channels to answer with a voice, so
 * only a box running OpenClaw gets the mode written; the desktop chat's
 * half of the switch works on every harness.
 */
async function handleAutoReply(enabled: unknown) {
  if (typeof enabled !== "boolean") {
    return refuse("Say whether spoken replies are on or off.", "bad_request", 400);
  }
  if ((await getActiveHarness()) === "openclaw" && !openclawIsAbsent()) {
    await runOpenclawConfigSet([`${await ttsConfigHome()}.auto`, ttsAutoModeFor(enabled)]);
  }
  await setVoiceAutoReply(enabled);
  return NextResponse.json(await status(), { headers: NO_STORE });
}

/*
 * Every write below goes to the harness that will actually SPEAK — the
 * openclaw CLI (`config set tts.provider`, `…providers.<cloud>.voice`;
 * OpenClaw 2 moved the block from messages.tts to a top-level tts object and
 * the readers in voice-output.ts accept both homes), or `hermes config set
 * tts.*` on a box running Hermes (see lib/hermes-tts.ts).
 *
 * Keyed on the ACTIVE harness rather than on "is the openclaw binary here",
 * which is what makes the dual SKU come out right: a dual box switched to
 * Hermes has an openclaw binary AND speaks through Hermes, so a write chosen
 * by the binary's presence would land in the config of the harness that is
 * not talking.
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

export async function GET() {
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
 * Which voice an engine speaks with.
 *
 * The on-device voice is the file the local script reads, so the next
 * utterance uses it with no restart — and it needs no harness branch, because
 * both harnesses run that same script. The cloud voice is the harness's own
 * per-provider key: OpenClaw's `providers.<cloud>.voice`, or Hermes'
 * `tts.openai.voice`. Both are validated against the catalogue the engine
 * accepts, so an unknown id is refused here instead of failing at speech time.
 */
async function handleVoice(engine: unknown, voice: unknown) {
  const harness = await getActiveHarness();
  if (engine === "local") {
    if (!isLocalVoice(voice)) {
      return refuse("That voice is not on this box.", "unknown_voice", 400);
    }
    // Edition-agnostic on purpose: `clawbox-tts.sh` reads this file on every
    // utterance and both harnesses run that same script, so the on-device
    // voice needs no harness branch at all.
    await writeLocalVoice(voice);
  } else if (engine === "cloud") {
    if (!isCloudVoice(voice)) {
      return refuse("The cloud voice does not have that voice.", "unknown_voice", 400);
    }
    const target = cloudSpeechTarget(await readVoiceConfig(harness));
    if (!target) {
      return refuse("That voice is not available on this box.", "not_available", 409);
    }
    // A voice some model has is not a voice THIS model has: tts-1 refuses
    // ballad and verse at speech time, which would be a saved setting that
    // never speaks.
    if (!isCloudVoiceFor(target.model, voice)) {
      return refuse(`The cloud voice's model (${target.model}) does not have that voice.`, "unknown_voice", 400);
    }
    if (harness === "hermes") {
      // Hermes' own per-provider key. Same catalogue on both editions: the
      // OpenAI-compatible slot takes the same voice names OpenClaw writes, so
      // the ids map one to one and no translation table is needed.
      await writeHermesCloudVoice(voice);
    } else {
      // The DETECTED home, not a hardcoded one: writing top-level tts.* while
      // the providers still live under the legacy messages.tts would split the
      // voice from its provider definition (and the readers prefer the
      // top-level home). ttsConfigHome() keys off the same signal the readers
      // use — where the providers actually are.
      await runOpenclawConfigSet([`${await ttsConfigHome()}.providers.${target.providerId}.voice`, voice]);
    }
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

/** Write the harness's selection: Hermes through its own writer, OpenClaw through the CLI. */
async function selectProvider(
  harness: Awaited<ReturnType<typeof getActiveHarness>>,
  before: VoiceOutputStatus,
  providerId: string,
): Promise<Response | null> {
  if (harness === "hermes") {
    // Endpoint and credential first, selection last — see selectHermesEngine.
    // A refusal here must not be swallowed: a box left pointing at a
    // provider whose credential never landed answers every utterance with a
    // 401, which reads as "the voice is broken" rather than "it was never
    // configured".
    const engine = before.engines.find((e) => e.providerId === providerId)?.id;
    if (!engine) return refuse("That voice is not available on this box.", "not_available", 409);
    await selectHermesEngine(engine, await resolveClawaiToken());
    return null;
  }
  await runOpenclawConfigSet([`${await ttsConfigHome()}.provider`, providerId]);
  return null;
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
async function settleOnAuto(
  harness: Awaited<ReturnType<typeof getActiveHarness>>,
  before: VoiceOutputStatus,
  requested: VoiceChoice,
  reason: LocalFallbackReason,
) {
  const providerId = providerIdForChoice("auto", before.engines);
  if (providerId && providerId !== before.activeProviderId) {
    const refused = await selectProvider(harness, before, providerId);
    if (refused) return refused;
  }
  await withVoiceState(async () => {
    await writeVoiceState({ ...(await readVoiceState()), choice: "auto" });
  });
  return NextResponse.json({ ...(await status()), fallback: { requested, reason } }, { headers: NO_STORE });
}

async function handleSelect(choice: VoiceChoice) {
  const harness = await getActiveHarness();
  let { config, probe } = await probeBox(harness);

  // The box's own voice, installed but not wired: Kokoro is there (stamp,
  // unit) and only OpenClaw's `tts-local-cli` provider entry is missing — the
  // state install.sh leaves behind when another provider was already
  // selected. The owner's pick is the moment to write it, not a refusal to
  // read. OpenClaw only: Hermes' provider is registered by install.sh itself.
  let wiringFailed = false;
  if (choice === "local" && harness !== "hermes" && probe.engineInstalled && !(probe.providerConfigured && probe.commandPresent)) {
    if (openclawIsAbsent()) {
      return refuse("This box cannot change the voice.", "cannot_change", 409);
    }
    const wired = await wireLocalVoice(await ttsConfigHome());
    if (wired.ok) {
      ({ config, probe } = await probeBox(harness));
    } else {
      wiringFailed = true;
    }
  }

  const state = await readVoiceState();
  const before = buildVoiceOutputStatus(config, probe, state);

  const refusal = selectionError(choice, before.engines);
  if (refusal && choice === "local") {
    // Not a red error: the default voice stays, and the answer says why.
    return settleOnAuto(harness, before, choice, probe.engineInstalled || wiringFailed ? "not_wired" : "not_installed");
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
    const refused = await selectProvider(harness, before, providerId);
    if (refused) return refused;
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const { action: rawAction, choice, engine, voice, language, enabled } = (body ?? {}) as Record<string, unknown>;

  const action = ACTIONS.find((name) => name === rawAction);
  if (!action) {
    return refuse("Unknown action.", "bad_request", 400);
  }
  // OWNER ONLY for the switch, and from OUR page: whether the box answers a
  // voice message with audio — through the cloud voice, which sends the
  // words off the box — is the person's decision, and the agent holds the
  // MCP bearer the middleware also admits here (same rule as the stt route);
  // the cookie rides on a POST any other site fires at the box (same-origin.ts).
  if (action === "autoReply" && !(await hasOwnerSession(req))) {
    return NextResponse.json(
      { error: "Changing spoken replies needs a signed-in browser session.", kind: "owner_only", code: "owner_only" },
      { status: 403, headers: NO_STORE },
    );
  }
  if (action === "autoReply" && !isSameOriginRequest(req)) {
    return NextResponse.json(
      { error: "Changing spoken replies only works from this ClawBox's own pages.", kind: "cross_origin", code: "cross_origin" },
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
    // A harness that refused the write is a 409 the panel can explain, not a
    // 500: the box is reachable and said no. Anything else really is a fault.
    if (err instanceof HermesTtsWriteError) {
      return refuse("This box could not change the voice.", "cannot_change", 409);
    }
    return refuse("Could not change the voice on this box.", "cannot_change", 500);
  }
}
