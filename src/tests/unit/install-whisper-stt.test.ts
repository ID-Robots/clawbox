import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * faster-whisper was unreachable code on every shipped box.
 *
 * `install.sh:3179` is the only caller of install-voice.sh and always passes
 * `--tts-only`, whose arm exits above the STT steps — so "Whisper: Not
 * installed" was the permanent state of the fleet, with no route to fixing it
 * short of SSH.
 *
 * The stated reason was cost: "roughly an hour on an Orin". That number was
 * never measured. The build emits code for EVERY CUDA architecture unless it is
 * told which one the board has; pinned to sm_87 it took 255 s of `make -j4`
 * plus a 34 s clone on this Orin Nano (measured 2026-09-04, CTranslate2 4.8.2,
 * linking libcudnn.so.9 / libcublas.so.12, `cuobjdump` reporting sm_87 only).
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const VOICE_SH_PATH = path.join(REPO, "scripts/install-voice.sh");
const VOICE_SH = readFileSync(VOICE_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const start = VOICE_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install-voice.sh`);
  const end = VOICE_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return VOICE_SH.slice(start, end);
}
function shellCode(fn: string): string {
  return fn.split(NL).filter((l) => !l.trim().startsWith("#")).join(NL);
}

/**
 * The body of the --tts-only arm.
 *
 * Anchored, and loudly: `slice(VOICE_SH.indexOf(...))` on a missed anchor is
 * `slice(-1)` — the last CHARACTER of the file, not an empty string — so the
 * exit-contract test below would iterate nothing and pass having inspected no
 * code at all.
 */
function ttsOnlyArm(): string {
  const at = VOICE_SH.indexOf('if [ "${1:-}" = "--tts-only" ]; then');
  if (at < 0) throw new Error("the --tts-only arm was not found in install-voice.sh");
  return VOICE_SH.slice(at);
}

describe("the STT half is reachable from the path every box runs", () => {
  it("--tts-only installs it, after Kokoro", () => {
    const arm = ttsOnlyArm();
    const kokoro = arm.indexOf("install_kokoro_tts");
    const stt = arm.indexOf("install_whisper_stt");
    expect(stt).toBeGreaterThan(-1);
    // After Kokoro so a failed pip or a lost network can never cost the box
    // its voice — the hazard that kept STT out of the shipped path.
    expect(kokoro).toBeLessThan(stt);
  });

  it("and before the case that exits, so a mute box still gets its ears", () => {
    const arm = ttsOnlyArm();
    expect(arm.indexOf("install_whisper_stt")).toBeLessThan(arm.indexOf('case "$TTS_KOKORO_VERDICT" in'));
  });

  it("does not touch the arm's exit contract, which is Kokoro's", () => {
    // install.sh grades step_openclaw_tts by these codes; STT must not move them.
    const arm = ttsOnlyArm();
    const end = arm.indexOf(`${NL}fi`);
    for (const line of arm.slice(0, end).split(NL).filter((l) => l.trim().startsWith("exit "))) {
      expect(line, `exit must not carry the STT code: ${line}`).not.toContain("STT_RC");
    }
  });

  it("no longer claims the hour it never measured", () => {
    const stale = VOICE_SH.split(NL).filter(
      (l) => /roughly an hour|about an hour/.test(l) && !/never measured|used to/.test(l),
    );
    expect(stale, `stale cost claims: ${stale.join(" | ")}`).toEqual([]);
  });
});

describe("the build is pinned to the board's own architecture", () => {
  const BUILD = shellCode(extractShellFunction("build_ctranslate2_cuda"));

  it("passes CMAKE_CUDA_ARCHITECTURES", () => {
    // The entire five-minutes-vs-an-hour difference.
    expect(BUILD).toContain("CMAKE_CUDA_ARCHITECTURES");
  });

  it("does not fan out to every core", () => {
    // Six parallel nvcc jobs on a 7.4 GB board is how this gets OOM-killed.
    expect(BUILD).toContain("make -j4");
    expect(BUILD).not.toContain("make -j$(nproc)");
  });

  it("maps the boards ClawBox actually ships on", () => {
    const PIN = extractShellFunction("cuda_arch_pin");
    expect(PIN).toContain("tegra234");  // Orin
    expect(PIN).toContain("87");
    expect(PIN).toContain("tegra194");  // Xavier
    expect(PIN).toContain("72");
  });
});

describe("one writer for whisper-server.service", () => {
  it("the heredoc exists exactly once", () => {
    const heredocs = VOICE_SH.split("Description=Whisper STT Server").length - 1;
    expect(heredocs).toBe(1);
  });

  it("and it points at the workspace copy, which every path deploys", () => {
    // $SCRIPTS_DST is assigned only on the full-pipeline path; a unit written
    // from --tts-only with that path would name a file that does not exist.
    const UNIT = extractShellFunction("write_whisper_unit");
    expect(UNIT).toContain("$WORKSPACE/scripts/whisper-server.py");
    expect(UNIT).not.toContain("$SCRIPTS_DST");
  });
});

/**
 * The ordering rule is the one thing a regex cannot settle, and it is the one
 * that matters: src/lib/local-models.ts derives `installed` from the unit
 * FILE's presence alone, while src/lib/stt-local.ts demands a real import. A
 * unit written ahead of a failed install makes those two disagree, and Settings
 * advertises an engine the box does not have.
 */
describe("install_whisper_stt — behaviour, driven against stubs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
    fs.mkdirSync(path.join(tmp, "systemd"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "cache"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const unitPath = () => path.join(tmp, "systemd", "whisper-server.service");
  const stampPath = () => path.join(tmp, "cache", "whisper-installed");

  function run({
    cuda = true, pipOk = true, importOk = true, buildOk = true,
    skip = false, stamped = false, unitWritable = true,
  } = {}) {
    if (stamped) fs.writeFileSync(stampPath(), "1\n");
    // A regular FILE where the unit directory should be: `mkdir -p` cannot
    // create it, which is the cheapest honest way to fail write_whisper_unit.
    const systemdDir = unitWritable ? path.join(tmp, "systemd") : path.join(tmp, "blocked", "systemd");
    if (!unitWritable) fs.writeFileSync(path.join(tmp, "blocked"), "not a directory");
    const log = path.join(tmp, "calls.log");
    fs.writeFileSync(log, "");
    const script = [
      "set -euo pipefail",
      `CLAWBOX_HOME="${tmp}"`,
      `CLAWBOX_USER="$(id -un)"`,
      `SYSTEMD_USER="${systemdDir}"`,
      `WORKSPACE="${tmp}/workspace"`,
      `WHISPER_STAMP="${stampPath()}"`,
      'WHISPER_STAMP_VERSION="1"',
      `export CLAWBOX_SKIP_STT="${skip ? "1" : "0"}"`,
      // Stub every collaborator, so this test is about ORDER and OUTCOME only.
      `LOG="${log}"`,
      'note() { printf "%s\\n" "$1" >> "$LOG"; }',
      `detect_cuda() { note detect_cuda; ${cuda ? "return 0" : "return 1"}; }`,
      `pip_as_clawbox() { note "pip $1"; ${pipOk ? "return 0" : "return 1"}; }`,
      `clawbox_python() { note "py"; ${importOk ? "return 0" : "return 1"}; }`,
      'ctranslate2_cuda_present() { return 1; }',
      `build_ctranslate2_cuda() { note build; ${buildOk ? "return 0" : "return 1"}; }`,
      'whisper_predownload_model() { note predownload; return 0; }',
      'kokoro_ld_path() { printf "/x/lib"; }',
      'activate_user_units() { note activate; }',
      `sed -n '/^whisper_stack_present() {/,/^}/p' "$1" > "${tmp}/f.sh"`,
      `sed -n '/^whisper_mark_installed() {/,/^}/p' "$1" >> "${tmp}/f.sh"`,
      `sed -n '/^write_whisper_unit() {/,/^}/p' "$1" >> "${tmp}/f.sh"`,
      `sed -n '/^install_whisper_stt() {/,/^}/p' "$1" >> "${tmp}/f.sh"`,
      `. "${tmp}/f.sh"`,
      // `|| rc=$?`, exactly as the --tts-only arm calls it: bare under
      // errexit a non-zero return would abort before RC could be printed.
      // 2>&1 because the warnings that matter here (a failed CUDA build, a
      // failed pip) are on stderr, which execFileSync does not return on success.
      "rc=0; install_whisper_stt 2>&1 || rc=$?; echo RC=$rc",
    ].join(NL);
    let out: string; let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", VOICE_SH_PATH], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return {
      out, code,
      unitWritten: fs.existsSync(unitPath()),
      stamped: fs.existsSync(stampPath()),
      calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean),
    };
  }

  it("installs, then writes the unit, on a healthy board", () => {
    const r = run();
    expect(r.out).toContain("RC=0");
    expect(r.unitWritten).toBe(true);
    expect(r.stamped).toBe(true);
  });

  it("writes NO unit when the wheels fail", () => {
    // The trap: a unit here makes Settings → Local AI report an engine that
    // cannot import, while stt-local.ts correctly reports none.
    const r = run({ pipOk: false });
    expect(r.out).toContain("RC=12");
    expect(r.unitWritten).toBe(false);
    expect(r.stamped).toBe(false);
  });

  it("writes NO unit when the install cannot import afterwards", () => {
    const r = run({ importOk: false });
    expect(r.out).toContain("RC=12");
    expect(r.unitWritten).toBe(false);
  });

  it("survives a failed CUDA build — the CPU wheel still transcribes", () => {
    const r = run({ buildOk: false });
    expect(r.out).toContain("RC=0");
    expect(r.unitWritten).toBe(true);
    expect(r.out).toMatch(/transcribe on the CPU/);
  });

  it("skips a board with no CUDA rather than failing it", () => {
    const r = run({ cuda: false });
    expect(r.out).toContain("RC=13");
    expect(r.calls).not.toContain("build");
  });

  it("honours CLAWBOX_SKIP_STT for the e2e container", () => {
    const r = run({ skip: true });
    expect(r.out).toContain("RC=13");
    expect(r.calls.some((c) => c.startsWith("pip"))).toBe(false);
  });

  it("does not stamp or report ready when the unit cannot be written", () => {
    // errexit is OFF inside this function — it is called with `|| STT_RC=$?` —
    // so an ignored mkdir failure would let it stamp the install and announce a
    // ready engine whose unit file does not exist. A stamped box skips the work
    // on every later update, which would make that permanent. Reported by
    // CodeRabbit on #648.
    const r = run({ unitWritable: false });
    expect(r.out).toContain("RC=12");
    expect(r.stamped, "a failed install must not be stamped").toBe(false);
    expect(r.out).toMatch(/could not write whisper-server\.service/);
    // …and says nothing about readiness: a regression that printed this before
    // returning 12 would otherwise satisfy every assertion above.
    expect(r.out).not.toContain("faster-whisper ready");
  });

  it("is stamp-gated: an installed box pays one import check, not a build", () => {
    const r = run({ stamped: true });
    expect(r.out).toContain("RC=0");
    expect(r.calls.some((c) => c.startsWith("pip"))).toBe(false);
    expect(r.calls).not.toContain("build");
    // …and still rewrites the unit, so a reset that wiped it is repaired.
    expect(r.unitWritten).toBe(true);
  });
});
