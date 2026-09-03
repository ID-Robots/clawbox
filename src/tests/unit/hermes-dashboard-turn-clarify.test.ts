import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The turn stopping to ask the CUSTOMER something, and being able to wait for it.
 *
 * `clarify.request` had no case in this reader at all: the frame fell to
 * `default`, was counted as one more unknown event and dropped. Meanwhile the
 * agent's worker thread was parked on it — `_clarify_block` → `_block` →
 * `Event.wait(agent.clarify_timeout)`, which defaults to 3600 seconds and
 * treats `<= 0` as forever. So the two ends disagreed by twenty times over: the
 * agent waited an hour for an answer to a question nobody had been shown, and
 * this reader gave up after its 180-second idle window and wrote "dashboard
 * stream went quiet" into the customer's transcript.
 *
 * What is pinned here is the whole of the fix: the question REACHES a person,
 * both wire shapes arrive as one thing a surface can render, the idle watchdog
 * steps aside for a human-shaped wait and comes back afterwards, and a question
 * that was already waiting when we reconnected is shown exactly once.
 */

const ticketMock = vi.hoisted(() => vi.fn());

/**
 * The same fake socket the sibling suite drives, built inside `vi.hoisted`
 * because `vi.mock` is lifted above every ordinary declaration in this file and
 * would otherwise close over a class that does not exist yet.
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

import {
  DashboardStreamQuietError,
  openDashboardTurn,
  resetHermesStreamProbe,
  type DashboardActivity,
} from "@/lib/hermes-dashboard-turn";

/** The socket the module just made, after letting the constructor run. */
async function latest(): Promise<FakeSocket> {
  for (let i = 0; i < 50 && socketsMock.made.length === 0; i++) await Promise.resolve();
  return socketsMock.made[socketsMock.made.length - 1];
}

/** Let the reader's own awaits run without moving any clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Open a turn, answering the handshake and the session RPC as the box would.
 *
 * `extraResult` is folded into the session reply, which is how a pending
 * clarify actually reaches a client: it is NOT an event, it is a member of the
 * `session.resume` / `session.info` RESULT.
 */
async function connect(extraResult: Record<string, unknown> = {}) {
  const opening = openDashboardTurn({ text: "Hey", model: "deepseek-v4-flash", provider: "clawai" });
  const socket = await latest();
  socket.open();
  await Promise.resolve();
  socket.event("gateway.ready", {});
  await Promise.resolve();
  socket.deliver({
    jsonrpc: "2.0",
    id: 1,
    result: {
      session_id: "e0719549",
      stored_session_id: "20260823_190319_3e9e35",
      info: { model: "deepseek-v4-flash", provider: "custom" },
      ...extraResult,
    },
  });
  return { turn: await opening, socket };
}

/** Only the clarify prompts, narrowed so a test can read `questions` off them. */
function clarifiesOnly(seen: readonly DashboardActivity[]) {
  return seen.filter((a): a is Extract<DashboardActivity, { kind: "clarify" }> => a.kind === "clarify");
}

beforeEach(() => {
  socketsMock.made.length = 0;
  ticketMock.mockReset();
  ticketMock.mockResolvedValue("a-ticket");
  resetHermesStreamProbe();
});
afterEach(() => {
  // The watchdog tests below drive the idle clock with fake timers; a suite
  // that left them installed would hand the next file a frozen Date.
  vi.useRealTimers();
  resetHermesStreamProbe();
});

