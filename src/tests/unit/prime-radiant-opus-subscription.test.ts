/**
 * The Opus tier on the owner's Claude subscription: which account answers,
 * the headless `claude` call (no tools, no MCP, a temp folder, a deadline),
 * the usage-limit stop, yielding to a coding-agent run, the nightly page cap
 * and the `subscription` cost basis. Every CLI is a fake; fixtures are
 * synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import {
  OpusLimitError,
  OpusUnavailableError,
  OpusYieldError,
  runOpusTier,
  setOpusClientOverride,
  type OpusClient,
} from "@/lib/prime-radiant/opus";
import {
  createSubscriptionOpusClient,
  detectOpusSource,
  parseCliResult,
  resolveOpusClient,
  subscriptionArgs,
  type CliRunner,
} from "@/lib/prime-radiant/opus-source";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { readCostSummary } from "@/lib/prime-radiant/runs";
import { DEFAULT_OPUS_MAX_PAGES, readSettings, writeSettings, SettingsError } from "@/lib/prime-radiant/settings";
import { readPage, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-opus-sub-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterEach(() => setOpusClientOverride(null));

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

function okResult(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 90, output_tokens: 40 },
    ...extra,
  });
}

function errResult(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, api_error_status: null, ...extra });
}

function fakeRunner(stdout: string, code = 0, stderr = ""): CliRunner & { calls: Array<{ bin: string; args: readonly string[]; input: string; cwd: string; env: Record<string, string> }> } {
  const calls: Array<{ bin: string; args: readonly string[]; input: string; cwd: string; env: Record<string, string> }> = [];
  const runner = (async (bin, args, input, options) => {
    calls.push({ bin, args, input, cwd: options.cwd, env: options.env });
    expect(fs.existsSync(options.cwd)).toBe(true);
    return { code, stdout, stderr, timedOut: false };
  }) as CliRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

const notBusy = async () => null;

describe("which account answers", () => {
  it("an API key first, without asking about the subscription", async () => {
    const subscriptionUsable = vi.fn(async () => true);
    const found = await detectOpusSource({ readKey: async () => "sk-ant-api03-placeholder", subscriptionUsable });
    expect(found.source).toBe("api_key");
    expect(subscriptionUsable).not.toHaveBeenCalled();
  });

  it("the subscription when there is no key, the sign-in is usable and claude is installed", async () => {
    const found = await detectOpusSource({
      readKey: async () => null,
      subscriptionUsable: async () => true,
      claude: async () => ({ path: "/opt/fake/claude", pathValue: "/opt/fake" }),
    });
    expect(found).toMatchObject({ source: "subscription", claude: { path: "/opt/fake/claude" } });
  });

  it("none without a key and a usable sign-in, or without the CLI", async () => {
    expect((await detectOpusSource({ readKey: async () => null, subscriptionUsable: async () => false })).source).toBe("none");
    const noCli = await detectOpusSource({ readKey: async () => null, subscriptionUsable: async () => true, claude: async () => null });
    expect(noCli).toMatchObject({ source: "none", reason: "the claude CLI is not installed" });
    const throwing = await detectOpusSource({
      readKey: async () => {
        throw new Error("store unreadable");
      },
      subscriptionUsable: async () => {
        throw new Error("pool unreadable");
      },
    });
    expect(throwing.source).toBe("none");
  });

  it("resolves a client per source, and a test override wins", async () => {
    const key = await resolveOpusClient("claude-opus-5-5", { readKey: async () => "sk-ant-api03-placeholder" });
    expect(key.source).toBe("api_key");
    const sub = await resolveOpusClient("claude-opus-5-5", {
      readKey: async () => null,
      subscriptionUsable: async () => true,
      claude: async () => ({ path: "/opt/fake/claude", pathValue: "/opt/fake" }),
    });
    expect(sub.source).toBe("subscription");
    const none = await resolveOpusClient("claude-opus-5-5", { readKey: async () => null, subscriptionUsable: async () => false });
    expect(none.source).toBe("none");
    await expect(none.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toBeInstanceOf(OpusUnavailableError);
    const override: OpusClient = { model: "claude-opus-5-5", complete: vi.fn() };
    setOpusClientOverride(override);
    expect(await resolveOpusClient("claude-opus-5-5", { readKey: async () => "sk-ant-api03-placeholder" })).toBe(override);
  });
});

describe("the subscription client", () => {
  it("runs claude headless: Opus, JSON, no tools, no MCP, no settings, one turn, a temp folder, no API key", async () => {
    const runner = fakeRunner(okResult('[{"k":0,"verdict":"ok","claims":[],"note":"fine"}]'));
    const client = createSubscriptionOpusClient("claude-opus-5-5", { claudePath: "/opt/fake/claude", runner, yieldReason: notBusy, pathValue: "/opt/fake:/usr/bin" });
    const out = await client.complete({ system: "SYSTEM", user: "PAGES", maxTokens: 8000 });
    expect(out.text).toContain('"verdict":"ok"');
    expect(out.usage).toEqual({ promptTokens: 600, completionTokens: 40, cacheHitTokens: 90 });
    const call = runner.calls[0];
    expect(call.bin).toBe("/opt/fake/claude");
    expect(call.input).toBe("PAGES");
    expect(call.args).toEqual(subscriptionArgs("claude-opus-5-5", "SYSTEM"));
    const args = [...call.args];
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5-5"]);
    expect(args.slice(-2)).toEqual(["--tools", ""]);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(call.env.PATH).toBe("/opt/fake:/usr/bin");
    expect(call.env.HOME).toBe(os.homedir());
    expect(path.basename(call.cwd)).toMatch(/^prime-radiant-opus-/);
    expect(fs.existsSync(call.cwd)).toBe(false);
  });

  it("stops on a usage limit, in JSON or in plain words, and on a 429", async () => {
    const make = (stdout: string, code = 1) =>
      createSubscriptionOpusClient("claude-opus-5-5", { claudePath: "/x/claude", runner: fakeRunner(stdout, code), yieldReason: notBusy });
    const req = { system: "s", user: "u", maxTokens: 10 };
    await expect(make(errResult("Claude AI usage limit reached|1758231000")).complete(req)).rejects.toBeInstanceOf(OpusLimitError);
    await expect(make("You've hit your session limit · resets 10:50pm\n").complete(req)).rejects.toBeInstanceOf(OpusLimitError);
    await expect(make(errResult("API Error: overloaded", { api_error_status: 429 })).complete(req)).rejects.toBeInstanceOf(OpusLimitError);
    const auth = make(errResult("Invalid API key · Please run /login")).complete(req);
    await expect(auth).rejects.toBeInstanceOf(OpusUnavailableError);
    await expect(auth).rejects.not.toBeInstanceOf(OpusLimitError);
    await expect(make(okResult("   "), 0).complete(req)).rejects.toThrow(/no text/);
  });

  it("yields to a coding-agent run without starting the CLI", async () => {
    const runner = fakeRunner(okResult("[]"));
    const client = createSubscriptionOpusClient("claude-opus-5-5", { claudePath: "/x/claude", runner, yieldReason: async () => "a coding-agent run is working" });
    await expect(client.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toBeInstanceOf(OpusYieldError);
    expect(runner.calls).toHaveLength(0);
  });

  it("reads the JSON result line among other output", () => {
    expect(parseCliResult(`warning: something\n${okResult("[1]")}\n`)?.result).toBe("[1]");
    expect(parseCliResult("not json")).toBeNull();
  });

  it("really spawns the CLI with an empty environment, and ends one that does not answer in time", async () => {
    const dir = fs.mkdtempSync(path.join(base, "bin-"));
    const fake = path.join(dir, "claude");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\ncat > /dev/null\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"key=%s;dir=%s","usage":{"input_tokens":1,"output_tokens":1}}\\n' "\${ANTHROPIC_API_KEY:-none}" "\${CLAUDE_CONFIG_DIR:-none}"\n`,
      { mode: 0o755 },
    );
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-pass";
    try {
      const client = createSubscriptionOpusClient("claude-opus-5-5", { claudePath: fake, yieldReason: notBusy, pathValue: "/usr/bin:/bin" });
      await expect(client.complete({ system: "s", user: "u", maxTokens: 10 })).resolves.toMatchObject({ text: "key=none;dir=none" });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
    const slow = path.join(dir, "slow-claude");
    fs.writeFileSync(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const client = createSubscriptionOpusClient("claude-opus-5-5", { claudePath: slow, yieldReason: notBusy, pathValue: "/usr/bin:/bin", timeoutMs: 300 });
    const started = Date.now();
    await expect(client.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("the tier on a subscription", () => {
  const PAGES: Record<string, string> = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`concepts/p${i}.md`, pageText({ title: `Page ${i}`, claims: [claim(`acme-ops/p${i}/fact`, `Fact number ${i} holds.`)] })]),
  );
  const queue = Object.keys(PAGES).map((p) => ({ path: p, reason: "sample" as const }));

  async function seed() {
    await vaultOperation("seed: pages", async (tx) => {
      for (const [p, t] of Object.entries(PAGES)) await tx.write(p, t);
    });
  }

  function subscription(complete: OpusClient["complete"]): OpusClient {
    return { model: "claude-opus-5-5", source: "subscription", complete };
  }

  const answer = (count: number) => ({
    text: JSON.stringify(Array.from({ length: count }, (_, k) => ({ k, verdict: "ok", claims: [], note: "fine" }))),
    model: "claude-opus-5-5",
    usage: { promptTokens: 3000, completionTokens: 200, cacheHitTokens: 0 },
  });

  it("runs without a rate or a dollar cap, records $0 under the subscription basis", async () => {
    await seed();
    const client = subscription(async (req) => answer((JSON.parse(req.user.slice(req.user.indexOf("["))) as unknown[]).length));
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 0.01, maxPages: 100, rates: { ...DEFAULT_COST_RATES, models: {} }, client, runId: "run-0000000000cc" }),
    );
    expect(op.result).toMatchObject({ source: "subscription", reviewed: 6, pending: 0, calls: 2, usdEstimate: 0, stopped: null });
    const costs = readCostSummary(vaultDir(), DEFAULT_COST_RATES);
    expect(costs.totals).toMatchObject({ calls: 2, tokensIn: 6000, tokensOut: 400, usdEstimate: 0 });
    expect(costs.byBasis).toEqual([{ basis: "subscription", calls: 2, tokensIn: 6000, tokensOut: 400, usdEstimate: 0 }]);
  });

  it("stops at the nightly page cap and leaves the rest pending", async () => {
    await seed();
    const complete = vi.fn(async () => answer(4));
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 2, maxPages: 4, rates: DEFAULT_COST_RATES, client: subscription(complete) }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(op.result).toMatchObject({ reviewed: 4, pending: 2, stopped: "pages", maxPages: 4 });
    const last = await readPage("concepts/p5.md");
    expect(last!.parsed.ok && last!.parsed.frontmatter.opus_pending).toBe(true);
  });

  it("the page cap holds for an API key too", async () => {
    await seed();
    const complete = vi.fn(async () => answer(4));
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 100, maxPages: 5, rates: DEFAULT_COST_RATES, client: { model: "claude-opus-5-5", complete } }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(op.result).toMatchObject({ source: "api_key", stopped: "pages", pending: 2 });
  });

  it("stops for the night at a usage limit; everything not read waits", async () => {
    await seed();
    let calls = 0;
    const client = subscription(async () => {
      calls += 1;
      if (calls === 2) throw new OpusLimitError("session limit");
      return answer(4);
    });
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 2, maxPages: 100, rates: DEFAULT_COST_RATES, client }),
    );
    expect(calls).toBe(2);
    expect(op.result).toMatchObject({ reviewed: 4, pending: 2, stopped: "limit", calls: 1 });
    expect(op.result.notes.join(" ")).toMatch(/Claude subscription reached its usage limit/);
  });

  it("yields to a coding-agent run: nothing is read, every page waits", async () => {
    await seed();
    const client = subscription(async () => {
      throw new OpusYieldError("a coding-agent run is working");
    });
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 2, maxPages: 100, rates: DEFAULT_COST_RATES, client }),
    );
    expect(op.result).toMatchObject({ reviewed: 0, pending: 6, stopped: "busy", calls: 0 });
  });
});

describe("the page cap setting", () => {
  it("defaults, accepts a whole number in range and refuses anything else", () => {
    expect(readSettings().opus.maxPages).toBe(DEFAULT_OPUS_MAX_PAGES);
    expect(writeSettings({ opus: { maxPages: 40 } }).opus.maxPages).toBe(40);
    for (const bad of [3, 2001, 4.5, "40"]) expect(() => writeSettings({ opus: { maxPages: bad } })).toThrow(SettingsError);
    expect(readSettings().opus.maxPages).toBe(40);
  });
});
