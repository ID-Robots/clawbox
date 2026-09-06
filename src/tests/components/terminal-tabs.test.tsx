import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalTabs, { terminalTabTitle } from "@/components/TerminalTabs";
import TerminalApp from "@/components/TerminalApp";

/**
 * Tabs in the Terminal window, and the right-click menu in each.
 *
 * Pinned: the first tab carries the window's command and is named after it;
 * "+" opens a plain shell and brings it to the front while the first stays
 * mounted (its shell keeps running); closing a tab moves to its neighbour;
 * closing the last opens a fresh one; and the shell's keyboard shortcuts
 * reach the strip. The menu: a right click on selected text offers Copy,
 * which puts the selection on the clipboard; Select all and Clear reach the
 * terminal; Paste is named as a key combination on an origin whose clipboard
 * cannot be read from script.
 */

interface Frame { type: string; data?: string }

const sockets: FakeWs[] = [];
const sent: Frame[] = [];

class FakeWs {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this); }
  send(raw: string) { sent.push(JSON.parse(raw) as Frame); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  output(data: string) { this.onmessage?.({ data: JSON.stringify({ type: "output", data }) } as MessageEvent); }
}

let selection = "";
interface FakeTerm {
  cols: number; rows: number;
  loadAddon: () => void; open: () => void; focus: ReturnType<typeof vi.fn>; write: () => void; writeln: () => void; dispose: () => void;
  clear: ReturnType<typeof vi.fn>; selectAll: ReturnType<typeof vi.fn>; paste: ReturnType<typeof vi.fn>;
  getSelection: () => string;
  onData: () => { dispose: () => void };
  attachCustomKeyEventHandler: (fn: (ev: KeyboardEvent) => boolean) => void;
  press: (ev: Partial<KeyboardEvent>) => boolean | undefined;
}
const terms: FakeTerm[] = [];
function makeTerm(): FakeTerm {
  let keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
  const term: FakeTerm = {
    cols: 80, rows: 24,
    loadAddon: () => {}, open: () => {}, focus: vi.fn(), write: () => {}, writeln: () => {}, dispose: () => {},
    clear: vi.fn(), selectAll: vi.fn(), paste: vi.fn(),
    getSelection: () => selection,
    onData: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: (fn: (ev: KeyboardEvent) => boolean) => { keyHandler = fn; },
    press: (ev: Partial<KeyboardEvent>) => keyHandler?.({ type: "keydown", preventDefault: () => {}, ...ev } as KeyboardEvent),
  };
  terms.push(term);
  return term;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class { constructor() { return makeTerm() as unknown as object; } },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  sockets.length = 0;
  sent.length = 0;
  terms.length = 0;
  selection = "";
  const WebSocketStub = function (url: string) { return new FakeWs(url); } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const t = (key: string, params?: Record<string, string | number>) => key.replace(/\{n\}/, "") + (params?.n ?? "");

describe("terminalTabTitle", () => {
  it("names a tab after what it runs, or by its number", () => {
    expect(terminalTabTitle({ id: 1, command: "claude-ds --resume abc" }, t)).toBe("claude-ds");
    expect(terminalTabTitle({ id: 2, command: "/home/clawbox/clawbox/scripts/coding-run-preview '/x'" }, t)).toBe("coding-run-preview");
    expect(terminalTabTitle({ id: 3, command: "cd '/p' && claude-ds --resume abc" }, t)).toBe("claude-ds");
    expect(terminalTabTitle({ id: 4 }, t)).toBe("terminal.tab4");
  });
});

describe("TerminalTabs", () => {
  it("types the window's command into the first tab only, and names the tab after it", async () => {
    render(<TerminalTabs initialCommand="claude-ds" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(screen.getByTestId("terminal-tab-1")).toHaveTextContent("claude-ds");
    await act(async () => { sockets[0].open(); sockets[0].output("$ "); });
    expect(sent.filter((f) => f.type === "input").map((f) => f.data)).toEqual(["claude-ds\r"]);

    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(2));
    await act(async () => { sockets[1].open(); sockets[1].output("$ "); });
    // The plain shell got no command.
    expect(sent.filter((f) => f.type === "input").length).toBe(1);
  });

  it("brings a new tab to the front and keeps the first mounted behind it", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(sockets.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(screen.getByTestId("terminal-tab-2")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("terminal-tab-1")).toHaveAttribute("aria-selected", "false");
    // Both shells are still there: the first is hidden, not gone.
    expect(screen.getByTestId("terminal-panel-1")).toHaveAttribute("hidden");
    expect(screen.getByTestId("terminal-panel-2")).not.toHaveAttribute("hidden");
    expect(sockets[0].readyState).not.toBe(3);

    fireEvent.click(screen.getByTestId("terminal-tab-1"));
    expect(screen.getByTestId("terminal-panel-1")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("terminal-panel-2")).toHaveAttribute("hidden");
  });

  it("closes a tab onto its neighbour, and opens a fresh one when the last closes", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(sockets.length).toBe(1));
    // One at a time: vitest's mocker resolves two concurrent dynamic imports
    // of the same mocked module unreliably, which is a fact about the test
    // runner, not about the strip.
    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(2));
    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(3));
    expect(screen.getByTestId("terminal-tab-3")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByTestId("terminal-tab-close-3"));
    expect(screen.queryByTestId("terminal-tab-3")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-tab-2")).toHaveAttribute("aria-selected", "true");
    // The closed tab's shell was hung up.
    expect(sockets[2].readyState).toBe(3);

    fireEvent.click(screen.getByTestId("terminal-tab-close-2"));
    fireEvent.click(screen.getByTestId("terminal-tab-close-1"));
    // Never an empty window: a fresh tab takes the place of the last one.
    await waitFor(() => expect(screen.getByTestId("terminal-tab-4")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("answers the shell's tab shortcuts", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    act(() => { terms[0].press({ altKey: true, shiftKey: true, key: "T" }); });
    await waitFor(() => expect(screen.getByTestId("terminal-tab-2")).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(terms.length).toBe(2));
    act(() => { terms[1].press({ altKey: true, shiftKey: true, key: "PageUp" }); });
    expect(screen.getByTestId("terminal-tab-1")).toHaveAttribute("aria-selected", "true");
    act(() => { terms[0].press({ altKey: true, shiftKey: true, key: "PageDown" }); });
    expect(screen.getByTestId("terminal-tab-2")).toHaveAttribute("aria-selected", "true");
    // The browser's own Ctrl+Shift+W (close the window) is never claimed.
    expect(terms[1].press({ ctrlKey: true, shiftKey: true, key: "W" })).toBe(true);
    act(() => { terms[1].press({ altKey: true, shiftKey: true, key: "W" }); });
    await waitFor(() => expect(screen.queryByTestId("terminal-tab-2")).not.toBeInTheDocument());
    expect(screen.getByTestId("terminal-tab-1")).toHaveAttribute("aria-selected", "true");
  });
});

describe("the tab strip's keyboard", () => {
  it("moves the selection with the arrows only from a tab, and lands focus on the neighbour after a keyboard close", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(sockets.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(2));
    const tab2 = screen.getByTestId("terminal-tab-2");
    // An arrow on the CLOSE button must not move the selection.
    fireEvent.keyDown(screen.getByTestId("terminal-tab-close-2"), { key: "ArrowLeft" });
    expect(tab2).toHaveAttribute("aria-selected", "true");
    // From the tab itself it does, and the focus goes with it.
    tab2.focus();
    fireEvent.keyDown(tab2, { key: "ArrowLeft" });
    const tab1 = screen.getByTestId("terminal-tab-1");
    expect(tab1).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab1);
    fireEvent.keyDown(tab1, { key: "End" });
    expect(tab2).toHaveAttribute("aria-selected", "true");
    // A keyboard close (a click with no pointer detail) leaves focus on the
    // tab that is selected next, not on a button that no longer exists.
    const close2 = screen.getByTestId("terminal-tab-close-2");
    close2.focus();
    fireEvent.click(close2, { detail: 0 });
    await waitFor(() => expect(screen.queryByTestId("terminal-tab-2")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId("terminal-tab-1"));
  });
});

