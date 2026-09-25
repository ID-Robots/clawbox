import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-1197 — the state-schema pre-flight judged the WRONG core.
 *
 * It read `config/openclaw-target.txt` before step 1, and before step 1 that
 * file is the release the box is LEAVING: `bootstrap_updater` is what syncs the
 * tree to the release it is going to. So every full update was judged by the
 * core the box already had —
 *
 *   - the TASK-1088 box (pinned 2026.9.3, store migrated to schema 17 by a
 *     2026.9.4 core) was refused the one update, pinned 2026.9.4, that would
 *     have repaired it; and
 *   - an update to a release whose pin moves BACKWARDS past the store was let
 *     through on the newer pin already on disk, into the mid-run failure the
 *     check exists to prevent.
 *
 * The pre-flight now asks the release it is going to — fetched, read with
 * `git show`, nothing checked out — and asks again at the `openclaw_install`
 * boundary on the synced tree, for a pin the first ask could not clear.
 *
 * Each case is a checkout on disk (`CLAWBOX_ROOT`: `.update-branch`, the pin
 * file) and a git whose every call is written down, so "which pin was judged"
 * and "what ran" are both observable.
 */

const { root, originalRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  const originalRoot = process.env.CLAWBOX_ROOT;
  // Read once, at import, into PROJECT_DIR — so it is set before the import.
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-schema-target-"));
  process.env.CLAWBOX_ROOT = root;
  return { root, originalRoot };
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
}));

// No gateway to quiesce around `openclaw_install`: the cases that dispatch it
// are about WHETHER it is dispatched, and the quiesce has its own suite.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  gatewayIsAbsent: () => true,
  openclawIsAbsent: () => false,
}));

vi.mock("@/lib/x64-integration", () => ({ hasX64DesktopIntegration: () => false }));

import { get, set, setMany } from "@/lib/config-store";
import * as childProcess from "child_process";
import { readStateSchemaVersion, statePath } from "@/lib/openclaw-state-store";
import * as updater from "@/lib/updater";

const DB = "/home/clawbox/.openclaw/state/openclaw.sqlite";
const PIN_FILE = path.join(root, "config", "openclaw-target.txt");
const OFFLINE = /No internet connection/;

/** Every child the updater started, as one argv string each. */
let calls: string[] = [];

interface Box {
  /** The pin in the checkout the box is on now. */
  checkoutPin: string;
  /** The pin in the release `origin/beta` points at. */
  targetPin: string;
  /** The store's schema. */
  schema: number | null;
  /** Does `git fetch` land? */
  fetch?: boolean;
  /** Does the internet probe answer? Offline is the proof a run was let through. */
  online?: boolean;
  /** Does `bootstrap_updater` sync the tree, i.e. write the target pin to disk? */
  syncWritesTarget?: boolean;
  /** A root step that fails when dispatched — how a run that got past the pre-flight is settled. */
  failingStep?: string;
}

function box({
  checkoutPin, targetPin, schema, fetch = true, online = false, syncWritesTarget = true, failingStep,
}: Box): void {
  writeFileSync(path.join(root, ".update-branch"), "beta\n");
  mkdirSync(path.dirname(PIN_FILE), { recursive: true });
  writeFileSync(PIN_FILE, `${checkoutPin}\n`);
  vi.mocked(statePath).mockReturnValue(DB);
  // Written into the same log as the children, so WHEN the store was asked —
  // before step 1, or at the install boundary — can be read off it.
  vi.mocked(readStateSchemaVersion).mockImplementation(() => {
    calls.push("schema-read");
    return schema;
  });
  calls = [];
  vi.mocked(childProcess.execFile).mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: Error | null, out?: unknown, err2?: unknown) => void;
    const argv = [cmd, ...args].join(" ");
    calls.push(argv);
    const ok = (stdout = "") => cb(null, { stdout, stderr: "" });
    if (cmd === "git") {
      if (args.includes("fetch")) {
        return fetch ? ok() : cb(Object.assign(new Error("fatal: unable to access 'https://github.com/'"), {
          stderr: "fatal: unable to access 'https://github.com/': Could not resolve host: github.com",
        }));
      }
      if (args.includes("show")) return ok(`${targetPin}\n`);
      return ok();
    }
    if (cmd.endsWith("sudo")) {
      if (syncWritesTarget && args.includes("bootstrap_updater")) writeFileSync(PIN_FILE, `${targetPin}\n`);
      if (failingStep && args.includes(failingStep)) return cb(new Error(`${failingStep} failed`));
      return ok();
    }
    if (cmd.includes("ping")) return online ? ok() : cb(new Error("ping: unreachable"));
    return ok();
  }) as never);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (online) return new Response(null, { status: 200 });
    throw new Error("offline");
  }));
}

