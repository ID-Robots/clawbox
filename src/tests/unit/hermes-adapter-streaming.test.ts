import { describe, expect, it, vi } from "vitest";

import { HermesAdapter } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor } from "@/lib/harness/capabilities";
import { HarnessError, type TurnEvent } from "@/lib/harness/transport";

/**
 * The Hermes adapter reading a STREAMED turn.
 *
 * What is actually at stake here is not "does text arrive early" — it is the
 * two ways a streaming client silently corrupts a conversation:
 *
 *  - getting the delta contract backwards, which either doubles the reply or
 *    shows only its last few characters;
 *  - painting the model's monologue into the bubble, which is the exact bug the
 *    non-streaming path already had to be fixed for and which a new transport
 *    is free to reintroduce.
 *
 * Both are pinned below, along with the third thing a stream can do that a
 * request/response cannot: end in the middle.
 */

const FACTS = {
  hasClawaiToken: true,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: true, hermesAgentDrawsImages: false
};
const STREAMING_CAPS = capabilitiesFor("hermes", FACTS);
const BLOCKING_CAPS = capabilitiesFor("hermes", { ...FACTS, hermesStreamsTurns: false , hermesAgentDrawsImages: false});

/** One SSE frame, framed the way the route frames it. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A Response whose body yields the given pieces in order.
 *
 * The pieces are handed over as written, so a test can deliberately split a
 * frame across two reads — which is what a real socket does constantly and the
 * single most likely thing for a hand-rolled parser to get wrong.
 */
function sseResponse(pieces: string[], init?: { ok?: boolean; status?: number }): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (i >= pieces.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(pieces[i++]) };
        },
      };
    },
  };
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body,
    json: async () => {
      throw new Error("a streamed response must not be read as JSON");
    },
  } as unknown as Response;
}

/** A Response that is the ordinary one-shot JSON body. */
function jsonResponse(payload: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    body: null,
    json: async () => payload,
  } as unknown as Response;
}

