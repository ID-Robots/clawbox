/**
 * Where Prime Radiant keeps its files, and the one gate every page path a
 * caller hands in goes through.
 *
 *   <root>/vault/                 the git-backed wiki vault (memory-wiki, isolated mode)
 *   <root>/prime-radiant.sqlite   state: review queue, runs, costs, ingest jobs, claim registry
 *
 * `<root>` is `<box data dir>/prime-radiant`, or `PRIME_RADIANT_DIR` when set
 * (tests point it at a tmp dir). Both are read at CALL time, never captured at
 * import, so a test that changes the environment in `beforeEach` is honoured.
 *
 * SERVER ONLY.
 */

import path from "@/lib/runtime-path";
import { resolveConfigRoot } from "@/lib/config-store";

export function primeRadiantRoot(): string {
  const override = process.env.PRIME_RADIANT_DIR;
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(resolveConfigRoot(), "data", "prime-radiant");
}

export function vaultDir(): string {
  return path.join(primeRadiantRoot(), "vault");
}

/** The state database sits beside the vault, never inside it (it is not versioned). */
export function stateDbPath(): string {
  return path.join(primeRadiantRoot(), "prime-radiant.sqlite");
}

/** Files and folders in the vault that are bookkeeping, not knowledge pages. */
export const RESERVED_FILES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "WIKI.md",
  "index.md",
  "inbox.md",
  "log.md",
  "log.jsonl",
  "README.md",
]);

export const RESERVED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".openclaw-wiki",
  "_views",
  "_attachments",
  "reports",
]);

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

/**
 * A caller's page path rebuilt into a safe, vault-relative POSIX path, or null.
 *
 * Accepts `entities/acme-widgets.md` (or without `.md`). Refuses absolute
 * paths, `..`, dot-files, control characters, backslashes and anything under a
 * reserved folder. Each segment is rebuilt from the allowed alphabet rather
 * than tested and passed through.
 */
export function safePagePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let raw = input.trim();
  if (raw === "" || raw.length > 512 || raw.includes("\\") || raw.includes("\0")) return null;
  if (raw.startsWith("/")) return null;
  if (!raw.toLowerCase().endsWith(".md")) raw = `${raw}.md`;
  const segments = raw.split("/");
  const rebuilt: string[] = [];
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === ".." || seg.endsWith(".")) return null;
    rebuilt.push(seg.replace(/[^A-Za-z0-9._ -]/g, ""));
  }
  if (rebuilt.length > 1 && RESERVED_DIRS.has(rebuilt[0])) return null;
  return rebuilt.join("/");
}

/** Absolute path of a page already accepted by {@link safePagePath}. */
export function pageAbsPath(vault: string, rel: string): string {
  const abs = path.resolve(vault, ...rel.split("/"));
  const back = path.relative(vault, abs);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error("page path escapes the vault");
  }
  return abs;
}

/** True when a vault-relative path is a knowledge page (not bookkeeping). */
export function isKnowledgePage(rel: string): boolean {
  if (!rel.endsWith(".md")) return false;
  const segments = rel.split("/");
  if (segments.some((s) => s.startsWith("."))) return false;
  if (segments.length > 1 && RESERVED_DIRS.has(segments[0])) return false;
  if (segments.length === 1 && RESERVED_FILES.has(segments[0])) return false;
  return true;
}
