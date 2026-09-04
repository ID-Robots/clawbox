import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A box that finishes provisioning with NO working speech engine must FAIL,
 * loudly, naming the engine it tried and why it is not there.
 *
 * #519, #533 and #544 removed the false successes one at a time, but all three
 * kept one carve-out: when every engine reported `skipped:*` the run was
 * graded clean. `--tts-only` printed "No on-device TTS engine applies to this
 * board" on stdout and exited 10 or 11; step_openclaw_tts mapped that to
 * TTS_RC=0 with no record_provision_failure; and step_validate_services'
 * probe asked for a `failed:*` before it would report a mute box, so a
 * `skipped:*` verdict matched no arm and fell out of the chain as a silent
 * PASS.
 *
 * The defence for it was that failing a board the engine does not ship for
 * "would only teach everyone to ignore this check", naming install-x64.sh as
 * the run it would fail. That run does not exist:
 *
 *   $ grep -c 'voice\|tts\|kokoro' install-x64.sh   -> 0
 *   $ grep -n 'install-voice.sh' *.sh               -> install.sh only
 *
 * install-x64.sh never calls the script that publishes these verdicts, so
 * nothing legitimate lands in the carve-out. Nor is the gateway's cloud voice
 * a reason to grade it clean: the installer cannot know whether that voice
 * exists — it needs the ClawBox AI link, which happens after install — and
 * every shipped ClawBox is a Jetson a Kokoro build exists for, so a skipped
 * Kokoro on real hardware means something is wrong. The box that came out had
 * no voice, and every layer called it healthy.
 *
 * There is ONE on-device engine now — Kokoro; the CPU fallback of an earlier
 * release is gone — so the rule has one half to be about: a `skipped:*`
 * Kokoro IS the mute box. `--tts-only` and the full pipeline exit 13 for it
 * and name the reason, step_openclaw_tts records it (non-fatal, so the box
 * still comes up fixable), and step_validate_services refuses to pass it.
 * 10 and 11 are no longer emitted: 10 meant "GPU skipped, CPU fallback
 * speaks", which cannot happen with one engine. A `failed:*` Kokoro, no
 * verdict, or a verdict outside the vocabulary stays 12 — a different fix,
 * and never a claim of proven silence off something the run did not say.
 *
 * These tests EXECUTE the shipped artifacts — the real `--tts-only` dispatch
 * out of scripts/install-voice.sh, the real engine-report block at the end of
 * its full pipeline, the real step_openclaw_tts and the real
 * step_validate_services out of install.sh — against stubs, so a rewrite that
 * keeps the prose but drops the verdict fails them. The over-correction guards
 * are the point of half the file: a box whose engine is READY, or whose
 * verdict cannot be read, is not a mute box, and reporting it as one would be
 * the same class of untrue status line pointed the other way.
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

/** See install-tts-no-engine.test.ts: keeps the isolated stub PATH usable on Windows. */
const HOST_PATH_SUFFIX = process.platform === "win32" ? `${path.delimiter}${process.env.PATH ?? ""}` : "";

/** Lift a multi-line shell function verbatim out of a shipped script, so the
 *  test executes the real body rather than a paraphrase of it. */
function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** Write an executable bash stub onto the isolated PATH the script under test
 *  will resolve its commands from. */
function writeExec(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** Programs run from a FILE, not `bash -c`: see install-tts-no-engine.test.ts. */
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
  ttsStatus: string;
  verdict: (key: string) => string | null;
}

/**
 * Build a fake device root and run the REAL scripts/install-voice.sh.
 *
 * `arch` is the whole defect surface: on x86_64 install_kokoro_tts has no
 * Jetson wheel, so the only engine publishes `skipped:arch-x86_64` and the box
 * has nothing to speak with. `withCuda` puts an nvcc stub on PATH; without it
 * an aarch64 board takes the other skip, `skipped:no-cuda`, which is the same
 * mute box. `warmupExit` makes the model pre-download fail behind a working
 * CUDA, which is a `failed:*` — the other, different, failure.
 *
 * `seedStatus` writes a verdict file before the run, the way an earlier run
 * would have left one.
 */
