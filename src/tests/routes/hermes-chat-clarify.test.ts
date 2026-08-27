import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route that carries the customer's answer back to a parked agent.
 *
 * What is being pinned is mostly the SHAPE of the call, because the shape is
 * the whole design. `clarify.respond` takes `{ request_id, answer,
 * question_id? }` and no session id — upstream resolves the session from a
 * global pending registry keyed by the request id — so this route opens a
 * short-lived socket of its own instead of trying to speak back up the SSE
 * stream. That is what lets a question be answered after the streaming request
 * has died, which is exactly the case that used to leave the agent parked for
 * the rest of its hour-long timeout.
 *
 * The rest is the boring half that matters when a box misbehaves: a body that
 * is nonsense is refused with something a person can read, a dashboard that is
 * down is a 503 rather than a hang, and every path closes its socket.
 */

const ticketMock = vi.hoisted(() => vi.fn());

const fake = vi.hoisted(() => {
  const made: FakeSocket[] = [];
  /** Just enough of `ws` to be wrong in the ways that matter — see the sibling suite. */
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

import { POST } from "@/app/setup-api/hermes/chat/clarify/route";

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/hermes/chat/clarify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * The socket the route made AFTER `seen` of them already existed.
 *
 * Counted from a baseline rather than "the newest one", because a test that
 * answers twice would otherwise be handed the first call's socket again and
 * drive that one instead — passing while the second request sat unopened until
 * the test timed out. Found exactly that way.
 */
async function nextSocket(seen: number): Promise<FakeSocket> {
  for (let i = 0; i < 50 && socketsMock.made.length <= seen; i++) await Promise.resolve();
  // The socket AT the baseline, not the newest one — those differ the moment a
  // test answers twice, and returning the newest is the very swap this helper
  // exists to prevent. Throwing when it never arrives keeps a route that failed
  // to connect from surfacing as a confusing assertion on a stale socket.
  const socket = socketsMock.made[seen];
  if (!socket) throw new Error(`the route opened no socket after baseline ${seen}`);
  return socket;
}

/**
 * Answer a clarify end to end, playing the dashboard's side.
 *
 * `reply` is delivered against whatever id the route actually used, so a test
 * cannot accidentally pass by hard-coding the one the route happens to pick.
 */
async function answer(body: unknown, reply: Record<string, unknown> | null) {
  const before = socketsMock.made.length;
  const pending = POST(post(body));
  const socket = await nextSocket(before);
  socket.open();
  for (let i = 0; i < 50 && !socket.method("clarify.respond"); i++) await Promise.resolve();
  const sent = socket.method("clarify.respond");
  if (reply) socket.deliver({ jsonrpc: "2.0", id: sent?.id, ...reply });
  const res = await pending;
  return { res, socket, sent, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  socketsMock.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("a-ticket");
});

describe("answering a pending clarify", () => {
  it("addresses the answer by request id alone, on a socket of its own", async () => {
    // No session id anywhere in the params, and that is the point rather than
    // an oversight: it is what makes the answer independent of the request that
    // asked the question, and therefore deliverable after that request is gone.
    const { res, sent, body } = await answer(
      { requestId: "9f2a1c04", answer: "config.yaml" },
      { result: { status: "ok" } },
    );
    expect(res.status).toBe(200);
    expect(sent?.params).toEqual({ request_id: "9f2a1c04", answer: "config.yaml" });
    expect(sent?.params).not.toHaveProperty("session_id");
    expect(body).toEqual({ status: "ok" });
  });

  it("carries the single-use ticket on the upgrade, never a stored secret", async () => {
    const { socket } = await answer({ requestId: "9f2a1c04", answer: "a" }, { result: { status: "ok" } });
    expect(socket.url).toBe("ws://127.0.0.2:9119/api/ws?ticket=a-ticket");
  });

  it("names the question when one of a batch is being answered", async () => {
    // Mandatory for a batch. An answer with NO question_id against one is
    // upstream's cancel-all, so this must never be defaulted to an empty string.
    const { sent, body } = await answer(
      { requestId: "77dd88ee", answer: "beta", questionId: "q1" },
      { result: { status: "ok", remaining: ["q2", "q3"] } },
    );
    expect(sent?.params).toEqual({ request_id: "77dd88ee", answer: "beta", question_id: "q1" });
    // What is still outstanding comes from the GATEWAY, because only it knows:
    // the answers accumulate in its registry across every client that has
    // answered anything, including ones this browser never saw.
    expect(body).toEqual({ status: "ok", remaining: ["q2", "q3"] });
  });

  it("passes an empty answer through as the locked skip it is", async () => {
    // Upstream counts an empty answer as a deliberate SKIP that releases the
    // batch — so refusing it here as "you forgot to type something" would take
    // away the only way a customer has to say "not this one".
    const { res, sent } = await answer(
      { requestId: "77dd88ee", answer: "", questionId: "q2" },
      { result: { status: "ok" } },
    );
    expect(res.status).toBe(200);
    expect(sent?.params).toMatchObject({ answer: "", question_id: "q2" });
  });

  it("reports a late answer as expired rather than as a failure", async () => {
    // `_respond` runs with `allow_expired=True` precisely so this is an answer
    // and not an error. The customer was a few seconds slow; they deserve to be
    // told the question timed out, not shown a failure.
    const { res, body } = await answer(
      { requestId: "expired1", answer: "a.ts" },
      { result: { status: "expired" } },
    );
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "expired" });
  });

  it("closes its socket whichever way the call went", async () => {
    // A leaked connection here is a leaked authenticated session on a box whose
    // whole model is that the ticket is single-use and short-lived.
    const ok = await answer({ requestId: "9f2a1c04", answer: "a" }, { result: { status: "ok" } });
    expect(ok.socket.closed).toBe(true);
    const refused = await answer({ requestId: "9f2a1c04", answer: "a" }, { error: { message: "no such request" } });
    expect(refused.socket.closed).toBe(true);
  });
});

