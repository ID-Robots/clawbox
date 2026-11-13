/**
 * `/setup-api/local-ai/anthropic/v1/*` — Claude Code's Messages API on the
 * box's own engine (TASK-2501 PR-E), for coding runs on the `local` provider.
 *
 * WHO MAY CALL: a coding run (and a terminal `claude-ds` on `local`) presents
 * the box's LOCAL CODING TOKEN, derived from the Local AI token
 * (`localCodingToken`). The route is loopback service-to-service like the
 * Local AI proxy beside it, so middleware lets it through without a session
 * cookie and this module checks the bearer itself.
 *
 * WHERE IT GOES: only to the engine `resolveLocalEngine()` names — the
 * owner's External engine, or Local AI's llama.cpp / Ollama through the Local
 * AI proxy, which wakes the runtime and holds its lease for the length of the
 * answer. Never to ClawBox AI, never to Anthropic: there is no other address
 * in this module. With no engine set up the route says so and asks nothing.
 *
 * THE ENGINE'S KEY never leaves the server: the engine is asked with the key
 * the box holds for it (`LocalEngine.authorization`), and the run only ever
 * holds the derived token, which opens this route and nothing else.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { resolveLocalEngine, type LocalEngine } from "@/lib/local-engine";
import {
  anthropicError,
  anthropicToChat,
  chatToAnthropic,
  ChatToAnthropicStream,
  engineFailure,
  errorEvent,
  messageAsEvents,
  SseDataDecoder,
  type AnthropicError,
  type AnthropicRequest,
} from "@/lib/local-anthropic";
import { estimateTokens } from "@/lib/token-estimate";

/** What the token is derived for: a change here retires every token handed out before. */
const LOCAL_CODING_TOKEN_CONTEXT = "clawbox local coding route v1";
const LOCAL_CODING_TOKEN_PREFIX = "clawbox-local-";

/**
 * The bearer a coding run presents to this route: an HMAC of the Local AI
 * token, so it is stable across restarts, needs no file of its own, and opens
 * this route only — the Local AI proxy does not accept it. `scripts/claude-ds`
 * derives the same value from the same file for a terminal session.
 */
export function localCodingToken(): string {
  const mac = crypto.createHmac("sha256", getLocalAiToken()).update(LOCAL_CODING_TOKEN_CONTEXT).digest("hex");
  return `${LOCAL_CODING_TOKEN_PREFIX}${mac}`;
}

/** Does the request carry the local coding token, as a Bearer or as `x-api-key`? */
export function verifyLocalCodingRequest(headers: Headers): boolean {
  const expected = Buffer.from(localCodingToken());
  const candidates: string[] = [];
  const auth = headers.get("authorization");
  const bearer = auth ? /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() : undefined;
  if (bearer) candidates.push(bearer);
  const apiKey = headers.get("x-api-key")?.trim();
  if (apiKey) candidates.push(apiKey);
  return candidates.some((c) => {
    const presented = Buffer.from(c);
    return presented.byteLength === expected.byteLength && crypto.timingSafeEqual(presented, expected);
  });
}

/**
 * The smallest window a Claude Code run can work in: its system prompt and
 * tool list alone take tens of thousands of tokens, and it compacts about 33k
 * below the window it is given — under this, every turn would compact. The
 * same floor Hermes keeps for a session (`HERMES_MIN_CONTEXT_WINDOW`).
 */
export const MIN_LOCAL_CODING_CONTEXT_TOKENS = 64_000;

export const NO_ENGINE_ERROR =
  "No engine is set up on this box for local coding runs. Choose an External engine (or switch Local AI on) in Settings → Local AI.";

export function windowTooSmallError(contextTokens: number): string {
  return `The box's engine has a window of ${contextTokens.toLocaleString("en-US")} tokens; a Claude Code run needs at least ${MIN_LOCAL_CODING_CONTEXT_TOKENS.toLocaleString("en-US")}. Raise the engine's context window in Settings → Local AI, or use an engine with a larger one.`;
}

/** The engine a local coding run would use right now, or why there is none. Never throws. */
export async function localCodingEngine(): Promise<{ ok: true; engine: LocalEngine } | { ok: false; error: string }> {
  const engine = await resolveLocalEngine().catch(() => null);
  if (!engine) return { ok: false, error: NO_ENGINE_ERROR };
  if (engine.contextTokens < MIN_LOCAL_CODING_CONTEXT_TOKENS) return { ok: false, error: windowTooSmallError(engine.contextTokens) };
  return { ok: true, engine };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(e: AnthropicError): Response {
  return json(e.status, e.body);
}

async function guard(request: Request): Promise<{ ok: true; engine: LocalEngine } | { ok: false; response: Response }> {
  if (!verifyLocalCodingRequest(request.headers)) {
    return { ok: false, response: fail(anthropicError(401, "authentication_error", "The local coding token is required.")) };
  }
  const resolved = await localCodingEngine();
  // 400, not 5xx: nothing will change by asking again, and Claude Code retries a 5xx.
  if (!resolved.ok) return { ok: false, response: fail(anthropicError(400, "invalid_request_error", resolved.error)) };
  return { ok: true, engine: resolved.engine };
}

async function readRequest(request: Request): Promise<AnthropicRequest | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AnthropicRequest) : null;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

