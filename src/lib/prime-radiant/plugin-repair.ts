/**
 * Taking memory-wiki's writes back out of the vault.
 *
 * {@link repairPluginWritesOnce} is the ONE-TIME repair of a vault the plugin
 * compiled into before the wiring switched its writers off: its managed
 * blocks ("## Related" on every page, "## Generated" in `index.md`) are taken
 * out of the pages, the files it generated (`<folder>/index.md`, the
 * `reports/` dashboards, `WIKI.md`, `inbox.md`) are deleted when they are
 * still exactly as it made them, its empty `_views/`, `_attachments/` and
 * `reports/` folders go, and `.gitignore` learns its file names. What HEAD
 * held of it is removed in ONE commit of its own ({@link REPAIR_COMMIT_MESSAGE});
 * what only the working tree held needs none. Owner content is never touched:
 * a page the owner edited by hand keeps the edit (only the block goes, and
 * the page is not committed), an `inbox.md` with a note in it stays. Done
 * once per vault (`pass_state`), from the first of `POST init`, an ingest of
 * the vault or the nightly pass.
 *
 * {@link restorePluginOnlyEdits} is what the nightly merge and a revert ask
 * first: a tracked page whose only change is a managed block the plugin
 * wrote since is put back as committed, so the plugin cannot make the vault
 * "dirty" and hold a night.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "@/lib/runtime-path";
import { commitPaths, git, showFileAt, trackedAtHead, withVaultLock } from "./git";
import { isKnowledgePage, vaultDir } from "./paths";
import {
  isPristineInbox,
  isPristinePluginIndex,
  isPristinePluginReport,
  isPristineWikiOverview,
  MANAGED_MARKER_PREFIX,
  PLUGIN_INDEX_DIRS,
  stripManagedBlocks,
  withPluginGitignore,
} from "./plugin-files";
import { stateDbExists, withStateDb } from "./state-db";
import { INDEX_FILE, readVaultSnapshot, vaultInitialised } from "./vault";

/** The `pass_state` key that says the repair has run on this vault. */
export const REPAIR_STATE_KEY = "memory_wiki_repair";
export const REPAIR_COMMIT_MESSAGE = "repair: take memory-wiki's generated blocks and files out of the vault";
/** Folders the plugin makes empty and fills only with what its writers (now off) generate. */
const EMPTY_PLUGIN_DIRS = ["reports", "_views", "_attachments"];

export interface PluginRepairResult {
  /** False when the repair had run before, or there is no vault yet. */
  ran: boolean;
  /** Pages (and `index.md`) a managed block was taken out of. */
  cleaned: string[];
  /** Plugin files, and folders (with a trailing `/`), deleted. */
  removed: string[];
  /** The commit that took what HEAD held of it out, or null when HEAD held none. */
  commit: string | null;
}

/** Whether the one-time repair has run on `vault`. Never creates the database. */
export function pluginRepairDone(vault: string = vaultDir()): boolean {
  if (!stateDbExists(vault)) return false;
  return withStateDb(vault, (db) => !!db.prepare("SELECT 1 AS one FROM pass_state WHERE key = ?").get(REPAIR_STATE_KEY));
}

function recordRepairDone(vault: string, at: string): void {
  withStateDb(vault, (db) => {
    db.prepare(`INSERT INTO pass_state (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`).run(
      REPAIR_STATE_KEY,
      at,
      at,
    );
  });
}

/**
 * Two texts of one file alike but for surrounding whitespace — what
 * `showFileAt` gives back is trimmed (the child runner trims its output).
 */
function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function abs(vault: string, rel: string): string {
  return path.join(vault, ...rel.split("/"));
}

/** A regular file's text, never through a symlink; null when it is not one. */
async function readPlain(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    return st.isFile() ? await handle.readFile("utf8") : null;
  } finally {
    await handle.close();
  }
}

async function writeText(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Tracked files HEAD has a managed block in. */
async function headFilesWithBlocks(vault: string): Promise<Set<string>> {
  const r = await git(vault, ["grep", "-l", "-z", "-F", "-e", MANAGED_MARKER_PREFIX, "HEAD", "--"], { allowFail: true });
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const entry of r.stdout.split("\0")) {
    const rel = entry.startsWith("HEAD:") ? entry.slice(5) : entry;
    if (rel !== "") out.add(rel);
  }
  return out;
}

/** Delete `rel` when it is a folder holding nothing but empty folders. Answers whether it went. */
async function removeIfEmpty(vault: string, rel: string): Promise<boolean> {
  const dir = abs(vault, rel);
  let entries;
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return false;
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !(await removeIfEmpty(vault, `${rel}/${e.name}`))) return false;
  }
  await fs.rmdir(dir).catch(() => undefined);
  return true;
}

