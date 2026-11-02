import { describe, expect, it, vi } from "vitest";

import { HermesAdapter } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";
import { HarnessError, type TurnEvent } from "@/lib/harness/transport";

/**
 * The Hermes adapter's half of "a reload does not stop the answer" (TASK-2117).
 *
 * A Hermes turn now belongs to the box rather than to the request that sent
 * it, which moves three things onto this adapter:
 *
 *  - FOLLOWING a turn it did not send: the reloaded page asks the route for the
 *    turn still running (`attachLiveTurn`) and must end up with exactly what the
 *    page that sent it would have had;
 *  - STOPPING on the box: aborting its own fetch no longer stops anything
 *    there, so Stop — and closing a tab with a turn running — must say so;
 *  - NOT stopping on the box when the page merely goes away (`disconnect`).
 */

const CAPS = capabilitiesFor("hermes", { ...UNKNOWN_FACTS, hasClawaiToken: true, hermesStreamsTurns: true });
const SESSION = "20260823_193014_6f5942";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= pieces.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(pieces[i++]) };
          },
        };
      },
    },
  } as unknown as Response;
}

function json(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    body: null,
    json: async () => payload,
  } as unknown as Response;
}

/** A response that never comes, until the caller's signal gives up on it. */
function held(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

type Call = { url: string; method: string; body?: Record<string, unknown>; accept?: string };

function makeAdapter(route: (call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      ...((init?.headers as Record<string, string> | undefined)?.Accept
        ? { accept: (init?.headers as Record<string, string>).Accept }
        : {}),
    };
    calls.push(call);
    return route(call, init);
  });
  let sessionKey = "desktop";
  const adapter = new HermesAdapter(
    CAPS,
    () => ({ devicePairing: { provider: "clawai", model: "deepseek-v4-flash" }, modelsReady: true, sessionKey }),
    fetchImpl as unknown as typeof fetch,
  );
  return { adapter, calls, setKey: (key: string) => { sessionKey = key; } };
}

const isAttach = (c: Call) => c.method === "GET" && c.url.startsWith("/setup-api/hermes/chat?");
const isStop = (c: Call) => c.method === "DELETE" && c.url.startsWith("/setup-api/hermes/chat?");

describe("following a turn the box is still running", () => {
  it("replays what was said, streams the rest, and resolves with the settled turn", async () => {
    const { adapter, calls } = makeAdapter((call) => {
      if (isAttach(call)) {
        return sse([
          frame("delta", { text: "The first half, " }),
          frame("tool", { name: "web_search", phase: "start", id: "t1" }),
          frame("delta", { text: "and the rest." }),
          frame("done", { text: "The first half, and the rest.", harness: "hermes", sessionId: SESSION, model: "deepseek-v4-flash" }),
        ]);
      }
      return json({ text: "next answer", sessionId: SESSION });
    });
    const events: TurnEvent[] = [];
    const result = await adapter.attachLiveTurn((event) => events.push(event));

    const attach = calls.find(isAttach)!;
    expect(attach.url).toBe("/setup-api/hermes/chat?sessionKey=desktop");
    expect(attach.accept).toBe("text/event-stream");
    expect(events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text)).toEqual([
      "The first half, ",
      "The first half, and the rest.",
    ]);
    expect(events.some((e) => e.kind === "tool")).toBe(true);
    expect(result).toMatchObject({ text: "The first half, and the rest.", model: "deepseek-v4-flash" });

    // The followed turn's session is the conversation's: the next message
    // resumes it rather than starting a stranger.
    await adapter.sendTurn({ text: "and then?", attachments: [], idempotencyKey: "next-1" });
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ sessionId: SESSION });
  });

  it("resolves null when nothing is running", async () => {
    const { adapter } = makeAdapter(() => ({ ok: true, status: 204, headers: { get: () => null }, body: null } as unknown as Response));
    await expect(adapter.attachLiveTurn()).resolves.toBeNull();
  });

  it("resolves null rather than failing when the route will not say", async () => {
    const { adapter } = makeAdapter(() => json({ error: "nope" }, 500));
    await expect(adapter.attachLiveTurn()).resolves.toBeNull();
  });

  it("ends as a Stop, not as a cut-off reply, when the box says the turn was stopped", async () => {
    const { adapter } = makeAdapter(() => sse([frame("delta", { text: "Once upon " }), frame("stopped", {})]));
    const err = await adapter.attachLiveTurn().catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe("aborted");
  });

  it("is what Stop reaches while it is followed: the read ends, and the box is told", async () => {
    const { adapter, calls } = makeAdapter((call, init) => (isStop(call) ? json({ stopped: 1 }) : held(init)));
    const following = adapter.attachLiveTurn().catch((e) => e);
    await vi.waitFor(() => expect(calls.some(isAttach)).toBe(true));
    await adapter.abortTurn();
    expect(((await following) as HarnessError).code).toBe("aborted");
    expect(calls.filter(isStop).map((c) => c.url)).toEqual(["/setup-api/hermes/chat?sessionKey=desktop"]);
  });
});

describe("loading the history", () => {
  it("says when the box is still answering the conversation", async () => {
    const { adapter } = makeAdapter(() => json({ messages: [{ role: "user", text: "Write me a story", timestamp: 1 }], liveTurn: true }));
    expect((await adapter.loadHistory()).liveTurn).toBe(true);
  });

  it("says nothing of the kind when it is not", async () => {
    const { adapter } = makeAdapter(() => json({ messages: [] }));
    expect((await adapter.loadHistory()).liveTurn).toBeUndefined();
  });
});

describe("stopping a turn", () => {
  it("sends the turn's id with it, and names it in the Stop", async () => {
    const { adapter, calls } = makeAdapter((call, init) => (isStop(call) ? json({ stopped: 1 }) : held(init)));
    const turn = adapter.sendTurn({ text: "Write me a story", attachments: [], idempotencyKey: "turn-abc_1" }).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ turnId: "turn-abc_1" });

    await adapter.abortTurn();
    expect(((await turn) as HarnessError).code).toBe("aborted");
    expect(calls.filter(isStop).map((c) => c.url)).toEqual([
      "/setup-api/hermes/chat?sessionKey=desktop&turnId=turn-abc_1",
    ]);
  });

  it("never sends an id the route would refuse", async () => {
    const { adapter, calls } = makeAdapter(() => json({ text: "ok", sessionId: SESSION }));
    await adapter.sendTurn({ text: "hi", attachments: [], idempotencyKey: "../../etc/passwd" });
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("turnId");
  });

  it("stops on the box before the transcript of a closed tab is deleted", async () => {
    const { adapter, calls, setKey } = makeAdapter((call, init) => {
      if (isStop(call) || call.method === "DELETE") return json({ ok: true, stopped: 1 });
      return held(init);
    });
    setKey("desktop-abc123def456");
    const turn = adapter.sendTurn({ text: "Write me a story", attachments: [], idempotencyKey: "turn-2" }).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await adapter.deleteSession("desktop-abc123def456", { running: true });
    await turn;
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toEqual([
      "/setup-api/hermes/chat?sessionKey=desktop-abc123def456&turnId=turn-2",
      "/setup-api/chat/history?sessionKey=desktop-abc123def456",
    ]);
  });

  it("does not stop anything on the box when the page merely goes away", async () => {
    // A reload unmounts the page. That must not be what ends an answer.
    const { adapter, calls } = makeAdapter((_call, init) => held(init));
    const turn = adapter.sendTurn({ text: "Write me a story", attachments: [], idempotencyKey: "turn-3" }).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    adapter.disconnect();
    await turn;
    expect(calls.some(isStop)).toBe(false);
  });
});
