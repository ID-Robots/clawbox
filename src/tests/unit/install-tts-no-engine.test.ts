import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A box with NO working TTS engine at all finished provisioning as
 * "All checks healthy" (TTS-01).
 *
 * PR #506 removed the false success for one half of the speech install — the
 * Kokoro GPU half, which publishes a verdict to $TTS_STATUS_FILE that
 * install.sh health-checks. The OTHER half published nothing, so the same
 * false success was still reachable straight through it:
 *
 *   1. On a board with no CUDA (install-x64.sh, or an Orin with no nvcc)
 *      install_kokoro_tts legitimately publishes `KOKORO=skipped:no-cuda`.
 *   2. install_piper fails on a flaky download.
 *   3. `--tts-only` ran its Piper guard BEFORE `exit "$KOKORO_RC"`, so the bare
 *      `exit 1` overwrote the Kokoro verdict — including 12, the hard-failure
 *      code #506 exists to surface.
 *   4. install.sh's `case "$VOICE_RC" in 1)` printed a warning, left TTS_RC=0
 *      and never called record_provision_failure, so PROVISION_FAILURES stayed
 *      empty.
 *   5. step_validate_services greps only `^KOKORO=` and scores `skipped:*` as a
 *      PASS, so the run printed "=== ClawBox Setup Complete ===" with no
 *      PROVISIONING INCOMPLETE banner.
 *
 * The box then answers every spoken request with silence.
 *
 * These tests EXECUTE the shipped artifacts — the real `--tts-only` dispatch
 * out of scripts/install-voice.sh, the real step_openclaw_tts and the real
 * step_validate_services out of install.sh — against stubs. A rewrite that
 * keeps the prose but drops the verdict fails them.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE = path.join(REPO, "scripts", "install-voice.sh");
