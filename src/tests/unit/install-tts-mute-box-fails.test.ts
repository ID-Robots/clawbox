import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A box that finishes provisioning with NO working speech engine must FAIL,
 * loudly, naming every engine it tried and why each one is not there.
 *
 * #519, #533 and #544 removed the false successes one at a time, but all three
 * kept one carve-out: when BOTH engines report `skipped:*` the run was graded
 * clean. `--tts-only` printed "No on-device TTS engine applies to this board"
 * on stdout and exited $KOKORO_RC; step_openclaw_tts mapped that to TTS_RC=0
 * with no record_provision_failure; and step_validate_services' probe asked for
 * a `failed:*` before it would report a mute box, so two `skipped:*` verdicts
 * matched no arm and fell out of the chain as a silent PASS.
 *
 * The defence for it, repeated in all three PRs, was that failing a board
 * neither engine ships for "would only teach everyone to ignore this check",
 * naming install-x64.sh as the run it would fail. That run does not exist:
 *
 *   $ grep -c 'voice\|tts\|piper\|kokoro' install-x64.sh   -> 0
 *   $ grep -n 'install-voice.sh' *.sh                      -> install.sh:2602
 *
 * install-x64.sh never calls the script that publishes these verdicts, so
 * nothing legitimate lands in the carve-out. What lands in it is install.sh run
 * where `uname -m` is not aarch64 — the only way both halves skip, since
 * install_piper_engine's single non-failure skip is the architecture test and
 * install_kokoro_tts returns 11 on that same board. The box that comes out has
 * no voice, and every layer called it healthy.
 *
 * A silent box is not a healthy box. These tests EXECUTE the shipped artifacts
 * — the real `--tts-only` and `--piper-only` dispatches out of
 * scripts/install-voice.sh, the real engine-report block at the end of its full
 * pipeline, the real step_openclaw_tts and the real step_validate_services out
 * of install.sh — against stubs, so a rewrite that keeps the prose but drops
 * the verdict fails them.
 *
 * Roughly half of these are over-correction guards, and they are the point of
 * half the diff: a box with ONE engine is not a mute box, and reporting it as
 * one would be the same class of untrue status line pointed the other way.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE = path.join(REPO, "scripts", "install-voice.sh");
