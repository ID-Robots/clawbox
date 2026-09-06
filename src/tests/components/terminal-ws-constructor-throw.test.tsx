import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";

/**
 * The Terminal's connect lock has to come back down when the socket
 * constructor throws (TASK-712's sibling call site).
 *
 * `connect()` raises `connectLockRef` on entry and only `onopen` and `onclose`
 * lower it again — neither of which a constructor that threw will ever call.
 * With the flag stuck raised every later `connect()` returned at its own
 * guard, so the 3 s auto-reconnect AND the Reconnect button in the status bar
 * both became no-ops: the window sat on "Connecting to terminal server…"
 * until the owner closed and reopened it.
 */

let throwOnNextConstruct = false;
const sockets: FakeWs[] = [];

class FakeWs {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

const writes: string[] = [];
function makeTerm() {
  return {
    cols: 80, rows: 24,
    loadAddon: () => {}, open: () => {}, focus: () => {}, write: () => {},
    writeln: (line: string) => { writes.push(line); },
    dispose: () => {}, clear: () => {}, selectAll: () => {}, paste: () => {},
    getSelection: () => "",
    onData: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
  };
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class { constructor() { return makeTerm() as unknown as object; } },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

describe("a terminal socket constructor that throws", () => {
  beforeEach(() => {
    sockets.length = 0;
    writes.length = 0;
    throwOnNextConstruct = true;
    const WebSocketStub = function (url: string) {
      if (throwOnNextConstruct) {
        throwOnNextConstruct = false;
        throw new SyntaxError("The URL's scheme must be either 'ws' or 'wss'.");
      }
      return new FakeWs(url);
    } as unknown as typeof WebSocket;
    (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
    vi.stubGlobal("WebSocket", WebSocketStub);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says so and leaves Reconnect working", async () => {
    render(<TerminalApp />);

    // The failure is reported rather than swallowed behind "Connecting…".
    await screen.findByText("Error");
    expect(writes.some((line) => line.includes("Cannot connect to"))).toBe(true);
    expect(sockets).toHaveLength(0);

    // And the button in the status bar can still open one.
    fireEvent.click(screen.getByText("Reconnect"));
    await waitFor(() => expect(sockets).toHaveLength(1));
  });
});
