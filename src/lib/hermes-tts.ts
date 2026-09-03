import { hermesConfigGetMany } from "@/lib/hermes-config-cache";
import { runHermesCli } from "@/lib/hermes-cli";
import { CLAWBOX_AI_PROXY_URL } from "@/lib/harness/credentials";
import { LOCAL_TTS_PROVIDER_ID, type VoiceConfigView } from "@/lib/voice-output";

/**
 * Speech on the Hermes edition, driven through Hermes' OWN TTS pipeline.
 *
 * The Voice tab used to be a card reading "Speaking out loud is an OpenClaw
 * feature". That was never true of the hardware — it was true of the LOOKUP.
 * Hermes ships a first-class `tts:` config block (eleven providers), a
 * `text_to_speech` agent tool, and `POST /api/audio/speak` on its dashboard,
 * all of it read off the pinned box:
 *
 *   `hermes config get tts` → `provider: edge` plus openai / elevenlabs /
 *   piper / kittentts / neutts / … ; and tools/tts_tool.py resolves an
 *   OpenAI-compatible endpoint from `tts.openai.base_url`, passing api_key,
 *   base_url, model and voice straight through to it.
 *
 * So nothing here synthesises anything or invents a catalogue. It maps
 * ClawBox's two engines onto the two Hermes providers that mean the same
 * thing, and lets Hermes speak:
 *
 *   "ClawBox cloud" → `tts.provider: openai` with `tts.openai.base_url`
 *                     pointed at the ClawBox AI proxy and the device's `claw_`
 *                     token, which is exactly what OpenClaw's
 *                     `tts.providers.openai` holds and exactly the idiom
 *                     `applyClawaiToHermes` already uses for chat and images.
 *   "This box"      → `tts.providers.clawbox-local`, a `type: command`
 *                     provider wrapping the same `clawbox-tts.sh` (Kokoro) the
 *                     OpenClaw edition speaks with. install.sh registers it;
 *                     the name below is that contract and must not drift.
 *
 * The other nine providers are deliberately NOT offered: parity with the
 * OpenClaw panel is the requirement, and a dropdown listing engines one
 * edition has and the other does not is not parity. They stay in Hermes'
 * config untouched, for an owner who sets one by hand.
 */

/** The `type: command` provider install.sh registers. Contract with install.sh. */
export const HERMES_LOCAL_TTS_PROVIDER = "clawbox-local";

/**
 * The OpenAI-compatible slot, which on a ClawBox points at the ClawBox AI
 * proxy rather than at OpenAI. Hermes' own name for it; not ours to rename.
 */
export const HERMES_CLOUD_TTS_PROVIDER = "openai";

/**
 * What Hermes ships as `tts.provider` out of the box.
 *
 * Edge is Microsoft's free cloud voice. A ClawBox must never speak through it
 * by default: the Voice tab's privacy line says either "nothing leaves the
 * box" or names the cloud the words go to, and Edge is a third cloud the
 * customer never chose and the panel never mentions. So it is treated as
 * FACTORY-UNSET — replaceable by the first real selection — rather than as an
 * owner's pick to preserve. Anything else in that key is someone's deliberate
 * choice and is left alone. install.sh applies the same rule at provisioning.
 */
export const HERMES_FACTORY_TTS_PROVIDER = "edge";

/** The cloud speech model, matching the OpenClaw edition's default. */
export const HERMES_CLOUD_TTS_MODEL = "gpt-4o-mini-tts";

const KEYS = {
  provider: "tts.provider",
  localType: `tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.type`,
  localCommand: `tts.providers.${HERMES_LOCAL_TTS_PROVIDER}.command`,
  cloudVoice: `tts.${HERMES_CLOUD_TTS_PROVIDER}.voice`,
  cloudModel: `tts.${HERMES_CLOUD_TTS_PROVIDER}.model`,
  cloudBaseUrl: `tts.${HERMES_CLOUD_TTS_PROVIDER}.base_url`,
} as const;

export interface HermesVoiceProbe {
  /** `tts.provider`, or null when unset or unreadable. */
  provider: string | null;
  /** The command provider install.sh registers is present AND is a command. */
  localRegistered: boolean;
  /** The command it runs, so the route can check it is still on disk. */
  localCommand: string | null;
  cloudVoice: string | null;
  cloudModel: string | null;
  /** Where the OpenAI-compatible slot points. Null until something writes it. */
  cloudBaseUrl: string | null;
}

function trimmed(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? v : null;
}

/**
 * Read the box's speech config in one pass.
 *
 * Through `hermesConfigGetMany`, whose memo is keyed on config.yaml's mtime:
 * every write below rewrites that file, so a selection the owner just made
 * can never be served from a stale read. That is also why this is not a
 * probe-once — there is no cached "can this box speak" boolean anywhere in
 * this module; the question is re-asked and the file's own mtime decides
 * whether the answer is reused.
 */
