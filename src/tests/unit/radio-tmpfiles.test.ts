import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// Runs the real install_radio_tmpfiles under bash; a spawning test carries both
// ceilings (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * /run/clawbox-radio is where scripts/wifi-radio.sh takes the radio lock. /run
 * is a tmpfs, so the directory (and the lock in it) has to be put back at every
 * boot by a tmpfiles.d entry; otherwise the web account, which cannot create
 * anything under /run, fails every stop-ap.sh / `wifi-radio.sh --nmcli` on a box
 * where no root radio script has run yet.
 */

const REPO = path.resolve(__dirname, "../../..");
const CONF = path.join(REPO, "config", "clawbox-radio-tmpfiles.conf");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

/** The non-comment, non-empty lines of a tmpfiles.d file as [type, path, mode, user, group, age]. */
function entries(file: string): string[][] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => l.trim().split(/\s+/));
}

describe("config/clawbox-radio-tmpfiles.conf", () => {
  it("creates /run/clawbox-radio as root:root 0755, the owner and mode wifi_lock demands of root", () => {
    expect(entries(CONF)).toContainEqual(["d", "/run/clawbox-radio", "0755", "root", "root", "-"]);
    // wifi_lock's own check, so the two cannot drift apart.
    const radio = fs.readFileSync(path.join(REPO, "scripts", "wifi-radio.sh"), "utf-8");
    expect(radio).toContain('RADIO_DIR="${CLAWBOX_RADIO_RUN_DIR:-/run/clawbox-radio}"');
    expect(radio).toContain('[ "$(stat -c %a "$RADIO_DIR")" = 755 ]');
  });

  it("also creates the lock for the default interface, root-owned and world-readable", () => {
    const radio = fs.readFileSync(path.join(REPO, "scripts", "wifi-radio.sh"), "utf-8");
    const iface = /RADIO_IFACE="\$\{NETWORK_INTERFACE:-([^}]+)\}"/.exec(radio)?.[1];
    expect(iface).toBeTruthy();
    // 0644: the web account opens it read-only to flock it, which needs read access.
    expect(entries(CONF)).toContainEqual(["f", `/run/clawbox-radio/${iface}.lock`, "0644", "root", "root", "-"]);
  });

  it("has no age field that would let a cleaner remove the lock out from under a holder", () => {
    for (const e of entries(CONF)) expect(e[5], e.join(" ")).toBe("-");
  });

  it("is only about the radio directory", () => {
    for (const e of entries(CONF)) expect(e[1].startsWith("/run/clawbox-radio")).toBe(true);
  });
});

