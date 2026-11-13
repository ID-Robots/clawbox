/**
 * The Messages ↔ Chat Completions translation a `local` coding run rides on
 * (TASK-2501 PR-E, src/lib/local-anthropic.ts). Pure: every mapping Claude
 * Code depends on is pinned here without a server — the request (system,
 * tools, tool results in the order OpenAI insists on, pictures, thinking
 * left out), the whole answer, the streamed answer (text as it arrives, tool
 * calls gathered whole, the engine's own mid-stream error), and the engine's
 * refusals in the statuses Claude Code acts on.
 */
import { describe, expect, it } from "vitest";
import {
  anthropicToChat,
  chatToAnthropic,
  ChatToAnthropicStream,
  engineErrorWords,
  engineFailure,
  ENGINE_ERROR_QUOTE_CHARS,
  messageAsEvents,
  PICTURE_NOT_SEEN,
  SseDataDecoder,
  stopReasonFrom,
  toolInputFrom,
  type EngineTarget,
} from "@/lib/local-anthropic";

const TARGET: EngineTarget = { model: "dsv41-flash", maxOutputTokens: 8_192, imageInput: false, thinkingOffField: false };

/** The events of a stream, parsed back: `[event, data]` pairs. */
function events(chunks: string[]): Array<[string, Record<string, unknown>]> {
  return chunks.join("").split("\n\n").filter(Boolean).map((block) => {
    const [ev, data] = block.split("\n");
    return [ev.replace(/^event: /, ""), JSON.parse(data.replace(/^data: /, "")) as Record<string, unknown>];
  });
}

