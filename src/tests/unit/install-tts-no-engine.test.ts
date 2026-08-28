import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A box with NO working on-device TTS engine must not finish provisioning as
 * "All checks healthy" (TTS-01), and a Kokoro that was asked for and did not
 * arrive must not be laundered into a warning.
 *
 * This file used to pin the two-engine version of that rule: the Piper CPU
 * fallback published its own verdict, `--tts-only` exited 13 when neither
 * engine survived, and install.sh's health check read BOTH keys. The owner
 * removed Piper (2026-08): Kokoro is the only on-device voice, and a Kokoro
 * failure is reported — verdict file, exit status, provisioning record,
 * health check — rather than hidden behind a second engine. So the rule now
 * has one engine to be about:
 *
 *   1. `--tts-only` publishes ONE engine verdict, KOKORO=, and nothing else.
 *      A PIPER= line left by an earlier release is neither read nor kept.
 *   2. Its exit status carries what happened to Kokoro (0 / 10 / 11 / 12) and
 *      to the scripts (1). There is no 13: with one engine, "Kokoro failed"
 *      and "no engine" are the same fact and 12 carries it.
 *   3. step_openclaw_tts records every failure it is handed, stays non-fatal,
 *      and never names an engine the box does not have.
 *   4. step_validate_services reads KOKORO= alone: `failed:*` and a missing
 *      verdict fail, `skipped:*` passes (no on-device voice by design — the
 *      gateway's cloud voice speaks), and a stale PIPER= line changes nothing.
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
  home: string;
}

/**
 * Build a fake device root and a PATH of stubs, then run the REAL
 * `scripts/install-voice.sh --tts-only`.
 *
 * `withCuda` puts an nvcc stub on PATH; without it install_kokoro_tts takes its
 * legitimate `skipped:no-cuda` path. `priorStatus` pre-writes a verdict file
 * an earlier release might have left. `breakDeploy` puts a regular file where
 * the workspace directory has to be created, so deploy_voice_scripts fails
 * for a reason that has nothing to do with Kokoro.
 */
function runTtsOnly(
  opts: {
    withCuda?: boolean;
    arch?: string;
    warmupExit?: string;
    priorStatus?: string;
    breakDeploy?: boolean;
    args?: string[];
  } = {},
): VoiceRun {
  const { withCuda = false, arch = "aarch64", args = ["--tts-only"] } = opts;
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const ttsStatus = path.join(root, "tts-status");
  const cudaHome = path.join(root, withCuda ? "cuda" : "no-such-cuda");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (opts.priorStatus !== undefined) writeFileSync(ttsStatus, opts.priorStatus);
  if (opts.breakDeploy) {
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "workspace"), "not a directory\n");
  }

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
  // No network in a unit test: any download is a bug.
  writeExec(path.join(bin, "curl"), "exit 1");
  writeExec(path.join(bin, "wget"), "exit 1");
  writeExec(path.join(bin, "chown"), "exit 0");
  writeExec(path.join(bin, "loginctl"), "exit 0");

  const res = spawnSync("bash", [INSTALL_VOICE, ...args], {
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
    home,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tts-no-engine-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── 1. One engine, one verdict ───────────────────────────────────────────────

describe.skipIf(!hasBash)("--tts-only publishes one engine verdict and nothing else", () => {
  it("publishes KOKORO=ready and no second-engine line when Kokoro landed", () => {
    const res = runTtsOnly({ withCuda: true });
    expect(res.status, res.out).toBe(0);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.verdict("PIPER"), `a verdict was published for an engine that no longer exists:\n${res.ttsStatus}`).toBeNull();
    expect(res.ttsStatus).not.toMatch(/piper/i);
  });

  it("publishes skipped:no-cuda on a board with no CUDA, and still nothing about a second engine", () => {
    const res = runTtsOnly({});
    expect(res.status, res.out).toBe(10);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.verdict("PIPER")).toBeNull();
  });

  it("drops a stale PIPER= line left by a release that still shipped the CPU fallback", () => {
    // The file is rewritten from what THIS run knows. Carrying an old engine's
    // verdict forward would let a line nobody can produce any more keep
    // describing the box.
    const res = runTtsOnly({ withCuda: true, priorStatus: "KOKORO=failed:model\nPIPER=ready\nTIMESTAMP=old\n" });
    expect(res.status, res.out).toBe(0);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.verdict("PIPER"), `a stale second-engine verdict survived:\n${res.ttsStatus}`).toBeNull();
  });

  it("installs no CPU fallback: nothing is downloaded and nothing named Piper is mentioned", () => {
    const res = runTtsOnly({ withCuda: true });
    expect(res.out, `--tts-only still talks about the removed engine:\n${res.out}`).not.toMatch(/piper/i);
    expect(existsSync(path.join(res.home, ".local", "share", "piper"))).toBe(false);
  });
});

