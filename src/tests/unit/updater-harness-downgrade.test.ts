import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Switching update branch backwards — beta -> main while main still pins
 * OpenClaw 2026.10.3, or any rollback — on a box whose agent databases
 * OpenClaw 2026.10.6 has migrated to schema 25. 2026.10.3 reads up to 24 and
 * its repair step refuses them outright, so the update used to stop there with
 * the gateway left stopped. The state database (schema 20 for both) gave the
 * old pre-flight nothing to see.
 *
 * The pre-flight now reads the target branch's pins (OpenClaw and, on a box
 * that runs it, Hermes) before step 1 and compares them with what is installed
 * and with every database on disk; a downgrade is refused with a code the
 * screen localises, and goes ahead only on the owner's explicit override,
 * after a backup.
 *
 * Each case is a checkout on disk (`CLAWBOX_ROOT`: `.update-branch`, the pin
 * file) and a git whose every call is written down.
 */

const { root, originalRoot, HERMES_DIR, HERMES_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  const originalRoot = process.env.CLAWBOX_ROOT;
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-harness-downgrade-"));
  process.env.CLAWBOX_ROOT = root;
  // Read at import: the edition comes from the environment, never this machine.
  process.env.CLAWBOX_EDITION_FILE = nodePath.join(root, "no-edition.env");
  const HERMES_DIR = nodePath.join(root, "hermes-agent");
  const HERMES_HOME = nodePath.join(root, "hermes-home");
  return { root, originalRoot, HERMES_DIR, HERMES_HOME };
});

vi.mock("@/lib/config-store", () => {
  const get = vi.fn();
  return {
    get,
    getKnown: vi.fn(async (key: string) => ({ value: await get(key), known: true })),
    set: vi.fn(),
    setMany: vi.fn(),
  };
});

vi.mock("child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));

vi.mock("@/lib/openclaw-state-store", () => ({
  statePath: vi.fn(),
  readStateSchemaVersion: vi.fn(),
  readAgentSchemaVersions: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  gatewayIsAbsent: () => true,
  openclawIsAbsent: () => false,
}));

vi.mock("@/lib/x64-integration", () => ({ hasX64DesktopIntegration: () => false, hasX64Install: () => false, X64_DESKTOP_CORE_STEP_TIMEOUT_MS: 6_600_000, X64_DESKTOP_GATEWAY_READY_WAIT_MS: 240_000 }));

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));

vi.mock("@/lib/harness-downgrade-backup", () => ({
  backUpBeforeDowngrade: vi.fn(),
  writeDowngradeAuthorization: vi.fn(),
  clearDowngradeAuthorization: vi.fn(),
  downgradeAuthorizedFor: vi.fn(),
}));

// The installed core is read from its package.json under the npm prefix; that
// one path is answered here, every other read is the real file.
const { installedCore } = vi.hoisted(() => ({ installedCore: { version: null as string | null } }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFile = vi.fn(async (p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith("/.npm-global/lib/node_modules/openclaw/package.json")) {
      if (!installedCore.version) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return JSON.stringify({ name: "openclaw", version: installedCore.version });
    }
    return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  });
  return { ...actual, default: { ...actual, readFile }, readFile };
});

import { get, set, setMany } from "@/lib/config-store";
import * as childProcess from "child_process";
import { readAgentSchemaVersions, readStateSchemaVersion, statePath } from "@/lib/openclaw-state-store";
import { runHermesCli } from "@/lib/hermes-cli";
import {
  backUpBeforeDowngrade,
  clearDowngradeAuthorization,
  downgradeAuthorizedFor,
  writeDowngradeAuthorization,
} from "@/lib/harness-downgrade-backup";
import * as updater from "@/lib/updater";

const STATE_DB = "/home/clawbox/.openclaw/state/openclaw.sqlite";
const AGENT_DB = "/home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite";
const PIN_FILE = path.join(root, "config", "openclaw-target.txt");
const OFFLINE = /No internet connection/;
const HERMES_OLD = "2237be355906fbe6065ce1815711eee52b2d646e";
const HERMES_NEW = "4d04303818b61bf3aa09278af48356315515965b";

let calls: string[] = [];

