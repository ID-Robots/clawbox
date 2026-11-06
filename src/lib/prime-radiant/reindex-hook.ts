/**
 * The seam between a change to the vault and Memory Shard's index of it.
 *
 * After the vault's main branch moves (a nightly merge, a verification, a
 * revert) the pages that changed are handed to whatever hook is installed —
 * Memory Shard's incremental `reindexPrimeRadiantPaths` by default, or an
 * override installed with `setVaultReindexHook` (tests). A hook that fails or throws is logged and never fails the change
 * that called it.
 *
 * The hook lives in `processStore`: the boot layer that installs it and the
 * route that calls it are separate module copies (see process-store.ts).
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { isKnowledgePage } from "./paths";

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
  try {
    await hook(pages);
    return true;
  } catch (err) {
    console.warn("[prime-radiant] reindex hook failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function defaultHook(paths: string[]): Promise<unknown> {
  const { reindexPrimeRadiantPaths } = await import("./shard-index");
  return reindexPrimeRadiantPaths(paths);
}
