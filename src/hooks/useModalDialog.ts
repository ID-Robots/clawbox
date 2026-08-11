"use client";

import { useEffect, useRef, type RefObject } from "react";

// One modal-dialog behaviour for the whole desktop.
//
// Every overlay on the device used to hand-roll this and each one missed
// something different: the app store's install confirmation never moved focus
// in at all (so a keyboard user tabbed straight through it into the page
// behind and could not reach "Install anyway"), the sign-in and upgrade
// modals moved focus in but never trapped or restored it, and the system
// update dialog had a working trap that nothing else could reuse. This hook is
// that trap, extracted from the Hermes skills store's ConfirmDialog — the one
// implementation that was already correct — so there is a single place to fix.
//
// What a caller gets by attaching the returned ref to the dialog PANEL:
//   - focus moves into the panel on open, and back to the trigger on close
//   - Tab / Shift-Tab cycle inside the panel instead of walking the page
//   - Escape closes (and stops there, so the window behind doesn't also close)
//   - everything outside the panel is `inert` + `aria-hidden` while it is open
//
// The caller still owns the markup: put `role="dialog"` (or `alertdialog`),
// `aria-modal="true"` and an `aria-labelledby` on the same element the ref is
// attached to. The role belongs on the panel, not on the full-screen backdrop —
// on the backdrop the accessible dialog would be the whole viewport, and its
// accessible name would swallow every bit of text behind the scrim.

// Candidate types only — `disabled`, `hidden` and `inert` are all filtered
// below rather than encoded here, so the rule for "can this take focus" lives
// in exactly one place. (The selector form would also miss a `[tabindex]`
// element carrying `disabled`.)
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  // Broad on purpose — the effective state is decided in the filter, not here.
  // `[contenteditable='true']` alone missed the equally-editable `""` and
  // `"plaintext-only"`, and `[tabindex]:not([tabindex='-1'])` still matched
  // `tabindex="-2"`, which is not focusable either.
  "[contenteditable]",
  "[tabindex]",
].join(",");

