/**
 * The box's Messages-API route for `local` coding runs (TASK-2501 PR-E,
 * src/lib/local-anthropic-route.ts), end to end over a stand-in engine:
 * who may call it, that it asks the box's engine alone and with the box's
 * key, that a streamed answer comes back as Anthropic's events, and that every
 * way the engine can fail reaches Claude Code in a status it acts on.
 */
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalEngine } from "@/lib/local-engine";

const resolveLocalEngine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-engine")>()),
  resolveLocalEngine,
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "0123456789abcdef0123456789abcdef" }));

import {
  handleLocalCountTokens,
  handleLocalMessages,
  handleLocalModels,
  localCodingEngine,
  localCodingToken,
  MIN_LOCAL_CODING_CONTEXT_TOKENS,
  NO_ENGINE_ERROR,
  verifyLocalCodingRequest,
} from "@/lib/local-anthropic-route";

const ENGINE: LocalEngine = {
  kind: "clawext",
  model: "dsv41-flash",
  modelRef: "clawext/dsv41-flash",
  chatUrl: "http://192.0.2.9:8899/v1/chat/completions",
  authorization: "Bearer engine-secret-key",
  contextTokens: 1_000_000,
  maxOutputTokens: 32_000,
  parallel: 1,
  imageInput: false,
};

const BASE = "http://127.0.0.1/setup-api/local-ai/anthropic/v1";

function post(path: string, body: unknown, token: string | null = localCodingToken(), header: "authorization" | "x-api-key" = "authorization"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers[header] = header === "authorization" ? `Bearer ${token}` : token;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function sseBody(payloads: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  // Split mid-line on purpose: an engine's chunks do not respect event borders.
  const text = payloads.map((p) => `data: ${p}\n\n`).join("");
  const pieces = [text.slice(0, 17), text.slice(17, 90), text.slice(90)];
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) if (p) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

function parseEvents(text: string): Array<[string, Record<string, unknown>]> {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const [ev, data] = block.split("\n");
    return [ev.replace(/^event: /, ""), JSON.parse(data.replace(/^data: /, "")) as Record<string, unknown>];
  });
}

beforeEach(() => {
  resolveLocalEngine.mockReset().mockResolvedValue(ENGINE);
});

