// @vitest-environment jsdom
/**
 * The Terminal's own copy, in the language the desktop is in.
 *
 * Every string in this window went through `t()` except the ones the
 * CONNECTION speaks: the status bar and its Reconnect button, the two lines
 * written into the transcript, the loader, and the tab strip's accessible
 * name. On a German box the strip said "Neuer Tab" and "Kopieren" while the
 * bar underneath it said "Disconnected — ws://…" with a "Reconnect" button.
 *
 * Both halves are pinned: the keys are used when the catalogue carries them,
 * and English stands in when it does not — a raw `terminal.disconnected` on
 * screen would be worse than the English it replaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";
import TerminalTabs from "@/components/TerminalTabs";

const catalogue = vi.hoisted(() => ({ table: {} as Record<string, string> }));

// Only the dictionary is stubbed. The English floor these components read
// through is the REAL `useTr` (@/lib/i18n-floor), which asks this `t` like any
// other caller — so a key missing from the table below is proven to fall back
// rather than merely asserted against a second copy of the rule.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => catalogue.table[key] ?? key,
  }),
}));

const DE: Record<string, string> = {
  "terminal.connecting": "Verbinde…",
  "terminal.disconnected": "Getrennt",
  "terminal.reconnect": "Neu verbinden",
  "terminal.connectingToServer": "Verbinde mit dem Terminalserver…",
  "terminal.retrying": "Getrennt — neuer Versuch in 3 s…",
  "terminal.tabsLabel": "Terminal-Tabs",
  "terminal.tab": "Terminal {n}",
};

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
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const sockets: FakeWs[] = [];

const written: string[] = [];
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
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  sockets.length = 0;
  written.length = 0;
  catalogue.table = { ...DE };
  const WebSocketStub = function (url: string) { return new FakeWs(url); } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Terminal's connection copy", () => {
  it("speaks the desktop's language in the status bar, its button and the transcript", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(sockets.length).toBe(1));

    expect(await screen.findByText("Verbinde…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neu verbinden" })).toBeInTheDocument();
    expect(written.some((line) => line.includes("Verbinde mit dem Terminalserver…"))).toBe(true);

    // The retry line the shell prints when the socket goes away.
    await act(async () => { sockets[0].drop(); });
    expect(written.some((line) => line.includes("Getrennt — neuer Versuch in 3 s…"))).toBe(true);
    expect(await screen.findByText("Getrennt")).toBeInTheDocument();
  });

  it("names the tab strip in the desktop's language", async () => {
    render(<TerminalTabs />);
    expect(await screen.findByRole("tablist", { name: "Terminal-Tabs" })).toBeInTheDocument();
  });

  it("falls back to English, never to the raw key, on a catalogue that lacks the keys", async () => {
    catalogue.table = {};
    render(<TerminalApp />);
    await waitFor(() => expect(sockets.length).toBe(1));

    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(written.some((line) => line.includes("Connecting to terminal server…"))).toBe(true);
    expect(screen.queryByText("terminal.connecting")).toBeNull();
  });
});
