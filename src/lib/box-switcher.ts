/**
 * The linked-box switcher (TASK-2519): Ctrl+Shift+1 … Ctrl+Shift+9 on a
 * ClawBox desktop shows box 1 … 9, like workspaces. Slot 1 is THIS box, slots
 * 2–9 the list in Settings → Linked ClawBoxes (linked-boxes-shape.ts). Pure
 * — no DOM, no fetch — so every decision here is a unit test; the desktop's
 * hook (use-box-switcher.ts) feeds it real events and a real location.
 *
 * Two places switch:
 *
 *  - The kiosk Chrome (an x64 ClawBox's own screen, `--kiosk`, no tab strip):
 *    the kiosk extension (kiosk/extension/workspaces.js) takes the keys on
 *    EVERY page, keeps each box in a tab of its own and activates it. It
 *    marks the page with KIOSK_SWITCHER_ATTR, and the desktop's own handler
 *    stands down wherever that mark is.
 *  - Any other browser: the desktop navigates the tab to the other box's
 *    desktop. The numbers travel with it, in the address's fragment (never
 *    sent to a server): `#clawbox-boxes=<base64url JSON>`, the numbering the
 *    owner started from (`boxes[0]` is that home box) and the slot asked for.
 *    The box arrived at (when it runs this version) keeps that numbering for
 *    the tab, so Ctrl+Shift+1 there goes home again — but only to boxes IT
 *    lists too (`effectiveWorkspaces`): a crafted link must not be able to
 *    make a key press take the owner anywhere their own boxes do not list.
 */
import {
  MAX_LINKED_BOXES,
  boxOrigin,
  normalizeBoxName,
  normalizeBoxUrl,
  type LinkedBox,
} from "./linked-boxes-shape";

/** This box and the eight linked ones. */
export const MAX_WORKSPACES = MAX_LINKED_BOXES + 1;

/** On <html> while the kiosk extension switches boxes itself (as tabs). */
export const KIOSK_SWITCHER_ATTR = "data-clawbox-box-switcher";

/** Fired on `window` after Settings saves the list, so every reader asks again. */
export const LINKED_BOXES_CHANGED_EVENT = "clawbox:linked-boxes-changed";

export const LINKED_BOXES_URL = "/setup-api/linked-boxes";

/** The fragment that carries the numbering to the next box. */
export const CARRY_PREFIX = "#clawbox-boxes=";
/** sessionStorage: the numbering this tab arrived with (this origin's copy). */
export const CARRIED_STORAGE_KEY = "clawbox:linked-boxes:carried";
/** sessionStorage: the slot the last switch asked for, until the desktop shows it. */
export const ARRIVAL_STORAGE_KEY = "clawbox:linked-boxes:arrived";

export interface SwitchKeyLike {
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/**
 * The slot a key press asks for (1–9), or null. By `code`, never `key`: with
 * Shift held `key` is "!" or "@" on one layout and "+" or "ě" on another,
 * while `code` names the physical key on every layout. The number row only —
 * with Shift held, the keypad's digits are its navigation keys.
 */
export function boxSwitchSlot(e: SwitchKeyLike): number | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.isComposing) return null;
  const m = /^Digit([1-9])$/.exec(e.code ?? "");
  return m ? Number(m[1]) : null;
}

export interface Workspace {
  slot: number;
  name: string;
  /** The box's desktop, or null for a slot of the carried numbering this box does not list. */
  url: string | null;
  /** The box this page is on. */
  here: boolean;
}

export interface CarriedSet {
  /** The numbering, `boxes[0]` the box it started from. */
  boxes: LinkedBox[];
  /** The slot the switch asked for. */
  to: number;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The longest fragment read: nine boxes at their longest, encoded. */
const MAX_CARRY_LENGTH = 8192;

export function encodeCarried(set: CarriedSet): string {
  return toBase64Url(JSON.stringify({ v: 1, to: set.to, b: set.boxes.map((b) => [b.name, b.url]) }));
}

/** A carried numbering, rebuilt from its own rules, or null for anything else. */
export function decodeCarried(text: string): CarriedSet | null {
  if (!text || text.length > MAX_CARRY_LENGTH) return null;
  const json = fromBase64Url(text);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { v, to, b } = raw as { v?: unknown; to?: unknown; b?: unknown };
  if (v !== 1 || !Array.isArray(b) || b.length < 1 || b.length > MAX_WORKSPACES) return null;
  if (typeof to !== "number" || !Number.isInteger(to) || to < 1 || to > b.length) return null;
  const boxes: LinkedBox[] = [];
  for (const entry of b) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const name = normalizeBoxName(entry[0]);
    const url = normalizeBoxUrl(entry[1]);
    if (name === null || url === null) return null;
    boxes.push({ name, url });
  }
  return { boxes, to };
}

