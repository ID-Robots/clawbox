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

vi.mock("@/lib/hermes-dashboard-turn", () => ({ openDashboardTurn: openTurnMock }));
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

/** A turn handle that emits the given fragments and then settles. */
function fakeTurn(opts: {
  sessionId?: string;
  deltas?: string[];
  text?: string;
  reasoning?: string;
  status?: string;
  error?: string;
  fail?: Error;
}) {
  const closed = { value: false };
  return {
    handle: {
      sessionId: opts.sessionId ?? "20260823_190319_3e9e35",
      async run(onDelta: (chunk: string) => void) {
        if (opts.fail) throw opts.fail;
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
