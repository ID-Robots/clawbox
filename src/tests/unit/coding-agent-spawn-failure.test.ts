/**
 * What happens when the spawn itself throws.
 *
 * startRun persists the run as "running" BEFORE it spawns, so the status route
 * can answer immediately. If the spawn then throws synchronously — a working
 * folder that vanished between the check and the call, a setpriv that is not
 * executable — nothing else would ever settle that record: `live` has no entry
 * for it, so the boot sweep is the only thing that would, and until the next
 * restart the one-run-at-a-time rule answers every later run with "busy". The
 * feature would be wedged by a transient failure.
 *
 * child_process is mocked here and nowhere else in the coding-agent tests: the
 * others run the real shipped wrapper, which is the point of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { saveEnv } from "@/tests/helpers/env";

const spawnMock = vi.hoisted(() => vi.fn());
// Partial, not a bare `{ spawn }`: the runner's import graph now reaches
// openclaw-config (through harness/credentials, for the vision model a run's
// screenshots are described with), which promisifies execFile at module load.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: spawnMock };
});
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let restore: () => void;

function readyDevice(): void {
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ clawai_token: "t", coding_agent_enabled: true }),
  );
  const project = path.join(root, "data", "code-projects", "site");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-spawn-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  readyDevice();
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(() => {
  lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a spawn that throws synchronously", () => {
  it("settles the run as failed instead of leaving it running forever", async () => {
    spawnMock.mockImplementation(() => { throw new Error("EACCES: permission denied"); });

    await expect(lib.startRun({ task: "do the thing", projectId: "site", source: "agent" }))
      .rejects.toMatchObject({ kind: "not_ready" });

    const runs = lib.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toMatch(/EACCES/);
    expect(runs[0].completedAt).not.toBeNull();
    expect(lib.runningCount()).toBe(0);

    // And it is on disk that way, not only in memory.
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8"));
    expect(onDisk[0].status).toBe("failed");
  });

  it("does not wedge the feature — the next run is not refused as busy", async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error("EACCES: permission denied"); });
    await expect(lib.startRun({ task: "first", projectId: "site", source: "agent" })).rejects.toBeTruthy();

    // A plausible child: enough of an EventEmitter for the runner to attach to.
    spawnMock.mockImplementation(() => {
      const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), {
        stdout: stream(),
        stderr: stream(),
        stdin: { end: () => {}, on: () => {} },
        kill: () => {},
        pid: 4242,
      });
    });

    const second = await lib.startRun({ task: "second", projectId: "site", source: "agent" });
    expect(second.status).toBe("running");
    expect(lib.runningCount()).toBe(1);
  });
});
