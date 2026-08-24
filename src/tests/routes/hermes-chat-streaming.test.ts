import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat route's streaming path.
 *
 * Two things are being pinned, and only one of them is "text arrives early".
 *
 * The other is that streaming did not cost the turn its RECORD. Everything the
 * blocking path produces — the deduplicated thinking, the tool steps, the
 * session id, the transcript line — comes from the agent's own database AFTER
 * the turn ends, and none of it can be read off the stream. A streamed turn
 * that shipped only what it streamed would silently lose the steps sidebar, the
 * reasoning disclosure, and the ability to resume the conversation.
 *
 * And a third, quieter one: the raw monologue must never reach the delta
 * channel. Here that is structural rather than filtered — the route forwards
 * only what the transport calls the answer — so the test is written to fail if
 * anyone ever "helpfully" widens it.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const readTurnMock = vi.hoisted(() => vi.fn());

// Only the OPENING is faked. The rest of the module — `isQuietStreamError` and
// the error class it recognises — is the real thing, because the route's
// recovery path turns on that predicate and a hand-written stand-in would let
// the two drift: a mock that answered `true` for every failure would prove the
// route recovers from errors it must still report.
vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({ readHermesTurn: readTurnMock }));
vi.mock("@/lib/harness/media-root", () => ({ resolveInMediaRoot: vi.fn(async (p: string) => p) }));
vi.mock("@/lib/hermes-model-options", () => ({
  // No catalogue: the route falls back to its static allowlist and lets hermes
  // itself judge the pair, which is the path a box takes before the header has
  // warmed the cache.
  getModelOptions: vi.fn(async () => null),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";
import { DashboardStreamQuietError, type DashboardActivity } from "@/lib/hermes-dashboard-turn";

/** A turn handle that emits the given fragments and then settles. */
function fakeTurn(opts: {
  sessionId?: string;
  deltas?: string[];
  /** What the turn reports it is DOING, emitted before the answer text. */
  activities?: DashboardActivity[];
  text?: string;
  reasoning?: string;
  status?: string;
  error?: string;
  fail?: Error;
  model?: string;
  provider?: string;
}) {
  const closed = { value: false };
  return {
    handle: {
      sessionId: opts.sessionId ?? "20260823_190319_3e9e35",
      // What the transport says this session will actually run. The route
      // records it with the turn, so a switch that did not take is visible.
      model: opts.model ?? "",
      provider: opts.provider ?? "",
      async run(onDelta: (chunk: string) => void, onActivity?: (activity: DashboardActivity) => void) {
        if (opts.fail) throw opts.fail;
        // The order a real turn takes: the tool runs, and only then is there
        // anything to say about it.
        for (const activity of opts.activities ?? []) onActivity?.(activity);
        for (const chunk of opts.deltas ?? []) onDelta(chunk);
        return {
          text: opts.text ?? (opts.deltas ?? []).join(""),
          reasoning: opts.reasoning ?? "",
          status: opts.status ?? "complete",
          ...(opts.error ? { error: opts.error } : {}),
        };
      },
      close() {
        closed.value = true;
      },
    },
    closed,
  };
}

function post(body: Record<string, unknown>, accept = "text/event-stream"): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify(body),
  });
}

/** Read a whole SSE body into `[eventName, payload]` pairs. */
async function readEvents(res: Response): Promise<Array<[string, Record<string, unknown>]>> {
  const text = await res.text();
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let name = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    out.push([name, JSON.parse(data.join("\n")) as Record<string, unknown>]);
  }
  return out;
}

beforeEach(() => {
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  readTurnMock.mockReset();
  readTurnMock.mockResolvedValue(null);
});

