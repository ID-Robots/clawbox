import fs from "fs";
import path from "@/lib/runtime-path";
import { LARGE_FILE_BYTES, type LeftOutFile } from "@/lib/project-backup-shared";

// ── What never leaves the box in a project backup (TASK-1358) ──────────────
//
// The owner this feature is for has never typed a git command, so nothing
// here may rely on them knowing what a `.gitignore` is or that a `.env` holds
// passwords. Two fences, both applied on every backup:
//
//   1. a safe `.gitignore`, MERGED into the folder's own (only missing lines
//      are appended; the owner's lines are never touched, reordered or
//      removed), so the usual suspects never show up as changes at all;
//   2. a check of every file the next commit would carry — by name, by a
//      cheap look at the first part of its content for token prefixes and
//      private-key headers, and by size. What it flags is left out of the
//      commit and listed to the owner. A rule in a `.gitignore` can be
//      undone by a later `!pattern`; this check cannot.
//
// Plus the two small pure helpers the backup needs and the tests pin: a
// repository name GitHub accepts, and a remote's address with any password
// taken out of it.

/** First line of the block this box appends to a `.gitignore`. */
export const SAFE_GITIGNORE_HEADER = "# Added by ClawBox backup: keeps passwords, keys and very large files off GitHub.";

/** Says, in the file itself, how the size rule (which a `.gitignore` cannot express) is kept. */
const SIZE_NOTE = "# Files over 50 MB (model weights such as *.bin too) are left out by ClawBox's check before every backup.";

export const SAFE_GITIGNORE_PATTERNS: readonly string[] = [
  // Passwords, keys and certificates.
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "credentials*",
  "secrets*",
  ".netrc",
  ".git-credentials",
  // Things a project re-creates by itself.
  "node_modules/",
  ".venv/",
  "__pycache__/",
  "dist/",
  ".next/",
  "build/",
  "*.log",
  // Operating-system junk.
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".Trash-*/",
  // Model weights.
  "*.gguf",
  "*.safetensors",
  "*.onnx",
];

/**
 * The folder's `.gitignore` with every safe pattern it lacks appended under
 * one header. `existing` is the file's text, or null when there is none.
 * Only lines are ever ADDED: an owner's `!keep-this.key` stays exactly where
 * it was (and the check before the commit still has the last word on it).
 */
export function mergeGitignore(existing: string | null): { text: string; added: string[] } {
  const base = existing ?? "";
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const present = new Set(
    base.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")),
  );
  const added = SAFE_GITIGNORE_PATTERNS.filter((p) => !present.has(p));
  if (added.length === 0) return { text: base, added };
  const block: string[] = [];
  if (!base.includes(SAFE_GITIGNORE_HEADER)) block.push(SAFE_GITIGNORE_HEADER, SIZE_NOTE);
  block.push(...added);
  let head = base;
  if (head && !head.endsWith("\n")) head += eol;
  if (head.trim()) head += eol;
  return { text: `${head}${block.join(eol)}${eol}`, added };
}

// ── The check before every commit ────────────────────────────────────────────

/** Names (any segment of the path) that hold passwords or keys. Mirrors the secret half of the `.gitignore`. */
const SECRET_NAME_RULES: readonly RegExp[] = [
  /^\.env/,
  /\.(pem|key|p12|pfx)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^credentials/,
  /^secrets/,
  /^\.netrc$/,
  /^\.git-credentials$/,
];

/** True when some folder or the file name on `rel` looks like a password or key store. */
export function looksLikeSecretName(rel: string): boolean {
  return rel
    .split("/")
    .filter(Boolean)
    .some((segment) => {
      const name = segment.toLowerCase();
      return SECRET_NAME_RULES.some((rule) => rule.test(name));
    });
}

/**
 * Token shapes worth stopping a backup for. Each needs a real body after the
 * prefix, so prose ("ask the desk-top team", "sk-learn") does not trip it.
 */
const SECRET_CONTENT_RULES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic-style API keys (sk-…, sk-ant-…, sk-proj-…)
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, // PEM / OpenSSH / PGP private keys
];

/** True when `text` carries something shaped like a token or a private key. */
export function looksLikeSecretContent(text: string): boolean {
  return SECRET_CONTENT_RULES.some((rule) => rule.test(text));
}

/** How much of each file the content check reads. Cheap by design: tokens sit near the top of the files that hold them. */
export const CONTENT_SCAN_BYTES = 2 * 1024 * 1024;

function readHead(abs: string, bytes: number): string {
  const fd = fs.openSync(/* turbopackIgnore: true */ abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("latin1");
  } finally {
    fs.closeSync(fd);
  }
}

export interface PreflightEntry {
  /** Relative to the project folder; a trailing `/` is a folder git lists as one entry (a nested repository). */
  path: string;
  /** A deletion carries no content to check. */
  deleted?: boolean;
}

export interface PreflightResult {
  /** What may go into the commit. */
  safe: string[];
  leftOut: LeftOutFile[];
}

/**
 * Sort what the next commit would carry into what may go and what stays.
 * `dir` is the project folder; every path is relative to it. Never throws: a
 * file that cannot be read is judged by its name and size alone, and one that
 * cannot even be stat'ed has gone since git listed it, which `git add` will
 * record as the deletion it now is.
 */
