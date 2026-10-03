// @vitest-environment jsdom
/**
 * The Terminal on a session switch (TASK-1247).
 *
 * Its socket is authorised once, at upgrade, with the cookie of the moment —
 * the proxy never looks again — so a Terminal left open while another tab
 * signed in (a 12-hour session, another user) stayed on the PREVIOUS
 * session's shell until someone reloaded. The page now leaves for the new
 * session, and the Terminal drops that socket first, cleanly and without its
 * 3 s retry. An ordinary drop still retries exactly as before.
 */
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";
import StandaloneAppPage from "@/app/app/[id]/page";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { SESSION_SWITCH_EVENT, announceSessionSwitch } from "@/lib/session-switch";
import {
  announceFromAnotherTab,
  channelTick,
  installFakeBroadcastChannel,
  stubLocation,
  type StubbedLocation,
} from "@/tests/helpers/session-switch";

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useT: () => ({ t: (key: string) => key }),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "terminal" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));

class FakeWs {
  static readonly OPEN = 1;
  readyState = 0;
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this); }
  send() {}
  close(code?: number, reason?: string) { this.readyState = 3; this.closedWith = { code, reason }; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const sockets: FakeWs[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    unicode = { activeVersion: "6" };
    loadAddon() {}
    open() {}
    focus() {}
    clear() {}
    write() {}
    writeln() {}
    dispose() {}
    getSelection() { return ""; }
    hasSelection() { return false; }
    onData() { return { dispose: () => {} }; }
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

let location: StubbedLocation | undefined;

beforeEach(() => {
  sockets.length = 0;
  window.localStorage.clear();
  installFakeBroadcastChannel();
  _resetSessionUserForTest();
  const WebSocketStub = function (url: string) { return new FakeWs(url); } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = FakeWs.OPEN;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => (String(input).includes("/setup-api/users/me")
      ? { username: "clawbox", isOwner: true, multiUser: false }
      : {}),
  })));
});

afterEach(() => {
  location?.restore();
  location = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function connectedTerminal() {
  const view = render(<TerminalApp />);
  await waitFor(() => expect(sockets.length).toBe(1));
  await act(async () => { sockets[0].open(); });
  return view;
}

const leaveSession = () => act(() => { window.dispatchEvent(new CustomEvent(SESSION_SWITCH_EVENT)); });

describe("TerminalApp — the page leaves for another session", () => {
  it("closes the previous session's socket cleanly and does not reopen it on its own", async () => {
    await connectedTerminal();
    vi.useFakeTimers();
    leaveSession();

    expect(sockets[0].closedWith).toEqual({ code: 1000, reason: "session switched" });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(sockets).toHaveLength(1);
    // Said as a disconnect, with the way back offered.
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("drops a socket that was still opening, and Reconnect is not left stuck", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(sockets.length).toBe(1));
    leaveSession();
    expect(sockets[0].closedWith?.code).toBe(1000);

    // A person asking for a shell gets one — on whatever session holds now.
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(sockets).toHaveLength(2));
  });

  it("drops it on its own page's Switch user too", async () => {
    await connectedTerminal();
    act(() => { announceSessionSwitch("logout"); });
    expect(sockets[0].closedWith?.code).toBe(1000);
  });

  it("still retries an ordinary drop after 3 s — reconnect behaviour unchanged", async () => {
    await connectedTerminal();
    vi.useFakeTimers();
    await act(async () => { sockets[0].drop(); });
    act(() => { vi.advanceTimersByTime(3000); });
    vi.useRealTimers();
    await waitFor(() => expect(sockets).toHaveLength(2));
  });
});

describe("/app/terminal — a Terminal tab while another tab switches the session", () => {
  it("drops its shell and reopens /app/terminal on the new session", async () => {
    location = stubLocation("/app/terminal");
    render(<StandaloneAppPage />);
    await waitFor(() => expect(sockets.length).toBe(1), { timeout: 5_000 });
    await act(async () => { sockets[0].open(); });

    announceFromAnotherTab("login", "channel");
    await act(async () => { await channelTick(); });

    expect(sockets[0].closedWith).toEqual({ code: 1000, reason: "session switched" });
    expect(location!.replace).toHaveBeenCalledTimes(1);
    expect(location!.replace).toHaveBeenCalledWith("/app/terminal");
    expect(location!.assign).not.toHaveBeenCalled();
  });

  it("is left alone by storage traffic that is not a session switch", async () => {
    location = stubLocation("/app/terminal");
    render(<StandaloneAppPage />);
    await waitFor(() => expect(sockets.length).toBe(1), { timeout: 5_000 });
    await act(async () => { sockets[0].open(); });

    window.dispatchEvent(new StorageEvent("storage", { key: "clawbox-custom-wallpapers", newValue: "[]" }));
    await act(async () => { await channelTick(); });

    expect(sockets[0].closedWith).toBeNull();
    expect(location!.replace).not.toHaveBeenCalled();
  });
});
