/**
 * The clipboard, as the Terminal reaches it — over plain HTTP too.
 *
 * `navigator.clipboard` exists only in a secure context (https, localhost).
 * Every LAN ClawBox is `http://clawbox.local`, so on most boxes the legacy
 * `document.execCommand("copy")` path is the one that runs, and it has to work
 * without disturbing the terminal:
 *
 * 1. Answer the `copy` event ourselves. execCommand fires it at the focused
 *    element; a capture listener sets the text and cancels the default, so
 *    nothing is selected and focus never leaves xterm's input.
 * 2. Only if that did not land, the textbook fallback: a hidden textarea,
 *    selected and copied — and then focus goes back where it was, because
 *    the old version left the keyboard on <body> and the next keystroke
 *    missed the shell.
 *
 * Both need the user's gesture (a key press, a click, a touch) to be recent,
 * which every caller here has.
 */

export function canUseAsyncClipboard(): boolean {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  if (typeof window !== "undefined" && window.isSecureContext === false) return false;
  return true;
}

/** Can the page READ the clipboard from script? A secure origin only — elsewhere paste is the browser's own. */
export function canReadClipboard(): boolean {
  return canUseAsyncClipboard() && typeof navigator.clipboard.readText === "function";
}

function copyViaEvent(text: string): boolean {
  let delivered = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    delivered = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    const ok = document.execCommand("copy");
    return ok && delivered;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

function copyViaTextarea(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(area);
  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
  return ok;
}

/** The legacy path alone — exported for the tests, which cannot fake a secure context away. */
export function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !text) return false;
  return copyViaEvent(text) || copyViaTextarea(text);
}

/**
 * Put `text` on the clipboard. Answers whether it got there as far as the page
 * can tell. The async API is called first and synchronously, so it runs inside
 * the gesture; when it is missing or refuses, the legacy path runs.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (canUseAsyncClipboard() && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A permission refusal or a document without focus: try the old way.
    }
  }
  return legacyCopy(text);
}

/** The clipboard's text, where script may read it; null where only the browser's own paste can. */
export async function readClipboard(): Promise<string | null> {
  if (!canReadClipboard()) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
