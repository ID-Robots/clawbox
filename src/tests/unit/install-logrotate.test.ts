import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Starts a real bash per case: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Ubuntu's logrotate on the Jetson, installed by step_apt_update.
 *
 * Some Jetson images ship without the package, so rsyslog's /var/log/syslog,
 * kern.log, auth.log and ufw.log were never rotated: a measured board's syslog
 * held 61 days in 179 MB, although the rsyslog and ufw packages' own weekly
 * policy sat in /etc/logrotate.d the whole time. The step installs the package
 * and makes sure its daily timer is enabled, so that policy runs; ClawBox adds
 * no policy of its own and never forces a rotation.
 *
 * The install has its own apt line and can never fail the step: under
 * `set -euo pipefail` (install.sh's own mode) a mirror that cannot serve
 * logrotate would otherwise stop the base install, the document libraries and
 * the Node check on every update.
 *
 * Whether a package is there is dpkg's answer (`dpkg_installed`), never
 * apt-get's exit code: apt-get exits 100 when ANOTHER package's trigger or
 * postinst fails after the one asked for was configured, and a held package is
 * installed although `${Status}` does not start with "install". The same
 * read-back decides the document libraries' warning.
 *
 * The shipped step_apt_update, ensure_logrotate and dpkg_installed are lifted
 * out of install.sh and run under bash with apt-get, dpkg-query, systemctl and
 * curl stubbed; nothing reads the real /etc or the runner's package database.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/** A shell function lifted out of install.sh, so the test cannot drift from it. */
function shellFunction(name: string): string | null {
  const start = INSTALL_SH.indexOf(`\n${name}() {\n`);
  if (start < 0) return null;
  const end = INSTALL_SH.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start + 1, end + 2);
}

type Timer = "enabled" | "disabled" | "masked";

type Box = {
  state: string;
  bin: string;
  calls: () => string[];
};

/** The document libraries step_apt_update installs on their own apt line. */
const DOC_LIBS = ["python3-docx", "python3-openpyxl", "python3-reportlab"];

/**
 * A box as apt and systemd see it. `installed`: whether dpkg knows logrotate.
 * `held`: it is installed and on hold (`${Status}` is "hold ok installed").
 * `timer`/`active`: logrotate.timer's unit state. `aptFailsLogrotate`: a mirror
 * that cannot serve the package. `aptInstallsNothing`: apt-get answers 0 and
 * dpkg still does not know the package. `aptFailsAfterInstall`: apt-get
 * configures logrotate, then exits 100 over another package's postinst.
 * `enableRefused`: `systemctl enable --now` fails and changes nothing.
 * `startFails`: it enables the unit, then fails to start it. `docsAptFails`:
 * the document-libraries line exits 100 after configuring what it could;
 * `docsMissing`: the libraries that line leaves uninstalled.
 */
function makeBox(opts: {
  installed: boolean;
  held?: boolean;
  timer?: Timer;
  active?: boolean;
  aptFailsLogrotate?: boolean;
  aptInstallsNothing?: boolean;
  aptFailsAfterInstall?: boolean;
  enableRefused?: boolean;
  startFails?: boolean;
  docsAptFails?: boolean;
  docsMissing?: string[];
}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-logrotate-"));
  const state = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(state, "calls"), "");
  if (opts.installed || opts.held) writeFileSync(path.join(state, "installed"), "");
  if (opts.held) writeFileSync(path.join(state, "held"), "");
  writeFileSync(path.join(state, "timer"), opts.timer ?? "disabled");
  writeFileSync(path.join(state, "active"), opts.active ? "active" : "inactive");
  if (opts.aptFailsLogrotate) writeFileSync(path.join(state, "apt-fails-logrotate"), "");
  if (opts.aptInstallsNothing) writeFileSync(path.join(state, "apt-installs-nothing"), "");
  if (opts.aptFailsAfterInstall) writeFileSync(path.join(state, "apt-fails-after-install"), "");
  if (opts.enableRefused) writeFileSync(path.join(state, "enable-refused"), "");
  if (opts.startFails) writeFileSync(path.join(state, "start-fails"), "");
  if (opts.docsAptFails) writeFileSync(path.join(state, "docs-apt-fails"), "");
  for (const pkg of opts.docsMissing ?? []) writeFileSync(path.join(state, `docs-missing-${pkg}`), "");

  const write = (name: string, body: string) => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\nST=${JSON.stringify(state)}\n${body}`);
    chmodSync(p, 0o755);
  };

  // apt-get as a box sees it: a mirror without logrotate answers 100 with
  // apt's own sentence; a served one runs the package's postinst, which on
  // jammy and later enables and starts logrotate.timer on a first install.
  // An exit of 100 AFTER the package was configured is another package's
  // failing postinst in the same dpkg run.
  write("apt-get", `