interface Box {
  /** The pin in the checkout the box is on now. */
  checkoutPin?: string;
  /** The pin on the branch it is switching to. */
  targetPin: string;
  /** The OpenClaw core installed now; null for none. */
  installed: string | null;
  /** The newest agent database's schema; null for none. */
  agentSchema: number | null;
  stateSchema?: number;
  /** The Hermes pin on the target branch, and what is checked out now (a Hermes box). */
  hermes?: { targetCommit: string; targetName: string; head: string; installedVersion: string; ancestor: boolean };
}

function box({ checkoutPin = "2026.10.6", targetPin, installed, agentSchema, stateSchema = 20, hermes }: Box): void {
  writeFileSync(path.join(root, ".update-branch"), "main\n");
  mkdirSync(path.dirname(PIN_FILE), { recursive: true });
  writeFileSync(PIN_FILE, `${checkoutPin}\n`);
  installedCore.version = installed;
  vi.mocked(statePath).mockReturnValue(STATE_DB);
  vi.mocked(readStateSchemaVersion).mockReturnValue(stateSchema);
  vi.mocked(readAgentSchemaVersions).mockReturnValue(
    agentSchema === null ? [] : [{ agentId: "main", path: AGENT_DB, version: agentSchema }],
  );
  vi.mocked(backUpBeforeDowngrade).mockResolvedValue({
    ok: true, kind: "local", dir: "/home/clawbox/clawbox-harness-backups/20261023T000000Z", summary: "backed up",
  });
  vi.mocked(writeDowngradeAuthorization).mockResolvedValue(undefined);
  vi.mocked(clearDowngradeAuthorization).mockResolvedValue(undefined);
  vi.mocked(downgradeAuthorizedFor).mockResolvedValue(false);
  if (hermes) {
    process.env.CLAWBOX_EDITION = "dual";
    // The session store an older release cannot run on, once a newer one wrote it.
    mkdirSync(HERMES_HOME, { recursive: true });
    writeFileSync(path.join(HERMES_HOME, "state.db"), "");
    vi.mocked(runHermesCli).mockResolvedValue({ code: 0, stdout: `Hermes Agent v${hermes.installedVersion} (2026.10.20)\n`, stderr: "" });
  }
  calls = [];
  vi.mocked(childProcess.execFile).mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: Error | null, out?: unknown) => void;
    calls.push([cmd, ...args].join(" "));
    const ok = (stdout = "") => cb(null, { stdout, stderr: "" });
    if (cmd === "git" && args.includes(HERMES_DIR)) {
      if (!hermes) return cb(new Error("not a git repository"));
      if (args.includes("rev-parse")) return ok(`${hermes.head}\n`);
      if (args.includes("merge-base")) return hermes.ancestor ? ok() : cb(Object.assign(new Error("not ancestor"), { code: 1 }));
      return ok();
    }
    if (cmd === "git") {
      if (args.some((a) => a.endsWith(":config/openclaw-target.txt"))) return ok(`${targetPin}\n`);
      if (args.some((a) => a.endsWith(":install.sh")) && hermes) {
        return ok(`# Current pin: upstream tag v2026.9.7 == "Hermes Agent v${hermes.targetName}" (pinned).\n`
          + `HERMES_PIN_COMMIT="\${HERMES_PIN_COMMIT:-${hermes.targetCommit}}"\n`);
      }
      return ok();
    }
    if (cmd.includes("ping")) return cb(new Error("ping: unreachable"));
    return ok();
  }) as never);
  // Offline: a run the pre-flight lets through stops at the network probe.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
}

async function runToVerdict(start: () => { started: boolean; error?: string }) {
  expect(start()).toEqual({ started: true });
  await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"), { timeout: 10_000 });
  return updater.getUpdateState();
}

const gitCalls = (sub: string) => calls.filter((c) => c.startsWith("git ") && c.split(" ").includes(sub));
const dispatched = (step: string) => calls.some((c) => c.startsWith("/usr/bin/sudo ") && c.split(" ").includes(step));

