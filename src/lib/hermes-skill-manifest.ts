// TASK-452 — proving a skill install actually landed, and repairing it when it
// did not.
//
// THE BUG THIS EXISTS FOR. Hermes' installer does not download a skill
// directory; it downloads SKILL.md and then guesses which support files to
// fetch by running a regex over that file's prose
// (~/.hermes/hermes-agent/tools/skills_hub.py:155-158). The regex only matches
// `references|templates|scripts|assets|examples/...` when it is preceded by
// `](`, a backtick or whitespace, so:
//
//   * `anthropics/skills/skills/algorithmic-art` installed 2 of its 4 upstream
//     files — the `**templates/generator_template.js**` its own SKILL.md tells
//     the agent to read is in BOLD, so no left delimiter matched, and the
//     root-level LICENSE.txt is in none of the five directories;
//   * `anthropics/skills/skills/pdf` matches ZERO support paths, so 1 of 12
//     files installs and the skill's own "read REFERENCE.md / FORMS.md" lands
//     pointing at nothing;
//
// and in both cases the install answered `{"ok":true}` and wrote a lock entry
// describing the truncated bundle as complete.
//
// WHAT THIS MODULE DOES. It resolves the set of files a skill SHOULD have from
// the most authoritative source available, diffs that against what is on disk,
// fetches the ones the installer skipped, and verifies each fetched blob
// against the hash the source published. The install route refuses to keep an
// install it cannot complete.
//
// Three manifest origins, best first:
//   github-tree    the repo's own git tree (one API call, `recursive=1`) —
//                  every blob with its size and its git object id. The only
//                  origin that is COMPLETE, and the only one that can repair.
//   official-disk  `official/*` skills ship inside the agent checkout at
//                  hermes-agent/optional-skills/<category>/<name>, so the
//                  device already holds the authoritative file list offline.
//   skill-md       last resort: every relative path the installed SKILL.md
//                  names. Incomplete by construction (a skill may ship a file
//                  it never mentions) but it catches the case that matters —
//                  a SKILL.md that instructs the agent to read a file the
//                  installer did not fetch.
//
// SECURITY. Every path in a manifest comes from a public registry. Nothing is
// joined to the filesystem without `resolveInside`; symlink and submodule tree
// entries are dropped rather than followed; every fetched blob is checked
// against the git object id the tree published BEFORE it is written; and the
// whole repair is bounded by file count, per-file size and total bytes.

import { createHash } from 'crypto';
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';

// ── Limits ──────────────────────────────────────────────────────────────────
// A skill is documentation plus a handful of scripts. These are ceilings for a
// hostile or broken registry row, not expectations: the largest bundled skill
// on a real device is 17 files / ~200 KB.
const MAX_MANIFEST_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPAIR_BYTES = 20 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 20_000;
const MAX_DIR_DEPTH = 6;

/** One file a skill is expected to contain, relative to its install directory. */
export interface ExpectedFile {
  path: string;
  /** Byte size the source published, when it published one. */
  size?: number;
  /** Git object id (sha1 of `blob <len>\0<content>`), when the source has one. */
  sha?: string;
}

export type ManifestOrigin = 'github-tree' | 'official-disk' | 'skill-md';

export interface SkillManifest {
  origin: ManifestOrigin;
  files: ExpectedFile[];
  /** True when the origin lists EVERY file, so a diff is authoritative. */
  complete: boolean;
}

// ── Path hygiene ────────────────────────────────────────────────────────────

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._][A-Za-z0-9._+-]*$/;

/**
 * Is this a relative, in-tree path we are willing to create or compare?
 * Rejects absolute paths, traversal, empty and dot segments, Windows drive
 * letters, control characters and anything unreasonably deep.
 */
export function isSafeRelativePath(rel: string): boolean {
  if (typeof rel !== 'string') return false;
  const v = rel.trim();
  if (!v || v.length > 200) return false;
  if (v.startsWith('/') || v.startsWith('\\') || /^[A-Za-z]:/.test(v)) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  const parts = v.split('/');
  if (parts.length > MAX_DIR_DEPTH) return false;
  return parts.every((p) => p !== '.' && p !== '..' && SAFE_SEGMENT_RE.test(p));
}