function makeAdapter(response: Response, caps = STREAMING_CAPS) {
  const requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push({
      headers: (init?.headers || {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return response;
  });
  const adapter = new HermesAdapter(
    caps,
    () => ({ devicePairing: { provider: "clawai", model: "deepseek-v4-flash" }, modelsReady: true }),
    fetchImpl as unknown as typeof fetch,
  );
  return { adapter, requests };
}

const turn = { text: "Hey", attachments: [], idempotencyKey: "k1" };

describe("a Hermes turn that streams", () => {
  it("reports the answer SO FAR, never the fragment that just arrived", async () => {
    // The contract in transport.ts is cumulative. The wire is not — the
    // dashboard socket emits fragments — so the accumulation has to happen
    // here, and this is the assertion that says so. Passing fragments through
    // raw would leave the bubble showing "there" instead of the whole reply.
    const { adapter } = makeAdapter(
      sseResponse([
        frame("delta", { text: "Hello" }),
        frame("delta", { text: " there" }),
        frame("delta", { text: "!" }),
        frame("done", { text: "Hello there!", harness: "hermes", sessionId: "20260823_190319_3e9e35" }),
      ]),
    );
    const seen: string[] = [];
    const result = await adapter.sendTurn(turn, (e: TurnEvent) => {
      if (e.kind === "delta") seen.push(e.text);
    });
    expect(seen).toEqual(["Hello", "Hello there", "Hello there!"]);
    expect(result.text).toBe("Hello there!");
  });

  it("survives a frame split across two reads", async () => {
    // A socket boundary lands mid-frame constantly. A parser that assumed one
    // read is one frame would drop this delta entirely and still resolve with a
    // plausible-looking final, which is the worst shape of wrong.
    const whole = frame("delta", { text: "streamed" }) + frame("done", { text: "streamed", harness: "hermes" });
    const cut = Math.floor(whole.length / 3);
    const { adapter } = makeAdapter(sseResponse([whole.slice(0, cut), whole.slice(cut)]));
    const seen: string[] = [];
    const result = await adapter.sendTurn(turn, (e) => {
      if (e.kind === "delta") seen.push(e.text);
    });
    expect(seen).toEqual(["streamed"]);
    expect(result.text).toBe("streamed");
  });

  it("never lets the monologue reach the bubble, mid-stream or at the end", async () => {
    // The route sends thinking on no channel at all — the transport separates
    // it upstream — so the only place it can appear is the finished turn's own
    // `reasoning` field, beside the answer and never inside it.
    const { adapter } = makeAdapter(
      sseResponse([
        frame("delta", { text: "The answer is 4." }),
        frame("done", {
          text: "The answer is 4.",
          harness: "hermes",
          reasoning: "Let me add two and two. That is four.",
        }),
      ]),
    );
    const seen: string[] = [];
    const result = await adapter.sendTurn(turn, (e) => {
      if (e.kind === "delta") seen.push(e.text);
    });
    for (const painted of seen) expect(painted).not.toContain("Let me add two and two");
    expect(result.text).toBe("The answer is 4.");
    expect(result.reasoning).toBe("Let me add two and two. That is four.");
  });

  it("keeps the tool steps the stream itself could not carry", async () => {
    // Only the agent's own record has these, and only after the turn ends. A
    // streamed turn that dropped them would quietly lose the steps sidebar that
    // the blocking path shows.
    const { adapter } = makeAdapter(
      sseResponse([
        frame("delta", { text: "done" }),
        frame("done", {
          text: "done",
          harness: "hermes",
          toolCalls: [{ name: "terminal", detail: "uname -r", status: "ok" }],
          sessionId: "20260823_190334_956175",
        }),
      ]),
    );
    const result = await adapter.sendTurn(turn, () => {});
    expect(result.toolCalls).toEqual([{ name: "terminal", detail: "uname -r", status: "ok" }]);
    // And the session id threads exactly as it does on the blocking path.
    expect(adapter.threadedSessionId).toBe("20260823_190334_956175");
  });

  it("treats a stream that stops before it finished as a failure", async () => {
    // Resolving with the partial text would record a truncated reply as though
    // the agent had finished speaking — an answer the customer cannot tell from
    // a complete one.
    const { adapter } = makeAdapter(sseResponse([frame("delta", { text: "half a sen" })]));
    await expect(adapter.sendTurn(turn, () => {})).rejects.toBeInstanceOf(HarnessError);
    // Nothing was threaded: no turn completed.
    expect(adapter.threadedSessionId).toBe("");
  });

  it("raises what the stream reported rather than a generic failure", async () => {
    const { adapter } = makeAdapter(
      sseResponse([frame("delta", { text: "…" }), frame("error", { error: "the provider is rate limiting" })]),
    );
    await expect(adapter.sendTurn(turn, () => {})).rejects.toThrow("the provider is rate limiting");
  });

  it("asks to be streamed to only when the box can and the caller is listening", async () => {
    // Two halves, and neither on its own. Asking on a box that cannot stream
    // costs nothing (the route answers JSON), but asking with no listener would
    // hold the whole turn open for events nobody reads.
    const streamable = makeAdapter(sseResponse([frame("done", { text: "ok", harness: "hermes" })]));
    await streamable.adapter.sendTurn(turn, () => {});
    expect(streamable.requests[0].headers.Accept).toBe("text/event-stream");

    const noListener = makeAdapter(jsonResponse({ text: "ok", harness: "hermes" }));
    await noListener.adapter.sendTurn(turn);
    expect(noListener.requests[0].headers.Accept).toBeUndefined();

    const cannotStream = makeAdapter(jsonResponse({ text: "ok", harness: "hermes" }), BLOCKING_CAPS);
    await cannotStream.adapter.sendTurn(turn, () => {});
    expect(cannotStream.requests[0].headers.Accept).toBeUndefined();
  });

  it("reads a STREAMED answer even when the caller passed no listener", async () => {
    // The mirror of the case above, and the one nothing covered: the adapter
    // only ASKS for a stream when someone is listening, but the route is free
    // to answer with one anyway — a proxy that upgrades the response, or a
    // version skew between the two halves of an upgrade. With no `onEvent` to
    // call, the body still has to be drained into a reply; the alternative is a
    // turn that ran, cost the box a full agent invocation, and rendered blank.
    const { adapter } = makeAdapter(
      sseResponse([frame("done", { text: "streamed anyway", harness: "hermes" })]),
    );
    const result = await adapter.sendTurn(turn);
    expect(result.text).toBe("streamed anyway");
  });

  it("reads a JSON answer to a streaming request, because the route may fall back", async () => {
    // The route tries the dashboard and spawns the CLI when it cannot reach it,
    // so a turn that ASKED for a stream can still be answered with one body.
    // The content type decides, not the request — anything else would make a
    // perfectly good answer unreadable exactly when the fast path is down.
    const { adapter } = makeAdapter(
      jsonResponse({ text: "spawned instead", harness: "hermes", sessionId: "20260823_190508_ce85d3" }),
    );
    const seen: TurnEvent[] = [];
    const result = await adapter.sendTurn(turn, (e) => seen.push(e));
    expect(result.text).toBe("spawned instead");
    expect(seen).toEqual([]);
    expect(adapter.threadedSessionId).toBe("20260823_190508_ce85d3");
  });
});
