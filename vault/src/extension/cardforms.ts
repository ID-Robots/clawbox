// Checkout (payment card) field detection and filling, DOM-only like forms.ts,
// so it runs in the content script and in the DOM tests alike.
//
// Detection: the autocomplete tokens cc-name / cc-given-name / cc-family-name /
// cc-number / cc-exp / cc-exp-month / cc-exp-year / cc-csc / cc-type first,
// then name / id / placeholder / aria-label / label heuristics in English,
// German and Bulgarian. Heuristic-only fields count only next to a card number
// field, so a birthday "month" select is not taken for an expiry.
//
// Filling reuses the React-safe fillInput (native setter + input/change/blur),
// formats to the field (split month/year, select or input, 2- or 4-digit year,
// "MM / YY" vs "MMYY", grouped numbers), and falls back to typing character by
// character when an input mask rewrote the value.
import { cardBrand, digitsOf, formatNumber, luhnValid, parseExpiry } from "../shared/card";
import { ancestorOriginsOf, isPaymentFrameOrigin, isSecureOrLocal } from "../shared/hosts";
import { fillInput, framedBySameOrigin, isVisible } from "./forms";

export type CardFieldKind = "name" | "givenName" | "familyName" | "number" | "exp" | "expMonth" | "expYear" | "cvc" | "type";

type Field = HTMLInputElement | HTMLSelectElement;

export interface CardField {
  el: Field;
  kind: CardFieldKind;
  /** Declared by autocomplete (counts on its own, e.g. in a payment provider's iframe). */
  strong: boolean;
}

/** What one fill hands a frame: only the parts that frame has fields for. */
export interface CardData {
  number?: string;
  cardholder?: string;
  /** MM/YY */
  exp?: string;
  cvv?: string;
  brand?: string;
}

export interface CardFillOutcome {
  status: "filled" | "no_form";
  filled?: CardFieldKind[];
  /** Fields the page has but the card cannot fill (e.g. no stored security code). */
  missing?: CardFieldKind[];
  detail?: string;
}

const AUTOCOMPLETE: Record<string, CardFieldKind> = {
  "cc-name": "name",
  "cc-given-name": "givenName",
  "cc-family-name": "familyName",
  "cc-number": "number",
  "cc-exp": "exp",
  "cc-exp-month": "expMonth",
  "cc-exp-year": "expYear",
  "cc-csc": "cvc",
  "cc-type": "type",
};

const INPUT_TYPES = new Set(["", "text", "tel", "number", "password", "month", "search"]);

const EXCLUDE =
  /gift|voucher|gutschein|coupon|promo|rabatt|discount|iban|bic|swift|routing|loyalty|bonus|member|phone|telefon|телефон|mobile|zip|postal|plz|post.?code|пощенски|ваучер|подаръч|search|suche|търс|captcha|otp|one.?time|sms|birth|dob|geburt|рожд/i;
const CVC =
  /cvv|cvc|csc|cvn|cav2|(^|[^a-z])cid([^a-z]|$)|security.?code|securitycode|card.?code|verification.?(code|number|value)|card.?verification|prüf(nummer|ziffer|code)|pruef(nummer|ziffer)|sicherheits(code|nummer)|kartenprüf|код\s*(за\s*)?(сигурност|cvv|cvc)|(cvv|cvc)\s*код|защитен\s*код|секретен\s*код/i;
const EXP_PATTERN = /(mm|мм)\s*[/\-.]?\s*(yy|jj|гг|aa)/i;
const MONTH = /month|monat|месец|mois|(^|[^a-zа-я])(mm|мм)([^a-zа-я/]|$)|exp.?m($|[^a-z])/i;
const YEAR = /year|jahr|година|année|(^|[^a-zа-я])(yy|yyyy|jj|jjjj|гг|гггг)([^a-zа-я/]|$)|exp.?y($|[^a-z])/i;
const EXP =
  /expir|exp[-_ .]?(date|dt)|(^|[^a-z])(cc[-_]?)?exp($|[^a-z])|card[-_ .]?exp|ablauf|gültig|gueltig|valid(\s|-)?(thru|through|until|till|to)|validity|валидн|изтича|срок на валидност|дата на изтичане/i;