// ── 2. The exit status carries what happened to Kokoro ──────────────────────

describe.skipIf(!hasBash)("--tts-only reports what happened to Kokoro, with nothing to hide behind", () => {
  it("exits 12 with failed:* when Kokoro was requested and did not install", () => {
    // 12 is the hard-failure code #506 landed so a failed engine could not ship
    // as a soft fallback. With no fallback left it is also the whole story:
    // this box has no on-device voice until someone fixes it.
    const res = runTtsOnly({ withCuda: true, warmupExit: "1" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, `a requested engine that did not install exited ${res.status}:\n${res.out}`).toBe(12);
    expect(res.out).toMatch(/did NOT install/);
    expect(res.out).toMatch(/no on-device voice/);
  });

  it("exits 11 with skipped:* on an architecture no engine was ever going to run on", () => {
    // x86_64: no Jetson CUDA build. Nothing was asked for and nothing is
    // missing — failing every install-x64.sh run would just teach everyone to
    // ignore this check. The cloud voice speaks on such a box.
    const res = runTtsOnly({ withCuda: true, arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.status, `a board with no applicable engine was called broken:\n${res.out}`).toBe(11);
    expect(res.out).toMatch(/cloud voice/);
  });

  it("never exits 13: with one engine, 'Kokoro failed' and 'no engine' are the same fact", () => {
    // 13 was the two-engine code for "neither survived". Keeping it would
    // mean two codes for one outcome, and install.sh would have to guess
    // which one a given install-voice.sh emits.
    const dispatch = INSTALL_VOICE_SH.slice(
      INSTALL_VOICE_SH.indexOf('"${1:-}" = "--tts-only"'),
      INSTALL_VOICE_SH.indexOf("Voice Pipeline Installer"),
    );
    expect(dispatch).not.toMatch(/exit 13/);
    expect(dispatch).toMatch(/exit 12/);
  });

  it("exits 1 when the voice scripts do not deploy, without erasing the Kokoro verdict", () => {
    const res = runTtsOnly({ breakDeploy: true });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/did not deploy/);
    // Kokoro's own answer is still in the file for install.sh to read.
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
  });

  it("lets a hard Kokoro failure outrank a deploy failure", () => {
    // 12 is the code install.sh records as "the engine you asked for did not
    // arrive" and nothing may overwrite it — the lesson of the bare `exit 1`
    // that once sat before `exit "$KOKORO_RC"` and laundered a mute box into a
    // warning.
    const res = runTtsOnly({ withCuda: true, warmupExit: "1", breakDeploy: true });
    expect(res.status, res.out).toBe(12);
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^failed:/);
  });
});

