/**
 * Voice output: which engine speaks for this box.
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
 *     whole job is to set the primary honestly — inventing a second chain here
 *     would just be a chain that can disagree with the one that runs.
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
 * So availability here is read off the box — the local engine from the
 * artefacts on its disk, the cloud one from a credential with an endpoint
 * behind it. The per-engine "voice check" that used to record which engine
 * actually spoke went with the Check button (the Voice tab is three dropdowns
 * and a sentence to hear); the gateway's own fall-through covers a failure at
 * speech time, and `tts/sample` auditions ONE engine on demand.
 */
import { buildCloudTtsWarning, cloudTtsDisclosure, type CloudTtsDisclosure } from "@/lib/tts-cloud-warning";
import { isClawboxAiToken } from "@/lib/clawai-token";
import {
  DEFAULT_CLOUD_VOICE,
  DEFAULT_LOCAL_VOICE,
  DEFAULT_VOICE_LANGUAGE,
  isCloudVoiceFor,
  isLocalVoice,
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
  /** OpenClaw 2's home for the speech config. */
  tts?: {
    provider?: unknown;
    providers?: unknown;
  };
  /** The pre-2026.8 home; still read so a not-yet-migrated box keeps its voice. */
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

export interface VoiceEngine {
  id: VoiceEngineId;
  providerId: string | null;
  label: string;
  /** Everything this engine needs is present on the box. */
  configured: boolean;
  /** One line the customer can act on. Never a path, a URL or a credential. */
  detail: string;
}

export interface VoiceOutputStatus {
  choice: VoiceChoice;
  /** `messages.tts.provider` exactly as it stands in openclaw.json. */
  activeProviderId: string | null;
  /** Which of our two engines that provider is, or null when it is neither. */
  activeEngine: VoiceEngineId | null;
  /** What `choice` resolves to given what the box has. */
  preferredEngine: VoiceEngineId | null;
  /** The selection and the box disagree — Auto has somewhere to move to. */
  drifted: boolean;
  engines: VoiceEngine[];
  /**
   * The TASK-409 privacy notice, built by the same function the chat banner
   * uses, so the two surfaces cannot word the same fact differently.
   */
  warning: string | null;
  /**
   * The same fact as `warning`, unworded, so the Voice tab can say it in the
   * owner's language: which cloud providers are in the chain and whether the
   * cloud speaks first or only when the box's own voice cannot.
   */
  disclosure: CloudTtsDisclosure | null;
  /** The language the sample sentence comes in: the owner's pick, or the UI language until they make one. */
  language: string;
  /** The voice each engine speaks with right now; the lists are in voice-catalog.ts. */
  voice: Record<VoiceEngineId, string>;
  /**
   * The cloud speech model openclaw.json names, or null for the provider's
   * default. The Voice tab reads it to offer only the voices that model has
   * (`cloudVoicesFor`). Optional on the type because the panel's own validator
   * does not require it — a status written before it existed still renders.
   */
  cloudModel?: string | null;
}

/** Persisted in the setup app's own data dir; see voice-output-store.ts. */
export interface VoiceOutputState {
  choice: VoiceChoice;
  /**
   * Sample-sentence language on the Voice tab. Absent until the owner picks
   * one — the tts route then shows the UI language instead, so a German
   * desktop opens the tab on a German sample without a second setting.
   */
  language?: string;
}

export const DEFAULT_VOICE_STATE: VoiceOutputState = {
  choice: "auto",
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
  model?: unknown;
  enabled?: unknown;
}

/**
 * The cloud voice openclaw.json names (`messages.tts.providers.<cloud>.voice`),
 * or the engine's own default when nothing is written — which is what the
 * gateway speaks with in that case, so the dropdown shows the same thing.
 */
export function cloudVoiceFrom(config: VoiceConfigView): string {
  const providerId = cloudProviderIdFor(config);
  const voice = providerId ? ttsProviders(config)[providerId]?.voice : undefined;
  // Judged against the model that will speak it: a `verse` left in the file
  // beside `tts-1` is a voice that model refuses, so the engine's default is
  // the honest answer to "what does this box speak with".
  return isCloudVoiceFor(cloudModelFrom(config), voice) ? voice : DEFAULT_CLOUD_VOICE;
}

/**
 * The cloud speech model openclaw.json names (`messages.tts.providers.<cloud>.model`),
 * or null for the provider's default. Read without the credential check
 * `cloudSpeechTarget` makes, because which voices to OFFER is a question about
 * the model, not about whether the box can call it right now.
 */
export function cloudModelFrom(config: VoiceConfigView): string | null {
  const providerId = cloudProviderIdFor(config);
  const model = providerId ? ttsProviders(config)[providerId]?.model : undefined;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function ttsProviders(config: VoiceConfigView): Record<string, TtsProviderEntry> {
  const providers = config.tts?.providers ?? config.messages?.tts?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  return providers as Record<string, TtsProviderEntry>;
}

export function configuredTtsProviderId(config: VoiceConfigView): string | null {
  return normalizeProviderId(config.tts?.provider ?? config.messages?.tts?.provider);
}

/**
 * Which provider a cloud pick would write. Prefer an explicit `messages.tts`
 * entry — someone who configured their own cloud voice means that one — and
 * fall back to the OpenAI-compatible provider the ClawBox image ships.
 */
export function cloudProviderIdFor(config: VoiceConfigView): string | null {
  for (const [id, entry] of Object.entries(ttsProviders(config))) {
    const normalized = normalizeProviderId(id);
    // A provider switched off in the chain (Microsoft's bundled voice, see
    // ensureMicrosoftTtsExcluded) is not the cloud voice, however early it
    // sits in the file.
    if (normalized && !isLocalProviderId(normalized) && entry?.enabled !== false) return normalized;
  }
  const models = config.models?.providers ?? {};
  if (models[DEFAULT_CLOUD_TTS_PROVIDER_ID]) return DEFAULT_CLOUD_TTS_PROVIDER_ID;
  return null;
}

/** What a speech request to the cloud needs, or null when this box cannot make one. */
export interface CloudSpeechTarget {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  /** The configured model, or null for the provider's default. */
  model: string | null;
}

/** OpenClaw's own default for the OpenAI speech provider. */
const DEFAULT_OPENAI_SPEECH_URL = "https://api.openai.com/v1";

/**
 * The one answer to "can this box call the cloud voice, and with what": the
 * same rule `cloudEngine` uses for `configured`, so a voice the dropdown
 * offers is one the Play button can reach.
 */
export function cloudSpeechTarget(config: VoiceConfigView): CloudSpeechTarget | null {
  const providerId = cloudProviderIdFor(config);
  if (!providerId) return null;
  const apiKey = credentialFor(config, providerId);
  if (!apiKey || cloudCredentialIsUnusable(config, providerId)) return null;
  const entry = ttsProviders(config)[providerId];
  const baseUrl = [entry?.baseUrl, config.models?.providers?.[providerId]?.baseUrl]
    .find((u): u is string => typeof u === "string" && Boolean(u.trim()))?.trim() ?? DEFAULT_OPENAI_SPEECH_URL;
  const model = typeof entry?.model === "string" && entry.model.trim() ? entry.model.trim() : null;
  return { providerId, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model };
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
 * `openai` slot is the owner's own. Saying so is the difference between a
 * selector that reports the box and one that repeats a registry.
 */
export function cloudCredentialIsUnusable(config: VoiceConfigView, providerId: string): boolean {
  const key = credentialFor(config, providerId);
  if (!key) return false;
  return isClawboxAiToken(key) && !cloudEndpointConfigured(config, providerId);
}

export interface LocalVoiceProbe {
  /** `messages.tts.providers["tts-local-cli"]` names a command. */
  providerConfigured: boolean;
  /** That command is really on disk AND executable — see `localTtsCommandRunnable`. */
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

function localEngine(probe: LocalVoiceProbe): VoiceEngine {
  const configured = probe.providerConfigured && probe.commandPresent && probe.engineInstalled;
  const voices = probe.engineNames.join(", ");
  let detail: string;
  if (!probe.engineInstalled) {
    detail = "No on-device voice is installed, so this box cannot speak by itself yet.";
  } else if (!probe.providerConfigured || !probe.commandPresent) {
    detail = "A voice is installed but the box is not wired to use it. Re-running the update repairs this.";
  } else {
    // The on-device voice is judged by artefacts read off this disk, so naming
    // the installed voice IS the evidence.
    detail = voices
      ? `Speaks on the box itself. Nothing leaves it. Installed: ${voices}.`
      : "Speaks on the box itself. Nothing leaves it.";
  }
  return {
    id: "local",
    providerId: LOCAL_TTS_PROVIDER_ID,
    label: "On this box",
    configured,
    detail,
  };
}

function cloudEngine(config: VoiceConfigView): VoiceEngine {
  const providerId = cloudProviderIdFor(config);
  const hasKey = providerId ? Boolean(credentialFor(config, providerId)) : false;
  const unusableKey = providerId ? cloudCredentialIsUnusable(config, providerId) : false;
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
  } else {
    detail = "Speaks in the cloud. The words to be spoken leave this box.";
  }

  return {
    id: "cloud",
    providerId,
    label: "ClawBox cloud",
    configured,
    detail,
  };
}

/**
 * What the selection resolves to right now.
 *
 * Auto follows the standing recommendation but will not pin an engine the box
 * does not have; an explicit pick is honoured whenever the box has it, and
 * only steps aside when it does not, because a silent box is worse than a box
 * that says which engine it fell back to.
 */
export function resolvePreferredEngine(
  choice: VoiceChoice,
  engines: VoiceEngine[],
): VoiceEngineId | null {
  const configured = (id: VoiceEngineId) => engines.find(e => e.id === id)?.configured === true;
  const order: VoiceEngineId[] = choice === "local"
    ? ["local", "cloud"]
    : choice === "cloud"
      ? ["cloud", "local"]
      : RECOMMENDED_ENGINE === "cloud" ? ["cloud", "local"] : ["local", "cloud"];
  return order.find(configured) ?? null;
}

/**
 * Reuse the chat disclosure rather than write a second one (PR #401, TASK-409).
 *
 * The payload is the shape `tts.status` returns, assembled from what this panel
 * already measured: the primary is the provider actually configured, and the
 * other engine is a fallback when the box HAS it — which is exactly how the
 * gateway derives its own chain.
 *
 * `enabled` is passed as true because the question here is "who would speak",
 * not "is speech switched on": a customer choosing a cloud voice must see the
 * notice at the moment they choose it, not only once the box has spoken.
 */
function disclosurePayload(activeProviderId: string | null, engines: VoiceEngine[]) {
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
  return {
    enabled: true,
    provider: activeProviderId ?? undefined,
    fallbackProviders,
    providerStates,
  };
}

export function buildVoiceDisclosure(
  activeProviderId: string | null,
  engines: VoiceEngine[],
): string | null {
  return buildCloudTtsWarning(disclosurePayload(activeProviderId, engines));
}

export function buildVoiceOutputStatus(
  config: VoiceConfigView,
  probe: LocalVoiceProbe,
  state: VoiceOutputState,
  /** The voice the local script is saved to speak with; its default when unset. */
  localVoice: string | null = null,
): VoiceOutputStatus {
  const engines = [localEngine(probe), cloudEngine(config)];
  const activeProviderId = configuredTtsProviderId(config);
  const preferredEngine = resolvePreferredEngine(state.choice, engines);
  const preferredProviderId = preferredEngine
    ? engines.find(e => e.id === preferredEngine)?.providerId ?? null
    : null;
  const payload = disclosurePayload(activeProviderId, engines);
  return {
    choice: state.choice,
    activeProviderId,
    activeEngine: engineForProviderId(activeProviderId),
    preferredEngine,
    drifted: Boolean(preferredProviderId) && preferredProviderId !== activeProviderId,
    engines,
    warning: buildCloudTtsWarning(payload),
    disclosure: cloudTtsDisclosure(payload),
    language: state.language ?? DEFAULT_VOICE_LANGUAGE,
    voice: {
      local: isLocalVoice(localVoice) ? localVoice : DEFAULT_LOCAL_VOICE,
      cloud: cloudVoiceFrom(config),
    },
    cloudModel: cloudModelFrom(config),
  };
}

/**
 * Why an explicit pick cannot be honoured, or null when it can.
 *
 * An engine the box does not have is refused out loud rather than quietly
 * turned into the other one — scope line 3 of this task says a choice that
 * silently becomes something else is the failure to avoid, and the mirror is
 * just as bad.
 *
 * This is about the moment of choosing. Once chosen, the gateway still falls
 * back if the picked engine fails mid-request.
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
 * An explicit pick writes THAT engine — the customer asked for it, and the
 * alternative is a selector that reads back something the customer did not
 * choose. Auto instead resolves to whatever the box has.
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
