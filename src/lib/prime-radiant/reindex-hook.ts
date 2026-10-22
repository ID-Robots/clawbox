/**
 * The seam between a change to the vault and Memory Shard's index of it.
 *
 * After the vault's main branch moves (a nightly merge, a verification, a
 * revert) the pages that changed are handed to whatever hook is installed —
 * Memory Shard's incremental `reindexPrimeRadiantPaths` by default, or an
 * override installed with `setVaultReindexHook` (tests). A hook that fails or throws is logged and never fails the change
 * that called it.
 *
 * The Prime Radiant core block follows `main` from here too (core-context-file.ts),
 * BESIDE the hook and never in its one slot: a refresh is started after the
 * hook, without being waited for, and only when there is a block to keep or
 * to take away — never on a box whose owner has not turned the `context`
 * setting on. Every commit on `main` follows it as well (vault.ts calls
 * `followCoreContextAfterCommit`): the owner's and the assistant's own edits
 * never come through `notifyVaultChanged`, and a page set to confidential or
 * deleted must leave the block without waiting for the night.
 *
 * The hook lives in `processStore`: the boot layer that installs it and the
 * route that calls it are separate module copies (see process-store.ts).
 *
 * SERVER ONLY.
 */

import fs from "fs";
import { processStore } from "@/lib/process-store";
import { coreContextPath, isKnowledgePage } from "./paths";
import { readSettings } from "./settings";

export type VaultReindexHook = (paths: string[]) => Promise<unknown> | unknown;

const store = processStore("prime-radiant:reindex-hook", () => ({ hook: null as VaultReindexHook | null }));

export function setVaultReindexHook(hook: VaultReindexHook | null): void {
  store.hook = hook;
}

/** Hand the changed knowledge pages to the hook. Answers whether a hook ran. */
export async function notifyVaultChanged(paths: readonly string[]): Promise<boolean> {
  const pages = [...new Set(paths.filter(isKnowledgePage))].sort();
  if (pages.length === 0) return false;
  const hook = store.hook ?? defaultHook;
  let ran = false;
  try {
    await hook(pages);
    ran = true;
  } catch (err) {
    console.warn("[prime-radiant] reindex hook failed:", err instanceof Error ? err.message : err);
  }
  followCoreContext();
  return ran;
}

/**
 * Commits on `main` come in bursts — an ingest commits each answered batch — so
 * a commit is followed once its burst settles: FOLLOW_DEBOUNCE_MS after the last
 * one, and never later than FOLLOW_MAX_WAIT_MS after the first, so a long ingest
 * costs one rebuild every half minute at most while an edit shows within seconds.
 */
const FOLLOW_DEBOUNCE_MS = 2_000;
const FOLLOW_MAX_WAIT_MS = 30_000;
const follow = processStore("prime-radiant:core-follow", () => ({ timer: null as NodeJS.Timeout | null, first: 0 }));

/** A commit landed on the vault's `main`: the core block follows it, once the burst it belongs to settles. Never throws. */
export function followCoreContextAfterCommit(): void {
  const now = Date.now();
  if (follow.timer) clearTimeout(follow.timer);
  else follow.first = now;
  const wait = Math.max(0, Math.min(FOLLOW_DEBOUNCE_MS, follow.first + FOLLOW_MAX_WAIT_MS - now));
  follow.timer = setTimeout(() => {
    follow.timer = null;
    followCoreContext();
  }, wait);
  follow.timer.unref?.();
}

/** Start a refresh of the core block when the setting is on, or a block is still on disk to take away. */
function followCoreContext(): void {
  let wanted = false;
  try {
    wanted = readSettings().context.enabled || fs.existsSync(coreContextPath());
  } catch {
    /* nothing to follow */
  }
  if (!wanted) return;
  void import("./core-context-file")
    .then((m) => m.scheduleCoreContextRefresh())
    .catch((err) => console.warn("[prime-radiant] the core block was not refreshed:", err instanceof Error ? err.message : err));
}

async function defaultHook(paths: string[]): Promise<unknown> {
  const { reindexPrimeRadiantPaths } = await import("./shard-index");
  return reindexPrimeRadiantPaths(paths);
}