describe("install_radio_tmpfiles", () => {
  const fn = shellFn(INSTALL_SH, "install_radio_tmpfiles");

  /**
   * Run the real function against a fake tree. `failCopy` makes the root copy
   * fail; `noTmpfiles` leaves systemd-tmpfiles unavailable; `tmpfilesFails`
   * makes it fail.
   */
  function run(opts: { withSource?: boolean; failCopy?: boolean; noTmpfiles?: boolean; tmpfilesFails?: boolean } = {}) {
    const { withSource = true, failCopy = false, noTmpfiles = false, tmpfilesFails = false } = opts;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-tmpfiles-"));
    try {
      const project = path.join(tmp, "project");
      const dest = path.join(tmp, "tmpfiles.d");
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(path.join(project, "config"), { recursive: true });
      fs.mkdirSync(bin);
      if (withSource) fs.copyFileSync(CONF, path.join(project, "config", "clawbox-radio-tmpfiles.conf"));
      if (noTmpfiles) {
        // A PATH holding only what the stubs below use, so the real systemd-tmpfiles (if any) is out of reach.
        for (const tool of ["cp", "mkdir"]) fs.symlinkSync(fs.realpathSync(`/usr/bin/${tool}`), path.join(bin, tool));
      } else {
        fs.writeFileSync(
          path.join(bin, "systemd-tmpfiles"),
          `#!/bin/sh\necho "systemd-tmpfiles $*" >> "${tmp}/tmpfiles-calls"\n${tmpfilesFails ? "exit 1" : "exit 0"}\n`,
          { mode: 0o755 },
        );
      }
      const script = [
        "set -euo pipefail",
        `SRC_DIR=${JSON.stringify(project)}`,
        `ROOT_TMPFILES_DIR=${JSON.stringify(dest)}`,
        // `install -d -o root` cannot run unprivileged; only the directory matters here.
        'install() { if [ "$1" = -d ]; then mkdir -p -- "${@: -1}"; fi; }',
        `install_root_file() { ${failCopy ? "return 1" : 'cp -- "$1" "$2"'}; }`,
        'record_provision_failure() { echo "recorded:$1"; }',
        fn,
        // The OR-list shape every step_post_update fixup runs in.
        'install_radio_tmpfiles || echo "rc=$?"',
        'echo "after"',
      ].join("\n");
      const r = spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf-8",
        env: { ...process.env, PATH: noTmpfiles ? bin : `${bin}:/usr/bin:/bin` },
      });
      const installed = path.join(dest, "clawbox-radio.conf");
      const callsFile = path.join(tmp, "tmpfiles-calls");
      return {
        out: r.stdout + r.stderr,
        installed: fs.existsSync(installed) ? fs.readFileSync(installed, "utf-8") : null,
        installedPath: installed,
        tmpfilesCalls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf-8") : "",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("copies the entry to /etc/tmpfiles.d/clawbox-radio.conf and creates the directory right away", () => {
    const r = run();
    expect(r.out).toContain("after");
    expect(r.out).not.toContain("rc=");
    expect(r.out).not.toContain("recorded:");
    expect(r.installed).toBe(fs.readFileSync(CONF, "utf-8"));
    // Applied now, from that very file: no reboot needed for the lock directory to exist.
    expect(r.tmpfilesCalls).toBe(`systemd-tmpfiles --create ${r.installedPath}\n`);
  });

  it("records root_libexec and returns non-zero when the copy does not land", () => {
    const r = run({ failCopy: true });
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("recorded:root_libexec");
    expect(r.out).toContain("could not install");
    expect(r.installed).toBeNull();
    expect(r.tmpfilesCalls).toBe("");
  });

  it("is not a failure on a tree that predates the file", () => {
    const r = run({ withSource: false });
    expect(r.out).not.toContain("rc=");
    expect(r.out).not.toContain("recorded:");
    expect(r.installed).toBeNull();
  });

  it("only warns when the entry cannot be applied now: it is installed and the next boot creates the directory", () => {
    const r = run({ tmpfilesFails: true });
    expect(r.out).toContain("Warning: could not create /run/clawbox-radio now");
    expect(r.out).not.toContain("rc=");
    expect(r.out).not.toContain("recorded:");
    expect(r.installed).toBe(fs.readFileSync(CONF, "utf-8"));
  });

  it("is quiet and successful where there is no systemd-tmpfiles at all (a container)", () => {
    const r = run({ noTmpfiles: true });
    expect(r.out).not.toContain("rc=");
    expect(r.out).not.toContain("Warning");
    expect(r.installed).toBe(fs.readFileSync(CONF, "utf-8"));
  });
});

describe("step_systemd_services publishes it", () => {
  const step = shellFn(INSTALL_SH, "step_systemd_services");

  it("installs the radio entry right after the root-owned copies, before the units", () => {
    const libexec = step.indexOf("install_root_libexec ||");
    const tmpfiles = step.indexOf("install_radio_tmpfiles");
    const units = step.indexOf('cp "$src" /etc/systemd/system/');
    expect(libexec).toBeGreaterThan(-1);
    expect(tmpfiles).toBeGreaterThan(libexec);
    expect(units).toBeGreaterThan(tmpfiles);
  });

  it("does not let a failed tmpfiles copy hold the units back", () => {
    expect(step).toMatch(/install_radio_tmpfiles \|\| true/);
  });

  it("names the repair step for the failure it records", () => {
    expect(shellFn(INSTALL_SH, "provision_repair_step")).toMatch(/root_libexec\)\s+printf 'systemd_services'/);
  });
});
