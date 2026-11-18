"use client";

/**
 * The desktop's half of the linked-box switcher (box-switcher.ts holds the
 * rules): Ctrl+Shift+1 … Ctrl+Shift+9 anywhere on the page — the Terminal and
 * the code editor included, neither uses the combination — shows that box.
 * The listener is on `window` in the CAPTURE phase, so a focused app that
 * stops a key from bubbling (xterm does) never hides the shortcut from it. A
 * key pressed inside an app that is another web page (a frame) goes to that
 * page, as every desktop shortcut's does.
 *
 * In the kiosk Chrome the extension switches (as tabs) and marks the page
 * (KIOSK_SWITCHER_ATTR); this hook then leaves the keys alone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ARRIVAL_STORAGE_KEY,
  CARRIED_STORAGE_KEY,
  KIOSK_SWITCHER_ATTR,
  LINKED_BOXES_CHANGED_EVENT,
  LINKED_BOXES_URL,
  MAX_WORKSPACES,
  boxSwitchSlot,
  decodeCarried,
  effectiveWorkspaces,
  encodeCarried,
  planSwitch,
  readCarriedHash,
  type CarriedSet,
  type SwitchPlan,
  type Workspace,
} from "./box-switcher";
import { parseLinkedBoxesRead, normalizeBoxName, type LinkedBox } from "./linked-boxes-shape";

export interface BoxSwitcherIndicator {
  /** A new number per showing, so the same slot twice restarts the timer. */
  id: number;
  slot: number;
  kind: SwitchPlan["kind"];
  name: string | null;
  workspaces: Workspace[];
}

/** How long the indicator stays up (a switch that leaves the page keeps it until the page goes). */
export const INDICATOR_MS = 1800;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Take the numbering a switch carried here out of the address (so it is never
 * bookmarked, shared or reloaded) into this tab's sessionStorage. Run by the
 * desktop and by /login, where the box's middleware sends a tab that is not
 * signed in yet: the browser keeps the fragment across that redirect, and the
 * desktop reads the stash once the owner has signed in.
 */
export function takeCarriedFromLocation(): void {
  if (typeof window === "undefined") return;
  const { ours, carried } = readCarriedHash(window.location.hash);
  if (!ours) return;
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  } catch {
    // An address that cannot be rewritten keeps its fragment; nothing reads it twice.
  }
  const store = storage();
  if (!store || !carried) return;
  try {
    store.setItem(CARRIED_STORAGE_KEY, encodeCarried(carried));
    store.setItem(ARRIVAL_STORAGE_KEY, String(carried.to));
  } catch {
    // Storage full or refused: the tab keeps this box's own numbering.
  }
}

function readCarriedStash(): CarriedSet | null {
  const raw = storage()?.getItem(CARRIED_STORAGE_KEY);
  return raw ? decodeCarried(raw) : null;
}

/** The slot a switch asked for, once: the desktop shows it on arrival. */
function takeArrival(): number | null {
  const store = storage();
  const raw = store?.getItem(ARRIVAL_STORAGE_KEY);
  if (!raw) return null;
  store?.removeItem(ARRIVAL_STORAGE_KEY);
  const slot = Number(raw);
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_WORKSPACES ? slot : null;
}

interface ListAnswer {
  selfName: string;
  boxes: LinkedBox[];
}

async function fetchList(): Promise<ListAnswer | null> {
  try {
    const res = await fetch(LINKED_BOXES_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { self?: { name?: unknown }; boxes?: unknown };
    return {
      selfName: normalizeBoxName(body?.self?.name) ?? "ClawBox",
      boxes: parseLinkedBoxesRead(body?.boxes),
    };
  } catch {
    return null;
  }
}

/**
 * `enabled`: the owner's desktop, once it is known who is signed in (the
 * route is the owner's alone). Returns the indicator to draw, or null.
 */
export function useBoxSwitcher(enabled: boolean): { indicator: BoxSwitcherIndicator | null; dismiss: () => void } {
  const [list, setList] = useState<ListAnswer | null>(null);
  const [indicator, setIndicator] = useState<BoxSwitcherIndicator | null>(null);
  const seq = useRef(0);
  const carried = useRef<CarriedSet | null>(null);
  const arrivalShown = useRef(false);
  const reload = useRef<() => void>(() => {});

  // Before anything else, whoever is signed in: the address loses the fragment.
  useEffect(() => {
    takeCarriedFromLocation();
    carried.current = readCarriedStash();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Only the newest ask's answer counts: an older one still on its way when
    // Settings saved must not put the old list back over the new one.
    let asked = 0;
    const load = () => {
      const mine = ++asked;
      void fetchList().then((answer) => {
        if (live && answer && mine === asked) setList(answer);
      });
    };
    // Again whenever Settings saves it (here or in another window, which the
    // page sees as being shown again), and on a key press while it has none.
    const onShown = () => {
      if (!document.hidden) load();
    };
    reload.current = load;
    load();
    window.addEventListener(LINKED_BOXES_CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", onShown);
    return () => {
      live = false;
      reload.current = () => {};
      window.removeEventListener(LINKED_BOXES_CHANGED_EVENT, load);
      document.removeEventListener("visibilitychange", onShown);
    };
  }, [enabled]);

  const stateNow = useCallback(() => {
    if (!list) return null;
    const hereOrigin = window.location.origin;
    const state = effectiveWorkspaces({ selfName: list.selfName, hereOrigin, boxes: list.boxes, carried: carried.current });
    // Home again (or a numbering this box cannot vouch for): the tab is back on this box's own.
    if (!state.carried && carried.current) {
      carried.current = null;
      storage()?.removeItem(CARRIED_STORAGE_KEY);
    }
    return state;
  }, [list]);

  const show = useCallback((plan: SwitchPlan, workspaces: Workspace[]) => {
    seq.current += 1;
    setIndicator({
      id: seq.current,
      slot: plan.slot,
      kind: plan.kind,
      name: plan.kind === "empty" ? null : plan.workspace.name,
      workspaces,
    });
  }, []);

  // The switch that brought this tab here: say where it is, once.
  useEffect(() => {
    if (!enabled || !list || arrivalShown.current) return;
    arrivalShown.current = true;
    const slot = takeArrival();
    const state = stateNow();
    if (slot === null || !state) return;
    const workspace = state.workspaces.find((w) => w.slot === slot);
    if (workspace) show({ kind: "stay", slot, workspace }, state.workspaces);
  }, [enabled, list, stateNow, show]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const slot = boxSwitchSlot(e);
      if (slot === null) return;
      if (document.documentElement.hasAttribute(KIOSK_SWITCHER_ATTR)) return;
      const state = stateNow();
      // No list yet (still on its way, or the box did not answer): the key is
      // left alone rather than swallowed, and the list asked for again.
      if (!state) {
        reload.current();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const plan = planSwitch(slot, state);
      show(plan, state.workspaces);
      if (plan.kind === "go") window.location.assign(plan.url);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, stateNow, show]);

  const dismiss = useCallback(() => setIndicator(null), []);
  return { indicator, dismiss };
}
