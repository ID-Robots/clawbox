/**
 * The seam between a change to the vault and Memory Shard's index of it.
 *
 * After the vault's main branch moves (a nightly merge, a verification, a
 * revert) the pages that changed are handed to whatever hook is installed —
 * Memory Shard's incremental `reindexPrimeRadiantPaths` once the Shard side
 * registers it at boot (`setVaultReindexHook`). With no hook installed this is
 * a no-op: the vault is the source of truth and a full Shard pass reads it
 * anyway. A hook that fails or throws is logged and never fails the change
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
  const hook = store.hook;
  if (!hook || pages.length === 0) return false;
  try {
    await hook(pages);
    return true;
  } catch (err) {
    console.warn("[prime-radiant] reindex hook failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