const NAME =
  /card.?holder|holder.?name|name.?on.?(the.?)?card|cc.?name|card.?name|nameoncard|karteninhaber|inhaber|name auf der karte|картодържател|притежател|име върху картата|име на карта|titulaire|titular|card.?owner/i;
const TYPE = /card.?type|cc.?type|card.?brand|kartentyp|kartenart|тип на карта|вид на карта|вид карта|type de carte|tipo de tarjeta|payment.?brand/i;
const NUMBER =
  /card.?num|card.?no($|[^a-z])|card.?nr|cc.?num|ccnum|cc.?no($|[^a-z])|(^|[^a-z])cc($|[^a-z])|cardnumber|credit.?card|debit.?card|kreditkart|kartennummer|karten.?nr|номер на карта|номер на картата|номер карт|card\s*#|numéro de carte|número de tarjeta|numero (della )?carta|(^|[^a-z])pan($|[^a-z])|acct.?num/i;
const NUMBER_PLACEHOLDER = /^[\d•*xX#]{4}([ -]?[\d•*xX#]{4}){2,}/;
const BRAND_OPTION = /visa|master|amex|american express|discover|maestro|diners|jcb|unionpay/i;

function ac(el: Element): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase();
}

function isSelect(el: Element): el is HTMLSelectElement {
  return el.tagName === "SELECT";
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function labelText(el: Field): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  if (el.id) {
    const label = doc.querySelector(`label[for="${el.id.replace(/["\\]/g, "\\$&")}"]`);
    if (label) parts.push(textOf(label));
  }
  const wrapping = el.closest("label");
  if (wrapping) parts.push(textOf(wrapping));
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    parts.push(textOf(doc.getElementById(id)));
  }
  // A short caption right before the field (<span>Card number</span><input>).
  const prev = el.previousElementSibling;
  if (prev && !prev.querySelector("input, select, textarea") && textOf(prev).length < 60) parts.push(textOf(prev));
  return parts.join(" ");
}

function hints(el: Field): string {
  return [
    el.getAttribute("name"),
    el.id,
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-stripe"),
    el.getAttribute("data-braintree-name"),
    el.getAttribute("data-cse"),
    el.getAttribute("data-encrypted-name"),
    labelText(el),
  ]
    .filter(Boolean)
    .join(" ");
}

// ---- month names, for selects ---------------------------------------------------

const MONTH_NAMES: string[][] = [
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"],
];

/** Month 1-12 an option stands for ("05", "5", "May", "Mai", "05 - Май"), or null. */
function monthOfOption(opt: HTMLOptionElement): number | null {
  for (const raw of [opt.value, opt.text]) {
    const v = raw.trim().toLowerCase();
    const num = /^(\d{1,2})(\s|$|[-./])/.exec(v);
    if (num) {
      const n = Number(num[1]);
      if (n >= 1 && n <= 12) return n;
      continue;
    }
    const word = /^[\p{L}]+/u.exec(v)?.[0] ?? "";
    if (word.length < 3) continue;
    for (const names of MONTH_NAMES) {
      const i = names.findIndex((n) => n.startsWith(word));
      if (i >= 0) return i + 1;
    }
  }
  return null;
}

/** Four-digit year an option stands for ("2034", "34"), or null. */
function yearOfOption(opt: HTMLOptionElement, now = new Date()): number | null {
  for (const raw of [opt.value, opt.text]) {
    const v = raw.trim();
    const m = /^(\d{2}|\d{4})$/.exec(v);
    if (!m) continue;
    const y = m[1]!.length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    if (y >= now.getFullYear() - 1 && y <= now.getFullYear() + 40) return y;
  }
  return null;
}

// ---- classification ----------------------------------------------------------------

function usable(el: Field): boolean {
  if (el.disabled) return false;
  if (!isSelect(el)) {
    if (el.readOnly || !INPUT_TYPES.has(el.type.toLowerCase())) return false;
  }
  return isVisible(el);
}

