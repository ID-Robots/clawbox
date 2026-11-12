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

import { get as configGet } from "@/lib/config-store";
import type { LocalEngine } from "@/lib/local-engine";

/**
 * The device-store key of TASK-2501's local-only AI lock (PR-A): `true`, or
 * `"pinned"`, is on. Read here by its stored value until the lock's own
 * contract (`isCloudAiLocked()` in `ai-cloud-lock.ts`) is on beta; then this
 * reader becomes that call, with the same answer.
 */
export const CLOUD_AI_LOCK_KEY = "ai_cloud_lock";

/** Is the local-only AI lock on? An unreadable store reads as off, like every other device setting. */
export async function cloudAiLockOn(): Promise<boolean> {
  try {
    const value = await configGet(CLOUD_AI_LOCK_KEY);
    return value === true || value === "pinned";
  } catch {
    return false;
  }
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
