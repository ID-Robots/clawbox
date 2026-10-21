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
 * setting on.
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
