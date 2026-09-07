import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * src/lib/harness-swap.ts — the rules behind Settings → Harness's "Switch to
 * …" button (owner's ask, 2026-09-07): which way a locked box may swap, the
 * request file the root step reads, the journal's phase markers, the one
 * in-flight slot, the preflight refusals, the plan gate, and the carry-over of
 * the two per-harness credentials after the lock has flipped.
 */

const h = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  entitlementTier: vi.fn(async (): Promise<"free" | "flash" | "pro" | null> => null),
  applyClawaiToHermes: vi.fn(async () => ({ provider: "clawai", model: "m", tier: "flash", explicitPickKept: false })),
  setHermesTelegramToken: vi.fn(async () => {}),
  ensureHermesGateway: vi.fn(async () => ({ installed: true, running: true, scope: "system", applied: true })),
  readConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  setTelegramToken: vi.fn(async () => {}),
  restartGateway: vi.fn(async () => {}),
  getCodingAgentStatus: vi.fn(async () => ({ running: 0 })),
  updateLocked: vi.fn(async () => false),
  /** Where the OpenClaw core is — an absolute path — or the bare name when it is not installed. */
  openclawBin: "/home/clawbox/.npm-global/bin/openclaw",
  /** `systemctl show … -p ActiveState`'s stdout. */
  unitState: "ActiveState=inactive\n",
  /** `systemctl show … -p InvocationID`'s answer; empty until the unit has started. */
  invocationId: "",
  /** What `journalctl` prints for the invocation. */
  journal: [] as string[],
  /** When set, a `journalctl` asked to `--grep` fails with it — a build without pcre2. */
  journalGrepError: null as Error | null,
  /** When set, `systemctl` fails with it — a box with no systemd, a timed-out query. */
  unitError: null as Error | null,
  execCalls: [] as string[][],
}));

