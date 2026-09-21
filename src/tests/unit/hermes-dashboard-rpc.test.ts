import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One JSON-RPC call to the Hermes dashboard, for callers that want an answer
 * rather than a conversation.
 *
 * What has to be true for `reload.mcp` to be safe to fire from a settings save
 * is what is pinned here: the confirmation flag really is on the wire (without
 * it the dashboard answers `confirm_required` and does nothing, which would look
 * exactly like success), and EVERY way this can fail comes back as null instead
 * of an exception — the caller is a save the owner is waiting on, and a box with
 * no dashboard at all is an ordinary box.
 */

const ticketMock = vi.hoisted(() => vi.fn());

/**
 * Just enough of `ws` to be wrong in the ways that matter: listeners registered
 * by name, a `readyState` that starts closed, and an `open` that has to be
 * driven — because the real socket comes up asynchronously and code that
 * assumes otherwise passes here and hangs on the box.
 */
const fake = vi.hoisted(() => {
  const made: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(readonly url: string) {
      made.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) || [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        cb(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, cb: (...args: unknown[]) => void) {
      this.listeners.set(event, (this.listeners.get(event) || []).filter((f) => f !== cb));
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) || [])]) cb(...args);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw) as Record<string, unknown>);
    }
    close() {
      this.closed = true;
    }
    /** Come up, the way `ws` does asynchronously. */
    open() {
      this.readyState = FakeSocket.OPEN;
      this.emit("open");
    }
    /** Deliver one JSON-RPC frame from the server. */
    deliver(frame: unknown) {
      this.emit("message", JSON.stringify(frame));
    }
  }
  return { made, FakeSocket };
});

type FakeSocket = InstanceType<typeof fake.FakeSocket>;

vi.mock("ws", () => ({ WebSocket: fake.FakeSocket }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardWsTicket: ticketMock,
  DASHBOARD_WS_ORIGIN: "ws://127.0.0.2:9119",
}));

import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";

/** The socket the module just made, after letting the ticket promise settle. */
async function latest(): Promise<FakeSocket> {
  for (let i = 0; i < 50 && fake.made.length === 0; i++) await Promise.resolve();
  return fake.made[fake.made.length - 1];
}

beforeEach(() => {
  fake.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("tkt-1");
});

describe("dashboardRpc", () => {
  it("sends the method with its params, carrying the confirmation flag", async () => {
    const call = dashboardRpc("reload.mcp", { confirm: true });
    const socket = await latest();
    socket.open();
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { status: "ok", servers: 1 } });

    expect(await call).toEqual({ status: "ok", servers: 1 });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ method: "reload.mcp", params: { confirm: true } });
    // Without `confirm` the dashboard answers `confirm_required` and does
    // nothing at all — a silent no-op dressed as a success.
    expect((socket.sent[0].params as Record<string, unknown>).confirm).toBe(true);
    expect(socket.url).toContain("ticket=tkt-1");
    // The socket is for this one call and nothing else.
    expect(socket.closed).toBe(true);
  });

  it("waits for the reply that carries ITS id, not the first frame that arrives", async () => {
    const call = dashboardRpc("reload.mcp", { confirm: true });
    const socket = await latest();
    socket.open();
    // The dashboard opens with `gateway.ready` and keeps emitting housekeeping
    // events throughout, so a reply is found by id and never by position.
    socket.deliver({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready" } });
    socket.deliver({ jsonrpc: "2.0", id: 99, result: { not: "ours" } });
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { status: "ok" } });

    expect(await call).toEqual({ status: "ok" });
  });

  it("returns null when no ticket can be minted — the edition may have no dashboard", async () => {
    ticketMock.mockResolvedValue(null);
    expect(await dashboardRpc("reload.mcp", { confirm: true })).toBeNull();
    expect(fake.made).toHaveLength(0);
  });

  it("returns null, rather than throwing, when minting the ticket fails outright", async () => {
    ticketMock.mockRejectedValue(new Error("dashboard is down"));
    await expect(dashboardRpc("reload.mcp", { confirm: true })).resolves.toBeNull();
  });

  it("returns null when the socket errors", async () => {
    const call = dashboardRpc("reload.mcp", { confirm: true });
    const socket = await latest();
    socket.emit("error", new Error("ECONNREFUSED"));
    expect(await call).toBeNull();
  });

  it("returns null when the socket closes before the reply", async () => {
    const call = dashboardRpc("reload.mcp", { confirm: true });
    const socket = await latest();
    socket.open();
    socket.emit("close", 1006);
    expect(await call).toBeNull();
  });

  it("returns null when the dashboard accepts the socket and then says nothing", async () => {
    // The failure the deadline exists for: not a slow reload, but a half-dead
    // process that takes the connection and never answers.
    const call = dashboardRpc("reload.mcp", { confirm: true }, { timeoutMs: 20 });
    const socket = await latest();
    socket.open();
    expect(await call).toBeNull();
    expect(socket.closed).toBe(true);
  });

  it("returns null when the dashboard answers with an error frame", async () => {
    const call = dashboardRpc("reload.mcp", { confirm: true });
    const socket = await latest();
    socket.open();
    socket.deliver({ jsonrpc: "2.0", id: 1, error: { message: "unknown method" } });
    expect(await call).toBeNull();
  });
});
