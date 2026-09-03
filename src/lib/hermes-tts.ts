import { hermesConfigGet, hermesConfigGetMany, hermesConfigReadPending } from "@/lib/hermes-config-cache";
import { runHermesCli } from "@/lib/hermes-cli";
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
  cloudApiKey: `tts.${HERMES_CLOUD_TTS_PROVIDER}.api_key`,
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
  /**
   * Whether Hermes has a credential to authenticate the cloud voice with.
   *
   * Read as a PRESENCE, never carried: `writeHermesCloudTarget` writes three
   * keys and `set` throws on the first failure, so a box can hold the endpoint
   * while the credential never landed. Reporting that box as configured — off
   * the endpoint alone — would be a cloud voice that 401s on every utterance
   * under a panel calling it ready.
   */
  cloudHasKey: boolean;
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
    cloudHasKey: trimmed(values[KEYS.cloudApiKey]) !== null,
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
export function hermesVoiceConfigView(
  probe: HermesVoiceProbe,
  token: string | null,
  /**
   * The ClawBox AI speech endpoint, or NULL when this box's plan does not
   * include the cloud voice.
   *
   * Null is how entitlement is said here, and it is deliberate rather than a
   * shortcut: a `claw_` credential with no endpoint behind it is exactly the
   * state `cloudCredentialIsUnusable` already describes, and the panel already
   * has the right sentence for it ("The cloud voice comes with ClawBox AI Max,
   * and this box is not set up to call one."). The OpenClaw side gates the
   * same way — gateway-pre-start.sh writes the speech provider only for a
   * portal-confirmed `pro` device — and its comment says why: pointing an
   * unentitled box at a route that answers 403 would have the panel call the
   * cloud voice configured and every spoken reply pay a failed round trip.
   */
  proxyUrl: string | null,
): VoiceConfigView {
  const providers: Record<string, Record<string, unknown>> = {};
  if (probe.localRegistered && probe.localCommand) {
    providers[LOCAL_TTS_PROVIDER_ID] = { command: probe.localCommand };
  }
  if (token) {
    providers[HERMES_CLOUD_TTS_PROVIDER] = {
      apiKey: token,
      // The endpoint a ClawBox would use is a DERIVED CONSTANT, not a fact
      // discovered on the box — which is the whole difference between this
      // working and not.
      //
      // It read `probe.cloudBaseUrl` alone, and that was a deadlock: the key
      // is written only by `writeHermesCloudTarget`, reached only from
      // `selectHermesEngine("cloud")`, reached only after `selectionError`
      // has passed — and that refuses `cloud` unless the engine is already
      // `configured`, which needed the endpoint to be there. So on every real
      // box (install.sh writes only the local provider) the cloud option was
      // rendered disabled for ever and the whole cloud arm was unreachable.
      //
      // What `configured` should mean here is "this box CAN be pointed at the
      // proxy", i.e. it holds a `claw_` token — and the selection is what
      // actually points it. A box already pointed somewhere keeps that value.
      // ENTITLEMENT GATES THE PERSISTED ENDPOINT TOO, not just the derived
      // one. A box that was entitled, had `tts.openai.base_url` written, and
      // then dropped off the plan still holds that key — reading it here would
      // keep reporting a configured cloud voice whose every utterance the
      // proxy now answers 403. So the endpoint is exposed only while the plan
      // is: `proxyUrl` null means "not entitled", and the panel then falls to
      // `cloudCredentialIsUnusable` and its "comes with ClawBox AI Max" line,
      // which is the true statement about such a box.
      ...(proxyUrl ? { baseUrl: probe.cloudBaseUrl ?? proxyUrl } : {}),
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
  // IMPORTED HERE, not at the top of the file, for the reason hermes-clawai.ts
  // gives for the same move: `harness/credentials` reaches `openclaw-config`,
  // which spawns the openclaw CLI, and a static import would put that whole
  // machinery in the module graph of every route that merely READS the voice
  // config — including the Hermes chat turn, which never links a box and on
  // whose edition that CLI does not exist.
  const { CLAWBOX_AI_PROXY_URL } = await import("@/lib/harness/credentials");
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

/**
 * The largest speak response worth reading.
 *
 * A base64 data URL is ~4/3 of the audio, and the longest reply this path will
 * ever ask for is 4000 characters — seconds of speech, a few hundred KB at
 * any sane bitrate. 12 MB is orders of magnitude of headroom and still a bound
 * a Jetson survives.
 */
const MAX_SPEECH_BYTES = 12 * 1024 * 1024;

/**
 * The response body, or null when it exceeds `limit`.
 *
 * Streamed with a running total rather than `res.json()`, so an oversized peer
 * is abandoned partway instead of being buffered whole and then rejected.
 */
async function readBounded(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        console.warn("[hermes/tts] speak response exceeded", limit, "bytes — refused");
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

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
  // BOUNDED BEFORE IT IS BUFFERED. This runs on every reply on the chat path,
  // and neither the character cap on the text nor the abort deadline limits a
  // peer that returns a huge body quickly — `res.json()` would buffer all of
  // it into a Jetson's memory and take the chat handler down with it. Read the
  // stream with a running total instead, and refuse rather than truncate: half
  // a clip is not a clip. Content-Length is not trusted; it is advisory and
  // absent on a chunked response.
  const raw = await readBounded(res, MAX_SPEECH_BYTES);
  if (raw === null) return { ok: false, code: "cloud_no_audio", status: 502 };
  let body: { ok?: unknown; data_url?: unknown; mime_type?: unknown; error?: unknown } | null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
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
    // Read the SELECTION first and only then the one key that can confirm it,
    // rather than the whole block through `readHermesVoice`. Every key is a
    // `hermes config get`, i.e. a Python interpreter, and this runs on the chat
    // turn: asking all six would start six of them on an 8 GB board the first
    // time after any config write, five of which cannot change the answer.
    // Two of the three cases below settle on the first read alone.
    const provider = trimmed(await hermesConfigGet(KEYS.provider));
    if (provider === HERMES_LOCAL_TTS_PROVIDER) {
      // Three halves, not two, and the third is the one the config cannot see.
      //
      // A provider NAMED is not a provider that can answer, and install.sh
      // registers and selects `clawbox-local` regardless of Kokoro's own
      // verdict — a board that declines the engine is a documented, non-fatal
      // state that step_validate_services reports as "this box has NO working
      // on-device TTS engine". Asking the config alone therefore said yes on
      // exactly that box: the chat promised a player, every turn synthesised
      // nothing, while the Voice tab — which asks `buildTtsInventory()` — read
      // the same box as not installed. Two surfaces, one box, two answers.
      //
      // So the ENGINE is asked the same way the panel asks it. Re-stat'ed per
      // call (kokoroEntry reads the stamp and the unit every time, and this
      // module caches no verdict of its own), so installing Kokoro later flips
      // it without a restart.
      const [type, command, installed] = await Promise.all([
        hermesConfigGet(KEYS.localType),
        hermesConfigGet(KEYS.localCommand),
        localTtsEngineInstalled(),
      ]);
      const script = trimmed(command);
      if (trimmed(type) !== "command" || script === null || !installed) return false;
      // The command FILE, not just the string that names it — the third of the
      // panel's three conditions (`providerConfigured && commandPresent &&
      // engineInstalled`). A box whose clawbox-tts.sh is gone while the Kokoro
      // stamp and unit remain would otherwise have the chat promising a player
      // while the Voice tab says the box is not wired to use its voice.
      return await commandFileExists(script);
    }
    // The endpoint AND the credential: `writeHermesCloudTarget` writes them
    // separately and the first failure throws, so a box can hold one without
    // the other — and either alone speaks nothing.
    if (provider === HERMES_CLOUD_TTS_PROVIDER) {
      // The plan first: a box that lost its entitlement keeps the endpoint and
      // the credential on disk, and speaking through them costs a 403 per
      // reply while the capability claims a voice.
      if (!(await speechEntitledTier())) return false;
      const [baseUrl, apiKey] = await Promise.all([
        hermesConfigGet(KEYS.cloudBaseUrl),
        hermesConfigGet(KEYS.cloudApiKey),
      ]);
      return trimmed(baseUrl) !== null && trimmed(apiKey) !== null;
    }
    // Anything else — unset, or Hermes' factory Edge — is not a voice ClawBox
    // offers, so this box speaks nothing the panel would claim.
    return false;
  } catch {
    return false;
  }
}

/**
 * Did the voice probe FAIL rather than answer "no"?
 *
 * `hermesSpeaksReplies` fails closed, so "this box has no voice" and "the box
 * could not be asked" leave by the same door — right for the capability, wrong
 * for the page, which fetches these facts once on mount and on no timer. Its
 * three sibling probes each contribute one of these to `factsPending`; without
 * it a single timed-out `hermes config get` hid the box's voice until reload.
 *
 * Reads the memo without touching it, so it never starts a spawn of its own.
 */
export function hermesVoiceProbePending(): boolean {
  // Every key the verdict can rest on, not just the selection. `tts.provider`
  // can answer while the read that CONFIRMS it — the command definition, or
  // the endpoint and credential — is the one that timed out; the verdict is
  // then a `false` nobody will re-ask for, and the box's voice stays hidden
  // until the page is reloaded. Over-reporting "ask me again" is the safe
  // direction here: these accessors read the memo without spawning anything.
  return [KEYS.provider, KEYS.localType, KEYS.localCommand, KEYS.cloudBaseUrl, KEYS.cloudApiKey]
    .some(hermesConfigReadPending);
}

/**
 * The device tier the ClawBox AI proxy serves speech to.
 *
 * `gateway-pre-start.sh` gates the OpenClaw side on exactly this value
 * (`CLAWBOX_SPEECH_DEVICE_TIER = "pro"`), because the proxy answers 403 to
 * anything below it. Named here so the two editions cannot drift into
 * disagreeing about who has a cloud voice.
 */
export const CLAWBOX_AI_SPEECH_TIER = "pro";

/**
 * Does this box's plan include the cloud voice?
 *
 * Read from the tier the portal hand-off stamped (`clawai_tier`), the same
 * fact the gateway pre-start reads. Fails CLOSED: a tier that cannot be read
 * is not evidence of an entitlement, and claiming one would put the panel back
 * to calling a 403 a configured voice.
 */
export async function speechEntitledTier(): Promise<boolean> {
  try {
    const { get } = await import("@/lib/config-store");
    return (await get("clawai_tier")) === CLAWBOX_AI_SPEECH_TIER;
  } catch {
    return false;
  }
}

/**
 * Is an on-device TTS engine actually installed on this box?
 *
 * The same fact the Voice tab's local engine is judged by — `buildTtsInventory()`
 * stats Kokoro's own artefacts — so the chat's promise of a player and the
 * panel's verdict cannot disagree about one box. Imported lazily: `local-models`
 * reaches systemd and the filesystem, and this module is pulled in by the chat
 * turn, which has no other reason to load it.
 *
 * Fails CLOSED, like every other fact behind a capability.
 */
async function localTtsEngineInstalled(): Promise<boolean> {
  try {
    const { buildTtsInventory } = await import("@/lib/local-models");
    return (await buildTtsInventory()).some((m) => m.kind === "tts" && m.installed);
  } catch {
    return false;
  }
}

/**
 * Is the command the provider names actually on disk?
 *
 * `localCommandPath`-shaped: the provider's command is a full command line, so
 * the executable is its first word. Fails CLOSED like its neighbours.
 */
async function commandFileExists(command: string): Promise<boolean> {
  try {
    const bin = command.trim().split(/\s+/)[0];
    if (!bin) return false;
    const { promises: fs } = await import("fs");
    await fs.access(bin);
    return true;
  } catch {
    return false;
  }
}
