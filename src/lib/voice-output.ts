/**
 * Voice output: which engine speaks for this box, and which one actually did.
 *
 * TASK-434 asked for a per-capability Local/ClawBox/Auto picker across the whole
 * multimodal stack. Yanko cut it to TTS on 2026-08-22 for a measured reason: of
 * the five capabilities in the original scope, TTS is the only one with both an
 * on-device and a cloud implementation on a ClawBox. The other four would have
 * shipped a "Local" option nothing could ever select.
 *
 * Two facts about the device shape everything below, and both were read off a
 * real box before any of this was written:
 *
 *  1. THE GATEWAY ALREADY OWNS THE FALLBACK. `messages.tts` has no
 *     `fallbackProviders` key; `resolveTtsProviderOrder()` builds the chain from
 *     the primary plus every other configured speech provider. So a selector's
 *     whole job is to set the primary honestly and then report what actually
 *     served — inventing a second chain here would just be a chain that can
 *     disagree with the one that runs.
 *
 *  2. A CONFIGURED CLOUD VOICE IS NOT A WORKING ONE. The `openai` provider on a
 *     ClawBox carries the ClawBox AI portal token (`claw_…`), and a speech call
 *     with no endpoint behind it goes to api.openai.com and comes back 401
 *     (`openclaw capability tts convert --model openai/gpt-4o-mini-tts` on
 *     .177, 2026-08-22). An option that is present in a registry is therefore
 *     not evidence that the box can speak with it.
 *
 *     UPDATED 2026-08-22 (TASK-490): ClawBox AI now DOES serve speech —
 *     `/api/ai/audio/speech`, Max only (clawbox-website PR #523). An entitled
 *     box gets `messages.tts.providers.openai` written by
 *     gateway-pre-start.sh, which is what turns the claw_ token from a
 *     credential with nowhere to go into a working one. The rule below did not
 *     change, only the reason a box can fail it: an unentitled box, or one
 *     whose `openai` slot belongs to its owner, still has no endpoint.
 *
 * So availability here is a MEASUREMENT, in the same spirit as the Local Models
 * tab (TASK-435): an engine is usable when the box has what it needs AND the
 * last real attempt through it did not fail. `runVoiceCheck` is that attempt —
 * it synthesises a real phrase through the real chain and records which provider
 * produced the audio, which is what makes "chosen vs actually used" a fact
 * rather than a label.
 */
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { buildCloudTtsWarning } from "@/lib/tts-cloud-warning";
import {
  CLOUD_VOICES,
  DEFAULT_CLOUD_VOICE,
  DEFAULT_LOCAL_VOICE,
  DEFAULT_VOICE_LANGUAGE,
  isCloudVoice,
  isLocalVoice,
  LOCAL_VOICES,
  type VoiceOption,
} from "@/lib/voice-catalog";

/**
 * The slice of openclaw.json this module reads.
 *
 * Declared here rather than importing OpenClawConfig so the rules below can be
 * exercised against a literal in a test without dragging the CLI-spawning
 * module in, and so it is obvious at a glance how little of the config a voice
 * decision is allowed to depend on. `OpenClawConfig` is structurally assignable
 * to it.
 */
export interface VoiceConfigView {
  messages?: {
    tts?: {
      provider?: unknown;
      providers?: unknown;
    };
  };
  models?: {
    providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined>;
  };
}

/** The provider id install.sh writes for the on-device voice. */
export const LOCAL_TTS_PROVIDER_ID = "tts-local-cli";

/** The cloud speech provider a ClawBox would use if it had a key for one. */
export const DEFAULT_CLOUD_TTS_PROVIDER_ID = "openai";

/**
 * What the privacy notice calls the cloud voice. The customer bought ClawBox AI,
 * not a provider id, and the sentence reads "Voice uses <this> cloud TTS".
 */
export const CLOUD_DISCLOSURE_LABEL = "ClawBox AI";

/**
 * The standing V4 product decision (Yanko, 2026-08-20): cloud TTS first, local
 * as the fallback. "Auto" follows this rather than pinning it, so a box whose
 * cloud voice is unusable still speaks instead of going silent.
 */
