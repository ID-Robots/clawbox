import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * bluetoothd ran with `-d` on every Jetson, and its debug output once filled
 * 74 % of the retained journal.
 *
 * The flag is NVIDIA's: the L4T drop-in
 * /usr/lib/systemd/system/bluetooth.service.d/nv-bluetooth-service.conf
 * replaces the unit's ExecStart with `bluetoothd -d --noplugin=audio,a2dp,avrcp`.
 * Nothing in ClawBox uses Bluetooth. `step_bluetooth_no_debug` writes a drop-in
 * of its own that sorts after NVIDIA's, holding the vendor's line minus `-d`,
 * DERIVED from the vendor file on every run so a BSP that changes its
 * arguments is followed, not overridden with a stale copy.
 *
 * What is pinned here: the derived drop-in, its marker, its name sorting after
 * the vendor's, one daemon-reload and NO restart (a restart would drop a paired
 * keyboard or headset); a second run writes nothing; every shape the step does
 * not edit (no vendor file, no -d, an operator's own drop-in, quoting,
 * `--debug`, bundled short options) leaves the box as it is, and a stale
 * ClawBox drop-in is removed where it no longer matches the vendor; a failed
 * write or daemon-reload is reported as a failed step; and the step is wired
 * into both the full install and `step_post_update`. No test reads the real
 * /etc or /usr: both paths come in through their seams and systemctl, install
 * and mv are stubs.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform === "linux"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

const VENDOR_NAME = "nv-bluetooth-service.conf";
const DEST_NAME = "zz-clawbox-bluetoothd-no-debug.conf";
/** What the measured box's vendor drop-in starts bluetoothd with. */
const VENDOR_EXEC = "/usr/lib/bluetooth/bluetoothd -d --noplugin=audio,a2dp,avrcp";
const DERIVED_EXEC = "/usr/lib/bluetooth/bluetoothd --noplugin=audio,a2dp,avrcp";
const MARKER = "# ClawBox: bluetoothd without -d";

let sandbox: string;
let vendorDir: string;
let vendor: string;
let destDir: string;
let dest: string;
let tmpDir: string;
let calls: string;

function writeVendor(execStart: string) {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(vendor, `[Service]\nExecStart=\nExecStart=${execStart}\n`);
}

/**
 * The drop-in's first line tells an operator both halves: deleting the file
 * undoes it until the next update writes it again, and a drop-in of their own
 * is what keeps it undone (the step then removes ClawBox's file).
 */
function expectedDropIn(): string {
  return [
    `${MARKER}, derived from ${vendor} by install.sh; to restore the vendor's debug output, delete this file and run`
      + " systemctl daemon-reload (it applies from the next start of bluetooth.service); to keep it restored, add a"
      + " drop-in of your own (systemctl edit bluetooth), and every later update leaves the unit as you configured it",
    "[Service]",
    "ExecStart=",
    `ExecStart=${DERIVED_EXEC}`,
    "",
  ].join("\n");
}

/** The drop-in as earlier releases wrote it: the same marker and ExecStart, the old first line. */
function earlierReleaseDropIn(): string {
  return [
    `${MARKER}, derived from ${vendor} by install.sh; delete this file to restore the vendor's debug output`,
    "[Service]",
    "ExecStart=",
    `ExecStart=${DERIVED_EXEC}`,
    "",
  ].join("\n");
}

/** A ClawBox drop-in an earlier run wrote, from a vendor line that has changed since. */
function writeStaleMarkedDest() {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, `${MARKER}, derived from ${vendor} by install.sh\n[Service]\nExecStart=\nExecStart=/old\n`);
}

interface RunOpts {
  /** What `systemctl show bluetooth.service -p DropInPaths --value` answers; default: what systemd would list. */
  dropIns?: string[];
  showRc?: number;
  reloadRc?: number;
  /** `install` writes part of its target, then fails. */
  installFails?: boolean;
  /** Run through install.sh's own `optional_step`, as step_post_update does. */
  viaOptionalStep?: boolean;
}

/**
 * Run the real `step_bluetooth_no_debug`, with install.sh's own
 * `install_root_file`, under the options install.sh runs with. `install` is a
 * stub that drops `-o root -g root` (the tests do not run as root) and logs the
 * call; `systemctl` logs every call and answers DropInPaths from the script.
 */
