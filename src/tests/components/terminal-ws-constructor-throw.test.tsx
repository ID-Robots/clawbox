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

/** Every attempt, because `wsUrl` is derived once from `window.location` and
 *  cannot change: a url the browser refuses is refused again on the retry. */
let constructions = 0;

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
    constructions = 0;
    writes.length = 0;
    const WebSocketStub = function () {
      constructions += 1;
      throw new SyntaxError("The URL's scheme must be either 'ws' or 'wss'.");
    } as unknown as typeof WebSocket;
    (WebSocketStub as unknown as { OPEN: number }).OPEN = 1;
    vi.stubGlobal("WebSocket", WebSocketStub);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says why, and lets Reconnect try again", async () => {
    render(<TerminalApp />);

    // The failure is reported rather than swallowed behind "Connecting…", and
    // it names what actually refused: the browser, not the PTY server.
    await screen.findByText("Error");
    await waitFor(() => expect(constructions).toBe(1));
    expect(writes.some((line) => line.includes("the browser refused"))).toBe(true);
    expect(writes.some((line) => line.includes("scheme must be either"))).toBe(true);

    // The lock came back down, so the button in the status bar reaches the
    // constructor a second time. It throws again — the url cannot change — but
    // the attempt is the proof, and on beta there was none.
    fireEvent.click(screen.getByText("Reconnect"));
    await waitFor(() => expect(constructions).toBe(2));
  });
});
