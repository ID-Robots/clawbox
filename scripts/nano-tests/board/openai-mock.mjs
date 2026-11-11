// Runs ON the board, for scripts/nano-tests/tests/69-external-engine.sh: a
// small OpenAI-compatible server standing in for an owner's external AI engine
// (an inference cluster, a vLLM / SGLang server on the LAN) — TASK-2376.
//
//   node openai-mock.mjs --port N --model ID --key-file PATH --log PATH [--context N]
//
// Listens on 127.0.0.1 only. Answers what the box asks of an engine:
//
//   GET  /v1/models            the one model, with its window (`max_model_len`)
//   POST /v1/chat/completions  streamed (SSE) or not; the reply is the text
//                              after "nothing else:" in the last user message
//                              (the suite's "Reply with exactly this text and
//                              nothing else: NANO-CI-OK <serial>"), else
//                              "NANO-EXT-MOCK"
//
// Every request must carry `Authorization: Bearer <the key in --key-file>`;
// anything else is a 401, which is how the test proves the box sends the key
// it was given. Each request is appended to --log as one JSON line — path,
// model, stream, whether it was authorized, the end of the last user message
// and the reply given — never the key. Prints READY once it listens.
import http from "node:http";
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const PORT = Number(arg("port", "18931"));
const MODEL = arg("model", "nano-ci/echo-1");
const CONTEXT = Number(arg("context", "131072"));
const LOG = arg("log", "");
const KEY = fs.readFileSync(arg("key-file"), "utf8").trim();

function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // A full disk must not take the engine down with it.
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

function replyFor(messages) {
  const users = Array.isArray(messages) ? messages.filter((m) => m?.role === "user") : [];
  const last = textOf(users.at(-1)?.content);
  const m = /nothing else:\s*([^\n]+)/i.exec(last);
  return { last, reply: m ? m[1].trim() : "NANO-EXT-MOCK" };
}

const server = http.createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${KEY}`;
  const path = (req.url || "").split("?")[0].replace(/\/+$/, "");
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 8 * 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!authorized) {
      record({ method: req.method, path, authorized: false });
      send(res, 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } });
      return;
    }
    if (req.method === "GET" && path === "/v1/models") {
      record({ method: req.method, path, authorized: true });
      send(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: 1_700_000_000, owned_by: "nano-ci", max_model_len: CONTEXT }] });
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const { last, reply } = replyFor(body.messages);
      const stream = body.stream === true;
      record({
        method: req.method, path, authorized: true, model: body.model, stream,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        // The END of the message: a harness may put an envelope in front.
        lastUser: last.slice(-160),
        reply: reply.slice(0, 120),
      });
      if (body.model !== MODEL) {
        send(res, 404, { error: { message: `The model \`${body.model}\` does not exist.`, type: "invalid_request_error" } });
        return;
      }
      const id = `chatcmpl-nano-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.max(1, Math.ceil(reply.length / 4)) };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      if (!stream) {
        send(res, 200, {
          id, object: "chat.completion", created, model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage,
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const chunk = (delta, finish = null, extra = {}) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      chunk({ role: "assistant", content: "" });
      chunk({ content: reply });
      chunk({}, "stop");
      if (body.stream_options?.include_usage) {
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [], usage })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    record({ method: req.method, path, authorized: true, unknown: true });
    send(res, 404, { error: { message: `No route ${req.method} ${path}`, type: "invalid_request_error" } });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("READY");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
