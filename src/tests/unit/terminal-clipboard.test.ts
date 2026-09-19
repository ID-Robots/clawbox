// @vitest-environment jsdom
/**
 * The Terminal's clipboard (src/lib/terminal-clipboard.ts). A LAN ClawBox is
 * plain `http://clawbox.local`, where `navigator.clipboard` does not exist, so
 * the legacy `execCommand("copy")` path is the one most boxes run — and it has
 * to leave the keyboard where it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canReadClipboard, copyToClipboard, legacyCopy, readClipboard } from "@/lib/terminal-clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalExec = document.execCommand;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
function setSecure(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value });
}

/** An execCommand that fires a real `copy` event, as a browser does, and records what landed. */
function fakeExecCommand(result = true) {
  const landed: string[] = [];
  const exec = vi.fn((command: string) => {
    if (command !== "copy") return false;
    const data = new Map<string, string>();
    const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (type: string, text: string) => data.set(type, text), getData: (type: string) => data.get(type) ?? "" },
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    const text = event.defaultPrevented ? data.get("text/plain") : (document.activeElement as HTMLTextAreaElement | null)?.value;
    if (text !== undefined) landed.push(text);
    return result;
  });
  document.execCommand = exec as unknown as typeof document.execCommand;
  return { exec, landed };
}

beforeEach(() => {
  setSecure(true);
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure);
  document.execCommand = originalExec;
  document.body.innerHTML = "";
});

describe("copyToClipboard", () => {
  it("uses the async clipboard on a secure origin", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const { exec } = fakeExecCommand();
    await expect(copyToClipboard("ls -la")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand on plain HTTP, where navigator.clipboard is missing", async () => {
    setSecure(false);
    setClipboard(undefined);
    const { landed } = fakeExecCommand();
    await expect(copyToClipboard("echo copied over http")).resolves.toBe(true);
    expect(landed).toEqual(["echo copied over http"]);
  });

  it("falls back when the async clipboard refuses", async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) });
    const { landed } = fakeExecCommand();
    await expect(copyToClipboard("text")).resolves.toBe(true);
    expect(landed).toEqual(["text"]);
  });

  it("answers false when nothing could copy, and for empty text", async () => {
    setSecure(false);
    setClipboard(undefined);
    fakeExecCommand(false);
    await expect(copyToClipboard("x")).resolves.toBe(false);
    await expect(copyToClipboard("")).resolves.toBe(false);
  });
});

describe("legacyCopy", () => {
  it("answers the copy event itself, so nothing is selected and focus never moves", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    const { landed } = fakeExecCommand();
    expect(legacyCopy("multi\nline")).toBe(true);
    expect(landed).toEqual(["multi\nline"]);
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("falls back to a hidden textarea and gives the keyboard back afterwards", () => {
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    document.body.appendChild(input);
    input.focus();
    // A browser whose copy event carries no clipboardData.
    const landed: string[] = [];
    document.execCommand = vi.fn(() => {
      landed.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    }) as unknown as typeof document.execCommand;
    expect(legacyCopy("fallback")).toBe(true);
    // The first call was the copy-event path, which found no clipboardData.
    expect(landed.at(-1)).toBe("fallback");
    expect(document.activeElement).toBe(input);
    // The helper textarea is gone again.
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
  });
});

describe("reading the clipboard", () => {
  it("reads it on a secure origin that offers readText", async () => {
    setClipboard({ readText: vi.fn(async () => "pasted"), writeText: vi.fn() });
    expect(canReadClipboard()).toBe(true);
    await expect(readClipboard()).resolves.toBe("pasted");
  });

  it("does not try on plain HTTP — the browser's own paste event is the way there", async () => {
    setSecure(false);
    setClipboard({ readText: vi.fn(async () => "nope") });
    expect(canReadClipboard()).toBe(false);
    await expect(readClipboard()).resolves.toBeNull();
  });

  it("answers null when the read is refused", async () => {
    setClipboard({ readText: vi.fn(async () => { throw new Error("denied"); }) });
    await expect(readClipboard()).resolves.toBeNull();
  });
});