describe("a streamed chat turn", () => {
  it("sends the answer in pieces and then the settled turn", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["Hey! ", "What can I help with?"] }).handle);
    const res = await POST(post({ message: "Hey" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // A proxy that buffered this would hold every fragment until the turn ended
    // and undo the entire point of the change.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const events = await readEvents(res);
    expect(events.map(([name]) => name)).toEqual(["delta", "delta", "done"]);
    expect(events[0][1]).toEqual({ text: "Hey! " });
    expect(events[1][1]).toEqual({ text: "What can I help with?" });
    expect(events[2][1]).toMatchObject({
      text: "Hey! What can I help with?",
      harness: "hermes",
      sessionId: "20260823_190319_3e9e35",
    });
  });

  it("never spawns the CLI when the dashboard took the turn", async () => {
    // The whole saving is the process that is NOT started: ~6 seconds of agent
    // construction before the first request to the model even goes out.
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["ok"] }).handle);
    await readEvents(await POST(post({ message: "Hey" })));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still reads the tool steps and thinking out of the agent's own record", async () => {
    // None of this can be recovered from the stream. The database is the source
    // for the finished turn on BOTH transports, which is what keeps a streamed
    // reply identical to a spawned one everywhere except when it appeared.
    readTurnMock.mockResolvedValue({
      text: "The kernel is 5.15.185-tegra.",
      reasoning: "I ran uname and read the output.",
      toolCalls: [{ name: "terminal", detail: "uname -r", status: "ok" }],
    });
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["The kernel is 5.15.185-tegra."] }).handle);
    const events = await readEvents(await POST(post({ message: "kernel?" })));
    const [, done] = events[events.length - 1];
    expect(done).toMatchObject({
      text: "The kernel is 5.15.185-tegra.",
      reasoning: "I ran uname and read the output.",
      toolCalls: [{ name: "terminal", detail: "uname -r", status: "ok" }],
    });
    expect(readTurnMock).toHaveBeenCalledWith("20260823_190319_3e9e35");
  });

  it("records the answer once the turn settles, beside its thinking and never inside it", async () => {
    readTurnMock.mockResolvedValue({ text: "Hey!", reasoning: "a greeting, so greet back" });
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["Hey!"] }).handle);
    await readEvents(await POST(post({ message: "Hey" })));
    const assistant = appendMock.mock.calls.map((c) => c[0]).find((r) => r.role === "assistant");
    expect(assistant).toMatchObject({ text: "Hey!", reasoning: "a greeting, so greet back" });
    expect(assistant.text).not.toContain("a greeting, so greet back");
  });

  it("puts nothing of the monologue on the delta channel", async () => {
    // The transport separates them upstream, so the route has nothing to
    // filter — this asserts the route does not undo that by widening what it
    // forwards. The reasoning arrives only on the settled turn.
    openTurnMock.mockResolvedValue(
      fakeTurn({ deltas: ["Four."], text: "Four.", reasoning: "two plus two is four" }).handle,
    );
    const events = await readEvents(await POST(post({ message: "2+2?" })));
    for (const [name, payload] of events) {
      if (name !== "delta") continue;
      expect(JSON.stringify(payload)).not.toContain("two plus two");
    }
  });

  it("threads the conversation by resuming the id it was given", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({ sessionId: "20260823_185842_1eabd5", deltas: ["ok"] }).handle);
    await readEvents(await POST(post({ message: "and then?", sessionId: "20260823_185842_1eabd5" })));
    expect(openTurnMock.mock.calls[0][0]).toMatchObject({
      text: "and then?",
      sessionId: "20260823_185842_1eabd5",
    });
  });

  it("reports a failed turn inside the stream, since the status code is spent", async () => {
    openTurnMock.mockResolvedValue(
      fakeTurn({ deltas: ["…"], status: "error", error: "the provider is rate limiting" }).handle,
    );
    const events = await readEvents(await POST(post({ message: "Hey" })));
    expect(events[events.length - 1][0]).toBe("error");
    expect(events[events.length - 1][1]).toEqual({ error: "the provider is rate limiting" });
    // And the failure is in the transcript, so a refresh shows the box tried.
    expect(appendMock.mock.calls.map((c) => c[0]).some((r) => r.variant === "error")).toBe(true);
  });

  it("closes the turn even when it threw", async () => {
    const made = fakeTurn({ fail: new Error("dashboard stream went quiet") });
    openTurnMock.mockResolvedValue(made.handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    expect(events[events.length - 1][0]).toBe("error");
    expect(made.closed.value).toBe(true);
  });
});

