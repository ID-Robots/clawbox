import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Driving a Hermes turn through the running dashboard instead of a new process.
 *
 * The measurement this exists for: on the live box a `hermes chat -q` turn
 * spends ~6.0s building an agent before the first request to the model is sent
 * — against ~2.9s of actual model time on a "Hey". The dashboard has already
 * paid that cost, so the same turn submitted to its socket starts immediately
 * and streams back. What has to be true for that to be SAFE is what is pinned
 * here: the right session is threaded, the monologue never leaves on the answer
 * channel, and every ordinary failure happens while the caller can still fall
 * back to spawning the CLI.
 */

const ticketMock = vi.hoisted(() => vi.fn());

/**
 * The fake socket, built inside `vi.hoisted` because `vi.mock` is lifted above
 * every ordinary declaration in this file and would otherwise close over a
 * class that does not exist yet.
 */
const fake = vi.hoisted(() => {
  const made: FakeSocket[] = [];
  /**
   * Just enough of `ws` to be wrong in the ways that matter: listeners
   * registered by name, a `readyState` that starts closed, and an `open` that
   * has to be driven — because the real socket comes up asynchronously and code
   * that assumes otherwise passes here and hangs on the box.
   */
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
      const list = (this.listeners.get(event) || []).filter((f) => f !== cb);
      this.listeners.set(event, list);
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
    /** Deliver one agent event, in the dashboard's own envelope. */
    event(type: string, payload: unknown) {
      this.deliver({ jsonrpc: "2.0", method: "event", params: { type, payload } });
    }
    /** Every RPC this socket was asked to make, by method name. */
    method(name: string) {
      return this.sent.find((f) => f.method === name);
    }
  }
  return { made, FakeSocket };
});

type FakeSocket = InstanceType<typeof fake.FakeSocket>;
const socketsMock = fake;

vi.mock("ws", () => ({ WebSocket: fake.FakeSocket }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardWsTicket: ticketMock,
  DASHBOARD_WS_ORIGIN: "ws://127.0.0.2:9119",
}));

import { openDashboardTurn, hermesCanStreamTurns, resetHermesStreamProbe } from "@/lib/hermes-dashboard-turn";

/** The socket the module just made, after letting the constructor run. */
async function latest(): Promise<FakeSocket> {
  for (let i = 0; i < 50 && socketsMock.made.length === 0; i++) await Promise.resolve();
  return socketsMock.made[socketsMock.made.length - 1];
}

/** Open a turn, answering the handshake and the session RPC as the box would. */
async function connect(overrides: Record<string, unknown> = {}, storedId = "20260823_190319_3e9e35") {
  const opening = openDashboardTurn({ text: "Hey", model: "deepseek-v4-flash", provider: "clawai", ...overrides });
  const socket = await latest();
  socket.open();
  // The server greets before anything is asked of it; the session reply is
  // found by its id, not by being next.
  await Promise.resolve();
  socket.event("gateway.ready", {});
  await Promise.resolve();
  socket.deliver({
    jsonrpc: "2.0",
    id: 1,
    result: { session_id: "e0719549", stored_session_id: storedId },
  });
  return { turn: await opening, socket };
}

beforeEach(() => {
  socketsMock.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("a-ticket");
  resetHermesStreamProbe();
});
afterEach(() => {
  resetHermesStreamProbe();
});

