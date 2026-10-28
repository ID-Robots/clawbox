/**
 * Keyboard helpers for a dialog that listens on `window` (capture phase): the
 * What's new card and the full-screen view of its screenshots. Shared so the
 * two answer the same questions the same way — whose keys these are, whether
 * the owner is typing, and where Tab goes next.
 */

/**
 * Are the keys the dialog's? Not when something is drawn over it (the
 * screenshot overlay covers the screen), nor when the focus is on a surface
 * stacked above it (a power approval prompt focuses its own button). Focus on
 * the page behind the scrim — a composer that took it — is the dialog's to
 * take back. Without layout (jsdom) the dialog is taken to be on top.
 */
export function keysAreOurs(dialog: HTMLElement, backdrop: HTMLElement): boolean {
  if (typeof document.elementFromPoint !== "function") return true;
  const drawnByUs = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === null || backdrop.contains(hit);
  };
  if (!drawnByUs(dialog)) return false;
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement || dialog.contains(active)) return true;
  return drawnByUs(active);
}

/** Is this key event headed for something the owner types into? */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Keep Tab inside the dialog: past the last control it wraps to the first,
 * before the first to the last, and from outside it lands on the first.
 */
export function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const lastEl = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active) || active === dialog) {
    event.preventDefault();
    (event.shiftKey ? lastEl : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    lastEl.focus();
  } else if (!event.shiftKey && active === lastEl) {
    event.preventDefault();
    first.focus();
  }
}