describe("when the box cannot stream", () => {
  it("falls back to spawning, and answers ordinary JSON", async () => {
    // Every reason the fast path can fail is discovered while the response is
    // still uncommitted, which is the only thing that makes a fallback possible
    // at all. The customer waits the old amount and gets the old answer.
    openTurnMock.mockResolvedValue(null);
    readTurnMock.mockResolvedValue({ text: "spawned instead" });
    spawnMock.mockImplementation(() => {
      const proc = {
        stdout: { on: (e: string, cb: (c: Buffer) => void) => e === "data" && cb(Buffer.from("spawned instead")) },
        stderr: {
          on: (e: string, cb: (c: Buffer) => void) =>
            e === "data" && cb(Buffer.from("\nsession_id: 20260823_190508_ce85d3\n")),
        },
        on: (e: string, cb: (code: number) => void) => {
          if (e === "close") setTimeout(() => cb(0), 0);
        },
        kill: () => {},
      };
      return proc;
    });
    const res = await POST(post({ message: "Hey" }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ text: "spawned instead", harness: "hermes" });
    expect(spawnMock).toHaveBeenCalled();
  });

  it("does not even try to stream a turn carrying a picture", async () => {
    // `--image` is a flag on the CLI; the socket takes attachments through a
    // separate handshake this route has not been taught. Correctness first —
    // and a turn with a picture is rare and already slow.
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["ok"] }).handle);
    readTurnMock.mockResolvedValue({ text: "looked at it" });
    spawnMock.mockImplementation(() => ({
      stdout: { on: (e: string, cb: (c: Buffer) => void) => e === "data" && cb(Buffer.from("looked at it")) },
      stderr: { on: () => {} },
      on: (e: string, cb: (code: number) => void) => {
        if (e === "close") setTimeout(() => cb(0), 0);
      },
      kill: () => {},
    }));
    await POST(post({ message: "what is this?", imagePaths: ["/home/clawbox/media/a.png"] }));
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
  });

  it("does not stream to a caller that did not ask to be streamed to", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["ok"] }).handle);
    readTurnMock.mockResolvedValue({ text: "blocking" });
    spawnMock.mockImplementation(() => ({
      stdout: { on: (e: string, cb: (c: Buffer) => void) => e === "data" && cb(Buffer.from("blocking")) },
      stderr: { on: () => {} },
      on: (e: string, cb: (code: number) => void) => {
        if (e === "close") setTimeout(() => cb(0), 0);
      },
      kill: () => {},
    }));
    const res = await POST(post({ message: "Hey" }, "application/json"));
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("saying which model actually answered", () => {
  it("records the model the transport ran, not the one the pills asked for", async () => {
    // The pills are a request. When a mid-conversation switch is refused the
    // session keeps its old model, and the ONLY way that was ever noticed was
    // by asking the model directly -- nothing in the reply said which had
    // answered. Now the turn carries it.
    openTurnMock.mockResolvedValue(
      fakeTurn({ deltas: ["ok"], model: "deepseek-v4-flash", provider: "clawai" }).handle,
    );
    const events = await readEvents(
      await POST(post({ message: "Hey", model: "claude-fable-5", provider: "anthropic" })),
    );
    const [, done] = events[events.length - 1];
    expect(done).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
    // ...and the same goes into the durable transcript, per record, because one
    // conversation can be answered by several models.
    const assistant = appendMock.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .find((record) => record.role === "assistant");
    expect(assistant).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
  });

  it("omits the field entirely when the transport named no model", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["ok"] }).handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    const [, done] = events[events.length - 1];
    expect(done).not.toHaveProperty("model");
    expect(done).not.toHaveProperty("provider");
  });
});

describe("a turn whose model did no reasoning", () => {
  it("ends with no reasoning field rather than an empty disclosure", async () => {
    // Measured on the box: claude-fable-5 answered with real reasoning empty
    // while the agent spinner still ticked, so the disclosure showed a kaomoji
    // and nothing else. An absent field is what closes the disclosure.
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["one"], reasoning: "" }).handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    const [, done] = events[events.length - 1];
    expect(done).not.toHaveProperty("reasoning");
  });

  it("drops a status frame that reached reasoning by any other route", async () => {
    // The transport drops `thinking.delta` at the source, so this stands for
    // the paths with no channel to separate: an older record, or the CLI
    // printing its spinner to stdout.
    readTurnMock.mockResolvedValue({
      text: "one",
      // A face from the agent's own vocabulary (agent/display.py KAWAII_THINKING).
      reasoning: "⊙_⊙ cogitating...",
    });
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["one"] }).handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    const [, done] = events[events.length - 1];
    expect(done).not.toHaveProperty("reasoning");
  });

  it("keeps real reasoning untouched", async () => {
    readTurnMock.mockResolvedValue({ text: "one", reasoning: "The user asked for one word." });
    openTurnMock.mockResolvedValue(fakeTurn({ deltas: ["one"] }).handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    const [, done] = events[events.length - 1];
    expect(done).toMatchObject({ reasoning: "The user asked for one word." });
  });
});

