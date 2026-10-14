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
import { constants as fsConstants } from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { parsePage, serializePage, pageSummary, type ParsedPage } from "./frontmatter";
import { hasVerification, type PageFrontmatter } from "./schema";
import { isKnowledgePage, pageAbsPath, RESERVED_DIRS, safePagePath, vaultDir } from "./paths";
import { commitPaths, git, hasCommits, initRepo, isGitRepo, restorePaths, withVaultLock } from "./git";
import { lintVault, type LintFinding } from "./lint";
import { readRetiredLedger, recordRetired } from "./state-db";

/** A page bigger than this is not read whole; it is reported, never parsed. */
export const MAX_PAGE_FILE_BYTES = 1024 * 1024;
export const MAX_VAULT_PAGES = 50_000;
const MAX_DEPTH = 8;

export const INDEX_FILE = "index.md";

const SEED_FILES: Readonly<Record<string, string>> = {
  ".gitignore": [
    "# memory-wiki keeps its compiled state here; it is rebuildable and not history.",
    ".openclaw-wiki/",
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

async function readPageAt(vault: string, rel: string): Promise<VaultPage | null> {
  const abs = pageAbsPath(vault, rel);
  // One handle for the check and the read: O_NOFOLLOW refuses a symlink, and
  // fstat/readFile on the same descriptor cannot race a swap of the path.
  let handle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_PAGE_FILE_BYTES) {
      return {
        path: rel,
        text: "",
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        parsed: { ok: false, errors: [{ field: "", message: "file is too large to read" }], body: "", raw: null },
      };
    }
    const text = await handle.readFile("utf8");
    return { path: rel, text, bytes: st.size, mtimeMs: st.mtimeMs, parsed: parsePage(text) };
  } finally {
    await handle.close();
  }
}

/** One page by vault-relative path, or null when absent (or not a safe page path). */
export async function readPage(rel: string, vault: string = vaultDir()): Promise<VaultPage | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe)) return null;
  return readPageAt(vault, safe);
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
  const pages: VaultPage[] = [];
  for (const rel of rels) {
    const page = await readPageAt(vault, rel);
    if (page) pages.push(page);
  }
  let indexBody: string | null = null;
  try {
    indexBody = await fs.readFile(path.join(vault, INDEX_FILE), "utf8");
  } catch {
    indexBody = null;
  }
  return { vault, pages, indexBody, truncated };
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
    summary: pageSummary(p.body),
    bodyChars: p.body.length,
    mtimeMs: page.mtimeMs,
  };
}

// ── operations ────────────────────────────────────────────────────────────

/** What an operation may do to the vault. Every path is vault-relative and checked. */
export interface VaultTx {
  readonly vault: string;
  read(rel: string): Promise<VaultPage | null>;
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
  /** Run the scoped lint and refuse on a blocking finding. Default true. */
  lint?: boolean;
  /** Clock for the lint's stale check (tests). */
  now?: Date;
}

function txPath(rel: string): string {
  if (rel === INDEX_FILE) return rel;
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe)) throw new VaultPathError(rel);
  return safe;
}

/**
 * Run one mutating operation on the vault: exactly one commit with `message`
 * (conventional form, e.g. `ingest: acme-widgets`), or none when nothing
 * changed. On a blocking lint finding or a throw, every file the operation
 * touched is put back and nothing is committed.
 */
export async function vaultOperation<T>(
  message: string,
  fn: (tx: VaultTx) => Promise<T>,
  options: VaultOperationOptions = {},
): Promise<VaultOperationResult<T>> {
  const vault = options.vault ?? vaultDir();
  await ensureVault(vault);
  return withVaultLock(vault, async () => {
    const touched = new Set<string>();
    const tx: VaultTx = {
      vault,
      touched,
      async read(rel) {
        const p = txPath(rel);
        return p === INDEX_FILE ? null : readPageAt(vault, p);
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
        return tx.write(rel, serializePage(frontmatter, body));
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
    if (options.lint !== false && touched.size > 0) {
      const snapshot = await readVaultSnapshot(vault);
      const report = lintVault(snapshot, {
        scope: changed().filter((p) => p !== INDEX_FILE),
        ledgerRetired: readRetiredLedgerSafe(vault),
        now: options.now,
      });
      const blocking = report.findings.filter((f) => f.blocksCommit);
      if (blocking.length > 0) {
        await restorePaths(vault, changed());
        throw new VaultLintBlockedError(blocking);
      }
      findings = report.findings;
    }
    let commit: string | null;
    try {
      commit = await commitPaths(vault, message, changed());
    } catch (err) {
      await restorePaths(vault, changed());
      throw err;
    }
    if (commit) recordRetiredFromPages(vault, await Promise.all(changed().map((p) => (p === INDEX_FILE ? null : readPageAt(vault, p)))));
    return { result, commit, changed: changed(), findings };
  });
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
