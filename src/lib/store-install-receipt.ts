/**
 * The Store's receipt inside a ClawBox app it installed:
 * `<project>/.clawbox/store-app.json` (src/lib/store-install.ts writes it).
 *
 * Kept apart from the installer so the uninstall route can ask "did the Store
 * put a folder here?" without loading the installer's graph. The receipt is
 * the ONLY thing that makes a folder the Store's: a project the owner named
 * the same way is never removed by an uninstall.
 */
import fs from "fs";
import path from "./runtime-path";
import { CLAWBOX_APP_SOURCE } from "./store-categories";
import { safeAppId } from "./webapp-icon";

export const STORE_MARKER = path.join(".clawbox", "store-app.json");

export interface StoreMarker {
  source: typeof CLAWBOX_APP_SOURCE;
  slug: string;
  version: string;
  sha256: string;
  installedAt: string;
}

export async function readStoreMarker(directory: string): Promise<StoreMarker | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(directory, STORE_MARKER), "utf-8")) as Partial<StoreMarker>;
    if (raw.source !== CLAWBOX_APP_SOURCE || typeof raw.slug !== "string" || typeof raw.version !== "string") return null;
    return raw as StoreMarker;
  } catch {
    return null;
  }
}

/** The owner's project folder (chosen, else the ~/Projects default); null when the config cannot be read. Loaded on demand — see the module comment. */
async function projectsRoot(): Promise<string | null> {
  try {
    const { getDefaultDirectory } = await import("./coding-agent");
    return await getDefaultDirectory();
  } catch {
    return null;
  }
}

/**
 * The project folder a Store install made for `appId`, when there is one:
 * only a folder carrying the Store's receipt for exactly this id counts.
 */
export async function storeInstalledFolder(appId: string): Promise<string | null> {
  const id = safeAppId(appId);
  const base = id ? await projectsRoot() : null;
  if (!id || !base) return null;
  const root = path.resolve(base);
  const directory = path.resolve(root, id);
  if (path.dirname(directory) !== root) return null;
  const stat = await fs.promises.lstat(directory).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const marker = await readStoreMarker(directory);
  return marker?.slug === id ? directory : null;
}

/** Remove the project folder a Store install made. False when there is none; throws when it is there and will not go. */
export async function removeStoreInstalledFolder(appId: string): Promise<boolean> {
  const directory = await storeInstalledFolder(appId);
  if (!directory) return false;
  await fs.promises.rm(directory, { recursive: true, force: true });
  return true;
}