describe("showing the work while the turn is still doing it", () => {
  it("sends the tool step as its own event, before the turn is done", async () => {
    // The blank-bubble bug, measured: a `terminal` call on the live box ran
    // 240.3 seconds, emitting `tool.start` at t+3.7s and `tool.complete` at
    // t+244.0s with nothing in between. For four minutes the customer had a
    // reply that had not started and no reason given. These frames are that
    // reason, and they have to reach the client while the turn is still
    // running — a `done` frame that listed the same steps afterwards would be
    // a receipt, not progress.
    openTurnMock.mockResolvedValue(
      fakeTurn({
        activities: [
          { kind: "tool", phase: "start", id: "call_7", name: "terminal", detail: "uname -r" },
          { kind: "tool", phase: "result", id: "call_7", name: "terminal", detail: "5.15.185-tegra", status: "ok" },
        ],
        deltas: ["The kernel is 5.15.185-tegra."],
      }).handle,
    );
    const events = await readEvents(await POST(post({ message: "kernel?" })));
    expect(events.map(([name]) => name)).toEqual(["tool", "tool", "delta", "done"]);
    expect(events[0][1]).toMatchObject({ kind: "tool", phase: "start", id: "call_7", name: "terminal" });
    // The same id on both, so a surface updates the pill it already drew.
    expect(events[1][1]).toMatchObject({ kind: "tool", phase: "result", id: "call_7", name: "terminal" });
    expect(events.findIndex(([name]) => name === "tool")).toBeLessThan(
      events.findIndex(([name]) => name === "done"),
    );
  });

  it("keeps the delta channel to answer text and nothing else", async () => {
    // The delta channel paints the bubble. A status line or a tool name that
    // leaked onto it would be typed out as though the agent had said it —
    // which is how `(⊙_⊙) musing...` reached a customer once already.
    openTurnMock.mockResolvedValue(
      fakeTurn({
        activities: [
          { kind: "status", text: "(⌐■_■) computing..." },
          { kind: "tool", phase: "start", id: "call_7", name: "web_search", detail: "clawbox docs" },
        ],
        deltas: ["Here ", "they are."],
      }).handle,
    );
    const events = await readEvents(await POST(post({ message: "find the docs" })));
    const deltas = events.filter(([name]) => name === "delta");
    expect(deltas).toHaveLength(2);
    for (const [, payload] of deltas) {
      expect(Object.keys(payload)).toEqual(["text"]);
      expect(JSON.stringify(payload)).not.toContain("computing");
      expect(JSON.stringify(payload)).not.toContain("web_search");
    }
    // And the spinner still reaches the client — on its own channel.
    expect(events.some(([name, payload]) => name === "status" && payload.text === "(⌐■_■) computing...")).toBe(true);
  });
});

describe("when the stream goes quiet on a turn that already finished", () => {
  /**
   * The customer's own transcript, timestamped: the question was asked at
   * 20:10:44, the agent ran two tools and wrote its 582-character answer to
   * `state.db` at 20:11:12, and the `message.complete` frame never reached this
   * socket. The route waited out the idle window and wrote "Error: dashboard
   * stream went quiet" into their transcript at 20:14:13 — a finished answer
   * discarded and replaced with a failure, three minutes after it was ready.
   */
  it("reads the answer out of the record rather than writing an error over it", async () => {
    readTurnMock.mockResolvedValue({
      text: "The kernel is 5.15.185-tegra, and the box has 7.4 GB of RAM.",
      toolCalls: [{ name: "terminal", detail: "uname -r", status: "ok" }],
    });
    openTurnMock.mockResolvedValue(
      fakeTurn({ fail: new DashboardStreamQuietError(41, "tool.complete") }).handle,
    );
    const events = await readEvents(await POST(post({ message: "kernel and RAM?" })));
    const [name, payload] = events[events.length - 1];
    expect(name).toBe("done");
    expect(payload).toMatchObject({ text: "The kernel is 5.15.185-tegra, and the box has 7.4 GB of RAM." });
    expect(events.some(([event]) => event === "error")).toBe(false);
    // Nothing may say the turn failed: the transcript is what a refresh shows,
    // and an "Error:" row beside a perfectly good answer is the artefact the
    // customer reported.
    const rows = appendMock.mock.calls.map(([record]) => record as Record<string, unknown>);
    expect(rows.some((row) => row.variant === "error")).toBe(false);
    expect(rows.some((row) => typeof row.text === "string" && row.text.startsWith("Error:"))).toBe(false);
    expect(rows.some((row) => row.role === "assistant")).toBe(true);
  });

  it("still reports the failure when the record has no answer either", async () => {
    // The other side of the same branch, and the reason the recovery is safe:
    // a turn that really did die leaves no assistant row after the question, so
    // `readHermesTurn` returns null and the customer is told. Losing this would
    // turn every dead turn into a silent one.
    readTurnMock.mockResolvedValue(null);
    openTurnMock.mockResolvedValue(fakeTurn({ fail: new DashboardStreamQuietError(2, "message.start") }).handle);
    const events = await readEvents(await POST(post({ message: "Hey" })));
    const [name, payload] = events[events.length - 1];
    expect(name).toBe("error");
    expect(payload).toEqual({ error: "dashboard stream went quiet" });
    const rows = appendMock.mock.calls.map(([record]) => record as Record<string, unknown>);
    expect(rows.some((row) => row.variant === "error")).toBe(true);
  });
});
