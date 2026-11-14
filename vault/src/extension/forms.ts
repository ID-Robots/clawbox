// Login form detection and filling, DOM-only so it runs in the content script
// and in the DOM tests alike.
//
// Detection: a visible password input plus the nearest username/email input
// before it; a username-only page (step one of a two-step login); or a
// password-only page (step two). Filling uses the native value setter of the
// input's own window and then dispatches input/change/blur, so React, Vue and
// Angular controlled inputs register the value.
import { isSecureOrLocal } from "../shared/hosts";

export type LoginStep = "full" | "username" | "password";

export interface LoginForm {
  form: HTMLFormElement | null;
  username: HTMLInputElement | null;
  /** Fields that receive the password (two on sign-up forms: new + confirm). */
  passwords: HTMLInputElement[];
  step: LoginStep;
  submit: HTMLElement | null;
}

export interface FillOutcome {
  status: "filled" | "no_form";
  step?: LoginStep;
  submitted?: boolean;
  detail?: string;
}

const USER_HINT = /user|login|e-?mail|account|identifier|ident|signin|sign-in|uname|nick|member|customer|phone/i;
const USER_EXCLUDE = /search|query|captcha|otp|one.?time|2fa|totp|token|coupon|promo|voucher|zip|postal|city|street|address|first.?name|last.?name|given|family/i;
const TEXT_TYPES = new Set(["", "text", "email", "tel"]);
const SUBMIT_TEXT = /^(log\s?-?in|sign\s?-?in|sign\s?on|continue|next|submit|go|enter|weiter|anmelden|connexion|se connecter|entrar|iniciar sesi[oó]n|accedi|вход|войти|далее|продължи|влез)$/i;

/** Buttons that move a username-only page on to the password page. */
const STEP_ONE_TEXT = /^(log\s?-?in|sign\s?-?in|sign\s?on|continue|next|weiter|anmelden|connexion|se connecter|entrar|iniciar sesi[oó]n|accedi|вход|войти|далее|продължи|влез)$/i;

/** DOCUMENT_POSITION_FOLLOWING, without relying on a global Node. */
const FOLLOWING = 4;

function ac(el: Element): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase();
}

function hasLayout(doc: Document): boolean {
  const r = doc.documentElement?.getBoundingClientRect?.();
  return Boolean(r && (r.width > 0 || r.height > 0));
}

export function isVisible(el: Element): boolean {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    const style = win?.getComputedStyle(node);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) return false;
    if (style && node === el && style.opacity !== "" && Number(style.opacity) === 0) return false;
  }
  // Layout checks only where there is layout (a real page, not a DOM test).
  if (hasLayout(doc)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
  }
  return true;
}

function usable(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly && isVisible(input);
}

function inputs(scope: ParentNode): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll("input")) as HTMLInputElement[];
}

function isPasswordField(input: HTMLInputElement): boolean {
  return input.type === "password" && !ac(input).includes("one-time-code");
}

function labelText(input: HTMLInputElement): string {
  const parts: string[] = [];
  const id = input.id;
  if (id) {
    const label = input.ownerDocument.querySelector(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  const wrapping = input.closest("label");
  if (wrapping?.textContent) parts.push(wrapping.textContent);
  return parts.join(" ");
}

/** How much an input looks like a username/email field (<= 0: not one). */
export function usernameScore(input: HTMLInputElement): number {
  if (!TEXT_TYPES.has(input.type.toLowerCase())) return 0;
  const auto = ac(input);
  if (auto.includes("username")) return 100;
  if (auto.includes("email")) return 80;
  if (auto.includes("one-time-code")) return 0;
  const hints = [input.name, input.id, input.getAttribute("placeholder"), input.getAttribute("aria-label"), labelText(input)]
    .filter(Boolean)
    .join(" ");
  if (USER_EXCLUDE.test(hints)) return 0;
  if (input.type === "email") return 60;
  if (USER_HINT.test(hints)) return 40;
  if (input.type === "tel") return 5;
  return 1;
}

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & FOLLOWING) !== 0;
}