function runStep(opts: RunOpts = {}) {
  const dropIns = opts.dropIns ?? [vendor, ...(fs.existsSync(dest) ? [dest] : [])];
  const installBody = opts.installFails
    ? ': > "${@: -1}"; return 1'
    : [
      "local a=()",
      'while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done',
      'command install "${a[@]}"',
    ].join("\n");
  const script = [
    "set -euo pipefail",
    `export TMPDIR=${JSON.stringify(tmpDir)}`,
    `CALLS=${JSON.stringify(calls)}`,
    `CLAWBOX_BLUETOOTH_VENDOR_DROPIN=${JSON.stringify(vendor)}`,
    `CLAWBOX_BLUETOOTH_DROPIN_DIR=${JSON.stringify(destDir)}`,
    `DROPINS=${JSON.stringify(dropIns.join(" "))}`,
    "systemctl() {",
    '  echo "systemctl $*" >> "$CALLS"',
    '  case "$1" in',
    `    show) printf '%s\\n' "$DROPINS"; return ${opts.showRc ?? 0} ;;`,
    `    daemon-reload) return ${opts.reloadRc ?? 0} ;;`,
    "  esac",
    "}",
    "install() {",
    '  echo "install $*" >> "$CALLS"',
    installBody,
    "}",
    extractShellFunction("install_root_file"),
    extractShellFunction("step_bluetooth_no_debug"),
    ...(opts.viaOptionalStep
      ? [
        'POST_UPDATE_FAILED_STEPS=""',
        extractShellFunction("optional_step"),
        "optional_step bluetooth_no_debug step_bluetooth_no_debug",
        'echo "FAILED_STEPS=[$POST_UPDATE_FAILED_STEPS]"',
      ]
      : ["step_bluetooth_no_debug"]),
  ].join("\n");
  const runner = path.join(sandbox, "run.sh");
  fs.writeFileSync(runner, script, "utf-8");
  return spawnSync("bash", [runner], { encoding: "utf-8", cwd: sandbox });
}

function loggedCalls(): string[] {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean);
}
const systemctlCalls = () => loggedCalls().filter((line) => line.startsWith("systemctl "));
const reloads = () => systemctlCalls().filter((line) => line === "systemctl daemon-reload");
const installCalls = () => loggedCalls().filter((line) => line.startsWith("install "));

/** The step's own lines: root-step progress shows only two-space-indented ones. */
function stepLines(result: { stdout: string; stderr: string }): string[] {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => line && !line.startsWith("FAILED_STEPS="));
}

function expectIndented(result: { stdout: string; stderr: string }) {
  for (const line of stepLines(result)) expect(line).toMatch(/^ {2}\S/);
}

/** Nothing half-written is left behind: no temp file and no `.new` next to the live drop-in. */
function expectNoLeftovers() {
  expect(fs.readdirSync(tmpDir)).toEqual([]);
  if (fs.existsSync(destDir)) {
    expect(fs.readdirSync(destDir).filter((name) => name !== DEST_NAME)).toEqual([]);
  }
}

