/**
 * Anthropic's Messages API spoken over the box's own engine (TASK-2501 PR-E):
 * the translation between what Claude Code sends — `/v1/messages`, streamed,
 * with tools — and what every engine the box can hold serves — OpenAI's
 * `/chat/completions` (an External engine: vLLM, SGLang, llama.cpp; Local AI's
 * llama.cpp and Ollama through the Local AI proxy).
 *
 * PURE ON PURPOSE: no fs, no fetch, no store. The route
 * (`local-anthropic-route.ts`) resolves the engine, holds its key and does the
 * I/O; everything here is a function of its arguments, so each mapping is
 * pinned by a unit test without a server.
 *
 * WHAT IS LEFT OUT, deliberately:
 *  - Thinking. A `thinking` request is not passed on, a `thinking` block in
 *    the history is dropped, and an engine's `reasoning_content` never becomes
 *    a thinking block: the engines this serves either cannot think or are run
 *    with thinking off (the External engine record has no reasoning option yet),
 *    and a thinking block Claude Code cannot verify is one it refuses.
 *  - Anthropic's server tools (web search, web fetch, code execution): they run
 *    on Anthropic's side, which this route never reaches. A tool with a
 *    `type` other than `custom` is dropped from the list.
 *  - Prompt caching: `cache_control` is ignored; usage reports no cache reads.
 */

/** One Anthropic content block, as far as this translator reads it. */
export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: unknown;
}

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type?: string; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: unknown;
  metadata?: unknown;
}

/** What the translation needs to know about the engine. */
export interface EngineTarget {
  /** The model id the engine serves; every request names it, whatever Claude Code asked for. */
  model: string;
  /** The longest answer the engine is asked for. */
  maxOutputTokens: number;
  /** Whether a picture may be sent on (an engine that cannot see gets a sentence instead). */
  imageInput: boolean;
  /** Ask the box's own runtimes for no thinking (`reasoning_effort: none`); an External engine is sent no such field. */
  thinkingOffField: boolean;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type TranslatedRequest = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Said instead of a picture the engine cannot look at. */
export const PICTURE_NOT_SEEN = "[A picture was attached here. The box's engine cannot look at pictures, so it was left out.]";

/** The most stop sequences an OpenAI-compatible server is asked to honour. */
const MAX_STOP_SEQUENCES = 4;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as AnthropicBlock).type === "text" ? String((b as AnthropicBlock).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** A tool result's content as the one string a `tool` message carries. */
function toolResultText(block: AnthropicBlock): string {
  const parts: string[] = [];
  if (typeof block.content === "string") parts.push(block.content);
  else if (Array.isArray(block.content)) {
    for (const b of block.content as AnthropicBlock[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push(PICTURE_NOT_SEEN);
    }
  }
  const text = parts.join("\n");
  // An OpenAI tool message has no error flag: the words carry it.
  return block.is_error === true ? `Error: ${text || "the tool failed"}` : text;
}

function imagePart(block: AnthropicBlock, target: EngineTarget): { type: "image_url"; image_url: { url: string } } | null {
  if (!target.imageInput) return null;
  const s = block.source;
  if (!s) return null;
  if (s.type === "base64" && typeof s.data === "string" && typeof s.media_type === "string") {
    return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  }
  if (s.type === "url" && typeof s.url === "string") return { type: "image_url", image_url: { url: s.url } };
  return null;
}

function userMessages(content: string | AnthropicBlock[], target: EngineTarget): ChatMessage[] {
  if (typeof content === "string") return [{ role: "user", content }];
  const out: ChatMessage[] = [];
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_result") {
      // An OpenAI `tool` message must follow the assistant turn that called
      // it, before any user text: every result comes first, in its order.
      out.push({ role: "tool", tool_call_id: String(block.tool_use_id ?? ""), content: toolResultText(block) });
    } else if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const image = imagePart(block, target);
      parts.push(image ?? { type: "text", text: PICTURE_NOT_SEEN });
    } else if (block.type === "document") {
      const text = block.source && typeof (block.source as { data?: unknown }).data === "string" && block.source.type === "text"
        ? String(block.source.data)
        : textOf(block.content);
      if (text) parts.push({ type: "text", text });
    }
    // thinking, redacted_thinking and anything unknown: not for the engine.
  }
  if (parts.length > 0) {
    const allText = parts.every((p) => p.type === "text");
    out.push({
      role: "user",
      content: allText ? parts.map((p) => (p as { text: string }).text).join("\n") : parts,
    });
  }
  return out;
}

