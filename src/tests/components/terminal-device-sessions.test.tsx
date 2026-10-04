import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalTabs from "@/components/TerminalTabs";
import { WindowChromeContext, type WindowChrome } from "@/lib/window-chrome";
import type { SavedTerminalTabs } from "@/lib/desktop-state";

/**
 * A desktop Terminal's shells are sessions on the box that outlive the page
 * (TASK-1306). Pinned here, against the browser half:
 *
 * - a desktop window asks for a NEW session and records the id it is given in
 *   the tab list it hands the desktop to save; the standalone page asks for
 *   none, and its shells end with the page as they always did;
 * - a restored window reattaches every tab to ITS session, starts from the
 *   replayed scrollback and types nothing into a shell already running;
 * - a session that no longer exists is said as such, no fresh shell is opened
 *   by itself, and Enter starts a new one;
 * - closing a tab by hand ends its session on the box; unmounting (a refresh)
 *   does not;
 * - only the focused window's terminal takes the keyboard.
 */

interface Frame { type: string; data?: string }

const SESSION_1 = "11111111-2222-4333-8444-555555555555";
const SESSION_2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const SESSION_NEW = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

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
  message(msg: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  get query() { return new URL(this.url).searchParams; }
}

interface FakeTerm {
  cols: number; rows: number;
  lines: string[];
  loadAddon: () => void; open: () => void; focus: ReturnType<typeof vi.fn>; write: (d: string) => void; writeln: (d: string) => void; dispose: () => void;
  clear: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>;
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
    lines: [],
    loadAddon: () => {}, open: () => {}, focus: vi.fn(), dispose: () => {},
    write: (d: string) => { term.lines.push(d); },
    writeln: (d: string) => { term.lines.push(d); },
    clear: vi.fn(), reset: vi.fn(() => { term.lines.length = 0; }),
    getSelection: () => "",
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
  const WebSocketStub = function (url: string) { return new FakeWs(url); } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The terminal sockets, without the short ones that end a session. */
const shellSockets = () => sockets.filter((ws) => !ws.query.has("end"));
const endRequests = () => sockets.filter((ws) => ws.query.has("end")).map((ws) => ws.query.get("end"));

describe("a desktop Terminal window's device sessions", () => {
  it("starts a new session and hands its id to the desktop to save", async () => {
    const onStateChange = vi.fn();
    render(<TerminalTabs initialCommand="htop" onStateChange={onStateChange} />);
    await waitFor(() => expect(shellSockets()).toHaveLength(1));
    expect(sockets[0].query.get("session")).toBe("new");
    expect(onStateChange).toHaveBeenLastCalledWith({ tabs: [{ id: 1, command: "htop" }], activeId: 1, nextId: 2 });

    await act(async () => {
      sockets[0].open();
      sockets[0].message({ type: "started", session: SESSION_NEW, shell: "/bin/bash", cwd: "/home/owner" }); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
      sockets[0].message({ type: "output", data: "$ " });
    });
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith({ tabs: [{ id: 1, command: "htop", session: SESSION_NEW }], activeId: 1, nextId: 2 }));
    // A new shell still gets the window's command.
    expect(sent.filter((f) => f.type === "input").map((f) => f.data)).toEqual(["htop\r"]);
  });

  it("leaves the standalone Terminal's shells as they were: no session, gone with the page", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(shellSockets()).toHaveLength(1));
    expect(sockets[0].query.has("session")).toBe(false);
  });

  it("reattaches every restored tab to its own session and types nothing into a running shell", async () => {
    const persisted: SavedTerminalTabs = {
      tabs: [{ id: 1, command: "long-backup", session: SESSION_1 }, { id: 4, title: "logs", session: SESSION_2 }],
      activeId: 4,
      nextId: 5,
    };
    const onStateChange = vi.fn();
    render(<TerminalTabs persisted={persisted} onStateChange={onStateChange} />);
    await waitFor(() => expect(shellSockets()).toHaveLength(2));
    expect(sockets.map((ws) => ws.query.get("session"))).toEqual([SESSION_1, SESSION_2]);
    expect(screen.getByTestId("terminal-tab-4")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("terminal-tab-4")).toHaveTextContent("logs");

    await act(async () => {
      sockets[0].open();
      sockets[0].message({ type: "attached", session: SESSION_1, shell: "/bin/bash", cwd: "/home/owner" }); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
      sockets[0].message({ type: "output", data: "tick 1\r\ntick 2\r\n", replay: true });
      sockets[0].message({ type: "output", data: "tick 3\r\n" });
    });
    expect(terms[0].reset).toHaveBeenCalledTimes(1);
    expect(terms[0].lines.join("")).toBe("tick 1\r\ntick 2\r\ntick 3\r\n");
    expect(sent.filter((f) => f.type === "input")).toEqual([]);
    expect(onStateChange).toHaveBeenLastCalledWith(persisted);
    // Nothing was ended by coming back.
    expect(endRequests()).toEqual([]);
  });

  it("says a session no longer exists, opens no shell by itself, and starts one on Enter", async () => {
    const onStateChange = vi.fn();
    render(<TerminalTabs persisted={{ tabs: [{ id: 1, session: SESSION_1 }], activeId: 1, nextId: 2 }} onStateChange={onStateChange} />);
    await waitFor(() => expect(shellSockets()).toHaveLength(1));
    await act(async () => {
      sockets[0].open();
      sockets[0].message({ type: "gone" });
      sockets[0].drop(1000);
    });
    expect(terms[0].lines.join("\n")).toMatch(/session no longer exists on the box/);
    expect(await screen.findByText("Session no longer exists")).toBeInTheDocument();
    // No retry, no new shell.
    await new Promise((r) => setTimeout(r, 20));
    expect(shellSockets()).toHaveLength(1);
    // The saved tab keeps naming the old session until a new one exists, so
    // a refresh says the same thing again instead of opening a shell.
    expect(onStateChange).toHaveBeenLastCalledWith({ tabs: [{ id: 1, session: SESSION_1 }], activeId: 1, nextId: 2 });

    act(() => { terms[0].press({ key: "Enter" }); });
    await waitFor(() => expect(shellSockets()).toHaveLength(2));
    expect(sockets[1].query.get("session")).toBe("new");
    await act(async () => {
      sockets[1].open();
      sockets[1].message({ type: "started", session: SESSION_NEW, shell: "/bin/bash", cwd: "/home/owner" }); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    });
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith({ tabs: [{ id: 1, session: SESSION_NEW }], activeId: 1, nextId: 2 }));
    // The session it replaced is told to go (it is gone already; the ask is harmless).
    expect(endRequests()).toEqual([SESSION_1]);
  });

  it("reattaches to the same session when the connection drops, not to a new one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TerminalTabs onStateChange={() => {}} />);
      await waitFor(() => expect(shellSockets()).toHaveLength(1));
      await act(async () => {
        sockets[0].open();
        sockets[0].message({ type: "started", session: SESSION_NEW, shell: "/bin/bash", cwd: "/" });
        sockets[0].drop(1006);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      await waitFor(() => expect(shellSockets()).toHaveLength(2));
      expect(sockets[1].query.get("session")).toBe(SESSION_NEW);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a tab's session when the tab is closed by hand, and nothing when the window unmounts", async () => {
    const { unmount } = render(<TerminalTabs persisted={{ tabs: [{ id: 1, session: SESSION_1 }, { id: 2, session: SESSION_2 }], activeId: 2, nextId: 3 }} onStateChange={() => {}} />);
    await waitFor(() => expect(shellSockets()).toHaveLength(2));
    fireEvent.click(screen.getByTestId("terminal-tab-close-2"));
    await waitFor(() => expect(endRequests()).toEqual([SESSION_2]));
    unmount();
    expect(endRequests()).toEqual([SESSION_2]);
  });

  it("gives the keyboard only to a terminal in the window that has the focus", async () => {
    const chrome = (active: boolean): WindowChrome => ({ actions: null, active, tone: "dark", setTone: () => {} });
    render(
      <>
        <WindowChromeContext.Provider value={chrome(false)}>
          <TerminalTabs onStateChange={() => {}} />
        </WindowChromeContext.Provider>
        <WindowChromeContext.Provider value={chrome(true)}>
          <TerminalTabs onStateChange={() => {}} />
        </WindowChromeContext.Provider>
      </>,
    );
    await waitFor(() => expect(shellSockets()).toHaveLength(2));
    await act(async () => { sockets[0].open(); sockets[1].open(); });
    const background = terms.find((_, i) => sockets[i] === sockets[0])!;
    expect(background.focus).not.toHaveBeenCalled();
    expect(terms[1].focus).toHaveBeenCalled();
  });
});