d("step_bluetooth_no_debug starts bluetoothd without NVIDIA's -d", () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bluetooth-no-debug-"));
    vendorDir = path.join(sandbox, "usr", "lib", "systemd", "system", "bluetooth.service.d");
    vendor = path.join(vendorDir, VENDOR_NAME);
    destDir = path.join(sandbox, "etc", "systemd", "system", "bluetooth.service.d");
    dest = path.join(destDir, DEST_NAME);
    tmpDir = path.join(sandbox, "tmp");
    fs.mkdirSync(tmpDir);
    calls = path.join(sandbox, "calls.log");
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes a drop-in with the vendor's ExecStart minus -d, reloads once and restarts nothing", () => {
    writeVendor(VENDOR_EXEC);
    // /etc/systemd/system/bluetooth.service.d does not exist on the measured box.
    expect(fs.existsSync(destDir)).toBe(false);

    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe(expectedDropIn());
    expect(fs.statSync(dest).mode & 0o777).toBe(0o644);
    expect(fs.statSync(destDir).mode & 0o777).toBe(0o755);
    // Root-owned, through install.sh's atomic install_root_file.
    expect(installCalls()).toHaveLength(1);
    expect(installCalls()[0]).toContain("-o root -g root -m 0644");
    expect(installCalls()[0]).toContain(`${dest}.new`);
    expect(reloads()).toHaveLength(1);
    // Only the DropInPaths read and the reload: no restart, stop or start of bluetooth.
    expect(systemctlCalls().filter((line) => line !== "systemctl daemon-reload")).toEqual([
      "systemctl show bluetooth.service -p DropInPaths --value",
    ]);
    // Drop-ins apply in lexicographic order across directories: ours must come last.
    expect(DEST_NAME > VENDOR_NAME).toBe(true);
    expect(result.stdout).toContain("next start of bluetooth.service");
    expectIndented(result);
    expectNoLeftovers();
  });

  it("writes nothing and reloads nothing on the second run", () => {
    writeVendor(VENDOR_EXEC);
    expect(runStep().status).toBe(0);
    const past = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(dest, past, past);
    fs.rmSync(calls);

    const second = runStep();

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe(expectedDropIn());
    expect(fs.statSync(dest).mtimeMs).toBe(past.getTime());
    expect(installCalls()).toEqual([]);
    expect(reloads()).toEqual([]);
    expect(stepLines(second)).toHaveLength(1);
    expect(second.stdout).toContain("already in place");
    expectIndented(second);
    expectNoLeftovers();
  });

  it("rewrites an earlier release's drop-in once, with one reload and no restart, then leaves it", () => {
    writeVendor(VENDOR_EXEC);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, earlierReleaseDropIn());

    const first = runStep();

    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe(expectedDropIn());
    // Still read as ClawBox's own, and the ExecStart is unchanged.
    expect(fs.readFileSync(dest, "utf-8").startsWith(MARKER)).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toContain(`\nExecStart=${DERIVED_EXEC}\n`);
    expect(installCalls()).toHaveLength(1);
    expect(reloads()).toHaveLength(1);
    expect(systemctlCalls().filter((line) => line !== "systemctl daemon-reload")).toEqual([
      "systemctl show bluetooth.service -p DropInPaths --value",
    ]);
    expectNoLeftovers();

    fs.rmSync(calls);
    const second = runStep();

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.stdout).toContain("already in place");
    expect(installCalls()).toEqual([]);
    expect(reloads()).toEqual([]);
  });

  it("writes its first line as one line, starting with the marker", () => {
    writeVendor(VENDOR_EXEC);

    expect(runStep().status).toBe(0);

    const first = fs.readFileSync(dest, "utf-8").split("\n")[0];
    expect(first.startsWith(`${MARKER}, `)).toBe(true);
    expect(first).toContain("delete this file and run systemctl daemon-reload");
    expect(first).toContain("add a drop-in of your own (systemctl edit bluetooth)");
    expect(fs.readFileSync(dest, "utf-8").split("\n")[1]).toBe("[Service]");
  });

  it("re-derives the drop-in when the vendor's arguments change", () => {
    writeVendor(VENDOR_EXEC);
    expect(runStep().status).toBe(0);
    writeVendor("/usr/lib/bluetooth/bluetoothd -d --noplugin=audio,a2dp,avrcp,sap -E");
    fs.rmSync(calls);

    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toContain(
      "\nExecStart=/usr/lib/bluetooth/bluetoothd --noplugin=audio,a2dp,avrcp,sap -E\n",
    );
    expect(reloads()).toHaveLength(1);
    expectNoLeftovers();
  });

  it("never overwrites a file of its name that ClawBox did not write", () => {
    writeVendor(VENDOR_EXEC);
    fs.mkdirSync(destDir, { recursive: true });
    const owners = "[Service]\nExecStart=\nExecStart=/usr/lib/bluetooth/bluetoothd -d -n\n";
    fs.writeFileSync(dest, owners);

    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe(owners);
    expect(installCalls()).toEqual([]);
    expect(reloads()).toEqual([]);
    expect(stepLines(result)).toHaveLength(1);
    expectIndented(result);
  });

  it("drops every -d, wherever it stands, and nothing else", () => {
    writeVendor("/usr/lib/bluetooth/bluetoothd --noplugin=audio  -d -E -d");

    const result = runStep();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toContain(
      "\nExecStart=/usr/lib/bluetooth/bluetoothd --noplugin=audio -E\n",
    );
  });

  describe("when the vendor line has no -d", () => {
    it("writes nothing", () => {
      writeVendor("/usr/lib/bluetooth/bluetoothd --noplugin=audio,a2dp,avrcp");

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
      expectIndented(result);
    });

    it("writes nothing when the vendor drop-in sets no ExecStart at all", () => {
      fs.mkdirSync(vendorDir, { recursive: true });
      fs.writeFileSync(vendor, "[Service]\nExecStart=\n");

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
    });

    it("removes a drop-in an earlier run wrote, with one daemon-reload", () => {
      writeVendor("/usr/lib/bluetooth/bluetoothd --noplugin=audio,a2dp,avrcp");
      writeStaleMarkedDest();

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(dest)).toBe(false);
      expect(reloads()).toHaveLength(1);
      expectIndented(result);
    });

    it("leaves a file of that name ClawBox did not write alone", () => {
      writeVendor("/usr/lib/bluetooth/bluetoothd --noplugin=audio,a2dp,avrcp");
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(dest, "[Service]\nExecStart=\nExecStart=/usr/lib/bluetooth/bluetoothd -d\n");

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(dest, "utf-8")).toBe("[Service]\nExecStart=\nExecStart=/usr/lib/bluetooth/bluetoothd -d\n");
      expect(reloads()).toEqual([]);
    });
  });

  describe("when there is no vendor drop-in (every non-Jetson, and the CI container)", () => {
    it("is a no-op with one line and asks systemd nothing", () => {
      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(systemctlCalls()).toEqual([]);
      expect(installCalls()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
      expectIndented(result);
      expectNoLeftovers();
    });

    it("treats a vendor path that is a symlink as no vendor drop-in", () => {
      const real = path.join(sandbox, "elsewhere.conf");
      fs.writeFileSync(real, `[Service]\nExecStart=\nExecStart=${VENDOR_EXEC}\n`);
      fs.mkdirSync(vendorDir, { recursive: true });
      fs.symlinkSync(real, vendor);

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(systemctlCalls()).toEqual([]);
    });

    it("removes a stale ClawBox drop-in, with one daemon-reload", () => {
      writeStaleMarkedDest();

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(dest)).toBe(false);
      expect(reloads()).toHaveLength(1);
      expectIndented(result);
    });
  });

  describe("when bluetooth.service carries a drop-in ClawBox did not write", () => {
    it("leaves everything as it is", () => {
      writeVendor(VENDOR_EXEC);
      const operator = path.join(destDir, "override.conf");

      const result = runStep({ dropIns: [vendor, operator] });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(dest)).toBe(false);
      expect(installCalls()).toEqual([]);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
      expect(result.stdout).toContain(operator);
      expectIndented(result);
    });

    it("removes a ClawBox drop-in already there, so the operator's ExecStart is the one in force", () => {
      // Ours sorts after `override.conf`: kept, its `ExecStart=` reset would
      // silently replace the operator's own ExecStart at the next start.
      writeVendor(VENDOR_EXEC);
      writeStaleMarkedDest();
      const operator = path.join(destDir, "override.conf");
      const owners = "[Service]\nExecStart=\nExecStart=/usr/lib/bluetooth/bluetoothd -d -n\n";
      fs.writeFileSync(operator, owners);
      expect(path.basename(operator) < DEST_NAME).toBe(true);

      const result = runStep({ dropIns: [vendor, operator, dest] });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.readFileSync(operator, "utf-8")).toBe(owners);
      expect(installCalls()).toEqual([]);
      expect(reloads()).toHaveLength(1);
      expect(stepLines(result)).toHaveLength(1);
      expect(result.stdout).toContain(operator);
      expectIndented(result);
    });

    it("leaves a file of ClawBox's name it did not write alone, beside the operator's", () => {
      writeVendor(VENDOR_EXEC);
      fs.mkdirSync(destDir, { recursive: true });
      const unmarked = "[Service]\nExecStart=\nExecStart=/usr/lib/bluetooth/bluetoothd -d\n";
      fs.writeFileSync(dest, unmarked);
      const operator = path.join(sandbox, "run", "override.conf");

      const result = runStep({ dropIns: [vendor, operator, dest] });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(dest, "utf-8")).toBe(unmarked);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
    });

    it("leaves everything when systemd cannot say which drop-ins there are", () => {
      writeVendor(VENDOR_EXEC);

      const result = runStep({ showRc: 1 });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
      expectIndented(result);
    });
  });

  it("reads the vendor drop-in under another spelling of the same path as the vendor's", () => {
    // Merged /usr: systemd can report /lib/systemd/... for what is /usr/lib/systemd/...
    writeVendor(VENDOR_EXEC);
    const lib = path.join(sandbox, "lib");
    fs.symlinkSync(path.join(sandbox, "usr", "lib"), lib);
    const libSpelling = path.join(lib, "systemd", "system", "bluetooth.service.d", VENDOR_NAME);
    expect(libSpelling).not.toBe(vendor);

    const result = runStep({ dropIns: [libSpelling] });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe(expectedDropIn());
    expect(reloads()).toHaveLength(1);
  });

  describe("a vendor line that is not a shape this step edits", () => {
    const shapes: Array<[string, string]> = [
      ["a quote", "/usr/lib/bluetooth/bluetoothd -d '--noplugin=audio,a2dp'"],
      ["a double quote", '/usr/lib/bluetooth/bluetoothd -d "--noplugin=audio a2dp"'],
      ["a backslash", "/usr/lib/bluetooth/bluetoothd -d --noplugin=audio\\x2c"],
      ["a semicolon", "/usr/lib/bluetooth/bluetoothd -d ; /bin/true"],
      ["--debug", "/usr/lib/bluetooth/bluetoothd -d --debug=src/adapter.c"],
      ["--debug alone", "/usr/lib/bluetooth/bluetoothd --debug --noplugin=audio"],
      ["a bundled -nd", "/usr/lib/bluetooth/bluetoothd -nd --noplugin=audio"],
      ["a -d with its value glued on", "/usr/lib/bluetooth/bluetoothd -dsrc/adapter.c"],
    ];

    it.each(shapes)("leaves %s alone, with one line", (_what, execStart) => {
      writeVendor(execStart);

      const result = runStep();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(destDir)).toBe(false);
      expect(installCalls()).toEqual([]);
      expect(reloads()).toEqual([]);
      expect(stepLines(result)).toHaveLength(1);
      expect(result.stdout).toContain("not a shape this step edits");
      expectIndented(result);
    });

    it.each([shapes[0], shapes[6]])(
      "removes a ClawBox drop-in derived from an earlier line, so the vendor's own is in force (%s)",
      (_what, execStart) => {
        writeVendor(execStart);
        writeStaleMarkedDest();

        const result = runStep();

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fs.existsSync(dest)).toBe(false);
        expect(reloads()).toHaveLength(1);
        expectIndented(result);
      },
    );
  });

  it("fails the step, leaves nothing half-written and reloads nothing when the drop-in cannot be installed", () => {
    writeVendor(VENDOR_EXEC);

    const result = runStep({ installFails: true, viaOptionalStep: true });

    // Both callers run it with errexit off: only the return code carries the failure.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FAILED_STEPS=[ bluetooth_no_debug]");
    expect(fs.existsSync(dest)).toBe(false);
    expect(reloads()).toEqual([]);
    expectNoLeftovers();
    expectIndented(result);
  });

  it("fails the step when daemon-reload fails after a write", () => {
    writeVendor(VENDOR_EXEC);

    const result = runStep({ reloadRc: 1, viaOptionalStep: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FAILED_STEPS=[ bluetooth_no_debug]");
    expect(fs.readFileSync(dest, "utf-8")).toBe(expectedDropIn());
    expect(reloads()).toHaveLength(1);
    expectNoLeftovers();
  });

  it("does not report a failure for a run that succeeded", () => {
    writeVendor(VENDOR_EXEC);

    const result = runStep({ viaOptionalStep: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("FAILED_STEPS=[]");
  });

  it("runs on the full install and on every in-app update, non-fatally", () => {
    const systemConfig = extractShellFunction("step_system_config");
    const journal = systemConfig.indexOf("\n  step_persistent_journal");
    const call = systemConfig.indexOf(
      '\n  step_bluetooth_no_debug || echo "  Warning: bluetooth debug step failed (non-fatal)"',
    );
    expect(journal).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(journal);

    const postUpdate = extractShellFunction("step_post_update");
    const optional = postUpdate.indexOf("\n  optional_step bluetooth_no_debug step_bluetooth_no_debug\n");
    expect(optional).toBeGreaterThan(0);
    expect(optional).toBeGreaterThan(postUpdate.indexOf("optional_step persistent_journal step_persistent_journal"));
  });
});
