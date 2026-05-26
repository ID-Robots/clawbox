/**
 * Scroll a sentinel element into view, but wait for the next two animation
 * frames so the scroll fires AFTER the layout pass that accompanies the
 * triggering state update has settled.
 *
 * Without the double rAF, when a new chat message is appended while another
 * component in the header re-renders (e.g. the model-picker dropdown
 * becoming visible or changing height as the catalog loads), the scroll
 * executes against the pre-reflow layout and lands above the freshly-added
 * message — making the user think their send "disappeared" until they
 * refresh and the layout starts stable. Two rAFs guarantee we're past the
 * next paint regardless of which order React batches the renders in.
 *
 * SSR-safe: when `requestAnimationFrame` is undefined (Node), falls back
 * to a direct `scrollIntoView` call (which is itself a no-op in SSR).
 */
export function scrollToBottomAfterLayout(target: HTMLElement | null): void {
  if (!target) return;
  if (typeof requestAnimationFrame === 'undefined') {
    target.scrollIntoView({ behavior: 'instant' });
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'instant' });
    });
  });
}
