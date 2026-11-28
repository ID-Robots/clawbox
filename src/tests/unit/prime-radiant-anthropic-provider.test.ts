/**
 * Prime Radiant on the owner's own Anthropic account (TASK-2874 A): the
 * request the client sends, the pool it draws on (a REAL account pool and
 * secret store in a temp root, the same ones the coding agent uses), the
 * fallback to the next API-key account on a usage limit or a refused key, the
 * end of the line with a clear reason (never another provider), and the
 * provider choice itself — default `auto`, beaten by the cloud-AI lock.
 * Anthropic is a fake `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const lock = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/ai-cloud-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-cloud-lock")>()),
  isCloudAiLocked: async () => lock.on,
}));
const feature = vi.hoisted(() => ({ resolveFeatureEngine: vi.fn() }));
vi.mock("@/lib/feature-engine", () => feature);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const KEY_A = "sk-ant-api03-first-account-key-0123456789";
const KEY_B = "sk-ant-api03-second-account-key-987654321";
const CREDIT_LOW = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
const BAD_KEY = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
const RATE = { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit." } };
const OK_BODY = {
  id: "msg_1",
  type: "message",
  model: "claude-haiku-5-5-20261101",
  content: [{ type: "text", text: "[1]" }, { type: "text", text: "[2]" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
};
const REQ = { system: "You judge.", user: "Is it so?", maxTokens: 500 };

let root = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");
let flash: typeof import("@/lib/prime-radiant/flash-client");
let settings: typeof import("@/lib/prime-radiant/settings");

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake Anthropic: answers by the key the request carries. */
function anthropic(answers: Record<string, Response | (() => Response)>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, headers, body: JSON.parse(String(init.body)) });
    const a = answers[headers["x-api-key"]] ?? respond(500, "no answer");
    return typeof a === "function" ? a() : a.clone();
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function choose(provider: "auto" | "anthropic", anthropicModel = "claude-haiku-5-5") {
  settings.writeSettings({ model: { provider, anthropicModel } });
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME", "PRIME_RADIANT_DIR");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-anthropic-")));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "7c".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_TEST_HOME = path.join(root, "home");
  process.env.SESSION_SECRET = "ff".repeat(32);
  process.env.PRIME_RADIANT_DIR = path.join(root, "prime-radiant");
  lock.on = false;
  feature.resolveFeatureEngine.mockReset();
  feature.resolveFeatureEngine.mockResolvedValue({ kind: "clawbox-ai" });
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
  pool._resetAnthropicAccountsForTests();
  (await import("@/lib/claude-login"))._resetAnthropicLoginCache();
  flash = await import("@/lib/prime-radiant/flash-client");
  settings = await import("@/lib/prime-radiant/settings");
});

afterEach(() => {
  pool._resetAnthropicAccountsForTests();
  vi.unstubAllGlobals();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the request and the answer", () => {
  it("posts to Anthropic's Messages API with the pool's API key, and records the answer under the Claude model id", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    const fake = anthropic({ [KEY_A]: respond(200, OK_BODY) });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    expect(client).toMatchObject({ model: "claude-haiku-5-5", engine: "anthropic" });
    const out = await client.complete(REQ);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(fake.calls[0].headers).toMatchObject({ "x-api-key": KEY_A, "anthropic-version": "2023-06-01" });
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(fake.calls[0].body).toEqual({ model: "claude-haiku-5-5", max_tokens: 500, temperature: 0, system: "You judge.", messages: [{ role: "user", content: "Is it so?" }] });
    // The model id as the owner picked it (the key into the rates), never the dated one the API echoes.
    expect(out).toEqual({ text: "[1][2]", model: "claude-haiku-5-5", finishReason: "stop", usage: { promptTokens: 150, completionTokens: 40, cacheHitTokens: 30 } });
    expect(flash.estimateUsd(out.model, out.usage)).toBeGreaterThan(0);
  });

  it("asks again without a temperature of a model that takes none, and reads a capped answer as one", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    const answers = [
      respond(400, { type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." } }),
      respond(200, { ...OK_BODY, content: [], stop_reason: "max_tokens" }),
    ];
    const fetchImpl = vi.fn(async () => answers.shift() as Response);
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.complete(REQ)).rejects.toMatchObject({ kind: "bad_response", message: expect.stringMatching(/output cap/) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty("temperature");
  });

  it("classifies a busy or failing Anthropic as retryable, and a too-long prompt as too_long, without touching the accounts", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    const run = async (res: Response) => flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: (async () => res) as unknown as typeof fetch }).complete(REQ);
    await expect(run(respond(429, RATE, { "retry-after": "7" }))).rejects.toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 7000, retryable: true });
    await expect(run(respond(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).rejects.toMatchObject({ kind: "server", retryable: true });
    await expect(run(respond(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }))).rejects.toMatchObject({ kind: "too_long" });
    await expect(run(respond(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }))).rejects.toMatchObject({ kind: "refused", message: expect.stringContaining("claude-nope") });
    expect((await pool.readAccounts())[0]).toMatchObject({ status: "ok", limitedUntil: null });
  });
});