/**
 * Focusable descendants, in DOM order, skipping anything hidden or inert.
 *
 * Exported for its own unit tests: the visibility branch below cannot be
 * reached through the React components, because the engine that implements
 * `checkVisibility` is the one the component tests do not run in.
 */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    // `:disabled` is the EFFECTIVE state — it covers a control disabled by an
    // ancestor <fieldset>, and equally it does not fire for `<a href disabled>`
    // or `<div tabindex="0" disabled>`, where HTML gives the attribute no
    // meaning and the element stays focusable. Testing the raw attribute would
    // wrongly drop those.
    if (el.matches(":disabled")) return false;
    // Any negative tabindex is out of the tab order, not just -1.
    if (el.hasAttribute("tabindex") && el.tabIndex < 0) return false;
    // `contenteditable` is editable at "", "true" and "plaintext-only"; only an
    // explicit "false" opts out. Read from the attribute rather than
    // `isContentEditable`, which jsdom does not implement.
    //
    // "false" removes only the EDITING affordance, so it disqualifies an
    // element that had nothing else going for it — never a button, link or
    // anything explicitly tabbable, all of which report tabIndex >= 0.
    if (el.hasAttribute("contenteditable") && el.tabIndex < 0) {
      const mode = (el.getAttribute("contenteditable") || "").toLowerCase();
      if (mode === "false") return false;
    }
    // `closest` covers the element itself, so one test catches both an element
    // that is hidden/inert/aria-hidden and one nested inside such a subtree —
    // focus must never land on content excluded from the accessibility tree.
    if (el.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false;
    // Capability check, not an environment check: `checkVisibility` is CSSOM-View
    // and needs a layout engine. `visibilityProperty` adds `visibility: hidden`
    // to the default display/content-visibility tests; opacity is deliberately
    // excluded, since a 0-opacity control is still focusable and still reachable
    // by a screen reader.
    //
    // Consequence worth knowing: jsdom does not implement it, so this filter is
    // inert under the component tests and every control there counts. That is
    // why it has direct unit tests with a stubbed implementation.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) {
      return false;
    }
    return true;
  });

  // Put the list in TAB order, which is not DOM order when a positive tabindex
  // is present: those are visited first, ascending, before everything at 0.
  // The trap treats the first and last entries as its wrap boundaries, so a
  // DOM-ordered list would put the boundaries in the wrong place and let Tab
  // walk straight out of the dialog. Sort is stable, so ties keep DOM order.
  return candidates.sort((a, b) => {
    const ai = a.tabIndex > 0 ? a.tabIndex : Number.MAX_SAFE_INTEGER;
    const bi = b.tabIndex > 0 ? b.tabIndex : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/**
 * Hide everything outside `panel` from assistive tech and from the tab order.
 *
 * Walks from the panel up to <body>, marking each ancestor's siblings rather
 * than only the top-level children of <body>: these dialogs render inline in
 * the React tree (not through a portal), so the page behind them is a sibling
 * several levels down, not a sibling of the app root.
 *
 * Returns an undo function. Each element's prior attribute values are captured
 * and put back, rather than blindly removed, so a dialog opened over another
 * dialog does not strip the outer one's marking when it closes.
 */
function hideOutside(panel: HTMLElement): () => void {
  const touched: { el: Element; inert: string | null; ariaHidden: string | null }[] = [];
  let node: Element | null = panel;
  while (node && node.parentElement && node !== document.body) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node) continue;
      // Scripts and style tags are not in the a11y tree; marking them is noise.
      const tag = sibling.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") continue;
      touched.push({
        el: sibling,
        inert: sibling.getAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    node = node.parentElement;
  }
  return () => {
    // Order is irrelevant: each level's siblings are disjoint from the next
    // level's (which are their ancestors), so no element appears twice.
    for (const { el, inert, ariaHidden } of touched) {
      if (inert === null) el.removeAttribute("inert");
      else el.setAttribute("inert", inert);
      if (ariaHidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

// Open dialogs, oldest first. Only the last entry reacts to keys.
//
// Dialogs on this desktop DO stack: TierUpgradeCelebration mounts from the
// page shell independently of any window, and the sign-in modal can open over
// ClawKeep or Remote Control. Each open dialog adds its own capture listener
// to `document`, and stopPropagation() does not stop the OTHER listeners
// already registered on that same node — so without this, one Escape closed
// every open dialog at once, and the older dialog's Tab handler yanked focus
// out of the newer panel it was supposed to be trapped in.
const openPanels: HTMLElement[] = [];

export interface ModalDialogOptions {
  /**
   * Whether the dialog is currently rendered. Defaults to true.
   *
   * This is the normal contract, not a workaround: a modal that stays mounted
   * and self-gates (`if (!open) return null`) is the dominant React shape, and
   * two of this hook's callers are written that way. Callers that mount and
   * unmount the dialog outright can leave it alone.
   */
  open?: boolean;
  /** Called on Escape. Also used as the "dismiss" action for the trap. */
  onClose: () => void;
}

/**
 * Wire up focus containment for a modal dialog.
 *
 * @returns a ref to attach to the dialog panel element.
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>({
  open = true,
  onClose,
}: ModalDialogOptions): RefObject<T | null> {
  const panelRef = useRef<T>(null);
  // The close handler is read through a ref so the effect below can key on
  // `open` alone. Keying it on the callback re-ran the whole setup on every
  // parent render — and these parents DO re-render under an open dialog (the
  // app store resolves its detail fetch while the confirmation is up), which
  // yanked focus back to the first control mid-Tab and overwrote the element
  // we were meant to restore focus to on close.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) {
      // Silence here would mean a dialog with no trap and no signal — the worst
      // failure mode for a11y infrastructure. Callers must render the panel in
      // the same commit that flips `open`; one that gates its panel behind an
      // inner loading state has to keep `open` false until the panel exists.
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "useModalDialog: `open` is true but the panel ref is not attached — no focus trap is active.",
        );
      }
      return;
    }

    const restoreTarget = document.activeElement as HTMLElement | null;
    openPanels.push(panel);

    // Move focus in. If the dialog has no focusable control (a progress-only
    // overlay), focus the panel itself so the trap still has an anchor and the
    // screen reader lands on the dialog's label rather than on the page behind.
    const initial = focusableWithin(panel)[0];
    if (initial) {
      initial.focus();
    } else {
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      panel.focus();
    }

    const undoHide = hideOutside(panel);

    const onKeyDown = (e: KeyboardEvent) => {
      // Only the topmost dialog reacts. A dialog underneath is already `inert`
      // (the newer one marked it), so acting on keys would be wrong twice over.
      if (openPanels[openPanels.length - 1] !== panel) return;
      if (e.key === "Escape") {
        // Stop here: the window/app behind must not also act on this Escape.
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      // Recomputed per keystroke — dialog contents change while open (a button
      // becomes disabled mid-install, a details block expands).
      const focusables = focusableWithin(panel);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (!panel.contains(active)) {
        // Focus escaped (a click on the backdrop, or a browser chrome round
        // trip). Pull it back rather than letting Tab continue outside.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the dialog must see Tab/Escape before any handler further
    // down (or any bubble-phase listener on window) gets a chance to act.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const at = openPanels.lastIndexOf(panel);
      if (at !== -1) openPanels.splice(at, 1);
      undoHide();
      // Restore focus to whatever opened the dialog. `isConnected` guards the
      // case where the trigger itself was removed by the action just taken.
      if (restoreTarget && restoreTarget.isConnected) restoreTarget.focus?.();
    };
  }, [open]);

  return panelRef;
}