export const RECOMMENDED_ENGINE: VoiceEngineId = "cloud";

export type VoiceChoice = "auto" | "local" | "cloud";
export type VoiceEngineId = "local" | "cloud";

export const VOICE_CHOICES: readonly VoiceChoice[] = ["auto", "local", "cloud"];
export const VOICE_ENGINE_IDS: readonly VoiceEngineId[] = ["local", "cloud"];

export function isVoiceChoice(value: unknown): value is VoiceChoice {
  return typeof value === "string" && (VOICE_CHOICES as readonly string[]).includes(value);
}

export interface VoiceAttempt {
  providerId: string;
  engine: VoiceEngineId | null;
  ok: boolean;
  /** Customer-safe, or null when the raw reason could not be shown. */
  message: string | null;
  latencyMs: number | null;
}

export interface VoiceCheck {
  at: number;
  ok: boolean;
  /** The provider that actually produced audio, when one did. */
  servedByProviderId: string | null;
  servedEngine: VoiceEngineId | null;
  attempts: VoiceAttempt[];
  message: string | null;
}

export interface VoiceEngine {
  id: VoiceEngineId;
  providerId: string | null;
  label: string;
  /** Everything this engine needs is present on the box. */
  configured: boolean;
  /** A real conversion has gone through this engine on this box. */
  proven: boolean;
  /** The box can use it: configured, and the last real attempt did not fail. */
  usable: boolean;
  /** One line the customer can act on. Never a path, a URL or a credential. */
  detail: string;
}

export interface VoiceOutputStatus {
  choice: VoiceChoice;
  /** `messages.tts.provider` exactly as it stands in openclaw.json. */
  activeProviderId: string | null;
  /** Which of our two engines that provider is, or null when it is neither. */
  activeEngine: VoiceEngineId | null;
  /** What `choice` resolves to given today's measurements. */
  preferredEngine: VoiceEngineId | null;
  /** The selection and the box disagree — Auto has somewhere to move to. */
  drifted: boolean;
  engines: VoiceEngine[];
  lastCheck: VoiceCheck | null;
  /**
   * The TASK-409 privacy notice, built by the same function the chat banner
   * uses, so the two surfaces cannot word the same fact differently.
   */
  warning: string | null;
  /** The language the sample sentence comes in; the owner's pick. */
  language: string;
  /** The voice each engine speaks with right now, always one from `voices`. */
  voice: Record<VoiceEngineId, string>;
  /** What each engine can be asked to speak with. */
  voices: Record<VoiceEngineId, readonly VoiceOption[]>;
}

/** Persisted in the setup app's own data dir; see voice-output-store.ts. */
export interface VoiceOutputState {
  choice: VoiceChoice;
  /** The most recent real attempt through each engine, by engine id. */
  engineChecks: Partial<Record<VoiceEngineId, VoiceAttempt & { at: number }>>;
  lastCheck: VoiceCheck | null;
  /** Sample-sentence language on the Voice tab; absent in files written before it existed. */
  language?: string;
}

export const DEFAULT_VOICE_STATE: VoiceOutputState = {
  choice: "auto",
  engineChecks: {},
  lastCheck: null,
  language: DEFAULT_VOICE_LANGUAGE,
};

export function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return id || null;
}

/**
 * Local means "speaks without leaving the box". Kept deliberately in step with
 * `isLocalProvider` in tts-cloud-warning.ts: the privacy banner and this
 * selector must never disagree about whether an engine is on-device, or the box
 * would show "on this box" beside a cloud warning. The contract test
 * voice-output-warning-agreement asserts they agree on every id either sees.
 */
export function isLocalProviderId(id: string): boolean {
  if (id === LOCAL_TTS_PROVIDER_ID) return true;
  return /(?:^|[-_.])(local|cli|piper|kokoro)(?:$|[-_.])/.test(id);
}

export function engineForProviderId(id: string | null): VoiceEngineId | null {
  if (!id) return null;
  return isLocalProviderId(id) ? "local" : "cloud";
}

interface TtsProviderEntry {
  command?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  voice?: unknown;
}

/**
 * The cloud voice openclaw.json names (`messages.tts.providers.<cloud>.voice`),
 * or the engine's own default when nothing is written — which is what the
 * gateway speaks with in that case, so the dropdown shows the same thing.
 */
