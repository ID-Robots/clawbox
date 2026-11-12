/**
 * What may leave the box in a report about its own errors.
 *
 * A report about a crash or an error in ClawBox's own code may be read by
 * somebody other than the owner, so the
 * rule here is not "scrub what looks secret" but "everything that reaches the
 * wire has been through this function". It is pure and has no I/O precisely so
 * it can be tested exhaustively and called from anywhere without a device.
 *
 * WHAT IS REMOVED, and why each class is here rather than trusted to be absent:
 *
 *   - CREDENTIALS BY SHAPE. `claw_…` (ClawBox AI), `sk-…` (OpenAI and every
 *     provider that copied the prefix), `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and
 *     `github_pat_…` (GitHub), `xox?-…` (Slack), `AKIA…`/`ASIA…` (AWS access
 *     key ids), and the value after `Bearer`/`token`/`Authorization`.
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
 *  only: a trailing quote or bracket must survive so the sentence still reads.
 *
 *  The two PROVIDER-KEY bodies also take `*`, because the commonest way one of
 *  them reaches a person is a provider echoing the key it refused with the
 *  middle masked — verbatim from OpenAI on a box: "Incorrect API key provided:
 *  claw_08d*************************765e". A masked key is still a key
 *  fragment: it names the account and, with one un-masked pair of ends, the
 *  credential. Without the star the run of asterisks broke the match and the
 *  whole string survived. */
const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9_]{10,}/g,
  /\bclaw_[A-Za-z0-9._~+*/-]{8,}=*/g,
  /\bsk-[A-Za-z0-9._~+*/-]{8,}=*/g,
  // `xoxe-` is the rotating refresh token Slack hands out beside the others.
  /\bxox[abeprs]-[A-Za-z0-9-]{8,}/g,
  // An AWS access key id: a fixed four-letter prefix and sixteen capitals or
  // digits. Long-term (`AKIA`) and temporary (`ASIA`) alike.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // A JWT: three dot-separated base64url runs. Shows up whole in HTTP errors.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

/**
 * `Bearer <value>` on its own, because that is the shape an HTTP error prints.
 * The keyword stays and the value goes: which header failed is the diagnosis.
 *
 * A backtick ends the value as a quote does: in Markdown — a pull request's
 * body (src/lib/publish-redaction.ts) — the value is often inline code, and
 * taking its closing backtick with it left the rest of the text in code.
 */
