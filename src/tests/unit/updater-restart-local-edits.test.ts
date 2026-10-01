import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv, testEnv } from "@/tests/helpers/env";

/**
 * The in-app updater's RESTART step, run for real over a checkout that has no
 * scripts/preserve-local-edits.sh (TASK-1316).
 *
 * E2E Install's upgrade shard updates the PR-head install to `main` first, and
 * that update died here: step 1 had moved the tree to main, which predates the
 * script, and the running build asked the tree for it — "main baseline failed
 * at step 'restart': … preserve-local-edits.sh: No such file or directory". The
 * same tree is what a downgrade, a channel switch or any older release gives a
 * box in the field. So this drives `updateClawBoxAndReboot` itself: real git
 * and real bash over a real fixture whose HEAD has no scripts/ directory; only
 * root, systemd and the network are stood in for. The run is resumed AT the
 * restart step (an interruption record, the way a box resumes after a reboot),
 * and the stand-in for the rebuild dispatch — the step's last act, after the
 * save and every reset — ends it, so the step's error says how far it got.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT_TEXT = fs.readFileSync(path.join(REPO, "scripts", "preserve-local-edits.sh"), "utf-8");
const REBUILD_REACHED = "test stand-in: the rebuild was dispatched";

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock("@/lib/config-store", () => {
  const put = (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  };
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    getKnown: vi.fn(async (key: string) => ({ value: store.get(key), known: true })),
    set: vi.fn(async (key: string, value: unknown) => put(key, value)),
    setMany: vi.fn(async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) put(key, value);
    }),
  };
});

// Root is the launcher's; the rebuild dispatch is where this test stops.
vi.mock("@/lib/root-step-runner", async (orig) => ({
  ...(await orig<typeof import("@/lib/root-step-runner")>()),
  startRootStep: vi.fn(async (stepId: string) => {
    if (stepId === "rebuild_reboot") throw new Error(REBUILD_REACHED);
  }),
}));

vi.mock("@/lib/x64-integration", () => ({ hasX64DesktopIntegration: vi.fn(() => false) }));

vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: vi.fn(async () => true),
}));

// REAL git and bash — the save and the resets are the subject. Everything else
// the updater asks for (ping, systemctl, journalctl, sudo) answers as a quiet
// box would, without running.
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
  const execFile = vi.fn((file: string, args: readonly string[], opts?: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as Callback | undefined;
    const options = (typeof opts === "function" || opts == null ? {} : opts) as object;
    if (file === "git" || file === "/bin/bash") {
      return actual.execFile(file, [...args], { ...options, encoding: "utf-8" }, (err, stdout, stderr) => {
        if (err) callback?.(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
        else callback?.(null, { stdout: String(stdout), stderr: String(stderr) });
      });
    }
    setImmediate(() => callback?.(null, { stdout: "", stderr: "" }));
    return new EventEmitter() as unknown as ChildProcess;
  });
  const exec = vi.fn((_cmd: string, opts?: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as Callback | undefined;
    setImmediate(() => callback?.(null, { stdout: "", stderr: "" }));
    return new EventEmitter() as unknown as ChildProcess;
  });
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => child.emit("close", 0));
    return child as unknown as ChildProcess;
  });
  return { ...actual, execFile, exec, spawn };
});

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let origin: string;
let checkout: string;
let saves: string;
let restoreEnv: () => void;
let updater: typeof import("@/lib/updater");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The owner's edits: one changed file, one new one. */
function edit(): void {
  write(path.join(checkout, "app.ts"), "export const v = 1; // tuned on the box\n");
  write(path.join(checkout, "notes.md"), "my notes\n");
}

/** Run the update from the restart step, as a box resuming at it does, and wait for its verdict. */
async function runRestartStep(): Promise<{ error?: string; warnings: { code: string; message: string }[] }> {
  store.set("update_interrupted_at", "2026-09-29T16:21:40.000Z");
  store.set("update_interrupted_detail", { cause: "reboot", step: "restart" });
  updater.resetUpdateState();
  expect(updater.startUpdate()).toEqual({ started: true });
  await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"), { timeout: 45_000, interval: 50 });
  const state = updater.getUpdateState();
  const restart = state.steps.find((s) => s.id === "restart");
  // Resumed at the restart step: nothing before it ran.
  expect(state.steps.filter((s) => s.status === "failed").map((s) => s.id)).toEqual(["restart"]);
  return { error: restart?.error, warnings: state.warnings ?? [] };
}

