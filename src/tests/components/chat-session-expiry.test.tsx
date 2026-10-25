import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import {
  SESSION_EXPIRED_CHAT_MESSAGE,
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_EVENT,
  SESSION_PROBE_URL,
  sessionExpiredHeaders,
} from "@/lib/session-expiry";

// Both chats mount the full gateway handshake; see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A chat whose session has run out stops, and the page goes to /login.
 *
 * The chat was the one thing a lapsed session could still use: its socket was
 * opened while the session was good and nothing ever looked at it again. The
 * box now ends that socket (scripts/upgrade-session-watch.js) and refuses the
 * chat's routes with the session gate's marked 401 — and both chats, the
 * desktop's popup and the standalone page, have to take that as "signed out":
 * close the socket, open no other, and leave for /login carrying where they
 * were — never sit behind a "Restarting chat…" overlay retrying into 401s.
 */

const sockets: FakeGatewayWs[] = [];
let connects = 0;
let wsConfigAnswer: "ok" | "session-gate" = "ok";
let probeAnswer: "ok" | "session-gate" = "ok";
/** ws-config refusals still to answer with the session gate's 401 before answering normally. */
let wsConfigRefusals = 0;
/** Upgrades still to refuse — closed before any frame, the way a browser reports the gate's plain 401. */
let upgradeRefusals = 0;

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(public url: string) {
    sockets.push(this);
    if (upgradeRefusals > 0) {
      upgradeRefusals -= 1;
      setTimeout(() => this.serverClose(1006), 0);
      return;
    }
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    this.sent.push(String(frame.method));
    const id = frame.id as string;
    if (frame.method === "connect") {
      connects += 1;
      setTimeout(() => this.emit({
        type: "res", id, ok: true,
        payload: { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } },
      }), 0);
      return;
    }
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload: { messages: [], questions: [] } }), 0);
  }

  close() { this.closed = true; this.readyState = FakeGatewayWs.CLOSED; }
  addEventListener() {}
  removeEventListener() {}

  /** The box ends the socket from its side. */
  serverClose(code: number, reason = "") {
    this.readyState = FakeGatewayWs.CLOSED;
    this.onclose?.({ code, reason, wasClean: code !== 1006 } as CloseEvent);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const sessionGate401 = () => ({
  ok: false,
  status: 401,
  headers: new Headers(sessionExpiredHeaders()),
  json: async () => ({ error: "Authentication required" }),
});

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      if (wsConfigAnswer === "session-gate") return sessionGate401();
      if (wsConfigRefusals > 0) {
        wsConfigRefusals -= 1;
        return sessionGate401();
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes(SESSION_PROBE_URL)) {
      if (probeAnswer === "session-gate") return sessionGate401();
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ username: "clawbox", isOwner: true }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ options: [], activeOptionId: "" }) };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
  }));
}

let replace: ReturnType<typeof vi.fn>;
let savedLocation: PropertyDescriptor | undefined;

function stubLocation() {
  savedLocation = Object.getOwnPropertyDescriptor(window, "location");
  const real = window.location;
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: real.href,
      origin: real.origin,
      protocol: real.protocol,
      host: real.host,
      hostname: real.hostname,
      port: real.port,
      pathname: real.pathname,
      search: real.search,
      hash: real.hash,
      assign: vi.fn(),
      reload: vi.fn(),
      replace,
      toString: () => real.href,
    },
  });
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

beforeEach(() => {
  sockets.length = 0;
  connects = 0;
  wsConfigAnswer = "ok";
  probeAnswer = "ok";
  wsConfigRefusals = 0;
  upgradeRefusals = 0;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
  stubLocation();
});

afterEach(() => {
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
  vi.unstubAllGlobals();
  resetHarnessCache();
});

const SIGNED_OUT = "/login?redirect=%2F";

