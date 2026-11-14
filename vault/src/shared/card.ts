// Payment cards in the pass store, each one entry under its own prefix:
//
//   cards/<label>
//
//   <number, digits only>
//   name: <cardholder>
//   exp: <MM/YY>
//   cvv: <security code, optional>
//   label: <label>
//   note: <note>
//
// Line 1 is the number; the known fields follow as "key: value" lines. Any
// other lines are preserved untouched, in order, when a card is updated.
// Lists, the extension's chip and picker, the agent and the logs only ever see
// CardMeta: label, brand, last 4, expiry, cardholder and dates.
import { ValidationError, validateLine } from "./entry";

export const CARD_PREFIX = "cards";

export function isCardName(name: string): boolean {
  return name === CARD_PREFIX || name.startsWith(`${CARD_PREFIX}/`);
}

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "diners" | "jcb" | "unionpay" | "maestro" | "mir" | "unknown";

export const BRAND_NAMES: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  maestro: "Maestro",
  mir: "Mir",
  unknown: "Card",
};

export interface CardFields {
  /** Digits only. */
  number: string;
  cardholder: string;
  /** MM/YY. */
  exp: string;
  cvv: string;
  label: string;
  note: string;
}

export interface ParsedCard extends CardFields {
  /** Lines after line 1 that are not one of the known fields, kept verbatim. */
  extra: string[];
}

/** Non-secret view of a card: what lists, the extension and the agent may see. */
export interface CardMeta {
  name: string;
  label: string;
  brand: CardBrand;
  last4: string;
  exp: string;
  expired: boolean;
  cardholder: string;
  updated: string;
}

const FIELD_KEYS: Record<string, keyof CardFields> = {
  name: "cardholder",
  exp: "exp",
  cvv: "cvv",
  label: "label",
  note: "note",
};

export function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function parseCard(text: string): ParsedCard {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const first = (lines[0] ?? "").trim();
  // Scripts may have written the number in groups; the digits are the number.
  const number = /^[\d -]+$/.test(first) ? digitsOf(first) : first;
  const card: ParsedCard = { number, cardholder: "", exp: "", cvv: "", label: "", note: "", extra: [] };
  for (const line of lines.slice(1)) {
    const m = /^([A-Za-z0-9]+):\s?(.*)$/.exec(line);
    const key = m ? FIELD_KEYS[m[1]!.toLowerCase()] : undefined;
    if (m && key && card[key] === "") card[key] = m[2]!.trim();
    else card.extra.push(line);
  }
  return card;
}

export function serializeCard(card: ParsedCard): string {
  const lines = [card.number];
  if (card.cardholder) lines.push(`name: ${card.cardholder}`);
  if (card.exp) lines.push(`exp: ${card.exp}`);
  if (card.cvv) lines.push(`cvv: ${card.cvv}`);
  if (card.label) lines.push(`label: ${card.label}`);
  if (card.note) lines.push(`note: ${card.note}`);
  lines.push(...card.extra);
  return lines.join("\n") + "\n";
}

// ---- number: Luhn, brand, formatting ------------------------------------------------

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function prefixIn(digits: string, len: number, from: number, to: number): boolean {
  if (digits.length < len) return false;
  const p = Number(digits.slice(0, len));
  return p >= from && p <= to;
}

/** Card brand from the issuer prefix (IIN ranges). */
export function cardBrand(number: string): CardBrand {
  const d = digitsOf(number);
  if (!d) return "unknown";
  if (/^3[47]/.test(d)) return "amex";
  if (prefixIn(d, 4, 2200, 2204)) return "mir";
  if (/^5[1-5]/.test(d) || prefixIn(d, 4, 2221, 2720)) return "mastercard";
  if (/^4/.test(d)) return "visa";
  if (/^(6011|65|64[4-9])/.test(d)) return "discover";
  if (prefixIn(d, 4, 3528, 3589)) return "jcb";
  if (/^(36|38|39|30[0-5])/.test(d)) return "diners";
  if (/^62/.test(d)) return "unionpay";
  if (/^(5[06-8]|6\d)/.test(d)) return "maestro";
  return "unknown";
}

const BRAND_LENGTHS: Record<CardBrand, number[]> = {
  visa: [13, 16, 19],
  mastercard: [16],
  amex: [15],
  discover: [16, 17, 18, 19],
  diners: [14, 15, 16, 17, 18, 19],
  jcb: [16, 17, 18, 19],
  unionpay: [16, 17, 18, 19],
  maestro: [13, 14, 15, 16, 17, 18, 19],
  mir: [16, 17, 18, 19],
  unknown: [13, 14, 15, 16, 17, 18, 19],
};