describe("opening a dashboard turn", () => {
  it("carries the single-use ticket on the upgrade, never a stored secret", async () => {
    const { turn, socket } = await connect();
    expect(turn).not.toBeNull();
    expect(socket.url).toBe("ws://127.0.0.2:9119/api/ws?ticket=a-ticket");
  });

  it("starts a new conversation with the turn's own model and provider", async () => {
    const { turn, socket } = await connect();
    const created = socket.method("session.create");
    expect(created).toBeDefined();
    expect(created?.params).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
    // The durable id, not the transport handle — this is what threads the next
    // turn and what the agent's own record is keyed by.
    expect(turn?.sessionId).toBe("20260823_190319_3e9e35");
  });

  it("resumes by the id the previous turn reported, and asks for no transcript", async () => {
    // The conversation is threaded by the STORED id, the same value
    // `chat -q --resume` takes, so switching transports mid-chat is invisible.
    // The history is ours to serve from our own store; replaying it over this
    // socket would be a large payload nothing reads.
    const { turn, socket } = await connect({ sessionId: "20260823_185842_1eabd5" }, "20260823_185842_1eabd5");
    const resumed = socket.method("session.resume");
    expect(resumed?.params).toMatchObject({ session_id: "20260823_185842_1eabd5", omit_messages: true });
    expect(socket.method("session.create")).toBeUndefined();
    expect(turn?.sessionId).toBe("20260823_185842_1eabd5");
  });

  it("answers null rather than throwing when the box cannot stream", async () => {
    // "Not right now" is an expected answer, not a fault: the caller still has
    // a perfectly good CLI to spawn, and it can only take that path if this one
    // fails quietly and BEFORE any response has been committed.
    ticketMock.mockResolvedValue(null);
    await expect(openDashboardTurn({ text: "Hey" })).resolves.toBeNull();
    expect(socketsMock.made).toHaveLength(0);
  });

  it("answers null when the dashboard refuses the session", async () => {
    const opening = openDashboardTurn({ text: "Hey", sessionId: "20260823_000000_aaaaaa" });
    const socket = await latest();
    socket.open();
    await Promise.resolve();
    socket.deliver({ jsonrpc: "2.0", id: 1, error: { message: "session not found" } });
    await expect(opening).resolves.toBeNull();
    expect(socket.closed).toBe(true);
  });

  it("answers null when the socket dies during the handshake", async () => {
    const opening = openDashboardTurn({ text: "Hey" });
    const socket = await latest();
    socket.emit("error", new Error("ECONNREFUSED"));
    await expect(opening).resolves.toBeNull();
  });
});