describe("a Messages request as a Chat Completions body", () => {
  it("names the engine's model whatever slot Claude Code filled, and puts the system prompt first", () => {
    const out = anthropicToChat({
      model: "claude-haiku-5-5",
      max_tokens: 1_000,
      system: [{ type: "text", text: "You are a coder." }, { type: "text", text: "Be brief." }],
      messages: [{ role: "user", content: "Fix the bug." }],
    }, TARGET);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.model).toBe("dsv41-flash");
    expect(out.body.messages).toEqual([
      { role: "system", content: "You are a coder.\nBe brief." },
      { role: "user", content: "Fix the bug." },
    ]);
    expect(out.body.max_tokens).toBe(1_000);
    expect(out.body.stream).toBe(false);
  });

  it("never asks for more than the engine's longest answer", () => {
    const out = anthropicToChat({ max_tokens: 64_000, messages: [{ role: "user", content: "x" }] }, TARGET);
    expect(out.ok && out.body.max_tokens).toBe(8_192);
    const unnamed = anthropicToChat({ messages: [{ role: "user", content: "x" }] }, TARGET);
    expect(unnamed.ok && unnamed.body.max_tokens).toBe(8_192);
  });

  it("turns tool_use into tool_calls and puts every tool result right after them, before the user's words", () => {
    const out = anthropicToChat({
      messages: [
        { role: "user", content: "Run the tests." },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden" },
            { type: "text", text: "Running them." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
            { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.js" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Here you go." },
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "1 failing" }] },
            { type: "tool_result", tool_use_id: "toolu_2", content: "file body", is_error: true },
          ],
        },
      ],
    }, TARGET);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.messages).toEqual([
      { role: "user", content: "Run the tests." },
      {
        role: "assistant",
        content: "Running them.",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "npm test" }) } },
          { id: "toolu_2", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "a.js" }) } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "1 failing" },
      { role: "tool", tool_call_id: "toolu_2", content: "Error: file body" },
      { role: "user", content: "Here you go." },
    ]);
  });

  it("gives an assistant turn of tool calls alone no content", () => {
    const out = anthropicToChat({
      messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Glob", input: {} }] }],
    }, TARGET);
    expect(out.ok && (out.body.messages as Array<{ content: unknown }>)[1].content).toBeNull();
  });

  it("hands Claude Code's own tools to the engine as functions, and drops Anthropic's server tools", () => {
    const out = anthropicToChat({
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
        { type: "custom", name: "Edit", input_schema: { type: "object" } },
      ],
      tool_choice: { type: "auto" },
    }, TARGET);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.tools).toEqual([
      { type: "function", function: { name: "Bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } },
      { type: "function", function: { name: "Edit", parameters: { type: "object" } } },
    ]);
    expect(out.body.tool_choice).toBe("auto");
  });

  it("maps every tool_choice, and sends none with no tools left", () => {
    const body = (choice: Record<string, string>) => {
      const out = anthropicToChat({ messages: [{ role: "user", content: "x" }], tools: [{ name: "Bash", input_schema: {} }], tool_choice: choice }, TARGET);
      return out.ok ? out.body.tool_choice : "refused";
    };
    expect(body({ type: "any" })).toBe("required");
    expect(body({ type: "none" })).toBe("none");
    expect(body({ type: "tool", name: "Bash" })).toEqual({ type: "function", function: { name: "Bash" } });
    const serverOnly = anthropicToChat({ messages: [{ role: "user", content: "x" }], tools: [{ type: "web_fetch_20250910", name: "web_fetch" }], tool_choice: { type: "any" } }, TARGET);
    expect(serverOnly.ok && serverOnly.body.tools).toBeUndefined();
    expect(serverOnly.ok && serverOnly.body.tool_choice).toBeUndefined();
  });

  it("says a picture was left out when the engine cannot see, and sends it when it can", () => {
    const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const blind = anthropicToChat({ messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, picture] }] }, TARGET);
    expect(blind.ok && blind.body.messages).toEqual([{ role: "user", content: `What is this?\n${PICTURE_NOT_SEEN}` }]);
    const seeing = anthropicToChat({ messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, picture] }] }, { ...TARGET, imageInput: true });
    expect(seeing.ok && seeing.body.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    }]);
  });

  it("passes on no thinking request, and asks the box's own runtimes for none", () => {
    const external = anthropicToChat({ messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 4_000 } }, TARGET);
    expect(external.ok && external.body.thinking).toBeUndefined();
    expect(external.ok && external.body.reasoning_effort).toBeUndefined();
    const onBox = anthropicToChat({ messages: [{ role: "user", content: "x" }], thinking: { type: "enabled" } }, { ...TARGET, thinkingOffField: true });
    expect(onBox.ok && onBox.body.reasoning_effort).toBe("none");
  });

  it("streams with the engine's usage asked for, and carries sampling and stop sequences", () => {
    const out = anthropicToChat({
      messages: [{ role: "user", content: "x" }],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["a", "", "b", "c", "d", "e"],
    }, TARGET);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.stream).toBe(true);
    expect(out.body.stream_options).toEqual({ include_usage: true });
    expect(out.body.temperature).toBe(0.2);
    expect(out.body.top_p).toBe(0.9);
    expect(out.body.stop).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses a request it cannot translate, in words", () => {
    expect(anthropicToChat({ messages: [] }, TARGET)).toEqual({ ok: false, error: expect.stringMatching(/at least one message/) });
    expect(anthropicToChat({ messages: [{ role: "system" as never, content: "x" }] }, TARGET).ok).toBe(false);
  });
});

