import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The legacy `clawbox-whisper.service` (TASK-1214, the report's "Half 2").
 *
 * A box in the field ran a SYSTEM unit that no ClawBox release ever wrote:
 *
 *   ExecStart=/usr/bin/python3 /home/clawbox/clawbox/scripts/openclaw/whisper-server-gpu.py
 *
 * That file has never existed (the tree ships scripts/openclaw/whisper-server.py),
 * so the unit restarted every 10 s, 31,681 times by 2026-09-25. The product's
 * own unit is the clawbox user's `whisper-server.service`. The box had none,
 * so Settings → Local AI and the chat microphone's fallback reported on-box
 * speech as not installed, while faster-whisper itself imported and
 * transcribed. install-voice.sh now retires the stray unit in every mode. On
 * the update (`--scripts-only`) it gives the engine the stray unit was pointed
 * at a whisper-server.service, written only after the import is verified. The
 * Local AI tab's Install (`--whisper`) heals the same box.
 */

// Starts a real bash per case: vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const SPAWN_TIMEOUT_MS = 20_000;

const REPO = process.cwd();
const VOICE_SH_PATH = path.join(REPO, "scripts/install-voice.sh");
const VOICE_SH = readFileSync(VOICE_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);
const UNIT = "clawbox-whisper.service";

/** The unit from the customer's box, as `systemctl cat` would show it. */
const LEGACY_UNIT = [
  "[Unit]",
  "Description=ClawBox Whisper STT (GPU)",
  "After=network.target",
  "",
  "[Service]",
  "Type=simple",
  "User=clawbox",
  "ExecStart=/usr/bin/python3 /home/clawbox/clawbox/scripts/openclaw/whisper-server-gpu.py",
  "Restart=always",
  "RestartSec=10",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join(NL);

function unitRunning(execStart: string): string {
  return ["[Service]", `ExecStart=${execStart}`, "Restart=always", "", "[Install]", "WantedBy=multi-user.target", ""].join(NL);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-legacy-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sysDir = () => path.join(tmp, "etc-systemd-system");
const home = () => path.join(tmp, "home", "clawbox");
const userDir = () => path.join(home(), ".config", "systemd", "user");
const workspace = () => path.join(home(), ".openclaw", "workspace");
const whisperUnit = () => path.join(userDir(), "whisper-server.service");
const stampPath = () => path.join(home(), ".cache", "clawbox", "whisper-installed");

/** A unit file plus the link `systemctl enable` would have made for it. */
function placeUnit(dir: string, body: string, wantedBy = "multi-user.target") {
  fs.mkdirSync(path.join(dir, `${wantedBy}.wants`), { recursive: true });
  fs.writeFileSync(path.join(dir, UNIT), body);
  fs.symlinkSync(path.join(dir, UNIT), path.join(dir, `${wantedBy}.wants`, UNIT));
}

interface Run {
  out: string;
  done: boolean;
  calls: string[];
}

/**
 * The retire and the update's refresh, sourced out of the SHIPPED file and run
 * under the script's own `set -euo pipefail`, bare, exactly as the mode
 * dispatch calls them. `systemctl` and `su` are stubbed and log what they are
 * asked. `SYS_FRAGMENT` / `USER_FRAGMENT` are what systemd would answer for
 * FragmentPath. The import and the weights check are stubbed too, so each case
 * is about the unit files and the order of the calls only.
 */
function update({
  importOk = true,
  weights = false,
  stamped = false,
  sysFragment = "",
  userFragment = "",
  entry = "retire_legacy_whisper_unit; whisper_refresh_present",
} = {}): Run {
  fs.mkdirSync(sysDir(), { recursive: true });
  fs.mkdirSync(path.join(home(), ".cache", "clawbox"), { recursive: true });
  if (stamped) fs.writeFileSync(stampPath(), "1\n");
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(log, "");
  const fns = [
    "legacy_whisper_unit_stale",
    "retire_legacy_whisper_scope",
    "retire_legacy_whisper_unit",
    "whisper_adopt_legacy_engine",
    "whisper_refresh_present",
    "whisper_stack_present",
    "whisper_mark_installed",
    "write_whisper_unit",
  ];
  const program = [
    "set -euo pipefail",
    `CLAWBOX_USER="clawbox"`,
    `CLAWBOX_HOME="${home()}"`,
    `SYSTEMD_USER="${userDir()}"`,
    `WORKSPACE="${workspace()}"`,
    `WHISPER_STAMP="${stampPath()}"`,
    'WHISPER_STAMP_VERSION="1"',
    `LOG="${log}"`,
    `SYS_FRAGMENT="${sysFragment}"`,
    `USER_FRAGMENT="${userFragment}"`,
    'note() { printf "%s\\n" "$*" >> "$LOG"; }',
    "systemctl() {",
    '  note "systemctl $*"',
    '  case "$*" in *"show --property=FragmentPath"*) printf "%s\\n" "$SYS_FRAGMENT" ;; esac',
    "  return 0",
    "}",
    // `su - clawbox -c "<lines>"`: log each `systemctl --user` line it carries.
    "su() {",
    '  local cmd="" l',
    '  while [ $# -gt 0 ]; do case "$1" in -c) cmd="$2"; shift 2 ;; *) shift ;; esac; done',
    '  while IFS= read -r l; do l="${l#"${l%%[![:space:]]*}"}"; case "$l" in "systemctl --user"*) note "su $l" ;; esac; done <<< "$cmd"',
    '  case "$cmd" in *FragmentPath*) printf "%s\\n" "$USER_FRAGMENT" ;; esac',
    "  return 0",
    "}",
    `clawbox_python() { note "py $1"; ${importOk ? "return 0" : "return 1"}; }`,
    `whisper_model_cached() { ${weights ? "return 0" : "return 1"}; }`,
    'kokoro_ld_path() { printf "/x/lib"; }',
    "activate_user_units() { note activate; }",
    // The shipped constants, then the shipped functions.
    `sed -n '/^LEGACY_WHISPER_UNIT=/p;/^LEGACY_WHISPER_RETIRED=/p' "$1" > "${tmp}/f.sh"`,
    ...fns.map((fn) => `sed -n '/^${fn}() {/,/^}/p' "$1" >> "${tmp}/f.sh"`),
    `. "${tmp}/f.sh"`,
    `SYSTEMD_SYSTEM_DIR="${sysDir()}"`,
    `${entry} 2>&1`,
    "echo DONE",
  ].join(NL);
  const file = path.join(tmp, "prog.sh");
  fs.writeFileSync(file, program);
  const r = spawnSync("bash", [file, VOICE_SH_PATH], { encoding: "utf-8", timeout: SPAWN_TIMEOUT_MS });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    out,
    done: out.includes("DONE"),
    calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean),
  };
}

const mutations = (calls: string[]) =>
  calls.filter((c) => /systemctl (--user )?(stop|disable|reset-failed|daemon-reload)/.test(c));

describe("the shipped functions exist where this test reads them", () => {
  it.each([
    "legacy_whisper_unit_stale",
    "retire_legacy_whisper_scope",
    "retire_legacy_whisper_unit",
    "whisper_adopt_legacy_engine",
  ])("%s", (fn) => {
    // A missed sed range sources nothing, and every case below would then fail
    // for a reason that is not the one it names.
    expect(VOICE_SH).toMatch(new RegExp(`^${fn}\\(\\) \\{$`, "m"));
  });
});

describe("retire_legacy_whisper_unit — the unit the report found", () => {
  it("stops, disables, resets, deletes and reloads the customer's system unit, in that order", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update();
    expect(r.done, r.out).toBe(true);

    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.existsSync(path.join(sysDir(), "multi-user.target.wants", UNIT))).toBe(false);
    const order = mutations(r.calls);
    expect(order).toEqual([
      `systemctl stop ${UNIT}`,
      `systemctl disable ${UNIT}`,
      `systemctl reset-failed ${UNIT}`,
      "systemctl daemon-reload",
    ]);
    // Recognised by its script's name, not only because that path is missing
    // on this machine: the missing-path reason would name the same file.
    expect(r.out).toContain(
      `Retired the legacy ${UNIT} (system scope): it runs whisper-server-gpu.py, which no ClawBox release has shipped`,
    );
  });

  it("takes its drop-ins with it", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    fs.mkdirSync(path.join(sysDir(), `${UNIT}.d`));
    fs.writeFileSync(path.join(sysDir(), `${UNIT}.d`, "override.conf"), "[Service]\nRestartSec=10\n");
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), `${UNIT}.d`))).toBe(false);
  });

  it("retires a user-scope copy through the clawbox user's manager", () => {
    placeUnit(userDir(), LEGACY_UNIT, "default.target");
    const r = update();
    expect(r.done, r.out).toBe(true);

    expect(fs.existsSync(path.join(userDir(), UNIT))).toBe(false);
    expect(fs.existsSync(path.join(userDir(), "default.target.wants", UNIT))).toBe(false);
    expect(mutations(r.calls)).toEqual([
      `su systemctl --user stop ${UNIT}`,
      `su systemctl --user disable ${UNIT}`,
      `su systemctl --user reset-failed ${UNIT}`,
      "su systemctl --user daemon-reload",
    ]);
    expect(r.out).toContain(`Retired the legacy ${UNIT} (user scope)`);
  });

  it("retires both when both scopes have one", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    placeUnit(userDir(), LEGACY_UNIT, "default.target");
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.existsSync(path.join(userDir(), UNIT))).toBe(false);
    expect(r.out).toContain("(system scope)");
    expect(r.out).toContain("(user scope)");
  });

  it("finds the file wherever systemd says it loaded it from", () => {
    // Hand-written units are not always in /etc. FragmentPath is systemd's
    // own answer.
    const lib = path.join(tmp, "lib-systemd-system");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, UNIT), LEGACY_UNIT);
    const r = update({ sysFragment: path.join(lib, UNIT) });
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(lib, UNIT))).toBe(false);
    expect(mutations(r.calls)).toContain(`systemctl stop ${UNIT}`);
  });

  it("stops a unit systemd still holds after its file was deleted without a reload", () => {
    const r = update({ sysFragment: path.join(tmp, "gone", UNIT) });
    expect(r.done, r.out).toBe(true);
    expect(mutations(r.calls)).toEqual([
      `systemctl stop ${UNIT}`,
      `systemctl disable ${UNIT}`,
      `systemctl reset-failed ${UNIT}`,
      "systemctl daemon-reload",
    ]);
    expect(r.out).toContain("is gone");
  });

  it("retires a clawbox-whisper.service whose ExecStart names any file that is not there", () => {
    const missing = path.join(tmp, "opt", "whisper", "serve.py");
    placeUnit(sysDir(), unitRunning(`/bin/sh ${missing}`));
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(r.out).toContain(`its ExecStart names ${missing}, which is not on this box`);
  });

  it("retires the whisper-server-gpu.py unit even on a box where someone created that file", () => {
    const gpu = path.join(tmp, "whisper-server-gpu.py");
    fs.writeFileSync(gpu, "");
    placeUnit(sysDir(), unitRunning(`/bin/sh ${gpu}`));
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
  });

  it("recognises whisper-server-gpu.py in a drop-in as well as in the unit", () => {
    const real = path.join(tmp, "srv", "run.sh");
    const gpu = path.join(tmp, "whisper-server-gpu.py");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "");
    fs.writeFileSync(gpu, "");
    placeUnit(sysDir(), unitRunning(`/bin/sh ${real}`));
    fs.mkdirSync(path.join(sysDir(), `${UNIT}.d`));
    fs.writeFileSync(path.join(sysDir(), `${UNIT}.d`, "gpu.conf"), `[Service]\nExecStart=\nExecStart=/bin/sh ${gpu}\n`);
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.existsSync(path.join(sysDir(), `${UNIT}.d`))).toBe(false);
    expect(r.out).toContain("which no ClawBox release has shipped");
  });
});

