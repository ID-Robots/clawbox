import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/harness/swap — Settings → Harness's "Switch to …" (owner's ask,
 * 2026-09-07): a locked box re-baked as the other edition through the
 * `harness_swap` root step, streamed the way the voice install is.
 *
 * Pinned here: the GET's shape, every refusal's status and code, that no
 * refusal stages a request or starts the step, the request file's bytes on
 * the way in, the stream's phase lines — from the journal as well as from the
 * follow's last line — the carry-over, the closing line, what a failure
 * after the lock flipped and a step that outlives the follow each close with,
 * and that the one in-flight slot is released on every path.
 *
 * EVERY 200 IS DRAINED before its test ends. `ReadableStream.start()` runs at
 * construction, so a response left unread keeps the follow mock, the route's
 * cleanup and the claim's release running into the NEXT test — which plants a
 * directory at the request path and then finds it deleted under it (measured:
 * one red run in three before the drain).
 */

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  follow: vi.fn<(step: string, opts: { onStatus: (line: string) => void }) => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: true }),
  ),
  edition: { edition: "openclaw" as "openclaw" | "hermes" | "dual", defaulted: false },
  active: vi.fn(async (): Promise<"openclaw" | "hermes"> => "openclaw"),
  refresh: vi.fn(async () => true),
  codingStatus: vi.fn(async () => ({ running: 0 })),
  updateLocked: vi.fn(async () => false),
  applyClawaiToHermes: vi.fn(async () => ({ provider: "clawai", model: "m", tier: "flash", explicitPickKept: false })),
  setHermesTelegramToken: vi.fn(async () => {}),
  ensureHermesGateway: vi.fn(async () => ({ installed: true, running: true, scope: "system", applied: true })),
  readConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  setTelegramToken: vi.fn(async () => {}),
  restartGateway: vi.fn(async () => {}),
  /** Where the OpenClaw core is — an absolute path — or the bare name when it is not installed. */
  openclawBin: "/home/clawbox/.npm-global/bin/openclaw",
  get: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  entitlementTier: vi.fn(async (): Promise<"free" | "flash" | "pro" | null> => "flash"),
  memAvailableMb: vi.fn(async (): Promise<number | null> => 4000),
  freeBytes: vi.fn(async (): Promise<number | null> => 50 * 1024 * 1024 * 1024),
  /** The Business-plan gate, flipped by one test without touching the constant. */
  planGateOn: false,
  unitState: "ActiveState=inactive\n",
  /** A systemctl that cannot be asked at all; null lets the probe answer. */
  unitError: null as Error | null,
  /** The unit's current invocation, as `systemctl show -p InvocationID` answers; empty before it starts. */
  invocationId: "",
  /** What `journalctl` answers for the invocation — the marker lines, the way `--grep` filters them. */
  journal: [] as string[],
  /** Every child_process call, for the legs that run a script. */
  execCalls: [] as string[][],
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/root-step-follow", async (orig) => ({
  ...(await orig<typeof import("@/lib/root-step-follow")>()),
  followRootStep: h.follow,
}));
vi.mock("@/lib/harness", async (orig) => ({
  ...(await orig<typeof import("@/lib/harness")>()),
  getEditionSource: () => ({ ...h.edition }),
  getEdition: () => h.edition.edition,
  getActiveHarness: h.active,
  isSingleHarnessEdition: () => true,
}));
vi.mock("@/lib/harness-mcp-refresh", () => ({ refreshHarnessToolsIfSwitched: h.refresh }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: h.codingStatus }));
vi.mock("@/lib/update-lock", () => ({ isUpdateLocked: h.updateLocked }));
vi.mock("@/lib/hermes-clawai", () => ({ applyClawaiToHermes: h.applyClawaiToHermes }));
vi.mock("@/lib/hermes-telegram", () => ({
  setHermesTelegramToken: h.setHermesTelegramToken,
  ensureHermesGateway: h.ensureHermesGateway,
  retireHermesUserGateway: vi.fn(async () => true),
}));
// PARTIAL, over the real module — see openclaw-config-mock-completeness.test.ts.
vi.mock("@/lib/openclaw-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-config")>()),
  readConfig: h.readConfig,
  setTelegramToken: h.setTelegramToken,
  restartGateway: h.restartGateway,
  findOpenclawBin: () => h.openclawBin,
}));
vi.mock("@/lib/config-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/config-store")>();
  // `set` named, not only spread: openclaw-config-mock-completeness.test.ts
  // reads factories by their text and wants both of the reader's exports.
  return { ...actual, get: h.get, set: actual.set };
});
vi.mock("@/lib/clawai-plan-tier", () => ({ readClawaiEntitlementTier: h.entitlementTier }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: h.memAvailableMb }));
vi.mock("@/lib/project-import", () => ({ freeBytes: h.freeBytes }));
// The gate is a constant by design; the route's handling of a refused plan is
// pinned through the one function that reads it.
vi.mock("@/lib/harness-swap", async (orig) => {
  const actual = await orig<typeof import("@/lib/harness-swap")>();
  return { ...actual, swapAllowed: (plan: Parameters<typeof actual.swapAllowed>[0]) => !h.planGateOn && actual.swapAllowed(plan) };
});
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  // `promisify(execFile)` follows util.promisify.custom, which is how the real
  // execFile resolves to `{ stdout, stderr }` rather than a bare stdout.
  const run = async (cmd: string, args: string[]) => {
    h.execCalls.push([cmd, ...args]);
    if (cmd.endsWith("journalctl")) return { stdout: `${h.journal.join("\n")}\n`, stderr: "" };
    if (args.includes("InvocationID")) return { stdout: `InvocationID=${h.invocationId}\n`, stderr: "" };
    if (args.includes("ActiveState")) {
      if (h.unitError) throw h.unitError;
      return { stdout: h.unitState, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

import { GET, POST } from "@/app/setup-api/harness/swap/route";
import { SWAP_FOLLOW_TIMEOUT_MS, SWAP_NOTES, _resetHarnessSwapForTests } from "@/lib/harness-swap";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-harness-swap-route-${process.pid}-${Date.now()}`);
const REQUEST_PATH = path.join(TEST_ROOT, "data", "harness-swap.env");

let restoreEnv: () => void;
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
  async () => new Response(null, { status: 404 }),
);

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.dirname(REQUEST_PATH), { recursive: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  restoreEnv();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  _resetHarnessSwapForTests();
  h.edition = { edition: "openclaw", defaulted: false };
  h.planGateOn = false;
  h.unitState = "ActiveState=inactive\n";
  h.unitError = null;
  h.invocationId = "";
  h.journal = [];
  h.execCalls.length = 0;
  h.openclawBin = "/home/clawbox/.npm-global/bin/openclaw";
  h.owner.mockReset().mockResolvedValue(true);
  h.sameOrigin.mockReset().mockReturnValue(true);
  h.follow.mockReset().mockResolvedValue({ ok: true });
  h.active.mockReset().mockResolvedValue("openclaw");
  h.refresh.mockReset().mockResolvedValue(true);
  h.codingStatus.mockReset().mockResolvedValue({ running: 0 });
  h.updateLocked.mockReset().mockResolvedValue(false);
  h.applyClawaiToHermes.mockReset().mockResolvedValue({ provider: "clawai", model: "m", tier: "flash", explicitPickKept: false });
  h.setHermesTelegramToken.mockReset().mockResolvedValue(undefined);
  h.ensureHermesGateway.mockReset().mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });
  h.readConfig.mockReset().mockResolvedValue({});
  h.setTelegramToken.mockReset().mockResolvedValue(undefined);
  h.restartGateway.mockReset().mockResolvedValue(undefined);
  h.get.mockReset().mockResolvedValue(undefined);
  h.entitlementTier.mockReset().mockResolvedValue("flash");
  h.memAvailableMb.mockReset().mockResolvedValue(4000);
  h.freeBytes.mockReset().mockResolvedValue(50 * 1024 * 1024 * 1024);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 404 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await fs.rm(REQUEST_PATH, { recursive: true, force: true });
});

function post(body: unknown, raw = false): Request {
  return new Request("http://box/setup-api/harness/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The follow flips the lock the way the real step does. It touches nothing on
 * disk: the route needs no file gone to succeed, and a mock that reached into
 * the filesystem was what a stray stream used to do to its neighbour.
 */
function followLandsOn(edition: "openclaw" | "hermes", journal: string[] = []) {
  h.follow.mockImplementation(async (_step, opts) => {
    for (const line of journal) opts.onStatus(line);
    h.edition = { edition, defaulted: false };
    return { ok: true };
  });
}

/** A 200 whose stream is read to the end and closed on the new harness. */
async function expectLanded(res: Response, active: "openclaw" | "hermes") {
  expect(res.status).toBe(200);
  const out = await lines(res);
  expect(out.at(-1)).toMatchObject({ success: true, active });
  return out;
}

async function expectRefusal(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(10);
  expect(h.follow).not.toHaveBeenCalled();
  await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
}

describe("GET /setup-api/harness/swap", () => {
  it("describes an OpenClaw box that can swap to Hermes, with its plan and the gate", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({
      edition: "openclaw",
      active: "openclaw",
      locked: true,
      target: "hermes",
      swappable: true,
      inProgress: false,
      inProgressTarget: null,
      plan: { tier: "flash", planNameKey: "ai.planNamePro" },
      businessPlanRequired: false,
      allowed: true,
    });
  });

  it("points a Hermes box back at OpenClaw", async () => {
    h.edition = { edition: "hermes", defaulted: false };
    h.active.mockResolvedValue("hermes");
    const body = await (await GET()).json();
    expect(body).toMatchObject({ edition: "hermes", active: "hermes", target: "openclaw", swappable: true });
  });

  it("has no target on a dual box or a guessed edition", async () => {
    h.edition = { edition: "dual", defaulted: false };
    expect(await (await GET()).json()).toMatchObject({ target: null, swappable: false });
    h.edition = { edition: "openclaw", defaulted: true };
    expect(await (await GET()).json()).toMatchObject({ target: null, swappable: false });
  });

  it("reports a swap the unit is running, with the request file's target", async () => {
    h.unitState = "ActiveState=active\n";
    await fs.writeFile(REQUEST_PATH, "TARGET_EDITION=hermes\nREQUESTED_AT=1\n");
    expect(await (await GET()).json()).toMatchObject({ inProgress: true, inProgressTarget: "hermes" });
  });

  it("says allowed: false when the gate is on and the plan is not Business", async () => {
    h.planGateOn = true;
    expect(await (await GET()).json()).toMatchObject({ allowed: false });
  });
});

describe("POST /setup-api/harness/swap — refusals", () => {
  it("refuses the MCP bearer: 403 owner_only", async () => {
    h.owner.mockResolvedValue(false);
    await expectRefusal(await POST(post({ harness: "hermes" })), 403, "owner_only");
  });

  it("refuses another site's page riding the cookie: 403 cross_origin", async () => {
    h.sameOrigin.mockReturnValue(false);
    await expectRefusal(await POST(post({ harness: "hermes" })), 403, "cross_origin");
  });

  it("refuses a body that names no harness: 400 bad_body", async () => {
    for (const bad of [null, "hermes", 5, [], {}, { harness: "dual" }, { harness: 1 }]) {
      await expectRefusal(await POST(post(bad)), 400, "bad_body");
    }
    await expectRefusal(await POST(post("{not json", true)), 400, "bad_body");
  });

  it("refuses a dual box and a guessed edition: 409 not_swappable", async () => {
    h.edition = { edition: "dual", defaulted: false };
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "not_swappable");
    h.edition = { edition: "openclaw", defaulted: true };
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "not_swappable");
  });

  it("refuses the harness the box already runs: 409 same_harness", async () => {
    await expectRefusal(await POST(post({ harness: "openclaw" })), 409, "same_harness");
    h.edition = { edition: "hermes", defaulted: false };
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "same_harness");
  });

  it("refuses when the Business-plan gate is on and the plan is not Business: 409 plan_required", async () => {
    h.planGateOn = true;
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "plan_required");
  });

  it("refuses while the unit is already running: 409 busy", async () => {
    h.unitState = "ActiveState=activating\n";
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "busy");
    // The refused claim is released: the next attempt, with the unit idle, goes through.
    h.unitState = "ActiveState=inactive\n";
    followLandsOn("hermes");
    await expectLanded(await POST(post({ harness: "hermes" })), "hermes");
  });

  it("refuses while an in-app update owns the box: 409 update_in_progress", async () => {
    h.updateLocked.mockResolvedValue(true);
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "update_in_progress");
    // Before the coding-run probe: an update is the cheaper fact and the worse race.
    expect(h.codingStatus).not.toHaveBeenCalled();
  });

  it("refuses while a coding run is live: 409 coding_run_live", async () => {
    h.codingStatus.mockResolvedValue({ running: 1 });
    await expectRefusal(await POST(post({ harness: "hermes" })), 409, "coding_run_live");
  });

  it("refuses a Hermes install the box cannot download: 412 offline", async () => {
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expectRefusal(await POST(post({ harness: "hermes" })), 412, "offline");
    expect(fetchMock.mock.calls[0][0]).toBe("https://raw.githubusercontent.com/");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
  });

  it("does not ask the network for a swap back to an OpenClaw core that is already installed", async () => {
    h.edition = { edition: "hermes", defaulted: false };
    h.active.mockResolvedValue("hermes");
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    followLandsOn("openclaw");
    await expectLanded(await POST(post({ harness: "openclaw" })), "openclaw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the npm registry before a swap to OpenClaw on a box with no OpenClaw core: 412 offline", async () => {
    // A Hermes-SKU box never had the core; `openclaw_install` downloads it.
    h.edition = { edition: "hermes", defaulted: false };
    h.active.mockResolvedValue("hermes");
    h.openclawBin = "openclaw";
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    const res = await POST(post({ harness: "openclaw" }));
    await expectRefusal(res, 412, "offline");
    expect(fetchMock.mock.calls[0][0]).toBe("https://registry.npmjs.org/");
  });

  it("refuses under 3 GiB free: 412 disk", async () => {
    h.freeBytes.mockResolvedValue(2 * 1024 * 1024 * 1024);
    await expectRefusal(await POST(post({ harness: "hermes" })), 412, "disk");
  });

  it("refuses under 1500 MB of MemAvailable: 412 memory", async () => {
    h.memAvailableMb.mockResolvedValue(900);
    await expectRefusal(await POST(post({ harness: "hermes" })), 412, "memory");
  });

  it("releases the slot after a preflight refusal, so the next attempt is not 'busy'", async () => {
    h.memAvailableMb.mockResolvedValueOnce(900);
    await expectRefusal(await POST(post({ harness: "hermes" })), 412, "memory");
    followLandsOn("hermes");
    await expectLanded(await POST(post({ harness: "hermes" })), "hermes");
  });

  it("answers 500 request_write_failed when the request cannot be staged, and releases the slot", async () => {
    // A directory at the path: the temp writes and the rename onto it rejects.
    await fs.mkdir(REQUEST_PATH);
    const res = await POST(post({ harness: "hermes" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "request_write_failed" });
    expect(h.follow).not.toHaveBeenCalled();
    await fs.rm(REQUEST_PATH, { recursive: true, force: true });
    followLandsOn("hermes");
    await expectLanded(await POST(post({ harness: "hermes" })), "hermes");
  });
});

describe("POST /setup-api/harness/swap — the stream", () => {
  it("stages the request, follows the root step for as long as systemd allows it, and closes on the new harness", async () => {
    h.get.mockImplementation(async (key: string) =>
      ({ clawai_token: "claw_abc", clawai_tier: "pro", telegram_bot_token: "123:bot" } as Record<string, string>)[key]);
    let staged = "";
    h.follow.mockImplementation(async (_step, opts) => {
      // The request file is what the step reads, so it has to be on disk
      // BEFORE the unit is started.
      staged = await fs.readFile(REQUEST_PATH, "utf8");
      opts.onStatus("[harness-swap] phase=install");
      opts.onStatus("Installing Hermes as clawbox…");
      opts.onStatus("[harness-swap] phase=lock");
      opts.onStatus("[harness-swap] phase=provision");
      opts.onStatus("[harness-swap] phase=done");
      h.edition = { edition: "hermes", defaulted: false };
      // The real step removes its request on the way out.
      await fs.rm(REQUEST_PATH, { force: true });
      return { ok: true };
    });

    const res = await POST(post({ harness: "hermes" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The stream started with the response; reading it to the end is what
    // makes the closing line — and everything after the follow — observable.
    const out = await lines(res);
    expect(staged).toMatch(/^TARGET_EDITION=hermes\nREQUESTED_AT=\d+\n$/);
    expect(h.follow.mock.calls[0][0]).toBe("harness_swap");
    expect(h.follow.mock.calls[0][1]).toMatchObject({ timeoutMs: SWAP_FOLLOW_TIMEOUT_MS });
    // Not below the unit's TimeoutStartSec (2 h): systemd owns the kill, never
    // this stream — a follow that gave up first reported a running swap as failed.
    expect(SWAP_FOLLOW_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);

    // The phases, in order; the step's own `done` is the end of the root step
    // and travels as a plain line — the route's `done` comes after the carry.
    expect(out.filter((l) => l.phase).map((l) => l.phase)).toEqual(["request", "install", "lock", "provision", "carry", "done"]);
    expect(out.find((l) => l.status === "[harness-swap] phase=done")).toBeDefined();
    expect(out.find((l) => l.status === "Installing Hermes as clawbox…")).toBeDefined();
    expect(out.find((l) => l.phase === "install")?.status).toContain("Hermes");
    const last = out[out.length - 1];
    expect(last).toEqual({
      success: true,
      active: "hermes",
      reload: true,
      notes: [SWAP_NOTES.clawaiCarried, SWAP_NOTES.telegramApprovals],
    });

    // The carry-over ran with the stored credentials, into HERMES.
    expect(h.applyClawaiToHermes).toHaveBeenCalledWith("claw_abc", "pro");
    expect(h.setHermesTelegramToken).toHaveBeenCalledWith("123:bot");
    expect(h.setTelegramToken).not.toHaveBeenCalled();
    // The agent's tool list is rebuilt for the harness that replaced the old one.
    expect(h.refresh).toHaveBeenCalledWith("openclaw", "hermes");
    // The step removed the request; the route did not put it back, and the slot is free.
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
    expect(await (await GET()).json()).toMatchObject({ inProgress: false });
  });

  it("finds the phase markers in the unit's journal when they are never the follow's last line", async () => {
    // install.sh prints `[harness-swap] phase=install` and, in the same
    // instant, the sub-step's own line; the follow forwards only the LAST
    // journal line per poll, so the marker itself never reaches onStatus.
    h.invocationId = "8f0c2e1d4b6a4c0e9a7d3e5f1b2c3d4e";
    h.follow.mockImplementation(async (_step, opts) => {
      h.journal = ["[harness-swap] phase=request", "[harness-swap] phase=install"];
      opts.onStatus("  -> install.sh --step hermes_install (as the Hermes edition)");
      opts.onStatus("Collecting torch==2.4.0");
      h.journal = [...h.journal, "[harness-swap] phase=lock", "[harness-swap] phase=provision"];
      opts.onStatus("  -> install.sh --step hermes_edition (as the Hermes edition)");
      h.journal = [...h.journal, "[harness-swap] phase=done"];
      opts.onStatus("  This box is now the Hermes edition");
      h.edition = { edition: "hermes", defaulted: false };
      return { ok: true };
    });

    const out = await expectLanded(await POST(post({ harness: "hermes" })), "hermes");

    // Every phase, once, in order — the ones the scan skipped over are filled
    // in so the list the modal draws is never missing a step.
    expect(out.filter((l) => l.phase).map((l) => l.phase)).toEqual(["request", "install", "lock", "provision", "carry", "done"]);
    // Each scan read THIS invocation's journal, and only its marker lines.
    const scans = h.execCalls.filter(([cmd]) => cmd.endsWith("journalctl"));
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan).toContain(`_SYSTEMD_INVOCATION_ID=${h.invocationId}`);
      expect(scan.join(" ")).toMatch(/-g \^\\\[harness-swap\\\] phase=/);
    }
    // The plain lines still travel, after the phase each belongs to.
    const installAt = out.findIndex((l) => l.phase === "install");
    const collectingAt = out.findIndex((l) => l.status === "Collecting torch==2.4.0");
    expect(installAt).toBeGreaterThan(0);
    expect(collectingAt).toBeGreaterThan(installAt);
  });

  it("carries the credentials and the persona into OpenClaw on the way back, and asks no Hermes dashboard for a tool reload", async () => {
    h.edition = { edition: "hermes", defaulted: false };
    h.active.mockResolvedValue("hermes");
    h.get.mockImplementation(async (key: string) => ({ telegram_bot_token: "123:bot" } as Record<string, string>)[key]);
    h.readConfig.mockResolvedValue({ models: { providers: { deepseek: { apiKey: "claw_abc" } } } });
    followLandsOn("openclaw");

    const out = await lines(await POST(post({ harness: "openclaw" })));

    expect(out[out.length - 1]).toEqual({
      success: true, active: "openclaw", reload: true, notes: [SWAP_NOTES.clawaiCarried, SWAP_NOTES.telegramApprovals],
    });
    expect(h.setTelegramToken).toHaveBeenCalledWith("123:bot");
    expect(h.restartGateway).toHaveBeenCalled();
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    // The shared identity is refreshed into the OpenClaw workspace the way the
    // runtime switcher does it — the step has no identity leg in this direction.
    const sync = h.execCalls.find((call) => call.some((arg) => arg.endsWith("scripts/clawbox-identity-sync.sh")));
    expect(sync).toBeDefined();
    expect(sync?.at(-1)).toBe("openclaw");
    // The refresh reloads HERMES' MCP children, and the Hermes dashboard was
    // just torn down — asking it would only log a refusal under the wrong tag.
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("closes with the step's error, deletes the request and skips the carry-over when the step failed before the lock flipped", async () => {
    h.follow.mockImplementation(async (_step, opts) => {
      opts.onStatus("[harness-swap] phase=install");
      opts.onStatus("Hermes is not runnable after the install; the edition lock is untouched");
      return { ok: false, error: "Hermes is not runnable after the install; the edition lock is untouched" };
    });

    const out = await lines(await POST(post({ harness: "hermes" })));

    expect(out[out.length - 1]).toEqual({
      error: "Hermes is not runnable after the install; the edition lock is untouched",
      code: "swap_failed",
    });
    expect(out.some((l) => l.success)).toBe(false);
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
    expect(await (await GET()).json()).toMatchObject({ inProgress: false });
  });

  it("says the box IS the target when the step failed after the lock flipped, and carries the credentials anyway", async () => {
    h.get.mockImplementation(async (key: string) =>
      ({ clawai_token: "claw_abc", clawai_tier: "pro", telegram_bot_token: "123:bot" } as Record<string, string>)[key]);
    h.follow.mockImplementation(async (_step, opts) => {
      opts.onStatus("[harness-swap] phase=provision");
      // The lock is re-baked; provisioning is what did not finish.
      h.edition = { edition: "hermes", defaulted: false };
      return { ok: false, error: "Error: the provision phase failed — the Hermes dashboard is not enabled after provisioning." };
    });

    const out = await lines(await POST(post({ harness: "hermes" })));

    const last = out[out.length - 1];
    expect(last).toMatchObject({
      code: "swap_failed",
      active: "hermes",
      reload: true,
      lockFlipped: true,
      notes: [SWAP_NOTES.clawaiCarried, SWAP_NOTES.telegramApprovals],
    });
    expect(String(last.error)).toContain("provision phase failed");
    expect(out.some((l) => l.success)).toBe(false);
    // The carry phase was announced, and the credentials went into HERMES.
    expect(out.find((l) => l.phase === "carry")).toBeDefined();
    expect(h.applyClawaiToHermes).toHaveBeenCalledWith("claw_abc", "pro");
    expect(h.setHermesTelegramToken).toHaveBeenCalledWith("123:bot");
    // A stale request must not be a standing instruction; the slot is free.
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
    expect(await (await GET()).json()).toMatchObject({ inProgress: false });
  });

  it("leaves the request in place and closes still_running when the follow gave up on a unit that is still working", async () => {
    h.follow.mockImplementation(async () => {
      // The follow's deadline passed; systemd's has not.
      h.unitState = "ActiveState=active\n";
      return { ok: false, error: "Collecting torch==2.4.0" };
    });

    const out = await lines(await POST(post({ harness: "hermes" })));

    const last = out[out.length - 1];
    expect(last).toMatchObject({ code: "still_running" });
    expect(String(last.error)).toContain("Settings → Harness");
    expect(last.lockFlipped).toBeUndefined();
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    // The step still reads the file; GET goes on reporting the swap from the unit.
    expect(await fs.readFile(REQUEST_PATH, "utf8")).toMatch(/^TARGET_EDITION=hermes\n/);
    expect(await (await GET()).json()).toMatchObject({ inProgress: true, inProgressTarget: "hermes" });
  });

  it("never dresses a step that exited 0 without re-baking the lock as a success", async () => {
    h.follow.mockResolvedValue({ ok: true });

    const out = await lines(await POST(post({ harness: "hermes" })));

    expect(out[out.length - 1]).toMatchObject({ code: "lock_unchanged" });
    expect(String(out[out.length - 1].error)).toContain("openclaw");
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
  });

  it("reports a follow that threw as swap_failed and frees the slot", async () => {
    h.follow.mockRejectedValue(new Error("sudo: a password is required"));
    const out = await lines(await POST(post({ harness: "hermes" })));
    expect(out[out.length - 1]).toEqual({ error: "sudo: a password is required", code: "swap_failed" });
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
    expect(await (await GET()).json()).toMatchObject({ inProgress: false });
  });

  it("refuses to start, 503 unit_unknown, while systemd cannot say whether a swap is running", async () => {
    h.unitError = new Error("Failed to connect to bus");
    const res = await POST(post({ harness: "hermes" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unit_unknown" });
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
    expect(await (await GET()).json()).toMatchObject({ inProgress: false, inProgressUnknown: true });
    // The slot is free again the moment systemd answers.
    h.unitError = null;
    h.follow.mockImplementation(async () => { h.edition = { edition: "hermes", defaulted: false }; return { ok: true }; });
    const out = await lines(await POST(post({ harness: "hermes" })));
    expect(out[out.length - 1]).toMatchObject({ success: true });
  });

  it("keeps the request when the follow gave up and systemd could not be asked whether the unit still runs", async () => {
    h.follow.mockImplementation(async () => {
      h.unitError = new Error("Failed to connect to bus");
      return { ok: false, error: "follow timed out" };
    });
    const out = await lines(await POST(post({ harness: "hermes" })));
    const last = out[out.length - 1];
    expect(last).toMatchObject({ code: "still_running" });
    expect(String(last.error)).toMatch(/Could not tell/);
    expect(await fs.readFile(REQUEST_PATH, "utf8")).toMatch(/^TARGET_EDITION=hermes\n/);
  });

  it("keeps the request and closes still_running when the follow threw while the unit is still working", async () => {
    // The unit outlives a follow that threw (a lost journal, a killed poll):
    // the file the step still reads is not pulled out from under it.
    h.follow.mockImplementation(async () => {
      h.unitState = "ActiveState=active\n";
      throw new Error("journalctl: connection reset");
    });
    const out = await lines(await POST(post({ harness: "hermes" })));
    expect(out[out.length - 1]).toMatchObject({ code: "still_running" });
    expect(await fs.readFile(REQUEST_PATH, "utf8")).toMatch(/^TARGET_EDITION=hermes\n/);
    expect(await (await GET()).json()).toMatchObject({ inProgress: true, inProgressTarget: "hermes" });
  });

  it("tells the desktop to reload when a throw came after the lock flipped", async () => {
    h.follow.mockImplementation(async () => {
      h.edition = { edition: "hermes", defaulted: false };
      return { ok: true };
    });
    // The carry-over folds its writers' failures into notes; the refresh is
    // the one awaited call after the lock that can still throw.
    h.refresh.mockRejectedValue(new Error("dashboard: ECONNRESET"));
    const out = await lines(await POST(post({ harness: "hermes" })));
    expect(out[out.length - 1]).toMatchObject({ code: "swap_failed", active: "hermes", reload: true, lockFlipped: true });
    await expect(fs.access(REQUEST_PATH)).rejects.toThrow();
  });

  it("answers a second POST 409 busy while the first is streaming, and GET names the target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.follow.mockImplementation(async () => {
      await gate;
      h.edition = { edition: "hermes", defaulted: false };
      return { ok: true };
    });

    const first = await POST(post({ harness: "hermes" }));
    // The stream's body is what runs the follow; read it in the background.
    const firstLines = lines(first);
    await new Promise((r) => setTimeout(r, 20));

    expect(await (await GET()).json()).toMatchObject({ inProgress: true, inProgressTarget: "hermes" });
    const second = await POST(post({ harness: "hermes" }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "busy" });
    expect(h.follow).toHaveBeenCalledTimes(1);

    release();
    const out = await firstLines;
    expect(out[out.length - 1]).toMatchObject({ success: true, active: "hermes" });
  });
});
