import type { DroppedFile, DroppedItem } from "./chat-attachments";

// ── What a drag-and-drop from the owner's computer holds ─────────────────────
//
// `dataTransfer.files` lists what was dropped at the top level and nothing
// under it: a FOLDER arrives there as one zero-byte "file" that cannot be read.
// The folder's tree is only reachable through the entries API —
// `DataTransferItem.webkitGetAsEntry()`, a directory reader per folder — which
// every browser the box is used from has (Chromium, Firefox, Safari).
//
// Two traps it has, both handled here:
//   - the items are only readable DURING the drop event. Everything is taken
//     off them synchronously, before the first await, or the second folder of
//     a drop comes back empty;
//   - `readEntries` answers in batches (100 at a time in Chromium) and must be
//     called until it answers an empty one, or a folder of 150 files is 100.

/** Minimal shapes of the entries API; the DOM lib's names vary by TS version. */
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FsFileEntry extends FsEntry {
  file(ok: (file: File) => void, fail?: (err: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader(): { readEntries(ok: (entries: FsEntry[]) => void, fail?: (err: unknown) => void): void };
}

/**
 * Folders a drop passes over, the way a ZIP of a project folder does — the
 * dependency and cache trees the project regenerates — plus `.git`, whose
 * history is thousands of objects the agent reads nothing from.
 */
export const DROP_SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "__pycache__", ".venv", ".cache", ".npm", ".git"]);

/** OS litter that is never the point of a drop. */
const DROP_SKIPPED_FILES: ReadonlySet<string> = new Set(["Thumbs.db", "desktop.ini"]);

/**
 * Whether an entry inside a dropped folder is left out: hidden ones (the
 * staging route would strip the dot and so change the structure anyway, and
 * a `.env` is exactly what should not leave the owner's computer by accident),
 * the skipped folders above, and OS litter.
 */
export function isSkippedDropEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".")) return true;
  return isDirectory ? DROP_SKIPPED_DIRS.has(name) : DROP_SKIPPED_FILES.has(name);
}

/** Whether a drag carries files from the owner's computer (not text, not a drag from inside the page). */
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes("Files");
}

function fileOf(entry: FsFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file(resolve, () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function readAllEntries(dir: FsDirectoryEntry, cap: number): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const all: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve) => {
      try {
        reader.readEntries(resolve, () => resolve([]));
      } catch {
        resolve([]);
      }
    });
    if (batch.length === 0 || all.length >= cap) return all;
    all.push(...batch);
  }
}

async function readFolder(root: FsDirectoryEntry, opts: { maxFiles: number; maxDepth: number }): Promise<DroppedItem> {
  const files: DroppedFile[] = [];
  let skipped = 0;
  let truncated = false;
  const walk = async (dir: FsDirectoryEntry, prefix: string, depth: number): Promise<void> => {
    if (depth > opts.maxDepth) {
      truncated = true;
      return;
    }
    const children = await readAllEntries(dir, opts.maxFiles * 4);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (truncated) return;
      if (isSkippedDropEntry(child.name, child.isDirectory)) {
        skipped += 1;
        continue;
      }
      const rel = `${prefix}/${child.name}`;
      if (child.isDirectory) {
        await walk(child as FsDirectoryEntry, rel, depth + 1);
      } else if (child.isFile) {
        // One past the limit is enough to know the drop is over it; the rest
        // of the tree is not read.
        if (files.length >= opts.maxFiles) {
          truncated = true;
          return;
        }
        const file = await fileOf(child as FsFileEntry);
        if (file) files.push({ file, relativePath: rel });
        else skipped += 1;
      }
    }
  };
  await walk(root, root.name, 1);
  return { kind: "folder", name: root.name, files, skipped, truncated };
}

/**
 * Everything a drop held, folders read as their trees. A browser without the
 * entries API gets the flat `files` list, which is what it could ever offer.
 */
export async function readDroppedItems(
  dt: DataTransfer | null | undefined,
  opts: { maxFiles: number; maxDepth: number },
): Promise<DroppedItem[]> {
  if (!dt) return [];
  // ── Synchronously, while the drop event still owns the items ──
  const out: DroppedItem[] = [];
  const folders: FsDirectoryEntry[] = [];
  const items = dt.items;
  const hasEntries = !!items && items.length > 0
    && typeof (items[0] as DataTransferItem & { webkitGetAsEntry?: unknown }).webkitGetAsEntry === "function";
  if (hasEntries) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = (item as unknown as { webkitGetAsEntry(): FsEntry | null }).webkitGetAsEntry();
      if (entry?.isDirectory) {
        folders.push(entry as FsDirectoryEntry);
        continue;
      }
      const file = item.getAsFile();
      if (file) out.push({ kind: "file", file });
    }
  } else {
    for (const file of Array.from(dt.files ?? [])) out.push({ kind: "file", file });
  }
  // ── Then the trees, at leisure ──
  for (const folder of folders) out.push(await readFolder(folder, opts));
  return out;
}
