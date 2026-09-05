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
const d = CAN_RUN ? describe : describe.skip;

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
let zoneinfo: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-tz-"));
  projectDir = path.join(tmp, "clawbox");
  fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
  tzEnv = path.join(projectDir, "data", "timezone.env");
  calls = path.join(tmp, "timedatectl-calls");
  fs.writeFileSync(calls, "");
  // A FIXTURE zoneinfo tree, so the guard assertions run everywhere — the ones
  // that matter are the privilege-boundary ones, and gating them on the host
  // having tzdata meant a slim CI image reported green with them never
  // executed. It carries the non-zone files a real database has, because those
  // are exactly what the reader must refuse.
  zoneinfo = path.join(tmp, "zoneinfo");
  fs.mkdirSync(path.join(zoneinfo, "Europe"), { recursive: true });
  fs.mkdirSync(path.join(zoneinfo, "posix", "Europe"), { recursive: true });
  fs.writeFileSync(path.join(zoneinfo, "Europe", "Sofia"), "TZif");
  fs.writeFileSync(path.join(zoneinfo, "posix", "Europe", "Sofia"), "TZif");
  fs.writeFileSync(path.join(zoneinfo, "zone.tab"), "# not a zone");
  fs.writeFileSync(path.join(zoneinfo, "leapseconds"), "# not a zone");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * What `read_configured_timezone` makes of the file on disk.
 *
 * `code` is the outcome that matters: 0 with a zone, 1 for "nothing recorded"
 * (a no-op), 2 for "a value was recorded and this device will not take it",
 * 3 for "data/timezone.env is not the plain file the route writes".
 */
function readConfigured(contents: string | null): { code: number; value: string } {
  if (contents !== null) fs.writeFileSync(tzEnv, contents);
  const script = [
    "set -uo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    extractShellFunction("read_configured_timezone"),
    "out=$(read_configured_timezone); rc=$?",
    'printf "[%s] rc=%s" "$out" "$rc"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", CLAWBOX_ZONEINFO_DIR: zoneinfo }),
  });
  const out = (r.stdout ?? "").trim();
  return { code: Number(/rc=(\d+)/.exec(out)?.[1] ?? -1), value: out.replace(/ rc=\d+$/, "") };
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

d("read_configured_timezone", () => {
  it("reads an IANA zone the device actually carries", () => {
    const r = readConfigured("TIMEZONE=Europe/Sofia\n");
    expect(r.value).toBe("[Europe/Sofia]");
    expect(r.code).toBe(0);
  });

  it("REJECTS — does not ignore — a zone this device has no data for", () => {
    // The difference is the whole defect: `read` used to answer "nothing
    // recorded" for a rejected value, `apply_timezone` took its no-op branch,
    // the unit exited 0, and every layer above reported the change as applied
    // while the box stayed on Etc/UTC.
    const r = readConfigured("TIMEZONE=Mars/Olympus\n");
    expect(r.value).toBe("[]");
    expect(r.code).toBe(2);
  });

  it("rejects the case ICU accepts and this filesystem does not", () => {
    // `europe/sofia` passes Node's case-insensitive ICU in the route. The
    // route canonicalises for that reason; this side must still refuse it.
    expect(readConfigured("TIMEZONE=europe/sofia\n").code).toBe(2);
  });

  it("rejects files in the database that are not zones", () => {
    for (const bad of ["zone.tab", "leapseconds", "posix/Europe/Sofia", "./Europe/Sofia"]) {
      const r = readConfigured(`TIMEZONE=${bad}\n`);
      expect(r.code, bad).toBe(2);
      expect(r.value, bad).toBe("[]");
    }
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
      const r = readConfigured(bad);
      expect(r.value, bad).toBe("[]");
      expect(r.code, bad).toBe(2);
    }
  });

  it("REJECTS anything that is not the plain file the route writes", () => {
    // `data/` is clawbox-writable and this reader runs as ROOT. `[ -f ]`
    // FOLLOWS a symlink and is false for a directory, a FIFO and a socket, so
    // every one of these answered 1 ("nothing recorded") — the one outcome
    // step_set_timezone treats as a legitimate no-op and exits 0 on. A planted
    // node is tampering, not silence.
    const target = path.join(tmp, "elsewhere.env");
    fs.writeFileSync(target, "TIMEZONE=Europe/Sofia\n");
    const shapes: [string, () => void][] = [
      ["symlink to a real file", () => fs.symlinkSync(target, tzEnv)],
      ["dangling symlink", () => fs.symlinkSync(path.join(tmp, "never-created.env"), tzEnv)],
      ["directory", () => fs.mkdirSync(tzEnv)],
      ["FIFO", () => spawnSync("mkfifo", [tzEnv])],
    ];

    for (const [name, plant] of shapes) {
      fs.rmSync(tzEnv, { recursive: true, force: true });
      plant();
      // A FIFO is the one that would otherwise HANG: `grep` on it blocks until
      // a writer appears, so the guard has to refuse before the read.
      const r = readConfigured(null);

      expect(r.code, name).toBe(3);
      expect(r.value, name).toBe("[]");
    }
  });

  it("answers 'nothing recorded' — not a rejection — when the box was never told", () => {
    const r = readConfigured(null);
    expect(r.code).toBe(1);
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

  it("keeps timedatectl's own refusal in the warning", () => {
    // `2>/dev/null` threw away the one line that says why the zone was
    // refused, leaving a red step with no reason in the journal.
    const script = [
      "set -uo pipefail",
      "is_test_mode() { return 1; }",
      "timedatectl() {",
      '  if [ "${1:-}" = "show" ]; then printf \'Etc/UTC\\n\'; return 0; fi',
      "  echo 'Failed to set time zone: Invalid time zone' >&2; return 1",
      "}",
      extractShellFunction("apply_timezone"),
      'apply_timezone "Europe/Sofia" || true',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "" }),
    });

    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("Invalid time zone");
  });

  it("is a no-op, not a failure, when nothing has been recorded", () => {
    // Every update runs the step list; a box whose owner never answered must
    // not end its update on a red line.
    const r = runApply("");

    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });
});

