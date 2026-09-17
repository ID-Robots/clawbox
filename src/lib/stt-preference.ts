/**
 * Which speech-to-text engine goes first, and what that means for each of the
 * two places a recording can arrive.
 *
 * Two surfaces transcribe on a ClawBox and they must agree:
 *   - the chat microphone posts to /setup-api/chat/transcribe, which walks
 *     `sttEngineOrder` itself;
 *   - a channel voice note (Telegram and friends) goes through OpenClaw's
 *     media-understanding, which tries `tools.media.audio.models[]` in order
 *     until one answers — so the same preference is expressed there as the
 *     order of that array, built by `buildAudioModels`.
 *
 * The preference lives in ClawBox's own config store rather than being read
 * back out of openclaw.json, because the Hermes edition has no openclaw.json
 * and its chat microphone still has a preference to honour.
 */

import { get, set } from "@/lib/config-store";
import { PYTHON3, sttClientScriptPath } from "@/lib/stt-local";

export type SttEngine = "cloud" | "local";

/** The config-store key. */
export const STT_PRIMARY_KEY = "stt_primary";

/**
 * The cloud transcription model.
 *
 * `gpt-4o-mini-transcribe` at $0.003/minute is the cheapest of OpenAI's eight
 * transcription options -- half of Whisper's $0.006, and a sixth of
 * `gpt-live-transcribe`. At roughly an hour of dictation per user per month
 * that is about $0.18. Overridable so a staging box can be pointed elsewhere
 * without a code change.
 *
 * scripts/gateway-pre-start.sh carries a copy of the default because a shell
 * migration cannot import this constant; keep the two in step.
 */
export const TRANSCRIBE_MODEL =
  process.env.CLAWBOX_AI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";

/**
 * The auth profile the cloud transcription row names as its own bearer.
 *
 * `tools.media.models[].profile` — the core's per-row credential binding
 * (`MediaUnderstandingModelSchema`), resolved as a LOCKED profile id, so the row
 * carries its credential instead of inheriting the provider's.
 *
 * It has to, now. This row's provider is `openai` — the only bundled
 * media-understanding provider that speaks the proxy's transcription API — and
 * its bearer used to be the ClawBox AI token ClawBox wrote onto
 * `models.providers.openai.apiKey` for the image model. That key is gone (see
 * `CLAWBOX_AI_IMAGE_PROVIDER` in clawbox-ai-models.ts: on the pinned core its
 * mere presence takes a ChatGPT sign-in off its own provider), so without a
 * profile here the core resolves the openai provider's ordinary credentials —
 * the owner's ChatGPT OAuth, or nothing — and every channel voice note is
 * refused before it is uploaded.
 *
 * `deepseek:default` is not a borrowed credential: it is the auth profile
 * ClawBox itself writes for the ClawBox AI subscription
 * (`CLAWBOX_AI_PROFILE_KEY` in the ai-models configure route), the same token,
 * already in the core's own credential store. Naming it here keeps the
 * transcription route on the proxy that serves it without putting that token on
 * any provider's auth. The profile's own provider id is not a constraint: an
 * explicit `profile` is a locked selection, resolved by id
 * (`resolveApiKeyForProfile`), which is exactly why the field exists.
 *
 * scripts/gateway-pre-start.sh carries a copy of this string for the same
 * reason it copies the model id; keep the two in step.
 */
export const TRANSCRIBE_AUTH_PROFILE = "deepseek:default";

export function isSttEngine(value: unknown): value is SttEngine {
  return value === "cloud" || value === "local";
}

/** The engine tried first. Cloud by default: it is what every box shipped with. */
export async function getSttPrimary(): Promise<SttEngine> {
  const stored = await get(STT_PRIMARY_KEY);
  return isSttEngine(stored) ? stored : "cloud";
}

export async function setSttPrimary(primary: SttEngine): Promise<void> {
  await set(STT_PRIMARY_KEY, primary);
}

/** The primary, then the other one as its fallback. */
export function sttEngineOrder(primary: SttEngine): SttEngine[] {
  return primary === "cloud" ? ["cloud", "local"] : ["local", "cloud"];
}

/** One `tools.media.models[]` entry, in either of the shapes OpenClaw accepts. */
export type AudioModelEntry = Record<string, unknown>;

/**
 * The `tools.media.models[]` array for an engine order (OpenClaw 2's one
 * shared media-model list; audio rows are tagged capabilities: ["audio"]).
 *
 * The cloud entry is the provider row gateway-pre-start.sh has always seeded.
 * The local entry is a CLI row running the same stt-client.py the chat
 * microphone uses (see stt-local.ts); `{{MediaPath}}` is OpenClaw's
 * placeholder for the voice note on disk. It is left out when the engine is
 * not installed: OpenClaw would otherwise try the row and record a failed
 * attempt for every voice note before reaching the cloud row behind it — and
 * on a box with no usable cloud leg, that is the transcript lost.
 */
export function buildAudioModels(order: readonly SttEngine[], localInstalled: boolean): AudioModelEntry[] {
  const entries: AudioModelEntry[] = [];
  for (const engine of order) {
    if (engine === "cloud") {
      // capabilities says where the row may be used; OpenClaw 2's shared
      // tools.media.models list requires it on every row.
      entries.push({
        provider: "openai",
        model: TRANSCRIBE_MODEL,
        // The row's own bearer — see TRANSCRIBE_AUTH_PROFILE. Without it this
        // row has no credential at all now that nothing writes
        // `models.providers.openai.apiKey`.
        profile: TRANSCRIBE_AUTH_PROFILE,
        capabilities: ["audio"],
      });
    } else if (localInstalled) {
      entries.push({
        type: "cli",
        command: PYTHON3,
        args: [sttClientScriptPath(), "{{MediaPath}}"],
        timeoutSeconds: 120,
        capabilities: ["audio"],
      });
    }
  }
  return entries;
}
