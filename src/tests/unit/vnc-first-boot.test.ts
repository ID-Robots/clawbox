import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// Runs the real first-boot script under bash; a spawning test carries both
// ceilings (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * On the boot after every update, clawbox-vnc.service logged "Main process
 * exited, code=exited, status=2/INVALIDARGUMENT" a moment after it started,
 * and then ran with NRestarts=0. Not a display race: the unit runs the virtual
 * Xvfb desktop, and 2 is what x11vnc exits with when it catches SIGTERM (1 when
 * it cannot open its display, 3 when the display dies). Every update runs
 * vnc_install, which arms the first-boot marker, and
 * clawbox-firstboot-vnc.service then RESTARTED the VNC unit that had come up
 * cleanly seconds before.
 */

const REPO = path.resolve(__dirname, "../../..");
const FIRST_BOOT = path.join(REPO, "scripts", "ensure-vnc-on-first-boot.sh");
const INSTALL_SH = path.join(REPO, "install.sh");
const MARKER_LINE = 'MARKER="/var/lib/clawbox/ensure-vnc-on-first-boot.pending"';

const read = (p: string) => fs.readFileSync(p, "utf-8");

/**
 * Run ensure-vnc-on-first-boot.sh with a `systemctl` that only records its
 * arguments. The marker is the one thing moved: the copy run here points at a
 * marker under the tmp tree, so the test never needs /var/lib/clawbox.
 */
function runFirstBoot(armed: boolean): { status: number | null; output: string; calls: string[]; markerLeft: boolean } {
  const source = read(FIRST_BOOT);
  expect(source, "the marker path the test swaps out").toContain(MARKER_LINE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-firstboot-vnc-"));
  try {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const log = path.join(tmp, "systemctl.log");
    const marker = path.join(tmp, "ensure-vnc-on-first-boot.pending");
    if (armed) fs.writeFileSync(marker, "");
    const script = path.join(tmp, "ensure-vnc-on-first-boot.sh");
    fs.writeFileSync(script, source.replace(MARKER_LINE, `MARKER=${JSON.stringify(marker)}`));
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    const calls = fs.existsSync(log) ? read(log).split("\n").filter(Boolean) : [];
    return { status: r.status, output: r.stdout + r.stderr, calls, markerLeft: fs.existsSync(marker) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every clawbox-vnc.service unit install.sh writes, heredoc body only. */
function vncUnits(sh: string): string[] {
  const units: string[] = [];
  for (let at = sh.indexOf("<<VNCSVC\n"); at !== -1; at = sh.indexOf("<<VNCSVC\n", at + 1)) {
    const body = at + "<<VNCSVC\n".length;
    units.push(sh.slice(body, sh.indexOf("\nVNCSVC\n", body)));
  }
  return units;
}

describe("clawbox-firstboot-vnc: a VNC that is already up is left alone", () => {
  it("starts the VNC units and never restarts or stops one", () => {
    const { status, output, calls } = runFirstBoot(true);
    expect(status, output).toBe(0);
    expect(calls).toContain("start clawbox-vnc.service");
    expect(calls).toContain("start clawbox-websockify.service");
    // A restart SIGTERMs the x11vnc that came up at boot: exit 2, the logged
    // "failure", and a dropped desktop.
    expect(calls.filter((c) => /^(restart|try-restart|reload-or-restart|try-reload-or-restart|stop|kill)\b/.test(c))).toEqual([]);
  });

  it("still brings up a unit that failed or never started, then retires itself", () => {
    const { status, output, calls, markerLeft } = runFirstBoot(true);
    expect(status, output).toBe(0);
    const resetAt = calls.findIndex((c) => /^reset-failed\b.*\bclawbox-vnc\.service\b/.test(c));
    const enableAt = calls.findIndex((c) => /^enable\b.*\bclawbox-vnc\.service\b/.test(c));
    const startAt = calls.indexOf("start clawbox-vnc.service");
    expect(resetAt, "reset-failed clears a start limit before the start").toBeGreaterThan(-1);
    expect(enableAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(resetAt);
    expect(startAt).toBeGreaterThan(enableAt);
    expect(markerLeft, "the marker is consumed").toBe(false);
    expect(calls.at(-1)).toBe("disable clawbox-firstboot-vnc.service");
  });

  it("does nothing on a boot without the marker", () => {
    const { status, output, calls } = runFirstBoot(false);
    expect(status, output).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("clawbox-vnc.service: x11vnc's exit 2 on SIGTERM is a clean stop", () => {
  const units = vncUnits(read(INSTALL_SH));

  it("is written by step_vnc_install and step_vnc_refresh, identically", () => {
    expect(units).toHaveLength(2);
    // The refresh is how a box that is already installed gets the unit: if the
    // two drift apart, existing boxes keep the old one.
    expect(units[1]).toBe(units[0]);
  });

  it("counts exit 2 as success and still restarts an exit 2 nobody asked for", () => {
    for (const unit of units) {
      expect(unit).toMatch(/^ExecStart=\$PROJECT_DIR\/scripts\/start-vnc\.sh$/m);
      expect(unit).toMatch(/^SuccessExitStatus=2$/m);
      // x11vnc exits 2 on a caught SIGSEGV/SIGBUS/SIGABRT too; systemd never
      // auto-restarts after a requested stop, so this only covers those.
      expect(unit).toMatch(/^RestartForceExitStatus=2$/m);
      expect(unit).toMatch(/^Restart=on-failure$/m);
    }
  });
});
