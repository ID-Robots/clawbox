/**
 * A capture one key or one click away (TASK-1491): the desktop-wide keys the
 * desktop's ScreenshotOverlay listens for, and the Screenshot button in the
 * shelf's tray. Both go through the overlay's one capture path — the button
 * by the same request event the app's own capture buttons send — with the
 * Screenshot window closed: no ScreenshotApp is rendered here at all, and the
 * finished capture asks for the window to be opened on it.
 *
 * The capture itself (src/components/screenshot/capture.ts) is replaced by a
 * promise the test settles, so "a capture is under way" is a state the test
 * holds open for as long as it likes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import ScreenshotOverlay from "@/components/ScreenshotOverlay";
import { CAPTURE_REQUEST_EVENT, SCREENSHOT_APP_ID, takeImage } from "@/lib/screenshot/session";
import { screenshotTranslations } from "@/lib/screenshot-translations";
import { OPEN_APP_EVENT } from "@/lib/ui-events";

const captureScreen = vi.fn();

vi.mock("@/components/screenshot/capture", () => ({
  captureScreen: (...args: unknown[]) => captureScreen(...args),
  currentCaptureScale: () => 1,
}));

// The shipped English catalogue, so the tooltip is checked as the owner reads it.
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

interface Pending {
  finish: () => void;
}

let pending: Pending[] = [];
let opened: string[] = [];
let requests: unknown[] = [];

const onOpen = (event: Event) => opened.push((event as CustomEvent<{ appId: string }>).detail.appId);
const onRequest = (event: Event) => {
  const { hide, ...rest } = (event as CustomEvent<Record<string, unknown>>).detail;
  requests.push({ ...rest, hide: hide ?? null });
};

beforeEach(() => {
  pending = [];
  opened = [];
  requests = [];
  // Every capture stays under way until the test finishes it.
  captureScreen.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push({
          finish: () => resolve({ bitmap: document.createElement("canvas"), engine: "dom", skipped: [], regionApplied: true }),
        });
      }),
  );
  window.addEventListener(OPEN_APP_EVENT, onOpen);
  window.addEventListener(CAPTURE_REQUEST_EVENT, onRequest);
});

afterEach(() => {
  window.removeEventListener(OPEN_APP_EVENT, onOpen);
  window.removeEventListener(CAPTURE_REQUEST_EVENT, onRequest);
  takeImage();
});

const PRINT = { key: "PrintScreen", code: "PrintScreen" };
const CTRL_SHIFT_S = { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true };

/** Print Screen pressed and let go; `false` when anything stopped its default. */
function pressPrint(target: Element = document.body, mods: KeyboardEventInit = {}) {
  const down = fireEvent.keyDown(target, { ...PRINT, ...mods });
  const up = fireEvent.keyUp(target, { ...PRINT, ...mods });
  return down && up;
}

/** Waits until the overlay has handed the picture over and asked for the window. */
async function finishCapture(expectedOpens: number) {
  await act(async () => {
    pending.shift()?.finish();
  });
  await waitFor(() => expect(opened).toHaveLength(expectedOpens));
}

function renderShelf() {
  return render(<ChromeShelf apps={[]} onAppClick={vi.fn()} onLauncherClick={vi.fn()} onTrayClick={vi.fn()} />);
}