beforeEach(() => {
  updater.resetUpdateState();
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.HERMES_AGENT_DIR = HERMES_DIR;
  process.env.HERMES_HOME = HERMES_HOME;
  process.env.GATEWAY_HEALTH_WAIT_MS = "1";
  process.env.GATEWAY_RECOVERY_WAIT_MS = "1";
  process.env.GATEWAY_WAIT_INTERVAL_MS = "1";
  delete process.env.OPENCLAW_PIN_VERSION;
  vi.mocked(get).mockReset();
  vi.mocked(get).mockResolvedValue(undefined as never);
  vi.mocked(set).mockReset();
  vi.mocked(set).mockResolvedValue(undefined as never);
  vi.mocked(setMany).mockReset();
  vi.mocked(setMany).mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  updater.resetUpdateState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(childProcess.execFile).mockReset();
  vi.mocked(backUpBeforeDowngrade).mockReset();
  vi.mocked(writeDowngradeAuthorization).mockReset();
  vi.mocked(clearDowngradeAuthorization).mockReset();
  delete process.env.HERMES_AGENT_DIR;
  delete process.env.HERMES_HOME;
  rmSync(HERMES_HOME, { recursive: true, force: true });
  delete process.env.GATEWAY_HEALTH_WAIT_MS;
  delete process.env.GATEWAY_RECOVERY_WAIT_MS;
  delete process.env.GATEWAY_WAIT_INTERVAL_MS;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalRoot;
  delete process.env.CLAWBOX_EDITION_FILE;
});