/** Digit groups as printed on the card: 4-6-5 for Amex, 4-6-4 for 14-digit Diners, else fours. */
export function formatNumber(number: string, sep = " "): string {
  const d = digitsOf(number);
  const brand = cardBrand(d);
  let sizes: number[];
  if (brand === "amex" || (brand === "diners" && d.length === 14)) sizes = [4, 6, d.length - 10];
  else sizes = Array.from({ length: Math.ceil(d.length / 4) }, () => 4);
  const out: string[] = [];
  let i = 0;
  for (const s of sizes) {
    if (i >= d.length) break;
    out.push(d.slice(i, i + s));
    i += s;
  }
  if (i < d.length) out.push(d.slice(i));
  return out.join(sep);
}

export function cardLast4(number: string): string {
  return digitsOf(number).slice(-4);
}

/** "•••• 4242": the only form a number is shown in outside an explicit reveal. */
export function maskNumber(number: string): string {
  const last4 = cardLast4(number);
  return last4 ? `•••• ${last4}` : "••••";
}

export function maskCvv(cvv: string): string {
  return cvv ? "•".repeat(Math.max(3, cvv.length)) : "";
}

// ---- expiry -------------------------------------------------------------------------

export interface Expiry {
  month: number;
  /** Four-digit year. */
  year: number;
}

/** Accepts MM/YY, MM/YYYY, M/YY, MM-YY, "MM / YY", MMYY and MMYYYY. */
export function parseExpiry(value: string): Expiry | null {
  const v = value.trim();
  let m = /^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/.exec(v);
  if (!m) m = /^(\d{2})(\d{2}|\d{4})$/.exec(v);
  if (!m) return null;
  const month = Number(m[1]);
  let year = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (m[2]!.length === 2) year += 2000;
  return { month, year };
}

export function formatExpiry(e: Expiry): string {
  return `${String(e.month).padStart(2, "0")}/${String(e.year % 100).padStart(2, "0")}`;
}

/** A card is valid through the last day of its expiry month. */
export function isExpired(exp: string, now: Date = new Date()): boolean {
  const e = parseExpiry(exp);
  if (!e) return false;
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  return e.year < y || (e.year === y && e.month < mo);
}

// ---- validation on save -------------------------------------------------------------

/**
 * Messages never quote the value: a rejected number or CVV must not reach a
 * response, a log or an error.
 */
export function validateCardNumber(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError("card number is required");
  const raw = String(value).trim();
  if (!raw) throw new ValidationError("card number is required");
  if (!/^[\d -]+$/.test(raw)) throw new ValidationError("card number may only contain digits");
  const d = digitsOf(raw);
  if (d.length < 13 || d.length > 19) throw new ValidationError("card number must have 13 to 19 digits");
  if (!luhnValid(d)) throw new ValidationError("card number fails the Luhn check (typo?)");
  const brand = cardBrand(d);
  if (!BRAND_LENGTHS[brand].includes(d.length)) throw new ValidationError(`a ${BRAND_NAMES[brand]} number cannot have ${d.length} digits`);
  return d;
}

const MAX_YEARS_AHEAD = 30;

export function validateExpiry(value: unknown, now: Date = new Date()): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("expiry is required (MM/YY)");
  const e = parseExpiry(value);
  if (!e) throw new ValidationError("expiry must be MM/YY");
  const exp = formatExpiry(e);
  if (isExpired(exp, now)) throw new ValidationError("the card has expired");
  if (e.year > now.getFullYear() + MAX_YEARS_AHEAD) throw new ValidationError("expiry is too far in the future");
  return exp;
}

/** Optional: "" when absent. 4 digits for American Express, 3 for the others. */
export function validateCvv(value: unknown, brand: CardBrand): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError("security code must be digits");
  const v = String(value).trim();
  if (!v) return "";
  if (!/^\d+$/.test(v)) throw new ValidationError("security code must be digits");
  const ok = brand === "amex" ? v.length === 4 : brand === "unknown" ? v.length === 3 || v.length === 4 : v.length === 3;
  if (!ok) throw new ValidationError(brand === "amex" ? "an American Express security code has 4 digits" : "the security code has 3 digits");
  return v;
}

