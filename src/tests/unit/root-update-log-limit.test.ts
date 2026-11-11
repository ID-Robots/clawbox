/**
 * The root update unit's journald rate limit (TASK-2428). The update screen's
 * raw log is these units' journals, so a limit that drops lines drops them from
 * the log. Two facts from systemd make this more than one line of config:
 *
 *   - systemd hands journald a unit's LogRateLimitIntervalSec=/Burst= only when
 *     the value is above zero (unit_export_log_ratelimit_interval), so `=0`
 *     means journald's own default (10000 lines per 30 s), never "off";
 *   - the limit is fixed when the unit STARTS, so rebuild_reboot runs under the
 *     unit systemd had loaded before it — the copy step_systemd_services makes
 *     inside it is too late for it.
 *
 * So the shipped units carry a positive limit no step reaches, and install.sh's
 * refresh_root_update_log_limit bridges an installed unit that lacks it with a
 * drop-in at the start of step_apt_update (before the rebuild of every update),
 * and takes the drop-in down in step_systemd_services once the unit itself
 * carries the limit — so a box left on an older build has that build's unit and
 * no leftover of this one's. The helper is lifted out of install.sh and run
 * against a fixture unit folder with systemctl stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every case starts real bash processes: both ceilings, as the suite's
// timeout hygiene asks of any file that does.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = process.cwd();
const INSTALL = path.join(ROOT, "install.sh");
const UNIT = path.join(ROOT, "config", "clawbox-root-update@.service");
const canRun = process.platform === "linux" && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/** `Key=value` lines of a unit text, last one wins (as systemd reads them). */
function unitSettings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** The body of a top-level bash function in install.sh. */
function functionBody(name: string): string {
  const text = fs.readFileSync(INSTALL, "utf8");
  const start = text.indexOf(`\n${name}() {\n`);
  expect(start, `${name} in install.sh`).toBeGreaterThan(-1);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start + 1, end + 2);
}

function expectNoLimitReached(settings: Map<string, string>, where: string): void {
  const interval = settings.get("LogRateLimitIntervalSec");
  const burst = Number(settings.get("LogRateLimitBurst"));
  expect(interval, `${where}: LogRateLimitIntervalSec`).toBeDefined();
  // 0 (in any unit) is not exported: journald's default applies.
  expect(/^0+(?:[a-z]*)$/i.test(interval!), `${where}: LogRateLimitIntervalSec=${interval} is journald's default, not off`).toBe(false);
  expect(burst, `${where}: LogRateLimitBurst`).toBeGreaterThanOrEqual(1_000_000);
}

describe("the root update unit's journald limit, as shipped", () => {
  it("is a positive limit no step reaches in config/clawbox-root-update@.service", () => {
    expectNoLimitReached(unitSettings(fs.readFileSync(UNIT, "utf8")), "config/clawbox-root-update@.service");
  });

  it("is the same in install-x64.sh's inline unit", () => {
    const text = fs.readFileSync(path.join(ROOT, "install-x64.sh"), "utf8");
    const start = text.indexOf('cat > "/etc/systemd/system/clawbox-root-update@.service" <<\'UNIT\'');
    expect(start).toBeGreaterThan(-1);
    const inline = text.slice(text.indexOf("\n", start) + 1, text.indexOf("\nUNIT\n", start));
    expectNoLimitReached(unitSettings(inline), "install-x64.sh");
  });

  it("is installed first thing in step_apt_update — before the rebuild of every update — and kept by step_systemd_services", () => {
    const apt = functionBody("step_apt_update").split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(apt[0]).toBe("refresh_root_update_log_limit");
    expect(functionBody("step_systemd_services")).toMatch(/^\s*refresh_root_update_log_limit\s*$/m);
  });
});

