/**
 * The CHANNEL half of the transcription preference: `tools.media.models[]` in
 * openclaw.json, which is the order OpenClaw tries when a Telegram (or WhatsApp,
 * or Discord) voice note arrives.
 *
 * SERVER ONLY.
 *
 * Lifted out of `/setup-api/stt` because the cloud-defaults applier has to write
 * the same list: the chat microphone reads `stt_primary` per request, but a
 * channel voice note reads this array, and a box whose preference says cloud
 * while the array still lists the on-device row first is a box that disagrees
 * with itself about where recordings go.
 */

import { isDeepStrictEqual } from "util";
import { tokenFingerprint } from "@/lib/anthropic-gateway-auth";
import { hasChatgptOauthProfile } from "@/lib/chatgpt-subscription";
import { isClawboxAiToken } from "@/lib/clawai-token";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";
import {
  readGatewayAuthProfile,
  readGatewayProviderAuth,
  type GatewayAuthProfileRead,
  type GatewayProviderAuthRead,
} from "@/lib/openclaw-auth-store";
import {
  openclawIsAbsent,
  readConfig,
  readConfigStrict,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { createSerialLock } from "@/lib/serial-lock";
import { forgetLocalSttProbe, localSttInstalled } from "@/lib/stt-local";
import {
  buildAudioModels,
  readStoredSttPrimary,
  resolveSttPrimary,
  sttEngineOrder,
  TRANSCRIBE_AUTH_PROFILE,
  TRANSCRIBE_MODEL,
  transcribeProfileProblem,
  type SttEngine,
} from "@/lib/stt-preference";
import type { AuthProfileEntries } from "@/lib/subscription-surface";

/** Why the ClawBox AI cloud row is left out of channel voice notes. */
export type CloudSttUnavailable =
  /** No ClawBox AI token on this box — never linked, or signed out. */
  | "not_linked"
  /** The profile the row names is not recorded in openclaw.json, or not in the store the gateway resolves. */
  | "profile_missing"
  /** It is there, but recorded or stored as OAuth, stored as a token, or a dead refresh fence. */
  | "profile_not_api_key"
  /** It holds a key that is not this box's ClawBox AI token. */
  | "profile_stale"
  /** The `openai` credential is a ChatGPT sign-in, which the core will not send to the proxy. */
  | "openai_oauth";

export interface CloudSttBacking {
  usable: boolean;
  reason: CloudSttUnavailable | null;
}

/** What {@link decideCloudSttBacking} is a function of. */
export interface CloudSttFacts {
  /** `resolveClawaiToken()`'s answer. */
  token: string | null;
  /** What the gateway's store holds at {@link TRANSCRIBE_AUTH_PROFILE}. */
  bound: GatewayAuthProfileRead;
  /** Every `openai` profile the gateway's store holds. */
  openai: GatewayProviderAuthRead;
  /** openclaw.json's `auth.profiles` — the metadata ClawBox and the core write beside the store. */
  profiles: AuthProfileEntries;
}

const unusable = (reason: CloudSttUnavailable): CloudSttBacking => ({ usable: false, reason });

/** One sentence per reason, for the log line a write leaves behind. */
const UNAVAILABLE_SENTENCE: Record<CloudSttUnavailable, string> = {
  not_linked: "this box holds no ClawBox AI credential",
  profile_missing: `the ${TRANSCRIBE_AUTH_PROFILE} auth profile is not in the gateway's store`,
  profile_not_api_key: `the ${TRANSCRIBE_AUTH_PROFILE} auth profile is not an API key the gateway can send to the ClawBox AI endpoint`,
  profile_stale: `the ${TRANSCRIBE_AUTH_PROFILE} auth profile holds a different key from this box's ClawBox AI credential`,
  openai_oauth: "the openai credential is a ChatGPT sign-in, and OpenClaw refuses a custom endpoint for an OAuth credential",
};

/**
 * Does a ClawBox AI credential actually back the cloud transcription row?
 * PURE, so every arm is pinned by a test without a store on disk.
 *
 * The row is `{provider: "openai", profile: "deepseek:default"}` beside the
 * proxy as `tools.media.audio.baseUrl`, and it only ever worked because that
 * profile is the ClawBox AI token as an API key. Two things take that away
 * without anything rewriting the row, and both were found on a real box whose
 * owner had moved to a ChatGPT sign-in: every Telegram voice note was answered
 * "can't recognise audio", the gateway logged "OpenAI OAuth audio transcription
 * requires the official endpoint without custom request overrides", and the
 * Whisper installed on the same box was never tried.
 *
 *  - The profile is no longer what the row needs: gone from the store, an
 *    OAuth bundle or refresh fence in its place, or a key that is not the
 *    box's token. The core then resolves the `openai` provider's own
 *    credential for the row.
 *  - The `openai` credential is a ChatGPT sign-in. The pinned core (OpenClaw
 *    2026.10.7, docs/nodes/audio.md) transcribes with "the selected API-key or
 *    ChatGPT/Codex OAuth profile" and "Custom endpoints and request overrides
 *    require an API-key profile" — so `openai` + our endpoint + an OAuth
 *    credential is refused before upload. The documented way to keep both is
 *    an API-key profile OF THE OPENAI PROVIDER in the provider's auth order,
 *    which would put the ClawBox AI token into ChatGPT's own failover pool;
 *    that is not done here, and the box's own engine carries channel voice
 *    notes instead.
 *
 * Asked of openclaw.json's record of the profile first — it has to say a key
 * ({@link transcribeProfileProblem}), the rule gateway-pre-start.sh applies to
 * the same field — and then of the store the gateway resolves
 * (openclaw-auth-store.ts). A store that could not be read this time leaves the
 * record as the evidence: a transient read failure must not drop a working row.
 */
export function decideCloudSttBacking(facts: CloudSttFacts): CloudSttBacking {
  const { token, bound, openai, profiles } = facts;
  // A raw DeepSeek key in the same slot is the OWNER's credential, and the
  // proxy is not where it may be sent.
  if (token === null || !isClawboxAiToken(token)) return unusable("not_linked");
  // openclaw.json's record first, whatever the store says: it is the one
  // piece of evidence gateway-pre-start.sh can read too, and the two must
  // refuse the same rows or each boot undoes the other. A stale `mode: "oauth"`
  // row here is the box this card was found on.
  const recorded = transcribeProfileProblem(profiles);
  if (recorded !== null) return unusable(recorded);
  if (bound.kind === "present") {
    if (bound.type !== "api_key" || bound.fenced) return unusable("profile_not_api_key");
    // A key behind a SecretRef has no fingerprint here; only a key that is
    // provably somebody else's counts against the row.
    if (bound.fingerprint !== null && bound.fingerprint !== tokenFingerprint(token)) {
      return unusable("profile_stale");
    }
  } else if (bound.kind === "absent") {
    return unusable("profile_missing");
  }
  const oauthInStore = openai.kind === "present" && openai.profiles.some((profile) => profile.type === "oauth");
  if (oauthInStore || hasChatgptOauthProfile(profiles)) return unusable("openai_oauth");
  return { usable: true, reason: null };
}

/**
 * The ClawBox AI token, from the config this pass already holds first.
 *
 * `resolveClawaiToken` reads openclaw.json again with `readConfig`, which
 * answers `{}` for a file caught half-written by a concurrent `config set` —
 * the moment right after a provider save or a gateway start these passes run
 * in — and its null was taken for "not linked": the cloud row and our endpoint
 * came off a box whose STRICT read, in hand, held the token. The second read
 * is left to a token openclaw.json does not hold (the Hermes store).
 */
async function clawaiTokenFrom(config: OpenClawConfig): Promise<string | null> {
  const held = config.models?.providers?.[CLAWBOX_AI_PROVIDER]?.apiKey;
  if (typeof held === "string" && held.trim()) return held.trim();
  return await resolveClawaiToken();
}

/** {@link decideCloudSttBacking} over what this box holds now. */
export async function readCloudSttBacking(config?: OpenClawConfig): Promise<CloudSttBacking> {
  const cfg = config ?? (await readConfig());
  const token = await clawaiTokenFrom(cfg);
  // No token, no question for the store: both readers below open sqlite.
  if (token === null) return unusable("not_linked");
  return decideCloudSttBacking({
    token,
    bound: readGatewayAuthProfile(TRANSCRIBE_AUTH_PROFILE),
    openai: readGatewayProviderAuth("openai"),
    profiles: cfg.auth?.profiles,
  });
}

/** Is this the endpoint ClawBox writes? One trailing slash means nothing. */
function isOurAudioEndpoint(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trim = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
  return trim(url) === trim(CLAWBOX_AI_PROXY_URL);
}

/** The on-box client, matched by name as gateway-pre-start.sh matches it: HOME is the script's to resolve. */
const STT_CLIENT_SCRIPT = "stt-client.py";

/**
 * Could ClawBox have written this audio row? The cloud row in either shape a
 * box carries (with the profile, or the older one without), or a CLI row
 * running the workspace's `stt-client.py` — the rule `_is_clawbox_audio_model`
 * in gateway-pre-start.sh applies, so the two agree on whose list it is.
 */
function isClawboxAudioRow(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const { capabilities, ...rest } = row as Record<string, unknown>;
  if (capabilities !== undefined && !isDeepStrictEqual(capabilities, ["audio"]) && !isDeepStrictEqual(capabilities, [])) {
    return false;
  }
  if (rest.type === "cli") {
    const named = [rest.command, ...(Array.isArray(rest.args) ? rest.args : [])];
    return named.some((value) => typeof value === "string" && value.endsWith(STT_CLIENT_SCRIPT));
  }
  return isDeepStrictEqual(rest, { provider: "openai", model: TRANSCRIBE_MODEL, profile: TRANSCRIBE_AUTH_PROFILE })
    || isDeepStrictEqual(rest, { provider: "openai", model: TRANSCRIBE_MODEL });
}

export interface SyncChannelAudioOptions {
  /**
   * Stand down on a route ClawBox did not write: an audio row it does not
   * recognise, or an endpoint that is not its proxy. For the passes nobody
   * asked for (boot, a provider save, a Whisper install), which must not
   * overwrite an owner's own transcription setup — a LAN Whisper server, a
   * Deepgram key — the way gateway-pre-start.sh never does either. An owner's
   * engine pick in Settings still writes the list as it always did.
   */
  onlyOurRoute?: boolean;
}

/**
 * One writer of the audio list at a time. The Settings route, a Whisper
 * install, a provider save, the cloud-defaults applier and the boot pass can
 * all land together, and each is a read-modify-write of one shared list.
 */
const withChannelAudio = createSerialLock();

/**
 * Make openclaw.json's audio chain say what the preference says. Answers
 * whether anything was written, so the caller knows whether a restart is owed.
 *
 * Skipped entirely when the file already holds this exact endpoint and list:
 * the write costs a CLI cold start and the restart drops every open channel
 * connection, and re-selecting the engine already in force must cost neither.
 * One batch, not two calls, so the endpoint and the list can never land
 * without each other.
 *
 * The cloud row is written only while {@link readCloudSttBacking} says a
 * ClawBox AI credential backs it. Without one, the row is dropped and our
 * endpoint goes with it: `tools.media.audio.baseUrl` also applies to a
 * provider the core picks by itself when the list holds no audio row, and an
 * `openai` pick over a ChatGPT sign-in is exactly what it refuses. An endpoint
 * that is not ours is the owner's and stays.
 */
export async function syncChannelAudio(
  order: readonly SttEngine[],
  localInstalled: boolean,
  options: SyncChannelAudioOptions = {},
): Promise<boolean> {
  return await withChannelAudio(async () => {
    // STRICT: `readConfig` answers `{}` for a file it could not read — one
    // caught half-written by a concurrent `config set`, which a pass right
    // after a provider save or a gateway start can meet — and a list rebuilt
    // from `{}` drops every row that is not ours to write.
    const config = await readConfigStrict();
    // OpenClaw 2: the endpoint stays under tools.media.audio, but the model
    // list lives in the SHARED tools.media.models — one list for every media
    // capability, so rows that are not ours to order (no capabilities, or
    // capabilities without "audio": vision, video, an owner's own entries)
    // must ride along untouched. Only the audio subset is this module's.
    const media = config.tools?.media;
    const existing = Array.isArray(media?.models) ? media.models : [];
    const isAudioRow = (row: unknown): boolean => {
      if (!row || typeof row !== "object") return false;
      const caps = (row as { capabilities?: unknown }).capabilities;
      return Array.isArray(caps) && caps.includes("audio");
    };
    const baseUrl = media?.audio?.baseUrl;
    if (options.onlyOurRoute) {
      const hasEndpoint = typeof baseUrl === "string" && baseUrl.trim() !== "";
      if (!existing.filter(isAudioRow).every(isClawboxAudioRow) || (hasEndpoint && !isOurAudioEndpoint(baseUrl))) {
        console.warn("[stt-channel] channel voice notes left alone: tools.media names the owner's own transcription route");
        return false;
      }
    }
    const cloud = await readCloudSttBacking(config);
    const models = buildAudioModels(order, localInstalled, cloud.usable);
    const foreign = existing.filter((row) => !isAudioRow(row));
    const merged = [...foreign, ...models];
    const listInForce = isDeepStrictEqual(existing.filter(isAudioRow), models);
    if (cloud.usable) {
      if (baseUrl === CLAWBOX_AI_PROXY_URL && listInForce) return false;
      await runOpenclawConfigSetBatch([
        ["tools.media.audio.baseUrl", JSON.stringify(CLAWBOX_AI_PROXY_URL), "--json"],
        ["tools.media.models", JSON.stringify(merged), "--json"],
      ]);
      return true;
    }
    const endpointIsOurs = isOurAudioEndpoint(baseUrl);
    if (listInForce && !endpointIsOurs) return false;
    console.warn(
      `[stt-channel] channel voice notes go without the ClawBox AI transcription row: ${UNAVAILABLE_SENTENCE[cloud.reason ?? "not_linked"]}`,
    );
    // The list first: once it no longer names the cloud row, nothing reads the
    // endpoint for it, so a removal that fails below leaves nothing refused.
    if (!listInForce) {
      await runOpenclawConfigSetBatch([["tools.media.models", JSON.stringify(merged), "--json"]]);
    }
    // Present by the check above, which `config unset` requires.
    if (endpointIsOurs) await runOpenclawConfigUnset("tools.media.audio.baseUrl");
    return true;
  });
}

export interface ReconcileChannelAudioOptions {
  /** For the log line, so the passes are tellable apart in the journal. */
  trigger: "boot" | "provider" | "whisper-install";
  /**
   * Ask python again whether faster-whisper imports. An install that has just
   * finished would otherwise read the "missing" the panel cached a moment
   * before it started.
   */
  freshProbe?: boolean;
}

/**
 * Put channel voice notes on what this box can transcribe with NOW: the
 * engine on the box once it is installed, the ClawBox AI row only while a
 * credential backs it, in the order the chat microphone uses
 * ({@link resolveSttPrimary}).
 *
 * For the moments nothing else writes the list: a Whisper install that
 * finished (the engine was installed and enabled, and channels still never
 * tried it), a provider save that moved the box onto a ChatGPT sign-in or off
 * ClawBox AI, and every boot — which is also what catches a profile that went
 * away by any path ClawBox did not see. Token-independent, unlike the ClawBox
 * AI cloud defaults, which stand down on a box with no subscription — the very
 * box whose engine is all it has.
 *
 * No gateway restart: `tools` hot-applies on the pinned core (OpenClaw
 * 2026.10.7, docs/gateway/configuration/hot-reload.md), and ClawBox's writes
 * reach a running gateway as a `config.patch`. Answers whether it wrote.
 * Rejects on a failed write; every caller runs detached and catches.
 */
export async function reconcileChannelAudio(options: ReconcileChannelAudioOptions): Promise<boolean> {
  if (openclawIsAbsent()) return false;
  if (options.freshProbe) forgetLocalSttProbe();
  // STRICT, like the write below: a null token from a half-written file read
  // the order as "no cloud", and wrote Whisper ahead of an owner's cloud pick.
  const [stored, config, local] = await Promise.all([
    readStoredSttPrimary(),
    readConfigStrict(),
    localSttInstalled(),
  ]);
  const token = await clawaiTokenFrom(config);
  const order = sttEngineOrder(resolveSttPrimary(stored, token !== null, local.installed));
  const wrote = await syncChannelAudio(order, local.installed, { onlyOurRoute: true });
  if (wrote) {
    console.warn(
      `[stt-channel] channel voice notes re-aligned with the transcription preference (${options.trigger}); the box's own engine is ${local.installed ? "installed" : "not installed"}`,
    );
  }
  return wrote;
}