const BEARER_RE = /\bBearer\s+([^\s"'`&,;)\]}]{6,})/gi;

/**
 * `key: value` / `key=value` for the names a credential travels under. A
 * SEPARATOR is required, unlike Bearer above: without one, `\btoken\b\s+\S+`
 * redacted the second half of this box's own "Stopped at the token limit".
 */
const SECRET_KEYWORD_RE =
  /\b(token|authorization|api[_-]?key|apikey|password|passwd|secret|access_token|refresh_token|client_secret)\b\s*[:=]\s*(["']?)([^\s"'`&,;)\]}]{6,})\2/gi;

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

/**
 * A quoted value after a credential name and its separator, on one line. The
 * name is bare or quoted (`token`, `"token"`, `'apiKey'`, `\"token\"`), and the
 * value is in `"`, `'`, `\"` or `\'`. The value runs to the quote that opened
 * it, a backslash escaping the character after it, or to the end of its line.
 * A value that opens with an escaped quote also ends at a bare quote of the
 * same kind: that is the end of the string it is escaped in. Groups: 1 the name
 * with its quotes and separator, 2 the backslash of an escaped opening quote,
 * 3 the quote, 4 the value, 5 the closing quote (empty at the end of a line or
 * before a bare quote).
 *
 * Each character of a value is taken by exactly one branch, and a value always
 * ends where one of the closing branches matches, so a match never backtracks
 * into it. Exported for the publishing rules and the MCP gate, which pass
 * their own names.
 */
export function quotedCredentialValueRule(names: string): RegExp {
  return new RegExp(
    String.raw`((?:\\?["'])?(?:${names})(?:\\?["'])?[^\S\r\n]*[:=][^\S\r\n]*)(\\?)(["'])((?:(?!\2\3|\3)(?:\\[^\r\n]|\\(?=[\r\n]|$)|[^\\\r\n]))*)(\2\3|(?=\3|[\r\n]|$))`,
    "gi",
  );
}

/** A value that only names a secret held elsewhere: `${DB_PASSWORD}`,
 *  `${{ secrets.GITHUB_TOKEN }}`, `{{ .Values.apiToken }}`, `$TOKEN`, `%TOKEN%`. */
export function isSecretReference(value: string): boolean {
  return /^(?:\$?\{\{[^{}]*\}\}|\$\{[^{}]*\}|\$\w+|%\w+%)$/.test(value);
}

/** The names SECRET_KEYWORD_RE knows. */
export const SECRET_KEYWORD_NAMES =
  "token|authorization|api[_-]?key|apikey|password|passwd|secret|access_token|refresh_token|client_secret";

const QUOTED_SECRET_RE = quotedCredentialValueRule(String.raw`\b(?:${SECRET_KEYWORD_NAMES})\b`);

/**
 * The quoted value under a credential name, replaced through its closing
 * quote: `{"password": "correct horse battery staple"}` becomes
 * `{"password": "[redacted]"}`. The keyword rule stops a value at its first
 * space or quote and matches no quoted name, so such a value got through it.
 *
 * A caller runs it LAST, on the text it is about to hand on: after every other
 * rule, and after any cut, cap or check of its own. It only puts the
 * replacement in place of a value, so nothing taken out before it comes back;
 * a rule, cut or check that ran after it could see text it changed, so none
 * does. The name keeps its quotes and separator, except a bare name under
 * another replacement than the placeholder: that is written as the keyword
 * rule writes it (`token=<…>`, or nothing with the empty replacement), so a
 * second pass leaves it as it is. A value under 6 characters, a placeholder
 * (after `Bearer` or `Basic` too) and a reference stay as they are.
 */
export function redactQuotedCredentialValues(input: string, replacement: string = REDACTED): string {
  if (typeof input !== "string" || input === "") return "";
  return input.replace(QUOTED_SECRET_RE, (m, key: string, esc: string, quote: string, value: string, close: string) => {
    const rest = value.replace(/^(?:bearer|basic)\s+/i, "");
    if (value.length < 6 || rest === replacement || isPlaceholder(rest) || isSecretReference(value)) return m;
    const masked = `${esc}${quote}${replacement}${close}`;
    if (replacement === REDACTED || /["'][^\S\r\n]*[:=][^\S\r\n]*$/.test(key)) return `${key}${masked}`;
    return replacement ? `${key.replace(/[^\S\r\n]*[:=][^\S\r\n]*$/, "=")}${masked}` : "";
  });
}

/**
 * Every credential SHAPE this module knows, taken out of one string.
 *
 * Exported because it is the repo's inventory of "what may not reach a person",
 * and a second copy of it is how a shape added here stops reaching one of the
 * paths that needs it. `src/lib/chat-error-text.ts` is the other caller: the
 * provider's own sentence goes through it before a chat bubble is offered the
 * text. That caller passes an EMPTY replacement, because its sentence has to
 * still read as a sentence afterwards — "[redacted]" mid-clause is noise to a
 * customer — where a written report wants the placeholder so a
 * reader can see something was taken out.
 *
 * Named rules first and shapes second, for the reason in `sanitizeText`'s own
 * step 2: `Authorization: Bearer <jwt>` redacted by shape first leaves the
 * keyword rule matching the placeholder and a stray bracket behind.
 */
export function redactCredentialShapes(input: string, replacement: string = REDACTED): string {
  if (typeof input !== "string" || input === "") return "";
  let out = input;
  out = out.replace(BEARER_RE, (m, value: string) =>
    isPlaceholder(value) ? m : replacement ? `Bearer ${replacement}` : "");
  out = out.replace(SECRET_KEYWORD_RE, (m, keyword: string, quote: string, value: string) =>
    isPlaceholder(value) || /^bearer$/i.test(value)
      ? m
      : replacement ? `${keyword}=${quote}${replacement}${quote}` : "");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface SanitizeOptions {
  /**
   * Values this box holds as secrets — API keys, tokens, passwords — taken
   * from the config store by the caller. Redacted LITERALLY and first, which
   * is the only rule that covers a credential shape no pattern here knows.
   * Short values are ignored (see MIN_SECRET_CHARS).
   */
  secrets?: string[];
  /** Hard cap on the result. Applied after every rule but the quoted-value
   *  pass, which only replaces text inside what the cap kept. */
  maxChars?: number;
  /** `false` leaves the quoted-value pass out, for a caller that cuts or joins
   *  the result and runs the pass itself, last. */
  quotedValues?: boolean;
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

  // 2. Credential shapes — the shared inventory, so the chat's own pre-scrub
  //    and this one cannot know different lists.
  out = redactCredentialShapes(out);

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
  const capped = out.length > max ? `${out.slice(0, max)}…` : out;

  // 7. Quoted values under a credential name, last, on what the cap kept.
  return options.quotedValues === false ? capped : quotedValuesWithin(capped, max);
}

/** The quoted-value pass on a text a cap of `max` has already cut, so text the
 *  cap cut off stays cut off. It runs on each line without the "…" a cut left
 *  at its end, so a value read to the end of its line never takes that mark
 *  with it; it cuts again, with the mark, only where a placeholder came out
 *  longer than the value it replaced. */
function quotedValuesWithin(capped: string, max: number): string {
  const masked = capped
    .split("\n")
    .map((line) => (line.endsWith("…") ? `${redactQuotedCredentialValues(line.slice(0, -1))}…` : redactQuotedCredentialValues(line)))
    .join("\n");
  return masked.length > max && masked.length > capped.length ? `${masked.slice(0, max)}…` : masked;
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
  // The quoted-value pass runs once, after the cap over the joined lines.
  const text = kept.map((l) => sanitizeText(l, { ...options, maxChars: 400, quotedValues: false })).join("\n");
  const max = options.maxChars ?? 4_000;
  const capped = text.length > max ? `${text.slice(0, max)}…` : text;
  return options.quotedValues === false ? capped : quotedValuesWithin(capped, max);
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