/** The engine's event stream, translated as it arrives. */
function translatedStream(upstream: ReadableStream<Uint8Array>, requestedModel: string): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDataDecoder();
  const out = new ChatToAnthropicStream(requestedModel);
  let closed = false;
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, tail: string[]) => {
    if (closed) return;
    closed = true;
    for (const e of tail) controller.enqueue(enc.encode(e));
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    // Reads until it has something to pass on or the stream is over: a pull
    // that enqueues nothing is not called again while the reader waits (the
    // Streams spec), and a chunk can make no event at all — half an SSE frame,
    // a finish-only delta, `[DONE]`.
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const rest = sse.end().flatMap((p) => out.push(p));
            for (const e of rest) controller.enqueue(enc.encode(e));
            if (out.error) finish(controller, [errorEvent("api_error", `The box's engine failed mid-answer: ${out.error}`)]);
            else if (!out.answered) finish(controller, [errorEvent("api_error", "The box's engine ended its answer before saying anything.")]);
            // Cut off: no finish_reason and no [DONE]. Passed on as a failure,
            // never closed as though the answer were whole.
            else if (!out.completed) finish(controller, [errorEvent("api_error", "The box's engine stopped before finishing its answer.")]);
            else finish(controller, out.end());
            return;
          }
          const events = sse.push(decoder.decode(value, { stream: true })).flatMap((p) => out.push(p));
          for (const e of events) controller.enqueue(enc.encode(e));
          if (out.error) {
            await reader.cancel().catch(() => {});
            finish(controller, [errorEvent("api_error", `The box's engine failed mid-answer: ${out.error}`)]);
            return;
          }
          if (events.length > 0) return;
        }
      } catch (err) {
        finish(controller, [errorEvent("api_error", `The box's engine stopped answering: ${err instanceof Error ? err.message : String(err)}`)]);
      }
    },
    async cancel(reason) {
      closed = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}

const STREAM_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };

/** POST /v1/messages */
export async function handleLocalMessages(request: Request, options: { fetchImpl?: typeof fetch } = {}): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;
  const { engine } = g;
  const req = await readRequest(request);
  if (!req) return fail(anthropicError(400, "invalid_request_error", "The request body must be a JSON object."));
  const translated = anthropicToChat(req, {
    model: engine.model,
    maxOutputTokens: engine.maxOutputTokens,
    imageInput: engine.imageInput === true,
    // The box's own runtimes are asked for no thinking, the way every other
    // feature on them is (local-engine.ts, postLocalChat); an External engine
    // is free to refuse a field it does not know, so it is sent none.
    thinkingOffField: engine.kind !== "clawext",
  });
  if (!translated.ok) return fail(anthropicError(400, "invalid_request_error", translated.error));
  const requestedModel = typeof req.model === "string" && req.model ? req.model : engine.model;
  const streaming = req.stream === true;

  let upstream: Response;
  try {
    upstream = await (options.fetchImpl ?? fetch)(engine.chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: engine.authorization, accept: streaming ? "text/event-stream" : "application/json" },
      body: JSON.stringify(translated.body),
      cache: "no-store",
      // Never followed: a redirect would resend the run's code to wherever it points.
      redirect: "manual",
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal.aborted) return fail(anthropicError(499, "api_error", "The request was cancelled."));
    console.warn(`[local-anthropic] the ${engine.kind} engine did not answer: ${err instanceof Error ? err.message : String(err)}`);
    return fail(anthropicError(503, "api_error", "The box's engine did not answer. Check that it is running (Settings → Local AI)."));
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    console.warn(`[local-anthropic] the ${engine.kind} engine answered HTTP ${upstream.status}`);
    return fail(engineFailure(upstream.status, raw));
  }

  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streaming && isStream && upstream.body) {
    return new Response(translatedStream(upstream.body, requestedModel), { status: 200, headers: STREAM_HEADERS });
  }

  // A whole answer: asked for one, or an engine that does not stream.
  let parsed: unknown;
  const raw = await upstream.text().catch(() => "");
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(anthropicError(502, "api_error", "The box's engine answered something that is not a chat completion."));
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { choices?: unknown }).choices)) {
    return fail(anthropicError(502, "api_error", "The box's engine answered something that is not a chat completion."));
  }
  const message = chatToAnthropic(parsed, requestedModel);
  if (!streaming) return json(200, message);
  return new Response(messageAsEvents(message).join(""), { status: 200, headers: STREAM_HEADERS });
}

/** POST /v1/messages/count_tokens — an estimate, the conservative one every local caller sizes by. */
export async function handleLocalCountTokens(request: Request): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;
  const req = await readRequest(request);
  if (!req) return fail(anthropicError(400, "invalid_request_error", "The request body must be a JSON object."));
  const text = JSON.stringify({ system: req.system ?? null, messages: req.messages ?? [], tools: req.tools ?? [] });
  return json(200, { input_tokens: estimateTokens(text) });
}

/**
 * GET /v1/models — the one model every slot answers on, with the engine's
 * window and longest answer beside it (`clawbox`), which a terminal
 * `claude-ds` reads to size its auto-compact window.
 */
export async function handleLocalModels(request: Request): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;
  const { engine } = g;
  const model = {
    type: "model",
    id: engine.model,
    display_name: engine.model,
    created_at: "1970-01-01T00:00:00Z",
    clawbox: { engine: engine.kind, context_tokens: engine.contextTokens, max_output_tokens: engine.maxOutputTokens },
  };
  return json(200, { data: [model], has_more: false, first_id: engine.model, last_id: engine.model });
}