describe("carrying the agent's question out to a person", () => {
  it("reports a single clarify as one question, with no qid", async () => {
    // The single shape carries the question at the TOP of the payload and no
    // `questions` array at all. The empty qid is not a gap — it is the value
    // that says "answer this with no `question_id`", which is the only form
    // `clarify.respond` accepts for a non-batch prompt.
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    socket.event("clarify.request", {
      question: "Which config file did you mean?",
      choices: ["config.yaml", "openclaw.json"],
      request_id: "9f2a1c04",
    });
    await settle();
    const clarifies = clarifiesOnly(seen);
    expect(clarifies).toHaveLength(1);
    expect(clarifies[0].requestId).toBe("9f2a1c04");
    expect(clarifies[0].questions).toEqual([
      {
        qid: "",
        question: "Which config file did you mean?",
        choices: ["config.yaml", "openclaw.json"],
        multiSelect: false,
      },
    ]);
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("carries multi-select through, and only when the wire says so", async () => {
    // `multi_select` is emitted ONLY when true (server.py :3628), so its
    // absence above is a real answer rather than a missing field to guess at.
    // Getting this wrong renders radio buttons over a question that wanted
    // several answers, and the customer cannot say what they meant.
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    socket.event("clarify.request", {
      question: "Which of these should I install?",
      choices: ["Alpha", "Beta", "Gamma"],
      multi_select: true,
      request_id: "aa11bb22",
    });
    await settle();
    const [clarify] = clarifiesOnly(seen);
    expect(clarify.questions).toHaveLength(1);
    expect(clarify.questions[0].multiSelect).toBe(true);
    expect(clarify.questions[0].choices).toEqual(["Alpha", "Beta", "Gamma"]);
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("flattens a batch into ONE prompt, keeping each question's own id and mode", async () => {
    // One request_id covering N questions, because the agent is parked on a
    // single Event and unblocks only once EVERY qid has an answer. Reporting
    // this as N separate prompts would let a surface answer one and think it
    // was finished, leaving the agent parked exactly as before.
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    socket.event("clarify.request", {
      questions: [
        { qid: "q1", question: "Which branch?", choices: ["beta", "main"], multi_select: false },
        { qid: "q2", question: "Which tests?", choices: ["unit", "routes", "e2e"], multi_select: true },
        // No `choices` at all — a free-text question, which the wire sends by
        // omitting the field rather than by sending an empty array.
        { qid: "q3", question: "Name the branch" },
      ],
      request_id: "77dd88ee",
    });
    await settle();
    const clarifies = clarifiesOnly(seen);
    expect(clarifies).toHaveLength(1);
    expect(clarifies[0].requestId).toBe("77dd88ee");
    expect(clarifies[0].questions).toEqual([
      { qid: "q1", question: "Which branch?", choices: ["beta", "main"], multiSelect: false },
      { qid: "q2", question: "Which tests?", choices: ["unit", "routes", "e2e"], multiSelect: true },
      { qid: "q3", question: "Name the branch", choices: [], multiSelect: false },
    ]);
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("never answers the question itself", async () => {
    // THE difference from `approval.request`, which this reader answers
    // immediately. An approval asks whether a tool this route already permits
    // may run, so "once" grants nothing new. A clarify asks the customer
    // something only they know, and any default this file could pick would be
    // a guess put in their mouth — a confidently wrong turn, which is worse
    // than the wait it would be curing.
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    await settle();
    socket.event("clarify.request", { question: "Delete which one?", choices: ["a", "b"], request_id: "c0ffee11" });
    await settle();
    expect(socket.method("clarify.respond")).toBeUndefined();
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });
});

describe("a clarify that expires", () => {
  it("takes the prompt down and lets the ordinary idle clock resume", async () => {
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    const settled = running.catch((e: unknown) => e);
    await settle();
    socket.event("clarify.request", { question: "Which one?", choices: ["a"], request_id: "ee11ff22" });
    await settle();
    socket.event("clarify.expire", { request_id: "ee11ff22" });
    await settle();
    expect(seen.filter((a) => a.kind === "clarifyExpire")).toEqual([{ kind: "clarifyExpire", requestId: "ee11ff22" }]);
    // And the long window is given back: nobody is being waited on any more,
    // so three minutes of true silence is a dead socket again.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await settled).toBeInstanceOf(DashboardStreamQuietError);
  });

  it("ignores an expiry for a DIFFERENT request, and keeps waiting", async () => {
    // This socket carries frames the turn did not cause. An expiry naming some
    // other request — a stale one, or another session's — must not shorten the
    // window the customer is still typing inside; that would kill the turn out
    // from under a question they were halfway through answering.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    let outcome: unknown = null;
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    running.then(
      (value) => (outcome = value),
      (err) => (outcome = err),
    );
    await settle();
    socket.event("clarify.request", { question: "Which one?", choices: ["a"], request_id: "mine1234" });
    await settle();
    socket.event("clarify.expire", { request_id: "other999" });
    await settle();
    // Forwarded, because a surface may well be showing that other prompt too.
    expect(seen.filter((a) => a.kind === "clarifyExpire")).toEqual([{ kind: "clarifyExpire", requestId: "other999" }]);
    // Far past the ordinary idle window, and still alive.
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    expect(outcome).toBeNull();
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });
});

describe("the idle watchdog while a person is being waited on", () => {
  it("does not kill a turn that is waiting for an answer", async () => {
    // The bug, in one test. 180 seconds of silence is evidence only because a
    // running agent has no reason to produce none — and a parked one has
    // exactly that reason. Hermes itself waits `agent.clarify_timeout` (3600s
    // by default) for this answer; a reader that gives up twenty times sooner
    // reports a working turn as a failure every single time.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    let outcome: unknown = null;
    // An `onActivity` is passed because the long window is only justified when
    // the question actually reaches a surface — see the test below.
    const running = turn!.run(
      () => {},
      () => {},
    );
    running.then(
      (value) => (outcome = value),
      (err) => (outcome = err),
    );
    await settle();
    socket.event("clarify.request", { question: "Which file?", choices: ["a", "b"], request_id: "wd001122" });
    await settle();
    // Ten minutes of complete silence — more than three times the ordinary
    // window — with a person reading the question the whole time.
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    expect(outcome).toBeNull();
    // The answer lands over somebody else's socket, the agent unparks, and the
    // turn settles the way any other turn does.
    socket.event("message.complete", { text: "config.yaml it is.", status: "complete" });
    const final = await running;
    expect(final.text).toBe("config.yaml it is.");
    expect(final.status).toBe("complete");
  });

  it("gives up on the ordinary clock when there is no surface to ask on", async () => {
    // `onActivity` is optional, and a caller that omits it wants nothing but
    // the answer text. Such a caller can never put the question in front of
    // anybody, so arming the hour-long window for it would park the turn for
    // an hour on a prompt nobody will ever see — the same failure this file
    // exists to fix, arrived at from the other direction.
    //
    // Three minutes and an honest error is the right answer instead: the
    // question genuinely cannot be answered on this transport.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    let outcome: unknown = null;
    const running = turn!.run(() => {});
    running.then(
      (value) => (outcome = value),
      (err) => (outcome = err),
    );
    await settle();
    socket.event("clarify.request", { question: "Which file?", choices: ["a", "b"], request_id: "wd003344" });
    await settle();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(outcome).toBeInstanceOf(DashboardStreamQuietError);
  });

  it("does not arm the long window for a REPLAYED prompt with no surface", async () => {
    // The same rule on the replay path, which arms before the turn's first
    // frame and would otherwise hold the request open for an hour on a
    // question that was never rendered.
    vi.useFakeTimers();
    const { turn } = await connect({
      pending_clarify: { question: "Which mailbox?", choices: ["work", "home"], request_id: "wd005566" },
    });
    let outcome: unknown = null;
    const running = turn!.run(() => {});
    running.then(
      (value) => (outcome = value),
      (err) => (outcome = err),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(outcome).toBeInstanceOf(DashboardStreamQuietError);
  });

  it("still calls TRUE silence dead when nothing is pending", async () => {
    // The converse, and the reason the first test is safe. Standing the
    // watchdog down for a clarify must not stand it down generally — a wedged
    // turn with no question outstanding has to be given up on in three minutes
    // as it always was.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    const running = turn!.run(() => {});
    const settled = running.catch((e: unknown) => e);
    await settle();
    socket.event("tool.start", { tool_id: "call_7", name: "terminal", context: "sleep 600" });
    await settle();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await settled).toBeInstanceOf(DashboardStreamQuietError);
  });

  it("narrows the window again as soon as the turn's own frames resume", async () => {
    // The answer is sent over a different socket and is never acknowledged on
    // this one, so the only evidence available here that the wait is over is
    // that the agent started talking again. Without this the rest of the turn
    // would run on the hour-long window, and a turn that wedged AFTER a
    // clarify would hold the customer's response open for an hour.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    // `onActivity` is REQUIRED for this test to mean anything: the long window
    // is armed only when the prompt reached a surface, so without a callback
    // the turn would sit on the ordinary 180s clock the whole way through and
    // this assertion would still pass with the TURN_PROGRESS reset deleted.
    const running = turn!.run(
      () => {},
      () => {},
    );
    const settled = running.catch((e: unknown) => e);
    await settle();
    socket.event("clarify.request", { question: "Which file?", choices: ["a"], request_id: "wd334455" });
    await settle();
    // Proof the long window really is armed first: three minutes of silence
    // while the prompt is outstanding must NOT settle the turn.
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    // Answered elsewhere; the agent picks the turn back up.
    socket.event("message.delta", { text: "Right — " });
    await settle();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await settled).toBeInstanceOf(DashboardStreamQuietError);
  });

  it("suspends nothing on a clarify payload it could not use", async () => {
    // A payload with no question is not a prompt: there is nothing to show and
    // nothing a person could answer. Treating it as one would stand the
    // watchdog down for an hour on the strength of a frame that blocks nobody,
    // which is a hang manufactured out of a malformed frame.
    vi.useFakeTimers();
    const { turn, socket } = await connect();
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    const settled = running.catch((e: unknown) => e);
    await settle();
    socket.event("clarify.request", { request_id: "empty001" });
    socket.event("clarify.request", { question: "no id here", choices: ["a"] });
    socket.event("clarify.request", { questions: [], request_id: "empty002" });
    await settle();
    expect(clarifiesOnly(seen)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await settled).toBeInstanceOf(DashboardStreamQuietError);
  });
});

describe("a question that was already waiting when we reconnected", () => {
  it("replays it from the session reply, before anything this turn does", async () => {
    // NOT an event, and that is the trap. A clarify emitted while nobody was
    // connected is never re-emitted; it comes back folded into the RESULT of
    // `session.resume` (`_pending_clarify_request_payload` :1946). A reader
    // that only listens for `clarify.request` resumes a parked conversation,
    // sees nothing, and waits out its idle window while the answer it needs is
    // in the reply it already has.
    const { turn, socket } = await connect({
      pending_clarify: {
        question: "Which file did you mean?",
        choices: ["a.ts", "b.ts"],
        request_id: "re001122",
      },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    // It reaches the surface as the answer to this turn's message lands on it
    // (TASK-610) — but the payload itself still comes from the session RESULT,
    // and everything the customer must see is carried across from there.
    socket.deliver({ jsonrpc: "2.0", id: socket.method("clarify.respond")?.id, result: { status: "ok" } });
    await settle();
    expect(seen[0]).toEqual({
      kind: "clarify",
      requestId: "re001122",
      questions: [{ qid: "", question: "Which file did you mean?", choices: ["a.ts", "b.ts"], multiSelect: false }],
      answered: { "": "Hey" },
    });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("restores the answers a half-finished batch already has", async () => {
    // An empty string in there is a real answer — hermes counts it as a LOCKED
    // SKIP — so a reader that dropped it would show a returning customer a
    // question they had already dismissed, and the answer they then gave would
    // be refused because that qid is already locked.
    const { turn, socket } = await connect({
      pending_clarify: {
        questions: [
          { qid: "q1", question: "Which branch?", choices: ["beta"] },
          { qid: "q2", question: "Which tests?", choices: ["unit"], multi_select: true },
          { qid: "q3", question: "Anything else?" },
        ],
        answers: { q1: "beta", q3: "" },
        request_id: "re334455",
      },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    // q2 is the one still outstanding, so this turn's message goes there and
    // the two locked answers ride along beside it.
    socket.deliver({
      jsonrpc: "2.0",
      id: socket.method("clarify.respond")?.id,
      result: { status: "ok", remaining: 0 },
    });
    await settle();
    const [clarify] = clarifiesOnly(seen);
    expect(clarify.questions).toHaveLength(3);
    expect(clarify.answered).toEqual({ q1: "beta", q3: "", q2: "Hey" });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("shows it ONCE, even when the same question arrives live afterwards", async () => {
    // The replayed payload and a live re-emission are the SAME question. A
    // surface handed it twice draws two forms — the second one empty, over the
    // top of the half-filled one the customer was typing into. Keyed on
    // request_id, because that is the identity the gateway itself answers by.
    const { turn, socket } = await connect({
      pending_clarify: { question: "Which file?", choices: ["a.ts"], request_id: "dupe0011" },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    socket.deliver({ jsonrpc: "2.0", id: socket.method("clarify.respond")?.id, result: { status: "ok" } });
    await settle();
    expect(clarifiesOnly(seen)).toHaveLength(1);
    socket.event("clarify.request", { question: "Which file?", choices: ["a.ts"], request_id: "dupe0011" });
    await settle();
    expect(clarifiesOnly(seen)).toHaveLength(1);
    // A genuinely different question is still a different prompt.
    socket.event("clarify.request", { question: "And the branch?", choices: ["beta"], request_id: "dupe0022" });
    await settle();
    expect(clarifiesOnly(seen)).toHaveLength(2);
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });
});

describe("answering over the turn's own socket", () => {
  it("sends the answer addressed by request id alone", async () => {
    // No session id, and that is upstream's contract rather than an omission:
    // `_respond` resolves the session from a global pending registry keyed by
    // request id, which is exactly why an answer can arrive on a socket that
    // did not ask the question.
    const { turn, socket } = await connect();
    const answering = turn!.respondToClarify("9f2a1c04", '["Alpha","Beta"]');
    await settle();
    const sent = socket.method("clarify.respond");
    expect(sent).toBeDefined();
    // A JSON array string, not a comma-joined one: a choice label containing a
    // comma survives this encoding and does not survive the other.
    expect(sent?.params).toEqual({ request_id: "9f2a1c04", answer: '["Alpha","Beta"]' });
    socket.deliver({ jsonrpc: "2.0", id: sent?.id, result: { status: "ok" } });
    await expect(answering).resolves.toBeUndefined();
  });

  it("names the question when answering one of a batch", async () => {
    // Mandatory for a batch — and an answer with NO question_id against one is
    // upstream's cancel-all, so an empty string would discard every other
    // question in the same prompt rather than defaulting harmlessly.
    const { turn, socket } = await connect();
    const answering = turn!.respondToClarify("77dd88ee", "beta", "q1");
    await settle();
    const sent = socket.method("clarify.respond");
    expect(sent?.params).toEqual({ request_id: "77dd88ee", answer: "beta", question_id: "q1" });
    socket.deliver({ jsonrpc: "2.0", id: sent?.id, result: { status: "ok", remaining: ["q2"] } });
    await expect(answering).resolves.toBeUndefined();
  });

  it("treats a late answer as answered, not as a failure", async () => {
    // `_respond` runs with `allow_expired=True` precisely so a late reply is
    // REPORTED rather than raised. A customer who was a few seconds slow gets
    // "that question timed out", not an error in their transcript.
    const { turn, socket } = await connect();
    const answering = turn!.respondToClarify("expired1", "a.ts");
    await settle();
    const sent = socket.method("clarify.respond");
    socket.deliver({ jsonrpc: "2.0", id: sent?.id, result: { status: "expired" } });
    await expect(answering).resolves.toBeUndefined();
  });

  it("raises what the gateway refused, so a caller can say why", async () => {
    const { turn, socket } = await connect();
    const answering = turn!.respondToClarify("77dd88ee", "beta", "nope");
    await settle();
    const sent = socket.method("clarify.respond");
    socket.deliver({ jsonrpc: "2.0", id: sent?.id, error: { message: "unknown question_id" } });
    await expect(answering).rejects.toThrow("unknown question_id");
  });
});

describe("a new message while the agent is parked on a question", () => {
  // THE fix for TASK-610. Upstream parks the agent's worker thread on the
  // question for `agent.clarify_timeout` seconds; a fresh message on that
  // session used to be submitted as a brand-new prompt while the thread was
  // still parked, so the customer got their old question replayed at them and
  // nothing else happened until the window ran out. Their message IS the
  // answer, and `clarify.respond` — addressed by request id alone — is hermes'
  // own door for it.

  it("forwards the message as the ANSWER instead of replaying the question", async () => {
    const { turn, socket } = await connect({
      pending_clarify: { question: "Which file did you mean?", choices: ["a.ts", "b.ts"], request_id: "fw001122" },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    const answer = socket.method("clarify.respond");
    expect(answer).toBeDefined();
    // No `question_id`: a single-question clarify has no qid, and an empty one
    // against a batch is upstream's cancel-all.
    expect(answer?.params).toEqual({ request_id: "fw001122", answer: "Hey" });
    // And NOT also submitted as a fresh prompt — the same text processed twice
    // is two turns, two bills, and an agent answering itself.
    expect(socket.method("prompt.submit")).toBeUndefined();
    socket.deliver({ jsonrpc: "2.0", id: answer?.id, result: { status: "ok" } });
    await settle();
    socket.event("message.complete", { text: "a.ts it is", status: "complete" });
    const final = await running;
    expect(final.text).toBe("a.ts it is");
  });

  it("shows the question as answered by that message, once the gateway says so", async () => {
    // The UI half of the ruling: the card must say the question was answered —
    // and answered by THIS message — rather than sit there as an open form the
    // customer has already replied to.
    const { turn, socket } = await connect({
      pending_clarify: { question: "Which file did you mean?", choices: ["a.ts"], request_id: "fw112233" },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    const answer = socket.method("clarify.respond");
    socket.deliver({ jsonrpc: "2.0", id: answer?.id, result: { status: "ok" } });
    await settle();
    const clarifies = clarifiesOnly(seen);
    expect(clarifies).toHaveLength(1);
    // The empty qid is the single-question clarify's own identity — the same
    // key the card locks the answer under.
    expect(clarifies[0].answered).toEqual({ "": "Hey" });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("names the first UNANSWERED question of a batch, and keeps the rest askable", async () => {
    // A batch unblocks only once every qid has an answer, so the message goes
    // to the first question still outstanding and the others stay on the card.
    const { turn, socket } = await connect({
      pending_clarify: {
        questions: [
          { qid: "q1", question: "Which branch?", choices: ["beta"] },
          { qid: "q2", question: "Which file?", choices: ["a.ts"] },
          { qid: "q3", question: "Anything else?" },
        ],
        answers: { q1: "beta" },
        request_id: "fw334455",
      },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    const answer = socket.method("clarify.respond");
    expect(answer?.params).toEqual({ request_id: "fw334455", answer: "Hey", question_id: "q2" });
    socket.deliver({ jsonrpc: "2.0", id: answer?.id, result: { status: "ok", remaining: ["q3"] } });
    await settle();
    const [clarify] = clarifiesOnly(seen);
    expect(clarify.answered).toEqual({ q1: "beta", q2: "Hey" });
    expect(clarify.questions.map((q) => q.qid)).toEqual(["q1", "q2", "q3"]);
    // Still parked on q3, so the message must not have been submitted as a
    // prompt behind the customer's back either.
    expect(socket.method("prompt.submit")).toBeUndefined();
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("does not claim it was answered when the gateway refuses, and never drops the message", async () => {
    // False success, guarded: the answer's RESULT is read. A refusal means the
    // question stands — the card must stay open — and the customer's words are
    // still their turn, so they go in as a prompt rather than into a hole.
    const { turn, socket } = await connect({
      pending_clarify: { question: "Which file?", choices: ["a.ts"], request_id: "fw445566" },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    const answer = socket.method("clarify.respond");
    socket.deliver({ jsonrpc: "2.0", id: answer?.id, error: { message: "unknown request id" } });
    await settle();
    const [clarify] = clarifiesOnly(seen);
    expect(clarify.answered).toBeUndefined();
    expect(socket.method("prompt.submit")?.params).toMatchObject({ text: "Hey" });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });

  it("takes the card down and sends the message as a prompt when the window had closed", async () => {
    // `status: "expired"` is a SUCCESSFUL call whose window had gone — the
    // agent is not parked any more, so the message is an ordinary turn and the
    // dead question must stop being displayed as answerable.
    const { turn, socket } = await connect({
      pending_clarify: { question: "Which file?", choices: ["a.ts"], request_id: "fw556677" },
    });
    const seen: DashboardActivity[] = [];
    const running = turn!.run(
      () => {},
      (activity) => seen.push(activity),
    );
    await settle();
    const answer = socket.method("clarify.respond");
    socket.deliver({ jsonrpc: "2.0", id: answer?.id, result: { status: "expired" } });
    await settle();
    expect(seen.filter((a) => a.kind === "clarifyExpire")).toEqual([{ kind: "clarifyExpire", requestId: "fw556677" }]);
    expect(clarifiesOnly(seen).some((c) => c.answered)).toBe(false);
    expect(socket.method("prompt.submit")?.params).toMatchObject({ text: "Hey" });
    socket.event("message.complete", { text: "ok", status: "complete" });
    await running;
  });
});
