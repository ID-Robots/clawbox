/**
 * The OpenClaw plugin that puts the on-device model in lean mode
 * (`clawbox-local-lean`): a turn on the llamacpp model gets a short system
 * prompt and six tools, every other turn — any cloud model, a cloud fallback
 * after a local failure, a heartbeat — keeps OpenClaw's full prompt and tools.
 *
 * The plugin cannot import the app (it runs inside the gateway), so the names
 * it relies on are held here to the code that defines them.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import plugin from "../../../scripts/openclaw-plugins/clawbox-local-lean/index.mjs";
import {
  detectLanguage,
  isLeanTurn,
  LEAN_TOOLS,
  leanSystemPrompt,
  LOCAL_PROVIDER,
  promptBuild,
  toolSearchEnabled,
  turnProvider,
} from "../../../scripts/openclaw-plugins/clawbox-local-lean/local-lean.mjs";

const LOCAL_PRIMARY = { agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } } };
const CLOUD_PRIMARY = { agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"] } } } };
const NOW = new Date("2026-10-28T12:00:00Z");

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf-8");

type Handler = (event: unknown, ctx: unknown) => unknown;

function registered(config: unknown = {}): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  plugin.register({ on: (name: string, fn: Handler) => { handlers[name] = fn; }, config });
  return handlers;
}

describe("which turns are lean", () => {
  it("is the turn's own provider when the core names it", () => {
    expect(turnProvider({ modelProviderId: "llamacpp", modelId: "gemma4-e2b-it-q4_0" }, CLOUD_PRIMARY)).toBe("llamacpp");
    expect(turnProvider({ modelProviderId: " DeepSeek " }, LOCAL_PRIMARY)).toBe("deepseek");
  });

  it("falls back to the configured primary only when the core does not say", () => {
    expect(turnProvider({}, LOCAL_PRIMARY)).toBe("llamacpp");
    expect(turnProvider({}, { agents: { defaults: { model: "llamacpp/x" } } })).toBe("llamacpp");
    expect(turnProvider({ agentId: "work" }, {
      agents: { defaults: { model: { primary: "deepseek/x" } }, entries: { work: { model: "llamacpp/y" } } },
    })).toBe("llamacpp");
    expect(turnProvider({}, {})).toBe("");
  });

  it("is lean on the local model and on nothing else", () => {
    expect(LOCAL_PROVIDER).toBe("llamacpp");
    expect(isLeanTurn({ modelProviderId: "llamacpp" }, {})).toBe(true);
    expect(isLeanTurn({ modelProviderId: "deepseek" }, LOCAL_PRIMARY)).toBe(false); // a cloud fallback attempt
    expect(isLeanTurn({ modelProviderId: "ollama" }, {})).toBe(false);
    expect(isLeanTurn({}, CLOUD_PRIMARY)).toBe(false);
  });

  it("leaves heartbeat and memory-flush turns their full prompt, whose contracts live there", () => {
    expect(isLeanTurn({ modelProviderId: "llamacpp", trigger: "heartbeat" }, {})).toBe(false);
    expect(isLeanTurn({ modelProviderId: "llamacpp", trigger: "memory" }, {})).toBe(false);
    expect(isLeanTurn({ modelProviderId: "llamacpp", trigger: "user" }, {})).toBe(true);
    expect(isLeanTurn({ modelProviderId: "llamacpp", trigger: "cron" }, {})).toBe(true);
  });
});

describe("the prompt build answer", () => {
  it("gives a local turn the lean prompt and the lean tools", () => {
    const r = promptBuild({ prompt: "Make me an app" }, { modelProviderId: "llamacpp", workspaceDir: "/w" }, {}, NOW) as {
      systemPrompt: string; toolsAllow: string[];
    };
    expect(r.toolsAllow).toEqual([...LEAN_TOOLS]);
    expect(r.systemPrompt).toContain("Always reply in the language of the user's last message.");
    expect(r.systemPrompt).toContain("Act, do not ask");
    expect(r.systemPrompt).toContain("Keep replies short");
    expect(r.systemPrompt).toContain("your workspace, /w.");
    expect(r.systemPrompt).toMatch(/\nToday is \w+,? \d{1,2} October 2026\.$/);
  });

  it("leaves every cloud turn untouched", () => {
    expect(promptBuild({ prompt: "hi" }, { modelProviderId: "deepseek" }, LOCAL_PRIMARY, NOW)).toBeUndefined();
    expect(promptBuild({ prompt: "hi" }, {}, CLOUD_PRIMARY, NOW)).toBeUndefined();
  });

  it("is a small fraction of OpenClaw's own prompt", () => {
    // OpenClaw's full system prompt measured 44,823 characters on a box.
    const prompt = leanSystemPrompt({ language: "bg", workspaceDir: "/home/clawbox/.openclaw/workspace", today: "Wednesday, 28 October 2026" });
    expect(prompt.length).toBeLessThan(2_000);
  });

  it("names every lean tool it teaches, in the form the tool surface takes", () => {
    const viaSearch = leanSystemPrompt({});
    for (const tool of LEAN_TOOLS.filter((t: string) => t !== "read" && t !== "write")) {
      expect(viaSearch).toContain(`call tool_call with {"id": "${tool}", `);
    }
    expect(viaSearch).toContain('call read with {"path": "..."}');
    expect(viaSearch).toContain('or write with {"path": "...", "content": "..."}');
    // Flat, not nested under "args": a 2B model nesting a whole page lost the id.
    expect(viaSearch).not.toContain('"args"');

    const direct = leanSystemPrompt({ toolSearch: false });
    expect(direct).toContain('call clawbox__webapp_create with {"app_id": ');
    expect(direct).not.toContain("tool_call");
  });

  it("follows the core's Tool Search setting", () => {
    const off = promptBuild({ prompt: "x" }, { modelProviderId: "llamacpp" }, { tools: { toolSearch: false } }, NOW) as { systemPrompt: string };
    expect(off.systemPrompt).not.toContain("tool_call");
    const on = promptBuild({ prompt: "x" }, { modelProviderId: "llamacpp" }, {}, NOW) as { systemPrompt: string };
    expect(on.systemPrompt).toContain("tool_call");
  });

  it("reads Tool Search exactly as the core's resolveToolSearchConfig does", () => {
    expect(toolSearchEnabled({})).toBe(true);
    expect(toolSearchEnabled({ tools: {} })).toBe(true);
    expect(toolSearchEnabled({ tools: { toolSearch: true } })).toBe(true);
    expect(toolSearchEnabled({ tools: { toolSearch: false } })).toBe(false);
    expect(toolSearchEnabled({ tools: { toolSearch: { enabled: false, mode: "tools" } } })).toBe(false);
    expect(toolSearchEnabled({ tools: { toolSearch: { enabled: true } } })).toBe(true);
    expect(toolSearchEnabled({ tools: { toolSearch: { mode: "directory" } } })).toBe(true);
    // An object naming nothing but `enabled`-less defaults is off in the core.
    expect(toolSearchEnabled({ tools: { toolSearch: {} } })).toBe(false);
  });

  it("names the language of the current message, and the neighbour not to answer in", () => {
    const bg = promptBuild({ prompt: "Хей, какво можеш да правиш?" }, { modelProviderId: "llamacpp" }, {}, NOW) as { systemPrompt: string };
    expect(bg.systemPrompt).toContain("The user's last message is in Bulgarian: write your whole reply in Bulgarian (not Russian).");
    const de = promptBuild(
      { prompt: "history…", currentUserMessage: "Kannst du mir erklären, warum der Himmel blau ist?" },
      { modelProviderId: "llamacpp" }, {}, NOW,
    ) as { systemPrompt: string };
    expect(de.systemPrompt).toContain("is in German: write your whole reply in German.");
    const unknown = promptBuild({ prompt: "ok" }, { modelProviderId: "llamacpp" }, {}, NOW) as { systemPrompt: string };
    expect(unknown.systemPrompt).not.toContain("The user's last message is in");
    expect(unknown.systemPrompt).toContain("Always reply in the language of the user's last message.");
  });
});

describe("telling one message's language", () => {
  it.each([
    ["Хей, какво можеш да правиш?", "bg"],
    ["Запиши във файл todo-bg.txt в работната си папка текста: купи хляб", "bg"],
    ["Здравей! Ще ми помогнеш ли с това?", "bg"],
    ["Привет, что ты умеешь?", "ru"],
    ["Сделай мне, пожалуйста, приложение", "ru"],
    ["Привіт, що ти вмієш?", "uk"],
    ["Make me an HTML app with a dancing crab", "en"],
    ["What is 17 × 23? Reply with just the number.", "en"],
    ["Kannst du mir in zwei Sätzen erklären, warum der Himmel blau ist?", "de"],
    ["¿Cuál es la capital de Australia? Responde en una frase.", "es"],
    ["Peux-tu me dire pourquoi le ciel est bleu ?", "fr"],
    ["Qual é a capital do Brasil? Você sabe?", "pt"],
    ["今日はいい天気ですね", "ja"],
    ["今天天气很好", "zh"],
    ["안녕하세요", "ko"],
    ["Γεια σου, τι κάνεις;", "el"],
  ])("%s → %s", (text, code) => {
    expect(detectLanguage(text)).toBe(code);
  });

  it("says nothing rather than guess", () => {
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage(undefined)).toBeNull();
    expect(detectLanguage("12345 !!!")).toBeNull();
  });

  it("reads the person's words, not a pasted link or code block", () => {
    expect(detectLanguage("Какво има на https://example.com/the-and-is-what-you-can?")).toBe("bg");
    expect(detectLanguage("Обясни този код, моля:\n```\nconst the = and; if (is) return what;\n```")).toBe("bg");
  });
});

describe("the plugin as the gateway loads it", () => {
  it("registers one before_prompt_build hook that answers for local turns only", async () => {
    const handlers = registered();
    expect(Object.keys(handlers)).toEqual(["before_prompt_build"]);
    const local = await handlers.before_prompt_build({ prompt: "hi" }, { modelProviderId: "llamacpp" }) as { systemPrompt?: string };
    expect(local?.systemPrompt).toBeTruthy();
    await expect(Promise.resolve(handlers.before_prompt_build({ prompt: "hi" }, { modelProviderId: "deepseek" }))).resolves.toBeUndefined();
  });

  it("reads the config in force now, so a model switch needs no restart", () => {
    let current: unknown = CLOUD_PRIMARY;
    const handlers: Record<string, Handler> = {};
    plugin.register({
      on: (name: string, fn: Handler) => { handlers[name] = fn; },
      config: CLOUD_PRIMARY,
      runtime: { config: { current: () => current } },
    });
    expect(handlers.before_prompt_build({ prompt: "hi" }, {})).toBeUndefined();
    current = LOCAL_PRIMARY;
    expect(handlers.before_prompt_build({ prompt: "hi" }, {})).toBeTruthy();
  });

  it("never fails a turn: a fault costs it only the lean prompt", () => {
    const handlers: Record<string, Handler> = {};
    plugin.register({
      on: (name: string, fn: Handler) => { handlers[name] = fn; },
      config: {},
      runtime: { config: { current: () => { throw new Error("boom"); } } },
    });
    expect(() => handlers.before_prompt_build({ prompt: "hi" }, { get modelProviderId(): string { throw new Error("bad ctx"); } })).not.toThrow();
  });

  it("matches its manifest and package", () => {
    const manifest = JSON.parse(read("scripts/openclaw-plugins/clawbox-local-lean/openclaw.plugin.json"));
    const pkg = JSON.parse(read("scripts/openclaw-plugins/clawbox-local-lean/package.json"));
    expect(plugin.id).toBe(manifest.id);
    expect(pkg.name).toBe(manifest.id);
    expect(pkg.openclaw.extensions).toEqual(["./index.mjs"]);
  });

  it("is installed by the gateway pre-start with its prompt hook's grant", () => {
    const script = read("scripts/gateway-pre-start.sh");
    expect(script).toContain('CLAWBOX_LOCAL_LEAN_ID="clawbox-local-lean"');
    expect(script).toMatch(/CLAWBOX_HOOK_PLUGIN_CONVERSATION_ACCESS=1 install_clawbox_hook_plugin "\$CLAWBOX_LOCAL_LEAN_ID"/);
    for (const file of fs.readdirSync(path.resolve(process.cwd(), "scripts/openclaw-plugins/clawbox-local-lean"))) {
      expect(script).toContain(`"$CLAWBOX_LOCAL_LEAN_SRC/${file}"`);
    }
  });
});

describe("the tool names it relies on", () => {
  it("prefixes MCP tools with the server key ClawBox registers in openclaw.json", () => {
    expect(read("src/lib/clawbox-mcp-registration.ts")).toContain('const OPENCLAW_SERVER_ID = "clawbox";');
    expect(LEAN_TOOLS.filter((t: string) => t.includes("__")).every((t: string) => t.startsWith("clawbox__"))).toBe(true);
  });

  it("names MCP tools the server registers for the OpenClaw edition", () => {
    const sources = ["mcp/tools/desktop.ts", "mcp/tools/browser.ts"].map(read).join("\n");
    for (const tool of LEAN_TOOLS.filter((t: string) => t.startsWith("clawbox__"))) {
      const bare = tool.slice("clawbox__".length);
      const at = sources.indexOf(`"${bare}",`);
      expect(at, `${bare} is registered`).toBeGreaterThan(-1);
      expect(sources.slice(at, at + 1_500)).toMatch(/editions: \[[^\]]*"openclaw"/);
    }
  });
});
