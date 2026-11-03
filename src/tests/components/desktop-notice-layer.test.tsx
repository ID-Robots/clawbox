import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { snapshotDesktop, type DesktopState } from "@/lib/desktop-state";
import { OPEN_CHAT_EVENT } from "@/lib/ui-events";
import { TOAST_EVENT } from "@/components/ToastHost";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import { BACKGROUND_TASK_EVENT, type BackgroundTaskView } from "@/lib/background-task-client";

/**
 * TASK-2129: with the chat docked on the right, the top-right bubbles — a
 * background task's card ("Installing the voice (Kokoro)", Show log), an
 * update, a toast — moved to make room for the chat and collided with it. Now
 * they stand in ONE place, the screen's top-right corner, whatever the chat
 * does; and they take turns with it, and with the windows, in the desktop's
 * own focus order: drawn over the chat by default, under it once the owner
 * presses it, back on top when a bubble is pressed, hovered or arrives.
 *
 * The chat is a stub that draws itself the way ChatPopup does: docked or on a
 * phone at DESKTOP_LAYERS.chat, floating at the layer the desktop hands it,
 * and reporting a press (`onFocus`) and its docked width (`onPanelModeChange`).
 */

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));
vi.mock("@/components/FilesApp", () => ({ default: () => <div data-testid="files-app-stub" /> }));
vi.mock("@/components/SettingsApp", () => ({ default: () => <div data-testid="settings-app-stub" /> }));
vi.mock("@/components/ChatPopup", async () => {
  const React = await import("react");
  const { DESKTOP_LAYERS: LAYERS } = await import("@/lib/window-snap");
  function ChatStub({ isOpen, onClose, floatingZIndex, onFocus, onPanelModeChange, mobile = false }: {
    isOpen: boolean;
    onClose: () => void;
    floatingZIndex?: number;
    onFocus?: () => void;
    onPanelModeChange?: (width: number) => void;
    mobile?: boolean;
  }) {
    const [dockWidth, setDockWidth] = React.useState(0);
    const docked = dockWidth > 0 && !mobile;
    React.useEffect(() => {
      onPanelModeChange?.(isOpen && docked ? dockWidth : 0);
    }, [isOpen, docked, dockWidth, onPanelModeChange]);
    if (!isOpen) return null;
    return (
      <div
        data-testid="chat-stub"
        style={{ position: "fixed", zIndex: docked || mobile ? LAYERS.chat : floatingZIndex ?? LAYERS.chat }}
        onPointerDownCapture={onFocus}
      >
        <button type="button" onClick={() => setDockWidth(420)}>dock</button>
        <button type="button" onClick={() => setDockWidth(640)}>widen</button>
        <button type="button" onClick={() => setDockWidth(0)}>undock</button>
        <button type="button" onClick={onClose}>close chat</button>
      </div>
    );
  }
  return { default: ChatStub, CHAT_PANEL_GAP: 12 };
});

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function answer(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

function kokoroInstall(): BackgroundTaskView {
  return {
    id: "kokoro-1", kind: "kokoro-install", group: "kokoro", title: "Installing the voice (Kokoro)", meta: null,
    state: "running",
    steps: [{ id: "install", label: "Download the voice", state: "running", weight: 1 }],
    status: "Downloading", completed: null, total: null,
    startedAt: 1_000, updatedAt: 2_000, stepStartedAt: 1_000, finishedAt: null, error: null, result: null,
    log: ["Downloading the voice…"], logCount: 1,
    runner: "r", dismissed: false, percent: 40, etaSeconds: 120,
    cancellable: false, cancelRequested: false, unit: null, adoptedAt: null,
    label: "Kokoro", lanes: [], needs: null, queuedAt: null, queuedBehind: null,
  };
}

let saved: DesktopState | null = null;
let tasks: BackgroundTaskView[] = [];
/** Holds the saved desktop's answer back until the case lets it go. */
let stateGate: Promise<void> | null = null;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/desktop/state")) {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") return answer({ ok: true });
      if (stateGate) await stateGate;
      return answer({ user: "clawbox", state: saved });
    }
    if (url.includes("/setup-api/background-jobs/tasks")) return answer({ tasks });
    if (url.includes("/setup-api/users/me")) return answer({ username: "clawbox", isOwner: true, multiUser: false });
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return answer({});
  }));
}

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