describe("the capture keys, with the Screenshot window closed", () => {
  it("Print Screen takes the whole screen on release, and the window opens on the result", async () => {
    render(<ScreenshotOverlay />);
    expect(fireEvent.keyDown(document.body, PRINT)).toBe(false);
    // Nothing yet: the key is acted on when it comes back up.
    await act(async () => {});
    expect(captureScreen).not.toHaveBeenCalled();
    fireEvent.keyUp(document.body, PRINT);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect(captureScreen.mock.calls[0][0]).toMatchObject({ engine: "dom", region: null });
    await finishCapture(1);
    expect(opened).toEqual([SCREENSHOT_APP_ID]);
    expect(takeImage()).toMatchObject({ kind: "capture", engine: "dom" });
  });

  it("works from the keyup alone — what Windows delivers", async () => {
    render(<ScreenshotOverlay />);
    expect(fireEvent.keyUp(document.body, PRINT)).toBe(false);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
  });

  it("takes the whole screen on Ctrl+Shift+S, where Print Screen never reaches the page", async () => {
    render(<ScreenshotOverlay />);
    // The browser's own use of the combination is stopped.
    expect(fireEvent.keyDown(document.body, CTRL_SHIFT_S)).toBe(false);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect(captureScreen.mock.calls[0][0]).toMatchObject({ region: null });
    await finishCapture(1);
  });

  it("starts a region on Shift+Print Screen and on Alt+Shift+S", () => {
    const { unmount } = render(<ScreenshotOverlay />);
    pressPrint(document.body, { shiftKey: true });
    expect(screen.getByTestId("screenshot-region-overlay")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("screenshot-region-overlay")).toBeNull();
    fireEvent.keyDown(document.body, { key: "S", code: "KeyS", altKey: true, shiftKey: true });
    expect(screen.getByTestId("screenshot-region-overlay")).toBeInTheDocument();
    unmount();
  });

  it("stands aside while the owner is typing — text fields, editable text, a terminal", async () => {
    render(
      <>
        <ScreenshotOverlay />
        <input data-testid="field" />
        <input type="search" data-testid="search" />
        <textarea data-testid="area" />
        <div contentEditable suppressContentEditableWarning data-testid="editable">
          <span data-testid="editable-child">text</span>
        </div>
        <div className="xterm">
          <textarea className="xterm-helper-textarea" data-testid="xterm-input" />
          <div className="xterm-screen" data-testid="xterm-screen" tabIndex={0} />
        </div>
        <div data-testid="chrome-window-terminal">
          <button type="button" data-testid="terminal-tab">tab</button>
        </div>
      </>,
    );
    const targets = ["field", "search", "area", "editable", "editable-child", "xterm-input", "xterm-screen", "terminal-tab"];
    for (const id of targets) {
      const target = screen.getByTestId(id);
      // Untouched: no capture, and the key's default is the focused element's to keep.
      expect(pressPrint(target), `Print Screen in ${id}`).toBe(true);
      expect(fireEvent.keyDown(target, CTRL_SHIFT_S), `Ctrl+Shift+S in ${id}`).toBe(true);
      expect(pressPrint(target, { shiftKey: true }), `Shift+Print Screen in ${id}`).toBe(true);
      expect(fireEvent.keyDown(target, { key: "S", code: "KeyS", altKey: true, shiftKey: true }), `Alt+Shift+S in ${id}`).toBe(true);
    }
    expect(screen.queryByTestId("screenshot-region-overlay")).toBeNull();
    // Had any of those started a capture, the overlay would not be idle now
    // and this would be turned away: a region selection appearing proves none did.
    pressPrint(document.body, { shiftKey: true });
    expect(screen.getByTestId("screenshot-region-overlay")).toBeInTheDocument();
    expect(captureScreen).not.toHaveBeenCalled();
  });

  it("still acts from a control that takes no text, like a checkbox or a button", async () => {
    render(
      <>
        <ScreenshotOverlay />
        <input type="checkbox" data-testid="check" />
      </>,
    );
    expect(pressPrint(screen.getByTestId("check"))).toBe(false);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
  });

  it("never starts a second capture while one is under way", async () => {
    render(<ScreenshotOverlay />);
    pressPrint();
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));

    // Everything that could ask again, while the first is still being taken.
    pressPrint();
    fireEvent.keyDown(document.body, CTRL_SHIFT_S);
    pressPrint(document.body, { shiftKey: true });
    fireEvent.keyDown(document.body, { key: "S", code: "KeyS", altKey: true, shiftKey: true });
    expect(screen.queryByTestId("screenshot-region-overlay")).toBeNull();

    await finishCapture(1);
    expect(captureScreen).toHaveBeenCalledTimes(1);

    // Once it is done the keys work again — the guard was the capture under way, nothing else.
    pressPrint();
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(2));
    await finishCapture(2);
  });

  it("holding Ctrl+Shift+S takes one picture, not one per repeat", async () => {
    render(<ScreenshotOverlay />);
    fireEvent.keyDown(document.body, CTRL_SHIFT_S);
    fireEvent.keyDown(document.body, { ...CTRL_SHIFT_S, repeat: true });
    fireEvent.keyDown(document.body, { ...CTRL_SHIFT_S, repeat: true });
    fireEvent.keyUp(document.body, CTRL_SHIFT_S);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    await finishCapture(1);
    expect(captureScreen).toHaveBeenCalledTimes(1);
  });
});

