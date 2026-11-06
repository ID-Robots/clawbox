// @vitest-environment jsdom
/**
 * The Screenshot app's picture clipboard (src/lib/screenshot/clipboard.ts),
 * shared by the editor's Copy button and the copy a finished region makes on
 * its own. The write has to start inside the gesture, so the PNG is handed
 * over still being made — as a promise, never awaited first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canCopyImages, copyPngToClipboard } from "@/lib/screenshot/clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
function setSecure(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value });
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PNG = new Blob(["png"], { type: "image/png" });

beforeEach(() => {
  setSecure(true);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure);
});

describe("canCopyImages", () => {
  it("is true on a secure origin with ClipboardItem and clipboard.write", () => {
    setClipboard({ write: vi.fn() });
    expect(canCopyImages()).toBe(true);
  });

  it("is false on plain http, where the browser hides the picture clipboard", () => {
    setClipboard({ write: vi.fn() });
    setSecure(false);
    expect(canCopyImages()).toBe(false);
  });

  it("is false without ClipboardItem or without clipboard.write", () => {
    setClipboard({ writeText: vi.fn() });
    expect(canCopyImages()).toBe(false);
    setClipboard({ write: vi.fn() });
    vi.stubGlobal("ClipboardItem", undefined);
    expect(canCopyImages()).toBe(false);
  });
});

describe("copyPngToClipboard", () => {
  it("starts the write at once, with the PNG still on its way, and settles when it lands", async () => {
    const written: FakeClipboardItem[] = [];
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      written.push(...items);
      // As the browser does: the write waits for the picture.
      await Promise.all(items.map((item) => item.items["image/png"]));
    });
    setClipboard({ write });
    const png = deferred<Blob>();

    let done = false;
    const copying = copyPngToClipboard(png.promise).then(() => {
      done = true;
    });
    // Synchronously, inside the caller's gesture: one item, the PNG's promise itself.
    expect(write).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0].items)).toEqual(["image/png"]);
    expect(written[0].items["image/png"]).toBe(png.promise);
    await Promise.resolve();
    expect(done).toBe(false);

    png.resolve(PNG);
    await copying;
    expect(done).toBe(true);
  });

  it("rejects without writing when there is no picture clipboard, and a PNG that fails is no unhandled rejection", async () => {
    const write = vi.fn();
    setClipboard({ write });
    setSecure(false);
    const png = deferred<Blob>();
    await expect(copyPngToClipboard(png.promise)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    // Nobody waits on it now; vitest fails the run on an unhandled rejection.
    png.reject(new Error("capture failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects when the browser refuses the write", async () => {
    setClipboard({ write: vi.fn(() => Promise.reject(new DOMException("Refused", "NotAllowedError"))) });
    await expect(copyPngToClipboard(Promise.resolve(PNG))).rejects.toThrow("Refused");
  });

  it("rejects when the PNG never comes", async () => {
    setClipboard({
      write: vi.fn(async (items: FakeClipboardItem[]) => {
        await Promise.all(items.map((item) => item.items["image/png"]));
      }),
    });
    await expect(copyPngToClipboard(Promise.reject(new Error("not encoded")))).rejects.toThrow("not encoded");
  });

  it("rejects, rather than throwing, where ClipboardItem itself refuses", async () => {
    setClipboard({ write: vi.fn() });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor() {
          throw new TypeError("no promises here");
        }
      },
    );
    const copying = copyPngToClipboard(Promise.resolve(PNG));
    await expect(copying).rejects.toThrow("no promises here");
  });
});
