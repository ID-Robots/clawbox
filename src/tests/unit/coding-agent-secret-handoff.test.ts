/**
 * The owner's secrets at a run's spawn, as the audit trail and the store see it.
 *
 *  1. "inject" is written once the child has actually STARTED. A child that
 *     never came into being — a spawn that throws, or one whose process fails
 *     to exec — was handed nothing, and its line says so ("not_handed").
 *  2. A copy the owner limited to ONE run goes with the run that got it, and
 *     whatever ended that run — finishing, or never starting — takes it out of
 *     the store. No other run is ever handed it.
 *
 * child_process is mocked, as in coding-agent-spawn-failure.test.ts: the
 * harness gets a child this test controls, and everything else (`git`) fails
 * to start, which the runner already treats as "not a repository".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { saveEnv } from "@/tests/helpers/env";

// Starts the real runner over a temp tree: see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: spawnMock,
}));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/coding-run-worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-run-worktree")>()),
  addRunWorktree: vi.fn(async () => ({ ok: false as const, reason: "no_repository" as const, detail: "Not a git repository yet." })),
}));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";

let lib: typeof import("@/lib/coding-agent");
let secrets: typeof import("@/lib/project-secrets");
let base: string;
let root: string;
let restore: () => void;

/** A harness child the test drives. No pid: nothing here may signal a real process group. */
function harnessChild(): EventEmitter {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
  return Object.assign(new EventEmitter(), {
    stdout: stream(),
    stderr: stream(),
    stdin: { write: () => true, end: () => {}, on: () => {} },
    kill: () => true,
    pid: undefined,
  });
}

function isHarness(cmd: unknown, args: unknown): boolean {
  return [cmd, ...(Array.isArray(args) ? args : [])].some((part) => String(part).endsWith("claude-ds"));
}

/** Every harness spawn answers with `child`; anything else fails to start. */
function harnessSpawnsAs(child: () => EventEmitter): void {
  spawnMock.mockImplementation((cmd: unknown, args: unknown) => {
    if (isHarness(cmd, args)) return child();
    throw new Error("spawn ENOENT");
  });
}

function audit(): Record<string, unknown>[] {
  const file = path.join(root, "data", "secrets-audit.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-handoff-"));
  const home = path.join(base, "home");
  root = path.join(home, "clawbox");
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "5b".repeat(32), { mode: 0o600 });
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ clawai_token: "t", coding_agent_enabled: true, coding_agent_inject_secrets: true }),
  );
  const project = path.join(root, "data", "code-projects", "site");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  spawnMock.mockReset();
  vi.resetModules();
  secrets = await import("@/lib/project-secrets");
  secrets._resetSecretKeyCacheForTests();
  lib = await import("@/lib/coding-agent");

  await secrets.setSecret({ name: "DEPLOY_TOKEN", value: TOKEN, scope: "@box", inject: true });
  await secrets.importSecret({ name: "IMPORT_ME_TOKEN", value: "imported-value-0000", scope: "@box", source: "hermes", expiresAt: "run" });
  await secrets.setSecretInject({ name: "IMPORT_ME_TOKEN", scope: "@box", inject: true });
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the hand-off line", () => {
  it("is written once the child has started, naming what it was handed", async () => {
    let child: EventEmitter | null = null;
    harnessSpawnsAs(() => (child = harnessChild()));
    const run = await lib.startRun({ task: "deploy the site", projectId: "site", source: "agent" });
    expect(run.secretNames.sort()).toEqual(["DEPLOY_TOKEN", "IMPORT_ME_TOKEN"]);
    // The child exists but has not reported in: nothing was handed yet.
    expect(audit().filter((line) => line.action === "inject")).toEqual([]);

    child!.emit("spawn");
    await until(() => audit().some((line) => line.action === "inject"), "the inject line");
    expect(audit().filter((line) => line.action === "inject")).toEqual([
      expect.objectContaining({ names: ["DEPLOY_TOKEN", "IMPORT_ME_TOKEN"], scope: "@box", runId: run.id }),
    ]);
    // The one-run copy is this run's now: no second run is handed it.
    expect((await secrets.resolveSecretsForRun({ project: "site", runId: "run-0000other" })).names).toEqual(["DEPLOY_TOKEN"]);
  });

  it("says NOT handed for a child whose process failed to start, and takes the one-run copy back", async () => {
    let child: EventEmitter | null = null;
    harnessSpawnsAs(() => (child = harnessChild()));
    const run = await lib.startRun({ task: "deploy the site", projectId: "site", source: "agent" });

    child!.emit("error", Object.assign(new Error("spawn claude-ds ENOENT"), { code: "ENOENT" }));
    // The audit line, not the list: the line is appended after the store write the list reads.
    await until(() => audit().some((line) => line.action === "delete" && line.runId === run.id), "the one-run copy's removal line");

    const lines = audit().filter((line) => line.runId === run.id);
    expect(lines.some((line) => line.action === "inject")).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ action: "not_handed", names: ["DEPLOY_TOKEN", "IMPORT_ME_TOKEN"], reason: "spawn_failed" }));
    expect(lines).toContainEqual(expect.objectContaining({ action: "delete", names: ["IMPORT_ME_TOKEN"], reason: "run_ended" }));
    // The owner's own entry is untouched.
    expect((await secrets.listSecrets()).map((s) => s.name)).toEqual(["DEPLOY_TOKEN"]);
  });

  it("says NOT handed for a spawn that throws, and takes the one-run copy back", async () => {
    spawnMock.mockImplementation(() => { throw new Error("EACCES: permission denied"); });
    await expect(lib.startRun({ task: "deploy the site", projectId: "site", source: "agent" })).rejects.toMatchObject({ kind: "not_ready" });
    const [run] = lib.listRuns();

    // The audit line, not the list: the line is appended after the store write the list reads.
    await until(() => audit().some((line) => line.action === "delete" && line.runId === run.id), "the one-run copy's removal line");
    const lines = audit().filter((line) => line.runId === run.id);
    expect(lines.some((line) => line.action === "inject")).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ action: "not_handed", reason: "spawn_failed" }));
    expect(lines).toContainEqual(expect.objectContaining({ action: "delete", names: ["IMPORT_ME_TOKEN"], reason: "run_ended" }));
  });
});