describe("retire_legacy_whisper_unit — what it leaves alone", () => {
  it("does nothing on a box that never had it: it only asks", () => {
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
    expect(r.out).not.toContain("Retired");
  });

  it("is idempotent: a second run finds nothing to do", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    placeUnit(userDir(), LEGACY_UNIT, "default.target");
    expect(update().done).toBe(true);
    const again = update();
    expect(again.done, again.out).toBe(true);
    expect(mutations(again.calls)).toEqual([]);
    expect(again.out).not.toContain("Retired");
  });

  it("keeps a clawbox-whisper.service that starts something real, and says so", () => {
    const script = path.join(tmp, "srv", "run.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    placeUnit(sysDir(), unitRunning(`/bin/sh ${script}`));
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
    expect(r.out).toContain("left in place");
    // It retired nothing, so nothing is adopted either.
    expect(fs.existsSync(whisperUnit())).toBe(false);
  });

  it("reads ExecStart as systemd does: an empty ExecStart= in a drop-in clears the old one", () => {
    const script = path.join(tmp, "srv", "run.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    placeUnit(sysDir(), unitRunning(`/bin/sh ${path.join(tmp, "not-there.sh")}`));
    fs.mkdirSync(path.join(sysDir(), `${UNIT}.d`));
    fs.writeFileSync(path.join(sysDir(), `${UNIT}.d`, "fix.conf"), `[Service]\nExecStart=\nExecStart=/bin/sh ${script}\n`);
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
  });

  it("does not count a path it cannot resolve (a systemd specifier) as missing", () => {
    placeUnit(sysDir(), unitRunning("/bin/sh %h/whisper/run.sh"));
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
  });

  it("leaves a unit masked to /dev/null as it is: a mask cannot start anything", () => {
    fs.mkdirSync(sysDir(), { recursive: true });
    fs.symlinkSync("/dev/null", path.join(sysDir(), UNIT));
    const r = update();
    expect(r.done, r.out).toBe(true);
    expect(fs.lstatSync(path.join(sysDir(), UNIT)).isSymbolicLink()).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
  });

  it("ignores whatever a login shell prints instead of a FragmentPath", () => {
    const r = update({ userFragment: "Welcome to Ubuntu 22.04.5 LTS" });
    expect(r.done, r.out).toBe(true);
    expect(mutations(r.calls)).toEqual([]);
  });
});

/**
 * The update's half of the heal. The unit is written LAST, after the import is
 * verified (install_whisper_stt's rule, because src/lib/local-models.ts reads
 * `installed` off the unit file alone). It is written only on the run that
 * retired a legacy unit, because Uninstall keeps faster-whisper's wheels.
 */
describe("the update gives the engine the unit it lacked", () => {
  it("writes whisper-server.service for the faster-whisper the legacy unit was pointed at", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update();
    expect(r.done, r.out).toBe(true);

    expect(fs.existsSync(whisperUnit())).toBe(true);
    const unit = fs.readFileSync(whisperUnit(), "utf8");
    expect(unit).toContain(`ExecStart=/usr/bin/python3 ${workspace()}/scripts/whisper-server.py`);
    expect(unit).toContain("Restart=no");
    // Import checked, then the unit, then the user manager told about it.
    const py = r.calls.findIndex((c) => c === "py import faster_whisper");
    const activate = r.calls.indexOf("activate");
    expect(py).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(py);
    expect(r.out).toContain("whisper-server.service now runs the faster-whisper");
  });

  it("does not stamp an install whose weights are not on the box", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update({ weights: false });
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(whisperUnit())).toBe(true);
    expect(fs.existsSync(stampPath()), "a box without its weights was latched in as installed").toBe(false);
    expect(r.out).toContain("weights are not on this box yet");
  });

  it("stamps it when the weights are whole, so later updates keep the unit fresh", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update({ weights: true });
    expect(r.done, r.out).toBe(true);
    expect(fs.readFileSync(stampPath(), "utf8")).toBe("1\n");
  });

  it("writes NO unit when faster-whisper does not import, and says where to install it", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update({ importOk: false });
    expect(r.done, r.out).toBe(true);
    // The legacy unit still goes; nothing is advertised in its place.
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.existsSync(whisperUnit())).toBe(false);
    expect(fs.existsSync(stampPath())).toBe(false);
    expect(r.out).toContain("Settings → Local AI");
  });

  it("does not bring back an engine the owner uninstalled", () => {
    // Uninstall removes the unit, the stamp and the weights, and leaves the
    // wheels importable. No legacy unit means no evidence, so no unit.
    const r = update({ importOk: true });
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(whisperUnit())).toBe(false);
    expect(r.calls.some((c) => c.startsWith("py "))).toBe(false);
  });

  it("leaves a stamped box to the refresh it always had", () => {
    placeUnit(sysDir(), LEGACY_UNIT);
    const r = update({ stamped: true });
    expect(r.done, r.out).toBe(true);
    expect(fs.existsSync(whisperUnit())).toBe(true);
    // One import (whisper_stack_present's), not a second one from the adoption.
    expect(r.calls.filter((c) => c === "py import faster_whisper")).toHaveLength(1);
    expect(r.out).not.toContain("now runs the faster-whisper");
  });
});

