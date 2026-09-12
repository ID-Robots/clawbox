/**
 * What may leave the box in an Improvement Program report.
 *
 * The ClawBox Improvement Program files a GitHub issue about a crash or an
 * error in ClawBox's own code. A GitHub issue is PUBLIC and permanent, so the
 * rule here is not "scrub what looks secret" but "everything that reaches the
 * wire has been through this function". It is pure and has no I/O precisely so
 * it can be tested exhaustively and called from anywhere without a device.
 *
 * WHAT IS REMOVED, and why each class is here rather than trusted to be absent:
 *
 *   - CREDENTIALS BY SHAPE. `claw_…` (ClawBox AI), `sk-…` (OpenAI and every
 *     provider that copied the prefix), `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and
 *     `github_pat_…` (GitHub), and the value after `Bearer`/`token`/`Authorization`.
 *     An error message quoting the request that failed is the ordinary way a
 *     token ends up in a stack trace.
 *   - EMAIL ADDRESSES. The mail feature's errors name the mailbox, and the
 *     owner's address is the one identifier that is theirs rather than the box's.
 *   - IP ADDRESSES, v4 and v6. A LAN address says where the box is on somebody's
 *     network; a public one says who their ISP is. Loopback is kept, because
 *     `127.0.0.1:18789` is the gateway and removing it removes the diagnosis.
 *   - HOSTNAMES that are not localhost. The box's own mDNS name is usually the
 *     owner's name, and a host in an error is either theirs or a service they
 *     use. A short allow-list of ClawBox's own infrastructure survives, because
 *     "could not reach clawbox.com" is the fact being reported.
 *   - HOME PATHS. `/home/<user>/…` becomes `~/…`: the shape of the path is the
 *     diagnosis, the account name is the owner.
 *   - QUERY STRINGS. A URL's path is a route; its query is where a one-time
 *     code, a token or a search term lives.
 *   - ANY VALUE THE BOX HOLDS AS A SECRET. The caller passes the config's own
 *     secret values in; a literal match beats every pattern above, and it is
 *     the only defence against a credential shape nobody has thought of.
 *
 * WHAT IS NOT SENT AT ALL — and this is the store's rule, not the sanitizer's:
 * no transcripts, no prompts, no file contents, no environment dumps. The
 * sanitizer cleans the short message, the stack and a small fixed context; it
 * is not a filter that makes arbitrary text safe to publish.
 *
 * ORDER MATTERS. Email before hostname (an address contains a host), home path
 * before hostname (a path segment can look like one), and the caller's literal
 * secrets FIRST, because a secret whose shape we do not know must not be
 * partially rewritten by a later rule into something that no longer matches it.
 */

/** The placeholder every rule leaves behind. One word, so a reader of the issue
 *  can see at a glance that something was taken out and roughly what. */
export const REDACTED = "[redacted]";

/**
 * Hosts that survive redaction: ClawBox's own infrastructure and the loopback
 * names. "Could not reach clawbox.com" and "api.github.com refused" are the
 * report; rewriting them leaves an issue nobody can act on.
 */
const HOST_ALLOW = new Set([
  "localhost",
  "localhost.localdomain",
  "clawbox.com",
  "www.clawbox.com",
  "clawhub.ai",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "huggingface.co",
]);

/** A secret shorter than this is a word, not a credential: matching it
 *  literally would redact ordinary English out of every message. */
const MIN_SECRET_CHARS = 8;

/** Credential shapes, longest-prefix first so `github_pat_` is not eaten by a
 *  shorter rule. The bodies are deliberately greedy over the token alphabet
 *  only: a trailing quote or bracket must survive so the sentence still reads. */
