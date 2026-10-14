/**
 * A region lands on the clipboard by itself. However the selection was asked
 * for — the tray's button, Shift+Print Screen, Alt+Shift+S, the Screenshot
 * app's own Region button — the ScreenshotOverlay starts a clipboard write in
 * the pointer-up that finishes it, on a PNG it delivers once the picture has
 * been taken. The whole screen is never copied. A missing or refusing
 * clipboard costs nothing but the copy: no error, and the capture opens in
 * the app exactly as before.
 *
 * The capture itself (src/components/screenshot/capture.ts) is replaced by a
 * promise the test settles; the browser's ClipboardItem and clipboard.write by
 * fakes that, like the browser, wait for the PNG before they write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import ScreenshotOverlay from "@/components/ScreenshotOverlay";
import { TOAST_EVENT } from "@/components/ToastHost";
import { type CaptureRequest, SCREENSHOT_APP_ID, requestCapture, takeImage } from "@/lib/screenshot/session";
import { screenshotEn } from "@/lib/screenshot-translations";
import { OPEN_APP_EVENT } from "@/lib/ui-events";

const captureScreen = vi.fn();

vi.mock("@/components/screenshot/capture", () => ({
  captureScreen: (...args: unknown[]) => captureScreen(...args),
  currentCaptureScale: () => 1,
}));

vi.mock("@/lib/i18n", async () => {
  const { screenshotEn } = await import("@/lib/screenshot-translations");
  return {
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let text = screenshotEn[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
        return text;
      },
    }),
  };
});

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

const COPIED = screenshotEn["screenshot.copied"];

let pending: Array<{ finish: () => void; fail: (err: Error) => void }> = [];
let regionApplied = true;
let opened: string[] = [];
let toasts: string[] = [];
let written: FakeClipboardItem[] = [];
let write: ReturnType<typeof vi.fn>;

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalToBlob = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toBlob");

const onOpen = (event: Event) => opened.push((event as CustomEvent<{ appId: string }>).detail.appId);
const onToast = (event: Event) => toasts.push((event as CustomEvent<{ message: string }>).detail.message);

function setSecure(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value });
}

beforeEach(() => {
  pending = [];
  regionApplied = true;
  opened = [];
  toasts = [];
  written = [];
  captureScreen.mockReset();
  captureScreen.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({
          finish: () => resolve({ bitmap: document.createElement("canvas"), engine: "dom", skipped: [], regionApplied }),
          fail: reject,
        });
      }),
  );
  // The region selector captures the pointer for the drag; jsdom has no pointer capture.
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  // jsdom cannot encode a canvas; this one hands back a PNG of the asked-for type.
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback, type?: string) {
      callback(new Blob(["png"], { type: type ?? "image/png" }));
    },
  });
  // A secure origin with the picture clipboard, whose write waits for the PNG as the browser's does.
  setSecure(true);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  write = vi.fn(async (items: FakeClipboardItem[]) => {
    written.push(...items);
    await Promise.all(items.map((item) => item.items["image/png"]));
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
  window.addEventListener(OPEN_APP_EVENT, onOpen);
  window.addEventListener(TOAST_EVENT, onToast);
});

afterEach(() => {
  window.removeEventListener(OPEN_APP_EVENT, onOpen);
  window.removeEventListener(TOAST_EVENT, onToast);
  takeImage();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).setPointerCapture;
  if (originalToBlob) Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", originalToBlob);
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure);
});

const PRINT = { key: "PrintScreen", code: "PrintScreen" };

function pressPrint(mods: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.body, { ...PRINT, ...mods });
  fireEvent.keyUp(document.body, { ...PRINT, ...mods });
}

/** What the Screenshot app's own capture buttons send (ScreenshotApp's requestCapture). */
function appRequest(mode: CaptureRequest["mode"], delay = 0) {
  act(() => requestCapture({ mode, delay, engine: "dom", hide: null }));
}

/** Drags out a region on the selector, from (x, y) to (x + width, y + height). */
function dragRegion(x: number, y: number, width: number, height: number) {
  const overlay = screen.getByTestId("screenshot-region-overlay");
  fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
  fireEvent.pointerMove(overlay, { pointerId: 1, pointerType: "mouse", clientX: x + width, clientY: y + height });
  fireEvent.pointerUp(overlay, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x + width, clientY: y + height });
}

/** Waits until the overlay has handed the picture over and asked for the window. */
async function finishCapture(expectedOpens: number) {
  await act(async () => {
    pending.shift()?.finish();
  });
  await waitFor(() => expect(opened).toHaveLength(expectedOpens));
}

