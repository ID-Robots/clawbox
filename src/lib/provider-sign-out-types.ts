import type { Harness } from "@/lib/harness";

/**
 * One harness's half of a provider sign-out (src/lib/provider-sign-out.ts):
 * prepared from what the harness holds BEFORE anything is touched, then run
 * in the orchestrator's order — remove, apply, clear the backups, read back.
 */
export interface HarnessSignOut {
  harness: Harness;
  /** Whether the harness held anything of the credential before the sign-out. */
  held: boolean;
  /** Take the credential out of every place the harness keeps it. Never throws. */
  remove(): Promise<void>;
  /**
   * Bring the RUNNING harness onto it: hot-applied and confirmed, else
   * restarted. A no-op for a harness that held nothing or does not answer the
   * chat (the inactive half of a dual box).
   */
  apply(): Promise<{ restarting: boolean; refused: boolean }>;
  /** Take the removed values out of the config's rotating copies. Never throws. */
  scrubCopies(): Promise<void>;
  /**
   * What is still there, and what could not be read to say it is gone — each
   * named for the sentence the refusal says it in.
   */
  readBack(): Promise<{ left: string[]; unread: string[] }>;
}