describe("the terminal's right-click menu", () => {
  it("copies the selection, and reaches the terminal for Select all and Clear", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const surface = container.querySelector("[tabindex='0']") as HTMLElement;

    // Nothing selected: Copy is offered but greyed.
    fireEvent.contextMenu(surface, { clientX: 40, clientY: 50 });
    expect(screen.getByTestId("terminal-context-menu")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-menu-copy")).toBeDisabled();
    // No readText on this origin: Paste is named as its key combination.
    expect(screen.getByTestId("terminal-menu-paste")).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("terminal-context-menu")).not.toBeInTheDocument();

    selection = "ls -la";
    fireEvent.contextMenu(surface, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByTestId("terminal-menu-copy"));
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(screen.queryByTestId("terminal-context-menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(surface, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByTestId("terminal-menu-select-all"));
    expect(terms[0].selectAll).toHaveBeenCalled();

    fireEvent.contextMenu(surface, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByTestId("terminal-menu-clear"));
    expect(terms[0].clear).toHaveBeenCalled();
    // (clear() is also called on connect; the menu's call is the last one.)
  });

  it("closes on Escape without handing the key to the shell", async () => {
    const { container } = render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const surface = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.contextMenu(surface, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("terminal-context-menu")).toBeInTheDocument();
    // xterm asks the custom handler first; `false` means "not for the shell".
    let handled: boolean | undefined;
    act(() => { handled = terms[0].press({ key: "Escape" }); });
    expect(handled).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("terminal-context-menu")).not.toBeInTheDocument());
    // With the menu closed, Escape is the shell's again.
    expect(terms[0].press({ key: "Escape" })).toBe(true);
  });

  it("keeps the keyboard while it is open — no key reaches the shell, and focus stays on the menu", async () => {
    const { container } = render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const surface = container.querySelector("[tabindex='0']") as HTMLElement;
    // xterm's own hidden input, which the real terminal has and the mocked
    // one does not: the wrapper's fallback forwarder only fires when it finds
    // one and it is NOT focused — which is exactly the state a menu item's
    // focus puts the window in.
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    surface.appendChild(helper);
    await act(async () => { sockets[0].open(); });
    sent.length = 0;

    fireEvent.contextMenu(surface, { clientX: 10, clientY: 10 });
    const menu = screen.getByTestId("terminal-context-menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    // The menu is a child of the div that carries the fallback forwarder, so
    // every one of these bubbles to it. None of them is the shell's: Escape
    // would arrive as \x1b and abort a running claude-ds turn, ArrowDown as
    // \x1b[B (the stray `[B` seen on the prompt), Tab as a literal tab.
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape", "Home", "End"]) {
      fireEvent.keyDown(document.activeElement ?? menu, { key });
    }
    expect(sent.filter((frame) => frame.type === "input")).toEqual([]);

    // And the arrows moved focus WITHIN the menu rather than losing it to the
    // terminal underneath.
    fireEvent.contextMenu(surface, { clientX: 10, clientY: 10 });
    const reopened = await screen.findByTestId("terminal-context-menu");
    await waitFor(() => expect(reopened.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(reopened.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(helper);
  });

  it("pastes through the terminal when the clipboard can be read", async () => {
    const readText = vi.fn(async () => "echo hi");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText: vi.fn(async () => {}) } });
    const { container } = render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const surface = container.querySelector("[tabindex='0']") as HTMLElement;
    fireEvent.contextMenu(surface, { clientX: 10, clientY: 10 });
    const paste = screen.getByTestId("terminal-menu-paste");
    expect(paste).not.toBeDisabled();
    fireEvent.click(paste);
    await waitFor(() => expect(terms[0].paste).toHaveBeenCalledWith("echo hi"));
  });
});
