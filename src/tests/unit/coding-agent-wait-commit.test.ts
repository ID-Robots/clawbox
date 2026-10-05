/**
 * A wait that begins while a settled run's commit is still being made waits
 * for the commit — against a real repository and a real (fake) harness.
 *
 * THE CASE (bench, 2026-09-26). The record says `completed` the moment the
 * harness is gone; the settle then commits the run's work and only after
 * that wakes its waiters. A team waits on a worker in 60-second slices, and a
 * worker that ended right at the end of one was read by the NEXT wait, which
 * answered at once from the status: the team merged a branch the commit had
 * not reached, removed the worktree with the files in it, and accepted an
 * empty task. Here git's `commit` is held for two seconds so that window is
 * wide enough to start a wait in, every time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash / git): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let root: string;
let binDir: string;
let shimDir: string;
let projects: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
const COMMIT_HELD_S = 2;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "PATH");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-wait-commit-"));
  const home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  shimDir = path.join(base, "shim");
  projects = path.join(home, "Projects");
  for (const d of [binDir, shimDir, projects, path.join(root, "data")]) fs.mkdirSync(d, { recursive: true });
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // git as the runner calls it, with every `commit` held a moment.
  fs.writeFileSync(path.join(shimDir, "git"), [
    "#!/usr/bin/env bash",
    `for a in "$@"; do if [ "$a" = "commit" ]; then sleep ${COMMIT_HELD_S}; break; fi; done`,
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "claw_test_token", coding_agent_enabled: true, coding_agent_default_directory: projects }));
  // A harness that writes one file and reports it, as the real one does.
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "wrote the contract", session_id: "sess-1" });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", readFirstTurn(), ...[
    `printf '%s' '# Contract' > "$PWD/api-contract.md"`,
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/api-contract.md"}}]}}\\n' "$PWD"`,
    `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
    `echo '${result}'`,
    "exit 0",
  ]].join("\n"), { mode: 0o755 });
  const dir = path.join(projects, "alpha");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# alpha\n");
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a wait that begins between a run's settle and its commit", () => {
  it("waits for the commit instead of answering from the status", async () => {
    const started = await lib.startRun({ task: "write the contract", directory: "alpha", source: "owner" });
    // The window: the record already says completed, the commit is not there yet.
    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.status).toBe("completed");
    }, { timeout: 20_000, interval: 5 });
    expect(lib.getRun(started.id)?.commit ?? null).toBeNull();

    const woke = await lib.waitForRun(started.id, 20_000);
    expect(woke?.status).toBe("completed");
    // Answered only once the work was committed: what a team merges next is there.
    expect(woke?.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(woke?.commitError ?? null).toBeNull();
  });

  it("still answers a run that settled long ago at once", async () => {
    const started = await lib.startRun({ task: "write the contract", directory: "alpha", source: "owner" });
    const first = await lib.waitForRun(started.id, 20_000);
    expect(first?.commit).toMatch(/^[0-9a-f]{7,}$/);
    const t0 = Date.now();
    const again = await lib.waitForRun(started.id, 20_000);
    expect(again?.commit).toBe(first?.commit);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