export function preflight(dir: string, entries: readonly PreflightEntry[]): PreflightResult {
  const safe: string[] = [];
  const leftOut: LeftOutFile[] = [];
  for (const entry of entries) {
    const rel = entry.path;
    if (entry.deleted) {
      safe.push(rel);
      continue;
    }
    if (rel.endsWith("/")) {
      leftOut.push({ path: rel.replace(/\/+$/, ""), reason: "nested_git" });
      continue;
    }
    if (looksLikeSecretName(rel)) {
      leftOut.push({ path: rel, reason: "secret_name" });
      continue;
    }
    const abs = path.join(dir, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(/* turbopackIgnore: true */ abs);
    } catch {
      safe.push(rel);
      continue;
    }
    // A link is committed as the path it points at, never the target's bytes.
    if (stat.isSymbolicLink() || !stat.isFile()) {
      safe.push(rel);
      continue;
    }
    if (stat.size > LARGE_FILE_BYTES) {
      leftOut.push({ path: rel, reason: "too_large" });
      continue;
    }
    let head = "";
    try {
      head = readHead(abs, Math.min(stat.size, CONTENT_SCAN_BYTES));
    } catch { /* unreadable: judged by name and size above */ }
    if (head && looksLikeSecretContent(head)) {
      leftOut.push({ path: rel, reason: "secret_content" });
      continue;
    }
    safe.push(rel);
  }
  return { safe, leftOut };
}

// ── Names on GitHub ──────────────────────────────────────────────────────────

/** GitHub's own limit is 100; this leaves room for a "-20". */
const REPO_NAME_MAX = 90;
/** How far "-2", "-3"… goes before the owner is asked to choose a name. */
export const REPO_NAME_TRIES = 20;
export const FALLBACK_REPO_NAME = "clawbox-project";

/**
 * A repository name GitHub accepts, from a folder name or what the owner
 * typed: accents folded ("Café" → "Cafe"), anything outside `A-Za-z0-9._-`
 * turned into one dash, no leading or trailing dash or dot, no `.git` ending.
 * A name with nothing usable left (all Cyrillic, all symbols) becomes
 * `clawbox-project`.
 */
export function sanitizeRepoName(input: string): string {
  const folded = String(input).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let name = folded
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  name = name.replace(/\.git$/i, "").replace(/[-.]+$/g, "");
  name = name.slice(0, REPO_NAME_MAX).replace(/[-.]+$/g, "");
  return name || FALLBACK_REPO_NAME;
}

/** `name`, `name-2`, `name-3` … `name-20`. */
export function repoNameCandidates(base: string, tries = REPO_NAME_TRIES): string[] {
  const out = [base];
  for (let i = 2; i <= tries; i++) out.push(`${base}-${i}`);
  return out;
}

export type FreeName =
  | { ok: true; name: string; taken: string | null }
  | { ok: false; reason: "unreachable" | "exhausted" };

/**
 * The first candidate GitHub does not already have. `exists` answers true,
 * false, or null when it could not tell — and a null stops the search: a
 * guess here would mean pushing into somebody's existing repository.
 * `taken` is the base name, when it was the one that clashed.
 */
export async function firstFreeRepoName(
  base: string,
  exists: (name: string) => Promise<boolean | null>,
  tries = REPO_NAME_TRIES,
): Promise<FreeName> {
  for (const candidate of repoNameCandidates(base, tries)) {
    const answer = await exists(candidate);
    if (answer === null) return { ok: false, reason: "unreachable" };
    if (!answer) return { ok: true, name: candidate, taken: candidate === base ? null : base };
  }
  return { ok: false, reason: "exhausted" };
}

// ── Remotes, as an owner may see them ────────────────────────────────────────

/**
 * Where a remote points, for a sentence: `github.com/acme/site`. The address
 * git stores can carry a user name and a password or token
 * (`https://me:ghp_…@github.com/…`); that part never survives this. `webUrl`
 * is the page to open, for a github.com remote only.
 */
export function describeRemote(raw: string): { label: string; webUrl: string | null } {
  const url = raw.trim();
  let host = "";
  let rest = "";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      rest = decodeURIComponent(parsed.pathname);
      if (parsed.protocol === "file:") host = "";
    } catch {
      // Not parseable as a URL: drop anything up to an `@` after the scheme.
      const afterScheme = url.slice(scheme[0].length).replace(/^[^/@]*@/, "");
      const slash = afterScheme.indexOf("/");
      host = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme;
      rest = slash >= 0 ? afterScheme.slice(slash) : "";
    }
  } else {
    // scp-like `git@github.com:acme/site.git`, or a path on this box.
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.*)$/.exec(url);
    if (scp) {
      host = scp[1];
      rest = scp[2];
    } else {
      rest = url;
    }
  }
  const tail = rest.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const label = host ? (tail ? `${host}/${tail}` : host) : tail || url.replace(/^[^@]*@/, "");
  const gh = host.toLowerCase() === "github.com" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(tail);
  return { label, webUrl: gh ? `https://github.com/${tail}` : null };
}

/**
 * Text from git or gh made safe to show and to log: a password in an address
 * (`https://user:secret@host`) loses everything before the `@`, and anything
 * shaped like a token is blanked. Git usually redacts the first already; it
 * does not promise to on every path, and this text reaches the owner's screen.
 */
export function scrubSecrets(text: string): string {
  let out = String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1");
  for (const rule of SECRET_CONTENT_RULES) {
    out = out.replace(new RegExp(rule.source, "g"), "[hidden]");
  }
  return out;
}
