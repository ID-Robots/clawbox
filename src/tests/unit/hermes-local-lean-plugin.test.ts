import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  detectLanguage,
  languageLine,
  LEAN_TOOLS as OPENCLAW_LEAN_TOOLS,
} from "../../../scripts/openclaw-plugins/clawbox-local-lean/local-lean.mjs";
import { clampReasoningForProvider, HERMES_REASONING_LEVELS, isThinkingOnLevel } from "@/lib/hermes-reasoning";

// Starts a real process (python3): vitest's 5 s test default is not enough on
// a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The Hermes twin of clawbox-local-lean: `llm_request` middleware that gives a
// model call on the box's own llama.cpp model a short system prompt, six tools
// and thinking off unless asked. Driven through python3 — the module Hermes
// imports out of ~/.hermes/plugins/ — not a TypeScript restatement of it.
//
// The request shapes below are what Hermes v0.22.5 sent on a board: provider
// `custom`, base_url the Local AI proxy, platform `clawbox-chat`, keys
// messages/model/reasoning_effort/timeout/tools, MCP tools as
// `mcp__clawbox__<tool>`, and `reasoning_effort: "medium"` when nobody picked a
// level.

const REPO = path.resolve(__dirname, "../../..");
const PLUGINS_ROOT = path.join(REPO, "scripts/hermes-plugins");
const PLUGIN_DIR = path.join(PLUGINS_ROOT, "clawbox_local_lean");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 ? describe : describe.skip;

function py<T>(body: string, input: unknown = null): T {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "stdin = json.loads(sys.stdin.read() or 'null')",
    body,
  ].join("\n");
  const out = execFileSync("python3", ["-I", "-c", program, PLUGINS_ROOT], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

const LOCAL_URL = "http://127.0.0.1/setup-api/local-ai/llamacpp/v1";
const CLOUD_URL = "https://clawbox-ai.example/v1";

const tool = (name: string) => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object" } } });

/** The tool list a desktop turn carried with Tool Search off (a subset). */
const DIRECT_TOOLS = [
  "clarify", "delegate_task", "execute_code", "memory", "patch", "read_file", "search_files",
  "terminal", "web_extract", "web_search", "write_file", "mcp__clawbox__webapp_create",
  "mcp__clawbox__browser_open", "mcp__clawbox__system_stats", "mcp__clawbox__email_send",
].map(tool);

/** The same turn with Tool Search on: every MCP tool behind the bridge. */
const BRIDGED_TOOLS = [
  "clarify", "memory", "read_file", "terminal", "web_extract", "web_search", "write_file",
  "tool_search", "tool_describe", "tool_call",
].map(tool);

function request(overrides: Record<string, unknown> = {}) {
  return {
    model: "gemma4-e2b-it-q4_0",
    messages: [
      { role: "system", content: "You are Hermes Agent… (15,987 characters on the board)" },
      { role: "user", content: "направи ми проста todo страница" },
    ],
    tools: DIRECT_TOOLS,
    reasoning_effort: "medium",
    timeout: 900,
    ...overrides,
  };
}

interface Lean {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
  reasoning_effort?: string;
  timeout?: number;
}

function lean(req: unknown, baseUrl: string, platform: string | null = "clawbox-chat"): Lean | null {
  return py<Lean | null>(
    [
      "import datetime",
      "from clawbox_local_lean.local_lean import lean_request",
      "print(json.dumps(lean_request(stdin['req'], stdin['url'], stdin['platform'],",
      "                              now=datetime.datetime(2026, 10, 31, 12, 0)), ensure_ascii=False))",
    ].join("\n"),
    { req, url: baseUrl, platform },
  );
}

const names = (r: Lean | null) => (r?.tools ?? []).map((t) => t.function.name);

d("Hermes clawbox_local_lean middleware — which calls are lean", () => {
  it("rewrites a call to the box's own llama.cpp model", () => {
    const out = lean(request(), LOCAL_URL);
    expect(out).not.toBeNull();
    expect(out?.messages[0].role).toBe("system");
    expect(String(out?.messages[0].content)).toContain("You are the assistant built into this ClawBox");
  });

  it("leaves every cloud call alone, and the local model's internal turns", () => {
    expect(lean(request(), CLOUD_URL)).toBeNull();
    expect(lean(request(), "http://127.0.0.1/setup-api/local-ai/ollama/v1")).toBeNull();
    for (const platform of ["cron", "subagent", "curator"]) {
      expect(lean(request(), LOCAL_URL, platform)).toBeNull();
    }
    for (const platform of ["clawbox-chat", "cli", "telegram", null]) {
      expect(lean(request(), LOCAL_URL, platform)).not.toBeNull();
    }
  });

  it("answers through the plugin's own entry point, and registers as llm_request middleware", () => {
    const out = py<{ answer: { request: Lean; source: string } | null; cloud: unknown; registered: string[] }>(
      [
        "import clawbox_local_lean as p",
        "class Ctx:",
        "    def __init__(self): self.kinds = []",
        "    def register_middleware(self, kind, fn): self.kinds.append(kind)",
        "ctx = Ctx(); p.register(ctx)",
        "answer = p.llm_request(request=stdin['req'], original_request=stdin['req'], base_url=stdin['url'],",
        "                       platform='clawbox-chat', provider='custom', model='gemma4-e2b-it-q4_0', api_call_count=1)",
        "cloud = p.llm_request(request=stdin['req'], base_url='https://clawbox-ai.example/v1', platform='clawbox-chat')",
        "print(json.dumps({'answer': answer, 'cloud': cloud, 'registered': ctx.kinds}, ensure_ascii=False))",
      ].join("\n"),
      { req: request(), url: LOCAL_URL },
    );
    expect(out.registered).toEqual(["llm_request"]);
    expect(out.answer?.source).toBe("clawbox_local_lean");
    expect(out.answer?.request.tools?.length).toBe(6);
    expect(out.cloud).toBeNull();
  });

  it("never fails the call: a request it cannot read goes out unchanged", () => {
    const out = py<unknown[]>(
      [
        "import clawbox_local_lean as p",
        "print(json.dumps([p.llm_request(request=r, base_url=stdin['url']) for r in stdin['bad']]))",
      ].join("\n"),
      { url: LOCAL_URL, bad: [null, "text", { messages: "not a list" }, { tools: [] }] },
    );
    expect(out).toEqual([null, null, null, null]);
  });

  it("declares exactly the middleware it registers", () => {
    const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "plugin.yaml"), "utf-8");
    expect(manifest).toMatch(/^name: clawbox_local_lean$/m);
    expect(manifest).toMatch(/^provides_middleware:\n {2}- llm_request$/m);
  });
});