beforeEach(() => {
  saved = null;
  stateGate = null;
  tasks = [kokoroInstall()];
  resetHarnessCache();
  _resetSessionUserForTest();
  window.localStorage.clear();
  setViewport(1600, 1000);
  installFetch();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const column = () => screen.getByTestId("desktop-notice-stack");
const columnZ = () => Number(column().style.zIndex);
const chat = () => screen.getByTestId("chat-stub");
const chatZ = () => Number(chat().style.zIndex);
/** Where the column stands: what must never change for the chat. */
const place = () => ({ right: column().style.right, top: column().style.top, bottom: column().style.bottom, left: column().style.left });

async function desktopWithCard() {
  render(<ChromeDesktop />);
  await screen.findByTestId("background-task-card");
}

async function openChat() {
  act(() => { window.dispatchEvent(new Event(OPEN_CHAT_EVENT)); });
  return screen.findByTestId("chat-stub");
}

function toast(message: string) {
  act(() => { window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message } })); });
}

describe("the top-right bubbles' place", () => {
  it("is the screen's top-right corner — with the chat closed, floating, docked right, re-sized, undocked and closed again", async () => {
    await desktopWithCard();
    const corner = { right: "16px", top: "16px", bottom: "", left: "" };
    expect(place()).toEqual(corner);
    // The card is inside the column, which is what stands in the corner.
    expect(column()).toContainElement(screen.getByTestId("background-task-card"));

    await openChat();
    expect(place()).toEqual(corner);

    fireEvent.click(screen.getByRole("button", { name: "dock" }));
    await waitFor(() => expect(chatZ()).toBe(DESKTOP_LAYERS.chat));
    expect(place()).toEqual(corner);

    fireEvent.click(screen.getByRole("button", { name: "widen" }));
    expect(place()).toEqual(corner);

    fireEvent.click(screen.getByRole("button", { name: "undock" }));
    expect(place()).toEqual(corner);

    fireEvent.click(screen.getByRole("button", { name: "close chat" }));
    await waitFor(() => expect(screen.queryByTestId("chat-stub")).toBeNull());
    expect(place()).toEqual(corner);
  });

  it("holds the toasts too, in the same corner, under the cards", async () => {
    await desktopWithCard();
    toast("Kokoro is ready");
    const host = await screen.findByTestId("toast-host");
    expect(column()).toContainElement(host);
    expect(host).toHaveTextContent("Kokoro is ready");
    // After the cards: a toast coming and going does not push them about.
    const card = screen.getByTestId("background-task-card");
    expect(card.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

});

describe("the bubbles' turn in the stacking order", () => {
  it("over the docked chat by default; under it once it is pressed; back over it when a bubble is pressed or hovered", async () => {
    await desktopWithCard();
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: "dock" }));
    await waitFor(() => expect(chatZ()).toBe(DESKTOP_LAYERS.chat));
    // Opening and docking the chat leave the bubble where its arrival put
    // it: on top.
    expect(columnZ()).toBeGreaterThan(chatZ());

    fireEvent.pointerDown(chat());
    await waitFor(() => expect(columnZ()).toBeLessThan(chatZ()));

    fireEvent.pointerDown(screen.getByTestId("background-task-card"));
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));

    fireEvent.pointerDown(chat());
    await waitFor(() => expect(columnZ()).toBeLessThan(chatZ()));

    fireEvent.pointerOver(screen.getByTestId("background-task-card"));
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));
  });

  it("stays over the chat it was drawn over when the chat opens, and a new bubble brings it back", async () => {
    await desktopWithCard();
    await openChat();
    // The floating chat: the desktop hands it a layer from the window counter.
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));

    fireEvent.pointerDown(chat());
    await waitFor(() => expect(columnZ()).toBeLessThan(chatZ()));

    toast("Update available");
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));
  });

  it("goes under a window the owner presses, and back over it with the next bubble", async () => {
    saved = snapshotDesktop([
      { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 900, y: 0, width: 680, height: 500 },
    ], { savedAt: 1 });
    await desktopWithCard();
    const files = await screen.findByTestId("chrome-window-files");
    const filesZ = () => Number(files.style.zIndex);
    // The card arrived after the window was restored: over it.
    await waitFor(() => expect(columnZ()).toBeGreaterThan(filesZ()));

    // A press inside the window in front — the one the desktop already calls
    // active — puts it over the bubbles.
    expect(files).toHaveAttribute("data-active", "true");
    fireEvent.mouseDown(screen.getByTestId("files-app-stub"));
    await waitFor(() => expect(columnZ()).toBeLessThan(filesZ()));

    toast("Done");
    await waitFor(() => expect(columnZ()).toBeGreaterThan(filesZ()));
  });

  it("stays over the windows of a saved desktop that is restored after the bubble came up", async () => {
    saved = snapshotDesktop([
      { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 900, y: 0, width: 680, height: 500 },
    ], { savedAt: 1 });
    let letGo = () => {};
    stateGate = new Promise<void>((resolve) => { letGo = resolve; });
    await desktopWithCard();
    expect(screen.queryByTestId("chrome-window-files")).toBeNull();

    await act(async () => { letGo(); });
    const files = await screen.findByTestId("chrome-window-files");
    await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
    expect(columnZ()).toBeGreaterThan(Number(files.style.zIndex));
  });

  it("a window brought forward from the shelf leaves no tie for the next press", async () => {
    // Two Files windows under Settings: the shelf's Files entry brings both
    // forward, and a press on the lower one must then put it over the other.
    saved = snapshotDesktop([
      { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 40, y: 60, width: 600, height: 400 },
      { id: "files-2", appId: "files", zIndex: 101, minimized: false, x: 80, y: 90, width: 600, height: 400 },
      { id: "settings-1", appId: "settings", zIndex: 102, minimized: false, x: 700, y: 80, width: 600, height: 420 },
    ], { savedAt: 1 });
    render(<ChromeDesktop />);
    const settings = await screen.findByTestId("chrome-window-settings");
    await waitFor(() => expect(settings).toHaveAttribute("data-active", "true"));
    const win = (id: string) => document.querySelector<HTMLElement>(`[data-window-id="${id}"]`)!;
    const z = (id: string) => Number(win(id).style.zIndex);

    fireEvent.click(screen.getByTestId("shelf-app-files"));
    await waitFor(() => expect(z("files-2")).toBeGreaterThan(z("settings-1")));
    expect(z("files-1")).toBeGreaterThan(z("settings-1"));
    expect(z("files-2")).toBeGreaterThan(z("files-1"));

    fireEvent.mouseDown(win("files-1").querySelector('[data-testid="files-app-stub"]')!);
    await waitFor(() => expect(z("files-1")).toBeGreaterThan(z("files-2")));
  });

  it("raises itself when a running task ends — the result is news even under the chat", async () => {
    await desktopWithCard();
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: "dock" }));
    fireEvent.pointerDown(chat());
    await waitFor(() => expect(columnZ()).toBeLessThan(chatZ()));

    tasks = [{ ...kokoroInstall(), state: "failed", error: "No space left", finishedAt: 3_000 }];
    act(() => { window.dispatchEvent(new Event(BACKGROUND_TASK_EVENT)); });
    await waitFor(() => expect(screen.getByTestId("background-task-card")).toHaveAttribute("data-task-state", "failed"));
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));
  });
});