describe("a whole answer back as an Anthropic message", () => {
  it("carries the text, the tool calls and the count, under the model Claude Code asked for", () => {
    const msg = chatToAnthropic({
      id: "chatcmpl-1",
      choices: [{
        message: {
          content: "Fixing it.",
          reasoning_content: "never shown",
          tool_calls: [{ id: "call_9", function: { name: "Edit", arguments: "{\"file_path\":\"a.js\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }, "claude-sonnet-5-5");
    expect(msg).toMatchObject({
      id: "msg_chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [
        { type: "text", text: "Fixing it." },
        { type: "tool_use", id: "call_9", name: "Edit", input: { file_path: "a.js" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    expect(JSON.stringify(msg)).not.toContain("never shown");
  });

  it("reads the finish reasons Claude Code acts on", () => {
    expect(stopReasonFrom("length", false)).toBe("max_tokens");
    expect(stopReasonFrom("stop", false)).toBe("end_turn");
    expect(stopReasonFrom("stop", true)).toBe("tool_use");
    expect(stopReasonFrom(null, false)).toBe("end_turn");
  });

  it("keeps a tool call's broken arguments for Claude Code to answer, rather than inventing them", () => {
    expect(toolInputFrom("{\"a\":1}")).toEqual({ a: 1 });
    expect(toolInputFrom("")).toEqual({});
    expect(toolInputFrom({ already: "an object" })).toEqual({ already: "an object" });
    expect(toolInputFrom("[1,2]")).toEqual({ invalid_arguments: "[1,2]" });
    expect(toolInputFrom("{\"a\":")).toEqual({ invalid_arguments: "{\"a\":" });
  });

  it("is still a message when the engine said nothing, and gives a nameless call no block", () => {
    const msg = chatToAnthropic({ choices: [{ message: { content: "", tool_calls: [{ function: { arguments: "{}" } }] }, finish_reason: "stop" }] }, "m");
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(String(msg.id)).toMatch(/^msg_/);
  });

  it("replays as the event stream a streaming client expects", () => {
    const msg = chatToAnthropic({ choices: [{ message: { content: "Hi", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, "m");
    const evs = events(messageAsEvents(msg));
    expect(evs.map(([e]) => e)).toEqual([
      "message_start",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(evs[2][1]).toMatchObject({ index: 0, delta: { type: "text_delta", text: "Hi" } });
    expect(evs[4][1]).toMatchObject({ index: 1, content_block: { type: "tool_use", id: "c1", name: "Bash", input: {} } });
    expect(evs[5][1]).toMatchObject({ delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } });
    expect(evs[7][1]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 5, output_tokens: 2 } });
  });
});

describe("server-sent events off the engine", () => {
  it("joins lines split across chunks, reads CRLF, skips comments and other fields", () => {
    const d = new SseDataDecoder();
    expect(d.push(": keep-alive\n\nda")).toEqual([]);
    expect(d.push("ta: {\"a\":1}\r\nid: 7\r\n\r\ndata: [DO")).toEqual(["{\"a\":1}"]);
    expect(d.push("NE]\n\n")).toEqual(["[DONE]"]);
  });

  it("joins a multi-line data field, and hands back what is left at the end", () => {
    const d = new SseDataDecoder();
    expect(d.push("data: line one\ndata: line two\n\n")).toEqual(["line one\nline two"]);
    expect(d.push("data: tail")).toEqual([]);
    expect(d.end()).toEqual(["tail"]);
  });
});

describe("a streamed answer back as Anthropic's event stream", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => JSON.stringify({ id: "c", choices: [{ index: 0, delta, finish_reason: finish }] });

  it("passes text on as it arrives, in one block", () => {
    const s = new ChatToAnthropicStream("claude-sonnet-5-5");
    const out = [
      ...s.push(chunk({ role: "assistant", content: "" })),
      ...s.push(chunk({ content: "Hel" })),
      ...s.push(chunk({ reasoning_content: "hidden" })),
      ...s.push(chunk({ content: "lo" }, "stop")),
      ...s.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } })),
      ...s.push("[DONE]"),
      ...s.end(),
    ];
    const evs = events(out);
    expect(evs.map(([e]) => e)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(evs[0][1]).toMatchObject({ message: { model: "claude-sonnet-5-5", role: "assistant", content: [] } });
    expect(evs.filter(([e]) => e === "content_block_delta").map(([, d]) => (d.delta as { text: string }).text).join("")).toBe("Hello");
    expect(evs[5][1]).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { input_tokens: 11, output_tokens: 2 } });
    expect(JSON.stringify(evs)).not.toContain("hidden");
    expect(s.answered).toBe(true);
  });

  it("gathers tool calls sent in pieces — interleaved between calls too — and writes each whole, after the text", () => {
    const s = new ChatToAnthropicStream("m");
    const out = [
      ...s.push(chunk({ content: "Let me look." })),
      ...s.push(chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Re", arguments: "" } }] })),
      ...s.push(chunk({ tool_calls: [{ index: 0, function: { name: "ad", arguments: "{\"file_pa" } }] })),
      ...s.push(chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "Bash", arguments: "{\"command\":" } }] })),
      ...s.push(chunk({ tool_calls: [{ index: 0, function: { arguments: "th\":\"a.js\"}" } }] })),
      ...s.push(chunk({ tool_calls: [{ index: 1, function: { arguments: "\"npm test\"}" } }] }, "tool_calls")),
      ...s.end(),
    ];
    const evs = events(out);
    const starts = evs.filter(([e]) => e === "content_block_start").map(([, d]) => d);
    expect(starts).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "Read", input: {} } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_b", name: "Bash", input: {} } },
    ]);
    const json = evs.filter(([e, d]) => e === "content_block_delta" && (d.delta as { type: string }).type === "input_json_delta").map(([, d]) => JSON.parse((d.delta as { partial_json: string }).partial_json));
    expect(json).toEqual([{ file_path: "a.js" }, { command: "npm test" }]);
    expect(evs.find(([e]) => e === "message_delta")![1]).toMatchObject({ delta: { stop_reason: "tool_use" } });
    // Every block it opened, it closed.
    expect(evs.filter(([e]) => e === "content_block_stop").map(([, d]) => d.index)).toEqual([0, 1, 2]);
  });

  it("answers tool_use whenever a call came, even with the engine's finish reason missing", () => {
    const s = new ChatToAnthropicStream("m");
    const out = [...s.push(chunk({ tool_calls: [{ index: 0, id: "x", function: { name: "Glob", arguments: "{}" } }] })), ...s.end()];
    expect(events(out).find(([e]) => e === "message_delta")![1]).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("notices the engine's own error inside its stream", () => {
    const s = new ChatToAnthropicStream("m");
    expect(s.push(JSON.stringify({ error: { message: "CUDA out of memory" } }))).toEqual([]);
    expect(s.error).toBe("CUDA out of memory");
    expect(s.answered).toBe(false);
    const t = new ChatToAnthropicStream("m");
    t.push(JSON.stringify({ error: "plain words" }));
    expect(t.error).toBe("plain words");
  });

  it("ignores what is not a chunk", () => {
    const s = new ChatToAnthropicStream("m");
    expect(s.push("not json")).toEqual([]);
    expect(s.push("null")).toEqual([]);
    expect(s.answered).toBe(false);
  });
});

describe("the engine's refusals, in the statuses Claude Code acts on", () => {
  it("turns a conversation too long into the one refusal Claude Code compacts on", () => {
    const vllm = engineFailure(400, JSON.stringify({ error: { message: "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens." } }));
    expect(vllm.status).toBe(400);
    expect(vllm.body.error.type).toBe("invalid_request_error");
    expect(vllm.body.error.message).toMatch(/^prompt is too long: This model's maximum context length/);
    const llama = engineFailure(400, JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it" } }));
    expect(llama.body.error.message).toMatch(/^prompt is too long/);
  });

  it("quotes any other 4xx as a request the engine refused", () => {
    const e = engineFailure(422, "{\"detail\":\"tools[0].function.parameters is invalid\"}");
    expect(e).toEqual({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "The box's engine refused the request (HTTP 422): tools[0].function.parameters is invalid" } } });
  });

  it("never answers the run 401 for the engine's own key", () => {
    for (const status of [401, 403]) {
      const e = engineFailure(status, "{\"error\":\"bad key\"}");
      expect(e.status).toBe(502);
      expect(e.body.error.type).toBe("api_error");
      expect(e.body.error.message).toMatch(/refused the key the box holds/);
    }
  });

  it("lets Claude Code wait out a busy or overloaded engine", () => {
    expect(engineFailure(429, "slow down")).toMatchObject({ status: 429, body: { error: { type: "rate_limit_error" } } });
    expect(engineFailure(503, "")).toMatchObject({ status: 529, body: { error: { type: "overloaded_error" } } });
    expect(engineFailure(500, "boom")).toMatchObject({ status: 502, body: { error: { type: "api_error" } } });
    expect(engineFailure(404, "Not Found").body.error.message).toMatch(/no chat completions endpoint/);
  });

  it("quotes the engine's words shortened, never a page", () => {
    const long = "x".repeat(5_000);
    const words = engineErrorWords(long);
    expect(words.length).toBe(ENGINE_ERROR_QUOTE_CHARS + 1);
    expect(engineErrorWords("{\"message\":\"  spaced \\n words \"}")).toBe("spaced words");
    expect(engineFailure(500, "").body.error.message).toMatch(/HTTP 500/);
  });
});