/** Run an update to its settled verdict. */
async function runToVerdict(start: () => { started: boolean; error?: string }) {
  expect(start()).toEqual({ started: true });
  await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"), { timeout: 10_000 });
  return updater.getUpdateState();
}

/** Was this root step started (`sudo -n clawbox-run-root-step.sh <step>`)? */
const dispatched = (step: string) => calls.some((c) => c.startsWith("/usr/bin/sudo ") && c.split(" ").includes(step));
const gitCalls = (sub: string) => calls.filter((c) => c.startsWith("git ") && c.split(" ").includes(sub));

beforeEach(() => {
  updater.resetUpdateState();
  process.env.CLAWBOX_EDITION = "openclaw";
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
  delete process.env.GATEWAY_HEALTH_WAIT_MS;
  delete process.env.GATEWAY_RECOVERY_WAIT_MS;
  delete process.env.GATEWAY_WAIT_INTERVAL_MS;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalRoot;
});

describe("the pre-flight judges the core the update will INSTALL", () => {
  it("refuses a release whose pin moves back past the store, though the pin on disk is fine", async () => {
    // On disk: 2026.9.4 (schema 17) — the old pre-flight's answer was "fine".
    // The release: 2026.9.3 (schema 16), which cannot open this store.
    box({ checkoutPin: "2026.9.4", targetPin: "2026.9.3", schema: 17 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.error).toContain("state schema 17");
    expect(state.error).toContain("the pinned OpenClaw 2026.9.3 supports schema 16");
    expect(state.error).toMatch(/refused before it changed anything/);
    expect(state.currentStepIndex).toBe(-1);
    expect(state.steps.every((s) => s.status === "pending")).toBe(true);
    // Read from the RELEASE, after fetching it, and nothing checked out: the
    // box is on the tree it was on.
    const fetchAt = calls.findIndex((c) => c.startsWith("git ") && c.includes(" fetch "));
    const showAt = calls.findIndex((c) => c.startsWith("git ") && c.includes("origin/beta:config/openclaw-target.txt"));
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(showAt).toBeGreaterThan(fetchAt);
    expect(gitCalls("checkout")).toEqual([]);
    expect(gitCalls("reset")).toEqual([]);
    expect(dispatched("bootstrap_updater")).toBe(false);
  });

  it("lets through the update that REPAIRS a box the pin on disk cannot open (the TASK-1088 box)", async () => {
    // On disk: 2026.9.3 (schema 16) under a schema-17 store — the old
    // pre-flight refused this box its own fix.
    box({ checkoutPin: "2026.9.3", targetPin: "2026.9.4", schema: 17 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.error, "the update must be let through to the network probe").toMatch(OFFLINE);
    expect(state.error).not.toContain("state schema");
  });

  it("stands down — never falling back to the pin on disk — when the release cannot be fetched", async () => {
    // The pin on disk would refuse (16 < 17). Judging by it is the defect, so
    // an unreadable target is an unknown and the run goes on to the probe.
    box({ checkoutPin: "2026.9.3", targetPin: "2026.9.4", schema: 17, fetch: false });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.error).toMatch(OFFLINE);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toMatch(
      /could not read which OpenClaw this update installs/,
    );
    // ONE attempt: an offline box is not made to wait through retries for the
    // verdict it is about to be given.
    expect(gitCalls("fetch")).toHaveLength(1);
  });

  it("still honours OPENCLAW_PIN_VERSION the way install.sh does, without asking git", async () => {
    box({ checkoutPin: "2026.9.4", targetPin: "2026.9.4", schema: 17 });
    process.env.OPENCLAW_PIN_VERSION = "2026.8.1";
    try {
      const state = await runToVerdict(() => updater.startUpdate());
      expect(state.error).toContain("the pinned OpenClaw 2026.8.1 supports schema 15");
      expect(gitCalls("show")).toEqual([]);
    } finally {
      delete process.env.OPENCLAW_PIN_VERSION;
    }
  });

  it("reads the checkout for the OpenClaw-only update, which syncs nothing — so it IS the target", async () => {
    box({ checkoutPin: "2026.9.3", targetPin: "2026.9.4", schema: 17 });

    const state = await runToVerdict(() => updater.startOpenclawUpdate());

    expect(state.error).toContain("the pinned OpenClaw 2026.9.3 supports schema 16");
    expect(state.currentStepIndex).toBe(-1);
    expect(gitCalls("fetch")).toEqual([]);
  });
});

describe("the second ask, at the openclaw_install boundary on the synced tree", () => {
  it("refuses there when the first ask could not read the release — before the core is touched", async () => {
    // The fetch fails, so the first ask stands down; the sync then lands the
    // release's 2026.9.3 pin, which is what install.sh would read.
    box({ checkoutPin: "2026.9.4", targetPin: "2026.9.3", schema: 17, fetch: false, online: true });

    const state = await runToVerdict(() => updater.startUpdate());

    const install = state.steps.find((s) => s.id === "openclaw_install")!;
    expect(install.status).toBe("failed");
    expect(install.error).toContain("the pinned OpenClaw 2026.9.3 supports schema 16");
    expect(install.error).toMatch(/stopped before it touched OpenClaw, and the assistant keeps the core it has/);
    // Not "before it changed anything": the sync and the package steps ran.
    expect(install.error).not.toMatch(/before it changed anything/);
    expect(state.error).toBe(install.error);
    expect(dispatched("bootstrap_updater")).toBe(true);
    // THE POINT: the step that retires the working core was never started.
    expect(dispatched("openclaw_install")).toBe(false);
    const after = state.steps.slice(state.steps.indexOf(install) + 1);
    expect(after.every((s) => s.status === "pending")).toBe(true);
  });

  it("dispatches the install when the synced pin supports the store", async () => {
    box({
      checkoutPin: "2026.9.3", targetPin: "2026.9.4", schema: 17, fetch: false, online: true,
      failingStep: "openclaw_install",
    });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(dispatched("openclaw_install")).toBe(true);
    expect(state.error).toBe("openclaw_install failed");
    // The first ask had no pin to judge and did not open the store; the one
    // read is the boundary's — after the sync, before the install.
    const read = calls.indexOf("schema-read");
    expect(calls.filter((c) => c === "schema-read")).toHaveLength(1);
    expect(read).toBeGreaterThan(calls.findIndex((c) => c.startsWith("/usr/bin/sudo ") && c.includes("bootstrap_updater")));
    expect(read).toBeLessThan(calls.findIndex((c) => c.startsWith("/usr/bin/sudo ") && c.includes("openclaw_install")));
  });

  it("does not ask again for a pin the first ask already cleared", async () => {
    box({
      checkoutPin: "2026.9.3", targetPin: "2026.9.4", schema: 17, online: true,
      failingStep: "openclaw_install",
    });

    await runToVerdict(() => updater.startUpdate());

    expect(dispatched("openclaw_install")).toBe(true);
    // One read, and it is the first ask's: ahead of step 1.
    expect(calls.filter((c) => c === "schema-read")).toHaveLength(1);
    expect(calls.indexOf("schema-read")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("/usr/bin/sudo ") && c.includes("bootstrap_updater")),
    );
  });
});