function assistantMessage(content: string | AnthropicBlock[]): ChatMessage | null {
  if (typeof content === "string") return content ? { role: "assistant", content } : null;
  const texts: string[] = [];
  const calls: ChatToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) texts.push(block.text);
    else if (block.type === "tool_use") {
      calls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  if (texts.length === 0 && calls.length === 0) return null;
  return {
    role: "assistant",
    content: texts.length > 0 ? texts.join("\n") : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

/** Is this a tool the engine can be handed — one Claude Code runs itself? */
function isClientTool(tool: AnthropicTool): boolean {
  return !!tool && typeof tool.name === "string" && tool.name !== "" && (tool.type === undefined || tool.type === "custom");
}

/**
 * An Anthropic Messages request as the Chat Completions body the engine is
 * sent. The model is always the engine's: Claude Code names the slot it filled
 * (`ANTHROPIC_MODEL`, the haiku slot, a sub-agent's alias), and every slot is
 * the one model the engine serves.
 */
export function anthropicToChat(req: AnthropicRequest, target: EngineTarget): TranslatedRequest {
  if (!req || typeof req !== "object") return { ok: false, error: "The request body must be a JSON object." };
  if (!Array.isArray(req.messages) || req.messages.length === 0) return { ok: false, error: "messages: at least one message is required." };
  const messages: ChatMessage[] = [];
  const system = textOf(req.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of req.messages) {
    if (!m || typeof m !== "object") return { ok: false, error: "messages: every message must be an object." };
    if (m.role === "user") messages.push(...userMessages(m.content, target));
    else if (m.role === "assistant") {
      const a = assistantMessage(m.content);
      if (a) messages.push(a);
    } else return { ok: false, error: `messages: unknown role ${JSON.stringify(m.role)}.` };
  }
  const requested = typeof req.max_tokens === "number" && Number.isFinite(req.max_tokens) && req.max_tokens > 0 ? Math.floor(req.max_tokens) : target.maxOutputTokens;
  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    max_tokens: Math.max(1, Math.min(requested, target.maxOutputTokens)),
  };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences)) {
    const stop = req.stop_sequences.filter((s) => typeof s === "string" && s !== "").slice(0, MAX_STOP_SEQUENCES);
    if (stop.length > 0) body.stop = stop;
  }
  const tools = Array.isArray(req.tools) ? req.tools.filter(isClientTool) : [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    }));
    const choice = req.tool_choice?.type;
    if (choice === "any") body.tool_choice = "required";
    else if (choice === "none") body.tool_choice = "none";
    else if (choice === "tool" && typeof req.tool_choice?.name === "string") body.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
    else if (choice === "auto") body.tool_choice = "auto";
  }
  if (req.stream === true) {
    body.stream = true;
    // The engine's count arrives in a last chunk only when asked for.
    body.stream_options = { include_usage: true };
  } else body.stream = false;
  if (target.thinkingOffField) body.reasoning_effort = "none";
  return { ok: true, body };
}

// ─── The answer back ─────────────────────────────────────────────────────────

export type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";

/** An engine's finish reason in Anthropic's words. */
export function stopReasonFrom(finish: unknown, hadToolCalls: boolean): AnthropicStopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call" || hadToolCalls) return "tool_use";
  return "end_turn";
}

/** A tool call's arguments as the object a `tool_use` block's input must be. */
export function toolInputFrom(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== "string" || args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  // Kept, not dropped: Claude Code checks the input against the tool's schema
  // and answers the model with what was wrong, which is how it corrects itself.
  return { invalid_arguments: String(args).slice(0, 4_000) };
}

let idCounter = 0;
/** A fresh id in Anthropic's shape. Unique within the process; nothing depends on it beyond that. */
export function freshId(prefix: "msg" | "toolu"): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_local${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function usageFrom(u: ChatUsage | undefined | null): { input_tokens: number; output_tokens: number } {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { input_tokens: n(u?.prompt_tokens), output_tokens: n(u?.completion_tokens) };
}

/** A whole (non-streamed) Chat Completions answer as an Anthropic message. */
export function chatToAnthropic(chat: unknown, requestedModel: string): Record<string, unknown> {
  const c = (chat && typeof chat === "object" ? chat : {}) as {
    id?: unknown;
    choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> }; finish_reason?: unknown }>;
    usage?: ChatUsage;
  };
  const choice = Array.isArray(c.choices) ? c.choices[0] : undefined;
  const content: Array<Record<string, unknown>> = [];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  for (const call of calls) {
    const name = typeof call?.function?.name === "string" ? call.function.name : "";
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : freshId("toolu"),
      name,
      input: toolInputFrom(call.function?.arguments),
    });
  }
  const hadToolCalls = content.some((b) => b.type === "tool_use");
  // An empty answer is still a message: Anthropic's shape allows no content,
  // and Claude Code ends the turn on it rather than failing.
  return {
    id: typeof c.id === "string" && c.id ? `msg_${c.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}` : freshId("msg"),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReasonFrom(choice?.finish_reason, hadToolCalls),
    stop_sequence: null,
    usage: usageFrom(c.usage),
  };
}

