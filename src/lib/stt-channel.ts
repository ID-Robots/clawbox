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
import { CLAWBOX_AI_PROXY_URL } from "@/lib/harness/credentials";
import { readConfig, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";
import { buildAudioModels, type SttEngine } from "@/lib/stt-preference";

/**
 * Make openclaw.json's audio chain say what the preference says. Answers
 * whether anything was written, so the caller knows whether a restart is owed.
 *
 * Skipped entirely when the file already holds this exact endpoint and list:
 * the write costs a CLI cold start and the restart drops every open channel
 * connection, and re-selecting the engine already in force must cost neither.
 * One batch, not two calls, so the endpoint and the list can never land
 * without each other.
 */
export async function syncChannelAudio(
  order: readonly SttEngine[],
  localInstalled: boolean,
): Promise<boolean> {
  const models = buildAudioModels(order, localInstalled);
  // OpenClaw 2: the endpoint stays under tools.media.audio, but the model
  // list lives in the SHARED tools.media.models — one list for every media
  // capability, so rows that are not ours to order (no capabilities, or
  // capabilities without "audio": vision, video, an owner's own entries)
  // must ride along untouched. Only the audio subset is this module's.
  const media = (await readConfig()).tools?.media;
  const existing = Array.isArray(media?.models) ? media.models : [];
  const isAudioRow = (row: unknown): boolean => {
    if (!row || typeof row !== "object") return false;
    const caps = (row as { capabilities?: unknown }).capabilities;
    return Array.isArray(caps) && caps.includes("audio");
  };
  const foreign = existing.filter((row) => !isAudioRow(row));
  const merged = [...foreign, ...models];
  if (media?.audio?.baseUrl === CLAWBOX_AI_PROXY_URL && isDeepStrictEqual(existing.filter(isAudioRow), models)) return false;
  await runOpenclawConfigSetBatch([
    ["tools.media.audio.baseUrl", JSON.stringify(CLAWBOX_AI_PROXY_URL), "--json"],
    ["tools.media.models", JSON.stringify(merged), "--json"],
  ]);
  return true;
}
