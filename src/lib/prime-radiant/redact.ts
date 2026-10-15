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
 * mod-97 check or have exactly its country's registered shape, and is
 * replaced WHOLE, spaced or not (never its account part as a "card"); a card
 * number must pass the Luhn check and stand alone — and a bare 10- or
 * 13-digit run that reads as a Unix timestamp (seconds or milliseconds) is
 * never a card, since millisecond timestamps pass Luhn about one time in ten.
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

/**
 * IBAN length by country (the SWIFT IBAN registry). The length tells where an
 * IBAN ends, so one glued to the word after it ("…3456 78EUR") is still found
 * whole, and an IBAN whose check digits are off (a typo, a made-up example) is
 * still an account number when it has exactly its country's shape.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
});

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

/**
 * Where an IBAN may start: two capitals and two check digits not glued to the
 * word before them (except "IBAN" itself, which extracted text often runs
 * into the number), then letters and digits with single spaces between —
 * spaced in fours, unspaced, or anything between. Greedy on purpose: where
 * the IBAN really ends is decided by {@link ibanEnd}, not by the pattern.
 */
const IBAN_START_RE = /(?:(?<=IBAN)|(?<![A-Za-z0-9]))[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Z0-9]){11,32}/g;
const IBAN_MAX = 34;
const IBAN_MIN = 15;
/** Digits an IBAN-shaped run with bad check digits must hold to still count as one: an account number has them. */
const IBAN_SHAPE_MIN_DIGITS = 8;

/**
 * Where the IBAN that starts a candidate ends (an offset into `text`), or null
 * when there is none. With a registered country the registry length decides:
 * a run of that length that passes mod-97 is an IBAN whatever follows it, and
 * one with the right length, enough digits and an end at a word boundary is
 * one too (a mistyped IBAN is still an account number). Otherwise the
 * longest run ending at a boundary that passes mod-97.
 */
function ibanEnd(text: string, start: number, candidate: string): number | null {
  const at: number[] = [];
  for (let i = 0; i < candidate.length; i++) if (/[A-Z0-9]/.test(candidate[i])) at.push(i);
  const endOf = (n: number) => start + at[n - 1] + 1;
  const glued = (n: number) => /[A-Za-z0-9]/.test(text[endOf(n)] ?? "");
  const compact = (n: number) => at.slice(0, n).map((i) => candidate[i]).join("");
  const registered = IBAN_LENGTHS[candidate.slice(0, 2)];
  if (registered && at.length >= registered) {
    const iban = compact(registered);
    if (ibanValid(iban)) return endOf(registered);
    if (!glued(registered) && digitCount(iban.slice(4)) >= IBAN_SHAPE_MIN_DIGITS) return endOf(registered);
  }
  for (let n = Math.min(at.length, IBAN_MAX); n >= IBAN_MIN; n--) {
    if (!glued(n) && ibanValid(compact(n))) return endOf(n);
  }
  return null;
}

/** Every IBAN in `text` replaced whole, spaced or not; `onHit` counts them. */
function redactIbans(text: string, onHit: () => void): string {
  const re = new RegExp(IBAN_START_RE.source, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = ibanEnd(text, m.index, m[0]);
    if (end === null) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + placeholder("IBAN");
    onHit();
    last = end;
    re.lastIndex = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

const CARD_RE = /(?<![\d.,-])\d(?:[ -]?\d){12,18}(?![\d])/g;

/**
 * Whether the digits at `offset` are the account part of an IBAN-shaped word
 * (`BG80BNBG9661…`) — one that is not a valid IBAN, or it would be gone
 * already. Such digits are never a card: half an IBAN masked as a card
 * reads as if the rest were safe to show.
 */
function ibanTail(text: string, offset: number): boolean {
  let from = offset;
  while (from > 0 && /[A-Za-z0-9]/.test(text[from - 1])) from -= 1;
  return from < offset && /^[A-Z]{2}\d{2}/.test(text.slice(from, offset + 4));
}

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
  text = redactIbans(text, () => bump("IBAN"));
  text = text.replace(CARD_RE, (m: string, offset: number, whole: string) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || ibanTail(whole, offset)) return m;
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
