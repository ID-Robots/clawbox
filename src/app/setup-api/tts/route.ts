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
  KOKORO_STAMP,
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
 */
async function channelsSpeak(harness: Awaited<ReturnType<typeof getActiveHarness>>) {
  return harness === "openclaw" && !openclawIsAbsent()
    ? { supportedOnEdition: true as const }
    : CHANNELS_UNSUPPORTED;
}

type VoiceStatusBody = VoiceOutputStatus & {
  channels: typeof CHANNELS_UNSUPPORTED | { supportedOnEdition: true };
};

async function status(): Promise<VoiceStatusBody> {
  const harness = await getActiveHarness();
  const [{ config, probe }, state, localVoice] = await Promise.all([
    probeBox(harness),
    readVoiceState().then(withUiLanguage),
    readLocalVoice(),
  ]);
  return {
    ...buildVoiceOutputStatus(config, probe, state, localVoice),
    channels: await channelsSpeak(harness),
  };
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

async function handleSelect(choice: VoiceChoice) {
  const harness = await getActiveHarness();
  const { config, probe } = await probeBox(harness);
  const state = await readVoiceState();
  const before = buildVoiceOutputStatus(config, probe, state);

  // Refuse rather than write a primary the box cannot honour, and refuse rather
  // than quietly substitute the other engine: an engine that is not installed
  // must read as not installed, not as a selected option that never speaks.
  const refusal = selectionError(choice, before.engines);
  if (refusal) {
    return refuse(refusal, choice === "auto" ? "no_voice" : "not_available", 409);
  }
  const providerId = providerIdForChoice(choice, before.engines);
  if (!providerId) {
    return refuse("That voice is not available on this box.", "not_available", 409);
  }

  if (providerId !== before.activeProviderId) {
    if (harness === "hermes") {
      // Endpoint and credential first, selection last — see selectHermesEngine.
      // A refusal here must not be swallowed: a box left pointing at a
      // provider whose credential never landed answers every utterance with a
      // 401, which reads as "the voice is broken" rather than "it was never
      // configured".
      const engine = before.engines.find((e) => e.providerId === providerId)?.id;
      if (!engine) return refuse("That voice is not available on this box.", "not_available", 409);
      await selectHermesEngine(engine, await resolveClawaiToken());
    } else {
      await runOpenclawConfigSet([`${await ttsConfigHome()}.provider`, providerId]);
    }
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
  const { action, choice, engine, voice, language } = (body ?? {}) as Record<string, unknown>;

  if (action !== "select" && action !== "voice" && action !== "language") {
    return refuse("Unknown action.", "bad_request", 400);
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