describe("running a dashboard turn", () => {
  it("reports each fragment of the ANSWER as it lands", async () => {
    const { turn, socket } = await connect();
    const seen: string[] = [];
    const running = turn!.run((chunk) => seen.push(chunk));
    await Promise.resolve();
    socket.event("message.start", null);
    socket.event("message.delta", { text: "Hey! " });
    socket.event("message.delta", { text: "What can I help with?" });
    socket.event("message.complete", { text: "Hey! What can I help with?", status: "complete" });
    const final = await running;
    expect(seen).toEqual(["Hey! ", "What can I help with?"]);
    expect(final.text).toBe("Hey! What can I help with?");
    expect(final.status).toBe("complete");
  });

  it("submits the prompt against the TRANSPORT handle, not the stored id", async () => {
    // Two ids, and they are not interchangeable: `prompt.submit` addresses the
    // live in-memory session, while the stored id is what the database and the
    // next turn's resume are keyed by. Crossing them fails in the confusing way
    // — the RPC is refused and the turn never starts.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    expect(socket.method("prompt.submit")?.params).toMatchObject({ session_id: "e0719549", text: "Hey" });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("keeps the monologue off the answer channel entirely", async () => {
    // THE point of this transport for the bubble: thinking arrives on its own
    // event, so nothing has to parse it back out of the reply afterwards and
    // there is no window in which the raw monologue can flash into the bubble.
    const { turn, socket } = await connect();
    const seen: string[] = [];
    const running = turn!.run((chunk) => seen.push(chunk));
    await Promise.resolve();
    socket.event("thinking.delta", { text: "hmm, " });
    socket.event("reasoning.delta", { text: "the user said Hey, " });
    socket.event("reasoning.delta", { text: "so I should greet them back." });
    socket.event("message.delta", { text: "Hey!" });
    socket.event("message.complete", { text: "Hey!", status: "complete", reasoning: "the user said Hey" });
    const final = await running;
    expect(seen).toEqual(["Hey!"]);
    expect(seen.join("")).not.toContain("the user said Hey");
    expect(final.text).toBe("Hey!");
    expect(final.reasoning).toBe("the user said Hey");
  });

  it("answers an approval instead of leaving the agent parked on it", async () => {
    // THE bug this transport can have that spawning never could. The agent
    // thread blocks on an Event waiting for a person; a client that treats
    // `approval.request` as one more event to ignore hangs the turn forever.
    // Caught live: a turn logged its first model call and then nothing at all,
    // for minutes, with no turn-finished line anywhere.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("approval.request", { request_id: "req-7", command: "uname -r", choices: ["once", "deny"] });
    await Promise.resolve();
    const answer = socket.method("approval.respond");
    expect(answer).toBeDefined();
    expect(answer?.params).toMatchObject({ session_id: "e0719549", request_id: "req-7" });
    // The turn then runs on and settles, which is the point.
    socket.event("message.complete", { text: "5.15.185-tegra", status: "complete" });
    expect((await running).text).toBe("5.15.185-tegra");
  });

  it("grants only the call it was asked about", async () => {
    // Not "always", not "session". This route already lets tools run — that is
    // what `chat -q` does today — but nothing it answers may widen what a LATER
    // turn, or the owner's own dashboard session, is allowed to do.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("approval.request", { request_id: "req-8" });
    await Promise.resolve();
    const choice = (socket.method("approval.respond")?.params as Record<string, unknown>).choice;
    expect(choice).toBe("once");
    expect(choice).not.toBe("always");
    expect(choice).not.toBe("session");
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("still answers an approval that arrives without a request id", async () => {
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("approval.request", { command: "ls" });
    await Promise.resolve();
    const answer = socket.method("approval.respond");
    expect(answer).toBeDefined();
    expect(answer?.params).not.toHaveProperty("request_id");
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("falls back to what it accumulated when the final frame carries no text", async () => {
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.delta", { text: "partial answer" });
    socket.event("message.complete", { status: "complete" });
    expect((await running).text).toBe("partial answer");
  });

  it("surfaces a failed turn as a failure, not as an answer", async () => {
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.complete", { text: "", status: "error", error: "the provider is rate limiting" });
    const final = await running;
    expect(final.status).toBe("error");
    expect(final.error).toBe("the provider is rate limiting");
  });

  it("rejects when the socket drops mid-turn instead of resolving short", async () => {
    // Half an answer resolved as though it were whole is the one outcome a
    // customer cannot tell from a real reply.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.delta", { text: "half a sen" });
    socket.emit("close", 1006);
    await expect(running).rejects.toThrow(/closed/);
  });

  it("reports an abort AS an abort, not as a dropped socket", async () => {
    const controller = new AbortController();
    const { turn, socket } = await connect({ signal: controller.signal });
    const running = turn!.run(() => {});
    await Promise.resolve();
    controller.abort();
    socket.emit("close", 1000);
    // `rejects.toThrow()` alone passes for any error, which is exactly what
    // hid this: an abort and a dropped socket were indistinguishable to the
    // caller, and the chat route branches on the difference. A Stop that
    // arrives as `dashboard socket closed (1000)` is written into the
    // customer's transcript as a failed turn.
    const err = await running.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(socket.closed).toBe(true);
  });

  it("closes the socket once the turn has settled", async () => {
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await Promise.resolve();
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
    expect(socket.closed).toBe(true);
  });
});

describe("asking whether this box can stream", () => {
  it("proves it by minting a real ticket, and fails closed", async () => {
    // Nothing weaker tests all three preconditions at once: the dashboard is
    // up, the stored password still opens it, and the socket endpoints are on.
    expect(await hermesCanStreamTurns()).toBe(true);
    resetHermesStreamProbe();
    ticketMock.mockResolvedValue(null);
    expect(await hermesCanStreamTurns()).toBe(false);
    resetHermesStreamProbe();
    ticketMock.mockRejectedValue(new Error("dashboard is down"));
    expect(await hermesCanStreamTurns()).toBe(false);
  });

  it("does not re-ask on every request", async () => {
    // The composer asks per chat open; minting a ticket per ask would be a
    // login round trip on a socket that is about to be asked for another one.
    await hermesCanStreamTurns();
    await hermesCanStreamTurns();
    await hermesCanStreamTurns();
    expect(ticketMock).toHaveBeenCalledTimes(1);
  });
});