/** Resolve `relative` inside `root`, or null when it would escape. */
export function resolveInside(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  const abs = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  return abs.startsWith(prefix) ? abs : null;
}

// ── SKILL.md reference extraction ───────────────────────────────────────────

// Extensions a skill's support files actually use. Restricting to a known set
// is what stops prose like "see the docs" or a version string ("v1.2.3") being
// mistaken for a filename — the previous approach's failure mode in reverse.
const SUPPORT_EXTENSIONS = new Set([
  'md', 'txt', 'py', 'js', 'mjs', 'cjs', 'ts', 'sh', 'bash', 'json', 'yaml', 'yml',
  'toml', 'csv', 'tsv', 'html', 'htm', 'css', 'sql', 'r', 'rb', 'go', 'rs', 'ipynb',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'xml', 'ini', 'cfg', 'conf', 'tmpl', 'j2',
]);

// Everything that can carry a path in a SKILL.md, matched WITHOUT requiring a
// particular left delimiter — the exact assumption that dropped
// `**templates/generator_template.js**`. We over-collect deliberately and let
// `isSafeRelativePath` + the extension allowlist do the filtering; a spurious
// entry only ever means "we also checked for a file that does not exist", and
// unknown-but-absent files are reported, not fatal, for the `skill-md` origin.
const CANDIDATE_RE = /[A-Za-z0-9._][A-Za-z0-9._/+-]*\.[A-Za-z0-9]{1,8}/g;

// A URL's path would otherwise look exactly like a relative path.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Every relative file path an installed SKILL.md names, deduped and sorted.
 * Includes the frontmatter (a `license: Complete terms in LICENSE.txt` line is
 * how the algorithmic-art skill names the file the installer dropped) and the
 * body, and matches bold, backticked, bare and markdown-link forms alike.
 */
export function referencedPaths(skillMd: string): string[] {
  if (typeof skillMd !== 'string' || !skillMd) return [];
  // Strip URLs first so `https://example.com/a/b.md` cannot contribute `b.md`.
  const text = skillMd.slice(0, 512 * 1024).replace(URL_RE, ' ');
  const out = new Set<string>();
  for (const raw of text.match(CANDIDATE_RE) || []) {
    // Trailing sentence punctuation clings to a bare path: "see REFERENCE.md."
    const candidate = raw.replace(/[.,;:!?)\]}'"`*]+$/, '');
    if (!candidate.includes('.')) continue;
    const ext = candidate.split('.').pop()?.toLowerCase() || '';
    if (!SUPPORT_EXTENSIONS.has(ext)) continue;
    if (!isSafeRelativePath(candidate)) continue;
    // SKILL.md itself is the thing we read; it is never a missing support file.
    if (candidate === 'SKILL.md') continue;
    out.add(candidate);
    if (out.size >= MAX_MANIFEST_FILES) break;
  }
  return Array.from(out).sort();
}

// Directories a skill keeps its payload in. A path under one of these is a
// FILE THE SKILL SHIPS; a bare word with an extension elsewhere in the prose
// usually is not.
const SUPPORT_DIRS = new Set(['references', 'reference', 'templates', 'scripts', 'assets', 'examples', 'docs', 'data', 'agents']);

// Root-level companion docs are conventionally shouted: LICENSE.txt,
// REFERENCE.md, FORMS.md, README.md. That convention is what separates
// "the file this skill ships next to SKILL.md" from "report.md, the file the
// skill tells the agent to WRITE" — and getting that distinction wrong in the
// permissive direction would block installs over files that were never meant
// to exist.
const SHOUTED_BASENAME_RE = /^[A-Z][A-Z0-9_-]*$/;

/**
 * The subset of `referencedPaths` that a skill is expected to SHIP, used as the
 * manifest of last resort when neither the git tree nor an on-disk official
 * copy is available.
 *
 * Deliberately narrower than the raw extraction. This origin has no hashes and
 * no authoritative file list, so a false positive here does not merely warn —
 * it refuses an install. Both real-world truncations are inside it:
 * `templates/generator_template.js` (support dir) and `LICENSE.txt` /
 * `REFERENCE.md` / `FORMS.md` (shouted root docs).
 */