/** The carried numbering in a location's fragment, or null (and whether the fragment was one of ours at all). */
export function readCarriedHash(hash: string): { ours: boolean; carried: CarriedSet | null } {
  if (!hash.startsWith(CARRY_PREFIX)) return { ours: false, carried: null };
  return { ours: true, carried: decodeCarried(hash.slice(CARRY_PREFIX.length)) };
}

export interface SwitcherState {
  workspaces: Workspace[];
  /** What a switch from here carries on: the numbering in use, names and addresses. */
  numbering: LinkedBox[];
  /** True while the tab keeps the numbering of the box it started from. */
  carried: boolean;
}

/** This box's own numbering: itself, then its list. */
export function ownWorkspaces(selfName: string, hereOrigin: string, boxes: LinkedBox[]): SwitcherState {
  const numbering: LinkedBox[] = [{ name: selfName, url: `${hereOrigin}/` }, ...boxes.slice(0, MAX_LINKED_BOXES)];
  return {
    workspaces: numbering.map((b, i) => ({
      slot: i + 1,
      name: b.name,
      url: b.url,
      here: i === 0 || boxOrigin(b.url) === hereOrigin,
    })),
    numbering,
    carried: false,
  };
}

/**
 * The numbering a key press on this page uses. This box's own, unless the tab
 * arrived carrying another box's — and that one is kept only when its home is
 * a box this box lists too (the way back is one the owner set up here), and
 * then with every slot this box does not list left without an address.
 * Arriving back at the home box ends the carried numbering.
 *
 * What a slot is CALLED comes from this box's own list wherever it lists the
 * box (this box itself is its own name), so a link cannot make the indicator
 * call a box something else; only the ORDER is the home box's — the point of
 * carrying it — and every slot still leads to a box the owner listed here.
 */
export function effectiveWorkspaces(opts: {
  selfName: string;
  hereOrigin: string;
  boxes: LinkedBox[];
  carried: CarriedSet | null;
}): SwitcherState {
  const own = ownWorkspaces(opts.selfName, opts.hereOrigin, opts.boxes);
  const carried = opts.carried;
  if (!carried || carried.boxes.length === 0) return own;
  const homeOrigin = boxOrigin(carried.boxes[0].url);
  if (!homeOrigin || homeOrigin === opts.hereOrigin) return own;
  const known = new Map<string, string>([[opts.hereOrigin, opts.selfName]]);
  for (const b of opts.boxes) {
    const o = boxOrigin(b.url);
    if (o && !known.has(o)) known.set(o, b.name);
  }
  if (!known.has(homeOrigin)) return own;
  const origins = carried.boxes.map((b) => boxOrigin(b.url));
  // Reached under another address than the one the list gave (a redirect,
  // another hostname): the slot asked for is the one this page is.
  const anyHere = origins.includes(opts.hereOrigin);
  return {
    workspaces: carried.boxes.map((b, i) => {
      const origin = origins[i];
      const ownName = origin ? known.get(origin) : undefined;
      return {
        slot: i + 1,
        name: ownName ?? b.name,
        url: ownName !== undefined ? `${origin}/` : null,
        here: anyHere ? origin === opts.hereOrigin : i + 1 === carried.to,
      };
    }),
    numbering: carried.boxes,
    carried: true,
  };
}

export type SwitchPlan =
  /** Already on that box. */
  | { kind: "stay"; slot: number; workspace: Workspace }
  /** Open the box: `url` carries the numbering on. */
  | { kind: "go"; slot: number; workspace: Workspace; url: string }
  /** Nothing in that slot. */
  | { kind: "empty"; slot: number }
  /** A carried slot this box does not list. */
  | { kind: "unlinked"; slot: number; workspace: Workspace };

export function planSwitch(slot: number, state: SwitcherState): SwitchPlan {
  const workspace = state.workspaces.find((w) => w.slot === slot);
  if (!workspace) return { kind: "empty", slot };
  if (workspace.here) return { kind: "stay", slot, workspace };
  if (!workspace.url) return { kind: "unlinked", slot, workspace };
  const url = `${workspace.url}${CARRY_PREFIX}${encodeCarried({ boxes: state.numbering, to: slot })}`;
  return { kind: "go", slot, workspace, url };
}
