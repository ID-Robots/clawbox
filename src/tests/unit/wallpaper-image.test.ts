// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodesAsImage, isImageDataUrl, isShowableCustomWallpaper, readWallpaperFile } from "@/lib/wallpaper-image";

/**
 * A file picked as a wallpaper has to be a picture (2026-10-13 smoke test: a
 * text file was accepted and the desktop went black).
 *
 * jsdom's `Image` never loads anything, so the decode is stood in for by a
 * class that answers the way a browser does: `load` for bytes it can decode,
 * `error` for anything else.
 */

const DECODABLE = "REAL-PICTURE";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(value: string) {
    const ok = value.includes(btoa(DECODABLE));
    queueMicrotask(() => {
      if (ok) {
        this.naturalWidth = 4;
        this.naturalHeight = 4;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isImageDataUrl", () => {
  it("accepts image data URLs and nothing else", () => {
    expect(isImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isImageDataUrl("data:image/svg+xml,%3Csvg/%3E")).toBe(true);
    expect(isImageDataUrl("data:text/plain;base64,aGVsbG8=")).toBe(false);
    expect(isImageDataUrl("data:application/octet-stream;base64,AAAA")).toBe(false);
    expect(isImageDataUrl("https://example.com/a.png")).toBe(false);
    expect(isImageDataUrl("")).toBe(false);
    expect(isImageDataUrl(undefined)).toBe(false);
    expect(isImageDataUrl(42)).toBe(false);
  });
});

describe("readWallpaperFile", () => {
  it("refuses a text file", async () => {
    const file = new File(["just a note"], "smoke-note.txt", { type: "text/plain" });
    expect(await readWallpaperFile(file)).toBeNull();
  });

  it("refuses a file with no declared type", async () => {
    const file = new File([DECODABLE], "mystery");
    expect(await readWallpaperFile(file)).toBeNull();
  });

  it("refuses a text file renamed to look like a picture", async () => {
    // Declared as an image, so only the decode can tell.
    const file = new File(["just a note"], "note.png", { type: "image/png" });
    expect(await readWallpaperFile(file)).toBeNull();
  });

  it("returns the data URL of a picture that decodes", async () => {
    const file = new File([DECODABLE], "photo.png", { type: "image/png" });
    expect(await readWallpaperFile(file)).toBe(`data:image/png;base64,${btoa(DECODABLE)}`);
  });
});

describe("decodesAsImage", () => {
  it("is false for a picture with no pixels", async () => {
    class EmptyImage extends FakeImage {
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", EmptyImage);
    expect(await decodesAsImage("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("isShowableCustomWallpaper", () => {
  it("needs an image data URL that has not failed to decode", () => {
    expect(isShowableCustomWallpaper("data:image/png;base64,AAAA", false)).toBe(true);
    expect(isShowableCustomWallpaper("data:image/png;base64,AAAA", true)).toBe(false);
    expect(isShowableCustomWallpaper("data:text/plain;base64,AAAA", false)).toBe(false);
    expect(isShowableCustomWallpaper(undefined, false)).toBe(false);
  });
});