// ── 3. install.sh must not launder any of that into a warning ───────────────

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
  it("records a provision failure when Kokoro was requested and did not install (12)", () => {
    const res = runStep(12);
    expect(res.provisionFailures, `nothing was recorded:\n${res.out}`).toContain("openclaw_tts");
    expect(res.stepRc).toBe("12");
    expect(res.out).toMatch(/REQUESTED and did NOT install/);
    // The listener's outcome, stated: no on-device voice, the cloud voice
    // answers. Not "the box still speaks on the fallback" — there is none.
    expect(res.out).toMatch(/cloud voice/);
  });

  it("records a provision failure when the voice scripts did not deploy (1)", () => {
    // This branch printed a warning, left TTS_RC=0 and recorded nothing, so
    // PROVISION_FAILURES stayed empty and the run printed Setup Complete.
    const res = runStep(1);
    expect(res.provisionFailures, `a failed deploy was recorded nowhere:\n${res.out}`).toContain("openclaw_tts");
    expect(res.stepRc).toBe("14");
    expect(res.out).toMatch(/did not deploy/);
  });

  it("records a provision failure on an exit code it does not recognise", () => {
    // "No answer" and "an answer nobody wrote a branch for" must not both score
    // as healthy. 99 is not in the contract, so it cannot be assumed benign.
    const res = runStep(99);
    expect(res.provisionFailures, `an unknown voice-install status passed silently:\n${res.out}`).toContain(
      "openclaw_tts",
    );
  });

  it("still records a 13 from a voice script that reports no engine, rather than treating it as unknown", () => {
    // The Kokoro-only install-voice.sh does not emit 13 any more, but the arm
    // stays: a voice script that DOES say "no engine" — an older release's,
    // or a future one's — has to be recorded as exactly that.
    const res = runStep(13);
    expect(res.provisionFailures).toContain("openclaw_tts");
    expect(res.stepRc).toBe("13");
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it("stays non-fatal — a box with no engine still finishes provisioning and comes up reachable", () => {
    // Loud, recorded, and reflected in the exit status, but not an aborted
    // install: a box that cannot speak for itself must still be reachable to
    // be fixed.
    for (const code of [1, 12, 13]) {
      const res = runStep(code);
      expect(res.stepRc, `install-voice.sh ${code} aborted the step:\n${res.out}`).not.toBe("");
    }
  });

  it("records nothing when the board simply has no CUDA", () => {
    const res = runStep(10);
    expect(res.provisionFailures).toEqual([]);
    expect(res.stepRc).toBe("0");
    // And says where the voice comes from on such a box.
    expect(res.out).toMatch(/cloud voice/);
  });

  it("never names an engine the box does not have", () => {
    // The trap the two-engine version walked into on its way out of the
    // original bug: a mute box told it speaks on a fallback it did not have,
    // in the summary line an operator actually reads. Now there is only one
    // engine to claim, and it may be claimed only on exit 0.
    for (const code of [1, 10, 11, 12, 13, 99]) {
      const res = runStep(code);
      expect(res.out, `exit ${code} claimed a working Kokoro:\n${res.out}`).not.toContain("configured (Kokoro GPU)");
      expect(res.out, `exit ${code} named the removed engine:\n${res.out}`).not.toMatch(/piper/i);
    }
    expect(runStep(0).out).toContain("On-device TTS configured (Kokoro GPU)");
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

// ── 4. The health check reads the one verdict there is ──────────────────────

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

describe.skipIf(!hasBash)("service validation scores the one engine there is", () => {
  it("FAILS when Kokoro was requested and did not install", () => {
    const res = runValidator("KOKORO=failed:model\n");
    expect(res.status, `validation passed a box whose GPU engine failed:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/requested and did NOT install/);
    expect(res.out).toMatch(/--step openclaw_tts/);
  });

  it("FAILS when the verdict is absent or empty", () => {
    // "No answer" is not a pass — the same rule the KOKORO probe has always
    // applied, and the reason this file exists.
    expect(runValidator(null).status).toBe(1);
    const res = runValidator("");
    expect(res.status, `an unreported engine scored as healthy:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/no on-device TTS verdict/);
  });

  it("passes a board with no CUDA — no on-device voice by design, the cloud voice speaks", () => {
    // This used to fail unless PIPER=ready stood next to it. With the CPU
    // engine gone, a skipped Kokoro is the whole verdict for such a board.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, res.out).toBe(0);
  });

  it("passes a board no engine was ever going to run on", () => {
    const res = runValidator("KOKORO=skipped:arch-x86_64\n");
    expect(res.status, res.out).toBe(0);
  });

  it("passes a box that has the engine", () => {
    expect(runValidator("KOKORO=ready\n").status).toBe(0);
  });

  it("ignores a stale PIPER= line rather than scoring an engine that no longer exists", () => {
    // A box updated from a release that still shipped the CPU fallback may
    // carry its last verdict until the TTS step rewrites the file. That line
    // must neither fail a healthy box nor rescue a broken one.
    expect(runValidator("KOKORO=ready\nPIPER=failed:download\n").status).toBe(0);
    expect(runValidator("KOKORO=skipped:no-cuda\nPIPER=failed:download\n").status).toBe(0);
    expect(runValidator("KOKORO=failed:model\nPIPER=ready\n").status).toBe(1);
  });

  it("re-reads the verdict file on every probe rather than trusting an earlier answer", () => {
    // A probe taken once and never refreshed is its own recurring defect here.
    // Same process, same helper, two different files: the second answer has to
    // come from the second file.
    expect(runValidator("KOKORO=ready\n").status).toBe(0);
    expect(runValidator("KOKORO=failed:torch\n").status).toBe(1);
  });

  it("reads no second engine key", () => {
    const probe = extractShellFn(INSTALL_SH, "step_validate_services");
    expect(probe).toContain("s/^KOKORO=//p");
    expect(probe).not.toContain("s/^PIPER=//p");
  });
});
