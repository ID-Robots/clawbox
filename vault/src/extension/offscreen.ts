// Offscreen document: the only extension context that can write the clipboard
// without a visible page. Used to copy a password and to clear it 30 s later.
import type { OffscreenMessage } from "./messages";

function writeClipboard(text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true });
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== "offscreen") return false;
  sendResponse({ ok: writeClipboard(msg.type === "copy" ? msg.text : "") });
  return false;
});