describe("a spawn that fails before the child is asked for", () => {
  it("still says NOT handed, and takes the one-run copy back", async () => {
    // The stream logs are opened before `spawn` is called: a file where their
    // folder should be makes that step throw, so no child is ever asked for.
    fs.writeFileSync(path.join(root, "data", "coding-agent-streams"), "");
    harnessSpawnsAs(() => harnessChild());
    await expect(lib.startRun({ task: "deploy the site", projectId: "site", source: "agent" })).rejects.toMatchObject({ kind: "not_ready" });
    const [run] = lib.listRuns();
    expect(spawnMock.mock.calls.some(([cmd, args]) => isHarness(cmd, args))).toBe(false);

    await until(() => audit().some((line) => line.action === "delete" && line.runId === run.id), "the one-run copy's removal line");
    const lines = audit().filter((line) => line.runId === run.id);
    expect(lines.some((line) => line.action === "inject")).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ action: "not_handed", names: ["DEPLOY_TOKEN", "IMPORT_ME_TOKEN"], reason: "spawn_failed" }));
  });
});

describe("a one-run copy", () => {
  it("is gone once the run that got it has ended", async () => {
    let child: EventEmitter | null = null;
    harnessSpawnsAs(() => (child = harnessChild()));
    const run = await lib.startRun({ task: "deploy the site", projectId: "site", source: "agent" });
    child!.emit("spawn");
    expect((await secrets.listSecrets()).map((s) => s.name).sort()).toEqual(["DEPLOY_TOKEN", "IMPORT_ME_TOKEN"]);

    lib.stopRun(run.id);
    child!.emit("exit", null, "SIGTERM");
    child!.emit("close", null, "SIGTERM");
    // The audit line, not the list: the line is appended after the store write the list reads.
    await until(() => audit().some((line) => line.action === "delete" && line.runId === run.id), "the one-run copy's removal line");
    expect((await secrets.listSecrets()).map((s) => s.name)).toEqual(["DEPLOY_TOKEN"]);
    expect(audit().at(-1)).toMatchObject({ action: "delete", names: ["IMPORT_ME_TOKEN"], runId: run.id, reason: "run_ended" });
    expect(fs.readFileSync(path.join(root, "data", "secrets-audit.log"), "utf-8")).not.toContain("imported-value-0000");
  });
});