describe("refusing a body that cannot be an answer", () => {
  it("rejects a request id that is missing or the wrong shape", async () => {
    for (const body of [{ answer: "a" }, { requestId: "", answer: "a" }, { requestId: 7, answer: "a" }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    // Bounded charset AND bounded length, so a hostile body cannot arrive as a
    // megabyte of text that then gets logged, echoed or put on a URL.
    const long = await POST(post({ requestId: "a".repeat(65), answer: "a" }));
    expect(long.status).toBe(400);
    const punctuated = await POST(post({ requestId: "9f2a1c04; drop", answer: "a" }));
    expect(punctuated.status).toBe(400);
    expect(socketsMock.made).toHaveLength(0);
  });

  it("rejects an answer that is not text, or is far too much of it", async () => {
    const notText = await POST(post({ requestId: "9f2a1c04", answer: { pick: "a" } }));
    expect(notText.status).toBe(400);
    const huge = await POST(post({ requestId: "9f2a1c04", answer: "x".repeat(4001) }));
    expect(huge.status).toBe(400);
    expect(((await huge.json()) as { error: string }).error).toContain("too long");
    expect(socketsMock.made).toHaveLength(0);
  });

  it("rejects a question id that is not one", async () => {
    const res = await POST(post({ requestId: "9f2a1c04", answer: "a", questionId: "q 1; rm -rf" }));
    expect(res.status).toBe(400);
    expect(socketsMock.made).toHaveLength(0);
  });

  it("rejects a body that is not JSON at all", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(socketsMock.made).toHaveLength(0);
  });
});

describe("when the box cannot take the answer", () => {
  it("answers 503 when the dashboard will not mint a ticket", async () => {
    // No ticket means the dashboard is down, or the stored password no longer
    // opens it. Either way it is "come back later", not "your answer was
    // wrong" — and the client should keep the form on screen rather than
    // throwing away what the customer typed.
    ticketMock.mockResolvedValue(null);
    const res = await POST(post({ requestId: "9f2a1c04", answer: "a" }));
    expect(res.status).toBe(503);
    expect(socketsMock.made).toHaveLength(0);
  });

  it("answers 503 when the socket dies before the answer lands", async () => {
    const pending = POST(post({ requestId: "9f2a1c04", answer: "a" }));
    const socket = await nextSocket(0);
    socket.emit("error", new Error("ECONNREFUSED"));
    const res = await pending;
    expect(res.status).toBe(503);
  });

  it("answers 502 when the gateway refuses the answer, and says why", async () => {
    // A refusal is the dashboard working and disagreeing — a `question_id` that
    // is not one of the emitted qids comes back as error 4002 — which is a
    // different thing from the dashboard being unreachable, and is worth
    // telling the client apart from it.
    const { res, body } = await answer(
      { requestId: "77dd88ee", answer: "beta", questionId: "nope" },
      { error: { message: "unknown question_id" } },
    );
    expect(res.status).toBe(502);
    expect(body.error).toBe("unknown question_id");
  });
});
