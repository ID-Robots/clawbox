import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reload must not stop a Hermes answer (TASK-2117).
 *
 * On a real box, refreshing the chat while the agent was writing cut the answer
 * off and left "Stopped." in the transcript — every time. The route handed the
 * REQUEST's abort signal to the turn, and that signal fires for any end of the
 * browser's connection, a reload included, so every reload read as a Stop.
 *
 * Pinned here, against the route itself:
 *   - a request that goes away mid-answer leaves the turn running, and the
 *     answer is recorded as the turn's own — no "Stopped.";
 *   - the reloaded page re-attaches (GET) and is handed what was streamed so
 *     far, then the rest live;
 *   - only the owner's Stop (DELETE) ends a turn early, and it is recorded as
 *     a Stop exactly as before — including a Stop that reached the box before
 *     the turn it names did.
 *
 * The fake transport keeps the REAL one's abort contract: an abort of the
 * signal the turn was opened with rejects `run` with an AbortError
 * (hermes-dashboard-turn.ts, `onAbort`). A fake that ignored its signal would
 * pass on the unfixed route too.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const readTurnMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  withHermesStateHome: (_home: unknown, fn: () => unknown) => fn(),
  readHermesTurn: readTurnMock,
  readHermesUsageMarks: async () => null,
  readHermesBillingProvider: async () => "",
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-reload-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { DELETE, GET, POST } from "@/app/setup-api/hermes/chat/route";
import { hasLiveTurn, resetLiveTurns } from "@/lib/harness/hermes-live-turn";

const SESSION = "20260823_190319_3e9e35";
const KEY = "desktop";

/**
 * A turn that says its first half, then waits to be released before saying the
 * rest — long enough to reload in the middle of it. Rejects the way the real
 * transport does when the signal it was opened with fires.
 */
function gatedTurn() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: { signal?: AbortSignal } = {};
  const closed = { value: false };
  const handle = {
    sessionId: SESSION,
    model: "",
    provider: "",
    async run(onDelta: (chunk: string) => void) {
      const signal = seen.signal;
      const aborted = new Promise<never>((_resolve, reject) => {
        const fire = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) fire();
        else signal?.addEventListener("abort", fire, { once: true });
      });
      onDelta("The first half, ");
      await Promise.race([gate, aborted]);
      onDelta("and the rest.");
      return { text: "The first half, and the rest.", reasoning: "", status: "complete" };
    },
    close() {
      closed.value = true;
    },
  };
  openTurnMock.mockImplementation(async (req: { signal?: AbortSignal }) => {
    seen.signal = req.signal;
    // The real one answers "cannot stream" for a signal already aborted.
    return req.signal?.aborted ? null : handle;
  });
  return { release: () => release(), seen, closed };
}

function post(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function attachRequest(sessionKey = KEY): Request {
  return new Request(`http://localhost/setup-api/hermes/chat?sessionKey=${sessionKey}`, {
    headers: { accept: "text/event-stream" },
  });
}

function stopRequest(query: string): Request {
  return new Request(`http://localhost/setup-api/hermes/chat?${query}`, { method: "DELETE" });
}

function parse(text: string): Array<[string, Record<string, unknown>]> {
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

/** Read one chunk of a streamed response — the frames the browser saw before it went. */
async function firstFrames(res: Response) {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  return { reader, events: parse(new TextDecoder().decode(value)) };
}

const records = () => appendMock.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  readTurnMock.mockReset();
  readTurnMock.mockResolvedValue(null);
  resetLiveTurns();
});

describe("a reload in the middle of a Hermes answer", () => {
  it("does not stop the turn: the answer is recorded whole and nothing says Stopped", async () => {
    const turn = gatedTurn();
    const browser = new AbortController();
    const res = await POST(post({ message: "Write me a long story" }, browser.signal));
    const { reader, events } = await firstFrames(res);
    expect(events).toEqual([["delta", { text: "The first half, " }]]);

    // F5: the browser's connection ends, and the response with it.
    browser.abort();
    await reader.cancel();
    // The turn was not told to stop: what fires for a reload is not what it holds.
    expect(turn.seen.signal?.aborted).toBe(false);

    turn.release();
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant")).toBe(true));
    const assistant = records().find((r) => r.role === "assistant");
    expect(assistant).toMatchObject({ text: "The first half, and the rest.", sessionId: SESSION });
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
    expect(records().some((r) => r.text === "Stopped.")).toBe(false);
    await vi.waitFor(() => expect(hasLiveTurn(KEY)).toBe(false));
    expect(turn.closed.value).toBe(true);
  });

  it("lets the reloaded page re-attach: what was said so far, then the rest live", async () => {
    const turn = gatedTurn();
    const browser = new AbortController();
    const { reader } = await firstFrames(await POST(post({ message: "Write me a long story" }, browser.signal)));
    browser.abort();
    await reader.cancel();

    // The reloaded page asks for the turn it was cut off from.
    const attached = await GET(attachRequest());
    expect(attached.status).toBe(200);
    expect(attached.headers.get("content-type")).toContain("text/event-stream");
    turn.release();
    const events = parse(await attached.text());
    expect(events.map(([name]) => name)).toEqual(["delta", "delta", "done"]);
    // Replayed first, then live — and together they are the answer.
    expect(events[0][1]).toEqual({ text: "The first half, " });
    expect(events[1][1]).toEqual({ text: "and the rest." });
    expect(events[2][1]).toMatchObject({ text: "The first half, and the rest.", sessionId: SESSION });
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
  });

  it("answers 204 to a page asking after a conversation with nothing running", async () => {
    const res = await GET(attachRequest());
    expect(res.status).toBe(204);
  });

  it("refuses to hand one person's running turn to a key that is not a conversation", async () => {
    const res = await GET(attachRequest("..%2Fetc"));
    expect(res.status).toBe(400);
  });
});

