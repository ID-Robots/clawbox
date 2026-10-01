/**
 * The browser's half of the Terminal's device sessions (TASK-1306,
 * src/lib/terminal-sessions.ts): where the PTY socket is, and the short
 * `?end=` socket a hand-closed window or tab ends its session with.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { endTerminalSession, isTerminalSessionId, terminalWsUrl } from "@/lib/terminal-sessions";

const ID = "11111111-2222-4333-8444-555555555555";

class FakeWs {
  static made: FakeWs[] = [];
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = 0;
  constructor(public url: string) { FakeWs.made.push(this); }
  close() { this.closed++; }
}

afterEach(() => {
  FakeWs.made = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("terminalWsUrl", () => {
  it("is the page's own origin, secure when the page is", () => {
    expect(terminalWsUrl({ protocol: "http:", host: "clawbox.local" })).toBe("ws://clawbox.local/terminal-ws");
    expect(terminalWsUrl({ protocol: "https:", host: "box.example:8443" })).toBe("wss://box.example:8443/terminal-ws");
    expect(terminalWsUrl(undefined)).toBe("ws://localhost/terminal-ws");
  });
});

describe("isTerminalSessionId", () => {
  it.each([[ID, true], ["short", false], ["../../etc/passwd-xxxxxxxxxx", false], [42, false], [null, false]])("%s → %s", (value, ok) => {
    expect(isTerminalSessionId(value)).toBe(ok);
  });
});

describe("endTerminalSession", () => {
  it("asks the box to end the session on a socket of its own, and hangs up when answered", () => {
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("window", { location: { protocol: "http:", host: "clawbox.local" } });
    endTerminalSession(ID);
    expect(FakeWs.made.map((ws) => ws.url)).toEqual([`ws://clawbox.local/terminal-ws?end=${ID}`]);
    FakeWs.made[0].onmessage?.();
    expect(FakeWs.made[0].closed).toBe(1);
  });

  it("gives up after a while when nothing answers", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWs);
    endTerminalSession(ID);
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.made[0].closed).toBe(1);
  });

  it("sends nothing for a missing or malformed id", () => {
    vi.stubGlobal("WebSocket", FakeWs);
    endTerminalSession(undefined);
    endTerminalSession(null);
    endTerminalSession("not-an-id");
    expect(FakeWs.made).toEqual([]);
  });

  it("does not throw when the browser refuses the socket", () => {
    vi.stubGlobal("WebSocket", class { constructor() { throw new Error("blocked"); } });
    expect(() => endTerminalSession(ID)).not.toThrow();
  });
});