describe("the local coding token", () => {
  it("is an HMAC of the Local AI token, the value scripts/claude-ds derives too", () => {
    const expected = "clawbox-local-" + crypto.createHmac("sha256", "0123456789abcdef0123456789abcdef").update("clawbox local coding route v1").digest("hex");
    expect(localCodingToken()).toBe(expected);
    // It is not the Local AI token: the Local AI proxy does not open with it.
    expect(localCodingToken()).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("opens the route as a Bearer or as x-api-key, and nothing else does", () => {
    expect(verifyLocalCodingRequest(new Headers({ authorization: `Bearer ${localCodingToken()}` }))).toBe(true);
    expect(verifyLocalCodingRequest(new Headers({ "x-api-key": localCodingToken() }))).toBe(true);
    expect(verifyLocalCodingRequest(new Headers({ authorization: "Bearer 0123456789abcdef0123456789abcdef" }))).toBe(false);
    expect(verifyLocalCodingRequest(new Headers({ authorization: `Bearer ${localCodingToken()}x` }))).toBe(false);
    expect(verifyLocalCodingRequest(new Headers())).toBe(false);
  });
});

describe("which engine a local run may use", () => {
  it("is the box's engine, refused in words when there is none or its window is too small", async () => {
    expect(await localCodingEngine()).toEqual({ ok: true, engine: ENGINE });
    resolveLocalEngine.mockResolvedValue(null);
    expect(await localCodingEngine()).toEqual({ ok: false, error: NO_ENGINE_ERROR });
    resolveLocalEngine.mockResolvedValue({ ...ENGINE, contextTokens: 32_768 });
    const small = await localCodingEngine();
    expect(small.ok).toBe(false);
    expect(!small.ok && small.error).toMatch(/32,768 tokens.*at least 64,000/);
    resolveLocalEngine.mockResolvedValue({ ...ENGINE, contextTokens: MIN_LOCAL_CODING_CONTEXT_TOKENS });
    expect((await localCodingEngine()).ok).toBe(true);
    resolveLocalEngine.mockRejectedValue(new Error("store unreadable"));
    expect((await localCodingEngine()).ok).toBe(false);
  });
});

describe("POST /v1/messages", () => {
  it("refuses a caller without the token, and asks nothing", async () => {
    const fetchImpl = vi.fn();
    for (const req of [post("/messages", { messages: [] }, null), post("/messages", { messages: [] }, "wrong")]) {
      const res = await handleLocalMessages(req, { fetchImpl });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says there is no engine as a request error Claude Code does not retry", async () => {
    resolveLocalEngine.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    const res = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(NO_ENGINE_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a request", async () => {
    const res = await handleLocalMessages(new Request(`${BASE}/messages`, { method: "POST", headers: { "x-api-key": localCodingToken() }, body: "not json" }));
    expect(res.status).toBe(400);
    const empty = await handleLocalMessages(post("/messages", { messages: [] }), { fetchImpl: vi.fn() });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.message).toMatch(/at least one message/);
    // A message with no content is refused as a request, not thrown on.
    const engine = vi.fn();
    const nothing = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: null }] }), { fetchImpl: engine });
    expect(nothing.status).toBe(400);
    expect((await nothing.json()).error).toMatchObject({ type: "invalid_request_error", message: expect.stringMatching(/string or a list of blocks/) });
    expect(engine).not.toHaveBeenCalled();
  });

  it("asks the box's engine, with the box's key and the engine's model, and answers a whole message", async () => {
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      id: "x1",
      choices: [{ message: { content: "Done." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await handleLocalMessages(post("/messages", { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Fix it" }] }, localCodingToken(), "x-api-key"), { fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "message", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 3 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENGINE.chatUrl);
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer engine-secret-key");
    expect(init!.redirect).toBe("manual");
    const sent = JSON.parse(String(init!.body));
    expect(sent).toMatchObject({ model: "dsv41-flash", max_tokens: 100, stream: false });
    // An External engine is sent no thinking field it may not know.
    expect(sent.reasoning_effort).toBeUndefined();
  });

  it("asks the box's own runtimes for no thinking", async () => {
    resolveLocalEngine.mockResolvedValue({ ...ENGINE, kind: "llamacpp", chatUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1/chat/completions", authorization: "Bearer local-ai-token", contextTokens: 131_072 });
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }));
    await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).reasoning_effort).toBe("none");
  });

  it("streams the engine's answer back as Anthropic's events, tool call and all", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseBody([
      JSON.stringify({ choices: [{ delta: { content: "Editing " } }] }),
      JSON.stringify({ choices: [{ delta: { content: "now." } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Write", arguments: "{\"file_path\":\"a.js\"," } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"content\":\"x\"}" } }] }, finish_reason: "tool_calls" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 25 } }),
      "[DONE]",
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "x" }], tools: [{ name: "Write", input_schema: { type: "object" } }] }), { fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const evs = parseEvents(await res.text());
    expect(evs[0][0]).toBe("message_start");
    expect(evs.filter(([e, d]) => e === "content_block_delta" && (d.delta as { type: string }).type === "text_delta").map(([, d]) => (d.delta as { text: string }).text).join("")).toBe("Editing now.");
    const tool = evs.find(([e, d]) => e === "content_block_start" && (d.content_block as { type: string }).type === "tool_use");
    expect(tool![1]).toMatchObject({ content_block: { id: "call_1", name: "Write" } });
    const input = evs.find(([e, d]) => e === "content_block_delta" && (d.delta as { type: string }).type === "input_json_delta");
    expect(JSON.parse((input![1].delta as { partial_json: string }).partial_json)).toEqual({ file_path: "a.js", content: "x" });
    expect(evs.find(([e]) => e === "message_delta")![1]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 900, output_tokens: 25 } });
    expect(evs.at(-1)![0]).toBe("message_stop");
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it("replays a whole answer as events for an engine that does not stream", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    const evs = parseEvents(await res.text());
    expect(evs.map(([e]) => e)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("ends a stream with Anthropic's error event when the engine fails inside it", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseBody([
      JSON.stringify({ choices: [{ delta: { content: "Part" } }] }),
      JSON.stringify({ error: { message: "engine crashed" } }),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    const evs = parseEvents(await res.text());
    expect(evs.at(-1)).toEqual(["error", { type: "error", error: { type: "api_error", message: "The box's engine failed mid-answer: engine crashed" } }]);
    expect(evs.some(([e]) => e === "message_stop")).toBe(false);
  });

  it("says so when the engine's stream ends with nothing in it", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseBody(["[DONE]"]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(parseEvents(await res.text()).at(-1)![1]).toMatchObject({ error: { message: expect.stringMatching(/before saying anything/) } });
  });

  // One network chunk per SSE event, the way an engine writes them. The
  // finish-only delta and `[DONE]` make no event of their own, and a pull that
  // passes nothing on is not called again while the reader waits: the stream
  // has to keep reading through them, or the run hangs on a finished answer.
  it("keeps reading through chunks that make no event, to the end of the answer", async () => {
    const enc = new TextEncoder();
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: "Done." } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ].map((p) => enc.encode(`data: ${p}\n\n`));
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = frames.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    const evs = parseEvents(await res.text());
    expect(evs.map(([e]) => e)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(evs.at(-2)![1]).toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  it("ends with an error, and lets go of the engine, when it streams a line that never ends", async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode("x".repeat(256 * 1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    const evs = parseEvents(await res.text());
    expect(evs.at(-1)![0]).toBe("error");
    expect(String((evs.at(-1)![1] as { error: { message: string } }).error.message)).toMatch(/^The box's engine stopped answering: the engine sent a line longer than/);
    expect(cancelled).toBe(true);
  });

  it("passes on an answer the engine cut off as a failure, never as a whole message", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseBody([
      JSON.stringify({ choices: [{ delta: { content: "Half of an ans" } }] }),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await handleLocalMessages(post("/messages", { stream: true, messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    const evs = parseEvents(await res.text());
    expect(evs.at(-1)).toEqual(["error", { type: "error", error: { type: "api_error", message: "The box's engine stopped before finishing its answer." } }]);
    expect(evs.some(([e]) => e === "message_stop")).toBe(false);
  });

  it("maps the engine's refusal — a conversation too long reaches Claude Code as the one it compacts on", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "This model's maximum context length is 131072 tokens." } }), { status: 400 }));
    const res = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/^prompt is too long/);
  });

  it("never hands the run the engine's own 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const res = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(res.status).toBe(502);
  });

  it("answers a 503 Claude Code retries when the engine cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const res = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toMatch(/did not answer/);
    // The log names the engine kind, never its key or its address.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/engine-secret-key|192\.0\.2\.9/);
    warn.mockRestore();
  });

  it("refuses an answer that is not a chat completion", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>proxy page</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl });
    expect(res.status).toBe(502);
    const notChat = vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    expect((await handleLocalMessages(post("/messages", { messages: [{ role: "user", content: "x" }] }), { fetchImpl: notChat })).status).toBe(502);
  });
});