describe.skipIf(!canRun)("refresh_root_update_log_limit", () => {
  let dir = "";
  let src = "";
  let units = "";
  const dropIn = () => path.join(units, "clawbox-root-update@.service.d", "50-log-rate-limit.conf");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-update-log-limit-"));
    src = path.join(dir, "src");
    units = path.join(dir, "units");
    fs.mkdirSync(path.join(src, "config"), { recursive: true });
    fs.mkdirSync(units);
    fs.copyFileSync(UNIT, path.join(src, "config", "clawbox-root-update@.service"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the helper as install.sh has it; returns how often it daemon-reloaded. */
  function refresh(): { status: number | null; reloads: number; stderr: string } {
    const log = path.join(dir, "systemctl.log");
    fs.rmSync(log, { force: true });
    const r = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `systemctl() { printf '%s\\n' "$*" >> "${log}"; }`,
      functionBody("refresh_root_update_log_limit"),
      `SRC_DIR="${src}"`,
      `refresh_root_update_log_limit "${units}"`,
    ].join("\n")], { encoding: "utf-8", timeout: 20_000, killSignal: "SIGKILL" });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    expect(calls.every((c) => c === "daemon-reload")).toBe(true);
    return { status: r.status, reloads: calls.length, stderr: r.stderr };
  }

  /** The unit as an older build installed it: no journald limit of its own. */
  const OLD_UNIT = "[Unit]\nDescription=ClawBox Root Update Step (%i)\n\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/clawbox/clawbox-root-step.sh %i\n";
  const installed = () => path.join(units, "clawbox-root-update@.service");
  const limitLines = (text: string) => text.split("\n").filter((l) => /^LogRateLimit(IntervalSec|Burst)=/.test(l));

  it("bridges an installed unit without the limit: the unit's own LogRateLimit lines as a drop-in, then a daemon-reload", () => {
    fs.writeFileSync(installed(), OLD_UNIT);
    const r = refresh();
    expect(r).toMatchObject({ status: 0, reloads: 1 });
    const conf = fs.readFileSync(dropIn(), "utf8");
    expect(conf).toContain("\n[Service]\n");
    const wanted = limitLines(fs.readFileSync(UNIT, "utf8"));
    expect(wanted).toHaveLength(2);
    expect(limitLines(conf)).toEqual(wanted);
    // Logging only: never what the unit runs.
    expect(conf).not.toMatch(/^Exec/m);
    expectNoLimitReached(unitSettings(conf), "the drop-in");
    // The installed unit itself is left alone.
    expect(fs.readFileSync(installed(), "utf8")).toBe(OLD_UNIT);
  });

  it("bridges a box with no unit installed yet, and an installed unit whose limit is 0", () => {
    expect(refresh()).toMatchObject({ status: 0, reloads: 1 });
    expect(fs.existsSync(dropIn())).toBe(true);
    fs.rmSync(path.dirname(dropIn()), { recursive: true });
    fs.writeFileSync(installed(), `${OLD_UNIT}LogRateLimitIntervalSec=0\n`);
    expect(refresh()).toMatchObject({ status: 0, reloads: 1 });
    expectNoLimitReached(unitSettings(fs.readFileSync(dropIn(), "utf8")), "the drop-in");
  });

  it("writes and reloads nothing when the bridge is already in place", () => {
    fs.writeFileSync(installed(), OLD_UNIT);
    refresh();
    const before = fs.statSync(dropIn()).mtimeMs;
    expect(refresh()).toMatchObject({ status: 0, reloads: 0 });
    expect(fs.statSync(dropIn()).mtimeMs).toBe(before);
  });

  it("replaces a stale drop-in — one with a limit of 0 — and reloads", () => {
    fs.writeFileSync(installed(), OLD_UNIT);
    fs.mkdirSync(path.dirname(dropIn()), { recursive: true });
    fs.writeFileSync(dropIn(), "[Service]\nLogRateLimitIntervalSec=0\n");
    expect(refresh()).toMatchObject({ status: 0, reloads: 1 });
    expectNoLimitReached(unitSettings(fs.readFileSync(dropIn(), "utf8")), "the refreshed drop-in");
  });

  it("takes the bridge down once the installed unit carries the limit itself, and then leaves nothing behind", () => {
    fs.writeFileSync(installed(), OLD_UNIT);
    refresh();
    expect(fs.existsSync(dropIn())).toBe(true);
    // step_systemd_services has copied the new unit.
    fs.copyFileSync(UNIT, installed());
    expect(refresh()).toMatchObject({ status: 0, reloads: 1 });
    expect(fs.existsSync(dropIn())).toBe(false);
    expect(fs.existsSync(path.dirname(dropIn()))).toBe(false);
    // A later downgrade copies the older unit: nothing of this build is left to mask it.
    fs.writeFileSync(installed(), OLD_UNIT);
    expect(fs.existsSync(path.dirname(dropIn()))).toBe(false);
    // And with the unit current and no bridge, nothing to do.
    fs.copyFileSync(UNIT, installed());
    expect(refresh()).toMatchObject({ status: 0, reloads: 0 });
  });

  it("removes its drop-in when this build sets no limit, and never fails the step it runs in", () => {
    fs.writeFileSync(installed(), OLD_UNIT);
    refresh();
    fs.writeFileSync(path.join(src, "config", "clawbox-root-update@.service"), "[Service]\nType=oneshot\n");
    expect(refresh()).toMatchObject({ status: 0, reloads: 1 });
    expect(fs.existsSync(dropIn())).toBe(false);
    // A drop-in folder it cannot write: a warning, not a failed apt_update.
    fs.writeFileSync(path.join(src, "config", "clawbox-root-update@.service"), fs.readFileSync(UNIT));
    const folder = path.dirname(dropIn());
    fs.mkdirSync(folder, { recursive: true });
    fs.chmodSync(folder, 0o500);
    try {
      const r = refresh();
      if (process.getuid?.() !== 0) {
        expect(r).toMatchObject({ status: 0, reloads: 0 });
        expect(r.stderr).toContain("could not install the root update unit's log limit");
      }
    } finally {
      fs.chmodSync(folder, 0o755);
    }
  });
});
