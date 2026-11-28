/**
 * The vault on disk: created by `POST init` or a first change (never by a
 * read), read as a snapshot, and changed
 * only through {@link vaultOperation} — which holds the vault's lock, lints the
 * pages it touched, and records exactly one commit (or puts every touched file
 * back when the lint refuses or the operation throws).
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { constants as fsConstants, type Stats } from "fs";
import os from "os";
import { createHash } from "crypto";
import path, { untraced } from "@/lib/runtime-path";
import { processStore } from "@/lib/process-store";
import { withPluginFields } from "./plugin-compat";
import { parsePage, serializePage, pageSummary, type ParsedPage } from "./frontmatter";
import { parseHead, splitFrontmatter, withBody, type ParsedHead } from "./frontmatter";
import { readInMemorySettings } from "./settings";
import { hasVerification, type PageFrontmatter } from "./schema";
import { generatedSummary } from "./summary-meta";
import { isKnowledgePage, pageAbsPath, RESERVED_DIRS, safePagePath, vaultDir } from "./paths";
import { PLUGIN_GITIGNORE_LINES, stripManagedBlocks } from "./plugin-files";
import { commitPaths, git, hasCommits, initRepo, isGitRepo, restorePaths, withVaultLock, type VaultAuthor } from "./git";
import { buildLinkGraph, pathAliases } from "./links";
import { LINT_RULES, lintSecretsInText, lintVault, type LintFinding } from "./lint";
import { readRetiredLedger, recordRetired } from "./state-db";

/** A page bigger than this is not read whole; it is reported, never parsed. */
export const MAX_PAGE_FILE_BYTES = 1024 * 1024;
export const MAX_VAULT_PAGES = 50_000;
const MAX_DEPTH = 8;
/** The deepest page the snapshot walk reaches: a folder at MAX_DEPTH holds pages one segment deeper. */
const MAX_PAGE_SEGMENTS = MAX_DEPTH + 1;

export const INDEX_FILE = "index.md";

const SEED_FILES: Readonly<Record<string, string>> = {
  ".gitignore": [
    "# OpenClaw's memory-wiki plugin keeps its state and its own generated files here;",
    "# they are rebuildable, not knowledge, and never part of the vault's history.",
    ...PLUGIN_GITIGNORE_LINES,
    "",
  ].join("\n"),
  [INDEX_FILE]: ["# Index", "", "Every page of this wiki is listed here, one line each.", ""].join("\n"),
  "AGENTS.md": [
    "# How this vault works",
    "",
    "- Every page is Markdown with YAML frontmatter (type, title, domain, owner, status,",
    "  generated, verified, stale_after, sources, privacy, claims).",
    "- The first paragraph of a page is its summary (300 characters at most).",
    "- Claim ids are global: `<domain>/<entity>/<fact>`; a retired id is never reused.",
    "- A page or claim with `verified` set was confirmed by a person and is final:",
    "  propose a change through the review queue, never edit it directly.",
    "- Each change is one git commit by Prime Radiant.",
    "",
  ].join("\n"),
};

export interface VaultPage {
  /** Vault-relative POSIX path, e.g. `entities/acme-widgets.md`. */
  path: string;
  text: string;
  bytes: number;
  mtimeMs: number;
  parsed: ParsedPage;
}

export interface VaultSnapshot {
  vault: string;
  pages: VaultPage[];
  /** The body of index.md, or null when the vault has none. */
  indexBody: string | null;
  /** True when the walk stopped at {@link MAX_VAULT_PAGES}. */
  truncated: boolean;
}

