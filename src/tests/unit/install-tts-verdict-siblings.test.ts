import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The SIBLINGS of the TTS-01 fix (#519), on the one-engine box.
 *
 * #519 taught ONE caller to stop reporting success from a return code and
 * read the published verdict instead. Every other caller was left as it was,
 * which is the shape this suite exists to catch — a bug fixed in one of
 * several identical paths. With Kokoro the ONLY on-device engine (the CPU
 * fallback is gone: no second verdict key, no `--piper-only`, no "both
 * halves") the surviving siblings are:
 *
 *   1. `install-voice.sh --tts-only`, the mode every TTS failure message tells
 *      an operator to run. install_kokoro_tts returns non-zero for "this
 *      board declines the engine" — a clean decline, not an engine — and the
 *      dispatch has to read the VERDICT, not the return code, to say what
 *      the box can do. A skipped Kokoro is a box with no on-device voice:
 *      exit 13, the engine and its concrete reason printed. The two-engine
 *      release exited 10/11 there because a CPU engine still spoke; nothing
 *      speaks behind a skipped Kokoro now, so 10 and 11 are not emitted.
 *   2. The full-pipeline path, the other caller, asserted an engine in its
 *      summary on every run whatever the verdict said — and then fell off
 *      its last `echo` with exit 0.
 *   3. install.sh's step_openclaw_tts used to bucket a "no engine" exit with
 *      the codes that carried a working fallback, and to grade a board skip
 *      clean; the installer cannot know whether a cloud voice will ever be
 *      linked, so a mute box is RECORDED (13, non-fatal), never graded clean.
 *   4. step_validate_services' probe used to fall out of its chain as a PASS
 *      on any verdict it had no arm for, so a value outside the `ready` /
 *      `skipped:<reason>` / `failed:<reason>` vocabulary (a torn write, a
 *      CRLF-terminated `ready`) scored better than an absent one. It now
 *      decides "unreadable" FIRST and only then names an engine state.
 *   5. step_post_update, the second caller of step_openclaw_tts, laundered
 *      12/13/14 into one generic `|| echo "(non-fatal)"` — and `--step`
 *      dispatch then ran `exit 0`, throwing away the record_provision_failure
 *      #519 added, so an in-app UPDATE that left the box mute finished as a
 *      successful update.
 *
 * These tests EXECUTE the shipped artifacts against stubs, like the #519 suite
 * they sit next to. A rewrite that keeps the prose but drops the verdict fails
 * them.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE = path.join(REPO, "scripts", "install-voice.sh");
const INSTALL_VOICE_SH = readFileSync(INSTALL_VOICE, "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * The stub PATH is the stub dir plus the POSIX system dirs, so the script under
 * test cannot reach the real curl, wget or nvcc. On Windows that also makes
 * `bash` itself unfindable, so the host PATH is appended there for the lookup
 * only — the stub dir still comes first. Empty on Linux/CI. (Same note as the
 * #519 suite; the reason has not changed.)
 */
const HOST_PATH_SUFFIX = process.platform === "win32" ? `${path.delimiter}${process.env.PATH ?? ""}` : "";

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

function writeExec(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/**
 * Run a generated shell program from a FILE rather than `bash -c "$program"`:
 * these programs carry whole functions lifted out of install.sh and run past
 * the 8 KiB per-argument ceiling on the Windows spawn path, where a `-c`
 * argument is silently truncated and bash dies with "unexpected end of file"
 * whatever the script under test did.
 */
function runShellProgram(program: string, env: Record<string, string>, args: string[] = []) {
  const file = path.join(root, `prog-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, program);
  return spawnSync("bash", [file, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tts-siblings-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── 1. --tts-only, the mode the repair command runs ─────────────────────────

interface VoiceRun {
  status: number | null;
  out: string;
  ttsStatus: string;
  verdict: (key: string) => string | null;
}

/**
 * Build a fake device root and a PATH of stubs, then run the REAL
 * `scripts/install-voice.sh --tts-only`.
 *
 * `kokoro: "ready"` puts an nvcc stub on PATH and answers the stack's import
 * probes with success, so Kokoro reaches `ready` without a single download.
 * `"broken"` keeps CUDA but fails the model warm-up, which is the flaky
 * install half of this defect. `"declined"` leaves nvcc off PATH, so
 * install_kokoro_tts takes its legitimate `skipped:no-cuda` path. `arch`
 * picks what `uname -m` answers: on anything but aarch64 the engine declines
 * for want of a Jetson build before it even looks for CUDA.
 */
function runTtsOnly(opts: { kokoro?: "ready" | "broken" | "declined"; arch?: string } = {}): VoiceRun {
  const { kokoro = "declined", arch = "aarch64" } = opts;
  const withCuda = kokoro !== "declined";
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const ttsStatus = path.join(root, "tts-status");
  const cudaHome = path.join(root, withCuda ? "cuda" : "no-such-cuda");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  if (withCuda) {
    mkdirSync(path.join(home, ".local", "lib", "python3.10", "site-packages", "nvidia", "cusparselt", "lib"), {
      recursive: true,
    });
    mkdirSync(path.join(cudaHome, "lib64"), { recursive: true });
    writeExec(path.join(bin, "nvcc"), 'echo "Cuda compilation tools, release 12.6, V12.6.68"');
  }

  writeExec(
    path.join(bin, "su"),
    [
      'cmd=""',
      'while [ $# -gt 0 ]; do case "$1" in -c) cmd="$2"; shift 2;; *) shift;; esac; done',
      'stdin_code=""',
      'case "$cmd" in *"python3 -") stdin_code="$(cat)" ;; esac',
      'full=$(printf "%s\\n%s" "$cmd" "$stdin_code")',
      "case \"$full\" in",
      '  *"sys.version_info"*) echo "python3.10"; exit 0 ;;',
      // The Kokoro packages are already on disk, so the engine reaches its
      // verdict without a download. The ONE injected fault in the "broken"
      // case is the model warm-up.
      '  *"import kokoro, torch"*) exit 0 ;;',
      '  *"from kokoro import KPipeline"*) exit "${WARMUP_EXIT:-0}" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  writeExec(
    path.join(bin, "uname"),
    [`[ "\${1:-}" = "-m" ] && { echo "\${FAKE_ARCH:-aarch64}"; exit 0; }`, 'exec /usr/bin/uname "$@"'].join("\n"),
  );
  // No network in a unit test: any download is a bug.
  writeExec(path.join(bin, "curl"), "exit 1");
  writeExec(path.join(bin, "wget"), "exit 1");
  writeExec(path.join(bin, "chown"), "exit 0");
  writeExec(path.join(bin, "loginctl"), "exit 0");

  const res = spawnSync("bash", [INSTALL_VOICE, "--tts-only"], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin${HOST_PATH_SUFFIX}`,
      HOME: home,
      CLAWBOX_USER: "clawbox",
      CLAWBOX_HOME: home,
      CLAWBOX_CUDA_HOME: cudaHome,
      CLAWBOX_TTS_STATUS_FILE: ttsStatus,
      FAKE_ARCH: arch,
      ...(kokoro === "broken" ? { WARMUP_EXIT: "1" } : {}),
      // Cast only because this repo's ProcessEnv augmentation insists on
      // NODE_ENV, which this deliberately minimal stub environment has no
      // business carrying.
    } as unknown as NodeJS.ProcessEnv,
  });

  const contents = existsSync(ttsStatus) ? readFileSync(ttsStatus, "utf-8") : "";
  return {
    status: res.status,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    ttsStatus: contents,
    verdict: (key: string) => {
      const m = new RegExp(`^${key}=(.*)$`, "m").exec(contents);
      return m ? m[1] : null;
    },
  };
}

describe.skipIf(!hasBash)("--tts-only reports the engine it published, not its return code", () => {
  it("exits 13 and says the box is mute on a board that declines the only engine", () => {
    // REVERSED from the two-engine release, and it stays reversed with one
    // engine. `skipped:*` meant nothing was missing only while the OTHER
    // engine carried the box; there is no other engine, so a board Kokoro
    // declines is a box that answers speech with silence — and the mode an
    // operator runs BECAUSE the box cannot speak was answering them with a
    // clean exit. See install-tts-mute-box-fails.test.ts.
    const res = runTtsOnly({ kokoro: "declined", arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:arch-x86_64");
    expect(res.status, `a mute box was told nothing is missing:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
  });

  it("names Kokoro and the concrete reason it is absent, and where the verdict is", () => {
    // "No engine" is not an actionable report: a board with no CUDA and one
    // with no Jetson build lead to different fixes, and a report that sends
    // someone to the status file to learn which is not a report.
    const noCuda = runTtsOnly({ kokoro: "declined" });
    expect(noCuda.verdict("KOKORO"), noCuda.ttsStatus).toBe("skipped:no-cuda");
    expect(noCuda.status, noCuda.out).toBe(13);
    expect(noCuda.out).toMatch(/Kokoro \(GPU\): SKIPPED \(no-cuda\)/);
    expect(noCuda.out).toMatch(/Verdict recorded in /);

    const wrongArch = runTtsOnly({ kokoro: "declined", arch: "x86_64" });
    expect(wrongArch.out).toMatch(/Kokoro \(GPU\): SKIPPED \(arch-x86_64\)/);
  });

  it("does not print the ready banner over a box where nothing was installed", () => {
    // The residual shape of the original defect: a clean decline read as a
    // return code, and a "ready" line printed over an empty disk.
    const res = runTtsOnly({ kokoro: "declined", arch: "x86_64" });
    expect(res.out, `a board with no engine was told it has one:\n${res.out}`).not.toContain("On-device TTS ready");
  });

  it("still exits 0 when Kokoro is ready", () => {
    // The over-correction guard: the question is "can this box speak", and a
    // box whose only engine published `ready` can.
    const res = runTtsOnly({ kokoro: "ready" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.status, `a box with a working engine was called mute:\n${res.out}`).toBe(0);
    expect(res.out).toContain("On-device TTS ready");
    expect(res.out).not.toMatch(/NO WORKING TTS ENGINE/);
  });

  it("fails with 12, not the mute-box 13, when the engine was asked for and did not arrive", () => {
    // Same silence for the listener, different fix for the operator: a board
    // that declines Kokoro is not repaired by re-running the install, a
    // failed download is. The two codes stay apart so install.sh can say
    // which.
    const res = runTtsOnly({ kokoro: "broken" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, `a failed install reported success:\n${res.out}`).toBe(12);
    expect(res.out).not.toContain("On-device TTS ready");
    expect(res.out).not.toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/did NOT install/);
  });

  it("no longer emits the two-engine release's 10 and 11 anywhere", () => {
    // 10 meant "GPU skipped, the CPU fallback speaks" and 11 "no build for
    // this architecture, the fallback has none either — but nothing is
    // missing". Neither sentence can be true with one engine, and install.sh
    // scored both as a healthy provision over a box with no voice.
    const emitted = INSTALL_VOICE_SH.match(/\b(?:exit|return) 1[01]\b/g) ?? [];
    expect(emitted, `install-voice.sh still hands out a clean-skip code: ${emitted.join(", ")}`).toEqual([]);
  });
});

// ── 2. The full pipeline is the other caller ────────────────────────────────

/**
 * Run the REAL tail of the full-pipeline path — the summary and the guard
 * after it — with the verdict preset, the way the Kokoro steps a few hundred
 * lines up would have left it. The reporting helpers are lifted out of the
 * same file so the wording under test is the shipped wording.
 */
function runPipelineTail(verdict: string): { status: number; out: string } {
  const start = INSTALL_VOICE_SH.indexOf('echo "=== Voice Pipeline Installed ==="');
  if (start < 0) throw new Error("the full-pipeline summary is not in install-voice.sh");
  const program = [
    "set -uo pipefail",
    "HAS_CUDA=false",
    `WORKSPACE="${root}/workspace"`,
    `TTS_STATUS_FILE="${root}/tail-tts-status"`,
    `TTS_KOKORO_VERDICT="${verdict}"`,
    extractShellFn(INSTALL_VOICE_SH, "tts_verdict_explain"),
    extractShellFn(INSTALL_VOICE_SH, "tts_missing_engine_report"),
    extractShellFn(INSTALL_VOICE_SH, "tts_mute_box_report"),
    INSTALL_VOICE_SH.slice(start),
  ].join("\n");
  const r = runShellProgram(program, {});
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("the full pipeline names the engine from the verdict too", () => {
  it("does not assert an engine in a summary the verdict never agreed to", () => {
    // The default path printed its TTS line unconditionally, including on the
    // runs where the Kokoro steps had reported an error a few dozen lines up
    // and the pipeline carried on.
    const summary = INSTALL_VOICE_SH.slice(INSTALL_VOICE_SH.indexOf("=== Voice Pipeline Installed ==="));
    expect(summary, "the full-pipeline summary is not in install-voice.sh").not.toBe("");
    expect(summary, `the summary claims an engine without reading its verdict:\n${summary}`).toContain(
      'case "$TTS_KOKORO_VERDICT" in',
    );
  });

  it("exits 13 after naming the board that declines the only engine", () => {
    // The manual voice-pipeline install an operator runs by hand used to fall
    // off its last `echo` with exit 0 over a box with no working engine.
    const res = runPipelineTail("skipped:arch-x86_64");
    expect(res.status, `a mute box finished the pipeline clean:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/Kokoro \(GPU\): SKIPPED \(arch-x86_64\)/);
  });

  it("exits 12 when the engine was asked for and did not arrive", () => {
    const res = runPipelineTail("failed:torch");
    expect(res.status, res.out).toBe(12);
    expect(res.out).toMatch(/did NOT install/);
    expect(res.out).not.toMatch(/NO WORKING TTS ENGINE/);
  });

  it("exits 0 when the engine is there", () => {
    const res = runPipelineTail("ready");
    expect(res.status, `a healthy pipeline run was failed by the guard:\n${res.out}`).toBe(0);
    expect(res.out).toMatch(/TTS engine: Kokoro/);
  });
});

// ── 3. install.sh must record a board that declines the only engine ─────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh whose exit
 * code the test picks — the #519 harness — optionally publishing the verdict
 * the real script would have written on the way out.
 */
function runStep(voiceExit: number, verdict?: string) {
  const projectDir = path.join(root, "project");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  writeExec(
    path.join(projectDir, "scripts", "install-voice.sh"),
    [
      ...(verdict !== undefined ? [`printf 'KOKORO=%s\\n' "${verdict}" > "$CLAWBOX_TTS_STATUS_FILE"`] : []),
      `exit ${voiceExit}`,
    ].join("\n"),
  );
  const openclaw = path.join(root, "openclaw");
  writeExec(openclaw, "exit 0");

  const provisionLog = path.join(root, "provision-failures.log");
  const ttsStatus = path.join(root, "step-tts-status");

  const program = [
    "set -uo pipefail",
    `PROJECT_DIR="${projectDir}"`,
    `OPENCLAW_BIN="${openclaw}"`,
    "CLAWBOX_USER=clawbox",
    'as_clawbox() { env "$@"; }',
    "is_hermes_edition() { return 1; }",
    `record_provision_failure() { printf '%s\\n' "$1" >> "${provisionLog}"; }`,
    extractShellFn(INSTALL_SH, "oc_config_set"),
    extractShellFn(INSTALL_SH, "tts_ensure_provider_registered"),
    extractShellFn(INSTALL_SH, "tts_write_local_provider_definition"),
    extractShellFn(INSTALL_SH, "step_openclaw_tts"),
    "step_openclaw_tts",
    'echo "STEP_RC=$?"',
  ].join("\n");

  const res = runShellProgram(program, { TTS_STATUS_FILE: ttsStatus });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return {
    out,
    stepRc: /STEP_RC=(\d+)/.exec(out)?.[1] ?? "",
    provisionFailures: existsSync(provisionLog)
      ? readFileSync(provisionLog, "utf-8").trim().split("\n").filter(Boolean)
      : [],
  };
}

describe.skipIf(!hasBash)("step_openclaw_tts records a board that declines the only engine", () => {
  it("RECORDS a board Kokoro does not ship for (13)", () => {
    // REVERSED. A board skip was a clean provision on the grounds that nothing
    // was asked for and nothing is missing — while the very same arm
    // described a box that answers speech with silence. A run that describes
    // a mute box and grades it healthy is not a check anyone can act on. It
    // stays non-fatal (the box must come up reachable so it can be fixed) and
    // it is recorded now. See install-tts-mute-box-fails.test.ts.
    const res = runStep(13, "skipped:arch-x86_64");
    expect(res.provisionFailures, `a box with no engine was not recorded:\n${res.out}`).toContain("openclaw_tts");
    expect(res.stepRc).toBe("13");
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it("names Kokoro and its reason from the verdict the run published", () => {
    // The verdict is what the run published, so it is what gets printed:
    // "no engine" on its own sends the operator to the status file to learn
    // what the run already knew.
    const res = runStep(13, "skipped:no-cuda");
    expect(res.out, `the mute box was reported without its reason:\n${res.out}`).toMatch(/Kokoro/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).not.toMatch(/piper/i);
  });

  it("names an exit code outside install-voice.sh's contract and records it, never clean", () => {
    // The over-correction guard for the arms table: the `*)` arm used to leave
    // TTS_RC at 0, so a status nobody wrote a branch for — a future code, a
    // crashed interpreter, an older voice script's retired codes — scored
    // exactly like success. It is named as out-of-contract and recorded; the
    // number it returns is not this suite's business beyond "not 0".
    const res = runStep(99, "skipped:no-cuda");
    expect(res.out, `an unknown TTS status was graded like success:\n${res.out}`).toMatch(/not in its contract/);
    expect(res.provisionFailures, `an out-of-contract exit was not recorded:\n${res.out}`).toContain("openclaw_tts");
    expect(res.stepRc).not.toBe("0");
    expect(res.out).not.toMatch(/piper/i);
  });

  it("keeps a failed engine (12) apart from a mute box and names no second engine", () => {
    // 12 is "the engine you asked for did not arrive": recorded, non-fatal,
    // and a different fix from a board that declines it. It used to print the
    // name of a CPU fallback here, which no box has.
    const res = runStep(12, "failed:model");
    expect(res.provisionFailures).toContain("openclaw_tts");
    expect(res.stepRc).toBe("12");
    expect(res.out).toMatch(/Kokoro GPU TTS was REQUESTED and did NOT install/);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
    expect(res.out).not.toMatch(/piper|fallback/i);
  });

  it("still grades a ready engine as clean (0)", () => {
    const res = runStep(0, "ready");
    expect(res.stepRc, res.out).toBe("0");
    expect(res.provisionFailures).toEqual([]);
    expect(res.out).toContain("On-device TTS configured (Kokoro GPU)");
  });
});

// ── 4. The health check must not score garbage above silence ────────────────

/**
 * Run the real step_validate_services with everything except the TTS verdict
 * stubbed healthy — the #519 harness, unchanged.
 */
function runValidator(contents: string | null): { status: number; out: string } {
  const ttsStatus = path.join(root, "validator-tts-status");
  if (contents !== null) writeFileSync(ttsStatus, contents);
  const clock = path.join(root, "clock");
  writeFileSync(clock, "1000\n");

  const program = [
    "set -uo pipefail",
    "CLAWBOX_EDITION=openclaw",
    "CLAWBOX_TEST_MODE=1",
    "PROJECT_DIR=/home/clawbox/clawbox",
    'IFACE_ENV="/nonexistent/network.env"',
    "EXPECTED_ACTIVE_SERVICES=()",
    "EXPECTED_INSTALLED_SERVICES=()",
    "FOREIGN_EDITION_UNITS=()",
    'is_test_mode() { [ "$CLAWBOX_TEST_MODE" = "1" ]; }',
    'is_hermes_edition() { [ "$CLAWBOX_EDITION" = "hermes" ]; }',
    "has_hermes_harness() { return 1; }",
    "gateway_port_listening() { return 1; }",
    "systemctl() { return 0; }",
    "curl() { printf '200'; }",
    `_CLOCK="${clock}"`,
    'date() { local n; n=$(( $(cat "$_CLOCK") + 100 )); echo "$n" > "$_CLOCK"; printf %s "$n"; }',
    "sleep() { :; }",
    extractShellFn(INSTALL_SH, "step_validate_services"),
    "step_validate_services",
  ].join("\n");

  const r = runShellProgram(program, { TTS_STATUS_FILE: ttsStatus });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("service validation treats an unreadable verdict as no verdict", () => {
  it("FAILS a verdict outside the vocabulary rather than falling through to a pass", () => {
    // A truncated write (tts_status_publish truncates with `>` rather than
    // writing-then-renaming, so a box that lost power mid-publish leaves one)
    // or a plain typo. The chain had no arm for it, so it passed — while the
    // strictly less informative ABSENT verdict correctly failed.
    const res = runValidator("KOKORO=redy\n");
    expect(res.status, `an unparseable verdict scored a pass:\n${res.out}`).not.toBe(0);
    expect(res.out).toMatch(/unrecognised/i);
  });

  it("does not read an engine state out of a verdict it could not parse", () => {
    // "This box has NO working on-device TTS engine" is a claim about an
    // engine that may be running perfectly, so the unreadable arm has to
    // come before every arm that names an engine state — reporting a failure
    // over something that succeeded is the same defect one register down.
    const res = runValidator("KOKORO=redy\n");
    expect(res.status, res.out).not.toBe(0);
    expect(res.out).toMatch(/unrecognised/i);
    expect(res.out, `a garbled Kokoro verdict was read as a mute box:\n${res.out}`).not.toMatch(
      /NO working on-device TTS engine/,
    );
    expect(res.out, `a garbled Kokoro verdict was read as a failed install:\n${res.out}`).not.toMatch(/did NOT install/);
  });

  it("does not accept a skip with its reason truncated away", () => {
    // `skipped:` matches `skipped:*` in bash, so a torn write could still be
    // read as a legitimate board decline. A claim whose reason is cut off is
    // not evidence for the claim — in either direction.
    const res = runValidator("KOKORO=skipped:\n");
    expect(res.status, `a reasonless skip was read as a board decline:\n${res.out}`).not.toBe(0);
    expect(res.out).toMatch(/unrecognised/i);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });

  it("reads a CRLF verdict rather than mistaking a ready engine for a mute box", () => {
    // A file edited on Windows or restored from a tarball ends the verdict as
    // `ready\r`, which is not `ready`. Refusing it would fail a box whose GPU
    // engine is running — a failure report over something that succeeded —
    // so the line is parsed, not merely rejected.
    const res = runValidator("KOKORO=ready\r\n");
    expect(res.status, `a CRLF file was misread:\n${res.out}`).toBe(0);
    expect(res.out).not.toMatch(/unrecognised/i);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });

  it("reads a CRLF skip as the mute box it records, not as garbage", () => {
    // The same parsing in the other direction: `skipped:no-cuda\r` is a
    // board decline with a reason, and it is reported as one — the honest
    // failure, not the unreadable one.
    const res = runValidator("KOKORO=skipped:no-cuda\r\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out).not.toMatch(/unrecognised/i);
  });

  it("still passes a box whose engine reported ready", () => {
    // The over-correction guard. The unreadable check runs BEFORE the arms that
    // name an engine state, and `ready` has its own explicit arm behind it; a
    // guard written as "anything that is not a failure is unreadable" would
    // fail every good box on the shelf.
    const res = runValidator("KOKORO=ready\n");
    expect(res.status, `a healthy box was failed by the new guard:\n${res.out}`).toBe(0);
  });

  it("ignores a garbled line under a key it does not read", () => {
    // The closed vocabulary applies to the ONE key this probe reads. A stale
    // second-engine line from an older release — garbled or not — is neither
    // an engine nor an unreadable verdict; it is not read at all.
    const res = runValidator("KOKORO=ready\nPIPER=redy\n");
    expect(res.status, `a line under an unread key changed the verdict:\n${res.out}`).toBe(0);
    expect(res.out).not.toMatch(/unrecognised/i);
  });

  it("FAILS a board that runs no engine by design", () => {
    // REVERSED. "By design" describes why the engine is absent, not whether
    // the box can speak — and it cannot. Recorded, named with its reason, and
    // the cloud voice is what will speak for it once the box is linked, which
    // is not something this installer can check. See
    // install-tts-mute-box-fails.test.ts.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).toMatch(/cloud voice/);
  });
});

// ── 5. The update path is the second caller of step_openclaw_tts ────────────

/**
 * Run the real step_post_update with every step it calls stubbed to a no-op
 * except step_openclaw_tts, whose exit code the test picks. What is under test
 * is the sentence the update path prints about a box's speech.
 */
function runPostUpdate(ttsExit: number) {
  const body = extractShellFn(INSTALL_SH, "step_post_update");
  const called = new Set(body.match(/\bstep_[a-z_]+/g) ?? []);
  called.delete("step_post_update");
  called.delete("step_openclaw_tts");

  const program = [
    "set -uo pipefail",
    ...[...called].map((fn) => `${fn}() { :; }`),
    // Not step_-prefixed, so the sweep above does not find them: the engine
    // pause/resume pair step_post_update performs around its ollama stop.
    // Undefined they exit 127, and the resume is the function's LAST statement,
    // so post_update would return 127 over a step that succeeded.
    "pause_engine_unit() { :; }",
    "resume_paused_engines() { :; }",
    `step_openclaw_tts() { return ${ttsExit}; }`,
    body,
    "step_post_update",
    'echo "POST_RC=$?"',
  ].join("\n");

  const res = runShellProgram(program, {});
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { out, postRc: /POST_RC=(\d+)/.exec(out)?.[1] ?? "" };
}

describe.skipIf(!hasBash)("step_post_update keeps the three TTS facts apart", () => {
  it("says a mute box is mute instead of 'openclaw_tts step failed (non-fatal)'", () => {
    // The dominant residual shape: the FIRST caller (step_openclaw_setup) was
    // given a tolerance table with a distinct sentence for 12, 13 and 14; the
    // second was left with one `|| echo` indistinguishable from the fourteen
    // around it — on the path that reaches already-shipped boxes. 13 is the
    // box with NO working on-device TTS engine, in the words the first caller
    // uses.
    const res = runPostUpdate(13);
    expect(res.out, `a mute box was reported like a skipped VNC refresh:\n${res.out}`).toMatch(
      /NO working on-device TTS engine/,
    );
  });

  it("does not call a degraded box mute, or a mute box degraded", () => {
    const degraded = runPostUpdate(14);
    const kokoroGone = runPostUpdate(12);
    expect(degraded.out).not.toMatch(/NO working on-device TTS engine/);
    expect(kokoroGone.out).not.toMatch(/NO working on-device TTS engine/);
    expect(kokoroGone.out).toMatch(/Kokoro/);
  });

  it("names an out-of-contract status instead of swallowing it", () => {
    const res = runPostUpdate(99);
    expect(res.out, `an unknown TTS status was laundered into the generic warning:\n${res.out}`).toMatch(
      /not in its contract/,
    );
  });

  it("stays non-fatal — an update whose TTS step failed still finishes", () => {
    // A box that cannot speak must still complete its update and come up
    // reachable; the verdict travels in the marker, not by aborting the run.
    expect(runPostUpdate(13).postRc).toBe("0");
  });
});

// ── 6. A dispatched step's recorded failures must reach the marker ──────────

/** The real `--step` dispatch block, lifted out of install.sh. */
function extractDispatchBlock(): string {
  const start = INSTALL_SH.indexOf('if [ "${1:-}" = "--step" ]; then');
  if (start < 0) throw new Error("the --step dispatch block is not in install.sh");
  const end = INSTALL_SH.indexOf("\nfi\n", start);
  if (end < 0) throw new Error("the --step dispatch block has no closing fi");
  return INSTALL_SH.slice(start, end + 4);
}

/**
 * Run the real dispatch block against a stub step that RECORDS a provisioning
 * failure and then returns 0 — which is exactly what step_post_update does
 * when its TTS step reports 13.
 */
function runDispatch(
  // Returns 0 the way the real step_post_update does — every fixup inside it is
  // `|| warn` — while having recorded a failure its caller must not lose.
  stepBody = 'record_provision_failure openclaw_tts; echo "  Warning: TTS reported 13"; return 0',
) {
  const marker = path.join(root, "provision-status");
  const program = [
    "set -euo pipefail",
    'PROJECT_DIR="/home/clawbox/clawbox"',
    "PROVISION_FAILURES=()",
    'PROVISION_RUN_ID="test-run"',
    'record_provision_failure() { PROVISION_FAILURES+=("$1"); }',
    `write_provision_status() { printf 'STATUS=%s\\nFAILED=%s\\n' "$1" "\${2:-}" > "${marker}"; }`,
    "DISPATCH_STEPS=(post_update)",
    `step_post_update() { ${stepBody}; }`,
    extractDispatchBlock(),
    'echo "DISPATCH_FELL_THROUGH"',
  ].join("\n");

  const res = runShellProgram(program, {}, ["--step", "post_update"]);
  return {
    status: res.status,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    marker: existsSync(marker) ? readFileSync(marker, "utf-8") : "",
  };
}

describe.skipIf(!hasBash)("--step dispatch carries the verdict its step recorded", () => {
  it("does not exit 0 over a step that recorded a provisioning failure", () => {
    // `"step_${local_step}"; exit 0` discarded the record_provision_failure
    // #519 added, so an in-app update that left the box with no TTS engine
    // reported a successful update.
    const res = runDispatch();
    expect(res.status, `a recorded provisioning failure exited 0:\n${res.out}`).not.toBe(0);
  });

  it("writes the incomplete verdict to the marker the flash host reads", () => {
    const res = runDispatch();
    expect(res.marker, `nothing was published for a failed step:\n${res.out}`).toContain("STATUS=incomplete");
    expect(res.marker).toContain("openclaw_tts");
  });

  it("prints the same stdout sentinel the full install prints", () => {
    const res = runDispatch();
    expect(res.out).toContain("[provision-status] INCOMPLETE");
    expect(res.out).toContain("[provision-run] ");
  });

  it("leaves a clean dispatched step exactly as it was — exit 0, no marker", () => {
    // The over-correction guard, and the reason success publishes NOTHING: one
    // dispatched step finishing cleanly is not evidence that the whole box
    // provisioned, so writing `ok` here would let a single `--step` run mint
    // the healthy verdict the flash host reads.
    const res = runDispatch('echo "  all good"; return 0');
    expect(res.status, `a clean step was failed by the new verdict block:\n${res.out}`).toBe(0);
    expect(res.marker).toBe("");
  });

  it("keeps a recorded failure AND the step's own status together", () => {
    // `sudo bash install.sh --step openclaw_tts` is the repair command every
    // TTS failure message prints. The step both records and returns 13, and
    // the operator needs each half: the marker for the dashboard, the exit
    // code for whatever ran the command.
    const res = runDispatch("record_provision_failure openclaw_tts; return 13");
    expect(res.status, res.out).toBe(13);
    expect(res.marker).toContain("STATUS=incomplete");
  });

  it("still exits with a failing step's own status", () => {
    // The trap must report the step, not replace it: a dispatched step that
    // dies keeps its exit code, which is what the updater and the operator
    // read.
    const res = runDispatch("return 7");
    expect(res.status, res.out).toBe(7);
  });
});
