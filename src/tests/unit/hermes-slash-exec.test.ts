import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Running ONE Hermes slash command.
 *
 * Why this exists at all: `prompt.submit` hands the text to the MODEL, so a box
 * asked `/status` down the ordinary turn path answers with the model's opinion
 * of the word — the composer would offer the harness's own commands and none of
 * them would do anything. `slash.exec` is Hermes' door for a command, and it is
 * session-scoped: the gateway's `_sess_nowait` answers `4001 session not found`
 * for an id it is not holding in memory, so the session has to be established
 * on the same socket first.
 *
 * What is pinned here is that sequence, the routing instruction Hermes itself
 * gives for a skill command, and the rule that a command which RAN and was
 * refused comes back as output rather than as nothing.
 */

const ticketMock = vi.hoisted(() => vi.fn());

const fake = vi.hoisted(() => {
  const made: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readonly OPEN = 1;
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

import { runHermesSlashCommand } from "@/lib/hermes-slash-exec";

async function latest(): Promise<FakeSocket> {
  for (let i = 0; i < 50 && fake.made.length === 0; i++) await Promise.resolve();
  return fake.made[fake.made.length - 1];
}

/** Wait until the socket has sent `count` frames. */
async function untilSent(socket: FakeSocket, count: number): Promise<void> {
  for (let i = 0; i < 200 && socket.sent.length < count; i++) await Promise.resolve();
}

beforeEach(() => {
  fake.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("tkt-1");
});

describe("runHermesSlashCommand", () => {
  it("resumes the stored session, then runs the command through slash.exec", async () => {
    const call = runHermesSlashCommand({ command: "/status", sessionId: "20260917_101112_a1b2c3" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    expect(socket.sent[0]).toMatchObject({
      method: "session.resume",
      // `omit_messages` selects Hermes' tip-only load path; without it a long
      // conversation is serialised over this socket for a payload nothing
      // reads, and on a loaded box that can outlast the deadline.
      params: { session_id: "20260917_101112_a1b2c3", omit_messages: true, source: "clawbox-chat" },
    });
    // The REAL wire shape: a runtime handle AND the stored key, which differ.
    socket.deliver({
      jsonrpc: "2.0",
      id: 1,
      result: { session_id: "a3f9c1e2", stored_session_id: "20260917_101112_a1b2c3" },
    });
    await untilSent(socket, 2);
    // The RUNTIME handle goes on the session-scoped RPC…
    expect(socket.sent[1]).toMatchObject({
      method: "slash.exec",
      params: { session_id: "a3f9c1e2", command: "/status" },
    });
    socket.deliver({ jsonrpc: "2.0", id: 2, result: { output: "Session · gemma · 1.2k tokens" } });

    // …and the STORED key comes back as the conversation's id. Handing the
    // runtime handle back instead made the chat route's own SESSION_ID_RE
    // reject it, so every message after a slash command answered HTTP 400.
    expect(await call).toEqual({
      output: "Session · gemma · 1.2k tokens",
      sessionId: "20260917_101112_a1b2c3",
    });
    expect(socket.closed).toBe(true);
  });

  it("creates a session when there is none to resume, carrying the pairing", async () => {
    const call = runHermesSlashCommand({ command: "/status", model: "gemma", provider: "clawlocal" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    expect(socket.sent[0]).toMatchObject({
      method: "session.create",
      // `source` so Hermes files the session as this surface's rather than as
      // `tui`/`desktop`.
      params: { model: "gemma", provider: "clawlocal", source: "clawbox-chat" },
    });
    socket.deliver({
      jsonrpc: "2.0",
      id: 1,
      result: { session_id: "b7d2", stored_session_id: "20260917_120000_ffee11" },
    });
    await untilSent(socket, 2);
    expect((socket.sent[1].params as Record<string, unknown>).session_id).toBe("b7d2");
    socket.deliver({ jsonrpc: "2.0", id: 2, result: { output: "ok" } });
    expect(await call).toEqual({ output: "ok", sessionId: "20260917_120000_ffee11" });
  });

  it("follows Hermes' own instruction to re-route a skill command to command.dispatch", async () => {
    const call = runHermesSlashCommand({ command: "/diagram thing", sessionId: "20260917_090000_aabbcc" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
    await untilSent(socket, 2);
    // The gateway's literal refusal for a profile skill command.
    socket.deliver({
      jsonrpc: "2.0",
      id: 2,
      error: { code: 4018, message: "skill command: use command.dispatch for /diagram" },
    });
    await untilSent(socket, 3);
    expect(socket.sent[2]).toMatchObject({
      method: "command.dispatch",
      params: { session_id: "rt1", name: "diagram", arg: "thing" },
    });
    socket.deliver({ jsonrpc: "2.0", id: 3, result: { output: "drawn" } });
    expect(await call).toEqual({ output: "drawn", sessionId: "20260917_090000_aabbcc" });
  });

  it("hands back a refusal as OUTPUT — a command that ran and failed is an answer", async () => {
    const call = runHermesSlashCommand({ command: "/frobnicate", sessionId: "20260917_090000_aabbcc" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
    await untilSent(socket, 2);
    socket.deliver({ jsonrpc: "2.0", id: 2, error: { code: 4018, message: "unknown command: /frobnicate" } });
    // Returned, not thrown: the owner has to be able to read what the harness
    // said, and a red banner over a working box would hide it.
    expect(await call).toEqual({ output: "unknown command: /frobnicate", sessionId: "20260917_090000_aabbcc" });
  });

  it("reads a command.dispatch result that carries no `output` at all", async () => {
    // The defect this pins: `command.dispatch`'s stages answer several shapes
    // and only some carry `output` — `{type:"send",message,notice}` is what
    // every pending-input built-in comes back as, and `slash.exec` forwards
    // `/undo`, `/queue`, `/steer`, `/plan`, `/goal` and `/compress` to it.
    // Reading `output` alone made all of those look like "the dashboard could
    // not be reached", and the caller's fall-through then RAN THE COMMAND A
    // SECOND TIME, as a prompt, at the model.
    const call = runHermesSlashCommand({ command: "/undo 2", sessionId: "20260917_090000_aabbcc" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
    await untilSent(socket, 2);
    socket.deliver({
      jsonrpc: "2.0",
      id: 2,
      result: { type: "send", message: "Backed up 2 turns.", notice: "" },
    });
    expect(await call).toEqual({ output: "Backed up 2 turns.", sessionId: "20260917_090000_aabbcc" });
  });

  it("never answers null once the gateway has run the command, whatever it said", async () => {
    // A clean frame means it RAN. Null past that point is not a fall-back, it
    // is the command executed twice. `(no output)` is Hermes' own literal for
    // a command that printed nothing, echoed rather than invented.
    const call = runHermesSlashCommand({ command: "/redraw", sessionId: "20260917_090000_aabbcc" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
    await untilSent(socket, 2);
    socket.deliver({ jsonrpc: "2.0", id: 2, result: { type: "alias", target: "" } });
    expect(await call).toEqual({ output: "(no output)", sessionId: "20260917_090000_aabbcc" });
  });

  it("threads the STORED key, never the runtime handle — the route rejects the latter", async () => {
    // The critical one. `session.create`/`session.resume` answer with both: a
    // runtime handle (`uuid4().hex[:8]`) that only this socket's RPCs take, and
    // the dated key a client threads. Returning the handle made the chat
    // route's SESSION_ID_RE answer HTTP 400 on every message AFTER a slash
    // command, until the tab was reset or the page reloaded.
    const call = runHermesSlashCommand({ command: "/status", sessionId: "20260917_101112_a1b2c3" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({
      jsonrpc: "2.0",
      id: 1,
      result: { session_id: "deadbeef", stored_session_id: "20260917_101112_a1b2c3" },
    });
    await untilSent(socket, 2);
    socket.deliver({ jsonrpc: "2.0", id: 2, result: { output: "ok" } });
    const answer = await call;
    expect(answer?.sessionId).toBe("20260917_101112_a1b2c3");
    expect(answer?.sessionId).not.toBe("deadbeef");
    // …and it is the dated shape the route validates.
    expect(answer?.sessionId).toMatch(/^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/);
  });

  it("splits the dispatch argument ONCE, as Hermes does, keeping it byte for byte", async () => {
    const call = runHermesSlashCommand({ command: "/goal draft  two  spaces", sessionId: "20260917_090000_aabbcc" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
    await untilSent(socket, 2);
    socket.deliver({
      jsonrpc: "2.0",
      id: 2,
      error: { code: 4018, message: "skill command: use command.dispatch for /goal" },
    });
    await untilSent(socket, 3);
    expect(socket.sent[2]).toMatchObject({
      method: "command.dispatch",
      params: { name: "goal", arg: "draft  two  spaces" },
    });
    socket.deliver({ jsonrpc: "2.0", id: 3, result: { output: "noted" } });
    await call;
  });

  it("reports a command that outlived the deadline as STILL RUNNING, never as no transport", async () => {
    // Reporting no transport sends the caller down its fall-through, which for
    // the chat route means submitting the same command to the MODEL while the
    // real one is still working on the box.
    vi.useFakeTimers();
    try {
      const call = runHermesSlashCommand({ command: "/compress", sessionId: "20260917_090000_aabbcc" });
      const socket = await latest();
      socket.open();
      await untilSent(socket, 1);
      socket.deliver({ jsonrpc: "2.0", id: 1, result: { session_id: "rt1", stored_session_id: "20260917_090000_aabbcc" } });
      await untilSent(socket, 2);
      // …and the box never answers.
      await vi.advanceTimersByTimeAsync(130_000);
      const answer = await call;
      expect(answer).not.toBeNull();
      expect(answer?.sessionId).toBe("20260917_090000_aabbcc");
      expect(answer?.output).toMatch(/still running/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers null when there is no dashboard to reach, so the caller can fall back", async () => {
    ticketMock.mockResolvedValue(null);
    expect(await runHermesSlashCommand({ command: "/status" })).toBeNull();
    expect(fake.made).toHaveLength(0);
  });

  it("answers null when the session could not be established", async () => {
    const call = runHermesSlashCommand({ command: "/status", sessionId: "gone" });
    const socket = await latest();
    socket.open();
    await untilSent(socket, 1);
    socket.deliver({ jsonrpc: "2.0", id: 1, error: { code: 4001, message: "session not found" } });
    expect(await call).toBeNull();
    // Nothing was run against a session that does not exist.
    expect(socket.sent.filter((f) => f.method === "slash.exec")).toHaveLength(0);
  });

  it("refuses anything that is not a command before opening a socket", async () => {
    expect(await runHermesSlashCommand({ command: "hello" })).toBeNull();
    expect(await runHermesSlashCommand({ command: "/" })).toBeNull();
    expect(fake.made).toHaveLength(0);
  });
});