vi.mock("@/lib/config-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/config-store")>()),
  get: h.get,
}));
vi.mock("@/lib/clawai-plan-tier", () => ({ readClawaiEntitlementTier: h.entitlementTier }));
vi.mock("@/lib/hermes-clawai", () => ({ applyClawaiToHermes: h.applyClawaiToHermes }));
vi.mock("@/lib/hermes-telegram", () => ({
  setHermesTelegramToken: h.setHermesTelegramToken,
  ensureHermesGateway: h.ensureHermesGateway,
}));
// PARTIAL, over the real module — see openclaw-config-mock-completeness.test.ts.
vi.mock("@/lib/openclaw-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-config")>()),
  readConfig: h.readConfig,
  setTelegramToken: h.setTelegramToken,
  restartGateway: h.restartGateway,
  findOpenclawBin: () => h.openclawBin,
}));
vi.mock("@/lib/project-import", () => ({ freeBytes: vi.fn(async () => null) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => null) }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: h.getCodingAgentStatus }));
vi.mock("@/lib/update-lock", () => ({ isUpdateLocked: h.updateLocked }));
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  // `promisify(execFile)` follows util.promisify.custom, which is how the real
  // execFile resolves to `{ stdout, stderr }` rather than a bare stdout.
  const run = async (cmd: string, args: string[]) => {
    h.execCalls.push([cmd, ...args]);
    if (h.unitError) throw h.unitError;
    if (cmd.endsWith("journalctl")) {
      if (h.journalGrepError && args.includes("-g")) throw h.journalGrepError;
      return { stdout: `${h.journal.join("\n")}\n`, stderr: "" };
    }
    if (args.includes("InvocationID")) return { stdout: `InvocationID=${h.invocationId}\n`, stderr: "" };
    if (args.includes("ActiveState")) return { stdout: h.unitState, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

import {
  HARNESS_SWAP_BUSINESS_PLAN_REQUIRED,
  SWAP_FOLLOW_TIMEOUT_MS,
  SWAP_INSTALL_ORIGIN,
  SWAP_MIN_AVAILABLE_MB,
  SWAP_MIN_FREE_BYTES,
  SWAP_NOTES,
  SWAP_NPM_ORIGIN,
  SWAP_PHASES,
  _resetHarnessSwapForTests,
  carryOverAfterSwap,
  claimSwap,
  latestSwapPhase,
  parseSwapPhase,
  preflightSwap,
  readSwapInvocationId,
  readSwapPlan,
  readSwapRequest,
  releaseSwap,
  removeSwapRequest,
  swapAllowed,
  swapAllowedFor,
  swapInProgress,
  swapPhaseFollower,
  swapPhaseStatus,
  swapRequestPath,
  swapTargetFor,
  writeSwapRequest,
} from "@/lib/harness-swap";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-harness-swap-tests-${process.pid}-${Date.now()}`);
const REQUEST_PATH = path.join(TEST_ROOT, "data", "harness-swap.env");

let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.dirname(REQUEST_PATH), { recursive: true });
});

afterAll(async () => {
  restoreEnv();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  _resetHarnessSwapForTests();
  h.unitState = "ActiveState=inactive\n";
  h.invocationId = "";
  h.journal = [];
  h.journalGrepError = null;
  h.unitError = null;
  h.execCalls.length = 0;
  h.openclawBin = "/home/clawbox/.npm-global/bin/openclaw";
  h.updateLocked.mockReset().mockResolvedValue(false);
  h.get.mockReset().mockResolvedValue(undefined);
  h.entitlementTier.mockReset().mockResolvedValue(null);
  h.applyClawaiToHermes.mockReset().mockResolvedValue({ provider: "clawai", model: "m", tier: "flash", explicitPickKept: false });
  h.setHermesTelegramToken.mockReset().mockResolvedValue(undefined);
  h.ensureHermesGateway.mockReset().mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });
  h.readConfig.mockReset().mockResolvedValue({});
  h.setTelegramToken.mockReset().mockResolvedValue(undefined);
  h.restartGateway.mockReset().mockResolvedValue(undefined);
  h.getCodingAgentStatus.mockReset().mockResolvedValue({ running: 0 });
});

afterEach(async () => {
  await fs.rm(REQUEST_PATH, { force: true });
});

/** A store holding the keys given and nothing else. */
function store(values: Record<string, unknown>): void {
  h.get.mockImplementation(async (key: string) => values[key]);
}

/** Every probe answering "fine", with overrides. */
function probes(over: Partial<Parameters<typeof preflightSwap>[1]> = {}) {
  return {
    updateLocked: async () => false,
    codingRuns: async () => 0,
    online: async () => true,
    openclawInstalled: async () => true,
    freeBytes: async () => SWAP_MIN_FREE_BYTES * 4,
    memAvailableMb: async () => SWAP_MIN_AVAILABLE_MB * 3,
    ...over,
  };
}

describe("which way a box may swap", () => {
  it("names the OTHER single edition", () => {
    expect(swapTargetFor({ edition: "openclaw", defaulted: false })).toBe("hermes");
    expect(swapTargetFor({ edition: "hermes", defaulted: false })).toBe("openclaw");
  });

  it("has nowhere to swap a dual box, which switches at runtime", () => {
    expect(swapTargetFor({ edition: "dual", defaulted: false })).toBeNull();
  });

  it("refuses to swap on a guessed edition — the lock could brand a Hermes box OpenClaw for good", () => {
    expect(swapTargetFor({ edition: "openclaw", defaulted: true })).toBeNull();
  });
});

describe("the plan beside the button", () => {
  it("maps the entitlement tier to the plan-name key the card draws", async () => {
    h.entitlementTier.mockResolvedValue("flash");
    expect(await readSwapPlan()).toEqual({ tier: "flash", planNameKey: "ai.planNamePro" });
    h.entitlementTier.mockResolvedValue("pro");
    expect(await readSwapPlan()).toEqual({ tier: "pro", planNameKey: "ai.planNameMax" });
    h.entitlementTier.mockResolvedValue("free");
    expect(await readSwapPlan()).toEqual({ tier: "free", planNameKey: "ai.planNameFree" });
  });

  it("words no plan on record — and a store that will not read — as the Free plan, with a null tier", async () => {
    expect(await readSwapPlan()).toEqual({ tier: null, planNameKey: "ai.planNameFree" });
    h.entitlementTier.mockRejectedValue(new Error("EACCES"));
    expect(await readSwapPlan()).toEqual({ tier: null, planNameKey: "ai.planNameFree" });
  });

  it("lets every plan swap while the Business-plan gate is off (owner, 2026-09-07)", async () => {
    expect(HARNESS_SWAP_BUSINESS_PLAN_REQUIRED).toBe(false);
    for (const tier of ["free", "flash", "pro", null] as const) {
      expect(swapAllowed({ tier, planNameKey: "x" })).toBe(true);
    }
  });

  it("refuses every current plan once the gate is on — there is no Business tier yet to map", () => {
    for (const tier of ["free", "flash", "pro", null] as const) {
      expect(swapAllowedFor({ tier, planNameKey: "x" }, true)).toBe(false);
    }
  });
});

describe("the request file the root step reads", () => {
  it("writes exactly the two lines, as a fresh 0600 plain file, with no temp left behind", async () => {
    await writeSwapRequest("hermes", 1_757_200_000_123);

    const stat = await fs.lstat(REQUEST_PATH);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(REQUEST_PATH, "utf8")).toBe("TARGET_EDITION=hermes\nREQUESTED_AT=1757200000\n");
    const siblings = (await fs.readdir(path.dirname(REQUEST_PATH))).filter((f) => f !== path.basename(REQUEST_PATH));
    expect(siblings).toEqual([]);
    expect(await readSwapRequest()).toEqual({ target: "hermes", requestedAt: 1_757_200_000 });
  });

  it("replaces a planted symlink instead of writing through it", async () => {
    const collateral = path.join(TEST_ROOT, "data", "collateral.txt");
    await fs.writeFile(collateral, "not the request\n");
    await fs.symlink(collateral, REQUEST_PATH);

    await writeSwapRequest("openclaw");

    const stat = await fs.lstat(REQUEST_PATH);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(await fs.readFile(collateral, "utf8")).toBe("not the request\n");
    await fs.rm(collateral, { force: true });
  });

  it("leaves nothing behind when the rename is refused", async () => {
    // A directory at the path: the temp writes fine and the rename rejects,
    // the same catch a read-only data/ reaches.
    await fs.mkdir(REQUEST_PATH);
    try {
      await expect(writeSwapRequest("hermes")).rejects.toThrow();
      const siblings = (await fs.readdir(path.dirname(REQUEST_PATH))).filter((f) => f !== path.basename(REQUEST_PATH));
      expect(siblings).toEqual([]);
    } finally {
      await fs.rm(REQUEST_PATH, { recursive: true, force: true });
    }
  });

  it("reads back only a request the root step would accept", async () => {
    expect(await readSwapRequest()).toBeNull();
    await fs.writeFile(REQUEST_PATH, "TARGET_EDITION=dual\nREQUESTED_AT=1\n");
    expect(await readSwapRequest()).toBeNull();
    await fs.writeFile(REQUEST_PATH, "TARGET_EDITION=hermes\nREQUESTED_AT=soon\n");
    expect(await readSwapRequest()).toBeNull();
    await fs.writeFile(REQUEST_PATH, "TARGET_EDITION=hermes\n");
    expect(await readSwapRequest()).toBeNull();
    await removeSwapRequest();
    expect(await readSwapRequest()).toBeNull();
    await removeSwapRequest();
  });

  it("lives under data/ of CLAWBOX_ROOT, where the root step looks", () => {
    expect(swapRequestPath()).toBe(REQUEST_PATH);
  });
});

describe("the journal's phase markers", () => {
  it("reads exactly `[harness-swap] phase=<name>`", () => {
    expect(parseSwapPhase("[harness-swap] phase=install")).toBe("install");
    expect(parseSwapPhase("  [harness-swap] phase=done  ")).toBe("done");
    for (const phase of SWAP_PHASES) expect(parseSwapPhase(`[harness-swap] phase=${phase}`)).toBe(phase);
  });

  it("forwards every near miss as a plain line rather than guessing a phase", () => {
    for (const line of [
      "[harness-swap] phase=INSTALL",
      "[harness-swap] phase=reboot",
      "[harness-swap] phase=install now",
      "phase=install",
      "[provision-status] ok",
      "Installing Hermes (phase=install)",
      "",
    ]) {
      expect(parseSwapPhase(line), line).toBeNull();
    }
  });

  it("names the harness the phase is about", () => {
    expect(swapPhaseStatus("install", "hermes")).toContain("Hermes");
    expect(swapPhaseStatus("done", "openclaw")).toContain("OpenClaw");
  });
});

describe("the phase markers read out of the unit's own journal", () => {
  // The follow forwards only the LAST journal line per poll, and install.sh
  // prints every marker immediately followed by the sub-step's own line, so
  // the markers have to be read from the journal itself — this invocation's,
  // never an earlier swap's `phase=done`.
  it("asks systemd for the unit's current invocation, and has none before it starts", async () => {
    expect(await readSwapInvocationId()).toBeNull();
    expect(h.execCalls[0]).toEqual(["/usr/bin/systemctl", "show", "clawbox-root-update@harness_swap.service", "-p", "InvocationID"]);
    h.invocationId = "8f0c2e1d4b6a4c0e9a7d3e5f1b2c3d4e";
    expect(await readSwapInvocationId()).toBe("8f0c2e1d4b6a4c0e9a7d3e5f1b2c3d4e");
    h.unitError = new Error("no systemd");
    expect(await readSwapInvocationId()).toBeNull();
  });

  it("answers the newest marker of that invocation, from the marker lines alone", async () => {
    h.journal = ["[harness-swap] phase=request", "[harness-swap] phase=install", "[harness-swap] phase=lock"];
    expect(await latestSwapPhase("8f0c2e1d")).toBe("lock");
    const [cmd, ...args] = h.execCalls[0];
    expect(cmd).toBe("/usr/bin/journalctl");
    expect(args).toContain("_SYSTEMD_INVOCATION_ID=8f0c2e1d");
    expect(args).toContain("-g");
    expect(args[args.indexOf("-g") + 1]).toBe("^\\[harness-swap\\] phase=");
    expect(args).toContain("--no-pager");
  });

  it("is not fooled by a near miss the grep let through, and is null with no marker at all", async () => {
    h.journal = ["[harness-swap] phase=install", "[harness-swap] phase=INSTALL now"];
    expect(await latestSwapPhase("id")).toBe("install");
    h.journal = ["Collecting torch==2.4.0"];
    expect(await latestSwapPhase("id")).toBeNull();
    h.journal = [];
    expect(await latestSwapPhase("id")).toBeNull();
  });

  it("falls back to a bounded plain read when journalctl cannot grep, and to null when it cannot answer", async () => {
    h.journalGrepError = new Error("Compiled without pattern matching support");
    h.journal = ["Installing", "[harness-swap] phase=provision", "  -> install.sh --step hermes_edition"];
    expect(await latestSwapPhase("id")).toBe("provision");
    const plain = h.execCalls.filter(([cmd, ...args]) => cmd.endsWith("journalctl") && !args.includes("-g"));
    expect(plain).toHaveLength(1);
    expect(plain[0]).toContain("-n");
    h.unitError = new Error("journal unreadable");
    expect(await latestSwapPhase("id")).toBeNull();
  });

  it("follower: a marker on the line itself advances at once; any other line asks the journal", async () => {
    const phases: string[] = [];
    const scans: string[] = [];
    let latest: ReturnType<typeof parseSwapPhase> = null;
    const follower = swapPhaseFollower((phase) => phases.push(phase), {
      invocationId: async () => "id",
      latest: async (id) => { scans.push(id); return latest; },
    });

    expect(follower.onLine("[harness-swap] phase=install")).toBe("install");
    expect(phases).toEqual(["install"]);
    expect(follower.onLine("Collecting torch==2.4.0")).toBeNull();
    await follower.settled();
    expect(scans).toEqual(["id"]);
    expect(phases).toEqual(["install"]);

    latest = "provision";
    follower.onLine("  -> install.sh --step hermes_edition");
    await follower.settled();
    // The phase the scan skipped over is filled in, so the list stays whole.
    expect(phases).toEqual(["install", "lock", "provision"]);

    // Never backwards, never twice, and never the two the route announces itself.
    latest = "install";
    follower.onLine("later line");
    await follower.settled();
    expect(follower.onLine("[harness-swap] phase=done")).toBe("done");
    expect(phases).toEqual(["install", "lock", "provision"]);
  });

  it("follower: keeps asking for the invocation until the unit has one, then keeps it", async () => {
    const ids = ["", "", "id-1"];
    const asked: string[] = [];
    const follower = swapPhaseFollower(() => {}, {
      invocationId: async () => ids.shift() ?? "id-1",
      latest: async (id) => { asked.push(id); return null; },
    });
    for (const line of ["a", "b", "c", "d"]) follower.onLine(line);
    await follower.settled();
    expect(asked).toEqual(["id-1", "id-1"]);
  });

  it("follower: a scan that throws is swallowed and the next line scans again", async () => {
    let calls = 0;
    const follower = swapPhaseFollower(() => {}, {
      invocationId: async () => "id",
      latest: async () => { calls += 1; if (calls === 1) throw new Error("journal gone"); return null; },
    });
    follower.onLine("a");
    follower.onLine("b");
    await expect(follower.settled()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("one swap at a time", () => {
  it("is idle when nothing is claimed and the unit is inactive", async () => {
    expect(await swapInProgress()).toEqual({ inProgress: false, target: null });
    expect(h.execCalls[0]).toEqual(["/usr/bin/systemctl", "show", "clawbox-root-update@harness_swap.service", "-p", "ActiveState"]);
  });

  it("reports this process's claim, and releases it", async () => {
    expect(await claimSwap("hermes")).toBe(true);
    expect(await swapInProgress()).toEqual({ inProgress: true, target: "hermes" });
    expect(await claimSwap("hermes")).toBe(false);
    releaseSwap();
    expect(await swapInProgress()).toEqual({ inProgress: false, target: null });
  });

  it("refuses two claims racing through the same tick", async () => {
    const [first, second] = await Promise.all([claimSwap("hermes"), claimSwap("hermes")]);
    expect([first, second].sort()).toEqual([false, true]);
  });

  it("sees a unit another process started, naming the target from the request file", async () => {
    h.unitState = "ActiveState=active\n";
    await writeSwapRequest("openclaw");
    expect(await swapInProgress()).toEqual({ inProgress: true, target: "openclaw" });
    expect(await claimSwap("openclaw")).toBe(false);
    // The refused claim must not stick.
    h.unitState = "ActiveState=inactive\n";
    expect(await claimSwap("openclaw")).toBe(true);
  });

  it("reads `activating` as running too, and a systemctl that fails as idle", async () => {
    h.unitState = "ActiveState=activating\n";
    expect((await swapInProgress()).inProgress).toBe(true);
    h.unitError = new Error("no systemd");
    expect((await swapInProgress()).inProgress).toBe(false);
    expect(await claimSwap("hermes")).toBe(true);
  });
});

describe("the preflight", () => {
  it("passes a box with room, a network and no run", async () => {
    expect(await preflightSwap("hermes", probes())).toBeNull();
  });

  it("refuses while an in-app update owns the box, before any other probe is asked", async () => {
    const codingRuns = vi.fn(async () => 0);
    const refusal = await preflightSwap("hermes", probes({ updateLocked: async () => true, codingRuns }));
    expect(refusal).toMatchObject({ status: 409, code: "update_in_progress" });
    expect(codingRuns).not.toHaveBeenCalled();
  });

  it("reads the update lock from the config store by default", async () => {
    h.updateLocked.mockResolvedValue(true);
    const rest = { codingRuns: async () => 0, online: async () => true, freeBytes: async () => null, memAvailableMb: async () => null };
    expect(await preflightSwap("hermes", rest)).toMatchObject({ code: "update_in_progress" });
  });

  it("refuses while a coding run is live", async () => {
    const refusal = await preflightSwap("hermes", probes({ codingRuns: async () => 1 }));
    expect(refusal).toMatchObject({ status: 409, code: "coding_run_live" });
  });

  it("asks the coding agent's own status for the run count by default", async () => {
    h.getCodingAgentStatus.mockResolvedValue({ running: 2 });
    const rest = { online: async () => true, freeBytes: async () => null, memAvailableMb: async () => null };
    expect(await preflightSwap("openclaw", rest)).toMatchObject({ code: "coding_run_live" });
  });

  it("refuses a Hermes install the box cannot download, asking the installer's origin", async () => {
    const online = vi.fn(async () => false);
    expect(await preflightSwap("hermes", probes({ online }))).toMatchObject({ status: 412, code: "offline" });
    expect(online).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledWith(SWAP_INSTALL_ORIGIN);
  });

  it("does not ask the network for OpenClaw when the core is already installed", async () => {
    const online = vi.fn(async () => false);
    expect(await preflightSwap("openclaw", probes({ online, openclawInstalled: async () => true }))).toBeNull();
    expect(online).not.toHaveBeenCalled();
  });

  it("asks the npm registry for OpenClaw when the core is absent — a Hermes-SKU box downloads it", async () => {
    const online = vi.fn(async () => false);
    const refusal = await preflightSwap("openclaw", probes({ online, openclawInstalled: async () => false }));
    expect(refusal).toMatchObject({ status: 412, code: "offline" });
    expect(String(refusal?.error)).toContain("OpenClaw");
    expect(online).toHaveBeenCalledWith(SWAP_NPM_ORIGIN);
    expect(SWAP_NPM_ORIGIN).toBe("https://registry.npmjs.org/");
  });

  it("knows the core by the binary the config module finds — an absolute path, never the bare name", async () => {
    const online = vi.fn(async () => false);
    const rest = { online, codingRuns: async () => 0, freeBytes: async () => null, memAvailableMb: async () => null };
    expect(await preflightSwap("openclaw", rest)).toBeNull();
    h.openclawBin = "openclaw";
    expect(await preflightSwap("openclaw", rest)).toMatchObject({ code: "offline" });
  });

  it("refuses under 3 GiB free on the data directory's filesystem", async () => {
    const freeBytes = vi.fn<(dir: string) => Promise<number | null>>(async () => SWAP_MIN_FREE_BYTES - 1);
    const refusal = await preflightSwap("hermes", probes({ freeBytes }));
    expect(refusal).toMatchObject({ status: 412, code: "disk" });
    expect(freeBytes.mock.calls[0][0]).toMatch(/[\\/]data$/);
    expect(await preflightSwap("hermes", probes({ freeBytes: async () => SWAP_MIN_FREE_BYTES }))).toBeNull();
  });

  it("refuses under 1500 MB of MemAvailable", async () => {
    const refusal = await preflightSwap("hermes", probes({ memAvailableMb: async () => SWAP_MIN_AVAILABLE_MB - 1 }));
    expect(refusal).toMatchObject({ status: 412, code: "memory" });
    expect(String(refusal?.error)).toContain(String(SWAP_MIN_AVAILABLE_MB - 1));
  });

  it("treats a probe that cannot answer as no evidence, not as a refusal", async () => {
    expect(await preflightSwap("hermes", probes({
      updateLocked: async () => { throw new Error("config store unreadable"); },
      freeBytes: async () => null,
      memAvailableMb: async () => null,
      codingRuns: async () => { throw new Error("runs store unreadable"); },
    }))).toBeNull();
  });

  it("follows the step for as long as systemd would — never a shorter budget than the unit's own", () => {
    // config/clawbox-root-update@.service: TimeoutStartSec=7200. A follow that
    // gave up first deleted the request and reported failure over a running unit.
    expect(SWAP_FOLLOW_TIMEOUT_MS).toBeGreaterThanOrEqual(7200 * 1000);
  });

  it("carries a sentence with every code", async () => {
    for (const over of [
      { codingRuns: async () => 1 },
      { online: async () => false },
      { freeBytes: async () => 0 },
      { memAvailableMb: async () => 0 },
    ]) {
      const refusal = await preflightSwap("hermes", probes(over));
      expect(refusal?.error, refusal?.code).toMatch(/\w+ \w+/);
    }
  });
});

describe("the carry-over after the lock has flipped", () => {
  const lines: string[] = [];
  const emit = (s: string) => { lines.push(s); };
  beforeEach(() => { lines.length = 0; });

  it("→ Hermes: applies the stored ClawBox AI token and tier, and the Telegram bot", async () => {
    store({ clawai_token: "claw_abc", clawai_tier: "pro", telegram_bot_token: "123:bot" });

    const notes = await carryOverAfterSwap("hermes", emit);

    expect(h.applyClawaiToHermes).toHaveBeenCalledWith("claw_abc", "pro");
    expect(h.setHermesTelegramToken).toHaveBeenCalledWith("123:bot");
    expect(h.ensureHermesGateway).toHaveBeenCalled();
    expect(notes).toEqual([SWAP_NOTES.clawaiCarried, SWAP_NOTES.telegramApprovals]);
    expect(h.setTelegramToken).not.toHaveBeenCalled();
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("→ Hermes: defaults the tier when the badge is missing or foreign", async () => {
    store({ clawai_token: "claw_abc", clawai_tier: "business" });
    await carryOverAfterSwap("hermes", emit);
    expect(h.applyClawaiToHermes).toHaveBeenCalledWith("claw_abc", "flash");
  });

  it("→ Hermes: a refused ClawBox AI write is a sign-in-again note, never a throw, never the token", async () => {
    store({ clawai_token: "claw_secret", clawai_tier: "flash" });
    h.applyClawaiToHermes.mockRejectedValue(new Error("hermes refused claw_secret"));

    const notes = await carryOverAfterSwap("hermes", emit);

    expect(notes).toEqual([SWAP_NOTES.clawaiSignIn]);
    expect(lines.join("\n")).toContain("hermes refused");
    expect(lines.join("\n")).not.toContain("claw_secret");
  });

  it("→ Hermes: no token on the box means sign in again, and the writer is not asked", async () => {
    store({});
    expect(await carryOverAfterSwap("hermes", emit)).toEqual([SWAP_NOTES.clawaiSignIn]);
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    expect(h.setHermesTelegramToken).not.toHaveBeenCalled();
  });

  it("→ Hermes: a gateway that does not confirm the bot is a pending note beside the approvals one", async () => {
    store({ telegram_bot_token: "123:bot" });
    h.ensureHermesGateway.mockResolvedValue({ installed: true, running: true, scope: "system", applied: false });
    expect(await carryOverAfterSwap("hermes", emit)).toEqual([
      SWAP_NOTES.clawaiSignIn, SWAP_NOTES.telegramPending, SWAP_NOTES.telegramApprovals,
    ]);
    h.ensureHermesGateway.mockRejectedValue(new Error("hermes gateway status timed out"));
    expect(await carryOverAfterSwap("hermes", emit)).toContain(SWAP_NOTES.telegramPending);
  });

  it("→ Hermes: a refused bot token is said as such, and nothing is claimed about approvals", async () => {
    store({ telegram_bot_token: "123:secret" });
    h.setHermesTelegramToken.mockRejectedValue(new Error("Hermes rejected the bot token 123:secret"));
    const notes = await carryOverAfterSwap("hermes", emit);
    expect(notes).toEqual([SWAP_NOTES.clawaiSignIn, SWAP_NOTES.telegramNotCarried]);
    expect(h.ensureHermesGateway).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("123:secret");
  });

  it("→ OpenClaw: writes the bot into openclaw.json and restarts the gateway", async () => {
    store({ clawai_token: "claw_abc", telegram_bot_token: "123:bot" });
    h.readConfig.mockResolvedValue({ models: { providers: { deepseek: { apiKey: "claw_abc", baseUrl: "https://ai.clawbox.com" } } } });

    const notes = await carryOverAfterSwap("openclaw", emit);

    expect(h.setTelegramToken).toHaveBeenCalledWith("123:bot");
    expect(h.restartGateway).toHaveBeenCalled();
    expect(notes).toEqual([SWAP_NOTES.clawaiCarried, SWAP_NOTES.telegramApprovals]);
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
    expect(h.setHermesTelegramToken).not.toHaveBeenCalled();
  });

  it("→ OpenClaw: refreshes the shared identity into the OpenClaw workspace, the runtime switcher's way", async () => {
    store({});
    const notes = await carryOverAfterSwap("openclaw", emit);
    const sync = h.execCalls.find((call) => call.some((arg) => arg.endsWith("scripts/clawbox-identity-sync.sh")));
    expect(sync).toBeDefined();
    expect(sync?.[0]).toBe("bash");
    expect(sync?.at(-1)).toBe("openclaw");
    // The script guards the introduction ritual itself; a refresh that landed is no note.
    expect(notes).toEqual([SWAP_NOTES.clawaiSignIn]);
  });

  it("→ OpenClaw: a persona refresh that fails is a note, never a throw — and never runs for Hermes, whose step did it", async () => {
    store({});
    h.unitError = new Error("identity-sync: canonical identity missing");
    expect(await carryOverAfterSwap("openclaw", emit)).toEqual([SWAP_NOTES.clawaiSignIn, SWAP_NOTES.identityNotSynced]);
    expect(lines.join("\n")).toContain("canonical identity missing");
    h.execCalls.length = 0;
    h.unitError = null;
    await carryOverAfterSwap("hermes", emit);
    expect(h.execCalls.find((call) => call.some((arg) => arg.includes("identity-sync")))).toBeUndefined();
  });

  it("→ OpenClaw: says sign in again when openclaw.json carries no ClawBox AI provider — never a faked success", async () => {
    store({ clawai_token: "claw_abc" });
    for (const config of [
      {},
      { models: { providers: {} } },
      { models: { providers: { deepseek: {} } } },
      { models: { providers: { deepseek: { apiKey: "  " } } } },
    ]) {
      h.readConfig.mockResolvedValue(config);
      expect(await carryOverAfterSwap("openclaw", emit), JSON.stringify(config)).toEqual([SWAP_NOTES.clawaiSignIn]);
    }
  });

  it("→ OpenClaw: a gateway restart that fails leaves the bot saved and pending", async () => {
    store({ telegram_bot_token: "123:bot" });
    h.restartGateway.mockRejectedValue(new Error("restart failed"));
    expect(await carryOverAfterSwap("openclaw", emit)).toEqual([
      SWAP_NOTES.clawaiSignIn, SWAP_NOTES.telegramPending, SWAP_NOTES.telegramApprovals,
    ]);
  });

  it("says so when the box's own store will not read, instead of guessing", async () => {
    h.get.mockRejectedValue(new Error("EACCES: data/config.json"));
    expect(await carryOverAfterSwap("hermes", emit)).toEqual([SWAP_NOTES.clawaiSignIn, SWAP_NOTES.telegramNotCarried]);
    expect(h.applyClawaiToHermes).not.toHaveBeenCalled();
  });
});