function buttonText(el: Element): string {
  const value = el instanceof el.ownerDocument.defaultView!.HTMLInputElement ? el.value : "";
  return (value || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
}

export function findSubmit(form: HTMLFormElement | null, anchor: Element): HTMLElement | null {
  const doc = anchor.ownerDocument;
  const scope: ParentNode = form ?? doc;
  const after = (el: Element) => form !== null || precedes(anchor, el);
  const explicit = Array.from(scope.querySelectorAll('button[type="submit"], input[type="submit"], input[type="image"]')).filter(
    (el) => isVisible(el) && after(el),
  );
  if (explicit.length) return explicit[0] as HTMLElement;
  if (form) {
    const implicit = Array.from(form.querySelectorAll("button")).find((b) => !b.getAttribute("type") && isVisible(b));
    if (implicit) return implicit;
  }
  const named = Array.from(scope.querySelectorAll('button, [role="button"], input[type="button"], a')).find(
    (el) => isVisible(el) && after(el) && SUBMIT_TEXT.test(buttonText(el)),
  );
  return (named as HTMLElement | undefined) ?? null;
}

export function findLoginForm(doc: Document): LoginForm | null {
  const all = inputs(doc);
  const passwords = all.filter((i) => isPasswordField(i) && usable(i));

  if (passwords.length) {
    const pw = passwords.find((p) => ac(p).includes("current-password")) ?? passwords[0]!;
    const form = pw.form;
    const samePlace = passwords.filter((p) => p.form === form);
    const signUp = samePlace.length >= 2 && samePlace.every((p) => ac(p).includes("new-password"));
    const fillPasswords = signUp ? samePlace : [pw];

    const scope: ParentNode = form ?? doc;
    let best: HTMLInputElement | null = null;
    let bestScore = 0;
    for (const cand of inputs(scope)) {
      if (cand === pw || !usable(cand) || !precedes(cand, pw)) continue;
      const score = usernameScore(cand);
      // ">=" keeps the nearest preceding field among equally good ones.
      if (score > 0 && score >= bestScore) {
        best = cand;
        bestScore = score;
      }
    }
    return { form, username: best, passwords: fillPasswords, step: best ? "full" : "password", submit: findSubmit(form, pw) };
  }

  // Step one of a two-step login: a username/email field with a strong signal,
  // and either autocomplete="username" or a "Next"/"Sign in"-style button, so a
  // newsletter or search box with an email field is not taken for a login.
  const candidates = all
    .filter((c) => usable(c) && usernameScore(c) >= 40)
    .sort((a, b) => usernameScore(b) - usernameScore(a));
  for (const user of candidates) {
    const submit = findSubmit(user.form, user);
    const declared = ac(user).includes("username");
    if (declared ? submit || user.form : submit && STEP_ONE_TEXT.test(buttonText(submit))) {
      return { form: user.form, username: user, passwords: [], step: "username", submit };
    }
  }
  return null;
}

/** Set a value the way a user would: native setter, then input/change/blur. */
export function fillInput(input: HTMLInputElement, value: string): void {
  const win = input.ownerDocument.defaultView;
  const proto = win ? win.HTMLInputElement.prototype : Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  input.focus();
  // If the DOM already shows this value (an earlier plain assignment), reset it
  // through the instance property first, so value trackers (React) see a change.
  if (input.value === value) input.value = "";
  if (setter) setter.call(input, value);
  else input.value = value;
  const EventCtor = win?.Event ?? Event;
  input.dispatchEvent(new EventCtor("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  input.blur();
}

function nextTick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fillLogin(
  doc: Document,
  creds: { login: string; password: string; submit?: boolean },
): Promise<FillOutcome> {
  const found = findLoginForm(doc);
  if (!found) return { status: "no_form" };
  if (found.step === "username" && !creds.login) return { status: "no_form", detail: "username step, but the entry has no login" };
  if (found.username && creds.login) fillInput(found.username, creds.login);
  for (const pw of found.passwords) fillInput(pw, creds.password);

  let submitted = false;
  if (creds.submit) {
    // Let frameworks flush the state updates from the input events first.
    await nextTick(50);
    if (found.submit) {
      found.submit.click();
      submitted = true;
    } else if (found.form) {
      found.form.requestSubmit();
      submitted = true;
    }
  }
  return { status: "filled", step: found.step, submitted };
}

/** All ancestor frames share this frame's origin (true for the top frame). */
export function framedBySameOrigin(win: Window): boolean {
  const own = win.location.origin;
  const anc = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (anc && typeof anc.length === "number") {
    for (let i = 0; i < anc.length; i++) if (anc[i] !== own) return false;
    return true;
  }
  let w: Window = win;
  for (let depth = 0; depth < 32; depth++) {
    let parent: Window;
    try {
      if (w === w.top) return true;
      parent = w.parent;
      if (!parent || parent === w) return true;
      if (parent.location.origin !== own) return false;
    } catch {
      return false; // cross-origin parents throw on access
    }
    w = parent;
  }
  return false;
}

export interface FrameReport {
  origin: string;
  ancestorsSameOrigin: boolean;
  hasForm: boolean;
  step: LoginStep | null;
}

export function probeFrame(win: Window): FrameReport {
  const found = findLoginForm(win.document);
  return {
    origin: win.location.origin,
    ancestorsSameOrigin: framedBySameOrigin(win),
    hasForm: Boolean(found),
    step: found?.step ?? null,
  };
}

export type GuardedOutcome = FillOutcome | { status: "origin_mismatch"; detail: string };

/**
 * Fill inside one frame, but only if this frame is exactly the origin the
 * background approved, is https (or http on localhost), and is not embedded
 * by another origin.
 */
export async function guardedFill(
  win: Window,
  args: { login: string; password: string; allowedOrigin: string; submit?: boolean },
): Promise<GuardedOutcome> {
  const loc = win.location;
  if (loc.origin !== args.allowedOrigin || !isSecureOrLocal(loc.protocol, loc.hostname)) {
    return { status: "origin_mismatch", detail: "frame origin differs from the entry" };
  }
  if (!framedBySameOrigin(win)) return { status: "origin_mismatch", detail: "frame is embedded by another origin" };
  return fillLogin(win.document, args);
}

export interface CapturedLogin {
  login: string;
  password: string;
}

/**
 * Credentials a user typed into a form, read at submit time. For change and
 * sign-up forms the new password wins over the current one.
 */
export function readTypedCredentials(scope: ParentNode): CapturedLogin | null {
  const fields = inputs(scope).filter((i) => isPasswordField(i) && i.value);
  const fresh = fields.filter((i) => ac(i).includes("new-password"));
  const pw = (fresh.length ? fresh[fresh.length - 1] : fields[0]) ?? null;
  let login = "";
  const anchor = pw ?? null;
  let bestScore = 0;
  for (const cand of inputs(scope)) {
    if (!cand.value || cand.type === "password" || cand.type === "hidden") continue;
    if (anchor && !precedes(cand, anchor)) continue;
    const score = usernameScore(cand);
    if (score > 0 && score >= bestScore) {
      login = cand.value.trim();
      bestScore = score;
    }
  }
  if (!pw) {
    // Username step: report only a strong username signal.
    return bestScore >= 40 && login ? { login, password: "" } : null;
  }
  return { login, password: pw.value };
}
