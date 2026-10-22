import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { testEnv } from "../helpers/env";
import { sliceScript } from "../helpers/gateway-pre-start";

/**
 * The shell twin of `@/lib/openclaw-maintenance` (F4, 2026-10-15), and the boot
 * script's validator reader. The pinned core (2026.10.6, as 2026.10.3) answers a config read
 * made while another process holds its state for maintenance with "…undergoing
 * offline maintenance; retry when it finishes." — exit 1, and for
 * `config validate --json` a `valid:false` payload on `<root>`. The pre-start
 * read that as the core REFUSING the config and spent 180 s of doctor on it.
 */

// Starts real processes (bash, the wrapper, `timeout`): both ceilings, see
// test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WRAPPER = path.resolve(process.cwd(), "scripts/openclaw-maintenance-retry.sh");

/** The payload the CI runner's `config validate --json` printed inside the window. */
const MAINTENANCE_PAYLOAD = JSON.stringify({
  ok: false,
  error: { type: "cli_error", message: "OpenClaw config is invalid: ~/.openclaw/openclaw.json" },
  valid: false,
  path: "/home/clawbox/.openclaw/openclaw.json",
  issues: [{
    path: "<root>",
    message: "read failed at /home/clawbox/.openclaw/openclaw.json: Error: OpenClaw state at /home/clawbox/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.",
  }],
});

let dir: string;
let calls: string;

/** An `openclaw` refused for maintenance `refusals` times, then answering `answer` with exit `rc`. */
function stub(refusals: number, answer = "{\"valid\":true}", rc = 0): string {
  const left = path.join(dir, "left");
  writeFileSync(left, String(refusals));
  const p = path.join(dir, "openclaw");
  writeFileSync(p, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
n=$(cat ${JSON.stringify(left)})
if [ "$n" -gt 0 ]; then
  echo $((n-1)) > ${JSON.stringify(left)}
  printf '%s\\n' ${JSON.stringify(MAINTENANCE_PAYLOAD)}
  exit 1
fi
printf '%s\\n' ${JSON.stringify(answer)}
exit ${rc}
`);
  chmodSync(p, 0o755);
  return p;
}

function run(cmd: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf-8",
    // The runner's own temp directory: the wrapper keeps its captures there.
    env: testEnv({ TMPDIR: tmpdir(), CLAWBOX_OPENCLAW_MAINTENANCE_PAUSE_S: "0", ...env }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function callCount(): number {
  try {
    return readFileSync(calls, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-oc-maintenance-"));
  calls = path.join(dir, "calls.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/openclaw-maintenance-retry.sh", () => {
  it("asks again while the core says to, and hands back the answer that follows", () => {
    const bin = stub(2);
    const r = run([WRAPPER, bin, "config", "validate", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{\"valid\":true}");
    expect(callCount()).toBe(3);
  });

  it("says busy (exit 75), not refused, when the window ends first", () => {
    const bin = stub(99);
    const r = run([WRAPPER, bin, "config", "validate", "--json"], { CLAWBOX_OPENCLAW_MAINTENANCE_WINDOW_S: "1", CLAWBOX_OPENCLAW_MAINTENANCE_PAUSE_S: "1" });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain("still finishing maintenance");
    // The last answer is still handed back, in the core's own words.
    expect(r.stdout).toContain("offline maintenance");
  });

  it("still hands on what the command printed when the caller's timeout ends it", () => {
    // Without the wrapper `timeout` leaves the partial output; the wrapper
    // captures it, so it has to replay it when it is signalled too.
    const r = run(["timeout", "2", WRAPPER, "sh", "-c", "echo partial; sleep 10"]);
    expect(r.status).toBe(124);
    expect(r.stdout).toContain("partial");
  });

  it("leaves no capture file behind when only the second one could be made", () => {
    // A `mktemp` that makes one file and then fails: the wrapper falls back to
    // running the command bare, and the first file must not stay in TMPDIR.
    const made = path.join(dir, "made");
    const count = path.join(dir, "mktemp-calls");
    const fake = path.join(dir, "mktemp");
    writeFileSync(fake, `#!/usr/bin/env bash
n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)
echo $((n+1)) > ${JSON.stringify(count)}
[ "$n" -ge 1 ] && exit 1
f="$(PATH=/usr/bin:/bin mktemp "$@")" || exit 1
printf '%s\\n' "$f" >> ${JSON.stringify(made)}
printf '%s\\n' "$f"
`);
    chmodSync(fake, 0o755);
    const r = run([WRAPPER, "sh", "-c", "echo ran"], { PATH: `${dir}:/usr/bin:/bin` });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ran");
    const first = readFileSync(made, "utf-8").trim();
    expect(first).not.toBe("");
    expect(existsSync(first)).toBe(false);
  });

  it("passes any other failure straight through, asked once", () => {
    const bin = stub(0, "{\"valid\":false,\"issues\":[{\"path\":\"gateway.port\",\"message\":\"Expected number\"}]}", 1);
    const r = run([WRAPPER, bin, "config", "validate", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Expected number");
    expect(callCount()).toBe(1);
  });

  it("asks once when 2026.10.6 says to restart the Gateway, not to retry", () => {
    // 2026.10.6's answer for an owner record it cannot read, where 2026.10.3
    // said "…could not be verified; retry after maintenance finishes.".
    const restart = "OpenClaw state ownership at ~/.openclaw/state/openclaw.sqlite could not be verified from ~/.openclaw/state/openclaw.sqlite.owner; restart the Gateway.";
    const bin = stub(0, restart, 1);
    const r = run([WRAPPER, bin, "config", "validate", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("restart the Gateway");
    expect(callCount()).toBe(1);
  });
});

describe("gateway-pre-start: clawbox_core_config_verdict on a core under maintenance", () => {
  const verdict = () => sliceScript(
    "clawbox_core_config_verdict() {",
    "# A stamp is a record of a FILE this core accepted",
  );

  function ask(extra: string[] = [], env: Record<string, string> = {}) {
    const program = [
      "set -euo pipefail",
      `OPENCLAW_CONFIG=${JSON.stringify(path.join(dir, "openclaw.json"))}`,
      `OPENCLAW_BIN=${JSON.stringify(path.join(dir, "openclaw"))}`,
      ...extra,
      verdict(),
      "clawbox_core_config_verdict",
    ].join("\n");
    return run(["bash", "-c", program], env);
  }

  it("reads a maintenance refusal as no verdict, never as the core refusing the config", () => {
    stub(99);
    // Run without the wrapper (a block run on its own): the payload alone must
    // not become a refusal.
    const r = ask();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^unknown\t/);
    expect(r.stdout).not.toMatch(/^refused/);
  });

  it("asks again through the wrapper and accepts what the core then says", () => {
    stub(1);
    const r = ask([`OPENCLAW_RETRY=${JSON.stringify(WRAPPER)}`]);
    expect(r.stdout.trim()).toBe("accepted");
    expect(callCount()).toBe(2);
  });

  it("answers busy when the wrapper's window ended first", () => {
    stub(99);
    const r = ask([`OPENCLAW_RETRY=${JSON.stringify(WRAPPER)}`], { CLAWBOX_OPENCLAW_MAINTENANCE_WINDOW_S: "1", CLAWBOX_OPENCLAW_MAINTENANCE_PAUSE_S: "1" });
    expect(r.stdout).toMatch(/^unknown\tOpenClaw was still finishing maintenance/);
  });
});