export function cloudVoiceFrom(config: VoiceConfigView): string {
  const providerId = cloudProviderIdFor(config);
  const voice = providerId ? ttsProviders(config)[providerId]?.voice : undefined;
  return isCloudVoice(voice) ? voice : DEFAULT_CLOUD_VOICE;
}

function ttsProviders(config: VoiceConfigView): Record<string, TtsProviderEntry> {
  const providers = config.messages?.tts?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  return providers as Record<string, TtsProviderEntry>;
}

export function configuredTtsProviderId(config: VoiceConfigView): string | null {
  return normalizeProviderId(config.messages?.tts?.provider);
}

/**
 * Which provider a cloud pick would write. Prefer an explicit `messages.tts`
 * entry — someone who configured their own cloud voice means that one — and
 * fall back to the OpenAI-compatible provider the ClawBox image ships.
 */
export function cloudProviderIdFor(config: VoiceConfigView): string | null {
  for (const id of Object.keys(ttsProviders(config))) {
    const normalized = normalizeProviderId(id);
    if (normalized && !isLocalProviderId(normalized)) return normalized;
  }
  const models = config.models?.providers ?? {};
  if (models[DEFAULT_CLOUD_TTS_PROVIDER_ID]) return DEFAULT_CLOUD_TTS_PROVIDER_ID;
  return null;
}