describe("the Screenshot button in the tray", () => {
  it("is not drawn where no capture overlay would answer it (a desktop that is not the owner's)", () => {
    renderShelf();
    expect(screen.queryByTestId("shelf-screenshot-button")).toBeNull();
  });

  it("sits in the tray beside the shield and the clock, named with its keyboard shortcut", () => {
    render(
      <>
        <ScreenshotOverlay />
        <ChromeShelf apps={[]} onAppClick={vi.fn()} onLauncherClick={vi.fn()} onTrayClick={vi.fn()} onClawKeepShieldClick={vi.fn()} />
      </>,
    );
    const button = screen.getByTestId("shelf-screenshot-button");
    expect(button).toHaveAttribute("title", "Screenshot (Print Screen or Ctrl+Shift+S)");
    expect(button).toHaveAttribute("aria-label", "Screenshot (Print Screen or Ctrl+Shift+S)");
    // The tray's own button shape and icon size: a 40 px round button, an 18 px glyph.
    expect(button.className).toContain("w-10 h-10 rounded-full");
    expect(button.querySelector(".material-symbols-rounded")).toHaveStyle({ fontSize: "18px" });
    // In the tray, between the shield and the clock.
    const tray = button.parentElement!;
    const order = Array.from(tray.children).map((child) => child.getAttribute("data-testid"));
    expect(order.indexOf("shelf-clawkeep-shield-button")).toBeLessThan(order.indexOf("shelf-screenshot-button"));
    expect(order.indexOf("shelf-screenshot-button")).toBeLessThan(order.indexOf("shelf-tray-button"));
  });

  it("starts a capture with one click, as the app's capture button does, and the window opens on it", async () => {
    render(
      <>
        <ScreenshotOverlay />
        <ChromeShelf apps={[]} onAppClick={vi.fn()} onLauncherClick={vi.fn()} onTrayClick={vi.fn()} />
      </>,
    );
    fireEvent.click(screen.getByTestId("shelf-screenshot-button"));
    // The app's own path: a request event to the overlay, for the whole screen.
    expect(requests).toEqual([{ mode: "full", delay: 0, engine: "dom", hide: null }]);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect(captureScreen.mock.calls[0][0]).toMatchObject({ engine: "dom", region: null });
    await finishCapture(1);
    expect(opened).toEqual([SCREENSHOT_APP_ID]);
  });

  it("does not start a second capture when clicked again, or Print Screen is pressed, while one is under way", async () => {
    render(
      <>
        <ScreenshotOverlay />
        <ChromeShelf apps={[]} onAppClick={vi.fn()} onLauncherClick={vi.fn()} onTrayClick={vi.fn()} />
      </>,
    );
    const button = screen.getByTestId("shelf-screenshot-button");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    pressPrint();
    await finishCapture(1);
    expect(captureScreen).toHaveBeenCalledTimes(1);
  });

  it("goes when the overlay goes, and comes back with it", () => {
    const overlay = render(<ScreenshotOverlay />);
    renderShelf();
    expect(screen.getByTestId("shelf-screenshot-button")).toBeInTheDocument();
    overlay.unmount();
    expect(screen.queryByTestId("shelf-screenshot-button")).toBeNull();
    render(<ScreenshotOverlay />);
    expect(screen.getByTestId("shelf-screenshot-button")).toBeInTheDocument();
  });
});

describe("the tray button's name in every language", () => {
  const LOCALES = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"] as const;

  it.each(LOCALES)("'%s' names the app and keeps both shortcut slots", (locale) => {
    const table = screenshotTranslations[locale];
    expect(table["screenshot.trayTooltip"]).toContain(table["app.screenshot"]);
    expect(table["screenshot.trayTooltip"]).toContain("{key}");
    expect(table["screenshot.trayTooltip"]).toContain("{fallback}");
    // The help note names the new fallback in every language too.
    expect(table["screenshot.shortcutsNote"]).toContain("Ctrl+Shift+S");
  });
});