describe("on a phone", () => {
  beforeEach(() => setViewport(390, 844));

  it("stays at the top on the right over the full-screen chat until the chat is tapped, and never reaches its input", async () => {
    await desktopWithCard();
    // Inline; on a touch phone the stylesheet moves the top under the
    // app/chat header (below). The bottom is bounded here either way, clear
    // of the chat's composer: a taller column scrolls instead.
    const phonePlace = place();
    expect(phonePlace).toMatchObject({ right: "16px", top: "16px", left: "" });
    expect(phonePlace.bottom).toMatch(/\d+px/);
    expect(column().style.overflowY).toBe("auto");

    await openChat();
    expect(chatZ()).toBe(DESKTOP_LAYERS.chat);
    expect(columnZ()).toBeGreaterThan(chatZ());
    expect(place()).toEqual(phonePlace);

    fireEvent.pointerDown(chat());
    await waitFor(() => expect(columnZ()).toBeLessThan(chatZ()));

    toast("Installing the voice (Kokoro)");
    await waitFor(() => expect(columnZ()).toBeGreaterThan(chatZ()));
  });

  it("has one fixed place from the stylesheet — under the header — and no layer of its own there", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf-8");
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.desktop-notice-stack\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    // A z-index here would pin the column over (or under) the chat for good.
    for (const rule of rules) expect(rule).not.toMatch(/z-index/);
    expect(rules.join("\n")).toMatch(/top: calc\(60px \+ env\(safe-area-inset-top\)\) !important;/);
  });
});