export function classifyCardField(el: Field): { kind: CardFieldKind; strong: boolean } | null {
  for (const token of ac(el).split(/\s+/)) {
    const kind = AUTOCOMPLETE[token];
    if (kind) return { kind, strong: true };
  }
  const h = hints(el);
  if (!h && !isSelect(el)) return null;
  if (EXCLUDE.test(h)) return null;
  if (isSelect(el)) {
    const opts = Array.from(el.options);
    if (TYPE.test(h) || opts.filter((o) => BRAND_OPTION.test(`${o.value} ${o.text}`)).length >= 2) return { kind: "type", strong: false };
    const months = new Set(opts.map((o) => monthOfOption(o)).filter((n) => n !== null)).size;
    const years = opts.filter((o) => yearOfOption(o) !== null).length;
    if (MONTH.test(h) && !YEAR.test(h)) return { kind: "expMonth", strong: false };
    if (YEAR.test(h) && !MONTH.test(h)) return { kind: "expYear", strong: false };
    if (months >= 12 && years < 5) return { kind: "expMonth", strong: false };
    if (years >= 5) return { kind: "expYear", strong: false };
    return null;
  }
  if (CVC.test(h)) return { kind: "cvc", strong: false };
  if (EXP_PATTERN.test(h)) return { kind: "exp", strong: false };
  if (el.type === "month" && EXP.test(h)) return { kind: "exp", strong: false };
  if (MONTH.test(h)) return { kind: "expMonth", strong: false };
  if (YEAR.test(h)) return { kind: "expYear", strong: false };
  if (EXP.test(h)) return { kind: "exp", strong: false };
  if (NAME.test(h)) return { kind: "name", strong: false };
  if (TYPE.test(h)) return { kind: "type", strong: false };
  if (NUMBER.test(h) || NUMBER_PLACEHOLDER.test(el.getAttribute("placeholder") ?? "")) return { kind: "number", strong: false };
  return null;
}

/** Card fields of one document, in document order. */
export function findCardFields(doc: Document): CardField[] {
  const found: CardField[] = [];
  for (const el of Array.from(doc.querySelectorAll("input, select")) as Field[]) {
    if (el.closest("[data-clawbox-vault-ignore]") || !usable(el)) continue;
    const c = classifyCardField(el);
    if (c) found.push({ el, ...c });
  }
  const hasNumber = found.some((f) => f.kind === "number");
  return found.filter((f) => f.strong || hasNumber);
}

export function cardFieldKinds(doc: Document): CardFieldKind[] {
  return [...new Set(findCardFields(doc).map((f) => f.kind))];
}

/** The card number input the in-page chip sits next to. */
export function cardNumberField(doc: Document): HTMLInputElement | null {
  const f = findCardFields(doc).find((x) => x.kind === "number" && !isSelect(x.el));
  return (f?.el as HTMLInputElement | undefined) ?? null;
}

// ---- filling ---------------------------------------------------------------------------

interface Exp {
  month: number;
  mm: string;
  yy: string;
  yyyy: string;
}

function expParts(exp: string): Exp | null {
  const e = parseExpiry(exp);
  if (!e) return null;
  return { month: e.month, mm: String(e.month).padStart(2, "0"), yy: String(e.year % 100).padStart(2, "0"), yyyy: String(e.year) };
}

function setterFor(el: Field): ((v: string) => void) | null {
  const win = el.ownerDocument.defaultView;
  const proto = win ? (isSelect(el) ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype) : Object.getPrototypeOf(el);
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  return set ? (v: string) => set.call(el, v) : null;
}

/** Type a value key by key, for input masks that rewrite a value set in one go. */
function typeInto(input: HTMLInputElement, value: string): void {
  const win = input.ownerDocument.defaultView;
  const set = setterFor(input) ?? ((v: string) => (input.value = v));
  const Ev = win?.Event ?? Event;
  const Kb = win?.KeyboardEvent ?? Ev;
  const In = win?.InputEvent ?? Ev;
  input.focus();
  set("");
  input.dispatchEvent(new Ev("input", { bubbles: true }));
  for (const ch of value) {
    input.dispatchEvent(new Kb("keydown", { key: ch, bubbles: true }));
    input.dispatchEvent(new Kb("keypress", { key: ch, bubbles: true }));
    set(input.value + ch);
    input.dispatchEvent(new In("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" } as InputEventInit));
    input.dispatchEvent(new Kb("keyup", { key: ch, bubbles: true }));
  }
  input.dispatchEvent(new Ev("change", { bubbles: true }));
  input.blur();
}