function credentialFor(config: VoiceConfigView, providerId: string): string | null {
  const direct = ttsProviders(config)[providerId]?.apiKey;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const model = config.models?.providers?.[providerId]?.apiKey;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function cloudEndpointConfigured(config: VoiceConfigView, providerId: string): boolean {
  const entry = ttsProviders(config)[providerId];
  if (typeof entry?.baseUrl === "string" && entry.baseUrl.trim()) return true;
  const provider = config.models?.providers?.[providerId];
  return typeof provider?.baseUrl === "string" && Boolean(provider.baseUrl.trim());
}

/**
 * A ClawBox AI portal token is not an OpenAI key. Sent to api.openai.com it
 * comes back 401 — proven on .177 — so a claw_ credential is only usable when
 * something has pointed it at a route that accepts it.
 *
 * Until 2026-08-22 nothing could: ClawBox AI served chat, transcription and
 * images but no speech. It serves speech now, on Max, and gateway-pre-start.sh
 * writes the endpoint for an entitled box (TASK-490). So this returning true no
 * longer means "the product has no cloud voice" — it means THIS box has not
 * been pointed at one, because its plan does not include it or because its
 * `openai` slot is the owner's own. Saying so before the customer spends a
 * check on it is the difference between a selector that reports the box and one
 * that repeats a registry.
 */
export function cloudCredentialIsUnusable(config: VoiceConfigView, providerId: string): boolean {
  const key = credentialFor(config, providerId);
  if (!key) return false;
  return key.startsWith("claw_") && !cloudEndpointConfigured(config, providerId);
}

export interface LocalVoiceProbe {
  /** `messages.tts.providers["tts-local-cli"]` names a command. */
  providerConfigured: boolean;
  /** That command is really on disk. */
  commandPresent: boolean;
  /** A TTS engine (Piper or Kokoro) is genuinely installed. */
  engineInstalled: boolean;
  /** Names of the installed on-device voices, for the detail line. */
  engineNames: string[];
}

export function localCommandPath(config: VoiceConfigView): string | null {
  const command = ttsProviders(config)[LOCAL_TTS_PROVIDER_ID]?.command;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

function lastFailure(state: VoiceOutputState, engine: VoiceEngineId): string | null {
  const attempt = state.engineChecks[engine];
  if (!attempt || attempt.ok) return null;
  return attempt.message ?? "The last voice check through it did not produce audio.";
}

function localEngine(probe: LocalVoiceProbe, state: VoiceOutputState): VoiceEngine {
  const configured = probe.providerConfigured && probe.commandPresent && probe.engineInstalled;
  const failure = lastFailure(state, "local");
  const proven = state.engineChecks.local?.ok === true;
  const voices = probe.engineNames.join(", ");
  let detail: string;
  if (!probe.engineInstalled) {
    detail = "No on-device voice is installed, so this box cannot speak by itself yet.";
  } else if (!probe.providerConfigured || !probe.commandPresent) {
    detail = "A voice is installed but the box is not wired to use it. Re-running the update repairs this.";
  } else if (failure) {
    detail = `The last voice check failed: ${failure}`;
  } else {
    // No "set up but unproven" line here, unlike the cloud engine, and that
    // asymmetry is the point: the on-device voice is judged by artefacts read
    // off this disk, so naming the installed voice IS the evidence. A cloud key
    // can only be tested by using it, so until a check succeeds the honest
    // thing to say about it is that nobody has tried.
    detail = voices
      ? `Speaks on the box itself. Nothing leaves it. Installed: ${voices}.`
      : "Speaks on the box itself. Nothing leaves it.";
  }
  return {
    id: "local",
    providerId: LOCAL_TTS_PROVIDER_ID,
    label: "On this box",
    configured,
    proven,
    usable: configured && !failure,
    detail,
  };
}

function cloudEngine(config: VoiceConfigView, state: VoiceOutputState): VoiceEngine {
  const providerId = cloudProviderIdFor(config);
  const hasKey = providerId ? Boolean(credentialFor(config, providerId)) : false;
  const unusableKey = providerId ? cloudCredentialIsUnusable(config, providerId) : false;
  const failure = lastFailure(state, "cloud");
  const proven = state.engineChecks.cloud?.ok === true;
  const configured = Boolean(providerId) && hasKey && !unusableKey;

  let detail: string;
  if (!providerId || !hasKey) {
    detail = "No cloud voice is set up on this box.";
  } else if (unusableKey) {
    // Was "ClawBox AI does not serve the voice yet", which stopped being true on
    // 2026-08-22 and was the most confident wrong sentence in the panel. What is
    // true for every box that still lands here: it holds a ClawBox AI key, and
    // that key does not open a cloud voice for it. The upgrade prompt at the
    // point of USE is TASK-486's, deliberately not duplicated here.
    //
    // It stops there rather than adding "so it speaks with its own voice".
    // This branch knows nothing about the local engine, and a box with no
    // installed voice would have been promised one it does not have — the same
    // class of confident wrong sentence this line replaced. The local row sits
    // directly above it in the panel and answers that question itself.
    detail = "The cloud voice comes with ClawBox AI Max, and this box is not set up to call one.";
  } else if (failure) {
    detail = `The last voice check failed: ${failure}`;
  } else if (proven) {
    detail = "Speaks in the cloud. The words to be spoken leave this box.";
  } else {
    detail = "Set up but not proven on this box yet. Run a voice check to find out.";
  }

  return {
    id: "cloud",
    providerId,
    label: "ClawBox cloud",
    configured,
    proven,
    usable: configured && !failure,
    detail,
  };
}

/**
 * What the selection resolves to right now.
 *
 * Auto follows the standing recommendation but will not pin an engine the box
 * cannot use; an explicit pick is honoured whenever it is usable, and only
 * steps aside when it is not, because a silent box is worse than a box that
 * says which engine it fell back to.
 */
export function resolvePreferredEngine(
  choice: VoiceChoice,
  engines: VoiceEngine[],
): VoiceEngineId | null {
  const usable = (id: VoiceEngineId) => engines.find(e => e.id === id)?.usable === true;
  const order: VoiceEngineId[] = choice === "local"
    ? ["local", "cloud"]
    : choice === "cloud"
      ? ["cloud", "local"]
      : RECOMMENDED_ENGINE === "cloud" ? ["cloud", "local"] : ["local", "cloud"];
  return order.find(usable) ?? null;
}

/**
 * Reuse the chat disclosure rather than write a second one (PR #401, TASK-409).
 *
 * The payload is the shape `tts.status` returns, assembled from what this panel
 * already measured: the primary is the provider actually configured, and the
 * other engine is a fallback when the box HAS it — which is exactly how the
 * gateway derives its own chain.
 *
 * `configured`, not `usable`, and that distinction is the whole point of a
 * privacy notice. A cloud voice whose last check failed is still in the chain:
 * the gateway sends it the text, it fails, and only then does the on-device
 * voice speak. The words left the box either way. Found on .177 with a failing
 * cloud primary, where filtering by `usable` silently dropped the notice while
 * every spoken reply was still being posted to the cloud first.
 *
 * `enabled` is passed as true because the question here is "who would speak",
 * not "is speech switched on": a customer choosing a cloud voice must see the
 * notice at the moment they choose it, not only once the box has spoken.
 */
export function buildVoiceDisclosure(
  activeProviderId: string | null,
  engines: VoiceEngine[],
): string | null {
  const providerStates = engines
    .filter(engine => engine.providerId)
    .map(engine => ({
      id: engine.providerId as string,
      label: engine.id === "cloud" ? CLOUD_DISCLOSURE_LABEL : engine.label,
      configured: engine.configured,
    }));
  const fallbackProviders = engines
    .filter(engine => engine.configured && engine.providerId && engine.providerId !== activeProviderId)
    .map(engine => engine.providerId as string);
  return buildCloudTtsWarning({
    enabled: true,
    provider: activeProviderId ?? undefined,
    fallbackProviders,
    providerStates,
  });
}

export function buildVoiceOutputStatus(
  config: VoiceConfigView,
  probe: LocalVoiceProbe,
  state: VoiceOutputState,
  /** The voice the local script is saved to speak with; its default when unset. */
  localVoice: string | null = null,
): VoiceOutputStatus {
  const engines = [localEngine(probe, state), cloudEngine(config, state)];
  const activeProviderId = configuredTtsProviderId(config);
  const preferredEngine = resolvePreferredEngine(state.choice, engines);
  const preferredProviderId = preferredEngine
    ? engines.find(e => e.id === preferredEngine)?.providerId ?? null
    : null;
  return {
    choice: state.choice,
    activeProviderId,
    activeEngine: engineForProviderId(activeProviderId),
    preferredEngine,
    drifted: Boolean(preferredProviderId) && preferredProviderId !== activeProviderId,
    engines,
    lastCheck: state.lastCheck,
    warning: buildVoiceDisclosure(activeProviderId, engines),
    language: state.language ?? DEFAULT_VOICE_LANGUAGE,
    voice: {
      local: isLocalVoice(localVoice) ? localVoice : DEFAULT_LOCAL_VOICE,
      cloud: cloudVoiceFrom(config),
    },
    voices: { local: LOCAL_VOICES, cloud: CLOUD_VOICES },
  };
}

/**
 * Why an explicit pick cannot be honoured, or null when it can.
 *
 * The gate is CONFIGURED, not usable, and the difference is the whole point. An
 * engine the box does not have is refused out loud rather than quietly turned
 * into the other one — scope line 3 of this task says a choice that silently
 * becomes something else is the failure to avoid, and the mirror is just as
 * bad. But an engine that merely FAILED its last check is still offered: a
 * failure that also removed the customer's ability to retry would be permanent
 * by construction, since Auto stops choosing a failed engine, so no later check
 * would ever route through it and nothing could clear the record.
 *
 * This is about the moment of choosing. Once chosen, the gateway still falls
 * back if the picked engine fails mid-request — which is why the panel
 * separately reports the engine that actually spoke.
 */
export function selectionError(choice: VoiceChoice, engines: VoiceEngine[]): string | null {
  if (choice === "auto") {
    return engines.some(e => e.configured) ? null : "This box has no voice it can use.";
  }
  const engine = engines.find(e => e.id === choice);
  if (!engine || !engine.configured) return "That voice is not available on this box.";
  return null;
}

/**
 * The provider id a choice should write, or null when nothing can be written.
 *
 * An explicit pick writes THAT engine, even if its last check failed — the
 * customer asked for it, and the alternative is a selector that reads back
 * something the customer did not choose. Auto instead resolves to whatever can
 * actually speak.
 */
export function providerIdForChoice(
  choice: VoiceChoice,
  engines: VoiceEngine[],
): string | null {
  if (choice !== "auto") {
    const engine = engines.find(e => e.id === choice);
    return engine?.configured ? engine.providerId : null;
  }
  const preferred = resolvePreferredEngine("auto", engines);
  return preferred ? engines.find(e => e.id === preferred)?.providerId ?? null : null;
}

/**
 * Drop what this box observed about one engine.
 *
 * Called when the customer deliberately picks an engine again: they are asking
 * for a retry, and continuing to say "the last check failed" about a choice
 * they have just re-made would be reporting history as if it were the present.
 * The next check writes a fresh record either way.
 */
export function forgetEngineCheck(state: VoiceOutputState, engine: VoiceEngineId): VoiceOutputState {
  if (!state.engineChecks[engine]) return state;
  // Rebuilt from the fixed list of engine ids rather than spread-and-delete.
  // `engine` reaches here from a request body — validated, but the shape that
  // makes that safe is not visible to a static analyser, and writing a key
  // derived from a request is worth avoiding on principle rather than
  // defending. Every key written below is a literal from a constant.
  const engineChecks: VoiceOutputState["engineChecks"] = {};
  for (const id of VOICE_ENGINE_IDS) {
    if (id === engine) continue;
    const entry = state.engineChecks[id];
    if (entry) engineChecks[id] = entry;
  }
  return { ...state, engineChecks };
}

interface RawAttempt {
  provider?: unknown;
  outcome?: unknown;
  reasonCode?: unknown;
  error?: unknown;
  message?: unknown;
  latencyMs?: unknown;
}

function attemptMessage(raw: RawAttempt): string | null {
  for (const candidate of [raw.error, raw.message, raw.reasonCode]) {
    const safe = sanitizeErrorMessage(typeof candidate === "string" ? candidate : null);
    if (safe && safe !== "success") return safe;
  }
  return null;
}

/**
 * Turn `openclaw capability tts convert --json` into the per-engine record.
 *
 * The CLI reports every provider it tried, in order, with an outcome each — so
 * a run where the cloud primary failed and the on-device voice spoke instead is
 * visible as two attempts, which is the fallback made observable rather than
 * asserted.
 */
export function parseVoiceCheck(rawOutput: unknown, at: number): VoiceCheck {
  const payload = (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput))
    ? rawOutput as Record<string, unknown>
    : {};
  const rawAttempts = Array.isArray(payload.attempts) ? payload.attempts as RawAttempt[] : [];
  const attempts: VoiceAttempt[] = [];
  for (const raw of rawAttempts) {
    const providerId = normalizeProviderId(raw?.provider);
    if (!providerId) continue;
    const ok = raw.outcome === "success";
    const latency = typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs)
      ? raw.latencyMs
      : null;
    attempts.push({
      providerId,
      engine: engineForProviderId(providerId),
      ok,
      message: ok ? null : attemptMessage(raw),
      latencyMs: latency,
    });
  }
  const served = attempts.find(a => a.ok) ?? null;
  const ok = payload.ok === true && served !== null;
  return {
    at,
    ok,
    servedByProviderId: served?.providerId ?? null,
    servedEngine: served?.engine ?? null,
    attempts,
    message: ok ? null : (attempts.find(a => !a.ok)?.message ?? null),
  };
}

/**
 * A failed run that never reached a provider still has to be recorded, or the
 * panel would show the previous success and read as though nothing happened.
 */
export function failedVoiceCheck(rawMessage: unknown, at: number): VoiceCheck {
  return {
    at,
    ok: false,
    servedByProviderId: null,
    servedEngine: null,
    attempts: [],
    message: sanitizeErrorMessage(rawMessage),
  };
}

/**
 * Fold a check's attempts into the per-engine memory the status reads.
 *
 * An engine this check did not attempt keeps its previous record: clearing it
 * would let a known-bad engine read as merely unproven every time the other one
 * is checked, and Auto would keep choosing it. The record is cleared by
 * {@link forgetEngineCheck} instead, when the customer deliberately asks for
 * that engine again.
 */
export function applyCheck(state: VoiceOutputState, check: VoiceCheck): VoiceOutputState {
  const engineChecks = { ...state.engineChecks };
  for (const attempt of check.attempts) {
    if (!attempt.engine) continue;
    engineChecks[attempt.engine] = { ...attempt, at: check.at };
  }
  return { ...state, engineChecks, lastCheck: check };
}