describe("the pool: same accounts, API keys only, fallback to the next one", () => {
  it("never uses a sign-in: an OAuth account first in the order is passed over and left as it was", async () => {
    await pool.addOAuthAccount({ label: "Max", email: "owner@example.com", tokens: { access: "oauth-access-token-0123456789", refresh: "oauth-refresh", expires: Date.now() + 8 * 3_600_000 } });
    await pool.addApiKeyAccount({ key: KEY_A });
    const fake = anthropic({ [KEY_A]: respond(200, OK_BODY) });
    await flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl }).complete(REQ);
    expect(fake.calls.map((c) => c.headers["x-api-key"])).toEqual([KEY_A]);
    expect(JSON.stringify(fake.calls)).not.toContain("oauth-access-token");
    expect((await pool.readAccounts()).map((a) => [a.kind, a.status])).toEqual([["oauth", "ok"], ["api_key", "ok"]]);
  });

  it("moves to the next account on a usage limit, rests the first in the pool, and keeps off it afterwards", async () => {
    await pool.addApiKeyAccount({ label: "A", key: KEY_A });
    await pool.addApiKeyAccount({ label: "B", key: KEY_B });
    const fake = anthropic({ [KEY_A]: respond(400, CREDIT_LOW), [KEY_B]: respond(200, OK_BODY) });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    expect((await client.complete(REQ)).text).toBe("[1][2]");
    expect(fake.calls.map((c) => c.headers["x-api-key"])).toEqual([KEY_A, KEY_B]);
    const [a, b] = await pool.readAccounts();
    expect(a).toMatchObject({ label: "A", status: "limited", limitKind: "credit" });
    expect(a.limitedUntil).toBeGreaterThan(Date.now());
    expect(b).toMatchObject({ label: "B", status: "ok" });
    await client.complete(REQ);
    expect(fake.calls.map((c) => c.headers["x-api-key"])).toEqual([KEY_A, KEY_B, KEY_B]);
  });

  it("reads Anthropic's own spend-limit answer as a limit too, with the date it names, and goes on with the next account", async () => {
    await pool.addApiKeyAccount({ label: "A", key: KEY_A });
    await pool.addApiKeyAccount({ label: "B", key: KEY_B });
    const back = new Date(Date.now() + 3 * 86_400_000);
    const day = back.toISOString().slice(0, 10);
    const SPEND = { type: "error", error: { type: "invalid_request_error", message: `You have reached your specified API usage limits. You will regain access on ${day} at 00:00 UTC.` } };
    const fake = anthropic({ [KEY_A]: respond(400, SPEND), [KEY_B]: respond(200, OK_BODY) });
    expect((await flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl }).complete(REQ)).text).toBe("[1][2]");
    expect(fake.calls.map((c) => c.headers["x-api-key"])).toEqual([KEY_A, KEY_B]);
    const [a] = await pool.readAccounts();
    expect(a).toMatchObject({ status: "limited", limitKind: "spend", limitedUntil: Date.parse(`${day}T00:00:00Z`) });
  });

  it("ends with the allowance reason when every key is at its limit, and asks no other provider", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    await pool.addApiKeyAccount({ key: KEY_B });
    const fake = anthropic({ [KEY_A]: respond(400, CREDIT_LOW), [KEY_B]: respond(400, CREDIT_LOW) });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    const err = await client.complete(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(flash.FlashCallError);
    expect(err).toMatchObject({ kind: "allowance", retryable: false });
    const stop = flash.allowanceStopOf(err);
    expect(stop).toMatchObject({ provider: "anthropic", kind: "weekly" });
    expect(stop?.resetAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(flash.allowanceSpentText(stop!)).toMatch(/^Every Anthropic account is at its limit, back at /);
    expect(fake.calls.every((c) => c.url === "https://api.anthropic.com/v1/messages")).toBe(true);
    // The next call does not even ask Anthropic: the pool knows.
    await expect(client.complete(REQ)).rejects.toMatchObject({ kind: "allowance" });
    expect(fake.calls).toHaveLength(2);
    expect(feature.resolveFeatureEngine).not.toHaveBeenCalled();
  });

  it("takes a key Anthropic refuses out of the order (after asking its own list) and answers from the next", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    await pool.addApiKeyAccount({ key: KEY_B });
    // The coding agent's own check of a refused key (GET /v1/models) says it is dead.
    vi.stubGlobal("fetch", vi.fn(async () => respond(401, BAD_KEY)));
    const fake = anthropic({ [KEY_A]: respond(401, BAD_KEY), [KEY_B]: respond(200, OK_BODY) });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    expect((await client.complete(REQ)).text).toBe("[1][2]");
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["revoked", "ok"]);
    // Every key refused: the reason is the refusal, never a move to another provider.
    fake.calls.length = 0;
    const alone = anthropic({ [KEY_B]: respond(401, BAD_KEY) });
    await expect(flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: alone.fetchImpl }).complete(REQ)).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["revoked", "revoked"]);
    await expect(client.complete(REQ)).rejects.toMatchObject({ kind: "auth" });
  });

  it("does not blame a key Anthropic never saw: a secret store that did not answer is said as such", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    // A root user reads a 000 file anyway; there is nothing to prove then.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const secrets = path.join(root, "data", "secrets.json");
    fs.chmodSync(secrets, 0o000);
    try {
      const fake = anthropic({ [KEY_A]: respond(200, OK_BODY) });
      await expect(flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl }).complete(REQ)).rejects.toMatchObject({
        kind: "no_credential",
        message: expect.stringMatching(/secret store did not answer/),
      });
      expect(fake.calls).toEqual([]);
      expect((await pool.readAccounts())[0].status).toBe("ok");
    } finally {
      fs.chmodSync(secrets, 0o600);
    }
  });

  it("still ends as an allowance when the pool could not record the limit it just met", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    // A root user writes into a read-only folder anyway; there is nothing to prove then.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const fake = anthropic({ [KEY_A]: respond(400, CREDIT_LOW) });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    fs.chmodSync(path.join(root, "data"), 0o555);
    try {
      const err = await client.complete(REQ).catch((e) => e);
      expect(err).toMatchObject({ kind: "allowance", retryable: false });
      expect(flash.allowanceStopOf(err)).toMatchObject({ provider: "anthropic" });
    } finally {
      fs.chmodSync(path.join(root, "data"), 0o755);
    }
  });

  it("goes on with a key the owner replaced while the call was in flight, once, and not with the one that was refused", async () => {
    const a = await pool.addApiKeyAccount({ key: KEY_A });
    const KEY_NEW = "sk-ant-api03-replacement-key-5566778899";
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-api-key"];
      seen.push(key);
      if (key === KEY_A) {
        await pool.replaceCredential(a.id, { kind: "api_key", key: KEY_NEW });
        return respond(401, BAD_KEY);
      }
      return respond(200, OK_BODY);
    });
    const client = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.complete(REQ)).text).toBe("[1][2]");
    expect(seen).toEqual([KEY_A, KEY_NEW]);
    // A key refused and NOT replaced is not asked again.
    const stuck = anthropic({ [KEY_NEW]: respond(401, BAD_KEY) });
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, { data: [] })));
    await expect(flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: stuck.fetchImpl }).complete(REQ)).rejects.toMatchObject({ kind: "auth" });
    expect(stuck.calls.length).toBeLessThanOrEqual(2);
  });

  it("counts a key whose week for THIS model is spent as at its limit, not as a secret store that did not answer", async () => {
    const a = await pool.addApiKeyAccount({ key: KEY_A });
    const until = Date.now() + 2 * 86_400_000;
    await pool.markModelLimited(a.id, { family: "haiku", name: "Haiku" }, until);
    const fake = anthropic({ [KEY_A]: respond(200, OK_BODY) });
    const haiku = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    const err = await haiku.complete(REQ).catch((e) => e);
    expect(err).toMatchObject({ kind: "allowance" });
    expect(flash.allowanceStopOf(err)).toMatchObject({ provider: "anthropic", resetAt: new Date(until).toISOString() });
    expect(fake.calls).toEqual([]);
    // Another model of the same account is not limited.
    const sonnet = flash.createAnthropicFlashClient({ model: "claude-sonnet-5-5", fetchImpl: fake.fetchImpl });
    expect((await sonnet.complete(REQ)).text).toBe("[1][2]");
  });

  it("refuses a route with its own code when the owner chose Anthropic and no key is saved, so the message reaches the owner", async () => {
    const { noEngineRefusal } = await import("@/lib/prime-radiant/route-helpers");
    const res = noEngineRefusal("no_anthropic_key");
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: flash.NO_ANTHROPIC_KEY_MESSAGE, code: "no_anthropic_key" });
  });

  it("says no_credential when no API key is saved, a subscription sign-in included", async () => {
    await pool.addOAuthAccount({ label: "Max", email: "owner@example.com", tokens: { access: "oauth-access-token-0123456789", refresh: "oauth-refresh", expires: Date.now() + 8 * 3_600_000 } });
    const fake = anthropic({});
    await expect(flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl }).complete(REQ)).rejects.toMatchObject({
      kind: "no_credential",
      message: flash.NO_ANTHROPIC_KEY_MESSAGE,
    });
    expect(fake.calls).toEqual([]);
  });

  it("never lets a credential out: not in an error, a note, data/config.json or the settings file", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    choose("anthropic");
    const fake = anthropic({ [KEY_A]: respond(403, { type: "error", error: { type: "permission_error", message: `denied for ${KEY_A}` } }) });
    const err = await flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl }).complete(REQ).catch((e) => e);
    expect(err).toMatchObject({ kind: "refused" });
    expect(JSON.stringify({ message: err.message, stack: String(err.stack).includes(KEY_A) })).not.toContain(KEY_A.slice(0, 20));
    const config = fs.existsSync(path.join(root, "data", "config.json")) ? fs.readFileSync(path.join(root, "data", "config.json"), "utf-8") : "";
    expect(config).not.toContain(KEY_A);
    expect(fs.readFileSync(path.join(root, "prime-radiant", "settings.json"), "utf-8")).not.toContain("sk-ant");
  });
});

