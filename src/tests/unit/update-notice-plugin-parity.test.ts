/**
 * /update and the Update button inside the two harnesses (TASK-2260).
 *
 * Three copies of one shape — `parseUpdateChatCommand` on the device, the
 * OpenClaw hook's `looksLikeUpdateCommand`, the Hermes hook's
 * `looks_like_update_command` — must agree, or a message one edition hands to
 * ClawBox is ordinary conversation on the other. Then what each hook actually
 * does with a match: who it tells, what it claims, and that it fails CLOSED
 * (both harnesses have a `/update` of their own that updates the harness
 * underneath ClawBox's pin).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parseUpdateChatCommand, UPDATE_BUTTON_DATA } from "@/lib/update-notice";
import {
  UNAVAILABLE_TEXT,
  UPDATE_BUTTON_DATA as OPENCLAW_BUTTON_DATA,
  looksLikeUpdateCommand,
  onUpdateCommand,
} from "../../../scripts/openclaw-plugins/clawbox-email-directives/update-commands.mjs";
import plugin, { onInboundBeforeDispatch } from "../../../scripts/openclaw-plugins/clawbox-email-directives/index.mjs";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const PLUGINS_ROOT = path.join(REPO, "scripts/hermes-plugins");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const py3 = hasPython3 ? describe : describe.skip;

function py<T>(body: string, input: unknown = null): T {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "stdin = json.loads(sys.stdin.read() or 'null')",
    body,
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, PLUGINS_ROOT], { input: JSON.stringify(input), encoding: "utf-8" }));
}

const SAMPLES = [
  "/update", " /update ", "/Update", "/UPDATE", "/update@ClawBoxBot", "\ufeff/update", "/update\n",
  "clawbox-update", "callback_data: clawbox-update", " clawbox-update ",
  "/update now", "/updates", "update", "/update@", "/update@bad-name", "please /update",
  "callback_data: clawbox-update2", "callback_data:clawbox-update", "send AB2CD", "", "/start",
];

describe("the shape, in three languages", () => {
  it("names the same button data everywhere", () => {
    expect(OPENCLAW_BUTTON_DATA).toBe(UPDATE_BUTTON_DATA);
    expect(UPDATE_BUTTON_DATA).toBe("clawbox-update");
  });

  it("OpenClaw's hook matches exactly what the device parses", () => {
    for (const s of SAMPLES) expect(looksLikeUpdateCommand(s), JSON.stringify(s)).toBe(parseUpdateChatCommand(s) !== null);
  });

  py3("Hermes", () => {
    it("Hermes' hook matches exactly what the device parses", () => {
      const verdicts = py<boolean[]>(
        "from clawbox_email_directives import update_commands as u\n"
          + "print(json.dumps([u.looks_like_update_command(s) for s in stdin]))",
        SAMPLES,
      );
      expect(verdicts).toEqual(SAMPLES.map((s) => parseUpdateChatCommand(s) !== null));
    });

    it("names the same button data", () => {
      expect(py<string>("from clawbox_email_directives import update_commands as u\nprint(json.dumps(u.UPDATE_BUTTON_DATA))"))
        .toBe(UPDATE_BUTTON_DATA);
    });
  });
});

describe("OpenClaw — before_dispatch", () => {
  const savedToken = process.env.CLAWBOX_MCP_TOKEN;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedToken === undefined) delete process.env.CLAWBOX_MCP_TOKEN;
    else process.env.CLAWBOX_MCP_TOKEN = savedToken;
  });

  function answering(status: number, body: unknown) {
    const calls: { url: string; body: unknown; auth: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify(body), { status });
    }));
    return calls;
  }

  it("asks nothing about ordinary conversation", async () => {
    const calls = answering(200, { handled: true });
    expect(await onUpdateCommand({ content: "is there an update?" }, { senderId: "6001", channelId: "telegram" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("hands ClawBox /update with the sender, the surface, the harness and whether it was a group", async () => {
    process.env.CLAWBOX_MCP_TOKEN = "t".repeat(32);
    const calls = answering(200, { handled: true });
    const result = await onUpdateCommand({ content: "/update", isGroup: false }, { senderId: "6001", channelId: "telegram" });
    expect(result).toEqual({ handled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:80/setup-api/update/chat-command");
    expect(calls[0].auth).toBe(`Bearer ${"t".repeat(32)}`);
    expect(calls[0].body).toEqual({ senderId: "6001", text: "/update", channel: "telegram", harness: "openclaw", isGroup: false });
  });

  it("hands over the tap in the form OpenClaw gives it", async () => {
    process.env.CLAWBOX_MCP_TOKEN = "t".repeat(32);
    const calls = answering(200, { handled: true });
    await onUpdateCommand({ content: "callback_data: clawbox-update" }, { senderId: "6001", channelId: "telegram" });
    expect((calls[0].body as { text: string }).text).toBe("callback_data: clawbox-update");
  });

  it("fails CLOSED: ClawBox unreachable means a word to the owner, never OpenClaw's own /update", async () => {
    process.env.CLAWBOX_MCP_TOKEN = "t".repeat(32);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connect ECONNREFUSED"); }));
    expect(await onUpdateCommand({ content: "/update" }, { senderId: "6001", channelId: "telegram" }))
      .toEqual({ handled: true, text: UNAVAILABLE_TEXT });
    answering(500, {});
    expect(await onUpdateCommand({ content: "/update" }, { senderId: "6001", channelId: "telegram" }))
      .toEqual({ handled: true, text: UNAVAILABLE_TEXT });
  });

  it("leaves /update on another channel to that channel", async () => {
    const calls = answering(200, { handled: true });
    expect(await onUpdateCommand({ content: "/update" }, { senderId: "6001", channelId: "whatsapp" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("is the plugin's one before_dispatch, ahead of the emailed-draft reply", async () => {
    const registered: string[] = [];
    (plugin as { register: (api: { on: (name: string) => void }) => void }).register({ on: (name) => registered.push(name) });
    expect(registered).toEqual(["reply_payload_sending", "before_dispatch"]);
    process.env.CLAWBOX_MCP_TOKEN = "t".repeat(32);
    const calls = answering(200, { handled: true });
    await onInboundBeforeDispatch({ content: "/update" }, { senderId: "6001", channelId: "telegram" });
    await onInboundBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:80/setup-api/update/chat-command",
      "http://127.0.0.1:80/setup-api/email/chat-reply",
    ]);
  });
});

py3("Hermes — pre_gateway_dispatch and the button's callback handler", () => {
  const FAKE = [
    "import json, urllib.request, urllib.error, asyncio",
    "import clawbox_email_directives as p",
    "import clawbox_email_directives.approvals as approvals",
    "import clawbox_email_directives.update_commands as u",
    "approvals.CLAWBOX_ROOT = '/nonexistent'",
    "approvals._cached_token = 't' * 32",
    "approvals.API_BASE = 'http://127.0.0.1:80'",
    "calls = []",
    "def fake_urlopen(req, timeout=None):",
    "    calls.append({'url': req.full_url, 'body': json.loads(req.data.decode())})",
    "    if stdin.get('fail') == 'refused': raise OSError('refused')",
    "    class R:",
    "        status = 200",
    "        def read(self): return json.dumps(stdin.get('answer', {'handled': True})).encode()",
    "        def __enter__(self): return self",
    "        def __exit__(self, *a): return False",
    "    return R()",
    "urllib.request.urlopen = fake_urlopen",
  ].join("\n");

  function dispatch(text: string, opts: { fail?: string; answer?: unknown; chatType?: string; platform?: string } = {}) {
    return py<{ result: unknown; calls: { url: string; body: Record<string, unknown> }[] }>(
      [
        FAKE,
        "class P: value = stdin['platform']",
        "class S: user_id = '7001'; chat_id = '7001'; chat_type = stdin['chatType']; platform = P()",
        "class E: text = stdin['text']; user_id = None; source = S()",
        "print(json.dumps({'result': p.pre_gateway_dispatch(event=E()), 'calls': calls}))",
      ].join("\n"),
      { text, fail: opts.fail, answer: opts.answer, chatType: opts.chatType ?? "dm", platform: opts.platform ?? "telegram" },
    );
  }

  it("claims /update after handing ClawBox the sender, chat and harness", () => {
    const { result, calls } = dispatch("/update");
    expect(result).toEqual({ action: "skip", reason: "clawbox_update" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:80/setup-api/update/chat-command");
    expect(calls[0].body).toEqual({ senderId: "7001", chatId: "7001", isGroup: false, text: "/update", channel: "telegram", harness: "hermes" });
  });

  it("says when it came from a group", () => {
    expect(dispatch("/update", { chatType: "group" }).calls[0].body.isGroup).toBe(true);
  });

  it("fails CLOSED: dropped, never left to Hermes' own /update", () => {
    expect(dispatch("/update", { fail: "refused" }).result).toEqual({ action: "skip", reason: "clawbox_update_unavailable" });
    expect(dispatch("/update", { answer: { handled: false } }).result).toEqual({ action: "skip", reason: "clawbox_update_unavailable" });
  });

  it("still hands the emailed-draft reply to the email route, and leaves conversation alone", () => {
    const email = dispatch("send AB2CD", { answer: { handled: true } });
    expect(email.calls[0].url).toBe("http://127.0.0.1:80/setup-api/email/chat-reply");
    const chat = dispatch("good morning");
    expect(chat.result).toBeNull();
    expect(chat.calls).toHaveLength(0);
  });

  it("leaves /update on another platform alone", () => {
    const { result, calls } = dispatch("/update", { platform: "discord" });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("registers a callback handler scoped to the button, beside its two hooks", () => {
    const out = py<{ hooks: string[]; factories: number; pattern: string }>(
      [
        FAKE,
        "import sys, types",
        // A stand-in for python-telegram-bot's CallbackQueryHandler: what is
        // asserted is the pattern the plugin scopes itself with.
        "ext = types.ModuleType('telegram.ext')",
        "class CallbackQueryHandler:",
        "    def __init__(self, cb, pattern=None): self.cb = cb; self.pattern = pattern",
        "ext.CallbackQueryHandler = CallbackQueryHandler",
        "sys.modules['telegram'] = types.ModuleType('telegram'); sys.modules['telegram.ext'] = ext",
        "class Ctx:",
        "    def __init__(self): self.hooks = []; self.factories = []",
        "    def register_hook(self, name, cb): self.hooks.append(name)",
        "    def register_telegram_handler(self, f): self.factories.append(f)",
        "ctx = Ctx(); p.register(ctx)",
        "class App:",
        "    def __init__(self): self.handlers = []",
        "    def add_handler(self, h): self.handlers.append(h)",
        "app = App(); ctx.factories[0](app, None)",
        "print(json.dumps({'hooks': ctx.hooks, 'factories': len(ctx.factories), 'pattern': app.handlers[0].pattern}))",
      ].join("\n"),
      {},
    );
    expect(out).toEqual({ hooks: ["transform_llm_output", "pre_gateway_dispatch"], factories: 1, pattern: "^clawbox-update$" });
  });

  it("still loads on a Hermes that cannot take a Telegram handler", () => {
    const hooks = py<string[]>(
      [
        "import clawbox_email_directives as p",
        "class Ctx:",
        "    def __init__(self): self.hooks = []",
        "    def register_hook(self, name, cb): self.hooks.append(name)",
        "ctx = Ctx(); p.register(ctx)",
        "print(json.dumps(ctx.hooks))",
      ].join("\n"),
    );
    expect(hooks).toEqual(["transform_llm_output", "pre_gateway_dispatch"]);
  });

  function tap(opts: { fail?: string; chatType?: string; data?: string } = {}) {
    return py<{ calls: { url: string; body: Record<string, unknown> }[]; answered: number; cleared: number }>(
      [
        FAKE,
        "class User: id = 7001",
        "class Chat: id = 7001; type = stdin['chatType']",
        "class Msg: chat = Chat()",
        "class Q:",
        "    data = stdin['data']; from_user = User(); message = Msg(); answered = 0; cleared = 0",
        "    async def answer(self, *a, **k): Q.answered += 1",
        "    async def edit_message_reply_markup(self, reply_markup=None): Q.cleared += 1",
        "class Upd: callback_query = Q()",
        "asyncio.run(u.on_update_button(Upd(), None))",
        "print(json.dumps({'calls': calls, 'answered': Q.answered, 'cleared': Q.cleared}))",
      ].join("\n"),
      { fail: opts.fail, chatType: opts.chatType ?? "private", data: opts.data ?? "clawbox-update" },
    );
  }

  it("a tap is acknowledged, handed to ClawBox as the presser's, and its button retired", () => {
    const out = tap();
    expect(out.answered).toBe(1);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].body).toEqual({
      senderId: "7001", chatId: "7001", isGroup: false, text: "clawbox-update", channel: "telegram", harness: "hermes",
    });
    expect(out.cleared).toBe(1);
  });

  it("keeps the button when ClawBox could not be asked, so the owner can tap again", () => {
    const out = tap({ fail: "refused" });
    expect(out.answered).toBe(1);
    expect(out.cleared).toBe(0);
  });

  it("ignores callback data that is not this button's", () => {
    const out = tap({ data: "mp:openai" });
    expect(out.calls).toHaveLength(0);
    expect(out.answered).toBe(0);
  });
});
