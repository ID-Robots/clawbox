// Runs ON the board, for scripts/nano-tests/tests/73-local-coding-provider.sh:
// an OpenAI-compatible engine standing in for the owner's External engine
// (TASK-2501 PR-E) that drives a coding run's tool loop the way a model would,
// so a `local` Claude Code run can be proven end to end without a GPU.
//
//   node coding-engine-mock.mjs --port N --model ID --key-file PATH --log PATH [--project-dir DIR]
//
// Listens on 127.0.0.1 only.
//
//   GET  /v1/models            the one model
//   POST /v1/chat/completions  streamed (SSE, tool calls sent in pieces) or not
//
// A request that offers Claude Code's own tools (Read, Edit, Bash) is the
// run's main loop, and is answered by how many tool results it already holds:
//   0 → Read add.js · 1 → Edit "a - b" → "a + b" · 2 → Bash `sh test.sh`
//   · then the run's closing words, which quote the test's verdict.
// The folder is the one Claude Code names in its system prompt ("Working
// directory: …"), else --project-dir. Any other request (a title, a quota
// check) is answered with a short text.
//
// Every request must carry `Authorization: Bearer <the key in --key-file>`;
// anything else is a 401 — which is how the test proves the box, not the run,
// holds the engine's key. Each request is appended to --log as one JSON line:
// path, model, stream, authorized, whether tools were offered, whether a
// thinking field came, the step answered — never the key, never the prompt.
// Prints READY once it listens.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const PORT = Number(arg("port", "18941"));
const MODEL = arg("model", "nano-ci/coder-1");
const LOG = arg("log", "");
const PROJECT_DIR = arg("project-dir", "");
const KEY = fs.readFileSync(arg("key-file"), "utf8").trim();

function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // A full disk must not take the engine down with it.
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === "text" ? p.text : "")).join("\n");
  return "";
}

/** The run's folder: Claude Code says it in its system prompt. */
function workingDirectory(messages) {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const hit = /Working directory:\s*(\S+)/.exec(textOf(m.content));
    if (hit) return hit[1];
  }
  return PROJECT_DIR;
}

let callSeq = 0;
/** What the main loop does next, as { text } or { tool: { name, input } }. */
function nextStep(messages) {
  const results = messages.filter((m) => m.role === "tool");
  const dir = workingDirectory(messages);
  const file = path.join(dir, "add.js");
  if (results.length === 0) return { step: "read", tool: { name: "Read", input: { file_path: file } } };
  if (results.length === 1) return { step: "edit", tool: { name: "Edit", input: { file_path: file, old_string: "a - b", new_string: "a + b" } } };
  if (results.length === 2) return { step: "test", tool: { name: "Bash", input: { command: "sh test.sh", description: "Run the project's test" } } };
  const verdict = /TESTS-PASS/.test(textOf(results[results.length - 1].content)) ? "TESTS-PASS" : "TESTS-FAILED";
  return { step: "done", text: `Fixed add.js: it subtracted where it should add. ./test.sh now reports ${verdict}.` };
}

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${KEY}`;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!authorized) {
    record({ path: url.pathname, authorized: false });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    record({ path: url.pathname, authorized: true });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", max_model_len: 131072 }] }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    record({ path: url.pathname, authorized: true, refused: "no such endpoint" });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no ${url.pathname} here` } }));
    return;
  }
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t && t.function && t.function.name).filter(Boolean) : [];
    const mainLoop = ["Read", "Edit", "Bash"].every((n) => toolNames.includes(n));
    const answer = mainLoop ? nextStep(messages) : { step: "text", text: "OK" };
    record({
      path: url.pathname,
      authorized: true,
      model: body.model,
      stream: body.stream === true,
      tools: toolNames.length,
      mainLoop,
      thinking: "thinking" in body || "reasoning" in body,
      toolResults: messages.filter((m) => m.role === "tool").length,
      step: answer.step,
    });
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 12, total_tokens: Math.ceil(raw.length / 4) + 12 };
    const callId = `call_${++callSeq}`;
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant", content: "" }));
      if (answer.text) {
        const half = Math.ceil(answer.text.length / 2);
        res.write(chunk({ content: answer.text.slice(0, half) }));
        res.write(chunk({ content: answer.text.slice(half) }, "stop"));
      } else {
        // In pieces, as a real engine sends a call: the name, then the arguments in two.
        const json = JSON.stringify(answer.tool.input);
        const cut = Math.floor(json.length / 2);
        res.write(chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: answer.tool.name, arguments: json.slice(0, cut) } }] }));
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(cut) } }] }, "tool_calls"));
      }
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    const message = answer.text
      ? { role: "assistant", content: answer.text }
      : { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.input) } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "mock", object: "chat.completion", model: MODEL, choices: [{ index: 0, message, finish_reason: answer.text ? "stop" : "tool_calls" }], usage }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log("READY"));