describe("every mode retires it", () => {
  function dispatchArm(): string {
    const at = VOICE_SH.indexOf('if [ "$VOICE_MODE" != "full" ]; then');
    const end = VOICE_SH.indexOf('echo "=== Voice Pipeline Installer (GPU-Accelerated) ==="');
    if (at < 0 || end < at) throw new Error("the mode dispatch moved");
    return VOICE_SH.slice(at, end);
  }
  const code = (s: string) => s.split(NL).filter((l) => !l.trim().startsWith("#")).join(NL);

  it("the dispatch runs it bare, outside any mode's arm, before the Whisper engine is looked at", () => {
    const arm = code(dispatchArm());
    expect(arm).toMatch(/^ {2}retire_legacy_whisper_unit$/m);
    const retire = arm.indexOf("retire_legacy_whisper_unit");
    expect(retire).toBeLessThan(arm.indexOf("install_whisper_stt"));
    expect(retire).toBeLessThan(arm.indexOf("*) whisper_refresh_present ;;"));
  });

  it("the full pipeline run by hand retires it before writing whisper-server.service", () => {
    const full = code(VOICE_SH.slice(VOICE_SH.indexOf('echo "=== Voice Pipeline Installer (GPU-Accelerated) ==="')));
    const retire = full.indexOf("retire_legacy_whisper_unit");
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(full.indexOf("write_whisper_unit"));
  });

  it("the retire cannot abort an update: both scopes run under || true", () => {
    const fn = code(VOICE_SH.slice(VOICE_SH.indexOf("retire_legacy_whisper_unit() {")));
    const body = fn.slice(0, fn.indexOf(`${NL}}`));
    expect(body).toMatch(/retire_legacy_whisper_scope system \|\| true/);
    expect(body).toMatch(/retire_legacy_whisper_scope user \|\| true/);
    expect(body).toMatch(/return 0/);
  });
});

