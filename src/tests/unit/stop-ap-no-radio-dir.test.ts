import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the shipped scripts under bash; a spawning test carries both ceilings
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * stop-ap.sh and wifi-radio.sh as the WEB ACCOUNT runs them: unprivileged, with
 * /run/clawbox-radio not there.
 *
 * /run is a tmpfs and only a root radio script (start-ap.sh, the watchdog,
 * wifi-failover.sh) or the tmpfiles.d entry creates the directory and the lock
 * in it. On a box where none had run — Ethernet, hotspot off, a lab board —
 * wifi_lock's mkdir failed, set -e ended stop-ap.sh, and Settings -> WiFi ->
 * Connect showed "Command failed: bash /usr/local/libexec/clawbox/stop-ap.sh".
 *
 * The tests run the real scripts with nmcli/iptables replaced by recorders, the
 * radio directory moved under a temp dir through the same CLAWBOX_RADIO_RUN_DIR
 * seam the other radio tests use. An unprivileged runner is the thing under
 * test, so they skip when the suite itself runs as root.
 */

const REPO = path.resolve(__dirname, "../../..");
const STOP_AP = path.join(REPO, "scripts", "stop-ap.sh");
const WIFI_RADIO = path.join(REPO, "scripts", "wifi-radio.sh");
const AP_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(isRoot)("stop-ap.sh without /run/clawbox-radio (unprivileged)", () => {
  let tmp: string;
  let bin: string;
  let calls: string;
  /** A radio directory that cannot be created: its parent is a regular file. */
  let missing: string;

  /**
   * nmcli, as a recorder. `ap`: a ClawBox-Setup AP profile on the radio exists;
   * `broken`: nmcli fails outright.
   */
  function stubNmcli(mode: "no-ap" | "ap" | "broken"): void {
    const script = [
      "#!/bin/sh",
      `echo "nmcli $*" >> "${calls}"`,
      mode === "broken" ? "exit 8" : "",
      'case "$*" in',
      `  "-g UUID connection show") ${mode === "ap" ? `echo ${AP_UUID}` : "true"} ;;`,
      '  *"connection.id"*) echo ClawBox-Setup ;;',
      '  *"802-11-wireless.mode"*) echo ap ;;',
      '  *"connection.interface-name"*) echo wlP1p1s0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(bin, "nmcli"), script, { mode: 0o755 });
  }

  function run(script: string, args: string[], radioDir: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAWBOX_RADIO_RUN_DIR: radioDir };
    delete env.NETWORK_INTERFACE;
    return spawnSync("bash", [script, ...args], { encoding: "utf-8", env, timeout: 20_000 });
  }

  const nmcliCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8") : "");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stop-ap-"));
    bin = path.join(tmp, "bin");
    calls = path.join(tmp, "calls");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "iptables"), `#!/bin/sh\necho "iptables $*" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, "plain-file"), "");
    missing = path.join(tmp, "plain-file", "clawbox-radio");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 0 and says no access point is running when there is none to stop", () => {
    stubNmcli("no-ap");
    const r = run(STOP_AP, [], missing);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No access point running");
    expect(r.stderr).toBe("");
    // It looked (read-only) and touched nothing.
    expect(nmcliCalls()).toContain("nmcli -g UUID connection show");
    expect(nmcliCalls()).not.toMatch(/connection (down|delete)/);
    expect(nmcliCalls()).not.toContain("iptables");
  });

  it("fails, saying why, when there IS an access point to stop and no way to lock the radio", () => {
    stubNmcli("ap");
    const r = run(STOP_AP, [], missing);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not set up");
    expect(r.stderr).toContain(missing);
    // Never a half-stop: no AP deleted without the lock.
    expect(nmcliCalls()).not.toMatch(/connection (down|delete)/);
  });

  it("fails when nmcli cannot say whether an access point is up", () => {
    stubNmcli("broken");
    const r = run(STOP_AP, [], missing);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("No access point running");
  });

  it("does not call a path that exists but is not a directory 'absent'", () => {
    stubNmcli("no-ap");
    const r = run(STOP_AP, [], path.join(tmp, "plain-file"));
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("No access point running");
    // nothing here asked nmcli about the AP: it is the lock that is wrong.
    expect(nmcliCalls()).not.toContain("UUID");
  });

  it("does not call a dangling symlink 'absent' either", () => {
    stubNmcli("no-ap");
    const link = path.join(tmp, "dangling");
    fs.symlinkSync(path.join(tmp, "nowhere"), link);
    const r = run(STOP_AP, [], link);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("No access point running");
  });

  it("is unchanged when the radio directory is there: it takes the lock and stops the AP", () => {
    stubNmcli("ap");
    const dir = path.join(tmp, "radio");
    fs.mkdirSync(dir, { mode: 0o755 });
    const r = run(STOP_AP, [], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Access point stopped.");
    expect(nmcliCalls()).toContain(`connection down uuid ${AP_UUID}`);
    expect(nmcliCalls()).toContain(`connection delete uuid ${AP_UUID}`);
  });

  it("is unchanged when the directory is there and there is no AP", () => {
    stubNmcli("no-ap");
    const dir = path.join(tmp, "radio");
    fs.mkdirSync(dir, { mode: 0o755 });
    const r = run(STOP_AP, [], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Access point stopped.");
    expect(nmcliCalls()).not.toMatch(/connection (down|delete)/);
  });

  it("wifi-radio.sh --nmcli still refuses to run an nmcli write without the lock, and says why", () => {
    stubNmcli("no-ap");
    const r = run(WIFI_RADIO, ["--nmcli", "device", "wifi", "connect", "Example-Home"], missing);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Radio ownership is not set up");
    expect(nmcliCalls()).not.toContain("connect");
  });

  it("wifi_lock leaves WIFI_LOCK_ABSENT at 0 when the failure is not an absent lock", () => {
    stubNmcli("no-ap");
    const probe = (dir: string) =>
      spawnSync("bash", ["-c", `. "${WIFI_RADIO}"; wifi_lock; echo "rc=$? absent=$WIFI_LOCK_ABSENT"`], {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAWBOX_RADIO_RUN_DIR: dir },
      }).stdout.trim();
    expect(probe(missing)).toBe("rc=1 absent=1");
    expect(probe(path.join(tmp, "plain-file"))).toBe("rc=1 absent=0");
    const dir = path.join(tmp, "radio");
    fs.mkdirSync(dir, { mode: 0o755 });
    expect(probe(dir)).toBe("rc=0 absent=0");
    // A directory that exists but whose lock cannot be created is "absent" for an unprivileged caller.
    fs.rmSync(path.join(dir, "wlP1p1s0.lock"), { force: true });
    fs.chmodSync(dir, 0o555);
    expect(probe(dir)).toBe("rc=1 absent=1");
    fs.chmodSync(dir, 0o755);
  });
});

describe("nothing in the access point's stop path turns the radio off", () => {
  // Switching the hotspot off must never leave the WiFi radio disabled: the
  // owner would have no network and no hotspot. The only things that can do it
  // are nmcli's radio switch, rfkill and a device/networking-wide off; none of
  // the scripts or routes that stop, start or restore the AP may carry them.
  const FILES = [
    "scripts/stop-ap.sh",
    "scripts/start-ap.sh",
    "scripts/ap-watchdog.sh",
    "scripts/wifi-failover.sh",
    "scripts/wifi-radio.sh",
    "src/app/setup-api/system/hotspot/route.ts",
    "src/lib/hotspot-env.ts",
    "src/lib/network.ts",
  ];
  const OFF = /radio\s+(wifi|wwan|all)\s+off|rfkill\s+(block|toggle)|networking\s+off|["']radio["']\s*,\s*["'](wifi|all)["']\s*,\s*["']off["']/;

  it.each(FILES)("%s has no radio-off command", (file) => {
    const code = fs
      .readFileSync(path.join(REPO, file), "utf-8")
      .split("\n")
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(OFF);
  });
});