describe("Update now: a target older than the data is refused before anything changes", () => {
  it("refuses main's 2026.10.3 over agent databases 2026.10.6 migrated to schema 25", async () => {
    box({ targetPin: "2026.10.3", installed: "2026.10.6", agentSchema: 25 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.errorCode).toBe("harness_downgrade");
    expect(state.downgrade).toEqual({
      branch: "main",
      downgrades: [{
        harness: "openclaw",
        installed: "2026.10.6",
        target: "2026.10.3",
        schema: { database: "agent", label: AGENT_DB, onDisk: 25, supported: 24 },
      }],
    });
    expect(state.error).toContain(`${AGENT_DB} is on agent schema 25`);
    expect(state.error).toContain("the pinned OpenClaw 2026.10.3 supports schema 24");
    expect(state.error).toMatch(/refused before it changed anything/);
    // Read off the fetched target, nothing checked out, no step started.
    expect(calls.some((c) => c.includes("origin/main:config/openclaw-target.txt"))).toBe(true);
    expect(gitCalls("checkout")).toEqual([]);
    expect(gitCalls("reset")).toEqual([]);
    expect(dispatched("bootstrap_updater")).toBe(false);
    expect(state.currentStepIndex).toBe(-1);
    expect(backUpBeforeDowngrade).not.toHaveBeenCalled();
  });

  it("refuses on the installed version for a pin whose schemas no table records", async () => {
    box({ targetPin: "2026.7.1", installed: "2026.10.6", agentSchema: 25 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.errorCode).toBe("harness_downgrade");
    expect(state.downgrade?.downgrades).toEqual([{ harness: "openclaw", installed: "2026.10.6", target: "2026.7.1" }]);
    expect(state.error).toContain("This device runs OpenClaw 2026.10.6, and this update would install the older OpenClaw 2026.7.1");
  });

  it("refuses an older Hermes on a box that runs it", async () => {
    box({
      targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25,
      hermes: { targetCommit: HERMES_OLD, targetName: "0.21.1", head: HERMES_NEW, installedVersion: "0.22.4", ancestor: true },
    });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.errorCode).toBe("harness_downgrade");
    expect(state.downgrade?.downgrades).toEqual([
      { harness: "hermes", installed: "0.22.4", target: "0.21.1", targetCommit: HERMES_OLD },
    ]);
    expect(calls.some((c) => c.includes("origin/main:install.sh"))).toBe(true);
    expect(dispatched("bootstrap_updater")).toBe(false);
  });
});

describe("Update now: the same or a newer target goes ahead", () => {
  it("lets the same pin through", async () => {
    box({ targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25 });
    const state = await runToVerdict(() => updater.startUpdate());
    expect(state.error).toMatch(OFFLINE);
    expect(state.errorCode).toBeUndefined();
  });

  it("lets a newer pin through over older databases", async () => {
    box({ checkoutPin: "2026.10.3", targetPin: "2026.10.6", installed: "2026.10.3", agentSchema: 24 });
    const state = await runToVerdict(() => updater.startUpdate());
    expect(state.error).toMatch(OFFLINE);
  });

  it("lets an older core through when no OpenClaw database is on disk for it to fail on", async () => {
    // A state dir moved aside (how the upgrade e2e builds its main baseline).
    box({ targetPin: "2026.9.4", installed: "2026.10.6", agentSchema: null });
    vi.mocked(statePath).mockReturnValue(null);
    const state = await runToVerdict(() => updater.startUpdate());
    expect(state.error).toMatch(OFFLINE);
  });

  it("lets an older Hermes through on a box with no state.db", async () => {
    box({
      targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25,
      hermes: { targetCommit: HERMES_OLD, targetName: "0.21.1", head: HERMES_NEW, installedVersion: "0.22.4", ancestor: true },
    });
    rmSync(path.join(HERMES_HOME, "state.db"));
    const state = await runToVerdict(() => updater.startUpdate());
    expect(state.error).toMatch(OFFLINE);
  });

  it("lets the pinned Hermes commit through", async () => {
    box({
      targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25,
      hermes: { targetCommit: HERMES_NEW, targetName: "0.22.4", head: HERMES_NEW, installedVersion: "0.22.4", ancestor: false },
    });
    const state = await runToVerdict(() => updater.startUpdate());
    expect(state.error).toMatch(OFFLINE);
  });

  it("withdraws an earlier run's authorisation before it judges anything", async () => {
    box({ targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25 });
    await runToVerdict(() => updater.startUpdate());
    expect(clearDowngradeAuthorization).toHaveBeenCalled();
  });
});

describe("the override: back up first, then go ahead", () => {
  it("backs the data up, authorises the installer for that core, and only then starts", async () => {
    box({ targetPin: "2026.10.3", installed: "2026.10.6", agentSchema: 25 });

    const state = await runToVerdict(() => updater.startUpdate({ allowHarnessDowngrade: true }));

    expect(backUpBeforeDowngrade).toHaveBeenCalledWith([
      expect.objectContaining({ harness: "openclaw", target: "2026.10.3", installed: "2026.10.6" }),
    ]);
    expect(writeDowngradeAuthorization).toHaveBeenCalledWith({
      openclaw: "2026.10.3",
      hermes: null,
      hermesCommit: null,
      backupDir: "/home/clawbox/clawbox-harness-backups/20261023T000000Z",
    });
    // The earlier run's authorisation is withdrawn BEFORE this run writes its own.
    expect(vi.mocked(clearDowngradeAuthorization).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(writeDowngradeAuthorization).mock.invocationCallOrder[0]);
    // Let through to the network probe, with the backup said on the result.
    expect(state.error).toMatch(OFFLINE);
    expect(state.errorCode).toBeUndefined();
    expect(state.warnings?.map((w) => w.code)).toContain("harness-downgrade-backup");
  });

  it("refuses when the backup could not be taken — no backup, no downgrade", async () => {
    box({ targetPin: "2026.10.3", installed: "2026.10.6", agentSchema: 25 });
    vi.mocked(backUpBeforeDowngrade).mockResolvedValue({ ok: false, reason: "openclaw backup create failed: disk full" });

    const state = await runToVerdict(() => updater.startUpdate({ allowHarnessDowngrade: true }));

    expect(state.errorCode).toBe("harness_downgrade_backup_failed");
    expect(state.error).toContain("could not be backed up");
    expect(state.error).toContain("disk full");
    // The command's own reason, apart from the prose the screen translates.
    expect(state.downgrade?.backupFailure).toBe("openclaw backup create failed: disk full");
    expect(writeDowngradeAuthorization).not.toHaveBeenCalled();
    expect(dispatched("bootstrap_updater")).toBe(false);
    expect(gitCalls("reset")).toEqual([]);
  });
});

describe("Settings update branch: checkBranchHarnessDowngrade", () => {
  it("answers the downgrade a branch would bring, read off origin without checking out", async () => {
    box({ targetPin: "2026.10.3", installed: "2026.10.6", agentSchema: 25 });

    const detail = await updater.checkBranchHarnessDowngrade("main");

    expect(detail?.branch).toBe("main");
    expect(detail?.downgrades[0]).toMatchObject({ harness: "openclaw", target: "2026.10.3", schema: { onDisk: 25, supported: 24 } });
    expect(calls.some((c) => c.startsWith("git ") && c.includes("fetch") && c.includes("main"))).toBe(true);
    expect(gitCalls("checkout")).toEqual([]);
  });

  it("answers null for a branch that pins the same or a newer core", async () => {
    box({ targetPin: "2026.10.6", installed: "2026.10.6", agentSchema: 25 });
    expect(await updater.checkBranchHarnessDowngrade("beta")).toBeNull();
  });
});