printf 'apt-get %s\\n' "$*" >> "$ST/calls"
case " $* " in
  *" logrotate "*)
    if [ -e "$ST/apt-fails-logrotate" ]; then
      echo "E: Unable to locate package logrotate" >&2
      exit 100
    fi
    if [ ! -e "$ST/installed" ] && [ ! -e "$ST/apt-installs-nothing" ]; then
      : > "$ST/installed"
      [ "$(cat "$ST/timer")" = masked ] || { echo enabled > "$ST/timer"; echo active > "$ST/active"; }
    fi
    if [ -e "$ST/apt-fails-after-install" ]; then
      echo "dpkg: error processing package fixture-other (--configure):" >&2
      echo "E: Sub-process /usr/bin/dpkg returned an error code (1)" >&2
      exit 100
    fi
    ;;
  *" python3-docx "*)
    for p in ${DOC_LIBS.join(" ")}; do
      [ -e "$ST/docs-missing-$p" ] || : > "$ST/pkg-$p"
    done
    if [ -e "$ST/docs-apt-fails" ]; then
      echo "E: Sub-process /usr/bin/dpkg returned an error code (1)" >&2
      exit 100
    fi
    ;;
esac
exit 0
`);

  // dpkg-query exits 1 for a package it has never seen, which is what a bare
  // assignment under errexit would die on. It answers per package, from the
  // last argument, as the real one does for one name.
  write("dpkg-query", `
printf 'dpkg-query %s\\n' "$*" >> "$ST/calls"
pkg="\${@: -1}"
case "$pkg" in
  logrotate)
    if [ -e "$ST/held" ]; then printf 'hold ok installed'; exit 0; fi
    if [ -e "$ST/installed" ]; then printf 'install ok installed'; exit 0; fi
    ;;
  *)
    if [ -e "$ST/pkg-$pkg" ]; then printf 'install ok installed'; exit 0; fi
    ;;
esac
echo "dpkg-query: no packages found matching $pkg" >&2
exit 1
`);

  write("systemctl", `
printf 'systemctl %s\\n' "$*" >> "$ST/calls"
unit=""
for a in "$@"; do case "$a" in -*) ;; *) unit="$a" ;; esac; done
[ "$unit" = logrotate.timer ] || exit 0
case "$1" in
  is-enabled) [ "$(cat "$ST/timer")" = enabled ] ;;
  is-active) [ "$(cat "$ST/active")" = active ] ;;
  enable)
    if [ "$(cat "$ST/timer")" = masked ]; then
      echo "Failed to enable unit: Unit file /etc/systemd/system/logrotate.timer is masked." >&2
      exit 1
    fi
    if [ -e "$ST/enable-refused" ]; then
      echo "Failed to enable unit: Access denied" >&2
      exit 1
    fi
    echo enabled > "$ST/timer"
    if [ -e "$ST/start-fails" ]; then
      echo "Job for logrotate.timer failed." >&2
      exit 1
    fi
    echo active > "$ST/active"
    ;;