describe("which provider answers", () => {
  it("is the engine feature-engine names on a box that never chose, whatever accounts it holds", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    expect(settings.readSettings().model).toEqual({ provider: "auto", anthropicModel: "claude-sonnet-5-5" });
    const client = await flash.flashClient();
    expect(client.engine).toBe("clawbox-ai");
    expect(await flash.flashEngine()).toBe("clawbox-ai");
    expect(await flash.flashUnavailableReason()).toBeNull();
  });

  it("is Anthropic, with the chosen model, once the owner picks it; unavailable with no usable key", async () => {
    choose("anthropic", "claude-opus-5-5");
    expect(await flash.flashUnavailableReason()).toBe("no_anthropic_key");
    expect(await flash.flashAvailable()).toBe(false);
    await pool.addApiKeyAccount({ key: KEY_A });
    const client = await flash.flashClient();
    expect(client).toMatchObject({ model: "claude-opus-5-5", engine: "anthropic" });
    expect(client.budget).toBeUndefined();
    expect(await flash.flashEngine()).toBe("anthropic");
    expect(await flash.flashUnavailableReason()).toBeNull();
    expect(feature.resolveFeatureEngine).not.toHaveBeenCalled();
  });

  it("is beaten by the local-only AI lock: the choice is not honoured and nothing is sent to Anthropic", async () => {
    await pool.addApiKeyAccount({ key: KEY_A });
    choose("anthropic");
    lock.on = true;
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "none", reason: "cloud_ai_locked" });
    expect(await flash.flashEngine()).toBeNull();
    expect(await flash.flashUnavailableReason()).toBe("cloud_ai_locked");
    await expect((await flash.flashClient()).complete(REQ)).rejects.toMatchObject({ kind: "no_engine" });
    // A client chosen before the lock went on stops at its next call.
    lock.on = false;
    const fake = anthropic({ [KEY_A]: respond(200, OK_BODY) });
    const early = flash.createAnthropicFlashClient({ model: "claude-haiku-5-5", fetchImpl: fake.fetchImpl });
    lock.on = true;
    await expect(early.complete(REQ)).rejects.toMatchObject({ kind: "no_engine" });
    expect(fake.calls).toEqual([]);
  });
});