export async function readHermesVoice(): Promise<HermesVoiceProbe> {
  const values = await hermesConfigGetMany(Object.values(KEYS));
  const localType = trimmed(values[KEYS.localType]);
  return {
    provider: trimmed(values[KEYS.provider]),
    // Hermes rejects a provider whose `type` is set to anything but `command`
    // (tts_tool.py), so this is the same test the harness itself applies.
    localRegistered: localType === "command",
    localCommand: trimmed(values[KEYS.localCommand]),
    cloudVoice: trimmed(values[KEYS.cloudVoice]),
    cloudModel: trimmed(values[KEYS.cloudModel]),
    cloudBaseUrl: trimmed(values[KEYS.cloudBaseUrl]),
  };
}

/**
 * Hermes' speech config, said in the shape the shared status builder reads.
 *
 * Deliberately a PROJECTION rather than a second status builder. Everything
 * the Voice tab shows — which engine is configured, which one Auto resolves
 * to, whether the selection has drifted, the privacy disclosure — is decided
 * by `buildVoiceOutputStatus`, and a Hermes-only copy of those rules would be
 * a second place for the two editions to disagree about the same box. So the
 * harness's own config is translated into the view that builder already reads,
 * and one set of rules serves both editions.
 *
 * `token` is the device's ClawBox AI credential (from `harness/credentials`,
 * which is edition-agnostic). Without one the cloud engine correctly reports
 * itself unconfigured, exactly as it does on an unlinked OpenClaw box.
 */
export function hermesVoiceConfigView(probe: HermesVoiceProbe, token: string | null): VoiceConfigView {
  const providers: Record<string, Record<string, unknown>> = {};
  if (probe.localRegistered && probe.localCommand) {
    providers[LOCAL_TTS_PROVIDER_ID] = { command: probe.localCommand };
  }
  if (token) {
    providers[HERMES_CLOUD_TTS_PROVIDER] = {
      apiKey: token,
      // The endpoint is what turns a `claw_` token from a credential with
      // nowhere to go into a working one — the same rule
      // `cloudCredentialIsUnusable` applies on the OpenClaw side. A box whose
      // key is written but whose base_url is not is reported unusable, not
      // configured, so the panel never offers a voice that would 401.
      ...(probe.cloudBaseUrl ? { baseUrl: probe.cloudBaseUrl } : {}),
      ...(probe.cloudVoice ? { voice: probe.cloudVoice } : {}),
      ...(probe.cloudModel ? { model: probe.cloudModel } : {}),
    };
  }
  return {
    tts: {
      // Said in the canonical id the shared rules know, and DROPPED when it is
      // neither of ours.
      //
      // The drop is the load-bearing part. `engineForProviderId` sorts every
      // unknown id into "cloud" (only an explicitly local-looking name is
      // local), so passing Hermes' factory `edge` straight through made the
      // panel report ClawBox cloud as the active engine on a box speaking
      // through Microsoft — a cloud the customer never chose and the privacy
      // line never names. Reported as no active engine instead, which is the
      // truth and which also lets Auto move the box onto a real one.
      ...(probe.provider === HERMES_LOCAL_TTS_PROVIDER
        ? { provider: LOCAL_TTS_PROVIDER_ID }
        : probe.provider === HERMES_CLOUD_TTS_PROVIDER
          ? { provider: HERMES_CLOUD_TTS_PROVIDER }
          : {}),
      providers,
    },
  };
}

/** Hermes' name for one of our two engines. */
export function hermesProviderFor(engine: "local" | "cloud"): string {
  return engine === "local" ? HERMES_LOCAL_TTS_PROVIDER : HERMES_CLOUD_TTS_PROVIDER;
}

/**
 * True when `tts.provider` may be overwritten by a selection without asking.
 *
 * Unset, or Hermes' factory Edge. See `HERMES_FACTORY_TTS_PROVIDER`.
 */
export function hermesTtsProviderIsFactory(provider: string | null): boolean {
  return provider === null || provider === HERMES_FACTORY_TTS_PROVIDER;
}

export class HermesTtsWriteError extends Error {}

async function set(key: string, value: string): Promise<void> {
  const r = await runHermesCli(["config", "set", key, value], { timeoutMs: 15_000 });
  if (r.code !== 0) {
    // The key, never the value: one of these writes carries the device token.
    // Passed as arguments rather than interpolated, for the same reason
    // hermes-clawai.ts does it — a log line built from a value is a tainted
    // format string.
    console.error("[hermes/tts] config write failed", key, r.code);
    throw new HermesTtsWriteError(`Could not write ${key}.`);
  }
}

/**
 * Point Hermes' OpenAI-compatible speech slot at the ClawBox AI proxy.
 *
 * The endpoint and the credential together, because neither is any use alone:
 * the token without the base_url goes to api.openai.com and comes back 401,
 * and the base_url without the token is an endpoint nothing may call. Written
 * before the provider is ever SELECTED (see `selectHermesEngine`), so a box
 * can never be left pointing at a provider that has nowhere to send a request.
 */
export async function writeHermesCloudTarget(token: string): Promise<void> {
  await set(KEYS.cloudBaseUrl, CLAWBOX_AI_PROXY_URL);
  await set(`tts.${HERMES_CLOUD_TTS_PROVIDER}.api_key`, token);
  await set(KEYS.cloudModel, HERMES_CLOUD_TTS_MODEL);
}