/** One server-sent event, written the way Anthropic writes it. */
export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A whole Anthropic message replayed as the event stream a streaming client expects. */
export function messageAsEvents(message: Record<string, unknown>): string[] {
  const usage = (message.usage ?? { input_tokens: 0, output_tokens: 0 }) as { input_tokens: number; output_tokens: number };
  const out: string[] = [
    sse("message_start", {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } },
    }),
  ];
  const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      out.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }));
    } else {
      out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
      out.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }));
    }
    out.push(sse("content_block_stop", { type: "content_block_stop", index }));
  });
  out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }));
  out.push(sse("message_stop", { type: "message_stop" }));
  return out;
}

/**
 * Server-sent events off a byte stream, one `data:` payload at a time. Lines
 * may arrive split across chunks; a comment (`:`) and the other fields are
 * skipped. Multi-line `data:` fields are joined, as the spec says.
 */
export class SseDataDecoder {
  private buffer = "";
  private data: string[] = [];

  /** Feed text; answers every payload a blank line completed. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length > 0) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }

  /** What is left when the stream ends without a closing blank line. */
  end(): string[] {
    const out = this.push("\n\n");
    return out;
  }
}

/** Why a stream ended badly, as Anthropic's `error` event. */
export function errorEvent(type: AnthropicErrorType, message: string): string {
  return sse("error", { type: "error", error: { type, message } });
}

interface ChatChunk {
  id?: unknown;
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: ChatUsage | null;
  error?: unknown;
}

/**
 * A streamed Chat Completions answer turned into Anthropic's event stream, one
 * engine chunk at a time.
 *
 * Text is passed on as it arrives. Tool calls are GATHERED and written whole
 * when the answer ends: an engine sends a call's name and its arguments in
 * pieces, sometimes interleaved between calls, and Claude Code parses the
 * joined `input_json_delta`s of a block once at its end — a call sent on
 * piece by piece would turn an engine's half-written or broken JSON into a
 * parse failure inside Claude Code. Whole, each input is checked here first
 * (`toolInputFrom`).
 */
export class ChatToAnthropicStream {
  private started = false;
  private index = 0;
  private textOpen = false;
  private finish: unknown = null;
  private usage = { input_tokens: 0, output_tokens: 0 };
  private calls = new Map<number, { id: string; name: string; args: string }>();
  private failed: string | null = null;
  private readonly id: string;

  constructor(private readonly requestedModel: string) {
    this.id = freshId("msg");
  }

