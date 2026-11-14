// Pure decisions of the background worker: which tab an agent fill goes to and
// which frame of that tab may receive the credentials.
import { isFillAllowedUrl, matchUrl, originOf, parseWebUrl } from "../shared/domain";
import { isPaymentFrameOrigin } from "../shared/hosts";
import type { CardFieldKind } from "./cardforms";
import type { LoginStep } from "./forms";

export interface TabInfo {
  id?: number;
  url?: string;
  active?: boolean;
  lastAccessed?: number;
}

export type TabChoice = { status: "ok"; tabId: number; url: string } | { status: "no_tab" | "origin_mismatch"; detail?: string };

/**
 * The tab to fill: its URL must match the entry and be fillable. Prefer a tab
 * on the exact origin the agent asked for, then the active one, then the most
 * recently used.
 */
export function pickTab(tabs: TabInfo[], entryUrl: string, requestedUrl: string): TabChoice {
  const wanted = originOf(requestedUrl);
  const candidates = tabs.filter((t) => t.id !== undefined && t.url && matchUrl(entryUrl, t.url));
  if (!candidates.length) {
    const insecure = tabs.some((t) => {
      const u = parseWebUrl(t.url);
      return u && u.protocol === "http:" && !isFillAllowedUrl(u) && matchUrl(entryUrl, `https://${u.host}`);
    });
    return insecure
      ? { status: "origin_mismatch", detail: "the matching tab is plain http://" }
      : { status: "no_tab" };
  }
  const score = (t: TabInfo) => (originOf(t.url) === wanted ? 4 : 0) + (t.active ? 2 : 0);
  candidates.sort((a, b) => score(b) - score(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const best = candidates[0]!;
  return { status: "ok", tabId: best.id!, url: best.url! };
}

export interface FrameProbe {
  frameId: number;
  /** location.origin of the frame ("null" for sandboxed/opaque frames). */
  origin: string;
  /** Every ancestor frame has the same origin as this frame. */
  ancestorsSameOrigin: boolean;
  hasForm: boolean;
  step: LoginStep | null;
}

export type FrameChoice = { status: "ok"; frameId: number; origin: string } | { status: "no_form" | "origin_mismatch"; detail?: string };

const STEP_RANK: Record<LoginStep, number> = { full: 0, password: 1, username: 2 };

/**
 * Only the top frame, or same-origin iframes whose origin matches the entry,
 * may receive credentials. A form found only in another frame is refused.
 */
export function chooseFillFrame(
  frames: FrameProbe[],
  tabUrl: string,
  entryUrl: string,
  opts: { needPassword?: boolean } = {},
): FrameChoice {
  if (!isFillAllowedUrl(tabUrl)) return { status: "origin_mismatch", detail: "the page is plain http://" };
  if (!matchUrl(entryUrl, tabUrl)) return { status: "origin_mismatch", detail: "the tab does not match the entry" };
  const topOrigin = originOf(tabUrl);

  const eligible = (f: FrameProbe) => {
    if (!f.origin || f.origin === "null" || !matchUrl(entryUrl, f.origin)) return false;
    if (f.frameId === 0) return true;
    return f.origin === topOrigin && f.ancestorsSameOrigin;
  };
  const withForm = frames.filter((f) => f.hasForm && f.step && (!opts.needPassword || f.step !== "username"));
  if (!withForm.length) return { status: "no_form" };
  const ok = withForm.filter(eligible);
  if (!ok.length) return { status: "origin_mismatch", detail: "the login form is in a frame from another origin" };
  // A real login form beats a lone email field; among equals the top frame wins.
  ok.sort((a, b) => STEP_RANK[a.step!] - STEP_RANK[b.step!] || (a.frameId === 0 ? -1 : 0) - (b.frameId === 0 ? -1 : 0));
  const best = ok[0]!;
  // The real login form is elsewhere (another origin): do not settle for a stray email field.
  const bestAnywhere = Math.min(...withForm.map((f) => STEP_RANK[f.step!]));
  if (STEP_RANK[best.step!] > bestAnywhere) {
    return { status: "origin_mismatch", detail: "the login form is in a frame from another origin" };
  }
  return { status: "ok", frameId: best.frameId, origin: best.origin };
}

// ---- cards ---------------------------------------------------------------------------

/**
 * The tab for an agent card fill: on exactly the origin the agent named and
 * fillable (https, or http on localhost). Active tab first, then most recent.
 */
export function pickCardTab(tabs: TabInfo[], requestedUrl: string): TabChoice {
  const wanted = originOf(requestedUrl);
  if (!wanted || !isFillAllowedUrl(requestedUrl)) return { status: "origin_mismatch", detail: "cards are filled only into https:// pages" };
  const candidates = tabs.filter((t) => t.id !== undefined && t.url && isFillAllowedUrl(t.url) && originOf(t.url) === wanted);
  if (!candidates.length) return { status: "no_tab" };
  candidates.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const best = candidates[0]!;
  return { status: "ok", tabId: best.id!, url: best.url! };
}

export interface CardFrameProbe {
  frameId: number;
  origin: string;
  /** Parent first, top last; [] for the top frame; null when unknown. */
  ancestorOrigins: string[] | null;
  kinds: CardFieldKind[];
}

export interface CardTarget {
  frameId: number;
  origin: string;
  kinds: CardFieldKind[];
  paymentFrame: boolean;
}

export type CardPlan =
  | { status: "ok"; topOrigin: string; targets: CardTarget[]; skipped: number }
  | { status: "no_form" | "origin_mismatch"; detail?: string };

/**
 * How a frame may receive card data: "top", "same-origin" (an iframe of the
 * page's own origin, embedded only by that origin), "payment" (an allowed
 * provider frame embedded by the page, only when the human started the fill in
 * this tab), or null: refused.
 */
export function cardFrameAccess(f: CardFrameProbe, topOrigin: string, allowPaymentFrames: boolean): "top" | "same-origin" | "payment" | null {
  if (!f.origin || f.origin === "null") return null;
  if (f.frameId === 0) return f.origin === topOrigin ? "top" : null;
  const anc = f.ancestorOrigins;
  if (!anc || !anc.length || anc[anc.length - 1] !== topOrigin) return null;
  if (f.origin === topOrigin && anc.every((o) => o === topOrigin)) return "same-origin";
  if (allowPaymentFrames && isPaymentFrameOrigin(f.origin) && anc.every((o) => o === topOrigin || o === f.origin)) return "payment";
  return null;
}

/**
 * Which frames of a tab get which card fields. The card number must sit in a
 * frame that may receive it; card fields in any other frame are skipped.
 */
export function planCardFill(frames: CardFrameProbe[], tabUrl: string, opts: { allowPaymentFrames: boolean }): CardPlan {
  if (!isFillAllowedUrl(tabUrl)) return { status: "origin_mismatch", detail: "the page is plain http://" };
  const topOrigin = originOf(tabUrl)!;
  const withFields = frames.filter((f) => f.kinds.length);
  if (!withFields.length) return { status: "no_form" };
  const targets: CardTarget[] = [];
  let skipped = 0;
  for (const f of withFields) {
    const access = cardFrameAccess(f, topOrigin, opts.allowPaymentFrames);
    if (access) targets.push({ frameId: f.frameId, origin: f.origin, kinds: f.kinds, paymentFrame: access === "payment" });
    else skipped++;
  }
  if (!targets.some((t) => t.kinds.includes("number"))) {
    const elsewhere = withFields.some((f) => f.kinds.includes("number"));
    if (!elsewhere) return { status: "no_form", detail: "no card number field on this page" };
    const payment = withFields.some((f) => f.kinds.includes("number") && isPaymentFrameOrigin(f.origin));
    return {
      status: "origin_mismatch",
      detail: payment && !opts.allowPaymentFrames
        ? "the card fields are in a payment provider frame: start the fill in this tab yourself"
        : "the card fields are in a frame from another origin",
    };
  }
  return { status: "ok", topOrigin, targets, skipped };
}

/** Frames that may show the card chip: those a user-started fill could reach. */
export function chipAllowed(frameId: number, frameOrigin: string | undefined, tabUrl: string | undefined): boolean {
  if (!tabUrl || !frameOrigin || !isFillAllowedUrl(tabUrl)) return false;
  const top = originOf(tabUrl);
  if (frameId === 0) return frameOrigin === top;
  return frameOrigin === top || isPaymentFrameOrigin(frameOrigin);
}
