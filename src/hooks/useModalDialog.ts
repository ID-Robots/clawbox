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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Focusable descendants, in DOM order, skipping anything hidden or inert. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
    if (el.hidden || el.closest("[hidden], [inert]") !== null) return false;
    // Layout-aware check where the engine offers one. `visibilityProperty`
    // adds `visibility: hidden` to the default display/content-visibility
    // checks; opacity is deliberately NOT included, since a 0-opacity control
    // is still focusable and still reachable by a screen reader.
    //
    // jsdom has no layout and does not implement checkVisibility, so under test
    // every control counts — which is what we want: a layout heuristic there
    // would filter the whole dialog away and silently make the trap untestable.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) {
      return false;
    }
    return true;
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
 * Returns an undo function. Previous attribute values are captured per element
 * so nesting one dialog inside another restores correctly on the way out.
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
    // Reverse order so a nested dialog's undo runs before the outer one's.
    for (let i = touched.length - 1; i >= 0; i--) {
      const { el, inert, ariaHidden } = touched[i];
      if (inert === null) el.removeAttribute("inert");
      else el.setAttribute("inert", inert);
      if (ariaHidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

export interface ModalDialogOptions {
  /** Whether the dialog is currently rendered. Defaults to true. */
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
    if (!panel) return;

    const restoreTarget = document.activeElement as HTMLElement | null;

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
      undoHide();
      // Restore focus to whatever opened the dialog. `isConnected` guards the
      // case where the trigger itself was removed by the action just taken.
      if (restoreTarget && restoreTarget.isConnected) restoreTarget.focus?.();
    };
  }, [open]);

  return panelRef;
}
