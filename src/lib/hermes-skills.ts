// Shared types + input validators for the Hermes Skills Store. This module is
// pure (no node/fs imports) so it can be imported from BOTH the setup-api route
// handlers and the client component. All fs-based enumeration lives in the
// `installed` route itself.
//
// Every value here is eventually handed to `runHermesCli` as an argv element
// (spawn with an array, NEVER a shell), so injection is impossible — but a value
// that starts with "-" could still be misread by hermes as a FLAG, and a value
// with ".." / "/" could escape the skills tree. The validators below reject both.

export interface HermesSkill {
  /** Install identifier — pass this verbatim to `hermes skills install`. */
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** Registry source: official | skills.sh | github | clawhub | ... */
  source?: string;
  /** builtin | official | trusted | community */
  trust?: string;
  /** Computed client-side against the installed set. */
  installed?: boolean;
}

export interface InstalledHermesSkill {
  /** Skill name — the lock.json key and the `uninstall` positional argument. */
  id: string;
  name: string;
  category: string;
  description?: string;
  /** How it got here: builtin | official | clawhub | skills.sh | ... */
  source: string;
  /** Full registry identifier when known (hub-installed skills carry one). */
  identifier?: string;
  trust?: string;
  /** Installer security scan verdict (hub-installed only): safe | ... */
  scanVerdict?: string;
  enabled?: boolean;
}

// The fixed set of discovery sources Hermes' `--source` flag accepts. `all` is
// the (default) firehose; the rest narrow to one registry. Anything outside
// this set is rejected so a request can't smuggle an arbitrary value.
export const HERMES_SKILL_SOURCES = [
  "all",
  "official",
  "skills-sh",
  "well-known",
  "github",
  "clawhub",
  "lobehub",
  "browse-sh",
  "nvidia",
  "openai",
  "anthropic",
  "huggingface",
  "voltagent",
  "gstack",
  "minimax",
] as const;

const SOURCE_SET = new Set<string>(HERMES_SKILL_SOURCES);

export function isValidSource(source: string): boolean {
  return SOURCE_SET.has(source);
}

/** True when the string contains any ASCII control char (0x00-0x1f or 0x7f). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Registry identifier for `install`. Real ids contain dots
// (`browse-sh/github.com/...`), slashes, and 4+ segments
// (`skills-sh/anthropics/skills/pdf`), so the charset is deliberately wide —
// but we still reject flag-smuggling, traversal, and control chars.
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface IdCheck {
  ok: boolean;
  /**
   * Always false — direct-URL installs are disabled (see below). Kept on the
   * interface so callers that branch on it stay valid.
   */
  isUrl?: boolean;
}

/**
 * Validate an install identifier. ONLY registry identifiers (`source/skill/...`
 * from the fixed source allowlist) are accepted.
 *
 * Direct-URL installs are DELIBERATELY rejected. `hermes skills install <URL>`
 * makes the CLI fetch an arbitrary endpoint server-side — an SSRF vector
 * (hostname allow/deny lists are bypassable via DNS rebinding) and a
 * supply-chain risk (unvetted code onto the device). A customer store only
 * needs the curated registries, so URL installs have no place here.
 */
export function checkInstallIdentifier(id: string): IdCheck {
  if (typeof id !== "string") return { ok: false };
  const v = id.trim();
  if (!v || v.length > 256) return { ok: false };
  if (v.startsWith("-")) return { ok: false }; // flag injection
  // Reject anything scheme-like (http:, https:, file:, data:, //host, ...):
  // no direct-URL installs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) return { ok: false };
  if (!IDENTIFIER_RE.test(v)) return { ok: false };
  if (v.startsWith("/") || v.endsWith("/")) return { ok: false };
  if (v.includes("//")) return { ok: false }; // empty segment / traversal
  if (v.split("/").includes("..")) return { ok: false }; // path traversal
  return { ok: true, isUrl: false };
}

// Skill NAME for `uninstall` — a single lock.json key, no slashes.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSkillName(name: string): boolean {
  if (typeof name !== "string") return false;
  const v = name.trim();
  if (!v || v.length > 128) return false;
  if (v.startsWith("-")) return false;
  return NAME_RE.test(v);
}

// `--category` / `--name` override values.
const META_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function isValidMeta(value: string, maxLen = 64): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > maxLen) return false;
  if (v.startsWith("-")) return false;
  if (v.includes("..")) return false;
  return META_RE.test(v);
}

// A query is POSITIONAL (never read as a flag), but we still cap length, reject
// a leading "-" defensively, and forbid control chars. Spaces/printable text OK.
export function isValidQuery(q: string): boolean {
  if (typeof q !== "string") return false;
  const v = q.trim();
  if (!v || v.length > 128) return false;
  if (v.startsWith("-")) return false;
  return !hasControlChar(v);
}

export function clampInt(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}