const INSTALL_VOICE_SH = readFileSync(INSTALL_VOICE, "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/** See install-tts-no-engine.test.ts: keeps the isolated stub PATH usable on Windows. */
const HOST_PATH_SUFFIX = process.platform === "win32" ? `${path.delimiter}${process.env.PATH ?? ""}` : "";

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** A one-line shell helper (`name() { ... }` all on one line), lifted verbatim. */
function extractShellOneLiner(source: string, name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(source);
  if (!m) throw new Error(`${name} not found as a one-liner`);
  return m[0];
}

/**
 * A helper the block under test MAY not carry yet, lifted when it is there and
 * stubbed when it is not. Without this the over-correction guards below could
 * not run against a tree that predates the helper, and a guard that errors for
 * a reason unrelated to what it guards proves nothing.
 */
function extractShellFnOrStub(source: string, name: string, stub: string): string {
  return source.includes(`${name}() {`) ? extractShellFn(source, name) : `${name}() { ${stub}; }`;
}

function shellConst(name: string): string {
  const m = new RegExp(`^${name}="([^"]+)"`, "m").exec(INSTALL_VOICE_SH);
  if (!m) throw new Error(`${name} not found in install-voice.sh`);
  return m[1];
}

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
 * `arch` is the whole defect surface: on x86_64 install_piper_engine has no
 * pinned artifact and install_kokoro_tts has no Jetson wheel, so BOTH halves
 * publish `skipped:arch-x86_64` and the box has nothing to speak with.
 *
 * `seedStatus` writes a verdict file before the run, which is how a mode that
 * installs ONE engine (--piper-only) learns about the other half — the case
 * that separates "this box lost its fallback" from "this box is mute".
 */
function runVoice(
  opts: {
    args?: string[];
    piper?: "ready" | "broken";
    withCuda?: boolean;
    arch?: string;
    seedStatus?: string;
  } = {},
): VoiceRun {
  const { args = ["--tts-only"], piper = "ready", withCuda = false, arch = "aarch64" } = opts;
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
      '  *"from kokoro import KPipeline"*) exit 0 ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  writeExec(
    path.join(bin, "uname"),
    [`[ "\${1:-}" = "-m" ] && { echo "\${FAKE_ARCH:-aarch64}"; exit 0; }`, 'exec /usr/bin/uname "$@"'].join("\n"),
  );
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

// ── 1. --tts-only: no `ready` engine is a failure, however each half declined ─

describe.skipIf(!hasBash)("--tts-only fails a box that ends with no engine", () => {
  it("exits 13 when BOTH halves skip for the board itself", () => {
    // The ruling. x86_64: no pinned Piper artifact AND no Jetson CUDA build, so
    // both halves publish `skipped:arch-*`. This exited 11 and install.sh
    // graded it a clean provision.
    const res = runVoice({ piper: "ready", arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.status, `a box with no engine at all exited clean:\n${res.out}`).toBe(13);
  });

  it("names BOTH engines and the concrete reason each one is absent", () => {
    // Not a bare "no engine": a report that sends the operator off to read
    // $TTS_STATUS_FILE to find out what happened is not a report. The reason
    // travels with the verdict, so it travels into the banner.
    const res = runVoice({ piper: "ready", arch: "x86_64" });
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/SILENCE/);
    expect(res.out, `the Kokoro half was not named:\n${res.out}`).toMatch(/Kokoro/);
    expect(res.out, `the Piper half was not named:\n${res.out}`).toMatch(/Piper/);
    expect(res.out, `neither reason was given:\n${res.out}`).toMatch(/arch-x86_64/);
  });

  it("still publishes both verdicts on the way out", () => {
    // The failure has to outlive the run: install.sh's health check and the
    // next update both read the file, not the flash log.
    const res = runVoice({ piper: "ready", arch: "x86_64" });
    expect(res.ttsStatus).toMatch(/^KOKORO=skipped:/m);
    expect(res.ttsStatus).toMatch(/^PIPER=skipped:/m);
  });

  it("reports the reason it FAILED on, not just the reason it skipped", () => {
    // The other route into the same arm, which already exited 13: a legitimate
    // `skipped:no-cuda` next to a Piper download that flaked. Both routes now
    // produce one outcome and both name their halves.
    const res = runVoice({ piper: "broken" });
    expect(res.status, res.out).toBe(13);
    expect(res.out).toMatch(/failed/i);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("does NOT fail a no-CUDA board that speaks on the CPU fallback", () => {
    // An aarch64 Orin with no nvcc: Kokoro legitimately skips, Piper installs,
    // the box speaks. `skipped:*` behind a working engine is still not a defect
    // — the rule that changed is only what happens when NOTHING is ready.
    const res = runVoice({ piper: "ready" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.verdict("PIPER"), res.ttsStatus).toBe("ready");
    expect(res.status, `a box that speaks on Piper was failed:\n${res.out}`).toBe(10);
  });

  it("does NOT fail a healthy box with both engines", () => {
    const res = runVoice({ piper: "ready", withCuda: true });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.status, `a healthy box was failed:\n${res.out}`).toBe(0);
  });

  it("keeps 'lost the fallback behind a working engine' as its own outcome (1, not 13)", () => {
    // Folding this into 13 would print "this box has NO working TTS engine"
    // over a box whose GPU engine is running perfectly.
    const res = runVoice({ piper: "broken", withCuda: true });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
    expect(res.status, res.out).toBe(1);
  });
});

// ── 2. --piper-only: the sibling call site, reached by a different route ─────

describe.skipIf(!hasBash)("--piper-only fails a box that ends with no engine", () => {
  it("exits 13 when it declines Piper and no other engine is on record", () => {
    // The mode clawbox-tts.sh tells an operator to run when it reports "Piper
    // not installed". On a board with no pinned artifact it printed "No Piper
    // artifact applies to this board" and exited 0 — a clean success handed to
    // someone who ran it BECAUSE the box could not speak.
    const res = runVoice({ args: ["--piper-only"], piper: "broken", arch: "x86_64" });
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.status, `a mute box was told nothing is missing:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
  });

  it("exits 13 when the fallback FAILED and no other engine is on record", () => {
    // Previously a plain 1, "the fallback did not complete" — the lesser fact,
    // on a box where the fallback was the only engine there was.
    const res = runVoice({ args: ["--piper-only"], piper: "broken" });
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, res.out).toBe(13);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("still exits 0 when it declines Piper behind a Kokoro that IS ready", () => {
    // The guard that decides the shape of the fix: the question is not "did
    // Piper install", it is "can this box speak". tts_status_load has just read
    // the GPU half's verdict off disk, and on this board it says yes.
    const res = runVoice({
      args: ["--piper-only"],
      piper: "broken",
      arch: "x86_64",
      seedStatus: "KOKORO=ready\n",
    });
    expect(res.status, `a box with a working GPU engine was called mute:\n${res.out}`).toBe(0);
    expect(res.out).toMatch(/No Piper artifact applies/i);
  });

  it("still exits 1 when the fallback is lost behind a ready Kokoro", () => {
    const res = runVoice({ args: ["--piper-only"], piper: "broken", seedStatus: "KOKORO=ready\n" });
    expect(res.status, res.out).toBe(1);
  });

  it("still announces the fallback when it genuinely installs", () => {
    const res = runVoice({ args: ["--piper-only"], piper: "ready" });
    expect(res.verdict("PIPER"), res.ttsStatus).toBe("ready");
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Piper fallback ready");
  });

  it("does not blank a Kokoro verdict an earlier run published", () => {
    // The #533 guard, re-pinned because this PR adds a reader of the seeded
    // value: if tts_status_load ever stopped seeding, the new mute-box check
    // would fail every --piper-only run on a healthy Kokoro box.
    const res = runVoice({ args: ["--piper-only"], piper: "ready", seedStatus: "KOKORO=ready\n" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
  });
});

// ── 3. The full pipeline is the third caller, and it fell off its last echo ──

/**
 * Execute the REAL engine-report block at the end of scripts/install-voice.sh —
 * everything from the line that names the entrypoint to EOF — with the two
 * verdicts preset. The pipeline above it installs CUDA torch and builds
 * CTranslate2 from source, which no unit test can run; this block is the part
 * that decides what the operator is told and what status they get back.
 */
function runPipelineReport(kokoro: string, piper: string) {
  const marker = 'echo "  TTS entrypoint:';
  const at = INSTALL_VOICE_SH.indexOf(marker);
  if (at < 0) throw new Error("the pipeline's engine-report block moved");
  const program = [
    "set -uo pipefail",
    `TTS_STATUS_FILE="${path.join(root, "tts-status")}"`,
    'WORKSPACE="/home/clawbox/.openclaw/workspace"',
    `TTS_KOKORO_VERDICT="${kokoro}"`,
    `TTS_PIPER_VERDICT="${piper}"`,
    extractShellOneLiner(INSTALL_VOICE_SH, "tts_verdict_is_ready"),
    extractShellFnOrStub(INSTALL_VOICE_SH, "tts_verdict_explain", 'printf %s "${1:-unreported}"'),
    INSTALL_VOICE_SH.slice(at),
  ].join("\n");
  const r = runShellProgram(program, {});
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("the manual voice-pipeline install fails a box with no engine", () => {
  it("exits 13 after printing that neither engine applies", () => {
    // It printed "no Kokoro GPU engine applies to this board" AND "no Piper
    // fallback applies to this board" and then exited 0, because the script
    // ended on an echo. #544 taught these two lines to read the verdicts and
    // left the status alone.
    const res = runPipelineReport("skipped:arch-x86_64", "skipped:arch-x86_64");
    expect(res.status, `the manual installer reported a mute box as success:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/arch-x86_64/);
  });

  it("exits 0 when an engine is there", () => {
    const res = runPipelineReport("ready", "ready");
    expect(res.status, res.out).toBe(0);
  });

  it("exits 0 on a no-CUDA board that has the CPU engine", () => {
    const res = runPipelineReport("skipped:no-cuda", "ready");
    expect(res.status, res.out).toBe(0);
  });
});

// ── 4. install.sh must record it, not launder it into a summary line ─────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh that publishes
 * the verdicts and THEN exits the chosen code, in that order — which is what
 * the real script does, so a rewrite that keeps the prose but reads the exit
 * code instead of the file fails here.
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
  it("RECORDS exit 11 instead of grading it a clean provision", () => {
    // 11 is "no Jetson CUDA build for this architecture", which is the same
    // `uname -m` test that leaves install_piper without a pinned artifact — so
    // 11 has always meant "this box has NO engine". It printed "this box
    // answers speech with SILENCE" and returned 0, with PROVISION_FAILURES left
    // empty and nothing in the marker the flash host reads.
    const res = runStep(11);
    expect(
      res.provisionFailures,
      `a box with no engine at all was not recorded as a failure:\n${res.out}`,
    ).toContain("openclaw_tts");
    expect(res.stepRc, res.out).toBe("13");
  });

  it("names both engines and their reasons when the run published them", () => {
    const res = runStep(13, "KOKORO=skipped:no-cuda\nPIPER=failed:download\n");
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).toMatch(/failed:download/);
  });

  it("keeps the provider configured — a mute box must still come up fixable", () => {
    // Non-fatal stays non-fatal. A box that cannot speak has to finish
    // provisioning and be reachable, which is how it gets repaired.
    const res = runStep(11);
    expect(res.out).not.toMatch(/^\s*ERROR/m);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("still grades a no-CUDA board that speaks on Piper as clean (10)", () => {
    const res = runStep(10, "KOKORO=skipped:no-cuda\nPIPER=ready\n");
    expect(res.provisionFailures, `a box that speaks on Piper was recorded broken:\n${res.out}`).toEqual([]);
    expect(res.stepRc, res.out).toBe("0");
    expect(res.out).toContain("Piper CPU only");
  });

  it("still grades a fully healthy box as clean (0)", () => {
    const res = runStep(0, "KOKORO=ready\nPIPER=ready\n");
    expect(res.provisionFailures, res.out).toEqual([]);
    expect(res.stepRc, res.out).toBe("0");
  });

  it("does not call a box mute when only its fallback is gone (1 -> 14)", () => {
    const res = runStep(1, "KOKORO=ready\nPIPER=failed:download\n");
    expect(res.stepRc, res.out).toBe("14");
    expect(res.out, `a box with a working GPU engine was called mute:\n${res.out}`).not.toMatch(
      /NO working TTS engine/,
    );
  });
});

// ── 5. The health check is the last layer that called it healthy ────────────

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
  it("FAILS a board where both engines skipped", () => {
    // The carve-out. The probe asked for a `failed:*` before it would report a
    // mute box, so two `skipped:*` verdicts matched no arm and scored a PASS —
    // "All 2 checks healthy" over a box that answers with silence.
    const res = runValidator("KOKORO=skipped:arch-x86_64\nPIPER=skipped:arch-x86_64\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/SILENCE/);
  });

  it("names both engines and both reasons in the failure it reports", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=skipped:arch-x86_64\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).toMatch(/skipped:arch-x86_64/);
  });

  it("FAILS the mixed case too — one skipped, one failed", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=failed:download\n");
    expect(res.status, res.out).toBe(1);
  });

  // ── over-correction guards ────────────────────────────────────────────────

  it("passes a no-CUDA Orin that speaks on the CPU fallback", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=ready\n");
    expect(res.status, `a box that speaks on Piper was failed:\n${res.out}`).toBe(0);
  });

  it("passes a box whose GPU engine is up and whose fallback the board declines", () => {
    // The mirror image, and the reason the new arm asks "is EITHER ready"
    // rather than "is either skipped": a `skipped:*` Piper behind a running
    // Kokoro is not a mute box.
    const res = runValidator("KOKORO=ready\nPIPER=skipped:arch-x86_64\n");
    expect(res.status, res.out).toBe(0);
  });

  it("passes a fully healthy box", () => {
    expect(runValidator("KOKORO=ready\nPIPER=ready\n").status).toBe(0);
  });

  it("still reports an unreported half as unassertable rather than as silence", () => {
    // `-n` on both verdicts before the SILENCE claim: an engine that published
    // nothing is unknown, not absent, and asserting a mute box off a missing
    // line would be a failure report over something that may have succeeded.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `an unreported engine scored as healthy:\n${res.out}`).toBe(1);
    expect(res.out, `a missing line was reported as proven silence:\n${res.out}`).not.toMatch(/with SILENCE/);
  });

  it("still puts an unreadable verdict ahead of the engine-naming arms", () => {
    // #533's guard. A garbled Kokoro verdict next to a ready Piper must not be
    // reported as "no engine" — that is a claim about an engine that may be
    // running perfectly.
    const res = runValidator("KOKORO=redy\nPIPER=ready\n");
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/unrecognised/i);
  });
});