describe("the owner's Stop", () => {
  it("is what stops a turn now: what was streamed is kept, then the marker, and followers hear it", async () => {
    const turn = gatedTurn();
    const { reader } = await firstFrames(await POST(post({ message: "Write me a long story" })));
    await reader.cancel();
    const follower = await GET(attachRequest());

    const res = await DELETE(stopRequest(`sessionKey=${KEY}`));
    expect(res.status).toBe(200);
    // Answered once the stopped turn has written its ending down.
    expect(await res.json()).toEqual({ stopped: 1 });
    expect(turn.seen.signal?.aborted).toBe(true);
    const tail = records().slice(-2);
    expect(tail[0]).toMatchObject({ role: "assistant", text: "The first half," });
    expect(tail[1]).toMatchObject({ role: "system", text: "Stopped.", variant: "stopped" });

    const events = parse(await follower.text());
    expect(events.map(([name]) => name)).toEqual(["delta", "stopped"]);
    expect(hasLiveTurn(KEY)).toBe(false);
  });

  it("still ends as a Stop when it lands after the last frame, before the answer is settled", async () => {
    // The transport has finished but the route has not written the answer
    // yet (the record, a spoken clip): the owner was shown the stop, so the
    // record says so, and a page reading the history is not told to follow it.
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    openTurnMock.mockResolvedValue({
      sessionId: SESSION,
      model: "",
      provider: "",
      async run(onDelta: (chunk: string) => void) {
        onDelta("All of it.");
        await finished;
        return { text: "All of it.", reasoning: "", status: "complete" };
      },
      close() {},
    });
    const { reader } = await firstFrames(await POST(post({ message: "Tell me" })));
    const stopping = DELETE(stopRequest(`sessionKey=${KEY}`));
    await vi.waitFor(() => expect(hasLiveTurn(KEY)).toBe(false));
    finish();
    expect(await (await stopping).json()).toEqual({ stopped: 1 });
    await reader.cancel();
    expect(readTurnMock).not.toHaveBeenCalled();
    const tail = records().slice(-2);
    expect(tail[0]).toMatchObject({ role: "assistant", text: "All of it." });
    expect(tail[1]).toMatchObject({ role: "system", variant: "stopped" });
  });

  it("stops nothing, and says so, when nothing is running", async () => {
    const res = await DELETE(stopRequest(`sessionKey=${KEY}`));
    expect(await res.json()).toEqual({ stopped: 0 });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("still lands when it reaches the box before the turn it names", async () => {
    // Send and Stop at once: the Stop can arrive while the turn's request is
    // still being read. The old route stopped that turn (its request's signal
    // fired); the turn id is what keeps it stopped now.
    gatedTurn();
    await DELETE(stopRequest(`sessionKey=${KEY}&turnId=turn-1`));
    const res = await POST(post({ message: "never mind", turnId: "turn-1" }));
    expect(res.status).toBe(499);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(records()[records().length - 1]).toMatchObject({ role: "system", variant: "stopped" });
  });

  it("held for one turn never stops the next message", async () => {
    const turn = gatedTurn();
    await DELETE(stopRequest(`sessionKey=${KEY}&turnId=turn-1`));
    const { reader } = await firstFrames(await POST(post({ message: "a new question", turnId: "turn-2" })));
    expect(turn.seen.signal?.aborted).toBe(false);
    turn.release();
    await reader.cancel();
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant")).toBe(true));
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
  });
});

describe("a reload while the CLI is answering", () => {
  it("leaves the child running and records its answer", async () => {
    // No dashboard: the box answers through `hermes chat -q`.
    openTurnMock.mockResolvedValue(null);
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const child = {
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stdout:${event}`] = cb as never; } },
      stderr: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stderr:${event}`] = cb as never; } },
      on: (event: string, cb: (...args: unknown[]) => void) => { listeners[event] = cb; },
      kill: vi.fn(),
    };
    spawnMock.mockReturnValue(child);
    const browser = new AbortController();
    const pending = POST(post({ message: "Write me a long story" }, browser.signal));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    browser.abort();
    // The CLI child was not killed by the reload…
    expect(child.kill).not.toHaveBeenCalled();
    listeners["stdout:data"]?.(Buffer.from("The whole story."));
    listeners["stderr:data"]?.(Buffer.from(`session_id: ${SESSION}\n`));
    listeners.close?.(0);
    await pending;
    // …and its answer is the turn's record, not a stop.
    expect(records().find((r) => r.role === "assistant")).toMatchObject({ text: "The whole story." });
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
  });
});
