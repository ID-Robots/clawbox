import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/run-tunnel.sh, actually executed.
 *
 * Two behaviours are proven here rather than asserted about:
 *
 *  1. A SIGTERM stop exits 0. The old script's pipeline ran under
 *     `set -o pipefail`, so cloudflared dying on SIGTERM made the whole script
 *     return 143 — measured on the box as
 *       clawbox-tunnel.service: Main process exited, code=exited, status=143/n/a
 *       clawbox-tunnel.service: Failed with result 'exit-code'.
 *     and rendered by the Remote Access panel as a red "Tunnel failed to start"
 *     alert right after the user pressed Stop. Running the pre-fix script under
 *     this harness gives EXIT=143; the fixed one gives 0.
 *
 *  2. Every published URL lands in a history file that a stop does NOT erase.
 *
 * SIGTERM goes to the whole process group, which is what systemd does with the
 * unit's default KillMode=control-group.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const RUN_TUNNEL = path.join(REPO, "scripts/run-tunnel.sh");
const FAKE_URL = "https://fake-observability-456.trycloudflare.com";

let root: string;
let fakeBin: string;

// Fixtures get their own process group so one signal reaps the script, its
// pipeline subshell and the fake cloudflared's `while true` loop together. Sent
// only on the happy path, that signal is missed whenever a test fails or vitest
// aborts first, and the group outlives the run — measured on the box as six
// stray groups still alive hours later. Everything started here is recorded and
// reaped in afterEach instead, pass or fail.
const spawned: ChildProcess[] = [];

function startFixture(scriptPath: string, cloudflaredBin: string): ChildProcess {
  const child = spawn("bash", [scriptPath], {
    env: { ...process.env, CLAWBOX_ROOT: root, CLOUDFLARED_BIN: cloudflaredBin },
    detached: true, // its own process group, so we can signal the group
    stdio: "ignore",
  });
  spawned.push(child);
  return child;
}

function reapSpawned() {
  let failure: unknown;
  for (const child of spawned.splice(0)) {
    if (child.pid == null) continue;
    try {
      // A negative pid signals the group. The group outliving its leader is
      // exactly the leak being closed, so signal it even once the child exited.
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      // ESRCH: nothing left in the group — the outcome this is here to get.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH" && !failure) failure = err;
    }
  }
  if (failure) throw failure;
}

// Belt and braces for what afterEach cannot cover: the worker torn down mid-test.
// Swallows, because an exception thrown from an `exit` listener is an uncaught
// exception during shutdown — a green run reported red over an undeliverable
// signal.
process.once("exit", () => {
  try {
    reapSpawned();
  } catch {
    // Nothing useful left to do at exit.
  }
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "clawbox-run-tunnel-"));
  fakeBin = path.join(root, "fake-cloudflared");
  // Prints the URL the way cloudflared does (on stderr), then stays up.
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash\necho "INF |  ${FAKE_URL}  |" >&2\nwhile true; do sleep 0.2; done\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  // Before the temp dir goes: the strays on the box were still running against a
  // CLAWBOX_ROOT that had already been deleted under them. `finally`, so a signal
  // that could not be delivered is still reported but does not trade the process
  // leak for a temp-dir one.
  try {
    reapSpawned();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const dataFile = (name: string) => path.join(root, "data", "cloudflared", name);

/** Start the script, wait until it has published a URL, then SIGTERM its group. */
async function runAndStop(scriptPath: string): Promise<number | null> {
  const child = startFixture(scriptPath, fakeBin);

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? null : code));
  });

  for (let i = 0; i < 100 && !existsSync(dataFile("tunnel.url")); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  process.kill(-child.pid!, "SIGTERM");
  return exited;
}

describe("run-tunnel.sh — a user-requested stop is not a failure", () => {
  it("exits 0 when SIGTERM'd", async () => {
    expect(await runAndStop(RUN_TUNNEL)).toBe(0);
  }, 20_000);

  it("keeps the URL history across the stop but clears the live URL", async () => {
    await runAndStop(RUN_TUNNEL);

    // tunnel.url answers "what is the URL right now" — a stopped tunnel has none.
    expect(existsSync(dataFile("tunnel.url"))).toBe(false);
    // The history answers "which hostnames has this box ever been reachable on".
    const history = readFileSync(dataFile("tunnel-url.log"), "utf-8").trim().split("\n");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z https:\/\/fake-observability-456\.trycloudflare\.com$/,
    );
  }, 20_000);

  it("appends across restarts instead of overwriting", async () => {
    mkdirSync(path.dirname(dataFile("tunnel-url.log")), { recursive: true });
    writeFileSync(dataFile("tunnel-url.log"), `2026-08-01T00:00:00Z ${FAKE_URL}\n`);

    await runAndStop(RUN_TUNNEL);

    const history = readFileSync(dataFile("tunnel-url.log"), "utf-8").trim().split("\n");
    expect(history).toHaveLength(2);
    expect(history[0]).toContain("2026-08-01T00:00:00Z");
  }, 20_000);

  it("still reports a real failure honestly", async () => {
    // cloudflared missing -> exit 1, and that must stay 1.
    const child = startFixture(RUN_TUNNEL, path.join(root, "nope"));
    const code = await new Promise<number | null>((resolve) =>
      child.on("exit", (c) => resolve(c)),
    );
    expect(code).toBe(1);
  }, 20_000);
});