/** Fill an input; if a mask mangled it (checked by `ok`), type it instead. */
function fillChecked(input: HTMLInputElement, value: string, ok: (shown: string) => boolean, typed = value): boolean {
  fillInput(input, value);
  if (ok(input.value)) return true;
  typeInto(input, typed);
  return ok(input.value);
}

function chooseOption(sel: HTMLSelectElement, match: (o: HTMLOptionElement) => boolean): boolean {
  const opt = Array.from(sel.options).find((o) => !o.disabled && match(o));
  if (!opt) return false;
  const win = sel.ownerDocument.defaultView;
  const Ev = win?.Event ?? Event;
  sel.focus();
  const set = setterFor(sel);
  if (set) set(opt.value);
  else sel.value = opt.value;
  sel.dispatchEvent(new Ev("input", { bubbles: true, composed: true }));
  sel.dispatchEvent(new Ev("change", { bubbles: true }));
  sel.blur();
  return sel.value === opt.value;
}

function placeholderOf(el: Field): string {
  return isSelect(el) ? "" : (el.getAttribute("placeholder") ?? "");
}

function maxLen(el: HTMLInputElement): number {
  return el.maxLength > 0 ? el.maxLength : Infinity;
}

/** "4242 4242 4242 4242" when the placeholder shows groups and maxlength fits, else digits. */
export function numberValueFor(input: HTMLInputElement, digits: string): string {
  if (input.type === "number") return digits;
  const sep = /[\d•*xX#]{4}([ -])[\d•*xX#]/.exec(placeholderOf(input))?.[1];
  const formatted = sep ? formatNumber(digits, sep) : digits;
  return formatted.length <= maxLen(input) ? formatted : digits;
}

/** Combined expiry as the field wants it: MM/YY, MM / YY, MM/YYYY, MMYY, or YYYY-MM for type=month. */
export function expValueFor(input: HTMLInputElement, e: Exp): string {
  if (input.type === "month") return `${e.yyyy}-${e.mm}`;
  const h = `${placeholderOf(input)} ${hints(input)}`;
  const four = /yyyy|jjjj|гггг|aaaa/i.test(h);
  const pattern = /(mm|мм)(\s*[/\-.]\s*|\s+)?(yy|jj|гг|aa)/i.exec(h);
  const sep = pattern ? (pattern[2] ?? "") : "/";
  const year = four ? e.yyyy : e.yy;
  const candidates = [`${e.mm}${sep}${year}`, `${e.mm}${sep.trim()}${year}`, `${e.mm}/${e.yy}`, `${e.mm}${e.yy}`];
  return candidates.find((c) => c.length <= maxLen(input)) ?? `${e.mm}${e.yy}`;
}

export function yearValueFor(input: HTMLInputElement, e: Exp): string {
  const h = `${placeholderOf(input)} ${hints(input)}`;
  if (maxLen(input) <= 2 || (/(^|[^a-zа-я])(yy|jj|гг)([^a-zа-я]|$)/i.test(h) && !/yyyy|jjjj|гггг/i.test(h))) return e.yy;
  return e.yyyy;
}

function brandMatcher(brand: string): RegExp | null {
  const map: Record<string, RegExp> = {
    visa: /visa/i,
    mastercard: /master/i,
    amex: /amex|american/i,
    discover: /discover/i,
    diners: /diners/i,
    jcb: /jcb/i,
    unionpay: /union/i,
    maestro: /maestro/i,
    mir: /(^|[^a-z])mir([^a-z]|$)|мир/i,
  };
  return map[brand] ?? null;
}

const BRAND_TEXT: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay", maestro: "Maestro", mir: "Mir" };

function fillNumber(fields: CardField[], digits: string): boolean {
  const inputs = fields.map((f) => f.el).filter((el): el is HTMLInputElement => !isSelect(el));
  if (!inputs.length) return false;
  // Split number (four inputs of four digits): distribute by maxlength.
  const parts = inputs.map((i) => i.maxLength);
  if (inputs.length >= 2 && parts.every((n) => n >= 3 && n <= 6) && parts.reduce((a, b) => a + b, 0) >= digits.length) {
    let at = 0;
    let ok = true;
    for (const input of inputs) {
      const chunk = digits.slice(at, at + input.maxLength);
      at += input.maxLength;
      if (chunk) ok = fillChecked(input, chunk, (v) => digitsOf(v) === chunk) && ok;
    }
    return ok;
  }
  const input = inputs[0]!;
  return fillChecked(input, numberValueFor(input, digits), (v) => digitsOf(v) === digits, digits);
}

/** Fill every card field of `doc` that `data` has a value for. Never submits. */
export function fillCardFields(doc: Document, data: CardData): CardFillOutcome {
  const fields = findCardFields(doc);
  if (!fields.length) return { status: "no_form" };
  const filled = new Set<CardFieldKind>();
  const missing = new Set<CardFieldKind>();
  const e = data.exp ? expParts(data.exp) : null;
  const digits = data.number ? digitsOf(data.number) : "";
  const brand = data.brand || (digits ? cardBrand(digits) : "");
  const [given, family] = (() => {
    const n = (data.cardholder ?? "").trim();
    const i = n.lastIndexOf(" ");
    return i > 0 ? [n.slice(0, i), n.slice(i + 1)] : [n, ""];
  })();

  const numbers = fields.filter((f) => f.kind === "number");
  if (numbers.length) {
    if (digits && fillNumber(numbers, digits)) filled.add("number");
    else if (!digits) missing.add("number");
  }
  for (const f of fields) {
    const el = f.el;
    let ok: boolean | null = null; // null: nothing to put here
    switch (f.kind) {
      case "number":
        continue;
      case "name":
        if (data.cardholder) ok = isSelect(el) ? false : fillChecked(el, data.cardholder, (v) => v === data.cardholder);
        break;
      case "givenName":
        if (given) ok = isSelect(el) ? false : fillChecked(el, given, (v) => v === given);
        break;
      case "familyName":
        if (family) ok = isSelect(el) ? false : fillChecked(el, family, (v) => v === family);
        break;
      case "exp":
        if (e) {
          if (isSelect(el)) ok = chooseOption(el, (o) => digitsOf(o.value) === `${e.mm}${e.yy}` || digitsOf(o.value) === `${e.mm}${e.yyyy}`);
          else {
            const want = expValueFor(el, e);
            const ok4 = (v: string) => digitsOf(v) === digitsOf(want) || digitsOf(v) === `${e.mm}${e.yy}` || v === want;
            ok = fillChecked(el, want, ok4, el.type === "month" ? want : `${e.mm}${e.yy}`);
          }
        }
        break;
      case "expMonth":
        if (e) {
          if (isSelect(el)) ok = chooseOption(el, (o) => monthOfOption(o) === e.month);
          else ok = fillChecked(el, maxLen(el) === 1 ? String(e.month) : e.mm, (v) => Number(digitsOf(v)) === e.month);
        }
        break;
      case "expYear":
        if (e) {
          if (isSelect(el)) ok = chooseOption(el, (o) => yearOfOption(o) === Number(e.yyyy));
          else {
            const want = yearValueFor(el, e);
            const check = (v: string) => v === e.yy || v === e.yyyy;
            // A mask that keeps only two digits gets the two-digit year.
            ok = fillChecked(el, want, check) || (want === e.yyyy && fillChecked(el, e.yy, check));
          }
        }
        break;
      case "cvc":
        if (data.cvv) ok = isSelect(el) ? false : fillChecked(el, data.cvv, (v) => v === data.cvv);
        break;
      case "type":
        if (brand && brand !== "unknown") {
          const re = brandMatcher(brand);
          if (isSelect(el)) ok = re ? chooseOption(el, (o) => re.test(`${o.value} ${o.text}`)) : false;
          else ok = fillChecked(el, BRAND_TEXT[brand] ?? brand, () => true);
        }
        break;
    }
    if (ok) filled.add(f.kind);
    else if (ok === null) missing.add(f.kind);
  }
  for (const k of filled) missing.delete(k);
  return { status: "filled", filled: [...filled], missing: [...missing] };
}

// ---- frames ------------------------------------------------------------------------------

export interface CardFrameReport {
  origin: string;
  /** Parent first, top last; [] in the top frame; null when unknown. */
  ancestorOrigins: string[] | null;
  kinds: CardFieldKind[];
}

export function probeCardFrame(win: Window): CardFrameReport {
  return { origin: win.location.origin, ancestorOrigins: ancestorOriginsOf(win), kinds: cardFieldKinds(win.document) };
}

export type GuardedCardOutcome = CardFillOutcome | { status: "origin_mismatch"; detail: string };

/**
 * Fill inside one frame, but only if it is exactly the origin the background
 * approved and https (or http on localhost), and either is embedded only by
 * its own origin (top frame, same-origin iframe), or is an allowed payment
 * provider frame embedded by the checkout page itself.
 */
export function guardedCardFill(
  win: Window,
  args: { data: CardData; allowedOrigin: string; topOrigin: string; paymentFrame: boolean },
): GuardedCardOutcome {
  const loc = win.location;
  if (loc.origin !== args.allowedOrigin || !isSecureOrLocal(loc.protocol, loc.hostname)) {
    return { status: "origin_mismatch", detail: "frame origin differs from the approved one" };
  }
  if (args.paymentFrame) {
    const anc = ancestorOriginsOf(win);
    const embedded = anc && anc.length > 0 && anc[anc.length - 1] === args.topOrigin && anc.every((o) => o === args.topOrigin || o === loc.origin);
    if (!isPaymentFrameOrigin(loc.origin) || !embedded) {
      return { status: "origin_mismatch", detail: "payment frame is not embedded by the checkout page" };
    }
  } else if (loc.origin !== args.topOrigin || !framedBySameOrigin(win)) {
    return { status: "origin_mismatch", detail: "frame is embedded by another origin" };
  }
  return fillCardFields(win.document, args.data);
}

// ---- typed cards (save bar) -----------------------------------------------------------------

export interface TypedCard {
  number: string;
  exp: string;
  cardholder: string;
  cvv: string;
}

function selectedText(sel: HTMLSelectElement): HTMLOptionElement | null {
  return sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex] ?? null) : null;
}