esac
`);

  write("curl", `printf 'curl %s\\n' "$*" >> "$ST/calls"\n`);

  return {
    state,
    bin,
    calls: () => readFileSync(path.join(state, "calls"), "utf-8").split("\n").filter(Boolean),
  };
}

/**
 * The helpers step_apt_update calls that are not this file's subject, stubbed:
 * each has a suite of its own. The Node check is logged, so a case can see the
 * step reached it.
 */
const AMBIENT = [
  "refresh_root_update_log_limit() { :; }",
  "wait_for_apt() { :; }",
  'node_satisfies_openclaw_engine() { printf "node-check\\n" >> "$ST/calls"; return 0; }',
  "node_engine_remedy() { :; }",
  "node() { printf 'v24.22.1\\n'; }",
];

/**
 * step_apt_update as install.sh runs it: errexit, nounset, pipefail. A case may
 * hand in its own copy of ensure_logrotate or step_apt_update.
 */
function run(
  box: Box,
  over: { ensureLogrotate?: string | null; step?: string } = {},
): SpawnSyncReturns<string> {
  const step = over.step ?? shellFunction("step_apt_update");
  if (!step) throw new Error("step_apt_update not found in install.sh");
  const ensureLogrotate = "ensureLogrotate" in over ? over.ensureLogrotate : shellFunction("ensure_logrotate");
  const program = [
    "set -euo pipefail",
    `ST=${JSON.stringify(box.state)}`,
    'OPENCLAW_NODE_ENGINE=">=24.22.1 <25 || >=26.12.1"',
    ...AMBIENT,
    shellFunction("dpkg_installed") ?? "",
    ensureLogrotate ?? "",
    step,
    "step_apt_update",
  ].join("\n");
  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 20_000,
    env: { ...process.env, PATH: `${box.bin}:${process.env.PATH ?? ""}` },
  });
}

const LOGROTATE_INSTALL = "apt-get install -y -qq logrotate";
const ENABLE = "systemctl enable --now logrotate.timer";
const SUMMARY = "logrotate: installed, daily timer enabled";

/** Index of the first logged call matching a substring, -1 when absent. */
function at(calls: string[], needle: string): number {
  return calls.findIndex((c) => c.includes(needle));
}

describe("step_apt_update installs Ubuntu's logrotate on the Jetson", () => {
  it("installs it on its own apt line when dpkg does not know it, and leaves the postinst's timer alone", () => {
    const box = makeBox({ installed: false });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    // The whole call: logrotate alone, so a mirror without it fails only this.
    const install = calls.indexOf(LOGROTATE_INSTALL);
    expect(install, `no separate logrotate install:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    // After the base line, never folded into it.
    const base = at(calls, "libreoffice-writer");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(calls[base]).not.toContain("logrotate");
    expect(install).toBeGreaterThan(base);
    // The package's postinst enabled and started the timer: nothing more to do.
    expect(at(calls, ENABLE)).toBe(-1);
    expect(r.stdout).toContain(SUMMARY);
  });

  it("goes on to the document libraries and the Node check when the mirror cannot serve it", () => {
    const box = makeBox({ installed: false, aptFailsLogrotate: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    const install = at(calls, LOGROTATE_INSTALL);
    expect(install, `logrotate was never asked for:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(at(calls, "python3-docx")).toBeGreaterThan(install);
    expect(at(calls, "node-check")).toBeGreaterThan(at(calls, "python3-docx"));
    expect(r.stderr.match(/logrotate not installed/g) ?? []).toHaveLength(1);
    // Nothing installed, so no timer work and no success line.
    expect(at(calls, ENABLE)).toBe(-1);
    expect(r.stdout).not.toContain(SUMMARY);
  });

  it("fails the step under errexit once the guard on that install is removed (the case above is real)", () => {
    const shipped = shellFunction("ensure_logrotate");
    expect(shipped, "ensure_logrotate in install.sh").not.toBeNull();
    const guarded = /(DEBIAN_FRONTEND=noninteractive apt-get install -y -qq logrotate) \|\| true\n/;
    expect(shipped).toMatch(guarded);
    const unguarded = shipped!.replace(guarded, "$1\n");
    const box = makeBox({ installed: false, aptFailsLogrotate: true });

    const r = run(box, { ensureLogrotate: unguarded });
    const calls = box.calls();

    expect(r.status).not.toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBeGreaterThanOrEqual(0);
    expect(at(calls, "python3-docx")).toBe(-1);
    expect(at(calls, "node-check")).toBe(-1);
  });

  it("takes a logrotate dpkg configured as installed although apt-get then exited 100", () => {
    // Another package's postinst failing in the same dpkg run is apt-get's 100
    // too; logrotate is configured and its postinst started the timer.
    const box = makeBox({ installed: false, aptFailsAfterInstall: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBeGreaterThanOrEqual(0);
    expect(r.stderr).not.toMatch(/logrotate not installed/);
    // apt-get's own error stays visible.
    expect(r.stderr).toContain("E: Sub-process /usr/bin/dpkg returned an error code (1)");
    expect(r.stdout).toContain(SUMMARY);
    expect(at(calls, "node-check")).toBeGreaterThan(at(calls, LOGROTATE_INSTALL));
  });

  it("never asks apt-get for a held logrotate, and claims nothing missing", () => {
    const box = makeBox({ installed: true, held: true, timer: "enabled", active: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBe(-1);
    expect(r.stderr).not.toMatch(/logrotate not installed/);
    expect(at(calls, ENABLE)).toBe(-1);
    expect(r.stdout).toContain(SUMMARY);
  });

  it("still enables the timer of a held logrotate", () => {
    const box = makeBox({ installed: true, held: true, timer: "disabled" });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBe(-1);
    expect(at(calls, ENABLE), `the timer was left disabled:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(r.stderr).not.toMatch(/logrotate not installed/);
    expect(r.stdout).toContain(SUMMARY);
  });

  it("believes dpkg, not apt-get's exit code, about whether the package is there", () => {
    const box = makeBox({ installed: false, aptInstallsNothing: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBeGreaterThanOrEqual(0);
    expect(r.stderr.match(/logrotate not installed/g) ?? []).toHaveLength(1);
    expect(at(calls, ENABLE)).toBe(-1);
    expect(r.stdout).not.toContain(SUMMARY);
    expect(at(calls, "node-check")).toBeGreaterThan(at(calls, LOGROTATE_INSTALL));
  });

  it("enables the timer on a box where it is installed but disabled", () => {
    const box = makeBox({ installed: true, timer: "disabled" });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBe(-1);
    expect(at(calls, ENABLE), `the timer was left disabled:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(r.stdout).toContain(SUMMARY);
  });

  it("starts a timer that is enabled but not running", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: false });

    const r = run(box);

    expect(r.status, r.stderr).toBe(0);
    expect(at(box.calls(), ENABLE)).toBeGreaterThanOrEqual(0);
    expect(r.stdout).toContain(SUMMARY);
  });

  it("does nothing on a box that already has the package and a running timer", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, LOGROTATE_INSTALL)).toBe(-1);
    expect(at(calls, ENABLE)).toBe(-1);
    expect(r.stdout).toContain(SUMMARY);
  });

  it.each([
    ["a masked timer", { timer: "masked" as Timer }],
    ["a timer systemd refuses to enable", { timer: "disabled" as Timer, enableRefused: true }],
    ["a timer that enables but will not start", { timer: "disabled" as Timer, startFails: true }],
  ])("warns and claims no timer on %s, and the step goes on", (_label, opts) => {
    const box = makeBox({ installed: true, ...opts });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(at(calls, ENABLE)).toBeGreaterThanOrEqual(0);
    expect(r.stderr.match(/Warning: logrotate\.timer could not be enabled and started/g) ?? []).toHaveLength(1);
    expect(r.stdout).not.toContain(SUMMARY);
    expect(at(calls, "node-check")).toBeGreaterThan(at(calls, ENABLE));
  });

  it("never adds logrotate to the base install line", () => {
    const step = shellFunction("step_apt_update") ?? "";
    const base = step.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("libreoffice-writer"));
    expect(base).toHaveLength(1);
    expect(base[0]).toMatch(/apt-get install -y -qq /);
    expect(base[0]).not.toContain("logrotate");
  });
});

/** The document-libraries lines of step_apt_update, as the box logs them. */
const docWarnings = (r: SpawnSyncReturns<string>) =>
  `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.includes("document libraries"));

describe("step_apt_update reads the document libraries back from dpkg", () => {
  it("claims nothing missing when apt-get exits 100 but dpkg has all three", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: true, docsAptFails: true });

    const r = run(box);
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(docWarnings(r)).toEqual([]);
    // apt-get's own error stays visible, and the step goes on to the Node check.
    expect(r.stderr).toContain("E: Sub-process /usr/bin/dpkg returned an error code (1)");
    expect(at(calls, "node-check")).toBeGreaterThan(at(calls, "python3-docx"));
  });

  it("names the one library dpkg does not have, though apt-get exited 0", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: true, docsMissing: ["python3-reportlab"] });

    const r = run(box);

    expect(r.status, r.stderr).toBe(0);
    expect(docWarnings(r)).toEqual(["  Warning: document libraries not installed: python3-reportlab"]);
    expect(r.stderr).toContain("  Warning: document libraries not installed: python3-reportlab\n");
    expect(at(box.calls(), "node-check")).toBeGreaterThan(at(box.calls(), "python3-docx"));
  });

  it("names every missing library on one line", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: true, docsAptFails: true, docsMissing: DOC_LIBS });

    const r = run(box);

    expect(r.status, r.stderr).toBe(0);
    expect(docWarnings(r)).toEqual([`  Warning: document libraries not installed: ${DOC_LIBS.join(" ")}`]);
  });

  it("prints nothing about them when apt-get exits 0 and dpkg has all three", () => {
    const box = makeBox({ installed: true, timer: "enabled", active: true });

    const r = run(box);

    expect(r.status, r.stderr).toBe(0);
    expect(docWarnings(r)).toEqual([]);
    for (const pkg of DOC_LIBS) expect(box.calls()).toContain(`dpkg-query -W -f=\${Status} ${pkg}`);
  });

  it("fails the step under errexit once the guard on that apt line is removed (the guard is real)", () => {
    const shipped = shellFunction("step_apt_update");
    expect(shipped, "step_apt_update in install.sh").not.toBeNull();
    const guarded =
      /(DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-docx python3-openpyxl python3-reportlab) \|\| true\n/;
    expect(shipped).toMatch(guarded);
    const box = makeBox({ installed: true, timer: "enabled", active: true, docsAptFails: true });

    const r = run(box, { step: shipped!.replace(guarded, "$1\n") });

    expect(r.status).not.toBe(0);
    expect(at(box.calls(), "python3-docx")).toBeGreaterThanOrEqual(0);
    expect(at(box.calls(), "node-check")).toBe(-1);
  });
});