d("step_set_timezone", () => {
  function runStep(contents: string | null): { status: number; out: string; calls: string[] } {
    if (contents !== null) fs.writeFileSync(tzEnv, contents);
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(projectDir)}`,
      "is_test_mode() { return 1; }",
      "timedatectl() {",
      `  printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      '  if [ "${1:-}" = "show" ]; then printf \'Etc/UTC\\n\'; return 0; fi',
      "  return 0",
      "}",
      extractShellFunction("read_configured_timezone"),
      extractShellFunction("apply_timezone"),
      extractShellFunction("step_set_timezone"),
      "step_set_timezone",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "", CLAWBOX_ZONEINFO_DIR: zoneinfo }),
    });
    return {
      status: r.status ?? -1,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      calls: fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean),
    };
  }

  it("applies the recorded zone", () => {
    const r = runStep("TIMEZONE=Europe/Sofia\n");

    expect(r.status).toBe(0);
    expect(r.calls).toContain("set-timezone Europe/Sofia");
  });

  it("is a no-op on a box that was never told a zone", () => {
    const r = runStep(null);

    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });

  it("FAILS when a zone was recorded and this device will not take it", () => {
    // A step that discards its input must not exit 0. This is what let the
    // route answer `{success:true}` over a box still on Etc/UTC.
    const r = runStep("TIMEZONE=Mars/Olympus\n");

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not one this device carries/i);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });

  it("FAILS on a planted timezone.env, and says so in its own words", () => {
    // The step's own half of the same defect: the file-shape outcome must not
    // reach the `1)` no-op, or the unit exits 0 and the route reports the OS
    // zone as changed over a box still on Etc/UTC. It must also not borrow the
    // rejected-zone sentence: the remedy is `rm data/timezone.env`, not a
    // different zone name.
    const target = path.join(tmp, "elsewhere.env");
    fs.writeFileSync(target, "TIMEZONE=Europe/Sofia\n");
    fs.symlinkSync(target, tzEnv);

    const r = runStep(null);

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not the plain file the timezone route writes/i);
    expect(r.out).not.toMatch(/not one this device carries/i);
    expect(r.calls.some((c) => c.startsWith("set-timezone"))).toBe(false);
  });

  it("reads the same file the route writes", () => {
    expect(extractShellFunction("read_configured_timezone")).toContain("data/timezone.env");
  });
});