beforeEach(async () => {
  restoreEnv = saveEnv(
    "CLAWBOX_ROOT", "CLAWBOX_LOCAL_EDITS_DIR", "CLAWBOX_PRESERVE_LOCAL_EDITS_SH", "HOME", "GIT_CONFIG_NOSYSTEM",
    "GATEWAY_HEALTH_WAIT_MS", "GATEWAY_RECOVERY_WAIT_MS", "GATEWAY_WAIT_INTERVAL_MS",
  );
  store.clear();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-restart-edits-")));
  origin = path.join(tmp, "origin");
  checkout = path.join(tmp, "clawbox");
  saves = path.join(tmp, "clawbox-local-edits");
  if (!CAN_RUN) return;

  // `main` as it is today: no scripts/preserve-local-edits.sh, no scripts/ at all.
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  write(path.join(origin, ".gitignore"), "data/\n.next/\n.update-branch\n");
  write(path.join(origin, "app.ts"), "export const v = 1;\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "main");
  git(tmp, "clone", "-q", "--branch", "main", origin, checkout);
  write(path.join(checkout, ".update-branch"), "main\n");

  process.env.CLAWBOX_ROOT = checkout;
  process.env.CLAWBOX_LOCAL_EDITS_DIR = saves;
  process.env.HOME = tmp;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GATEWAY_HEALTH_WAIT_MS = "1";
  process.env.GATEWAY_RECOVERY_WAIT_MS = "1";
  process.env.GATEWAY_WAIT_INTERVAL_MS = "1";
  // What next.config.ts bakes into a real build; each case says otherwise when it means to.
  process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH = SCRIPT_TEXT;
  vi.resetModules();
  updater = await import("@/lib/updater");
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("the restart step over a tree without scripts/preserve-local-edits.sh", () => {
  beforeEach(() => {
    expect(fs.existsSync(path.join(checkout, "scripts"))).toBe(false);
  });

  it("gets past the save over a clean tree — E2E Install's switch to main", async () => {
    const { error, warnings } = await runRestartStep();
    expect(error).toBe(REBUILD_REACHED);
    expect(fs.existsSync(saves)).toBe(false);
    expect(warnings.some((w) => w.code.startsWith("local-edits-saved"))).toBe(false);
  });

  it("saves the owner's edits with the build's own copy, then resets and cleans", async () => {
    edit();
    const { error, warnings } = await runRestartStep();
    expect(error).toBe(REBUILD_REACHED);

    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "origin/main"));
    const dirs = fs.readdirSync(saves);
    expect(dirs).toHaveLength(1);
    const saved = path.join(saves, dirs[0]);
    expect(fs.readFileSync(path.join(saved, "untracked", "notes.md"), "utf-8")).toBe("my notes\n");
    expect(fs.readFileSync(path.join(saved, "tracked.patch"), "utf-8")).toContain("tuned on the box");
    const card = warnings.find((w) => w.code === "local-edits-saved:restart");
    expect(card?.message).toContain(saved);
  });

  it("with no copy in the build either, keeps the edits in git stash and still updates", async () => {
    delete process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH;
    edit();
    const { error, warnings } = await runRestartStep();
    expect(error).toBe(REBUILD_REACHED);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(git(checkout, "stash", "list")).toContain("clawbox-update");
    expect(fs.existsSync(saves)).toBe(false);
    expect(warnings.find((w) => w.code === "local-edits-saved:restart")?.message).toContain("git stash");
  });

  it("names step 1's save rather than writing a second one or raising a second card", async () => {
    // Step 1 saved the edits and its reset took the tracked half, leaving the
    // new file — and its card is among the warnings the run carries.
    edit();
    const step1 = spawnSync("bash", ["-c", SCRIPT_TEXT, "preserve-local-edits.sh", checkout], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", CLAWBOX_LOCAL_EDITS_DIR: saves }),
    });
    expect(step1.status, step1.stderr).toBe(0);
    const [dir] = fs.readdirSync(saves);
    const message = /^CLAWBOX-WARN\[local-edits-saved\]: (.+)$/m.exec(step1.stdout)?.[1];
    expect(message).toContain(path.join(saves, dir));
    store.set("update_warnings", JSON.stringify([{ code: "local-edits-saved", message }]));
    git(checkout, "reset", "-q", "--hard", "HEAD");

    const { error, warnings } = await runRestartStep();
    expect(error).toBe(REBUILD_REACHED);
    expect(fs.readdirSync(saves)).toEqual([dir]);
    expect(warnings.map((w) => w.code)).toContain("local-edits-saved");
    expect(warnings.map((w) => w.code)).not.toContain("local-edits-saved:restart");
    expect(fs.existsSync(path.join(checkout, "notes.md"))).toBe(false);
  });

  it("still stops, with the tree untouched, when the edits fit nowhere", async () => {
    edit();
    fs.writeFileSync(saves, "a file where the save directory should be");
    const shims = path.join(tmp, "shims");
    fs.mkdirSync(shims);
    const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    write(path.join(shims, "git"), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = stash ] && exit 1; done\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shims, "git"), 0o755);
    const restorePath = saveEnv("PATH");
    process.env.PATH = `${shims}:${process.env.PATH ?? ""}`;
    try {
      const { error } = await runRestartStep();
      expect(error).toMatch(/^Error: .*could not be saved/);
    } finally {
      restorePath();
    }
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toContain("tuned on the box");
    expect(fs.readFileSync(path.join(checkout, "notes.md"), "utf-8")).toBe("my notes\n");
  });
});
