/**
 * Secret and personal-data redaction, applied to text AND to file paths
 * before anything Prime Radiant sends leaves the box — and the scan the lint's
 * `secret-pattern` rule runs over every page.
 *
 * Placeholders are deterministic (`[REDACTED:IBAN]`, …) and contain no
 * digits, so redacting twice changes nothing and a placeholder can never be
 * mistaken for the thing it replaced. The key of a `key=value` pair is kept;
 * only the value goes.
 *
 * Every numeric pattern is validated, not just matched: an IBAN must pass its
 * mod-97 check, a card number the Luhn check — and a bare 10- or 13-digit run
 * that reads as a Unix timestamp (seconds or milliseconds) is never a card,
 * since millisecond timestamps pass Luhn about one time in ten.
 *
 * Pure: no fs, no network.
 */

export const REDACTION_KINDS = [
  "PRIVATE_KEY",
  "API_KEY",
  "PASSWORD",
  "SECRET",
  "IBAN",
  "CARD",
  "EMAIL",
  "PHONE",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** The kinds that are credentials or payment data — what blocks a commit. */
export const SECRET_KINDS: ReadonlySet<RedactionKind> = new Set([
  "PRIVATE_KEY",
  "API_KEY",
  "PASSWORD",
  "SECRET",
  "IBAN",
  "CARD",
]);

export interface RedactOptions {
  /** Replace e-mail addresses. Default true. */
  maskEmails?: boolean;
  /** Replace phone numbers. Default true. */
  maskPhones?: boolean;
}

export interface RedactionResult {
  text: string;
  /** How many of each kind were replaced. */
  counts: Partial<Record<RedactionKind, number>>;
  /** The kinds replaced, in {@link REDACTION_KINDS} order. */
  kinds: RedactionKind[];
}

export function placeholder(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

const PLACEHOLDER_RE = /^\[REDACTED:[A-Z_]+\]$/;

// ── validators ────────────────────────────────────────────────────────────

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// 2000-01-01 .. 2100-01-01, in seconds.
const TS_MIN_S = 946_684_800;
const TS_MAX_S = 4_102_444_800;

/** A 10-digit run in seconds, or a 13-digit run in milliseconds, that falls in 2000–2100. */
export function looksLikeUnixTimestamp(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length === 10) {
    const n = Number(digits);
    return n >= TS_MIN_S && n < TS_MAX_S;
  }
  if (digits.length === 13) {
    const n = Number(digits);
    return n >= TS_MIN_S * 1000 && n < TS_MAX_S * 1000;
  }
  return false;
}

export function ibanValid(candidate: string): boolean {
  const iban = candidate.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const digit of chunk) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikeGeneratedSecret(value: string): boolean {
  if (value.length < 16) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  return entropy(value) >= 3.5;
}

// ── patterns ──────────────────────────────────────────────────────────────

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

const API_KEY_RE = new RegExp(
  "(?<![A-Za-z0-9_-])(?:" +
    [
      "sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}",
      "gh[pousr]_[A-Za-z0-9]{30,}",
      "github_pat_[A-Za-z0-9_]{30,}",
      "glpat-[A-Za-z0-9_-]{20,}",
      "(?:AKIA|ASIA)[0-9A-Z]{16}",
      "xox[abprs]-[A-Za-z0-9-]{10,}",
      "AIza[0-9A-Za-z_-]{35}",
      "(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
      "whsec_[A-Za-z0-9]{16,}",
      "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    ].join("|") +
    ")(?![A-Za-z0-9_-])",
  "g",
);

// `password: hunter22`, `"passwd" = 'x y z'`, `PASSWORD=...`
const PASSWORD_RE =
  /(\b(?:password|passwd|passphrase|pwd|app[ _-]?password)\b["']?\s*[:=]\s*)("[^"\n]{3,}"|'[^'\n]{3,}'|[^\s"',;]{3,})/gi;

const NOT_A_PASSWORD = new Set(["required", "optional", "none", "null", "nil", "true", "false", "unset", "empty", "changeme"]);

/**
 * An UNQUOTED value is only a password when it does not read as prose:
 * "password: rotate monthly" describes a policy, "password=hunter22" leaks one.
 * Quoted values are always taken at their word.
 */
function looksLikePassword(value: string, quoted: boolean): boolean {
  if (quoted) return true;
  if (NOT_A_PASSWORD.has(value.toLowerCase())) return false;
  if (/^[*•x.]+$/i.test(value) || /^[<{[$%].*[>}\]%]?$/.test(value)) return false;
  return /\d/.test(value) || /[^A-Za-z]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || value.length >= 12;
}

// `api_key = 9f8a…`, `"client_secret": "…"`, `X_AUTH_TOKEN=…` — only when the value looks generated.
const SECRET_KV_RE =
  /(\b[A-Za-z0-9_.-]*(?:secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|credential|private[_-]?key)[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*)("([^"\n]{16,})"|'([^'\n]{16,})'|([A-Za-z0-9+/=_~.-]{16,}))/gi;

const IBAN_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;

const CARD_RE = /(?<![\d.,-])\d(?:[ -]?\d){12,18}(?![\d])/g;

const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

const PHONE_RES: RegExp[] = [
  // International: +44 20 7946 0958, +1 (555) 010-0199, +359 88 123 4567
  /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/g,
  // North-American: (555) 010-0199, 555-010-0199, 555.010.0199
  /(?<![\w(])\(\d{3}\) ?\d{3}[-. ]\d{4}(?![\w])/g,
  /(?<![\w.-])\d{3}[-.]\d{3}[-.]\d{4}(?![\w.-])/g,
];

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

// ── the pass ──────────────────────────────────────────────────────────────

/** Redact one piece of text. */
export function redactText(input: string, options: RedactOptions = {}): RedactionResult {
  const maskEmails = options.maskEmails ?? true;
  const maskPhones = options.maskPhones ?? true;
  const counts: Partial<Record<RedactionKind, number>> = {};
  const bump = (kind: RedactionKind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  let text = input;

  text = text.replace(PRIVATE_KEY_RE, () => {
    bump("PRIVATE_KEY");
    return placeholder("PRIVATE_KEY");
  });
  text = text.replace(API_KEY_RE, () => {
    bump("API_KEY");
    return placeholder("API_KEY");
  });
  text = text.replace(PASSWORD_RE, (whole, key: string, value: string) => {
    const quoted = /^["']/.test(value);
    const bare = value.replace(/^["']|["']$/g, "");
    if (PLACEHOLDER_RE.test(bare) || !looksLikePassword(bare, quoted)) return whole;
    bump("PASSWORD");
    return key + placeholder("PASSWORD");
  });
  text = text.replace(
    SECRET_KV_RE,
    (whole, key: string, _value: string, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      const value = dq ?? sq ?? bare ?? "";
      if (PLACEHOLDER_RE.test(value) || !looksLikeGeneratedSecret(value)) return whole;
      bump("SECRET");
      return key + placeholder("SECRET");
    },
  );
  text = text.replace(IBAN_RE, (m: string) => {
    if (!ibanValid(m)) return m;
    bump("IBAN");
    return placeholder("IBAN");
  });
  text = text.replace(CARD_RE, (m: string) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return m;
    if (digits === m && looksLikeUnixTimestamp(digits)) return m;
    if (/^(\d)\1+$/.test(digits) || !luhnValid(digits)) return m;
    bump("CARD");
    return placeholder("CARD");
  });
  if (maskEmails) {
    text = text.replace(EMAIL_RE, () => {
      bump("EMAIL");
      return placeholder("EMAIL");
    });
  }
  if (maskPhones) {
    for (const re of PHONE_RES) {
      text = text.replace(re, (m: string) => {
        const n = digitCount(m);
        if (n < 8 || n > 15) return m;
        bump("PHONE");
        return placeholder("PHONE");
      });
    }
  }

  const kinds = REDACTION_KINDS.filter((k) => counts[k]);
  return { text, counts, kinds };
}

/** The kinds present in `text` (secret kinds only unless PII is asked for). */
export function scanSecrets(text: string, options: { includePii?: boolean } = {}): RedactionKind[] {
  const { kinds } = redactText(text, { maskEmails: !!options.includePii, maskPhones: !!options.includePii });
  return options.includePii ? kinds : kinds.filter((k) => SECRET_KINDS.has(k));
}

export interface RedactPathOptions extends RedactOptions {
  /** The home directory to fold to `~` (besides any `/home/<name>` or `/Users/<name>`). */
  homeDir?: string;
}

/**
 * Phone shapes as they appear in a FILE NAME. The prose patterns refuse a
 * number glued to a word (`v555-123-4567` is not a phone in a sentence), but
 * a name joins its parts with `_`, `-` and `.` — `555-123-4567-report.md`,
 * `call_+1 555 010 0199.txt`, and `call_555_010_0199.md` once an upload's
 * name is rebuilt — so here `_` is a separator too and only another digit
 * is a boundary.
 * A bare digit run stays: in a name it is far more often a timestamp or an
 * invoice number than a phone.
 */
const FILENAME_PHONE_RES: RegExp[] = [
  /(?<![\d+])\+\d{1,3}(?:[ ._-]?\(?\d{1,4}\)?){2,5}(?!\d)/g,
  /(?<!\d)\(\d{3}\)[ _]?\d{3}[-. _]\d{4}(?!\d)/g,
  /(?<!\d)\d{3}[-. _]\d{3}[-. _]\d{4}(?!\d)/g,
];

/**
 * One path segment: the phone shapes a name can hide first (the prose pattern
 * would otherwise stop at the `_` and leave the last group behind), then the
 * segment as text.
 */
function redactSegment(segment: string, options: RedactOptions): RedactionResult {
  let phones = 0;
  let text = segment;
  if (options.maskPhones !== false) {
    for (const re of FILENAME_PHONE_RES) {
      text = text.replace(re, (m: string) => {
        const n = digitCount(m);
        if (n < 8 || n > 15) return m;
        phones += 1;
        return placeholder("PHONE");
      });
    }
  }
  const r = redactText(text, options);
  if (phones === 0) return r;
  const counts = { ...r.counts, PHONE: (r.counts.PHONE ?? 0) + phones };
  return { text: r.text, counts, kinds: REDACTION_KINDS.filter((k) => counts[k]) };
}

/**
 * Redact a file path: the account's home folds to `~` (a user name is
 * personal data), then every segment is redacted as text — and as a file
 * name, whose parts are joined by `_`, `-` and `.` — separators kept.
 */
export function redactPath(input: string, options: RedactPathOptions = {}): RedactionResult {
  let p = input;
  const home = options.homeDir?.replace(/\/+$/, "");
  if (home && home !== "" && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`;
  p = p.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
  const counts: Partial<Record<RedactionKind, number>> = {};
  const parts = p.split("/").map((segment) => {
    const r = redactSegment(segment, options);
    for (const [k, n] of Object.entries(r.counts) as Array<[RedactionKind, number]>) counts[k] = (counts[k] ?? 0) + n;
    return r.text;
  });
  const kinds = REDACTION_KINDS.filter((k) => counts[k]);
  return { text: parts.join("/"), counts, kinds };
}
