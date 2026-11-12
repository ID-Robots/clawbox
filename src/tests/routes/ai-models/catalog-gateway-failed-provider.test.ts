import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// A PROVIDER WHOSE LAST ENUMERATION FAILED IS ASKED AGAIN NO MORE OFTEN THAN BEFORE.
//
// After an attempt that publishes nothing (an empty answer, a refusal, a call
// that timed out), `markStale` records the backoff, two minutes and doubling.
// Until it runs out, a GET starts another attempt only through the client
// retry: at most once per provider per five minutes, and only while nothing
// else is enumerating. With every attempt a CLI fork (3 to 5 s on a Jetson),
// that last clause spaced a client's walk down the provider list: the first
// provider's retry ran, and the GETs for the others inside it started nothing.
// A socket answer takes a tenth of a second, so the same walk spent every
// provider's retry at once. Every attempt after a failure therefore takes the
// CLI, as before; these cases pin that spacing and the count per provider.
//
// On a Jetson (the marker is there for every case). Fake timers, so the boot
// warm-up the first GET starts runs only when a case moves the clock, and
// never into another case. The socket answers at once and a fork is held for
// as long as a case says: the two speeds the box has.

const spawnMock = vi.hoisted(() => vi.fn());
const gatewayCall = vi.hoisted(() => vi.fn());
const TEGRA_MARKER = vi.hoisted(() => `/tmp/clawbox-catalog-failed-provider-test-${process.pid}-nv_tegra_release`);

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: gatewayCall,
}));
vi.mock("@/lib/ollama-size-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ollama-size-cap")>()),
  TEGRA_RELEASE: TEGRA_MARKER,
}));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));
const DATA_DIR = `/tmp/clawbox-catalog-failed-provider-test-${process.pid}`;
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-failed-provider-test-${process.pid}` }));
vi.mock("@/lib/provider-follow-newest", () => ({ followNewestModelOnBox: vi.fn(async () => {}) }));

type Route = typeof import("@/app/setup-api/ai-models/catalog/route");
type GatewayWs = typeof import("@/lib/openclaw-gateway-ws");
let route: Route;
let ws: GatewayWs;

// Taken before any case fakes the clock: the detached refreshes need real time
// for their disk writes.
const realSetTimeout = globalThis.setTimeout;
function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** What each failure is on the socket, and what the CLI prints for the same gateway state. */
const FAILURES: Array<[string, () => Promise<unknown>, unknown]> = [
  ["an empty answer", async () => ({ models: [] }), { count: 0, models: [] }],
  [
    "a refusal",
    async () => {
      throw new ws.GatewayRpcError("model catalog is not ready", "UNAVAILABLE");
    },
    { ok: false, error: { type: "gateway_request_error", message: "model catalog is not ready" } },
  ],
  [
    "a call that timed out",
    async () => {
      throw new ws.GatewayWsCallTimeoutError("models.list timed out after 10000ms");
    },
    { ok: false, error: { type: "gateway_request_error", message: "gateway timeout after 10000ms" } },
  ],
];

/** The providers a client walks in the wizard, every one of them failing. */
const WALK = ["anthropic", "openai", "google", "xai"];

function newChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function answer(child: ReturnType<typeof newChild>, json: unknown): void {
  child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
  child.emit("close", 0);
}

/** Every fork answers `json` at once. */
function forksAnswer(json: unknown): void {
  spawnMock.mockImplementation(() => {
    const child = newChild();
    queueMicrotask(() => answer(child, json));
    return child;
  });
}

/** Every fork from here on runs until `release`: a CLI's seconds, against a socket's tenth. */
function forksHold(json: unknown): { release: () => void } {
  const held: Array<ReturnType<typeof newChild>> = [];
  spawnMock.mockImplementation(() => {
    const child = newChild();
    held.push(child);
    return child;
  });
  return { release: () => held.splice(0).forEach((child) => answer(child, json)) };
}

/** Socket calls made for `provider` so far. */
function asked(provider: string): number {
  return gatewayCall.mock.calls.filter(([, params]) => (params as { provider?: string }).provider === provider).length;
}

/** CLI forks made for `provider` so far. */
function forked(provider: string): number {
  return spawnMock.mock.calls.filter(([, args]) => {
    const argv = args as string[];
    return argv[argv.indexOf("--provider") + 1] === provider;
  }).length;
}

/** Enumerations started for `provider` so far: socket calls and CLI forks alike. */
function enumerations(provider: string): number {
  return asked(provider) + forked(provider);
}

async function get(provider: string): Promise<{ warming?: boolean }> {
  const res = await route.GET(new NextRequest(`http://clawbox.local/setup-api/ai-models/catalog?provider=${provider}`));
  return (await res.json()) as { warming?: boolean };
}

