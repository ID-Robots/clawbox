import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-514. The privileged half of the timezone fix.
 *
 * `data/timezone.env` is written by the web server, which runs as `clawbox`,
 * and read back by `step_set_timezone` running as ROOT. It is therefore
 * attacker-influenced input on the root side of the privilege boundary — the
 * same shape as `data/hostname.env`, whose reader is PARSED and never sourced
 * for exactly that reason (TASK-445). An IANA zone contains `/`, which
 * `read_untrusted_env_value`'s character class excludes, so this reader has a
 * gate of its own and it has to hold.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const HAS_ZONEINFO = fs.existsSync("/usr/share/zoneinfo/Europe/Sofia");
const d = CAN_RUN ? describe : describe.skip;
const dz = CAN_RUN && HAS_ZONEINFO ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

let tmp: string;
let projectDir: string;
let tzEnv: string;
let calls: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-tz-"));
  projectDir = path.join(tmp, "clawbox");
  fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
  tzEnv = path.join(projectDir, "data", "timezone.env");
  calls = path.join(tmp, "timedatectl-calls");
  fs.writeFileSync(calls, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** What `read_configured_timezone` makes of the file on disk. */
function readConfigured(contents: string | null): { status: number; value: string } {
  if (contents !== null) fs.writeFileSync(tzEnv, contents);
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    extractShellFunction("read_configured_timezone"),
    'printf "[%s]" "$(read_configured_timezone)"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "" }),
  });
  return { status: r.status ?? -1, value: (r.stdout ?? "").trim() };
}

/** Drive apply_timezone with `timedatectl` stubbed and logged. */
function runApply(tz: string, current = "Etc/UTC"): { status: number; out: string; calls: string[] } {
  const script = [
    "set -euo pipefail",
    "is_test_mode() { return 1; }",
    `timedatectl() {`,
    `  printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
    `  if [ "\${1:-}" = "show" ]; then printf '%s\\n' ${JSON.stringify(current)}; return 0; fi`,
    "  return 0",
    "}",
    extractShellFunction("apply_timezone"),
    `apply_timezone ${JSON.stringify(tz)}`,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "" }),
  });
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    calls: fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean),
  };
}

dz("read_configured_timezone", () => {
  it("reads an IANA zone the device actually carries", () => {
    expect(readConfigured("TIMEZONE=Europe/Sofia\n").value).toBe("[Europe/Sofia]");
  });

  it("refuses a zone this device has no data for", () => {
    // The zoneinfo database on the box is the list — nothing here maintains one.
    expect(readConfigured("TIMEZONE=Mars/Olympus\n").value).toBe("[]");
  });

  it("never executes what it reads", () => {
    const marker = path.join(tmp, "pwned");
    expect(readConfigured(`TIMEZONE=$(touch ${marker})\n`).value).toBe("[]");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses traversal, absolute paths and shell metacharacters", () => {
    for (const bad of [
      "TIMEZONE=../../etc/passwd\n",
      "TIMEZONE=/etc/passwd\n",
      "TIMEZONE=Europe/Sofia; rm -rf /\n",
      "TIMEZONE=-Europe/Sofia\n",
    ]) {
      expect(readConfigured(bad).value, bad).toBe("[]");
    }
  });

  it("answers empty — not an error — when the box has never been told a zone", () => {
    const r = readConfigured(null);
    expect(r.status).toBe(0);
    expect(r.value).toBe("[]");
  });
});

d("apply_timezone", () => {
  it("sets the system zone", () => {
    const r = runApply("Europe/Sofia");

    expect(r.status).toBe(0);
    expect(r.calls).toContain("set-timezone Europe/Sofia");
  });

  it("leaves a box that already agrees alone", () => {
    const r = runApply("Europe/Sofia", "Europe/Sofia");

    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });

  it("is a no-op, not a failure, when nothing has been recorded", () => {
    // Every update runs the step list; a box whose owner never answered must
    // not end its update on a red line.
    const r = runApply("");

    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });
});

d("step_set_timezone is wired to the same file the route writes", () => {
  it("reads data/timezone.env and applies it", () => {
    const step = extractShellFunction("step_set_timezone");

    expect(step).toContain("apply_timezone");
    expect(step).toContain("read_configured_timezone");
    expect(extractShellFunction("read_configured_timezone")).toContain("data/timezone.env");
  });
});
