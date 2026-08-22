import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";
import { CODING_HARNESS_COMMAND } from "@/lib/coding-harness";

/**
 * The Coding icon opens a terminal that is already running the harness.
 *
 * The interesting part is WHEN the command is typed. Sending it on `onopen`
 * types into a pty whose login shell has not been exec'd yet — on a loaded Orin
 * that races with ~/.profile and the first characters are eaten, leaving the
 * owner staring at a prompt that did nothing. Waiting for the shell's first
 * byte of output is the cheap proof that it exists.
 *
 * It must also happen EXACTLY once per connection: every subsequent line of
 * output is ordinary program output, and re-typing `claude-ds` into a running
 * Claude Code session would send it as a prompt.
 */

interface Frame { type: string; data?: string; cols?: number; rows?: number }

const sent: Frame[] = [];
let socket: FakeWs | null = null;

class FakeWs {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {}

  send(raw: string) { sent.push(JSON.parse(raw) as Frame); }
  close() { this.readyState = 3; }

  /** The server accepted the connection. */
  open() {
    this.readyState = FakeWs.OPEN;
    this.onopen?.();
  }

  /** One chunk of pty output, as the terminal server frames it. */
  output(data: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "output", data }) } as MessageEvent);
  }
}

// xterm never renders in jsdom; the component only needs the surface it calls.
// Rebuilt per test because the suite runs with `mockReset`, which would strip
// the return value off a module-level vi.fn() before the second test.
function makeTerm() {
  return {
    cols: 80,
    rows: 24,
    loadAddon: () => {},
    open: () => {},
    clear: () => {},
    focus: () => {},
    write: () => {},
    writeln: () => {},
    dispose: () => {},
    onData: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
  };
}

let term = makeTerm();

vi.mock("@xterm/xterm", () => ({
  // A class, not vi.fn(): `new Terminal()` must keep working after mockReset.
  Terminal: class { constructor() { return term as unknown as object; } },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const inputs = () => sent.filter((f) => f.type === "input").map((f) => f.data);

beforeEach(() => {
  sent.length = 0;
  socket = null;
  term = makeTerm();
  // A factory rather than the class itself, so the test can hold on to the
  // instance the component created without aliasing `this` in a constructor.
  const WebSocketStub = function (url: string) {
    socket = new FakeWs(url);
    return socket;
  } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  // setup.ts installs a vi.fn() ResizeObserver, and this suite runs with
  // `mockReset`, which strips its implementation before the test body.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render, let the dynamic xterm import settle, and return the live socket. */
async function mount(initialCommand?: string): Promise<FakeWs> {
  render(<TerminalApp initialCommand={initialCommand} />);
  await waitFor(() => expect(socket).not.toBeNull());
  return socket as FakeWs;
}

describe("the Coding app's terminal", () => {
  it("types nothing before the shell has spoken", async () => {
    const ws = await mount(CODING_HARNESS_COMMAND);
    await act(async () => { ws.open(); });
    // Connected, sized — and silent. A command sent here would race the shell.
    expect(sent.some((f) => f.type === "resize")).toBe(true);
    expect(inputs()).toEqual([]);
  });

  it("runs the harness once the shell produces its prompt", async () => {
    const ws = await mount(CODING_HARNESS_COMMAND);
    await act(async () => { ws.open(); ws.output("clawbox@clawbox:~$ "); });
    expect(inputs()).toEqual([`${CODING_HARNESS_COMMAND}\r`]);
  });

  it("types it exactly once, however much the program then prints", async () => {
    const ws = await mount(CODING_HARNESS_COMMAND);
    await act(async () => {
      ws.open();
      ws.output("clawbox@clawbox:~$ ");
      ws.output("claude-ds: ClawBox AI (deepseek-v4-flash)\r\n");
      ws.output("> ");
    });
    expect(inputs()).toEqual([`${CODING_HARNESS_COMMAND}\r`]);
  });

  it("leaves a plain Terminal window plain", async () => {
    const ws = await mount();
    await act(async () => { ws.open(); ws.output("clawbox@clawbox:~$ "); });
    expect(inputs()).toEqual([]);
  });

  it("ignores a blank command rather than pressing Enter on an empty line", async () => {
    const ws = await mount("   ");
    await act(async () => { ws.open(); ws.output("clawbox@clawbox:~$ "); });
    expect(inputs()).toEqual([]);
  });
});