/**
 * The card a user typed into the checkout fields inside `scope`, read at
 * submit time; null unless the number passes the Luhn check.
 */
export function readTypedCard(doc: Document, scope: ParentNode = doc): TypedCard | null {
  const inScope = (el: Element) => scope === doc || (scope as Node).contains(el);
  const fields = findCardFields(doc).filter((f) => inScope(f.el));
  const digits = fields
    .filter((f) => f.kind === "number" && !isSelect(f.el))
    .map((f) => digitsOf(f.el.value))
    .join("");
  if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return null;
  const valueOf = (kind: CardFieldKind) => fields.find((f) => f.kind === kind && f.el.value)?.el;
  let exp = "";
  const combined = valueOf("exp");
  if (combined && !isSelect(combined)) {
    const v = combined.value.trim();
    const m = /^(\d{4})-(\d{2})$/.exec(v); // type=month
    const e = m ? { month: Number(m[2]), year: Number(m[1]) } : parseExpiry(v.replace(/\s+/g, ""));
    if (e) exp = `${String(e.month).padStart(2, "0")}/${String(e.year % 100).padStart(2, "0")}`;
  } else {
    const mEl = valueOf("expMonth");
    const yEl = valueOf("expYear");
    const month = mEl ? (isSelect(mEl) ? monthOfOption(selectedText(mEl)!) : Number(digitsOf(mEl.value))) : null;
    const year = yEl ? (isSelect(yEl) ? yearOfOption(selectedText(yEl)!) : Number(digitsOf(yEl.value))) : null;
    if (month && month >= 1 && month <= 12 && year) {
      const y = year < 100 ? 2000 + year : year;
      exp = `${String(month).padStart(2, "0")}/${String(y % 100).padStart(2, "0")}`;
    }
  }
  const name = valueOf("name")?.value.trim() ?? [valueOf("givenName")?.value.trim(), valueOf("familyName")?.value.trim()].filter(Boolean).join(" ");
  const cvvRaw = valueOf("cvc")?.value.trim() ?? "";
  return { number: digits, exp, cardholder: name, cvv: /^\d{3,4}$/.test(cvvRaw) ? cvvRaw : "" };
}