const INSTALL_VOICE_SH = readFileSync(INSTALL_VOICE, "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * The stub PATH below is deliberately just the stub dir plus the POSIX system
 * dirs, so the script under test cannot reach the real curl, wget or nvcc. On
 * Windows that also makes `bash` itself unfindable — the child's PATH is what
 * resolves the command — and every spawn fails with ENOENT before the script
 * runs a line. Appending the host PATH there restores the lookup only; the stub
 * dir still comes first, so the stubs keep winning. Empty on Linux/CI, where
 * the isolated PATH works as written.
 */
const HOST_PATH_SUFFIX = process.platform === "win32" ? `${path.delimiter}${process.env.PATH ?? ""}` : "";

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** Read a pinned constant (e.g. PIPER_EN_ONNX_SHA256) out of the real script. */
function shellConst(name: string): string {
  const m = new RegExp(`^${name}="([^"]+)"`, "m").exec(INSTALL_VOICE_SH);
  if (!m) throw new Error(`${name} not found in install-voice.sh`);
  return m[1];
}

function writeExec(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/**
 * Run a generated shell program from a FILE rather than `bash -c "$program"`.
 *
 * These programs carry whole functions lifted out of install.sh and run well
 * past 8 KiB, which is the per-argument ceiling on the Windows spawn path: a
 * `-c` argument is silently truncated there and bash dies with "unexpected end
 * of file" whatever the script under test actually does. Writing the program
 * out first is identical on Linux and makes this regression runnable on a
 * developer machine instead of only in CI.
 */
function runShellProgram(program: string, env: Record<string, string>) {
  const file = path.join(root, `prog-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, program);
  return spawnSync("bash", [file], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

let root: string;

interface VoiceRun {
  status: number | null;
  out: string;
  /** Contents of the published TTS verdict file, or "" when none was written. */
  ttsStatus: string;
  /** The value of one key in the published verdict file, or null when absent. */
  verdict: (key: string) => string | null;
}

/**
 * Build a fake device root and a PATH of stubs, then run the REAL
 * `scripts/install-voice.sh --tts-only`.
 *
 * `piper` picks what the CPU half does:
 *   "ready"   the binary and voices are already on disk — nothing to download.
 *   "broken"  nothing on disk and every fetch fails, which is the flaky
 *             download this defect was reproduced with.
 *
 * `withCuda` puts an nvcc stub on PATH; without it install_kokoro_tts takes its
 * legitimate `skipped:no-cuda` path, which is the board half of the defect.
 */
function runTtsOnly(
  opts: {
    piper?: "ready" | "broken";
    withCuda?: boolean;
    arch?: string;
    warmupExit?: string;
    args?: string[];
  } = {},
): VoiceRun {
  const { piper = "ready", withCuda = false, arch = "aarch64", args = ["--tts-only"] } = opts;
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
      // The Kokoro packages are already on disk, so the GPU half reaches its
      // `ready` verdict without a single download.
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
  // No network in a unit test. This is also the ONE injected fault in the
  // "broken" case: a download that does not come back.
  writeExec(path.join(bin, "curl"), "exit 1");
  writeExec(path.join(bin, "wget"), "exit 1");
  writeExec(path.join(bin, "chown"), "exit 0");
  writeExec(path.join(bin, "loginctl"), "exit 0");
  writeExec(path.join(bin, "sha256sum"), 'printf "%s  %s\\n" "$(head -c 64 "$1")" "$1"');

  const piperDir = path.join(root, "piper");
  if (piper === "ready") {
    mkdirSync(path.join(piperDir, "voices"), { recursive: true });
    writeExec(path.join(piperDir, "piper"), "exit 0");
    writeFileSync(path.join(piperDir, "voices", "en_US-lessac-medium.onnx"), shellConst("PIPER_EN_ONNX_SHA256"));
    writeFileSync(
      path.join(piperDir, "voices", "en_US-lessac-medium.onnx.json"),
      shellConst("PIPER_EN_JSON_SHA256"),
    );
  }

  const res = spawnSync("bash", [INSTALL_VOICE, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin${HOST_PATH_SUFFIX}`,
      HOME: home,
      CLAWBOX_USER: "clawbox",
      CLAWBOX_HOME: home,
      PIPER_DIR: piperDir,
      CLAWBOX_CUDA_HOME: cudaHome,
      CLAWBOX_TTS_STATUS_FILE: ttsStatus,
      FAKE_ARCH: arch,
      ...(opts.warmupExit ? { WARMUP_EXIT: opts.warmupExit } : {}),
      // Cast only because this repo's ProcessEnv augmentation insists on
      // NODE_ENV, which this deliberately minimal stub environment has no
      // business carrying — the point of it is that the script under test can
      // reach nothing but the stubs.
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

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tts-no-engine-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── 1. The Piper half has to publish a verdict of its own ───────────────────

describe.skipIf(!hasBash)("the CPU engine publishes a verdict that outlives the run", () => {
  it("publishes PIPER=ready next to KOKORO= when the fallback is installed", () => {
    const res = runTtsOnly({ piper: "ready" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.verdict("PIPER"), `no Piper verdict was published:\n${res.ttsStatus}`).toBe("ready");
  });

  it("publishes a failed:* Piper verdict where something other than stdout can read it", () => {
    // The half of the speech install that published NOTHING. stdout is not a
    // report: nobody greps a flash log a week later.
    const res = runTtsOnly({ piper: "broken" });
    expect(res.verdict("PIPER"), `no Piper verdict was published:\n${res.ttsStatus}`).toMatch(/^failed:/);
  });

  it("does not report Piper ready from a return code that only means 'declined'", () => {
    // install_piper returns 0 on a non-aarch64 board because there is no pinned
    // artifact to install — a clean decline, not an engine. Reading success off
    // that exit code is the "reports success from an exit code without checking
    // the outcome" shape this codebase keeps producing.
    const res = runTtsOnly({ piper: "broken", arch: "x86_64" });
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.verdict("PIPER")).not.toBe("ready");
  });

  it("keeps both verdicts in the file — neither half erases the other", () => {
    const res = runTtsOnly({ piper: "ready", withCuda: true });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.verdict("PIPER"), res.ttsStatus).toBe("ready");
  });
});

// ── 2. The Piper guard must not destroy the Kokoro verdict ──────────────────

describe.skipIf(!hasBash)("--tts-only reports which engines survived, not just the last thing it did", () => {
  it("exits 13 when NEITHER engine is usable", () => {
    // The defect, end to end: no CUDA is a legitimate skip and a failed Piper
    // download is a real failure, and together they leave the box mute. The old
    // code exited a bare 1, which install.sh laundered into a warning.
    const res = runTtsOnly({ piper: "broken" });
    expect(res.status, `a box with no TTS engine exited ${res.status}:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/SILENCE|no working TTS engine/i);
  });

  it("still surfaces Kokoro's hard-failure code when Piper is the survivor", () => {
    // 12 is the code #506 landed to surface. A Piper problem must not overwrite
    // it, and a Piper SUCCESS must not hide it either.
    const res = runTtsOnly({ piper: "ready", withCuda: true, warmupExit: "1" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, `the Kokoro verdict was overwritten:\n${res.out}`).toBe(12);
  });

  it("does not cry 'no engine' when Kokoro actually landed", () => {
    // The mirror-image bug class: an error path reporting failure over
    // something that succeeded. Losing the CPU fallback while the GPU engine
    // works is a degraded box, not a mute one, and must not exit 13.
    const res = runTtsOnly({ piper: "broken", withCuda: true });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.status, res.out).toBe(1);
  });

  it("does not cry 'no engine' on a board no engine was ever going to run on", () => {
    // x86_64: no pinned Piper artifact AND no Jetson CUDA build. Nothing was
    // asked for and nothing is missing — failing every install-x64.sh run would
    // just teach everyone to ignore this check.
    const res = runTtsOnly({ piper: "ready", arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.status, `a board with no applicable engine was called broken:\n${res.out}`).toBe(11);
  });
});

// ── 3. install.sh must not launder that into a warning ──────────────────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh whose exit
 * code the test picks, and report whether the step reached for
 * record_provision_failure — the call that is the difference between a failure
 * the operator sees and one that ends at a log line nobody greps.
 */
function runStep(voiceExit: number) {
  const projectDir = path.join(root, "project");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  writeExec(path.join(projectDir, "scripts", "install-voice.sh"), `exit ${voiceExit}`);
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

describe.skipIf(!hasBash)("step_openclaw_tts records the failures it is handed", () => {
  it("records a provision failure when the box is left with no engine (13)", () => {
    const res = runStep(13);
    expect(res.provisionFailures, `nothing was recorded:\n${res.out}`).toContain("openclaw_tts");
    expect(res.out).toMatch(/SILENCE|no working TTS engine/i);
  });

  it("records a provision failure when the CPU fallback did not install (1)", () => {
    // This branch printed a warning, left TTS_RC=0 and recorded nothing, so
    // PROVISION_FAILURES stayed empty and the run printed Setup Complete.
    const res = runStep(1);
    expect(res.provisionFailures, `a lost fallback was recorded nowhere:\n${res.out}`).toContain("openclaw_tts");
  });

  it("records a provision failure on an exit code it does not recognise", () => {
    // "No answer" and "an answer nobody wrote a branch for" must not both score
    // as healthy. 99 is not in the contract, so it cannot be assumed benign.
    const res = runStep(99);
    expect(res.provisionFailures, `an unknown voice-install status passed silently:\n${res.out}`).toContain(
      "openclaw_tts",
    );
  });

  it("stays non-fatal — a mute box still finishes provisioning and comes up reachable", () => {
    // Loud, recorded, and reflected in the exit status, but not an aborted
    // install: a box that cannot speak must still be reachable to be fixed.
    for (const code of [1, 13]) {
      const res = runStep(code);
      expect(res.stepRc, `install-voice.sh ${code} aborted the step:\n${res.out}`).not.toBe("");
    }
  });

  it("records nothing when the board simply has no CUDA", () => {
    const res = runStep(10);
    expect(res.provisionFailures).toEqual([]);
  });

  it("never puts the name of a working fallback on a box that has none", () => {
    // The trap this fix walked into on its way out of the original one. Before
    // 13 existed, every unhandled voice status fell through to the final `else`
    // and printed "On-device TTS configured (Piper CPU only)". Reached by a
    // MUTE box that is the same false success in a smaller font — a Piper the
    // box does not have, named in the summary line an operator actually reads.
    const res = runStep(13);
    expect(res.out, `a mute box was told it speaks on Piper:\n${res.out}`).not.toContain("Piper CPU only");
    expect(res.out).not.toContain("Kokoro GPU, Piper fallback");
    expect(res.out).toMatch(/SILENCE/);
  });

  it("does not call a box mute when only its fallback is gone", () => {
    // The mirror image, and the reason 1 maps to its own code instead of
    // sharing 13. A box whose Kokoro is running and whose Piper download flaked
    // is DEGRADED, not silent; reporting "this box has no working TTS engine"
    // over a working engine is a failure report over something that succeeded.
    const degraded = runStep(1);
    const mute = runStep(13);
    expect(degraded.stepRc, `a degraded box was reported as a mute one:\n${degraded.out}`).toBe("14");
    expect(mute.stepRc).toBe("13");
    expect(degraded.stepRc).not.toBe(mute.stepRc);
    expect(degraded.out).not.toMatch(/SILENCE/);
  });

  it("keeps both tolerated codes out of the fatal range step_openclaw_setup enforces", () => {
    // step_openclaw_setup returns any status it has no branch for, which aborts
    // the whole provision. 13 and 14 are the two it must carry rather than die
    // on, so a box that cannot speak still comes up reachable enough to fix.
    const setup = extractShellFn(INSTALL_SH, "step_openclaw_setup");
    for (const code of ["13)", "14)"]) {
      expect(setup, `step_openclaw_setup would abort the provision on ${code}`).toContain(code);
    }
  });
});

// ── 4. The health check has to read both verdicts ───────────────────────────

/**
 * Run the real step_validate_services with everything except the TTS verdict
 * stubbed healthy. `contents` is written to the verdict file, or the file is
 * left absent when it is null.
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

describe.skipIf(!hasBash)("service validation refuses to call a mute box healthy", () => {
  it("FAILS a board where Kokoro skipped and Piper failed", () => {
    // The exact shipped state this defect was reproduced in. The old probe
    // greps `^KOKORO=`, sees `skipped:no-cuda`, and prints "All checks healthy"
    // over a box that answers every spoken request with silence.
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=failed:download\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/--step openclaw_tts/);
  });

  it("FAILS when the Piper verdict is absent", () => {
    // "No answer" is not a pass — the same rule the KOKORO probe already
    // applies, and the reason this file exists.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `an unreported engine scored as healthy:\n${res.out}`).toBe(1);
  });

  it("passes a board that was never going to run either engine", () => {
    // install-x64.sh: no Jetson CUDA build and no pinned Piper artifact.
    const res = runValidator("KOKORO=skipped:arch-x86_64\nPIPER=skipped:arch-x86_64\n");
    expect(res.status, res.out).toBe(0);
  });

  it("passes a no-CUDA Orin that speaks on the CPU fallback", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=ready\n");
    expect(res.status, res.out).toBe(0);
  });

  it("passes a box that has the GPU engine", () => {
    expect(runValidator("KOKORO=ready\nPIPER=ready\n").status).toBe(0);
  });

  it("re-reads the verdict file on every probe rather than trusting an earlier answer", () => {
    // A probe taken once and never refreshed is its own recurring defect here.
    // Same process, same helper, two different files: the second answer has to
    // come from the second file.
    expect(runValidator("KOKORO=ready\nPIPER=ready\n").status).toBe(0);
    expect(runValidator("KOKORO=skipped:no-cuda\nPIPER=failed:download\n").status).toBe(1);
  });
});