/**
 * Run the repair on `vault` unless it has run there before. Never throws for
 * a vault that is not there yet (that has nothing to repair, and is not
 * marked, so the vault it becomes is still repaired once).
 */
export async function repairPluginWritesOnce(vault: string = vaultDir(), now: () => Date = () => new Date()): Promise<PluginRepairResult> {
  const nothing: PluginRepairResult = { ran: false, cleaned: [], removed: [], commit: null };
  if (!(await vaultInitialised(vault)) || pluginRepairDone(vault)) return nothing;
  return withVaultLock(vault, async () => {
    if (pluginRepairDone(vault)) return nothing;
    const result: PluginRepairResult = { ran: true, cleaned: [], removed: [], commit: null };
    const commit: string[] = [];
    const inHead = await headFilesWithBlocks(vault);

    // 1. Managed blocks out of every page and index.md.
    const snapshot = await readVaultSnapshot(vault);
    const candidates = [...snapshot.pages.map((p) => ({ rel: p.path, text: p.text })), { rel: INDEX_FILE, text: await readPlain(abs(vault, INDEX_FILE)) }];
    for (const { rel, text } of candidates) {
      if (text === null) continue;
      const working = stripManagedBlocks(text);
      if (working.blocks > 0) {
        await writeText(abs(vault, rel), working.text);
        result.cleaned.push(rel);
      }
      if (!inHead.has(rel)) continue;
      // HEAD holds a block: committed when the block is the page's only
      // difference from HEAD — never with an edit of the owner's riding along.
      const head = await showFileAt(vault, "HEAD", rel);
      if (head !== null && sameText(stripManagedBlocks(head).text, working.text)) {
        commit.push(rel);
        if (!result.cleaned.includes(rel)) result.cleaned.push(rel);
      }
    }

    // 2. The files the plugin generated, while they are still only its own.
    const generated: Array<{ rel: string; pristine: (text: string) => boolean }> = [
      ...PLUGIN_INDEX_DIRS.map((d) => ({ rel: `${d}/index.md`, pristine: isPristinePluginIndex })),
      { rel: "WIKI.md", pristine: isPristineWikiOverview },
      { rel: "inbox.md", pristine: isPristineInbox },
    ];
    try {
      for (const e of await fs.readdir(abs(vault, "reports"), { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".md")) generated.push({ rel: `reports/${e.name}`, pristine: isPristinePluginReport });
      }
    } catch {
      // no reports folder
    }
    for (const { rel, pristine } of generated) {
      const text = await readPlain(abs(vault, rel));
      if (text === null || !pristine(text)) continue;
      await fs.rm(abs(vault, rel), { force: true });
      result.removed.push(rel);
      if (await trackedAtHead(vault, rel)) commit.push(rel);
    }
    for (const dir of EMPTY_PLUGIN_DIRS) {
      if (await removeIfEmpty(vault, dir)) result.removed.push(`${dir}/`);
    }

    // 3. Their names in .gitignore, so a plugin that re-creates them changes nothing git sees.
    const ignore = withPluginGitignore(await readPlain(abs(vault, ".gitignore")));
    if (ignore !== null) {
      await writeText(abs(vault, ".gitignore"), ignore);
      commit.push(".gitignore");
    }

    if (commit.length > 0) result.commit = await commitPaths(vault, REPAIR_COMMIT_MESSAGE, commit);
    recordRepairDone(vault, now().toISOString());
    return result;
  });
}

/**
 * Put back every tracked page whose only change since HEAD is a managed block
 * the plugin wrote (its working copy, stripped, reads as HEAD stripped).
 * Anything else that changed is left for the caller's own dirty check.
 * Callers hold the vault's lock. Answers the paths put back.
 */
export async function restorePluginOnlyEdits(vault: string): Promise<string[]> {
  const diff = await git(vault, ["diff", "--name-only", "-z"], { allowFail: true });
  if (diff.code !== 0) return [];
  const restored: string[] = [];
  for (const rel of diff.stdout.split("\0")) {
    if (rel === "" || (rel !== INDEX_FILE && !isKnowledgePage(rel))) continue;
    const working = await readPlain(abs(vault, rel));
    if (working === null || !working.includes(MANAGED_MARKER_PREFIX)) continue;
    const head = await showFileAt(vault, "HEAD", rel);
    if (head === null || !sameText(stripManagedBlocks(working).text, stripManagedBlocks(head).text)) continue;
    restored.push(rel);
  }
  if (restored.length > 0) await git(vault, ["checkout", "--", ...restored]);
  return restored;
}
