import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { CLI_STDOUT, GATEWAY_ANSWER } from "../../fixtures/openclaw-models-list-2026.11.3";

// ON A JETSON THE CATALOGUE ASKS THE RUNNING GATEWAY, AND THE CLI WHEN IT MUST.
//
// At the pinned core, `openclaw models list --provider <p> --all --json` sends
// a running gateway ONE `models.list` and prints its rows. Forking a whole CLI
// for that cost a Jetson about 30 s of serial processes on the first picker
// open after every web-server start (five forks, measured). On a Jetson the
// route now sends that same request over the gateway socket, but only while no
// counted provider change is waiting for its first answer (right after a save
// the gateway may not have applied it yet) and the provider's last attempt did
// not fail (catalog-gateway-failed-provider.test.ts); those enumerations take
// the CLI exactly as before, and so does every case where no gateway answers.
// Any other host keeps the CLI for everything.
//
// No GET in this file, so the boot warm-up's timers never start. Each test
// loads the route afresh: its generation, backoff and single-flight state are
// module-level, and one test's must not decide another's transport. Every case
// runs on a Jetson unless it says otherwise.

const spawnMock = vi.hoisted(() => vi.fn());
const gatewayCall = vi.hoisted(() => vi.fn());
// The Jetson marker (`/etc/nv_tegra_release`), moved to a file this suite
// creates and removes: the route reads it at every fork.
const TEGRA_MARKER = vi.hoisted(() => `/tmp/clawbox-catalog-gateway-first-test-${process.pid}-nv_tegra_release`);

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/ollama-size-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ollama-size-cap")>()),
  TEGRA_RELEASE: TEGRA_MARKER,
}));
// The real module's classes, so the route's `instanceof` checks hold; only the
// socket call itself is replaced.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: gatewayCall,
}));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));
// A per-PROCESS data root, as the other catalogue suites take.
const DATA_DIR = `/tmp/clawbox-catalog-gateway-first-test-${process.pid}`;
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-gateway-first-test-${process.pid}` }));
// A published xai catalogue would otherwise load the chat-model route behind it.
vi.mock("@/lib/provider-follow-newest", () => ({ followNewestModelOnBox: vi.fn(async () => {}) }));

type Route = typeof import("@/app/setup-api/ai-models/catalog/route");
type GatewayWs = typeof import("@/lib/openclaw-gateway-ws");
let route: Route;
let ws: GatewayWs;

interface CliRow {
  key: string;
  name: string;
  input?: string;
  contextWindow: number;
  available: boolean | null;
  tags: string[];
}
interface CliList { count: number; models: CliRow[] }

/**
 * A gateway answer for the same rows, rebuilt from a CLI fixture. Enough for
 * the cases that ask WHICH transport answers; whether the two answers agree is
 * the pinned fixture's case (the first one below).
 */
function gatewayRows(list: CliList): Record<string, unknown>[] {
  return list.models.map((row) => {
    const slash = row.key.indexOf("/");
    return {
      provider: row.key.slice(0, slash),
      id: row.key.slice(slash + 1),
      name: row.name,
      ...(row.input ? { input: row.input.split("+") } : {}),
      contextWindow: row.contextWindow,
      available: row.available,
      tags: row.tags,
    };
  });
}

const ANTHROPIC: CliList = {
  count: 2,
  models: [
    { key: "anthropic/claude-sonnet-5", name: "Sonnet 5", input: "text+image", contextWindow: 1_000_000, available: true, tags: ["default"] },
    { key: "anthropic/claude-opus-5", name: "Opus 5", input: "text+image", contextWindow: 1_000_000, available: true, tags: [] },
  ],
};

const XAI: CliList = {
  count: 2,
  models: [
    { key: "xai/grok-4.7", name: "Grok 4.7", input: "text+image", contextWindow: 500_000, available: true, tags: ["default"] },
    { key: "xai/grok-4.6", name: "Grok 4.6", input: "text", contextWindow: 500_000, available: true, tags: [] },
  ],
};

/** openai on a box whose key is not saved yet: one row. */
const PRE: CliList = {
  count: 1,
  models: [
    { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", input: "text+image", contextWindow: 400_000, available: true, tags: ["default"] },
  ],
};

/** The same box once the key is saved and the plugin is on. */
const LINKED: CliList = {
  count: 3,
  models: [
    ...PRE.models,
    { key: "openai/gpt-5.5", name: "GPT-5.5", input: "text+image", contextWindow: 400_000, available: true, tags: [] },
    { key: "openai/gpt-5.4", name: "GPT-5.4", input: "text+image", contextWindow: 1_000_000, available: true, tags: [] },
  ],
};

const GOOGLE: CliList = {
  count: 2,
  models: [
    { key: "google/gemini-3-pro", name: "Gemini 3 Pro", input: "text+image", contextWindow: 1_000_000, available: true, tags: ["default"] },
    { key: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", input: "text+image", contextWindow: 1_000_000, available: true, tags: [] },
  ],
};

function newChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function fakeChild(json: unknown) {
  const child = newChild();
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

/** An `openclaw models list` fork that has started and not answered yet. */
function heldChild(json: unknown) {
  const child = newChild();
  return {
    child,
    release() {
      child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
      child.emit("close", 0);
    },
  };
}

/** Every CLI fork answers `json`. */
function cliAnswers(json: unknown): void {
  spawnMock.mockImplementation(() => fakeChild(json));
}

/** The argv of every `openclaw` the route forked. */
function cliArgv(): string[] {
  return spawnMock.mock.calls.map(([, args]) => (args as string[]).join(" "));
}

function cacheFile(provider: string): string {
  return path.join(DATA_DIR, "catalog-cache", `${provider}.json`);
}

function readCache(provider: string): { models: Array<Record<string, unknown>>; source?: string; fetchedAt: number } {
  return JSON.parse(fs.readFileSync(cacheFile(provider), "utf8"));
}

function cachedIds(provider: string): string[] {
  return readCache(provider).models.map((m) => String(m.id)).sort();
}

/** The recorded model count per provider (`_enumerations.json`), or nothing. */
function recordedCount(provider: string): number | undefined {
  const file = path.join(DATA_DIR, "catalog-cache", "_enumerations.json");
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: Record<string, { models: number }> };
  return parsed.providers?.[provider]?.models;
}

/** Let a detached refresh get as far as it is going to get. */
function settle(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function published(provider: string): Promise<void> {
  await vi.waitFor(() => expect(fs.existsSync(cacheFile(provider))).toBe(true), { timeout: 4000, interval: 25 });
  await settle();
}

/** This host is a Jetson (the marker is there), or it is not. */
function jetson(on: boolean): void {
  if (on) fs.writeFileSync(TEGRA_MARKER, "");
  else fs.rmSync(TEGRA_MARKER, { force: true });
}

/** Every line the route logs, warns or errors, from here on. */
function catalogLogs(): { lines: string[] } {
  const out = { lines: [] as string[] };
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      out.lines.push(args.map(String).join(" "));
    });
  }
  return out;
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
  spawnMock.mockReset();
  gatewayCall.mockReset();
  jetson(true);
  fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  vi.resetModules();
  route = await import("@/app/setup-api/ai-models/catalog/route");
  ws = await import("@/lib/openclaw-gateway-ws");
});

afterEach(() => {
  // Only the console spies; the hoisted mocks are reset in `beforeEach`.
  vi.restoreAllMocks();
  jetson(false);
});

describe("catalog — off a Jetson, every enumeration is the CLI fork it was", () => {
  it.each([
    ["anthropic", ANTHROPIC, ["models", "list", "--provider", "anthropic", "--all", "--json"]],
    ["xai", XAI, ["models", "list", "--provider", "xai", "--all", "--json", "--refresh"]],
  ])("%s: forks the CLI exactly as before and never opens the socket", async (provider, list, argv) => {
    jetson(false);
    const logs = catalogLogs();
    // A gateway that WOULD answer: only the host keeps the route off it.
    gatewayCall.mockResolvedValue({ models: gatewayRows(list) });
    cliAnswers(list);

    route.refreshInBackground(provider);
    await published(provider);

    expect(gatewayCall).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("openclaw", argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME ?? "/home/clawbox" },
    });
    expect(cachedIds(provider)).toEqual(list.models.map((m) => m.key.split("/")[1]).sort());
    expect(readCache(provider).source).toBe("live");
    expect(logs.lines.filter((line) => /gateway|socket/i.test(line))).toEqual([]);
  });

  it("logs an empty CLI answer with beta's own line", async () => {
    jetson(false);
    const logs = catalogLogs();
    gatewayCall.mockResolvedValue({ models: [] });
    cliAnswers({ count: 0, models: [] });

    route.refreshInBackground("google");
    await vi.waitFor(() => expect(recordedCount("google")).toBe(0), { timeout: 4000, interval: 25 });
    await settle();

    expect(gatewayCall).not.toHaveBeenCalled();
    expect(logs.lines).toEqual([
      "[catalog] google: live enumeration returned no models, keeping the previous catalogue (the CLI gave no reason)",
    ]);
  });

  it("reads the marker at every fork, not once: off, on, off again in one module", async () => {
    gatewayCall.mockResolvedValue({ models: gatewayRows(GOOGLE) });
    cliAnswers(GOOGLE);

    jetson(false);
    route.refreshInBackground("google");
    await published("google");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(gatewayCall).not.toHaveBeenCalled();

    jetson(true);
    route.refreshInBackground("google");
    await vi.waitFor(() => expect(gatewayCall).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    jetson(false);
    route.refreshInBackground("google");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2), { timeout: 4000, interval: 25 });
    await settle();
    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(cliArgv()).toEqual([
      "models list --provider google --all --json",
      "models list --provider google --all --json",
    ]);
  });
});

describe("catalog — an enumeration with no change pending asks the running gateway", () => {
  it("sends the CLI's own request over the socket and publishes what the CLI would have", async () => {
    // A pinned gateway answer, and what the pinned CLI printed for it: neither
    // built from the other (see the fixture's header).
    cliAnswers(CLI_STDOUT);
    gatewayCall.mockResolvedValue(GATEWAY_ANSWER);

    route.refreshInBackground("anthropic");
    await published("anthropic");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(gatewayCall).toHaveBeenCalledTimes(1);
    const [method, params, options] = gatewayCall.mock.calls[0];
    expect(method).toBe("models.list");
    // `openclaw models list --provider anthropic --all --json`, exactly.
    expect(params).toEqual({ view: "all", provider: "anthropic", includeDetails: true });
    expect("refresh" in (params as object)).toBe(false);
    expect(options).toEqual({ timeoutMs: 10_000, requiredCapabilities: ["published-model-catalog"] });

    const viaGateway = readCache("anthropic");
    expect(viaGateway.source).toBe("live");
    expect(viaGateway.models.map(({ id, label, contextWindow, input, isDefault }) => ({ id, label, contextWindow, input, isDefault })))
      .toEqual([
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1_000_000, input: "text+image", isDefault: true },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000, input: "text+image", isDefault: undefined },
        // Haiku is listed `available: false`: not offered, on either path.
      ]);

    // And it is the very catalogue the CLI's stdout publishes for the same gateway answer.
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
    vi.resetModules();
    route = await import("@/app/setup-api/ai-models/catalog/route");
    ws = await import("@/lib/openclaw-gateway-ws");
    gatewayCall.mockRejectedValue(new ws.GatewayWsUnavailableError("connect ECONNREFUSED"));
    route.refreshInBackground("anthropic");
    await published("anthropic");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readCache("anthropic").models).toEqual(viaGateway.models);
  });

  it("asks a provider whose default follows the newest model to refresh, with the CLI's refresh timeout", async () => {
    cliAnswers(XAI);
    gatewayCall.mockResolvedValue({ models: gatewayRows(XAI) });

    route.refreshInBackground("xai");
    await published("xai");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(gatewayCall).toHaveBeenCalledWith(
      "models.list",
      { view: "all", provider: "xai", includeDetails: true, refresh: true },
      { timeoutMs: 210_000, requiredCapabilities: ["published-model-catalog"] },
    );
    expect(cachedIds("xai")).toEqual(["grok-4.6", "grok-4.7"]);
  });
});

describe("catalog — a counted provider change is answered by the CLI, never by the socket", () => {
  it("asks the gateway with nothing pending, the CLI for the change, then the gateway again", async () => {
    // Phase A: nothing has changed; the gateway answers.
    gatewayCall.mockResolvedValue({ models: gatewayRows(PRE) });
    cliAnswers(LINKED);
    route.refreshInBackground("openai");
    await published("openai");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(cachedIds("openai")).toEqual(["gpt-5.6-sol"]);
    expect(gatewayCall).toHaveBeenCalledTimes(1);

    // Phase B: a key is saved. The gateway still answers PRE — it has not
    // applied the save yet — and is never asked; the CLI answers the change.
    route.notifyProviderSetChanged("openai");
    await vi.waitFor(() => expect(cachedIds("openai")).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]), { timeout: 4000, interval: 25 });
    await settle();
    expect(cliArgv()).toEqual(["models list --provider openai --all --json"]);
    expect(gatewayCall).toHaveBeenCalledTimes(1);

    // Phase C: the change has its answer; the next plain enumeration asks the gateway.
    gatewayCall.mockResolvedValue({ models: gatewayRows(LINKED) });
    route.refreshInBackground("openai");
    await vi.waitFor(() => expect(gatewayCall).toHaveBeenCalledTimes(2), { timeout: 4000, interval: 25 });
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(cachedIds("openai")).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]);
  });

  // These two pass on a build that never asks the gateway; they pin that a
  // pending change keeps every fork that answers it on the CLI.
  it("re-enumerates a second change on the CLI after the in-flight CLI fork is discarded", async () => {
    gatewayCall.mockResolvedValue({ models: gatewayRows(PRE) });
    cliAnswers(PRE);
    route.refreshInBackground("openai");
    await published("openai");
    gatewayCall.mockClear();
    spawnMock.mockClear();

    const held = heldChild(LINKED);
    let forks = 0;
    spawnMock.mockImplementation(() => (++forks === 1 ? held.child : fakeChild(LINKED)));
    route.notifyProviderSetChanged("openai");
    await settle();
    expect(forks).toBe(1);
    route.notifyProviderSetChanged("openai");
    await settle();
    expect(forks).toBe(1);

    held.release();
    await vi.waitFor(() => expect(forks).toBe(2), { timeout: 4000, interval: 25 });
    await vi.waitFor(() => expect(cachedIds("openai")).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]), { timeout: 4000, interval: 25 });
    await settle();
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("keeps asking the CLI after the change's fork was refused, until a post-change answer is published", async () => {
    gatewayCall.mockResolvedValue({ models: gatewayRows(PRE) });
    cliAnswers(PRE);
    route.refreshInBackground("openai");
    await published("openai");
    gatewayCall.mockClear();
    spawnMock.mockClear();

    cliAnswers({ ok: false, error: { message: "OpenClaw config could not be read" } });
    route.notifyProviderSetChanged("openai");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
    await settle();
    expect(cachedIds("openai")).toEqual(["gpt-5.6-sol"]);

    cliAnswers(LINKED);
    route.refreshInBackground("openai", { clientHasNoCurrentAnswer: true });
    await vi.waitFor(() => expect(cachedIds("openai")).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]), { timeout: 4000, interval: 25 });
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(gatewayCall).not.toHaveBeenCalled();
  });
});

describe("catalog — what each gateway outcome does", () => {
  it("falls back to today's CLI fork when no gateway is there to answer", async () => {
    const logs = catalogLogs();
    gatewayCall.mockRejectedValue(new ws.GatewayWsUnavailableError("gateway does not advertise published-model-catalog"));
    cliAnswers(GOOGLE);

    route.refreshInBackground("google");
    await published("google");

    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(cliArgv()).toEqual(["models list --provider google --all --json"]);
    expect(gatewayCall.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
    expect(cachedIds("google")).toEqual(["gemini-2.5-flash", "gemini-3-pro"]);
    expect(logs.lines.filter((line) => line.includes("asking the CLI"))).toEqual([
      "[catalog] google: the gateway did not answer (gateway does not advertise published-model-catalog), asking the CLI",
    ]);
  });

  it("falls back to the CLI on any other throw before an answer", async () => {
    gatewayCall.mockRejectedValue(new Error("socket hang up"));
    cliAnswers(GOOGLE);

    route.refreshInBackground("google");
    await published("google");

    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(cliArgv()).toEqual(["models list --provider google --all --json"]);
    expect(cachedIds("google")).toEqual(["gemini-2.5-flash", "gemini-3-pro"]);
  });

  // The retry inside one attempt asks every 1.5 s for up to 25 s. On the CLI each
  // ask is a fork of seconds; on the socket it would be a round trip, so the
  // gateway is asked once and the retries are the CLI's, spaced as before.
  it("asks the CLI again through the core's maintenance refusal, as it always has", async () => {
    gatewayCall
      .mockRejectedValueOnce(new ws.GatewayRpcError(
        "OpenClaw state at openclaw.sqlite is undergoing offline maintenance; retry when it finishes.",
        "UNAVAILABLE",
      ))
      .mockResolvedValue({ models: gatewayRows(GOOGLE) });
    cliAnswers(GOOGLE);

    route.refreshInBackground("google");
    await vi.waitFor(() => expect(fs.existsSync(cacheFile("google"))).toBe(true), { timeout: 4000, interval: 25 });
    await settle();

    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(cliArgv()).toEqual(["models list --provider google --all --json"]);
    expect(gatewayCall.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
    expect(cachedIds("google")).toEqual(["gemini-2.5-flash", "gemini-3-pro"]);
  }, 10_000);

  // What the pinned CLI prints for a refused request (`ok: false`): the
  // previous catalogue stays, the backoff is recorded, and it is never a clean
  // zero. The CLI does not resend a refused `models.list` either.
  it.each([
    ["INVALID_REQUEST", () => new ws.GatewayRpcError('Unknown provider filter "google"', "INVALID_REQUEST")],
    ["UNAVAILABLE", () => new ws.GatewayRpcError("model catalog is not ready", "UNAVAILABLE")],
    ["a call-stage timeout", () => new ws.GatewayWsCallTimeoutError("models.list timed out after 10000ms")],
  ])("keeps the previous catalogue and asks no CLI on %s", async (_label, refusal) => {
    gatewayCall.mockResolvedValue({ models: gatewayRows(GOOGLE) });
    cliAnswers(GOOGLE);
    route.refreshInBackground("google");
    await published("google");
    const before = readCache("google");
    expect(recordedCount("google")).toBe(2);

    gatewayCall.mockReset();
    gatewayCall.mockRejectedValue(refusal());
    route.refreshInBackground("google");
    await vi.waitFor(() => expect(gatewayCall).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
    await settle();

    expect(readCache("google")).toEqual(before);
    expect(recordedCount("google")).toBe(2);

    // Inside the backoff, a plain enumeration starts nothing at all.
    route.refreshInBackground("google");
    await settle();
    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ["models that is not a list", { models: { "gemini-3-pro": {} } }],
    ["a row with no string provider", { models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }] }],
  ])("publishes nothing, asks no CLI and records no zero for %s", async (_label, payload) => {
    gatewayCall.mockResolvedValue(payload);
    cliAnswers(GOOGLE);

    route.refreshInBackground("google");
    await vi.waitFor(() => expect(gatewayCall).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
    await settle();

    expect(fs.existsSync(cacheFile("google"))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(recordedCount("google")).toBeUndefined();
  });

  it("records an empty answer as a clean zero, as the CLI's `{ count: 0, models: [] }` is", async () => {
    const logs = catalogLogs();
    gatewayCall.mockResolvedValue({ models: [] });
    cliAnswers({ count: 0, models: [] });

    route.refreshInBackground("google");
    await vi.waitFor(() => expect(recordedCount("google")).toBe(0), { timeout: 4000, interval: 25 });
    await settle();

    expect(gatewayCall).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    // The log names the source the answer really came from.
    expect(logs.lines.filter((line) => line.includes("returned no models"))).toEqual([
      "[catalog] google: live enumeration returned no models, keeping the previous catalogue (the gateway gave no reason)",
    ]);
  });
});
