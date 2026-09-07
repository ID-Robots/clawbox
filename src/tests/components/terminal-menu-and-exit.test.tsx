// @vitest-environment jsdom
/**
 * Two things the desktop sweep found in the Terminal window (FT-2, FT-4).
 *
 * The right-click menu was clamped to the viewport and painted inside the
 * window: opened in the lower rows of a window that reaches the shelf, its
 * last item landed behind the shelf — and no z-index inside a window can
 * reach above it, since the window is its own stacking context. The menu is
 * now portaled onto the body on the desktop's menu layer and clamped above
 * the shelf.
 *
 * And a shell the owner ENDED — `exit` — was reported as a dropped
 * connection, with the socket's URL in the bar, and respawned three seconds
 * later. It is now said as what it is, the URL stays off the screen, and a
 * new shell is one Enter or Reconnect away; a socket that actually drops
 * still retries as it always did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

class FakeWs {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  /** What the terminal server does when the PTY exits: the message, then a close with no code. */
  exit(code: number) {
    this.onmessage?.({ data: JSON.stringify({ type: "exit", code }) });
    this.readyState = 3;
    this.onclose?.({ code: 1005 });
  }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const sockets: FakeWs[] = [];

const written: string[] = [];
let keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    clear() {}
    write() {}
    writeln(line: string) { written.push(line); }
    dispose() {}
    getSelection() { return ""; }
    onData() { return { dispose: () => {} }; }
    attachCustomKeyEventHandler(fn: (ev: KeyboardEvent) => boolean) { keyHandler = fn; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const H = 900;
const SHELF = 56;
const MENU_H = 160;

beforeEach(() => {
  sockets.length = 0;
  written.length = 0;
  keyHandler = null;
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
  const WebSocketStub = function (url: string) { return new FakeWs(url); } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connectedTerminal() {
  const view = render(<TerminalApp />);
  await waitFor(() => expect(sockets.length).toBe(1));
  await act(async () => { sockets[0].open(); });
  return view;
}

const pressEnter = () => keyHandler!({
  type: "keydown", key: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() {},
} as unknown as KeyboardEvent);

describe("the right-click menu (FT-2)", () => {
  it("opens above the shelf, on the body, on the desktop's menu layer", async () => {
    const { container } = await connectedTerminal();
    const surface = container.querySelector('div[tabindex="0"]')!;
    // The box's own case: a 900 px screen, a right-click in the bottom rows.
    fireEvent.contextMenu(surface, { clientX: 300, clientY: H - 10 });
    const menu = screen.getByTestId("terminal-context-menu");

    expect(parseInt(menu.style.top, 10)).toBeLessThanOrEqual(H - SHELF - MENU_H);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.zIndex).toBe(String(DESKTOP_LAYERS.menu));
    expect(DESKTOP_LAYERS.menu).toBeGreaterThan(DESKTOP_LAYERS.shelf);
  });
});

describe("a shell the owner ended (FT-4)", () => {
  it("is said as such, without the socket's URL, and is not respawned on its own", async () => {
    await connectedTerminal();
    expect(screen.queryByText(/ws:\/\//)).toBeNull();

    vi.useFakeTimers();
    await act(async () => { sockets[0].exit(0); });

    // The instruction is in the scrollback, where Enter is the next keystroke;
    // the bar carries a state word like the other four, not a sentence that
    // wraps three deep in a narrow window and names the button beside it.
    expect(written.some((line) => line.includes("The shell ended — press Enter or Reconnect to start a new one"))).toBe(true);
    expect(screen.getByText("Shell ended")).toBeInTheDocument();
    expect(screen.queryByText(/press Enter or Reconnect/)).toBeNull();
    expect(screen.queryByText(/ws:\/\//)).toBeNull();
    expect(written.some((line) => line.includes("Disconnected — will retry"))).toBe(false);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(3500); });
    expect(sockets.length).toBe(1);
  });

  it("starts a new shell on Enter", async () => {
    await connectedTerminal();
    await act(async () => { sockets[0].exit(0); });
    expect(keyHandler).not.toBeNull();

    // The key is the menu's, not the (gone) shell's.
    let passedOn: boolean | undefined;
    await act(async () => { passedOn = pressEnter(); });
    expect(passedOn).toBe(false);
    await waitFor(() => expect(sockets.length).toBe(2));
  });

  it("still retries a socket that actually dropped", async () => {
    await connectedTerminal();
    vi.useFakeTimers();
    await act(async () => { sockets[0].drop(); });
    expect(written.some((line) => line.includes("Disconnected — will retry"))).toBe(true);
    // The retry itself, not only its line: the exit path returns from onclose
    // right above it, and a retry deleted by mistake would still print this.
    act(() => { vi.advanceTimersByTime(3000); });
    vi.useRealTimers();
    await waitFor(() => expect(sockets.length).toBe(2));
  });
});