function runVoice(
  opts: {
    args?: string[];
    withCuda?: boolean;
    arch?: string;
    warmupExit?: string;
    seedStatus?: string;
  } = {},
): VoiceRun {
  const { args = ["--tts-only"], withCuda = false, arch = "aarch64" } = opts;
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const ttsStatus = path.join(root, "tts-status");
  const cudaHome = path.join(root, withCuda ? "cuda" : "no-such-cuda");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (opts.seedStatus !== undefined) writeFileSync(ttsStatus, opts.seedStatus);

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
  root = mkdtempSync(path.join(tmpdir(), "tts-mute-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── 1. --tts-only: no `ready` engine is a failure, however the board declined ─

describe.skipIf(!hasBash)("--tts-only fails a box that ends with no engine", () => {
  it("exits 13 when the board declines the only engine", () => {
    // The ruling. x86_64: no Jetson CUDA build, so Kokoro publishes
    // `skipped:arch-*` and there is no second engine to carry the box. This
    // exited 11 and install.sh graded it a clean provision.
    const res = runVoice({ arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:arch-x86_64");
    expect(res.status, `a box with no engine at all exited clean:\n${res.out}`).toBe(13);
  });

  it("exits 13 on an aarch64 board with no CUDA toolkit — the case the two-engine release graded 10", () => {
    // An Orin with no nvcc: Kokoro legitimately skips, and with the CPU
    // fallback gone nothing else installs. 10 meant "GPU skipped, the fallback
    // speaks"; there is no fallback, so this is the same mute box as x86_64
    // and gets the same grade.
    const res = runVoice();
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.status, `a no-CUDA board with no engine exited ${res.status}:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/no-cuda/);
  });

  it("names the engine and the concrete reason it is absent", () => {
    // Not a bare "no engine": a report that sends the operator off to read
    // $TTS_STATUS_FILE to find out what happened is not a report. The reason
    // travels with the verdict, so it travels into the banner.
    const res = runVoice({ arch: "x86_64" });
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/SILENCE/);
    expect(res.out, `Kokoro was not named:\n${res.out}`).toMatch(/Kokoro/);
    expect(res.out, `the reason was not given:\n${res.out}`).toMatch(/arch-x86_64/);
    expect(res.out, `the banner names an engine this release does not ship:\n${res.out}`).not.toMatch(/Piper/i);
  });

  it("still publishes the verdict on the way out", () => {
    // The failure has to outlive the run: install.sh's health check and the
    // next update both read the file, not the flash log. One engine, one key.
    const res = runVoice({ arch: "x86_64" });
    expect(res.ttsStatus).toMatch(/^KOKORO=skipped:/m);
    expect(res.ttsStatus, "a second engine key was published").not.toMatch(/^PIPER=/m);
    expect(res.out).toContain(`Verdict recorded in ${path.join(root, "tts-status")}`);
  });

  it("reports the reason it FAILED on, not just the reason it skipped — and grades it 12, not 13", () => {
    // The other route to a box with no voice: a Kokoro that was asked for and
    // did not arrive. Same silence for the listener, a different fix for the
    // operator (re-running the install repairs a flaked download; it does not
    // grow a CUDA toolkit), so it keeps its own code and names its own reason.
    const res = runVoice({ withCuda: true, warmupExit: "1" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, res.out).toBe(12);
    expect(res.out).toMatch(/FAILED \(/);
    expect(res.out).toMatch(/did NOT install/);
    expect(res.out, `a failed engine was reported as a board that declined it:\n${res.out}`).not.toMatch(
      /NO WORKING TTS ENGINE/,
    );
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("still exits 0 when Kokoro is ready", () => {
    const res = runVoice({ withCuda: true });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.status, `a healthy box was failed:\n${res.out}`).toBe(0);
    expect(res.out).not.toMatch(/NO WORKING TTS ENGINE/);
  });

  it("does not blank a Kokoro verdict an earlier run published", () => {
    // The #533 guard, re-pinned for one engine: a run on a healthy box must
    // leave the file saying `ready` — its own fresh verdict, never an empty
    // key — because step_validate_services reads the file a moment later and
    // scores an absent verdict as a failed check.
    const res = runVoice({ withCuda: true, seedStatus: "KOKORO=ready\n" });
    expect(res.status, res.out).toBe(0);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
  });

  it("replaces an earlier run's verdict with the truth rather than keeping a stale `ready`", () => {
    // The mirror image: seeding from an earlier file is exactly how a stale
    // line would be carried forward as if an engine still stood behind it.
    // The file after a mute run says the box is mute.
    const res = runVoice({ arch: "x86_64", seedStatus: "KOKORO=ready\n" });
    expect(res.status, res.out).toBe(13);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:arch-x86_64");
  });
});

// ── 2. The full pipeline is the other caller, and it fell off its last echo ──

/**
 * Execute the REAL engine-report block at the end of scripts/install-voice.sh —
 * everything from the line that names the entrypoint to EOF — with the verdict
 * preset. The pipeline above it installs CUDA torch and builds CTranslate2 from
 * source, which no unit test can run; this block is the part that decides what
 * the operator is told and what status they get back.
 */
function runPipelineReport(kokoro: string) {
  const marker = 'echo "  TTS entrypoint:';
  const at = INSTALL_VOICE_SH.indexOf(marker);
  if (at < 0) throw new Error("the pipeline's engine-report block moved");
  const program = [
    "set -uo pipefail",
    `TTS_STATUS_FILE="${path.join(root, "tts-status")}"`,
    'WORKSPACE="/home/clawbox/.openclaw/workspace"',
    `TTS_KOKORO_VERDICT="${kokoro}"`,
    extractShellFn(INSTALL_VOICE_SH, "tts_verdict_explain"),
    extractShellFn(INSTALL_VOICE_SH, "tts_missing_engine_report"),
    extractShellFn(INSTALL_VOICE_SH, "tts_mute_box_report"),
    INSTALL_VOICE_SH.slice(at),
  ].join("\n");
  const r = runShellProgram(program, {});
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("the manual voice-pipeline install fails a box with no engine", () => {
  it("exits 13 after printing that the only engine does not apply", () => {
    // It printed "no Kokoro GPU engine applies to this board" and then exited
    // 0, because the script ended on an echo. #544 taught the line to read
    // the verdict and left the status alone.
    const res = runPipelineReport("skipped:arch-x86_64");
    expect(res.status, `the manual installer reported a mute box as success:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/arch-x86_64/);
  });

  it("exits 13 on a no-CUDA board — there is no CPU engine to exit 0 for", () => {
    const res = runPipelineReport("skipped:no-cuda");
    expect(res.status, res.out).toBe(13);
    expect(res.out).toMatch(/no-cuda/);
  });

  it("exits 12 when the engine was asked for and did not install", () => {
    const res = runPipelineReport("failed:install");
    expect(res.status, res.out).toBe(12);
    expect(res.out).toMatch(/did NOT install/);
    expect(res.out).not.toMatch(/NO WORKING TTS ENGINE/);
  });

  it("exits 12, not 13, when the pipeline published no verdict — nothing to read is not proof of silence", () => {
    const res = runPipelineReport("");
    expect(res.status, res.out).toBe(12);
    expect(res.out).toMatch(/no verdict published/);
    expect(res.out, `a missing verdict was reported as proven silence:\n${res.out}`).not.toMatch(/SILENCE/);
  });

  it("exits 0 when the engine is there", () => {
    const res = runPipelineReport("ready");
    expect(res.status, res.out).toBe(0);
  });
});

// ── 3. install.sh must record it, not launder it into a summary line ─────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh that publishes
 * the verdict and THEN exits the chosen code, in that order — which is what the
 * real script does, so a rewrite that keeps the prose but reads the exit code
 * instead of the file fails here.
 */
function runStep(voiceExit: number, statusFileContents: string | null = null) {
  const projectDir = path.join(root, "project");
  const provisionLog = path.join(root, "provision-failures.log");
  const ttsStatus = path.join(root, "step-tts-status");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  writeExec(
    path.join(projectDir, "scripts", "install-voice.sh"),
    statusFileContents === null
      ? `exit ${voiceExit}`
      : [`cat > "$CLAWBOX_TTS_STATUS_FILE" <<'EOF'\n${statusFileContents}EOF`, `exit ${voiceExit}`].join("\n"),
  );
  const openclaw = path.join(root, "openclaw");
  writeExec(openclaw, ['if [ "$1" = "config" ] && [ "$2" = "get" ]; then exit 0; fi', "exit 0"].join("\n"));

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

  const r = runShellProgram(program, { TTS_STATUS_FILE: ttsStatus });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    out,
    stepRc: /STEP_RC=(\d+)/.exec(out)?.[1] ?? "",
    provisionFailures: existsSync(provisionLog)
      ? readFileSync(provisionLog, "utf-8").trim().split("\n").filter(Boolean)
      : [],
  };
}

describe.skipIf(!hasBash)("step_openclaw_tts records a box with no engine as a failure", () => {
  it("RECORDS a 13 instead of grading it a clean provision", () => {
    // "No Jetson CUDA build for this architecture" used to arrive as 11 and
    // print "this box answers speech with SILENCE" while returning 0, with
    // PROVISION_FAILURES left empty and nothing in the marker the flash host
    // reads. It arrives as 13 now, and 13 is recorded.
    const res = runStep(13, "KOKORO=skipped:arch-x86_64\n");
    expect(
      res.provisionFailures,
      `a box with no engine at all was not recorded as a failure:\n${res.out}`,
    ).toContain("openclaw_tts");
    expect(res.stepRc, res.out).toBe("13");
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it("names Kokoro and its reason when the run published them", () => {
    const res = runStep(13, "KOKORO=skipped:no-cuda\n");
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out, `the step names an engine this release does not ship:\n${res.out}`).not.toMatch(/Piper/i);
  });

  it("keeps the provider configured — a mute box must still come up fixable", () => {
    // Non-fatal stays non-fatal. A box that cannot speak has to finish
    // provisioning and be reachable, which is how it gets repaired.
    const res = runStep(13, "KOKORO=skipped:arch-x86_64\n");
    expect(res.out).not.toMatch(/^\s*ERROR/m);
    // The step went on to configure the provider and said so — with the mute
    // box named in the same line, not laundered out of it.
    expect(res.out).toMatch(/On-device TTS configured, but this box has NO working on-device TTS engine/);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("still grades a fully healthy box as clean (0)", () => {
    const res = runStep(0, "KOKORO=ready\n");
    expect(res.provisionFailures, res.out).toEqual([]);
    expect(res.stepRc, res.out).toBe("0");
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });

  it("does not call a box mute when only the voice scripts did not deploy (1 -> 14)", () => {
    // Folding this into 13 would print "this box has NO working TTS engine"
    // over a box whose GPU engine is running perfectly.
    const res = runStep(1, "KOKORO=ready\n");
    expect(res.stepRc, res.out).toBe("14");
    expect(res.provisionFailures, res.out).toContain("openclaw_tts");
    expect(res.out, `a box with a working GPU engine was called mute:\n${res.out}`).not.toMatch(
      /NO working on-device TTS engine/,
    );
  });

  it("keeps a requested engine that did not install as its own outcome (12), not a mute board", () => {
    const res = runStep(12, "KOKORO=failed:model\n");
    expect(res.stepRc, res.out).toBe("12");
    expect(res.provisionFailures, res.out).toContain("openclaw_tts");
    expect(res.out).toMatch(/did NOT install/);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });
});

// ── 4. The health check is the last layer that called it healthy ────────────

/**
 * Run the real step_validate_services against a verdict file of the test's
 * choosing, with every probe but the TTS one stubbed out. `null` writes no file
 * at all, which is the "the step left no record" case.
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

describe.skipIf(!hasBash)("service validation refuses to pass a box with no engine", () => {
  it("FAILS a board where the only engine skipped", () => {
    // The carve-out. The probe asked for a `failed:*` before it would report a
    // mute box, so a `skipped:*` verdict matched no arm and scored a PASS —
    // "All checks healthy" over a box that answers with silence.
    const res = runValidator("KOKORO=skipped:arch-x86_64\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it("FAILS a no-CUDA Orin — with one engine, a declined Kokoro is a mute box, not a fallback box", () => {
    // This was the over-correction guard of the two-engine release ("passes a
    // no-CUDA Orin that speaks on the CPU fallback"). There is no fallback to
    // speak on, so the same verdict is now the failure it always described.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `a box with no engine was passed:\n${res.out}`).toBe(1);
  });

  it("names Kokoro and the reason in the failure it reports", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out, `the probe names an engine this release does not ship:\n${res.out}`).not.toMatch(/Piper/i);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("passes a fully healthy box", () => {
    const res = runValidator("KOKORO=ready\n");
    expect(res.status, res.out).toBe(0);
  });

  it("still reports a missing verdict as unassertable rather than as silence", () => {
    // An engine that published nothing is unknown, not absent, and asserting
    // a mute box off a missing line would be a failure report over something
    // that may have succeeded. It still fails — "no answer" never scores as a
    // pass — but as "no verdict", the way --tts-only grades it 12 and not 13.
    for (const contents of [null, "", "TIMESTAMP=2026-08-28T00:00:00Z\n"]) {
      const res = runValidator(contents);
      expect(res.status, `an unreported engine scored as healthy:\n${res.out}`).toBe(1);
      expect(res.out).toMatch(/no on-device TTS verdict/);
      expect(res.out, `a missing line was reported as proven silence:\n${res.out}`).not.toMatch(
        /NO working on-device TTS engine/,
      );
    }
  });

  it("still puts an unreadable verdict ahead of the engine-naming arms", () => {
    // #533's guard. A garbled Kokoro verdict must not be reported as "no
    // engine" — that is a claim about an engine that may be running perfectly.
    const res = runValidator("KOKORO=redy\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/unrecognised/i);
    expect(res.out, `an unreadable verdict was reported as a mute box:\n${res.out}`).not.toMatch(
      /NO working on-device TTS engine/,
    );
  });

  it("does not accept a skip with its reason truncated away as a mute-box claim either", () => {
    // `skipped:?*`, never `skipped:*`: a bare `skipped:` is how a truncated
    // write appears, and a claim with its reason cut off is evidence of
    // nothing — it fails as unreadable, not as a named engine state.
    const res = runValidator("KOKORO=skipped:\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/unrecognised/i);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });
});