/**
 * The REAL install-voice.sh, end to end, over a box shaped like the customer's:
 * the legacy system unit enabled in multi-user.target, faster-whisper importable
 * for the clawbox user, no stamp, no whisper-server.service. `su`, `systemctl`,
 * `chown`, `loginctl` and `nvcc` are stubs on PATH, and nothing can reach the
 * network.
 */
describe("install-voice.sh end to end", () => {
  function writeExec(file: string, body: string) {
    fs.writeFileSync(file, `#!/bin/bash${NL}${body}${NL}`);
    fs.chmodSync(file, 0o755);
  }

  function runVoice(args: string[], { legacy = true, cuda = false } = {}) {
    const bin = path.join(tmp, "bin");
    const calls = path.join(tmp, "e2e-calls.log");
    const cudaHome = path.join(tmp, cuda ? "cuda" : "no-such-cuda");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home(), { recursive: true });
    fs.mkdirSync(sysDir(), { recursive: true });
    if (!fs.existsSync(calls)) fs.writeFileSync(calls, "");
    if (legacy && !fs.existsSync(path.join(sysDir(), UNIT))) placeUnit(sysDir(), LEGACY_UNIT);
    if (cuda) {
      fs.mkdirSync(path.join(cudaHome, "lib64"), { recursive: true });
      // The CUDA CTranslate2 is already built, so --whisper does not try to.
      fs.mkdirSync(path.join(home(), ".local", "lib"), { recursive: true });
      fs.writeFileSync(path.join(home(), ".local", "lib", "libctranslate2.so"), "");
      writeExec(path.join(bin, "nvcc"), 'echo "Cuda compilation tools, release 12.6, V12.6.68"');
    }
    writeExec(
      path.join(bin, "su"),
      [
        'cmd=""',
        'while [ $# -gt 0 ]; do case "$1" in -c) cmd="$2"; shift 2;; *) shift;; esac; done',
        'stdin_code=""',
        'case "$cmd" in *"python3 -") stdin_code="$(cat)" ;; esac',
        `printf 'su %s\\n' "$(printf '%s %s' "$cmd" "$stdin_code" | tr -s '[:space:]' ' ')" >> ${JSON.stringify(calls)}`,
        'case "$cmd $stdin_code" in',
        '  *"sys.version_info"*) echo "python3.10"; exit 0 ;;',
        '  *"import faster_whisper"*) exit "${IMPORT_EXIT:-0}" ;;',
        "esac",
        "exit 0",
      ].join(NL),
    );
    writeExec(path.join(bin, "systemctl"), `printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}; exit 0`);
    writeExec(path.join(bin, "chown"), "exit 0");
    writeExec(path.join(bin, "loginctl"), "exit 0");
    writeExec(path.join(bin, "curl"), "exit 1");
    writeExec(path.join(bin, "wget"), "exit 1");
    const r = spawnSync("bash", [VOICE_SH_PATH, ...args], {
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home(),
        CLAWBOX_USER: "clawbox",
        CLAWBOX_HOME: home(),
        CLAWBOX_CUDA_HOME: cudaHome,
        CLAWBOX_TTS_STATUS_FILE: path.join(tmp, "tts-status"),
        CLAWBOX_SYSTEMD_SYSTEM_DIR: sysDir(),
        // Only the stubs are reachable; see install-tts-no-engine.test.ts.
      } as unknown as NodeJS.ProcessEnv,
    });
    const log = fs.readFileSync(calls, "utf8").split(NL).filter(Boolean);
    fs.writeFileSync(calls, "");
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: log };
  }

  it("--scripts-only (every update) retires the loop and leaves on-box speech installed", () => {
    const r = runVoice(["--scripts-only"]);
    expect(r.status, r.out).toBe(0);

    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.existsSync(path.join(sysDir(), "multi-user.target.wants", UNIT))).toBe(false);
    expect(r.calls).toContain(`systemctl stop ${UNIT}`);
    expect(r.calls).toContain("systemctl daemon-reload");

    // What src/lib/stt-local.ts's localSttInstalled() stats before it imports:
    // the workspace's stt-client.py and the user unit.
    expect(fs.existsSync(path.join(workspace(), "scripts", "stt-client.py"))).toBe(true);
    expect(fs.existsSync(path.join(workspace(), "scripts", "whisper-server.py"))).toBe(true);
    expect(fs.readFileSync(whisperUnit(), "utf8")).toContain(
      `ExecStart=/usr/bin/python3 ${workspace()}/scripts/whisper-server.py`,
    );

    // …and the next update has nothing left to retire.
    const again = runVoice(["--scripts-only"], { legacy: false });
    expect(again.status, again.out).toBe(0);
    expect(again.calls.filter((c) => c.includes(`stop ${UNIT}`))).toEqual([]);
    expect(again.out).not.toContain("Retired");
  });

  it("--scripts-only on a box that never had it changes nothing about Whisper", () => {
    const r = runVoice(["--scripts-only"], { legacy: false });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter((c) => /systemctl (stop|disable|reset-failed|daemon-reload)/.test(c))).toEqual([]);
    expect(fs.existsSync(whisperUnit())).toBe(false);
  });

  it("--whisper (Settings → Local AI → Install) heals the same box", () => {
    const r = runVoice(["--whisper"], { cuda: true });
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(path.join(sysDir(), UNIT))).toBe(false);
    expect(fs.readFileSync(whisperUnit(), "utf8")).toContain(`${workspace()}/scripts/whisper-server.py`);
    expect(fs.readFileSync(stampPath(), "utf8")).toBe("1\n");
    expect(r.out).toContain("On-device speech-to-text ready");
  });
});
