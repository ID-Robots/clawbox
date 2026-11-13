/**
 * OpenClaw's compaction on the cloud model while the primary is on the box
 * (TASK-2127).
 *
 * WHY. OpenClaw compacts a conversation with the session's ACTIVE model unless
 * told otherwise. A long chat switched to Local AI therefore had its ~100k
 * tokens summarized by Gemma 4 E2B, the ~2B model llama.cpp serves on the box:
 * 121 s for the summary, then retries of 14–40 s each, before the owner's
 * one-line question was even read (gateway log: `context overflow detected
 * (attempt 1/3); attempting auto-compaction for llamacpp/…`).
 *
 * WHY THIS SHAPE. The core has its own key for exactly this:
 * `agents.defaults.compaction.model` (OpenClaw 2026.10, docs/concepts/
 * compaction.md — "Set agents.defaults.compaction.model to select a different
 * summarization model"). It covers automatic, overflow-recovery and manual
 * compaction (`sessions.compact`, `/compact`) alike, and leaves the reply
 * itself on the local model. The override is EXACT — it does not inherit the
 * session's fallback chain — so it is written only when there is a cloud model
 * to name: the primary the owner just left (the model the long conversation
 * was had with), else the first cloud model in the fallback chain. With
 * neither, nothing is written and the chat's offer of a new chat is the answer.
 *
 * OWNERSHIP. The value is a plain model reference, with no room for a marker,
 * so ClawBox records what it wrote in the device store
 * (`local_compaction_model`) and takes the key back out only while it still
 * holds exactly that value. An owner's own compaction model — set before, or
 * changed after — is never touched, and is never replaced either: an existing
 * value means "already chosen".
 *
 * Three routes write `agents.defaults.model.primary` from the UI. chat/model
 * and ai-models/configure arm in the batch that moves the primary onto the box
 * and disarm after a write that moves it off, the same places
 * src/lib/local-tool-search.ts hooks into. local-ai/exclusive (Local-only)
 * never arms and takes ClawBox's value out: the owner's "nothing goes to the
 * cloud" outranks a faster summary, and its long chats get the new-chat offer.
 */

import { isCloudAiLocked } from "@/lib/ai-cloud-lock";
import { get, set } from "@/lib/config-store";
import { installedOpenclawCoreAtLeast } from "@/lib/openclaw-core-generation";
import { runOpenclawConfigUnset, type OpenClawConfig, type OpenclawConfigSetArgs } from "@/lib/openclaw-config";

export const COMPACTION_MODEL_PATH = "agents.defaults.compaction.model";

/** Device-store key holding the compaction model ClawBox wrote, and nothing else. */
export const LOCAL_COMPACTION_MODEL_KEY = "local_compaction_model";

/** A model served on the box itself: llama.cpp or Ollama. */
export function isOnDeviceModel(ref: string | null | undefined): boolean {
  if (typeof ref !== "string") return false;
  const trimmed = ref.trim();
  return trimmed.startsWith("llamacpp/") || trimmed.startsWith("ollama/");
}

/** A `provider/model` reference that is not on the box. */
function isCloudModelRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[^/\s]+\/\S+$/.test(ref.trim()) && !isOnDeviceModel(ref);
}

function compactionModelOf(config: OpenClawConfig | null): unknown {
  const compaction: unknown = config?.agents?.defaults?.compaction;
  return compaction && typeof compaction === "object" ? (compaction as { model?: unknown }).model : undefined;
}

/**
 * The cloud model a summary should run on: the primary being left when it is
 * a cloud model, else the first cloud model in the fallback chain, else null.
 */
export function cloudCompactionModel(config: OpenClawConfig | null, previousPrimary?: string | null): string | null {
  if (isCloudModelRef(previousPrimary)) return previousPrimary.trim();
  const fallbacks = config?.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(fallbacks)) {
    const cloud = fallbacks.find(isCloudModelRef);
    if (cloud) return cloud.trim();
  }
  return null;
}

/**
 * The batch entry that points compaction at the cloud model for a primary on
 * the box — in the SAME batch as the primary, so a refused batch leaves both
 * as they were — or nothing: a cloud primary, an unreadable config (`null`:
 * absence cannot be proven), a compaction model already set (the owner's or
 * ours), no cloud model to name, or a core older than 2026.10, whose strict
 * schema could refuse the key and the switch with it.
 */
export async function localCompactionModelArmOps(
  config: OpenClawConfig | null,
  primary: string | null | undefined,
  previousPrimary?: string | null,
): Promise<OpenclawConfigSetArgs[]> {
  if (!isOnDeviceModel(primary) || config === null) return [];
  if (compactionModelOf(config) !== undefined) return [];
  const cloud = cloudCompactionModel(config, previousPrimary);
  if (!cloud) return [];
  // The local-only AI lock (TASK-2501): the conversation is not summarized by
  // a cloud model either, so nothing is armed — the long chat gets the
  // new-chat offer, as under Local-only mode.
  if (await isCloudAiLocked()) return [];
  if (!(await installedOpenclawCoreAtLeast(2026, 10))) return [];
  return [[COMPACTION_MODEL_PATH, cloud]];
}

/**
 * Remember what an arm batch wrote, once it has landed — the ownership record
 * the disarm reads. A batch without the key records nothing. Best effort: an
 * unrecorded value is merely one ClawBox will not take back.
 */
export async function noteLocalCompactionModel(ops: readonly OpenclawConfigSetArgs[]): Promise<void> {
  const op = ops.find((entry) => entry[0] === COMPACTION_MODEL_PATH);
  if (!op || typeof op[1] !== "string") return;
  try {
    await set(LOCAL_COMPACTION_MODEL_KEY, op[1]);
  } catch (err) {
    console.warn("[local-compaction-model] could not record the compaction model written:", err);
  }
}

/** Is the compaction model in `config` the one ClawBox wrote, exactly? */
export async function isClawboxCompactionModel(config: OpenClawConfig | null): Promise<boolean> {
  const current = compactionModelOf(config);
  if (typeof current !== "string") return false;
  const recorded = await get(LOCAL_COMPACTION_MODEL_KEY).catch(() => undefined);
  return typeof recorded === "string" && recorded === current;
}

/**
 * Whether a write that leaves the primary at `primary` must take ClawBox's
 * compaction model back out: a primary off the box compacts with itself again.
 * (Local-only mode takes it out too, for its own reason — nothing of that
 * box's conversations may go to a cloud model — see local-ai/exclusive.)
 * So does the local-only AI lock (TASK-2501), for the same reason: a write
 * made under it takes ClawBox's cloud compaction model out whatever the
 * primary. An owner's own compaction model is still never touched.
 */
export async function localCompactionModelDisarmNeeded(
  config: OpenClawConfig | null,
  primary: string | null | undefined,
): Promise<boolean> {
  if (isOnDeviceModel(primary) && !(await isCloudAiLocked())) return false;
  return isClawboxCompactionModel(config);
}

/**
 * Take ClawBox's compaction model out (`config unset`: a batch has no delete,
 * and the key's absence is OpenClaw's default) and forget the record. Logged,
 * not reported, on failure: what stays behind is a cloud model summarizing a
 * cloud conversation, which changes nothing the owner can see.
 */
export async function disarmLocalCompactionModel(label: string): Promise<void> {
  try {
    await runOpenclawConfigUnset(COMPACTION_MODEL_PATH);
    await set(LOCAL_COMPACTION_MODEL_KEY, undefined);
  } catch (err) {
    console.error(`[${label}] failed to restore OpenClaw's default compaction model:`, err);
  }
}