const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9_]{10,}/g,
  /\bclaw_[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bsk-[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  // A JWT: three dot-separated base64url runs. Shows up whole in HTTP errors.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

/**
 * `Bearer <value>` on its own, because that is the shape an HTTP error prints.
 * The keyword stays and the value goes: which header failed is the diagnosis.
 */
const BEARER_RE = /\bBearer\s+([^\s"'&,;)\]}]{6,})/gi;

/**
 * `key: value` / `key=value` for the names a credential travels under. A
 * SEPARATOR is required, unlike Bearer above: without one, `\btoken\b\s+\S+`
 * redacted the second half of this box's own "Stopped at the token limit".
 */
const SECRET_KEYWORD_RE =
  /\b(token|authorization|api[_-]?key|apikey|password|passwd|secret|access_token|refresh_token|client_secret)\b\s*[:=]\s*(["']?)([^\s"'&,;)\]}]{6,})\2/gi;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * A LOOSE candidate for IPv6, validated in the replacer by `isIpv6`.
 *
 * A pattern tight enough to be trusted on its own is unreadable, and one loose
 * enough to read matched `10:30:45` out of every timestamp — which is how a
 * redaction rule starts destroying the diagnosis it was added to protect. So
 * the regex finds candidates and a function decides.
 */
const IPV6_CANDIDATE_RE = /(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}/g;

/** `/home/<user>` and `/Users/<user>` — the account name, not the layout. */
const HOME_RE = /\/(?:home|Users)\/[^/\s:'"]+/g;

/** A query string on a URL, or on a bare path. The `?` stays so the shape of
 *  the failing request is still legible. */
const QUERY_RE = /\?[^\s"'<>)\]}]+/g;

/**
 * A hostname in running text: dot-separated labels with a letter TLD. Matched
 * AFTER emails and IPs, so neither reaches this rule.
 */
const HOST_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,24})\b/g;

/**
 * The TLDs a dotted token must END IN before it is treated as a host.
 *
 * An allow-list rather than "any letters", because the input this runs on is
 * mostly STACK TRACES, where every frame ends in `coding-agent.ts:4954` and
 * `.ts`, `.js`, `.json`, `.sh` are not places. Redacting those leaves an issue
 * with no frames in it, which is worse than useless.
 *
 * The trade it makes: a host under a TLD nobody listed survives. That is the
 * right direction for a device whose own names are `*.local` and whose errors
 * name public services — and the literal-secret pass and the shape patterns
 * above are what cover a credential, which is the fact worth protecting.
 *
 * `.sh`, `.md`, `.pl`, `.rs`, `.py`, `.ts`, `.js` and `.io` are deliberately
 * ABSENT though they are real TLDs: on this box every one of them is a file
 * extension far more often than a host, and `clawbox-tts.sh` must stay legible.
 */
const HOST_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name",
  "dev", "app", "cloud", "tech", "online", "site", "store", "xyz", "co",
  "local", "lan", "internal", "localdomain", "home", "arpa",
  "ai", "gg", "tv", "cc", "me", "us", "uk", "de", "fr", "nl", "se", "no",
  "fi", "dk", "pl", "cz", "at", "ch", "be", "es", "it", "pt", "gr", "hu",
  "ro", "bg", "ru", "ua", "tr", "jp", "cn", "kr", "in", "au", "nz", "ca",
  "br", "mx", "ar", "za", "il", "ie", "eu",
]);

/** True for a loopback literal, which is kept: it is the gateway, not a place. */
function isLoopback(ip: string): boolean {
  if (ip === "::1" || ip === "::" || ip === "0.0.0.0") return true;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 127;
}

/**
 * Whether a candidate really is an IPv6 address.
 *
 * The two legal shapes, and nothing else: eight hex groups, or one `::` with
 * at most seven groups around it. `10:30:45` has three groups and no `::`, so
 * a clock survives; `aa:bb:cc:dd:ee:ff` likewise stays a MAC rather than
 * becoming a hole in the sentence.
 */
function isIpv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:]+$/.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const group = /^[0-9A-Fa-f]{1,4}$/;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    if (![...left, ...right].every((g) => group.test(g))) return false;
    return left.length + right.length <= 7;
  }
  const groups = value.split(":");
  return groups.length === 8 && groups.every((g) => group.test(g));
}

/**
 * Whether a dotted token is a HOSTNAME rather than a version (`2026.8.1`) or a
 * filename (`coding-agent.ts`). See HOST_TLDS for the trade this makes.
 */
function looksLikeHost(value: string): boolean {
  const labels = value.split(".");
  if (labels.length < 2) return false;
  if (labels.every((l) => /^\d+$/.test(l))) return false;
  return HOST_TLDS.has(labels[labels.length - 1]);
}

/** True for a capture that is the placeholder, whole or clipped by a character
 *  class that stops at `]`. Both forms occur once a rule has already run. */
function isPlaceholder(value: string): boolean {
  return value === REDACTED || REDACTED.startsWith(value);
}

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SanitizeOptions {
  /**
   * Values this box holds as secrets — API keys, tokens, passwords — taken
   * from the config store by the caller. Redacted LITERALLY and first, which
   * is the only rule that covers a credential shape no pattern here knows.
   * Short values are ignored (see MIN_SECRET_CHARS).
   */
  secrets?: string[];
  /** Hard cap on the result. Applied last, so nothing is cut mid-redaction. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 2_000;

/**
 * Put one string through every rule. Safe on any input, including the empty
 * string; never throws.
 */
export function sanitizeText(input: string, options: SanitizeOptions = {}): string {
  if (typeof input !== "string" || input === "") return "";
  let out = input;

  // 1. The box's own secrets, literally. First, for the reason in the header.
  for (const secret of options.secrets ?? []) {
    if (typeof secret !== "string") continue;
    const trimmed = secret.trim();
    if (trimmed.length < MIN_SECRET_CHARS) continue;
    out = out.replace(new RegExp(escapeLiteral(trimmed), "g"), REDACTED);
  }

  // 2. Credential shapes. The KEYWORD rules run FIRST and the shape patterns
  //    after: `Authorization: Bearer <jwt>` redacted by shape first left the
  //    keyword rule matching the placeholder itself and a stray bracket behind
  //    ("Bearer [redacted]]"). Named-first, shapes-second has no such overlap.
  out = out.replace(BEARER_RE, (m, value: string) => (isPlaceholder(value) ? m : `Bearer ${REDACTED}`));
  out = out.replace(SECRET_KEYWORD_RE, (m, keyword: string, quote: string, value: string) =>
    // Already redacted, or the value IS the scheme name and the token after it
    // has gone: leave the line alone rather than stack one placeholder on another.
    isPlaceholder(value) || /^bearer$/i.test(value) ? m : `${keyword}=${quote}${REDACTED}${quote}`);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);

  // 3. Identities and addresses. Email first: it contains a host.
  out = out.replace(EMAIL_RE, REDACTED);
  out = out.replace(IPV6_CANDIDATE_RE, (m) => (isIpv6(m) && !isLoopback(m) ? REDACTED : m));
  out = out.replace(IPV4_RE, (m) => (isLoopback(m) ? m : REDACTED));

  // 4. Home paths, before hostnames: `/home/ada.local/x` must lose the account
  //    name as a path segment rather than be half-rewritten as a host.
  out = out.replace(HOME_RE, "~");

  // 5. Query strings, before hostnames, so a host inside a query is not the
  //    thing that survives.
  out = out.replace(QUERY_RE, "?" + REDACTED);

  // 6. Hostnames that are neither localhost nor ClawBox's own infrastructure.
  out = out.replace(HOST_RE, (m) => {
    const lower = m.toLowerCase();
    if (!looksLikeHost(lower)) return m;
    // A `.local` name is the box itself — named, on most boxes, after its owner.
    return HOST_ALLOW.has(lower) ? m : REDACTED;
  });

  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** How many stack frames a report may carry. Twelve is enough to see where a
 *  throw came from and short enough that the issue stays readable. */
export const MAX_STACK_FRAMES = 12;

/**
 * A stack trace, trimmed to MAX_STACK_FRAMES and sanitized line by line.
 *
 * The first line of a V8 stack is the message, not a frame; it is kept and
 * counted separately, because a stack whose message was dropped reads as a
 * crash in an anonymous function.
 */
export function sanitizeStack(stack: string | undefined | null, options: SanitizeOptions = {}): string | null {
  if (typeof stack !== "string" || !stack.trim()) return null;
  const lines = stack.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  const isFrame = (l: string) => /^\s*at\s/.test(l);
  const head = isFrame(lines[0]) ? [] : [lines[0]];
  const frames = lines.slice(head.length).filter(isFrame).slice(0, MAX_STACK_FRAMES);
  const kept = [...head, ...frames];
  if (!kept.length) return null;
  // Per line, so the cap applies to the whole trace rather than to each frame.
  const text = kept.map((l) => sanitizeText(l, { ...options, maxChars: 400 })).join("\n");
  const max = options.maxChars ?? 4_000;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** How many context entries a report may carry, and how long each may be. */
const MAX_CONTEXT_KEYS = 12;
const MAX_CONTEXT_VALUE_CHARS = 200;

/**
 * The small fixed context a caller attaches — a step id, an exit code, a run
 * status. Strings, numbers and booleans only: an object or an array here is
 * how a transcript or a file's contents would get in, so they are dropped
 * rather than stringified. Keys are held to an identifier shape for the same
 * reason.
 */
export function sanitizeContext(
  context: Record<string, unknown> | undefined,
  options: SanitizeOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!context || typeof context !== "object") return out;
  for (const [key, value] of Object.entries(context)) {
    if (Object.keys(out).length >= MAX_CONTEXT_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = typeof value === "string" ? value : String(value);
    out[key] = sanitizeText(text, { ...options, maxChars: MAX_CONTEXT_VALUE_CHARS });
  }
  return out;
}

/**
 * The message as the FINGERPRINT sees it: sanitized, then stripped of the
 * numbers and quoted fragments that differ between two occurrences of one
 * fault. Without this, "Stopped after 31 steps" and "Stopped after 47 steps"
 * are two issues.
 */
export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/["'`][^"'`]*["'`]/g, "'…'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
