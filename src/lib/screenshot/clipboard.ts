// Putting a picture on the clipboard. Shared by the editor's Copy button and
// the copy a finished region selection makes on its own (ScreenshotOverlay).

/**
 * Whether this page can put a picture on the clipboard at all. Plain http is
 * not a secure context: the browser hides the picture clipboard entirely.
 */
export function canCopyImages(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

/**
 * Writes a PNG to the clipboard. Call it synchronously from the gesture that
 * asked for the copy (a click, the pointer-up that finishes a selection) and
 * hand it the PNG still being made: the promise form of ClipboardItem keeps
 * the write inside that gesture while the picture is encoded — or taken.
 *
 * Rejects when there is no picture clipboard here (`canCopyImages()`), when
 * the PNG never comes, or when the browser refuses the write.
 */
export function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
  // The write reports a PNG that never came. Where no write looks at it — no
  // clipboard, a refused item — it is not an unhandled rejection besides.
  png.catch(() => {});
  if (!canCopyImages()) return Promise.reject(new Error("There is no picture clipboard here."));
  try {
    return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch (err) {
    return Promise.reject(err);
  }
}
