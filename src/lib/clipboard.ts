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
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