async function writeFileAtomic(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = untraced(`${abs}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, abs);
}

/** Refuse a write whose folder is reached through a symlink out of the vault. */
async function assertInsideVault(vault: string, abs: string): Promise<void> {
  const realVault = await fs.realpath(vault);
  let dir = path.dirname(abs);
  // Walk up to the nearest folder that exists and check where it really is.
  for (;;) {
    try {
      const real = await fs.realpath(dir);
      const rel = path.relative(realVault, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("page path leaves the vault");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const up = path.dirname(dir);
      if (up === dir) throw err;
      dir = up;
    }
  }
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("page path is not a plain file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Whether the vault exists as a repository with at least one commit. Reads
 * only: never creates the folder, the repository or the state database, so a
 * GET can ask it.
 */
export async function vaultInitialised(vault: string = vaultDir()): Promise<boolean> {
  try {
    if (!(await fs.stat(vault)).isDirectory()) return false;
  } catch {
    return false;
  }
  return (await isGitRepo(vault)) && (await hasCommits(vault));
}

/**
 * Create the vault (folder + git repository + seed files + first commit) when
 * it is not there yet. Idempotent. Called by `POST init` and by every
 * {@link vaultOperation}; the read routes never call it.
 */
export async function ensureVault(vault: string = vaultDir()): Promise<{ created: boolean }> {
  return withVaultLock(vault, async () => {
    await fs.mkdir(path.dirname(vault), { recursive: true, mode: 0o700 });
    await fs.mkdir(vault, { recursive: true, mode: 0o700 });
    let created = false;
    if (!(await isGitRepo(vault))) {
      await initRepo(vault);
      created = true;
    }
    if (!(await hasCommits(vault))) {
      const written: string[] = [];
      for (const [rel, text] of Object.entries(SEED_FILES)) {
        const abs = path.join(vault, rel);
        try {
          await fs.access(abs);
        } catch {
          await writeFileAtomic(abs, text);
        }
        written.push(rel);
      }
      await git(vault, ["add", "-A", "--", ...written]);
      await git(vault, ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", "init: vault"]);
      created = true;
    }
    return { created };
  });
}

// ── pages kept in memory (settings `inMemory`) ──────────────────────────────
//
// Off (the default) a read parses every page it reads, as it always did. With
// `inMemory.pages` the frontmatter's parse is kept, frozen, beside a hash of
// the YAML it came from: every read still reads the file, and parses it again
// only when that YAML changed — whoever changed it (Prime Radiant, the nightly
// merge, an undo, git or an editor on disk). With `inMemory.pageBodies` the
// file's text is kept too and the file is not read again while its size, times
// and inode are the ones it was read at. Only the box's own vault is kept (a
// nightly worktree is read and thrown away); a page a full read no longer
// finds is forgotten, and a switch turned off frees what it held.

/** A file changed this recently is read again: a second write in the same timestamp tick could leave its size and times as they were. */
const RACY_MS = 2_000;
/** About what one kept page costs beside its parse or its text: the map entry, its record and the hash. */
const ENTRY_BYTES = 160;

interface HeldText { value: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; bytes: number }
interface HeldHead { hash: string; head: ParsedHead; bytes: number }
interface HeldPage { text: HeldText | null; head: HeldHead | null }
interface HeldVault {
  pages: Map<string, HeldPage>;
  headBytes: number;
  textBytes: number;
  /** The switches as the last read or release saw them: a read already under way keeps nothing a switch turned off since. */
  on: { pages: boolean; pageBodies: boolean };
  /** The most both switches together keep, a quarter of the box's memory (2 GB on an 8 GB box): past it a page is read as if they were off. */
  ceiling: number;
}
interface Hold { vault: HeldVault; pages: boolean; bodies: boolean }

/** One per process, by vault (the routes and the boot layer are separate module copies). */
const heldVaults = processStore("prime-radiant:held-pages", () => new Map<string, HeldVault>());

/** The switches in force for a read of `vault`, freeing what a switch now off still holds; null when nothing is kept. */
function holdFor(vault: string): Hold | null {
  const key = path.resolve(vault);
  if (key !== path.resolve(vaultDir())) return null;
  let on;
  try {
    on = readInMemorySettings();
  } catch {
    on = { pages: false, pageBodies: false };
  }
  releaseHeldPages(on);
  if (!on.pages && !on.pageBodies) return null;
  let held = heldVaults.get(key);
  if (!held) heldVaults.set(key, (held = { pages: new Map(), headBytes: 0, textBytes: 0, on: { pages: on.pages, pageBodies: on.pageBodies }, ceiling: 0 }));
  held.ceiling = Math.floor(os.totalmem() / 4);
  return { vault: held, pages: on.pages, bodies: on.pageBodies };
}

/** Free what the switches that are off still hold: at once from the settings route, and on every read. */
export function releaseHeldPages(on: { pages: boolean; pageBodies: boolean }): void {
  for (const [key, held] of heldVaults) {
    held.on = { pages: on.pages, pageBodies: on.pageBodies };
    if (!on.pages && !on.pageBodies) {
      heldVaults.delete(key);
      continue;
    }
    if (!on.pages && held.headBytes > 0) for (const rel of [...held.pages.keys()]) keep(held, rel, "head", null);
    if (!on.pageBodies && held.textBytes > 0) for (const rel of [...held.pages.keys()]) keep(held, rel, "text", null);
  }
}

/** What `inMemory.pages` and `inMemory.pageBodies` hold right now, in bytes — about: V8's heap as these structures take it. */
export function heldPageBytes(): { pages: number; pageBodies: number } {
  let pages = 0;
  let pageBodies = 0;
  for (const held of heldVaults.values()) {
    pages += held.headBytes;
    pageBodies += held.textBytes;
  }
  return { pages, pageBodies };
}

function keep(held: HeldVault, rel: string, part: "head", value: HeldHead | null): void;
function keep(held: HeldVault, rel: string, part: "text", value: HeldText | null): void;
function keep(held: HeldVault, rel: string, part: "head" | "text", kept: HeldHead | HeldText | null): void {
  const entry = held.pages.get(rel) ?? { text: null, head: null };
  const was = entry[part]?.bytes ?? 0;
  // Its switch turned off while this read ran, or the ceiling reached: nothing is kept (and what was is stale).
  const value = kept && (part === "head" ? held.on.pages : held.on.pageBodies) && held.headBytes + held.textBytes - was + kept.bytes <= held.ceiling ? kept : null;
  if (part === "head") {
    entry.head = value as HeldHead | null;
    held.headBytes += (value?.bytes ?? 0) - was;
  } else {
    entry.text = value as HeldText | null;
    held.textBytes += (value?.bytes ?? 0) - was;
  }
  if (entry.head || entry.text) held.pages.set(rel, entry);
  else held.pages.delete(rel);
}

function forget(hold: Hold | null, rel: string): void {
  if (!hold) return;
  keep(hold.vault, rel, "head", null);
  keep(hold.vault, rel, "text", null);
}

/** About what a string takes on the heap: a header, one byte a character, two once any is past Latin-1. */
function stringBytes(s: string): number {
  return 16 + Math.ceil((s.length * (/[^\u0000-\u00ff]/.test(s) ? 2 : 1)) / 8) * 8;
}

/** Freeze `value` all the way down (a caller can never change what the next read answers) and answer about what it takes on the heap. */
function freezeAndMeasure(value: unknown): number {
  if (typeof value === "string") return stringBytes(value);
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 2 ** 30 ? 0 : 16;
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return 0;
  Object.freeze(value);
  const values = Object.values(value);
  let bytes = Array.isArray(value) ? 32 + 8 * values.length : 56 + 16 * values.length;
  for (const v of values) bytes += freezeAndMeasure(v);
  return bytes;
}

/** The page's parse, from memory while its YAML is the one parsed last. */
function heldParse(hold: Hold, rel: string, text: string): ParsedPage {
  const { yamlText, body } = splitFrontmatter(text);
  const hash = createHash("sha256").update(yamlText === null ? "\0" : `-${yamlText}`).digest("base64");
  let held = hold.vault.pages.get(rel)?.head;
  if (held?.hash !== hash) {
    const head = parseHead(yamlText);
    // The YAML text is counted too: the parse's strings are slices of it.
    held = { hash, head, bytes: ENTRY_BYTES + freezeAndMeasure(head) + (yamlText === null ? 0 : stringBytes(yamlText)) };
    keep(hold.vault, rel, "head", held);
  }
  return withBody(held.head, stripManagedBlocks(body).text);
}

/** The page from the text in memory, while the file is the one it was read from; null when it must be read. */
async function heldRead(abs: string, rel: string, held: HeldText, hold: Hold): Promise<VaultPage | "gone" | null> {
  let st: Stats;
  try {
    st = await fs.lstat(abs);
  } catch {
    return "gone";
  }
  // A symlink is never read (O_NOFOLLOW below), so it is no page either.
  if (!st.isFile()) return "gone";
  if (st.size !== held.size || st.mtimeMs !== held.mtimeMs || st.ctimeMs !== held.ctimeMs || st.ino !== held.ino) return null;
  return { path: rel, text: held.value, bytes: st.size, mtimeMs: st.mtimeMs, parsed: hold.pages ? heldParse(hold, rel, held.value) : parsePage(held.value) };
}

async function readPageAt(vault: string, rel: string, hold: Hold | null = null): Promise<VaultPage | null> {
  const abs = pageAbsPath(vault, rel);
  const heldText = hold?.bodies ? hold.vault.pages.get(rel)?.text : null;
  if (hold && heldText) {
    const page = await heldRead(abs, rel, heldText, hold);
    if (page === "gone") forget(hold, rel);
    if (page) return page === "gone" ? null : page;
  }
  // Taken before the stat: a file changed after this is newer than the time its text is kept with.
  const readAt = Date.now();
  // One handle for the check and the read: O_NOFOLLOW refuses a symlink, and
  // fstat/readFile on the same descriptor cannot race a swap of the path.
  let handle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    forget(hold, rel);
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      forget(hold, rel);
      return null;
    }
    if (st.size > MAX_PAGE_FILE_BYTES) {
      forget(hold, rel);
      return {
        path: rel,
        text: "",
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        parsed: { ok: false, errors: [{ field: "", message: "file is too large to read" }], body: "", raw: null },
      };
    }
    const text = await handle.readFile("utf8");
    if (hold?.bodies) {
      const settled = readAt - Math.max(st.mtimeMs, st.ctimeMs) >= RACY_MS;
      keep(hold.vault, rel, "text", settled ? { value: text, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, bytes: ENTRY_BYTES + stringBytes(text) } : null);
    }
    return { path: rel, text, bytes: st.size, mtimeMs: st.mtimeMs, parsed: hold?.pages ? heldParse(hold, rel, text) : parsePage(text) };
  } finally {
    await handle.close();
  }
}

/** One page by vault-relative path, or null when absent (or not a safe page path). */
export async function readPage(rel: string, vault: string = vaultDir()): Promise<VaultPage | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe)) return null;
  return readPageAt(vault, safe, holdFor(vault));
}

/**
 * One page by vault-relative path the way a snapshot would list it: null also
 * when the walk would not reach it (a folder on its way is a symlink, or it
 * lies deeper than the walk goes) — so a read of one page agrees with a read
 * of them all.
 */
export async function readListedPage(rel: string, vault: string = vaultDir()): Promise<VaultPage | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe) || safe.split("/").length > MAX_PAGE_SEGMENTS || !(await reachedByWalk(vault, safe))) return null;
  return readPageAt(vault, safe, holdFor(vault));
}

/** Every knowledge page in the vault, sorted by path. Symlinks and dot-folders are never followed. */
export async function readVaultSnapshot(vault: string = vaultDir()): Promise<VaultSnapshot> {
  const rels: string[] = [];
  let truncated = false;
  async function walk(dirRel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dirRel === "" ? vault : path.join(vault, ...dirRel.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
      if (e.isDirectory()) {
        if (dirRel === "" && RESERVED_DIRS.has(e.name)) continue;
        await walk(rel, depth + 1);
      } else if (e.isFile() && isKnowledgePage(rel) && safePagePath(rel) === rel) {
        if (rels.length >= MAX_VAULT_PAGES) {
          truncated = true;
          return;
        }
        rels.push(rel);
      }
    }
  }
  await walk("", 0);
  const hold = holdFor(vault);
  if (hold) {
    // A page the walk no longer finds was deleted or moved: forgotten.
    const walked = new Set(rels);
    for (const rel of [...hold.vault.pages.keys()]) if (!walked.has(rel)) forget(hold, rel);
  }
  // A few reads in flight at once: one after the other, a large vault spends
  // most of its read waiting on each file in turn. The order stays the walk's.
  const read: Array<VaultPage | null> = new Array(rels.length).fill(null);
  let next = 0;
  const reader = async () => {
    while (next < rels.length) {
      const at = next++;
      read[at] = await readPageAt(vault, rels[at], hold);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_READS_IN_FLIGHT, rels.length) }, reader));
  const pages = read.filter((p): p is VaultPage => p !== null);
  return { vault, pages, indexBody: await readIndexBody(vault), truncated };
}

/** Page files one snapshot reads at the same time. */
const SNAPSHOT_READS_IN_FLIGHT = 16;

/** index.md without memory-wiki's "## Generated" block (its links index nothing of ours), or null when there is none. */
async function readIndexBody(vault: string): Promise<string | null> {
  try {
    return stripManagedBlocks(await fs.readFile(path.join(vault, INDEX_FILE), "utf8")).text;
  } catch {
    return null;
  }
}

/** The order the snapshot walk lists pages in: folder by folder, each one's entries by name. */
function walkOrder(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].localeCompare(y[i]);
  }
  return x.length - y.length;
}

/**
 * Whether the walk reaches `rel`: every folder on its way a real folder, not
 * a symlink (the walk follows none), so a page read by its path alone is one
 * a snapshot would list too.
 */
async function reachedByWalk(vault: string, rel: string): Promise<boolean> {
  const segments = rel.split("/");
  for (let i = 1; i < segments.length; i++) {
    try {
      const st = await fs.lstat(path.join(vault, ...segments.slice(0, i)));
      if (!st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** What a page listing shows for one page — never the body. */
export interface PageListEntry {
  path: string;
  valid: boolean;
  title: string | null;
  type: string | null;
  domain: string | null;
  owner: string | null;
  status: string | null;
  privacy: string | null;
  verified: boolean;
  claims: number;
  summary: string | null;
  bodyChars: number;
  mtimeMs: number;
}

export function listEntry(page: VaultPage): PageListEntry {
  const p = page.parsed;
  const fm: PageFrontmatter | null = p.ok ? p.frontmatter : null;
  return {
    path: page.path,
    valid: p.ok,
    title: fm?.title ?? null,
    type: fm?.type ?? null,
    domain: fm?.domain ?? null,
    owner: fm?.owner ?? null,
    status: fm?.status ?? null,
    privacy: fm?.privacy ?? null,
    verified: fm ? hasVerification(fm) : false,
    claims: fm?.claims.length ?? 0,
    // The summary written from the page's connections, when it has one; else its own first paragraph.
    summary: (fm ? generatedSummary(fm)?.text : null) ?? pageSummary(p.body),
    bodyChars: p.body.length,
    mtimeMs: page.mtimeMs,
  };
}

// ── operations ────────────────────────────────────────────────────────────

/** What an operation may do to the vault. Every path is vault-relative and checked. */
export interface VaultTx {
  readonly vault: string;
  /** One page as it is on disk now, or null when the snapshot walk would not list it. */
  read(rel: string): Promise<VaultPage | null>;
  /**
   * The whole vault, read once per operation (later calls answer the same
   * snapshot). Read it BEFORE writing: the operation's lint then starts from
   * it and reads again only the paths the operation touched, instead of the
   * whole vault a second time.
   */
  snapshot(): Promise<VaultSnapshot>;
  /** Write raw text to a knowledge page (or to index.md). */
  write(rel: string, text: string): Promise<string>;
  /** Write a page from frontmatter + body (serialised deterministically). */
  writePage(rel: string, frontmatter: PageFrontmatter, body: string): Promise<string>;
  remove(rel: string): Promise<string>;
  /** Paths touched so far. */
  readonly touched: ReadonlySet<string>;
}

export class VaultLintBlockedError extends Error {
  constructor(readonly findings: LintFinding[]) {
    super(`the change was refused by lint: ${findings.map((f) => `${f.rule} (${f.path})`).join(", ")}`);
    this.name = "VaultLintBlockedError";
  }
}

export class VaultPathError extends Error {
  constructor(readonly input: string) {
    super(`not a page path: ${input}`);
    this.name = "VaultPathError";
  }
}

export interface VaultOperationResult<T> {
  result: T;
  /** The commit this operation made, or null when it changed nothing. */
  commit: string | null;
  changed: string[];
  /** Non-blocking findings on the changed pages. */
  findings: LintFinding[];
}

export interface VaultOperationOptions {
  vault?: string;
  /**
   * Run the scoped lint and refuse on a blocking finding. Default true: the
   * touched pages judged against the whole vault. `"pages"` judges each one
   * on its own, against index.md and the retired-id ledger, without reading
   * the rest — only for a change that leaves every page's title, body, claims
   * and retired ids as they were (a frontmatter metadata edit): the
   * vault-wide rules (the claim namespace, the link graph) then come out no
   * different than before the change, and a page is refused for what the
   * change did to it, exactly as a PATCH of that page alone would be. A
   * touched page index.md does not list is judged against the whole vault
   * after all (only every other page can tell whether it is an orphan); the
   * listed ones still on their own.
   */
  lint?: boolean | "pages";
  /** `Key: value` lines that close the commit message (git.ts `commitPaths`), e.g. who a verification names. */
  trailers?: readonly string[];
  /** Clock for the lint's stale check (tests). */
  now?: Date;
  /**
   * Re-embed the changed pages in Memory Shard's vault index after a commit on
   * `main`, in the background. Default true; a caller that reindexes itself
   * (a merge that names its own paths) can switch it off.
   */
  reindex?: boolean;
  /** Who the commit names as its author. Default Prime Radiant (git.ts). */
  author?: VaultAuthor;
}

function txPath(rel: string): string {
  if (rel === INDEX_FILE) return rel;
  const safe = safePagePath(rel);
  // A page the walk cannot reach would be committed and then never listed or linted.
  if (!safe || !isKnowledgePage(safe) || safe.split("/").length > MAX_PAGE_SEGMENTS) throw new VaultPathError(rel);
  return safe;
}

/**
 * Run one mutating operation on the vault: exactly one commit with `message`
 * (conventional form, e.g. `ingest: acme-widgets`; or worked out from what
 * the operation answered, e.g. how many pages it changed), or none when
 * nothing changed. On a blocking lint finding or a throw, every file the
 * operation touched is put back and nothing is committed.
 */
export async function vaultOperation<T>(
  message: string | ((result: T) => string),
  fn: (tx: VaultTx) => Promise<T>,
  options: VaultOperationOptions = {},
): Promise<VaultOperationResult<T>> {
  const vault = options.vault ?? vaultDir();
  await ensureVault(vault);
  return withVaultLock(vault, async () => {
    const touched = new Set<string>();
    let base: Promise<VaultSnapshot> | null = null;
    const tx: VaultTx = {
      vault,
      touched,
      async read(rel) {
        const p = txPath(rel);
        return p === INDEX_FILE ? null : readListedPage(p, vault);
      },
      snapshot() {
        base ??= readVaultSnapshot(vault);
        return base;
      },
      async write(rel, text) {
        const p = txPath(rel);
        const abs = p === INDEX_FILE ? path.join(vault, INDEX_FILE) : pageAbsPath(vault, p);
        await assertInsideVault(vault, abs);
        touched.add(p);
        await writeFileAtomic(abs, text);
        return p;
      },
      async writePage(rel, frontmatter, body) {
        // memory-wiki's own fields (id, pageType, sourceIds, updatedAt) ride along on every write.
        return tx.write(rel, serializePage(withPluginFields(txPath(rel), frontmatter), body));
      },
      async remove(rel) {
        const p = txPath(rel);
        const abs = p === INDEX_FILE ? path.join(vault, INDEX_FILE) : pageAbsPath(vault, p);
        await assertInsideVault(vault, abs);
        touched.add(p);
        await fs.rm(abs, { force: true });
        return p;
      },
    };
    const changed = () => [...touched].sort();
    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      await restorePaths(vault, changed());
      throw err;
    }
    let findings: LintFinding[] = [];
    // The touched pages as they are now: what the lint judges and what the retired-id ledger records.
    const current = new Map<string, VaultPage | null>();
    const touchedPages = async () => {
      for (const p of changed()) if (p !== INDEX_FILE && !current.has(p)) current.set(p, await readPageAt(vault, p));
      return current;
    };
    if (options.lint !== false && touched.size > 0) {
      let blocking: LintFinding[];
      try {
        findings = await lintTouched(vault, changed(), await touchedPages(), options.lint === "pages", () => base ?? readVaultSnapshot(vault), options.now);
        blocking = findings.filter((f) => f.blocksCommit);
      } catch (err) {
        await restorePaths(vault, changed());
        throw err;
      }
      if (blocking.length > 0) {
        await restorePaths(vault, changed());
        throw new VaultLintBlockedError(blocking);
      }
    }
    let commit: string | null;
    try {
      commit = await commitPaths(vault, typeof message === "string" ? message : message(result), changed(), options.author, options.trailers);
    } catch (err) {
      await restorePaths(vault, changed());
      throw err;
    }
    if (commit) recordRetiredFromPages(vault, [...(await touchedPages()).values()]);
    if (commit && options.reindex !== false) reindexAfterCommit(vault, changed());
    return { result, commit, changed: changed(), findings };
  });
}

/**
 * The lint of one operation's touched pages, as they are now. The vault it
 * judges them against is `vaultBefore()` — read before the operation wrote,
 * or just now — brought up to date with the touched paths alone: the vault as
 * a fresh read would find it, since the lock keeps every other writer out.
 * `pagesOnly` is the `"pages"` lint (see {@link VaultOperationOptions.lint}).
 */
async function lintTouched(
  vault: string,
  changed: readonly string[],
  touched: ReadonlyMap<string, VaultPage | null>,
  pagesOnly: boolean,
  vaultBefore: () => Promise<VaultSnapshot>,
  now: Date | undefined,
): Promise<LintFinding[]> {
  const ledgerRetired = readRetiredLedgerSafe(vault);
  const own = [...touched.values()].filter((p): p is VaultPage => p !== null);
  const indexSecrets = (indexBody: string | null) => (changed.includes(INDEX_FILE) && indexBody !== null ? lintSecretsInText(INDEX_FILE, indexBody) : []);
  if (pagesOnly) {
    const indexBody = await readIndexBody(vault);
    // index.md read once for them all. Judged alone, a page index.md does not
    // list has no inbound links at all, and whether another page links it
    // takes the whole vault to tell. A listing does not reach a page either
    // (links.ts `contentReach`), but an edit of a listed page (the quick road
    // a metadata edit takes) does not change who links it: it is judged on
    // its own, as its own PATCH would be, its orphan warning left to the
    // vault-wide lint, and only the unlisted ones against the whole vault.
    const listed = listedIn(indexBody, own);
    const alone = own.filter((p) => !p.parsed.ok || listed.has(p.path));
    const findings = alone.flatMap((p) =>
      lintVault({ vault, pages: [p], indexBody: null, truncated: false }, { scope: [p.path], ledgerRetired, now }).findings.filter((f) => f.rule !== "orphan"),
    );
    const unlisted = own.filter((p) => !alone.includes(p)).map((p) => p.path);
    if (unlisted.length > 0) {
      const before = await vaultBefore();
      const pages = [...before.pages.filter((p) => !touched.has(p.path)), ...own].sort((a, b) => walkOrder(a.path, b.path));
      findings.push(...lintVault({ vault, pages, indexBody, truncated: before.truncated }, { scope: unlisted, ledgerRetired, now }).findings);
    }
    findings.sort((a, b) => a.path.localeCompare(b.path) || LINT_RULES.indexOf(a.rule) - LINT_RULES.indexOf(b.rule));
    return [...findings, ...indexSecrets(indexBody)];
  }
  const before = await vaultBefore();
  const indexBody = changed.includes(INDEX_FILE) ? await readIndexBody(vault) : before.indexBody;
  // Every touched page is judged, also one the walk did not return (a
  // truncated snapshot): the blocking rules hold for every commit.
  const pages = [...before.pages.filter((p) => !touched.has(p.path)), ...own].sort((a, b) => walkOrder(a.path, b.path));
  const report = lintVault({ vault, pages, indexBody, truncated: before.truncated }, { scope: changed.filter((p) => p !== INDEX_FILE), ledgerRetired, now });
  return [...report.findings, ...indexSecrets(indexBody)];
}

/** Which of `pages` index.md lists, its links resolved as the lint resolves them (`buildLinkGraph(...).indexed`). */
function listedIn(indexBody: string | null, pages: readonly VaultPage[]): Set<string> {
  return buildLinkGraph(pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, aliases: p.parsed.ok ? pathAliases(p.parsed.frontmatter.aliases) : undefined, body: "" })), indexBody).indexed;
}

/**
 * Which of the pages at `rels` index.md lists now — whether the `"pages"`
 * lint judges each on its own or against the whole vault (see
 * {@link VaultOperationOptions.lint}).
 */
export async function indexedPaths(vault: string, rels: readonly string[]): Promise<Set<string>> {
  const pages = (await Promise.all(rels.map((rel) => readListedPage(rel, vault)))).filter((p): p is VaultPage => p !== null);
  return listedIn(await readIndexBody(vault), pages);
}

function readRetiredLedgerSafe(vault: string): string[] {
  try {
    return readRetiredLedger(vault);
  } catch {
    return [];
  }
}

function recordRetiredFromPages(vault: string, pages: Array<VaultPage | null>): void {
  const ids: Array<{ id: string; page: string }> = [];
  for (const p of pages) {
    if (p?.parsed.ok) for (const id of p.parsed.frontmatter.retiredClaimIds) ids.push({ id, page: p.path });
  }
  if (ids.length === 0) return;
  try {
    recordRetired(vault, ids);
  } catch {
    // The ledger is a second copy; the page itself already records the retirement.
  }
}

/**
 * Hand the commit's pages to Memory Shard's vault index without waiting for it.
 * Imported lazily: the index pulls in the embedder and sqlite, which a vault
 * operation must not need to load, and nothing here may slow or fail the
 * operation that already committed.
 */
function reindexAfterCommit(vault: string, changed: readonly string[]): void {
  void import("./shard-index")
    .then((m) => m.scheduleReindexAfterCommit(vault, changed))
    .catch((err) => {
      console.warn(`[prime-radiant] vault reindex could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
    });
}