/**
 * Which engine speaks for this box.
 *
 * DEFINITION BEFORE SELECTION, the same order install.sh and the OpenClaw
 * route both use: for the cloud that means the endpoint and credential land
 * first, and a failure there leaves `tts.provider` untouched rather than
 * selecting a provider that cannot answer. A selected provider that refuses
 * every utterance is strictly worse than an unchanged one.
 */
export async function selectHermesEngine(engine: "local" | "cloud", token: string | null): Promise<void> {
  if (engine === "cloud") {
    if (!token) throw new HermesTtsWriteError("This box has no ClawBox AI credential to speak with.");
    await writeHermesCloudTarget(token);
  }
  await set(KEYS.provider, hermesProviderFor(engine));
}

/** The voice an engine speaks with, in Hermes' own per-provider key. */
export async function writeHermesCloudVoice(voice: string): Promise<void> {
  await set(KEYS.cloudVoice, voice);
}

/**
 * How long a synthesis may take before we stop waiting.
 *
 * Sized off the on-device engine, not the cloud one: `clawbox-tts.sh` pays a
 * full Kokoro cold start whenever kokoro-server is not already up — 13-17 s
 * measured on an Orin Nano — and a deadline shorter than that would abort the
 * first sample a customer ever asks for and report it as a failure.
 */
const SPEAK_TIMEOUT_MS = 90_000;

/** Below this a clip is a container header and nothing else. */
const MIN_AUDIO_BYTES = 1024;

export type HermesSpeech =
  | { ok: true; audio: Uint8Array<ArrayBuffer>; mime: string }
  | { ok: false; code: string; status: number; reason?: string };

/**
 * Speak `text` with whatever Hermes is configured to speak with.
 *
 * Hermes' own `POST /api/audio/speak`, through `dashboardFetch` — the same
 * server-side, session-authenticated path the provider-OAuth and model-options
 * routes already use. Nothing is synthesised here and no provider chain is
 * reimplemented: the endpoint resolves `tts.provider` itself, which is exactly
 * the key the Voice tab writes, so what the customer hears is what the box is
 * configured to say things with.
 *
 * The answer is a base64 data URL. It is decoded and length-checked before
 * being called success: an `ok: true` carrying a 200-byte header is the
 * "false success" this codebase keeps producing, and a Play button that
 * reports success and then plays silence is worse than one that refuses.
 */
export async function speakWithHermes(
  text: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HermesSpeech> {
  const { dashboardFetch } = await import("@/lib/hermes-dashboard-auth");
  let res: Response;
  try {
    res = await dashboardFetch("/api/audio/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      timeoutMs: opts.timeoutMs ?? SPEAK_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    return { ok: false, code: "cloud_no_answer", status: 502 };
  }
  if (!res.ok) {
    return { ok: false, code: res.status === 401 ? "cannot_change" : "cloud_refused", status: 502 };
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: unknown; data_url?: unknown; mime_type?: unknown; error?: unknown }
    | null;
  if (!body || body.ok === false || typeof body.data_url !== "string") {
    return {
      ok: false,
      code: "no_voice",
      status: 502,
      ...(typeof body?.error === "string" ? { reason: body.error } : {}),
    };
  }
  // `data:<mime>;base64,<payload>` — anything else is not a clip we can play.
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(body.data_url);
  if (!match) return { ok: false, code: "cloud_no_audio", status: 502 };
  const audio = Buffer.from(match[2], "base64");
  if (audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, code: "cloud_no_audio", status: 502 };
  const declared = typeof body.mime_type === "string" ? body.mime_type.split(";")[0].trim() : "";
  const mime = declared.startsWith("audio/") ? declared : match[1].startsWith("audio/") ? match[1] : "audio/wav";
  // `Uint8Array.from`, not `new Uint8Array(buffer)`: a Node Buffer is
  // backed by a pooled ArrayBuffer that a Response body cannot take.
  return { ok: true, audio: Uint8Array.from(audio), mime };
}

/**
 * Is this box configured to speak at all?
 *
 * The fact behind `canSpeakReplies`. Both halves are asked, because a provider
 * NAMED is not a provider that can answer: the on-device one needs its command
 * registered, and the cloud one needs the endpoint that turns a `claw_` token
 * into a usable credential. A box that named a provider and lost its
 * definition must report that it cannot speak, not offer a player that plays
 * nothing.
 *
 * Fails CLOSED, like every other fact in the capability table: a probe that
 * could not be answered promises no player.
 */
export async function hermesSpeaksReplies(): Promise<boolean> {
  try {
    const probe = await readHermesVoice();
    if (probe.provider === HERMES_LOCAL_TTS_PROVIDER) {
      return probe.localRegistered && probe.localCommand !== null;
    }
    if (probe.provider === HERMES_CLOUD_TTS_PROVIDER) return probe.cloudBaseUrl !== null;
    // Anything else — unset, or Hermes' factory Edge — is not a voice ClawBox
    // offers, so this box speaks nothing the panel would claim.
    return false;
  } catch {
    return false;
  }
}