/** Lets every settled promise run its handlers — a toast that was going to come has come. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDesktop() {
  return render(
    <>
      <ScreenshotOverlay />
      <ChromeShelf apps={[]} onAppClick={vi.fn()} onLauncherClick={vi.fn()} onTrayClick={vi.fn()} />
    </>,
  );
}

describe("a finished region selection goes to the clipboard by itself", () => {
  const ENTRY_POINTS: Array<[string, () => void]> = [
    ["the tray's Screenshot button", () => fireEvent.click(screen.getByTestId("shelf-screenshot-button"))],
    ["Shift+Print Screen", () => pressPrint({ shiftKey: true })],
    ["Alt+Shift+S", () => fireEvent.keyDown(document.body, { key: "S", code: "KeyS", altKey: true, shiftKey: true })],
    ["the Screenshot app's Region button", () => appRequest("region")],
  ];

  it.each(ENTRY_POINTS)("from %s: the write starts in the pointer-up, the PNG follows, then 'Copied'", async (_name, start) => {
    renderDesktop();
    start();
    expect(screen.getByTestId("screenshot-region-overlay")).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();

    dragRegion(100, 80, 300, 200);
    // Inside the gesture itself: the write is under way before the picture has even been asked for.
    expect(write).toHaveBeenCalledTimes(1);
    expect(captureScreen).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0].items)).toEqual(["image/png"]);
    const png = written[0].items["image/png"];
    expect(png).toBeInstanceOf(Promise);

    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect(captureScreen.mock.calls[0][0]).toMatchObject({ region: { x: 100, y: 80, width: 300, height: 200 } });
    // Not copied before there is a picture to copy.
    await flush();
    expect(toasts).toEqual([]);

    await finishCapture(1);
    await expect(png).resolves.toMatchObject({ type: "image/png" });
    await waitFor(() => expect(toasts).toEqual([COPIED]));
    // And the capture is delivered as it always was.
    expect(opened).toEqual([SCREENSHOT_APP_ID]);
    expect(takeImage()).toMatchObject({ kind: "capture", engine: "dom", regionApplied: true });
  });

  it("copies each region once, not again for the next", async () => {
    renderDesktop();
    pressPrint({ shiftKey: true });
    dragRegion(10, 10, 100, 100);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
    await waitFor(() => expect(toasts).toEqual([COPIED]));

    pressPrint({ shiftKey: true });
    dragRegion(20, 20, 50, 50);
    expect(write).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(2));
    await finishCapture(2);
    await waitFor(() => expect(toasts).toEqual([COPIED, COPIED]));
  });
});

describe("the whole screen is never copied", () => {
  const FULL_SCREEN: Array<[string, () => void]> = [
    ["Print Screen", () => pressPrint()],
    ["Ctrl+Shift+S", () => fireEvent.keyDown(document.body, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true })],
    ["the Screenshot app's Full screen button", () => appRequest("full")],
  ];

  it.each(FULL_SCREEN)("%s: captured and opened, the clipboard untouched", async (_name, start) => {
    renderDesktop();
    start();
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect(captureScreen.mock.calls[0][0]).toMatchObject({ region: null });
    await finishCapture(1);
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(takeImage()).toMatchObject({ kind: "capture", regionApplied: true });
  });
});

describe("when the copy cannot be made, the capture goes on without it, quietly", () => {
  it("on plain http (no picture clipboard): nothing is written, nothing is said", async () => {
    setSecure(false);
    renderDesktop();
    fireEvent.click(screen.getByTestId("shelf-screenshot-button"));
    dragRegion(100, 80, 300, 200);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(takeImage()).toMatchObject({ kind: "capture", regionApplied: true });
  });

  it("when the browser refuses the write: no error toast, the region still opens", async () => {
    write.mockImplementation(() => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")));
    renderDesktop();
    fireEvent.click(screen.getByTestId("shelf-screenshot-button"));
    dragRegion(100, 80, 300, 200);
    expect(write).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
    await flush();
    // Not the Copy button's "could not be copied": a copy nobody asked for fails silently.
    expect(toasts).toEqual([]);
    expect(opened).toEqual([SCREENSHOT_APP_ID]);
    expect(takeImage()).toMatchObject({ kind: "capture", regionApplied: true });
  });

  it("a countdown cancelled with Escape drops the copy with the capture", async () => {
    renderDesktop();
    appRequest("region", 3);
    dragRegion(100, 80, 300, 200);
    expect(write).toHaveBeenCalledTimes(1);
    const png = written[0].items["image/png"];
    expect(screen.getByTestId("screenshot-countdown")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("screenshot-countdown")).toBeNull();
    await expect(png).rejects.toThrow();
    await flush();
    expect(captureScreen).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("a failed capture says only that it failed", async () => {
    renderDesktop();
    fireEvent.click(screen.getByTestId("shelf-screenshot-button"));
    dragRegion(100, 80, 300, 200);
    const png = written[0].items["image/png"];
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await act(async () => {
      pending.shift()?.fail(new Error("render failed"));
    });
    await expect(png).rejects.toThrow();
    await flush();
    expect(toasts).toEqual([screenshotEn["screenshot.captureFailed"]]);
    expect(opened).toEqual([]);
  });

  it("a whole screen that came back instead of the region is not copied", async () => {
    regionApplied = false;
    renderDesktop();
    appRequest("region");
    dragRegion(100, 80, 300, 200);
    const png = written[0].items["image/png"];
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
    await expect(png).rejects.toThrow();
    await flush();
    expect(toasts).toEqual([]);
    expect(takeImage()).toMatchObject({ kind: "capture", regionApplied: false });
  });
});