/** Labels, cardholders and notes are metadata: they must never carry a card number. */
export function validateCardText(value: unknown, field: string, max: number): string {
  const v = validateLine(value, field, { max });
  if (containsCardNumber(v)) throw new ValidationError(`${field} must not contain a card number`);
  return v;
}

export function defaultLabel(number: string): string {
  return `${BRAND_NAMES[cardBrand(number)]} ${cardLast4(number)}`;
}

/** Entry name for a label: cards/<slug>; letters (any script), digits, ".", "_" and "-". */
export function cardNameFor(label: string): string {
  const slug = label
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/g, "");
  return `${CARD_PREFIX}/${slug || "card"}`;
}

export function cardMetaOf(name: string, card: Pick<CardFields, "number" | "cardholder" | "exp" | "label">, updated: Date, now: Date = new Date()): CardMeta {
  const e = parseExpiry(card.exp);
  const exp = e ? formatExpiry(e) : card.exp;
  return {
    name,
    label: card.label || defaultLabel(card.number),
    brand: cardBrand(card.number),
    last4: cardLast4(card.number),
    exp,
    expired: isExpired(exp, now),
    cardholder: card.cardholder,
    updated: updated.toISOString(),
  };
}

/** The audit/log form of a card: label and last 4 only. */
export function cardTag(meta: Pick<CardMeta, "label" | "last4">): string {
  return `${meta.label} •••• ${meta.last4}`;
}

// ---- scrubber -----------------------------------------------------------------------

export const REDACTED = "[redacted]";

/** Runs of digits with single spaces or dashes between them: "4242 4242-4242". */
const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

/**
 * Character ranges of Luhn-valid 13–19 digit card numbers in `text`: whole
 * groups of a separated run ("4242 4242 4242 4242 123" finds the first four
 * groups), and a number glued to a short suffix (number + CVV) when its brand
 * and length fit.
 */
function cardNumberRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0];
    const start = m.index ?? 0;
    if (digitsOf(run).length < 13) continue;
    const groups: Array<{ from: number; to: number; digits: string }> = [];
    for (const g of run.matchAll(/\d+/g)) groups.push({ from: start + g.index!, to: start + g.index! + g[0].length, digits: g[0] });
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += groups[j]!.digits;
        if (digits.length > 19) break;
        if (digits.length >= 13 && luhnValid(digits)) ranges.push([groups[i]!.from, groups[j]!.to]);
      }
      const g = groups[i]!;
      if (g.digits.length > 13 && g.digits.length <= 23) {
        for (let len = 13; len <= Math.min(19, g.digits.length - 1); len++) {
          const head = g.digits.slice(0, len);
          if (luhnValid(head) && BRAND_LENGTHS[cardBrand(head)].includes(len) && cardBrand(head) !== "unknown") {
            ranges.push([g.from, g.from + len]);
          }
        }
      }
    }
  }
  return ranges;
}

export function containsCardNumber(text: string): boolean {
  return cardNumberRanges(text).length > 0;
}

export function redactCardNumbers(text: string): string {
  const ranges = cardNumberRanges(text).sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return text;
  let out = "";
  let at = 0;
  for (const [from, to] of ranges) {
    if (to <= at) continue;
    out += text.slice(at, Math.max(at, from)) + (from >= at ? REDACTED : "");
    at = to;
  }
  return out + text.slice(at);
}

/** A 3–4 digit value right after a security-code keyword: "cvv: 123", "\"cvc\":\"123\"", "CVV код 123". */
const CVV_NEAR_KEYWORD =
  /(?<![\p{L}\p{N}])(cvv2?|cvc2?|csc|cvn|cid|security[ _-]?code|card[ _-]?code|sicherheitscode|pr[üu]fnummer|код за сигурност|cvv[ -]?код)(["']?\s*[:=]?\s*["']?\s*(?:is\s+)?)(\d{3,4})(?!\d)/giu;

export function redactCvvs(text: string): string {
  return text.replace(CVV_NEAR_KEYWORD, (_all, key: string, sep: string) => `${key}${sep}${REDACTED}`);
}

/** Card numbers, CVVs next to their keyword, and any known secret strings. */
export function scrubCardData(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join(REDACTED);
  return redactCvvs(redactCardNumbers(out));
}

/** Deep copy of a JSON-like value with every string (and long number) scrubbed. */
export function scrubDeep<T>(value: T, clean: (s: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (typeof value === "number") {
    const s = String(value);
    const c = clean(s);
    return (c === s ? value : c) as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, clean)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, clean);
    return out as T;
  }
  return value;
}
