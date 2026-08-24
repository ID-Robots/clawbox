import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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

const REPO = process.cwd();
const RUN_TUNNEL = path.join(REPO, "scripts/run-tunnel.sh");
const FAKE_URL = "https://fake-observability-456.trycloudflare.com";

let root: string;
let fakeBin: string;

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
  rmSync(root, { recursive: true, force: true });
});

const dataFile = (name: string) => path.join(root, "data", "cloudflared", name);

/** Start the script, wait until it has published a URL, then SIGTERM its group. */
async function runAndStop(scriptPath: string): Promise<number | null> {
  const child = spawn("bash", [scriptPath], {
    env: { ...process.env, CLAWBOX_ROOT: root, CLOUDFLARED_BIN: fakeBin },
    detached: true, // its own process group, so we can signal the group
    stdio: "ignore",
  });

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
    const child = spawn("bash", [RUN_TUNNEL], {
      env: { ...process.env, CLAWBOX_ROOT: root, CLOUDFLARED_BIN: path.join(root, "nope") },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) =>
      child.on("exit", (c) => resolve(c)),
    );
    expect(code).toBe(1);
  }, 20_000);
});