  private start(): string[] {
    if (this.started) return [];
    this.started = true;
    return [
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }

  /** Did the engine say, inside its stream, that it failed? */
  get error(): string | null {
    return this.failed;
  }

  /** Has the engine sent any chunk of an answer yet? */
  get answered(): boolean {
    return this.started;
  }

  /** One `data:` payload from the engine; answers the events it makes. */
  push(payload: string): string[] {
    if (payload.trim() === "[DONE]") return [];
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      return [];
    }
    if (!chunk || typeof chunk !== "object") return [];
    if (chunk.error) {
      const e = chunk.error as { message?: unknown };
      this.failed = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "the engine failed mid-answer";
      return [];
    }
    const out = this.start();
    if (chunk.usage) {
      const u = usageFrom(chunk.usage);
      this.usage = { input_tokens: u.input_tokens || this.usage.input_tokens, output_tokens: u.output_tokens || this.usage.output_tokens };
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      if (!this.textOpen) {
        out.push(sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } }));
        this.textOpen = true;
      }
      out.push(sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: delta.content } }));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const at = typeof tc?.index === "number" ? tc.index : this.calls.size;
        const call = this.calls.get(at) ?? { id: "", name: "", args: "" };
        if (typeof tc?.id === "string" && tc.id) call.id = tc.id;
        if (typeof tc?.function?.name === "string") call.name += tc.function.name;
        if (typeof tc?.function?.arguments === "string") call.args += tc.function.arguments;
        else if (tc?.function?.arguments && typeof tc.function.arguments === "object") call.args = JSON.stringify(tc.function.arguments);
        this.calls.set(at, call);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.finish = choice.finish_reason;
    return out;
  }

  /** The events that close the message: the gathered tool calls, the stop reason, the count. */
  end(): string[] {
    const out = this.start();
    if (this.textOpen) {
      out.push(sse("content_block_stop", { type: "content_block_stop", index: this.index }));
      this.index += 1;
      this.textOpen = false;
    }
    let calls = 0;
    for (const at of [...this.calls.keys()].sort((a, b) => a - b)) {
      const call = this.calls.get(at)!;
      if (!call.name) continue;
      calls += 1;
      const id = call.id || freshId("toolu");
      out.push(sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id, name: call.name, input: {} } }));
      out.push(sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInputFrom(call.args)) } }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index: this.index }));
      this.index += 1;
    }
    out.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReasonFrom(this.finish, calls > 0), stop_sequence: null },
      usage: this.usage,
    }));
    out.push(sse("message_stop", { type: "message_stop" }));
    return out;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface AnthropicError {
  status: number;
  body: { type: "error"; error: { type: AnthropicErrorType; message: string } };
}

export function anthropicError(status: number, type: AnthropicErrorType, message: string): AnthropicError {
  return { status, body: { type: "error", error: { type, message } } };
}

/**
 * The engine's own refusals that mean "the conversation no longer fits": vLLM
 * and SGLang ("maximum context length"), llama.cpp ("exceeds the available
 * context size"), Ollama and others ("too long", "too many tokens").
 */
const TOO_LONG_RE = /maximum context length|context (?:length|size|window)|too long|too many tokens|exceeds? the (?:available|max)/i;

/** How much of an engine's error body is quoted back. Enough for its sentence, never a page. */
export const ENGINE_ERROR_QUOTE_CHARS = 300;

/** The words out of an engine's error body, shortened. */
export function engineErrorWords(raw: string): string {
  let words = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; detail?: unknown };
    const e = parsed?.error as { message?: unknown } | string | undefined;
    const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof parsed?.message === "string" ? parsed.message : typeof parsed?.detail === "string" ? parsed.detail : null;
    if (msg) words = msg;
  } catch {
    // not JSON: the text itself
  }
  words = words.replace(/\s+/g, " ").trim();
  return words.length > ENGINE_ERROR_QUOTE_CHARS ? `${words.slice(0, ENGINE_ERROR_QUOTE_CHARS)}…` : words;
}

/**
 * An engine's non-OK answer in Anthropic's terms, chosen for what Claude Code
 * does with each:
 *  - a conversation too long → 400 "prompt is too long", the one refusal
 *    Claude Code answers by compacting and asking again;
 *  - another 4xx from the engine → 400, quoting the engine (retrying cannot help);
 *  - the engine refusing the box's own key (401/403) → 502: the run's
 *    credential is fine, and a 401 would have Claude Code tell the owner to
 *    sign in again;
 *  - 429 → 429 and 503 → 529, both of which Claude Code waits out;
 *  - any other 5xx → 502.
 */
export function engineFailure(status: number, rawBody: string): AnthropicError {
  const words = engineErrorWords(rawBody) || `HTTP ${status}`;
  if (status === 429) return anthropicError(429, "rate_limit_error", `The box's engine is busy: ${words}`);
  if (status === 503) return anthropicError(529, "overloaded_error", `The box's engine is overloaded: ${words}`);
  if (status === 401 || status === 403) {
    return anthropicError(502, "api_error", `The box's engine refused the key the box holds for it (HTTP ${status}). Check the engine in Settings → Local AI.`);
  }
  if (status === 404) {
    return anthropicError(502, "api_error", `The box's engine has no chat completions endpoint for its model (HTTP 404): ${words}`);
  }
  if (status >= 400 && status < 500) {
    if (TOO_LONG_RE.test(words)) return anthropicError(400, "invalid_request_error", `prompt is too long: ${words}`);
    return anthropicError(400, "invalid_request_error", `The box's engine refused the request (HTTP ${status}): ${words}`);
  }
  return anthropicError(502, "api_error", `The box's engine failed (HTTP ${status}): ${words}`);
}
