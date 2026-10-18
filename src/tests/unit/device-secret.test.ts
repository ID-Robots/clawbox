import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The per-device hotspot credentials (scripts/device-secret.sh) and the
 * factory provisioning wrapper (scripts/provision-device.sh). The derivation
 * is byte-exact with the factory tooling that prints the sticker, so it is
 * checked against an independent implementation here (Node's HMAC), and the
 * two fixed vectors below pin it against silent drift.
 */

// Starts real bash/openssl processes: vitest's 5 s default is too tight on CI.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const DEVICE_SECRET = path.join(REPO, "scripts", "device-secret.sh");
const PROVISION = path.join(REPO, "scripts", "provision-device.sh");
const START_AP = fs.readFileSync(path.join(REPO, "scripts", "start-ap.sh"), "utf-8");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const ZEROS = "00".repeat(32);
const ONES = "ff".repeat(32);

function reference(secretHex: string): { ssid: string; psk: string } {
  const key = Buffer.from(secretHex, "hex");
  const mapped = (label: string, n: number) =>
    [...crypto.createHmac("sha256", key).update(label, "ascii").digest().subarray(0, n)]
      .map((b) => ALPHABET[b % 32])
      .join("");
  return {
    ssid: `ClawBox-${mapped("clawbox-hotspot-ssid-v1", 4).toUpperCase()}`,
    psk: mapped("clawbox-hotspot-psk-v1", 14),
  };
}

let tmp: string;
let etc: string;
let serialFile: string;

function run(script: string, args: string[], input = "", extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    input,
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_ETC: etc, CLAWBOX_SERIAL_FILE: serialFile, ...extraEnv },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "device-secret-"));
  etc = path.join(tmp, "etc");
  serialFile = path.join(tmp, "serial-number");
  // The device tree carries a trailing NUL, which the script must strip.
  fs.writeFileSync(serialFile, "1420321000001\0");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("device-secret.sh derivation", () => {
  it("has a 32-character alphabet without 0, 1, l or o", () => {
    expect(ALPHABET).toHaveLength(32);
    expect(new Set(ALPHABET).size).toBe(32);
    expect(ALPHABET).not.toMatch(/[01lo]/);
    expect(fs.readFileSync(DEVICE_SECRET, "utf-8")).toContain(`ALPHABET="${ALPHABET}"`);
  });

  it("matches the fixed vectors", () => {
    expect(reference(ZEROS)).toEqual({ ssid: "ClawBox-Q7M8", psk: "vkdynwkvv7sg5v" });
    expect(reference(ONES)).toEqual({ ssid: "ClawBox-DGVE", psk: "szki7yd9km7nd3" });
  });

  for (const secret of [ZEROS, ONES, crypto.randomBytes(32).toString("hex")]) {
    it(`derives the same SSID and PSK as an independent HMAC (${secret.slice(0, 8)}…)`, () => {
      const want = reference(secret);
      const r = run(DEVICE_SECRET, ["derive"], `${secret}\n`);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`SSID=${want.ssid}\nPSK=${want.psk}\n`);
      const qr = run(DEVICE_SECRET, ["qr"], secret.toUpperCase());
      expect(qr.status).toBe(0);
      expect(qr.stdout).toBe(`WIFI:T:WPA;S:${want.ssid};P:${want.psk};;\n`);
    });
  }

  it("refuses anything but 64 hex characters", () => {
    for (const bad of ["", "abc", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
      const r = run(DEVICE_SECRET, ["derive"], bad);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  it("never puts the secret on a command line", () => {
    const text = fs.readFileSync(DEVICE_SECRET, "utf-8");
    expect(text).not.toMatch(/hexkey|-hmac\b|-macopt/);
  });
});

describe("device-secret.sh install / load", () => {
  it("installs a 0600 file bound to this board's serial and loads it back", () => {
    const r = run(DEVICE_SECRET, ["install"], ONES);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(ONES);
    const file = path.join(etc, "device-secret");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toBe(`serial=1420321000001\nsecret=${ONES}\n`);

    const load = run(DEVICE_SECRET, ["load"]);
    expect(load.status).toBe(0);
    const want = reference(ONES);
    expect(load.stdout).toBe(`SSID=${want.ssid}\nPSK=${want.psk}\n`);
    expect(load.stdout + load.stderr).not.toContain(ONES);
  });

  it("exits 3 when the box has no device secret", () => {
    expect(run(DEVICE_SECRET, ["load"]).status).toBe(3);
  });

  it("ignores a secret cloned from another board (exit 4, nothing printed)", () => {
    expect(run(DEVICE_SECRET, ["install"], ONES).status).toBe(0);
    fs.writeFileSync(serialFile, "1420321000999\0");
    const r = run(DEVICE_SECRET, ["load"]);
    expect(r.status).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("device secret belongs to another board (cloned image?) — ignored");
    expect(r.stderr).not.toContain(ONES);
  });

  it("refuses to install without a board serial", () => {
    fs.rmSync(serialFile);
    expect(run(DEVICE_SECRET, ["install"], ONES).status).toBe(2);
    expect(fs.existsSync(path.join(etc, "device-secret"))).toBe(false);
  });
});

// Fake `passwd -S` / `runuser` so the owner guard can be driven without a
// real clawbox account. PASSWD_STATUS = P | L | NP | "" (unreadable);
// CHKPWD_RC = what unix_chkpwd answers for the legacy password (0 = it
// verifies, 7 = an owner's own password).
function stockEnv(passwdStatus = "L", chkpwdRc = "7"): Record<string, string> {
  const bin = path.join(tmp, "bin");
  const root = path.join(tmp, "root");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "passwd"),
    '#!/bin/sh\n[ -n "$PASSWD_STATUS" ] || exit 1\necho "clawbox $PASSWD_STATUS 2026-01-01 0 99999 7 -1"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "runuser"), '#!/bin/sh\ncat >/dev/null\nexit "$CHKPWD_RC"\n', { mode: 0o755 });
  return {
    PATH: `${bin}:${process.env.PATH}`,
    CLAWBOX_ROOT: root,
    PASSWD_STATUS: passwdStatus,
    CHKPWD_RC: chkpwdRc,
  };
}

describe("provision-device.sh", () => {
  it("removes the password and disables SSH without stopping the station's session", () => {
    const text = fs.readFileSync(PROVISION, "utf-8");
    expect(text).toContain(`usermod -p '!' "$ACCOUNT"`);
    expect(text).toMatch(/^systemctl disable ssh$/m);
    expect(text).not.toMatch(/disable --now ssh|systemctl stop ssh/);
    expect(text).not.toMatch(/chpasswd/);
  });

  it("--dry-run validates and prints the plan without writing or revealing the PSK", () => {
    const r = run(PROVISION, ["--dry-run"], ZEROS, stockEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ClawBox-Q7M8");
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain("remove the password of 'clawbox'");
    expect(r.stdout).toContain("ssh-policy = disabled");
    expect(r.stdout).toContain("not stopped now");
    expect(fs.existsSync(path.join(etc, "ssh-policy"))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain(reference(ZEROS).psk);
    expect(r.stdout + r.stderr).not.toContain(ZEROS);
    expect(fs.existsSync(path.join(etc, "device-secret"))).toBe(false);
  });

  describe("refuses a box that already has an owner", () => {
    // passwd / runuser stubs on PATH and a fake install tree, so the guard runs
    // exactly as on a box: P + not-the-legacy-password = owned.
    function guarded(opts: { status: string; chkpwd: number; setupComplete?: boolean }) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "prov-guard-"));
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(root, "box", "data"), { recursive: true });
      if (opts.setupComplete) {
        fs.writeFileSync(path.join(root, "box", "data", "config.json"), '{"setup_complete": true}');
      }
      fs.writeFileSync(path.join(bin, "passwd"), `#!/usr/bin/env bash\necho "clawbox ${opts.status} 01/01/2026"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "runuser"), `#!/usr/bin/env bash\ncat >/dev/null\nexit ${opts.chkpwd}\n`, { mode: 0o755 });
      const r = spawnSync("bash", [PROVISION, "--dry-run"], {
        input: ZEROS,
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAWBOX_ETC: etc, CLAWBOX_ROOT: path.join(root, "box") },
      });
      fs.rmSync(root, { recursive: true, force: true });
      return r;
    }

    it("an owner's own password", () => {
      const r = guarded({ status: "P", chkpwd: 7 });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("refusing");
    });

    it("a completed setup, whatever the password", () => {
      expect(guarded({ status: "L", chkpwd: 7, setupComplete: true }).status).toBe(3);
    });

    it("an undecidable password check", () => {
      expect(guarded({ status: "P", chkpwd: 4 }).status).toBe(3);
    });

    it("but provisions a stock box on the legacy image password or none", () => {
      expect(guarded({ status: "P", chkpwd: 0 }).status).toBe(0);
      expect(guarded({ status: "L", chkpwd: 7 }).status).toBe(0);
    });
  });

  it("--dry-run refuses a malformed secret", () => {
    expect(run(PROVISION, ["--dry-run"], "nope", stockEnv()).status).toBe(2);
  });

  it("accepts a stock box still carrying only the legacy image password", () => {
    const r = run(PROVISION, ["--dry-run"], ZEROS, stockEnv("P", "0"));
    expect(r.status).toBe(0);
  });

  // TASK-1572: an already set-up customer box must never be provisioned —
  // that would change its hotspot. Every owner signal alone refuses, and so
  // does doubt.
  it.each([
    ["setup completed", { config: '{"setup_complete": true}' }],
    ["owner password flag", { config: '{"password_configured":true}' }],
    ["own hotspot settings", { hotspotEnv: "HOTSPOT_SSID=Home\n" }],
    ["an owner password in shadow", { status: "P", rc: "7" }],
    ["unreadable password state", { status: "" }],
    ["password check failed", { status: "P", rc: "9" }],
  ])("refuses a box with %s", (_label, c: { config?: string; hotspotEnv?: string; status?: string; rc?: string }) => {
    const env = stockEnv(c.status ?? "L", c.rc ?? "7");
    if (c.config) fs.writeFileSync(path.join(env.CLAWBOX_ROOT, "data", "config.json"), c.config);
    if (c.hotspotEnv) fs.writeFileSync(path.join(env.CLAWBOX_ROOT, "data", "hotspot.env"), c.hotspotEnv);
    for (const args of [["--dry-run"], []]) {
      const r = run(PROVISION, args, ZEROS, env);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(etc, "device-secret"))).toBe(false);
      expect(fs.existsSync(path.join(etc, "provisioned"))).toBe(false);
    }
  });

  it("is installed root-owned beside start-ap.sh, which finds device-secret.sh as a sibling", () => {
    expect(INSTALL_SH).toMatch(/device-secret\.sh provision-device\.sh \\\n\s+wifi-failover\.sh start-ap\.sh/);
    expect(START_AP).toContain('DEVICE_SECRET_SH="$(dirname "${BASH_SOURCE[0]}")/device-secret.sh"');
  });
});