describe("the desktop chat (ChatPopup) on a lapsed session", () => {
  it("signs the page out when the box closes the socket for an expired session, and never reconnects", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    probeAnswer = "session-gate";
    await act(async () => { sockets[0].serverClose(SESSION_EXPIRED_CLOSE_CODE, "Session expired"); });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    expect(await screen.findByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/Restarting/i)).toBeNull();

    // No Retry is offered (it could only do nothing), and the retry ladder
    // opens no other socket on the way out.
    expect(screen.queryByText("chat.retry")).toBeNull();
    await settle();
    expect(sockets).toHaveLength(1);
  });

  it("reconnects instead of signing out when the closed socket's session was replaced on this page", async () => {
    // A password changed in this browser revokes the cookie the socket was
    // opened on and hands the page a new one. The box ends the old socket with
    // the same code; the page is still signed in.
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    await act(async () => { sockets[0].serverClose(SESSION_EXPIRED_CLOSE_CODE, "Session expired"); });
    await waitFor(() => expect(connects).toBe(2), { timeout: 10_000 });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeNull();
  });

  it("opens no socket at all when the session gate answers the chat's ws-config", async () => {
    wsConfigAnswer = "session-gate";
    probeAnswer = "session-gate";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    await settle();
    expect(sockets).toHaveLength(0);
    expect(screen.getByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeInTheDocument();
  });

  it("treats a late ws-config refusal on a session the box still accepts as an ordinary failure, and connects on the retry", async () => {
    // The read left before a sign-in in another tab and came back refused;
    // the page's cookie is good now.
    wsConfigRefusals = 1;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(connects).toBe(1), { timeout: 10_000 });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeNull();
  });

  it("closes its live socket the moment anything else on the page sees the session end", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    await act(async () => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); });
    expect(sockets[0].closed).toBe(true);
    expect(await screen.findByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("chat.retry")).toBeNull();

    // A connect from anywhere else on the page (the online/visibility
    // listeners call it directly) opens nothing either.
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(sockets).toHaveLength(1);
  });
});

describe("the standalone chat page (ChatApp) on a lapsed session", () => {
  it("signs the page out when the box closes the socket for an expired session", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    probeAnswer = "session-gate";
    await act(async () => { sockets[0].serverClose(SESSION_EXPIRED_CLOSE_CODE, "Session expired"); });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    expect(await screen.findByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeInTheDocument();
    // Neither the panel's Retry nor the header's Reconnect: both could only do nothing.
    expect(screen.queryByText("chat.retry")).toBeNull();
    expect(screen.queryByText("chat.reconnect")).toBeNull();
  });

  it("reconnects instead of signing out when the closed socket's session was replaced on this page", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    await act(async () => { sockets[0].serverClose(SESSION_EXPIRED_CLOSE_CODE, "Session expired"); });
    await waitFor(() => expect(connects).toBe(2), { timeout: 10_000 });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(SESSION_EXPIRED_CHAT_MESSAGE)).toBeNull();
  });

  it("asks the box about its session when a live chat drops without a code, and signs out if it is over", async () => {
    // Over plain HTTP the box cuts a lapsed session's socket outright.
    probeAnswer = "session-gate";
    render(<ChatApp />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    await act(async () => { sockets[0].serverClose(1006); });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === SESSION_PROBE_URL)).toBe(true);
  });

  it("a drop on a session that is still good stays on the page and reconnects", async () => {
    // Over plain HTTP a password changed in this browser cuts the socket
    // opened on the old cookie with no code; the page holds the new one.
    render(<ChatApp />);
    await waitFor(() => expect(connects).toBe(1));
    await settle();

    await act(async () => { sockets[0].serverClose(1006); });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === SESSION_PROBE_URL)).toBe(true));
    await waitFor(() => expect(connects).toBe(2), { timeout: 10_000 });
    expect(replace).not.toHaveBeenCalled();

    // A late close from the socket it already let go of changes nothing.
    await act(async () => { sockets[0].serverClose(1006); });
    await settle();
    await new Promise((r) => setTimeout(r, 3_500));
    expect(sockets).toHaveLength(2);
    expect(sockets[1].closed).toBe(false);
  });

  it("opens no socket at all when the session gate answers the chat's ws-config", async () => {
    wsConfigAnswer = "session-gate";
    probeAnswer = "session-gate";
    render(<ChatApp />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    await settle();
    expect(sockets).toHaveLength(0);
  });

  it("treats a late ws-config refusal on a session the box still accepts as an ordinary failure, with its Reconnect", async () => {
    wsConfigRefusals = 1;
    render(<ChatApp />);
    expect(await screen.findByText("Failed to get gateway config")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("chat.reconnect")).toBeInTheDocument();
  });

  it("signs the page out when the session gate refuses the socket itself, before any hello", async () => {
    // The session ran out between ws-config and the upgrade: the gate answers
    // the upgrade with a plain 401, which the browser reports as a bare close.
    upgradeRefusals = 1;
    probeAnswer = "session-gate";
    render(<ChatApp />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    await settle();
    expect(sockets).toHaveLength(1);
    expect(connects).toBe(0);
    expect(screen.queryByText("Could not connect to gateway")).toBeNull();
    expect(screen.queryByText("chat.reconnect")).toBeNull();
  });

  it("a socket refused before any hello on a session that is still good is an ordinary failed connect, with its Reconnect", async () => {
    upgradeRefusals = 1;
    render(<ChatApp />);
    expect(await screen.findByText("Could not connect to gateway")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === SESSION_PROBE_URL)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("chat.reconnect")).toBeInTheDocument();
  });
});