/**
 * dpkg_installed, the one read-back the installer's apt lines use: true when
 * dpkg has the package installed whatever apt was asked to want, false for
 * every other status and when dpkg-query cannot answer.
 */
describe("dpkg_installed", () => {
  it.each([
    ["install ok installed", 0, true],
    ["hold ok installed", 0, true],
    ["deinstall ok installed", 0, true],
    ["deinstall ok config-files", 0, false],
    ["install ok half-configured", 0, false],
    ["install reinstreq installed", 0, false],
    ["unknown ok not-installed", 0, false],
    ["", 0, false],
    ["", 1, false],
  ])("reads %j (dpkg-query exit %i) as installed: %s", (status, rc, installed) => {
    const helper = shellFunction("dpkg_installed");
    expect(helper, "dpkg_installed in install.sh, as a multi-line function").not.toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), "clawbox-dpkg-installed-"));
    const args = path.join(dir, "args");
    const program = [
      "set -euo pipefail",
      `dpkg-query() { printf '%s\\n' "$*" > ${JSON.stringify(args)}; printf '%s' ${JSON.stringify(status)}; return ${rc}; }`,
      helper!,
      "if dpkg_installed fixture-pkg; then echo yes; else echo no; fi",
    ].join("\n");

    const r = spawnSync("bash", ["-c", program], { encoding: "utf-8", timeout: 20_000 });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(installed ? "yes" : "no");
    // The `${Status}` field (want, error flag, status), for the one package.
    expect(readFileSync(args, "utf-8")).toBe("-W -f=${Status} fixture-pkg\n");
  });
});