describe("the setting", () => {
  it("reads and saves only the two known providers and the models Prime Radiant has a rate for", () => {
    expect(settings.defaultSettings().model).toEqual({ provider: "auto", anthropicModel: "claude-sonnet-5-5" });
    expect(() => settings.writeSettings({ model: { provider: "openai" } })).toThrow(/model\.provider/);
    expect(() => settings.writeSettings({ model: { anthropicModel: "claude-nope" } })).toThrow(/model\.anthropicModel/);
    expect(() => settings.readSettingsPatch({ model: { key: "sk-ant-x" } })).toThrow(/Unknown setting: model\.key/);
    expect(settings.writeSettings({ model: { provider: "anthropic", anthropicModel: "claude-haiku-5-5" } }).model).toEqual({ provider: "anthropic", anthropicModel: "claude-haiku-5-5" });
    expect(settings.writeSettings({ model: null }).model.provider).toBe("auto");
  });

  it("offers only models that have a list rate, all of them models the coding agent knows", async () => {
    const { PRIME_RADIANT_CLAUDE_MODELS, DEFAULT_COST_RATES } = await import("@/lib/prime-radiant/cost-rates");
    const { ANTHROPIC_MODELS } = await import("@/lib/coding-provider");
    for (const id of PRIME_RADIANT_CLAUDE_MODELS) {
      expect(ANTHROPIC_MODELS as readonly string[]).toContain(id);
      expect(DEFAULT_COST_RATES.models[id].output).toBeGreaterThan(0);
    }
  });
});
