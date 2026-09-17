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
import { resolveClawaiToken } from "@/lib/harness/credentials";
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

export function isSttEngine(value: unknown): value is SttEngine {
  return value === "cloud" || value === "local";
}

/**
 * Which engine is tried first, from what the store holds and whether this box
 * has a ClawBox AI credential at all. PURE, so the route that already knows the
 * second fact does not pay to learn it twice.
 *
 * The cloud is the default for a box that HAS a subscription — it is what every
 * such box shipped with, and the proxy's transcription route has no tier gate,
 * so any connected box may use it. It is not a default a box can be left
 * sitting on without one: `resolveClawaiCloudDefaults` says the target for an
 * unlinked box is the engine on the box, reason `not_linked`, and a stored (or
 * defaulted) `cloud` there made `/setup-api/stt` report "ClawBox cloud" as the
 * engine that hears this box beside `engines.cloud.configured: false`. The
 * recording was still transcribed — the chain drops an engine that cannot run —
 * but the box's account of itself contradicted the card's.
 *
 * So the credential is checked on the READ rather than on each of the writes:
 * every path that stores `cloud` (the applier's promotion, "Use as fallback",
 * the whisper removal's release) is handing the capability back to the
 * automatic default, and that default is the cloud only while the box is
 * linked. Checked here, an unlink cannot leave a stale `cloud` behind, and
 * connecting a subscription gives it back with no second write.
 *
 * An owner's `local` pick is unaffected in either direction.
 */
export function resolveSttPrimary(stored: unknown, cloudConfigured: boolean): SttEngine {
  if (!cloudConfigured) return "local";
  return isSttEngine(stored) ? stored : "cloud";
}

/** What the store holds, before {@link resolveSttPrimary} has its say. */
export async function readStoredSttPrimary(): Promise<unknown> {
  return await get(STT_PRIMARY_KEY);
}

/** The engine tried first. */
export async function getSttPrimary(): Promise<SttEngine> {
  const [stored, token] = await Promise.all([readStoredSttPrimary(), resolveClawaiToken()]);
  return resolveSttPrimary(stored, token !== null);
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
      entries.push({ provider: "openai", model: TRANSCRIBE_MODEL, capabilities: ["audio"] });
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