export function referencedSupportPaths(skillMd: string): string[] {
  return referencedPaths(skillMd).filter((rel) => {
    const parts = rel.split('/');
    if (parts.length > 1) return SUPPORT_DIRS.has(parts[0].toLowerCase());
    const base = parts[0].slice(0, parts[0].lastIndexOf('.'));
    return SHOUTED_BASENAME_RE.test(base);
  });
}

// ── Disk ────────────────────────────────────────────────────────────────────

/** Every regular file under a skill directory, as `relative path -> bytes`. */
export async function listSkillFiles(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (current: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DIR_DEPTH || out.size >= MAX_MANIFEST_FILES * 4) return;
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= MAX_MANIFEST_FILES * 4) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
      } else if (entry.isFile()) {
        try {
          out.set(childRel, (await fs.stat(childAbs)).size);
        } catch {
          /* vanished mid-walk */
        }
      }
      // Symlinks are neither followed nor counted: a link is not the file.
    }
  };
  await walk(dir, '', 1);
  return out;
}

/** Remove a skill's install directory. Used to clean up a refused install. */
export async function removeSkillDir(root: string, installPath: string): Promise<boolean> {
  const abs = resolveInside(root, installPath);
  if (!abs) return false;
  try {
    await fs.rm(abs, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface TreeEntry {
  path?: unknown;
  type?: unknown;
  mode?: unknown;
  size?: unknown;
  sha?: unknown;
}

/**
 * The complete file list of a skill directory inside a GitHub repo, from ONE
 * `git/trees?recursive=1` call. `HEAD` resolves the repo's default branch, so
 * no extra request is needed to discover whether it is `main` or `master`.
 *
 * Returns null when the repo/path is unusable or GitHub could not be reached —
 * an offline device must still be able to install, it just cannot repair.
 */
export async function githubTreeManifest(
  repo: string,
  subPath: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ExpectedFile[] | null> {
  if (!REPO_RE.test(repo)) return null;
  const prefix = subPath.replace(/^\/+|\/+$/g, '');
  if (prefix && !isSafeRelativePath(prefix)) return null;
  const doFetch = opts.fetchImpl || fetch;

  let res: Response;
  try {
    res = await doFetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'clawbox-skills-store' },
      signal: opts.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_TREE_BYTES) return null;
  let doc: { tree?: unknown; truncated?: unknown };
  try {
    doc = (await res.json()) as { tree?: unknown; truncated?: unknown };
  } catch {
    return null;
  }
  // A truncated tree is not a file list — treating it as one would "prove" that
  // files present upstream do not exist.
  if (doc.truncated === true) return null;
  if (!Array.isArray(doc.tree)) return null;

  const want = prefix ? `${prefix}/` : '';
  const files: ExpectedFile[] = [];
  for (const raw of doc.tree as TreeEntry[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type !== 'blob') continue;
    // 100644 / 100755 are files. 120000 is a symlink and 160000 a submodule —
    // neither is content we are willing to materialise on the device.
    const mode = typeof raw.mode === 'string' ? raw.mode : '';
    if (mode !== '100644' && mode !== '100755') continue;
    const full = typeof raw.path === 'string' ? raw.path : '';
    if (!full || (want && !full.startsWith(want))) continue;
    const rel = want ? full.slice(want.length) : full;
    if (!rel || !isSafeRelativePath(rel)) continue;
    const size = typeof raw.size === 'number' && raw.size >= 0 ? raw.size : undefined;
    if (size !== undefined && size > MAX_FILE_BYTES) continue;
    files.push({
      path: rel,
      size,
      sha: typeof raw.sha === 'string' && /^[a-f0-9]{40}$/.test(raw.sha) ? raw.sha : undefined,
    });
    if (files.length >= MAX_MANIFEST_FILES) break;
  }
  // A prefix that matched nothing means the identifier does not describe this
  // repo — reporting "0 expected files" would let any install pass.
  return files.length ? files.sort((a, b) => a.path.localeCompare(b.path)) : null;
}

/** Git's own object id for a blob: sha1 of `blob <bytelength>\0<content>`. */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\u0000`)
    .update(content)
    .digest('hex');
}

/**
 * Download one blob BY ITS OBJECT ID and verify it. Fetching by sha rather than
 * by branch+path means the bytes are pinned to exactly the revision the tree
 * described, so a repair cannot race a push, and the local re-hash proves the
 * transport did not alter them.
 */
export async function fetchGithubBlob(
  repo: string,
  sha: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<Buffer | null> {
  if (!REPO_RE.test(repo) || !/^[a-f0-9]{40}$/.test(sha)) return null;
  const doFetch = opts.fetchImpl || fetch;
  let res: Response;
  try {
    res = await doFetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'clawbox-skills-store' },
      signal: opts.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let doc: { content?: unknown; encoding?: unknown; size?: unknown };
  try {
    doc = (await res.json()) as { content?: unknown; encoding?: unknown; size?: unknown };
  } catch {
    return null;
  }
  if (doc.encoding !== 'base64' || typeof doc.content !== 'string') return null;
  if (typeof doc.size === 'number' && doc.size > MAX_FILE_BYTES) return null;
  const buf = Buffer.from(doc.content, 'base64');
  if (buf.length > MAX_FILE_BYTES) return null;
  // The whole point of fetching by object id: the bytes must hash back to it.
  if (gitBlobSha(buf) !== sha) return null;
  return buf;
}

// ── Diff + repair ───────────────────────────────────────────────────────────

export interface CompletenessReport {
  origin: ManifestOrigin;
  /** Expected files that are absent from disk. */
  missing: string[];
  /** Present, but a different size than the source published. */
  mismatched: string[];
  expectedCount: number;
  presentCount: number;
}

/** Diff an expected manifest against what the installer actually wrote. */
export function diffManifest(
  manifest: SkillManifest,
  onDisk: Map<string, number>,
): CompletenessReport {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const file of manifest.files) {
    const size = onDisk.get(file.path);
    if (size === undefined) {
      missing.push(file.path);
      continue;
    }
    // Only a size the SOURCE published can contradict the file on disk. The
    // `skill-md` origin publishes none, so it can only report absence.
    if (file.size !== undefined && file.size !== size) mismatched.push(file.path);
  }
  return {
    origin: manifest.origin,
    missing: missing.sort(),
    mismatched: mismatched.sort(),
    expectedCount: manifest.files.length,
    presentCount: manifest.files.length - missing.length,
  };
}

export interface RepairResult {
  /** Files fetched, verified and written. */
  repaired: string[];
  /** Files we could not obtain — the install cannot be completed. */
  stillMissing: string[];
}

/**
 * Fetch the files the installer skipped, verify each against the object id the
 * tree published, and write them into the install directory.
 *
 * Only ever called for the `github-tree` origin: it is the only manifest that
 * carries a per-file hash, and writing a file we cannot verify into a directory
 * the agent will read from is exactly the supply-chain step this store refuses
 * to take.
 */
export async function repairFromGithub(
  repo: string,
  installDir: string,
  manifest: SkillManifest,
  missing: string[],
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<RepairResult> {
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const repaired: string[] = [];
  const stillMissing: string[] = [];
  let budget = MAX_REPAIR_BYTES;

  for (const rel of missing) {
    const file = byPath.get(rel);
    const abs = resolveInside(installDir, rel);
    if (!file?.sha || !abs || budget <= 0) {
      stillMissing.push(rel);
      continue;
    }
    const content = await fetchGithubBlob(repo, file.sha, opts);
    if (!content || content.length > budget) {
      stillMissing.push(rel);
      continue;
    }
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY, and both halves of that matter.
      //
      // resolveInside() is a lexical check — path.resolve plus a prefix test —
      // so it proves `rel` contains no '..' and nothing else about the file
      // system. It cannot see a symlink. If `abs` already exists as a link to
      // ~/.hermes/config.yaml, an ordinary write follows it and lands outside
      // the skill directory, and a dangling link reads as "missing" to the
      // completeness scan that produced this list in the first place. O_EXCL
      // refuses to follow a final symlink and refuses an existing file, which
      // is precisely the contract here: repair only ever creates files the
      // installer failed to write, so a target that already exists means the
      // premise is wrong and the safe answer is to write nothing.
      //
      // Support files are data the agent reads, never something it executes
      // directly, so 0644 regardless of the upstream mode bit.
      handle = await fs.open(abs, 'wx', 0o644);
      await handle.writeFile(content);
      budget -= content.length;
      repaired.push(rel);
    } catch {
      stillMissing.push(rel);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { repaired, stillMissing };
}
