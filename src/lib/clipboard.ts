/**
 * Copy text to the system clipboard. Tries the modern API first; falls
 * back to a hidden textarea + execCommand for embedded WebView contexts
 * (the embedded Chromium occasionally hides navigator.clipboard or
 * rejects the call when the user-gesture chain is borderline).
 *
 * Returns true on success so callers can flash a "Copied" confirmation
 * only when the copy actually landed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy path.
    }
  }
  if (typeof document === "undefined") return false;
  // Always remove the textarea via finally — execCommand can throw or
  // return false, and either path used to leave the off-screen node in
  // the DOM forever.
  //
  // The styling here is deliberately verbose: the legacy execCommand path
  // requires the source element to be focusable and have a real bounding
  // box, otherwise `select()` silently no-ops on Chrome/Edge. `opacity: 0`
  // alone keeps the element invisible to the user but still selectable.
  // We also pin position so iOS Safari's autoscroll on focus doesn't jump
  // the page when the user clicks Copy on a long page.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "0";
  ta.style.outline = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  // iOS needs contentEditable + numeric font-size to skip the on-screen
  // keyboard popup that some other workarounds trigger.
  ta.style.fontSize = "12pt";
  try {
    document.body.appendChild(ta);
    // Preserve and restore the user's existing selection so the page's
    // visible selection (e.g. text the user just highlighted) survives
    // the copy round-trip.
    const sel = document.getSelection();
    const previousRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    ta.focus({ preventScroll: true });
    ta.select();
    // Belt-and-suspenders for browsers (mobile Safari) that ignore
    // textarea.select() but honour setSelectionRange.
    try { ta.setSelectionRange(0, text.length); } catch { /* ignore */ }
    const ok = document.execCommand("copy");
    if (previousRange && sel) {
      sel.removeAllRanges();
      sel.addRange(previousRange);
    }
    return ok;
  } catch {
    return false;
  } finally {
    if (ta.parentNode) ta.parentNode.removeChild(ta);
  }
}