/** The first GET after a start, and the warm-up it starts, every attempt failing. */
async function startAndWarmUp(): Promise<void> {
  await get("anthropic");
  await settle();
  await vi.advanceTimersByTimeAsync(31_000);
  await settle(300);
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  spawnMock.mockReset();
  gatewayCall.mockReset();
  fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  fs.writeFileSync(TEGRA_MARKER, "");
  vi.resetModules();
  route = await import("@/app/setup-api/ai-models/catalog/route");
  ws = await import("@/lib/openclaw-gateway-ws");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(TEGRA_MARKER, { force: true });
});

describe("catalog — a failed provider's next attempt is spaced as the CLI spaced it", () => {
  it.each(FAILURES)("%s: a client walking four failing providers starts one retry, not four", async (_label, gateway, cli) => {
    gatewayCall.mockImplementation(gateway);
    forksAnswer(cli);
    await startAndWarmUp();
    // Ninety seconds in: nothing is enumerating, and each provider waits out its backoff.
    await vi.advanceTimersByTimeAsync(59_000);
    const before = WALK.map(enumerations);
    const forkedBefore = forked("anthropic");

    const forks = forksHold(cli);
    const responses = [];
    for (const provider of WALK) {
      responses.push(await get(provider));
      await settle();
    }

    expect(WALK.map((provider, i) => enumerations(provider) - before[i])).toEqual([1, 0, 0, 0]);
    // And that one retry is the CLI fork it was.
    expect(forked("anthropic") - forkedBefore).toBe(1);
    // Nothing is on its way for the other three, so no picker polls them.
    expect(responses.slice(1).map((response) => response.warming === true)).toEqual([false, false, false]);
    forks.release();
    await settle();
  });

  it("an attempt after a failure is as long as the CLI's, so no other retry starts beside it", async () => {
    gatewayCall.mockImplementation(FAILURES[0][1]);
    forksAnswer(FAILURES[0][2]);
    await startAndWarmUp();
    // Past anthropic's two-minute backoff (from the first GET), inside openai's
    // (from its warm-up slot at 10 s), whose client retry has never been spent.
    await vi.advanceTimersByTimeAsync(94_000);
    const before = ["anthropic", "openai"].map(enumerations);
    const forkedBefore = forked("anthropic");

    const forks = forksHold(FAILURES[0][2]);
    await get("anthropic");
    await settle();
    await get("openai");
    await settle();

    expect(["anthropic", "openai"].map((provider, i) => enumerations(provider) - before[i])).toEqual([1, 0]);
    expect(forked("anthropic") - forkedBefore).toBe(1);
    forks.release();
    await settle();
  });

  // Per provider the count never depended on how long an attempt takes: a
  // polling client gets one attempt per backoff window and one client retry per
  // five minutes, as before. Only the first attempt, before anything failed,
  // asks the gateway; every later one is the CLI fork beta made.
  it.each(FAILURES)("%s: a client polling one provider for six minutes asks the gateway once", async (_label, gateway, cli) => {
    gatewayCall.mockImplementation(gateway);
    forksAnswer(cli);
    for (let at = 0; at <= 6 * 60_000; at += 10_000) {
      await get("google");
      await settle(40);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await settle();
    expect(enumerations("google")).toBe(POLLED_ATTEMPTS);
    expect(asked("google")).toBe(1);
  }, 30_000);
});

/** Attempts beta's route starts for that poll (first GET, client retry, backoff expiry, client retry). */
const POLLED_ATTEMPTS = 4;