describe("start-ap.sh hotspot credentials and captive probes", () => {
  it("prefers the owner's hotspot.env, then the device credentials, then the legacy open AP", () => {
    expect(START_AP).toContain('SSID="${HOTSPOT_SSID:-${DEVICE_SSID:-ClawBox-Setup}}"');
    expect(START_AP).toMatch(/AP_PSK="\$HOTSPOT_PASSWORD"; AP_SECURITY=owner/);
    expect(START_AP).toMatch(/AP_PSK="\$DEVICE_PSK"; AP_SECURITY=device/);
    expect(START_AP).toMatch(/AP_PSK=""; AP_SECURITY=open/);
    expect(START_AP).toContain('AP_SECURITY="$AP_SECURITY"');
    // The PSK goes to nmcli, never to the log.
    expect(START_AP).not.toMatch(/echo[^\n]*\$(AP_PSK|DEVICE_PSK|HOTSPOT_PASSWORD)/);
  });

  it("keeps the AP profile name the watchdog and failover look for", () => {
    expect(START_AP).toContain('CON_NAME="ClawBox-Setup"');
  });

  it("resolves only the probe hosts to the AP, and only during first setup", () => {
    const hosts = START_AP.match(/CAPTIVE_PROBE_HOSTS="([^"]+)"/)?.[1].split(" ");
    expect(hosts).toEqual([
      "connectivitycheck.gstatic.com", "connectivitycheck.android.com", "clients1.google.com",
      "clients3.google.com", "captive.apple.com", "www.msftconnecttest.com", "www.msftncsi.com",
      "detectportal.firefox.com", "nmcheck.gnome.org", "connectivity-check.ubuntu.com",
    ]);
    expect(START_AP).toContain('echo "address=/${probe_host}/${AP_IP}"');
    expect(START_AP).not.toMatch(/address=\/#\//);
    expect(START_AP).toMatch(/if \[ "\$setup_complete" != true \]; then\n\s+\{\n\s+echo "# Captive-portal probe hosts/);
    expect(START_AP).toContain('rm -f "$CAPTIVE_PROBES_CONF"');
    // install.sh's DNS step removes the probes only once setup is complete.
    const step = INSTALL_SH.slice(INSTALL_SH.indexOf("step_captive_portal_dns() {"));
    const body = step.slice(0, step.indexOf("\n}"));
    expect(body).toMatch(/setup_complete[^\n]*\n\s+rm -f "\$DNSMASQ_DIR\/captive-probes\.conf"/);
  });

  it("survives a factory reset: the secret lives in /etc, which the reset does not wipe", () => {
    expect(fs.readFileSync(DEVICE_SECRET, "utf-8")).toContain('ETC_DIR="${CLAWBOX_ETC:-/etc/clawbox}"');
    const reset = fs.readFileSync(path.join(REPO, "src/app/setup-api/setup/reset/route.ts"), "utf-8");
    expect(reset).not.toMatch(/\/etc\/clawbox/);
  });
});