describe("the optional endpoints", () => {
  it("estimates tokens conservatively, behind the token", async () => {
    const res = await handleLocalCountTokens(post("/messages/count_tokens", { system: "s", messages: [{ role: "user", content: "x".repeat(250) }] }));
    expect(res.status).toBe(200);
    const { input_tokens } = await res.json();
    expect(input_tokens).toBeGreaterThanOrEqual(100);
    expect((await handleLocalCountTokens(post("/messages/count_tokens", {}, null))).status).toBe(401);
  });

  it("lists the engine's one model with its window and longest answer, which the wrapper reads", async () => {
    const res = await handleLocalModels(new Request(`${BASE}/models`, { headers: { authorization: `Bearer ${localCodingToken()}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ type: "model", id: "dsv41-flash", display_name: "dsv41-flash", created_at: "1970-01-01T00:00:00Z", clawbox: { engine: "clawext", context_tokens: 1_000_000, max_output_tokens: 32_000 } }],
      has_more: false,
      first_id: "dsv41-flash",
      last_id: "dsv41-flash",
    });
    resolveLocalEngine.mockResolvedValue(null);
    expect((await handleLocalModels(new Request(`${BASE}/models`, { headers: { authorization: `Bearer ${localCodingToken()}` } }))).status).toBe(400);
  });
});