d("Hermes clawbox_local_lean middleware — the lean request", () => {
  it("keeps the six lean tools, web app first, and nothing else", () => {
    const out = lean(request(), LOCAL_URL);
    expect(names(out)).toEqual([
      "mcp__clawbox__webapp_create", "web_search", "web_extract", "mcp__clawbox__browser_open", "read_file", "write_file",
    ]);
  });

  it("matches the OpenClaw plugin's six, tool for tool", () => {
    const hermesIds = py<string[]>(
      "from clawbox_local_lean.local_lean import LEAN_TOOLS\nprint(json.dumps(sorted(t for _, t in LEAN_TOOLS)))",
    );
    // OpenClaw's names for the same six tools.
    const twin: Record<string, string> = {
      read: "read_file", write: "write_file", clawbox__webapp_create: "webapp_create",
      web_fetch: "web_extract", web_search: "web_search", clawbox__browser_open: "browser_open",
    };
    expect([...OPENCLAW_LEAN_TOOLS].map((n) => twin[n]).sort()).toEqual(hermesIds);
  });

  it("narrows and never widens: a tool the request lacks is neither added nor taught", () => {
    // Tool Search on: the MCP tools are behind the bridge and NOT callable by
    // name, so the prompt must not tell the model to call them.
    const out = lean(request({ tools: BRIDGED_TOOLS }), LOCAL_URL);
    expect(names(out)).toEqual(["web_search", "web_extract", "read_file", "write_file"]);
    const prompt = String(out?.messages[0].content);
    expect(prompt).not.toContain("webapp_create");
    expect(prompt).not.toContain("browser_open");
    expect(prompt).not.toContain("tool_call");

    const none = lean(request({ tools: [tool("terminal")], tool_choice: "auto" }), LOCAL_URL);
    expect(none).not.toHaveProperty("tools");
    expect(none).not.toHaveProperty("tool_choice");
    expect(String(none?.messages[0].content)).not.toContain("Tools:");
  });

  it("teaches each tool under the name the request offers it by", () => {
    const prompt = String(lean(request(), LOCAL_URL)?.messages[0].content);
    expect(prompt).toContain("call mcp__clawbox__webapp_create with {\"app_id\": \"todo-list\"");
    expect(prompt).toContain("call web_extract with {\"urls\": [\"https://...\"]}");
    expect(prompt).toContain("call mcp__clawbox__browser_open with {\"url\": \"https://...\"}");
    expect(prompt).toContain("never with write_file");
    // An older pin's spelling is recognised too.
    const older = lean(request({ tools: [tool("mcp_clawbox_webapp_create"), tool("read_file")] }), LOCAL_URL);
    expect(names(older)).toEqual(["mcp_clawbox_webapp_create", "read_file"]);
    expect(String(older?.messages[0].content)).toContain("call mcp_clawbox_webapp_create with");
  });

  it("replaces only the system prompt: the conversation goes out as it was", () => {
    const history = [
      { role: "system", content: "full prompt" },
      { role: "user", content: "направи ми проста todo страница" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "mcp__clawbox__webapp_create", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ];
    const out = lean(request({ messages: history }), LOCAL_URL);
    expect(out?.messages.slice(1)).toEqual(history.slice(1));
    expect(out?.model).toBe("gemma4-e2b-it-q4_0");
    expect(out?.timeout).toBe(900);

    const noSystem = lean(request({ messages: [{ role: "user", content: "hello there, what can you do?" }] }), LOCAL_URL);
    expect(noSystem?.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("is short: a few hundred tokens where Hermes' own prompt was 16k", () => {
    const prompt = String(lean(request(), LOCAL_URL)?.messages[0].content);
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).toContain("Today is Saturday 31 October 2026.");
  });
});

d("Hermes clawbox_local_lean middleware — the reply's language", () => {
  it("names the language of the last user message, Bulgarian not Russian", () => {
    const prompt = String(lean(request(), LOCAL_URL)?.messages[0].content);
    expect(prompt).toContain(
      "The user's last message is in Bulgarian: write your whole reply in Bulgarian (not Russian).",
    );
  });

  it("reads the last user message, text parts included", () => {
    const out = lean(request({
      messages: [
        { role: "system", content: "x" },
        { role: "user", content: "направи ми проста todo страница" },
        { role: "assistant", content: "Готово." },
        { role: "user", content: [{ type: "text", text: "Kannst du mir bitte die Seite erklären?" }] },
      ],
    }), LOCAL_URL);
    expect(String(out?.messages[0].content)).toContain("write your whole reply in German.");
  });

  it("detects every language exactly as the OpenClaw plugin does", () => {
    const corpus = [
      "направи ми проста todo страница", "Здравей, какво можеш да правиш днес?", "сделай мне простую страницу, пожалуйста",
      "Привіт, зроби мені сторінку сьогодні", "make me a simple todo page", "What is the weather like today?",
      "mach mir eine Seite bitte", "Fais-moi une page pour mes tâches", "¿Puedes hacerme una página?",
      "Fammi una pagina per favore", "Você pode fazer uma página?", "Maak een pagina voor mij",
      "Kan du göra en sida åt mig?", "Zrób mi stronę proszę", "Udělej mi stránku prosím", "Bana basit bir sayfa yap lütfen",
      "Fă-mi o pagină pentru că poți", "Γεια σου, φτιάξε μου μια σελίδα", "مرحبا اصنع لي صفحة", "שלום תעשה לי דף",
      "नमस्ते मेरे लिए एक पेज बनाओ", "สวัสดี ทำหน้าเว็บให้หน่อย", "こんにちは、ページを作ってください", "你好，请帮我做一个页面",
      "안녕하세요 페이지를 만들어 주세요", "hi", "", "```const x = 1``` https://example.com/страница [tag]", "12345 !!!",
      "Ok", "Hello hello", "ИСКАМ СТРАНИЦА", "NASIL yapılır", "Is it ready?",
    ];
    const python = py<Array<string | null>>(
      "from clawbox_local_lean.local_lean import detect_language\nprint(json.dumps([detect_language(t) for t in stdin]))",
      corpus,
    );
    expect(python).toEqual(corpus.map((text) => detectLanguage(text)));
    const lines = py<string[]>(
      "from clawbox_local_lean.local_lean import language_line\nprint(json.dumps([language_line(c) for c in stdin]))",
      ["bg", "ru", "uk", "sr", "mk", "en", "pt", "nl", "ja", null, "xx"],
    );
    expect(lines).toEqual(["bg", "ru", "uk", "sr", "mk", "en", "pt", "nl", "ja", null, "xx"].map((c) => languageLine(c)));
  });
});

d("Hermes clawbox_local_lean middleware — thinking", () => {
  it("sends the model's off level unless the turn asked for thinking, as ClawBox's own clamp does", () => {
    const out = py<Record<string, string | null>>(
      [
        "from clawbox_local_lean.local_lean import lean_request",
        "res = {}",
        "for level in stdin['levels']:",
        "    req = dict(stdin['req'], reasoning_effort=level)",
        "    res[level] = lean_request(req, stdin['url'])['reasoning_effort']",
        "print(json.dumps(res))",
      ].join("\n"),
      { levels: [...HERMES_REASONING_LEVELS], req: request(), url: LOCAL_URL },
    );
    for (const level of HERMES_REASONING_LEVELS) {
      const clamped = clampReasoningForProvider("clawlocal", level, "llamacpp");
      // The level that goes out thinks exactly when ClawBox's clamp would think.
      expect(isThinkingOnLevel("clawlocal", out[level] as (typeof HERMES_REASONING_LEVELS)[number]), level)
        .toBe(isThinkingOnLevel("clawlocal", clamped));
    }
    expect(out.medium).toBe("minimal");
    expect(out.max).toBe("max");
  });

  it("adds no level when the request carried none", () => {
    const req: Record<string, unknown> = request();
    delete req.reasoning_effort;
    expect(lean(req, LOCAL_URL)).not.toHaveProperty("reasoning_effort");
  });
});
