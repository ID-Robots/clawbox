/**
 * WHICH engine answers the box's own AI features — Prime Radiant's writer and
 * nightly passes, and picture descriptions — and whether Memory Shard's index
 * may embed in the cloud (TASK-2501 PR-C: those features on the local engine).
 *
 * The rule, read per call so a link, a sign-out or the lock takes effect at
 * once:
 *
 *  1. The local-only AI lock is on → the box's own engine (none when there is
 *     none: the lock never falls back to the cloud).
 *  2. The box holds a ClawBox AI credential → ClawBox AI, as on every box
 *     today. Nothing changes for a signed-in box.
 *  3. Otherwise the box's own engine — Local AI (llama.cpp, Ollama) or the
 *     owner's External engine — when one is set up. This is the box that runs
 *     its local engine only: a Workstation, or a box whose subscription is
 *     linked for its plan alone and holds no ClawBox AI credential.
 *  4. Otherwise none, and the feature says what to set up.
 *
 * SERVER ONLY.
 */

import { getKnown } from "@/lib/config-store";
import { AI_CLOUD_LOCK_KEY } from "@/lib/ai-cloud-lock-shared";
import type { LocalEngine } from "@/lib/local-engine";

/**
 * The device-store key of TASK-2501's local-only AI lock: `true`, or
 * `"pinned"`, is on — the key and rule of `isCloudAiLocked()` in
 * `ai-cloud-lock.ts`. Read here by its stored value so a reader that rejects
 * reads as locked (see below), where that contract falls back to a plain read.
 */
export const CLOUD_AI_LOCK_KEY = AI_CLOUD_LOCK_KEY;

/**
 * Is the local-only AI lock on? FAILING CLOSED: an absent store (no
 * data/config.json yet) is known and empty, so unlocked — the state every box
 * ships in; a store that is there and cannot be read (EACCES, a torn or corrupt
 * file) is not known to be unlocked, so it reads as LOCKED until it reads
 * again — on OpenClaw the ClawBox AI credential lives in openclaw.json, which
 * an unreadable data/config.json does not take away. `getKnown` reports every
 * read failure itself; a reader that rejects instead is no answer either, and
 * reads as locked too — never a forgiving read that could answer "off".
 */
export async function cloudAiLockOn(): Promise<boolean> {
  let read: { value: unknown; known: boolean };
  try {
    read = await getKnown(CLOUD_AI_LOCK_KEY);
  } catch {
    return true;
  }
  if (!read.known) return true;
  return read.value === true || read.value === "pinned";
}

export type FeatureEngine =
  | { kind: "clawbox-ai" }
  | { kind: "local"; engine: LocalEngine }
  /** `cloud_ai_locked`: the lock is on and the box has no engine of its own; `no_credential`: neither engine. */
  | { kind: "none"; reason: "cloud_ai_locked" | "no_credential" };

/** The engine the box's AI features answer from right now: see the module docblock. Never throws. */
export async function resolveFeatureEngine(): Promise<FeatureEngine> {
  const locked = await cloudAiLockOn();
  try {
    // Lazily: the credential reader pulls the OpenClaw config and the local
    // engine the llama.cpp launcher, and Memory Shard's embedder imports this
    // module for the lock alone.
    if (!locked) {
      const { resolveClawaiToken } = await import("@/lib/harness/credentials");
      if ((await resolveClawaiToken().catch(() => null)) !== null) return { kind: "clawbox-ai" };
    }
    const { resolveLocalEngine } = await import("@/lib/local-engine");
    const engine = await resolveLocalEngine().catch(() => null);
    if (engine) return { kind: "local", engine };
  } catch {
    // What cannot be read is no engine: the feature says what to set up.
  }
  return { kind: "none", reason: locked ? "cloud_ai_locked" : "no_credential" };
}
