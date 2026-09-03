import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

/**
 * install.sh advertised "On-device TTS configured (Kokoro GPU, Piper fallback)"
 * while calling `install-voice.sh --piper-only`, which installs the CPU
 * fallback and nothing else. Kokoro was only ever installed by the full,
 * no-flag path of that script, and install.sh never invoked it — so on three
 * freshly flashed boxes (beta e4f11e1, 2026-08-20) `import kokoro` and
 * `import torch` both raised ModuleNotFoundError, `systemctl --user
 * list-unit-files` had no kokoro-server unit, and Piper was the only engine
 * present. Neither the flash path nor the remote-update path shipped the
 * engine TASK-382 benchmarked and TASK-383 made the default.
 *
 * These tests EXECUTE the shipped artifacts — the real `--tts-only` dispatch
 * out of scripts/install-voice.sh, and the real step_openclaw_tts out of
 * install.sh — against stubs for su/pip/uname/nvcc, rather than grepping their
 * text. A rewrite that keeps the words but drops the install fails them.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE = path.join(REPO, "scripts", "install-voice.sh");
const INSTALL_VOICE_SH = readFileSync(INSTALL_VOICE, "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** Read a pinned constant (e.g. KOKORO_STAMP_VERSION) out of the real script. */
function shellConst(name: string): string {
  const m = new RegExp(`^${name}="([^"]+)"`, "m").exec(INSTALL_VOICE_SH);
  if (!m) throw new Error(`${name} not found in install-voice.sh`);
  return m[1];
}

function writeExec(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/** The value of the generated unit's `Environment=LD_LIBRARY_PATH=` line. */
function unitLdPath(unit: string): string {
  const m = /^Environment=LD_LIBRARY_PATH=(.*)$/m.exec(unit);
  expect(m, `the unit sets no LD_LIBRARY_PATH:\n${unit}`).not.toBeNull();
  return m![1];
}

// ── The --tts-only harness ──────────────────────────────────────────────────

interface VoiceRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * Every command handed to `su - clawbox -c`, one per entry — with the
   * program that travelled on stdin appended, so a payload that reads its
   * snippet from `python3 -` is still searchable by its contents.
   */
  su: string[];
  /**
   * Payloads a real `bash -n` refused to parse, each preceded by bash's own
   * complaint. MUST be empty: `su` hands the string to a login shell, so a
   * payload the shell cannot parse never runs at all.
   */
  suSyntax: string;
  curl: string[];
  /** Every `chown` argument list, one per line. */
  chown: string[];
  /** Contents of the published TTS verdict file, or "" when none was written. */
  ttsStatus: string;
  home: string;
}

let root: string;

/**
 * Build a fake device root and a PATH of stubs, then run the REAL
 * `install-voice.sh --tts-only`.
 *
 * Scripted via env:
 *   KOKORO_IMPORT_EXIT  `import kokoro, torch` status (0 = packages on disk)
 *   PIP_EXIT            every `pip3 install` status
 *   WARMUP_EXIT         the KPipeline pre-download status
 *   FAKE_ARCH           what `uname -m` reports
 *   WITH_CUDA           "1" puts an nvcc stub on PATH
 *
 * `stamped` pre-writes the completion stamp a previous successful run leaves —
 * `true` for the current version, or a literal string for a stamp an older
 * release wrote.
 */
function runTtsOnly(
  env: Record<string, string> = {},
  stamped: boolean | string = false,
  mode = "--tts-only",
): VoiceRun {
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const suLog = path.join(root, "su.log");
  const suSyntaxLog = path.join(root, "su-syntax.log");
  const curlLog = path.join(root, "curl.log");
  const chownLog = path.join(root, "chown.log");
  const ttsStatus = path.join(root, "tts-status");
  const cudaHome = path.join(root, env.WITH_CUDA_LIBS === "1" ? "cuda" : "no-such-cuda");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  // A real device HAS these three directories: the cusparselt wheel unpacks
  // into user-site and CUDA lives under /usr/local/cuda. They are what makes
  // kokoro_ld_path() return a non-empty path, and therefore what makes the
  // LD_LIBRARY_PATH export appear in the payload at all. Every test in this
  // file used to run without them, so `$ld` was always empty, the export was
  // always skipped, and the payload that is broken on real hardware was never
  // built here — which is precisely how a script that could not execute a
  // single python snippet on a Jetson kept a green suite.
  if (env.WITH_CUDA_LIBS === "1") {
    mkdirSync(path.join(home, ".local", "lib", "python3.10", "site-packages", "nvidia", "cusparselt", "lib"), {
      recursive: true,
    });
    mkdirSync(path.join(cudaHome, "lib64"), { recursive: true });
  }
  if (stamped) {
    mkdirSync(path.join(home, ".cache", "clawbox"), { recursive: true });
    const version = typeof stamped === "string" ? stamped : shellConst("KOKORO_STAMP_VERSION");
    writeFileSync(path.join(home, ".cache", "clawbox", "kokoro-installed"), `${version}\n`);
  }

  // `su - clawbox -c "<cmd>"` is how every pip/python step runs, so this stub
  // IS the pip call log the idempotence and no-STT assertions read.
  writeExec(
    path.join(bin, "su"),
    [
      'cmd=""',
      'while [ $# -gt 0 ]; do case "$1" in -c) cmd="$2"; shift 2;; *) shift;; esac; done',
      // Hand the payload to a REAL shell to parse before doing anything else.
      // `su` passes its -c string to the user's login shell, so a string that
      // shell cannot parse is a call that never happens — and that is exactly
      // what shipped: the model pre-download payload was
      //   -bash: -c: line 7: unexpected EOF while looking for matching `"'
      // on every box whose CUDA loader path resolved. These tests stayed green
      // through it because this stub only ever pattern-matched the string, and
      // because no test created the directories that make that path non-empty.
      `if ! bash -n -c "$cmd" 2>>"${suSyntaxLog}"; then printf '%s\\n---\\n' "$cmd" >> "${suSyntaxLog}"; fi`,
      // A payload that reads its program from stdin (`python3 -`, the form that
      // keeps a snippet out of shell-quoting entirely) carries it there, so the
      // log and the dispatch below have to see both halves.
      'stdin_code=""',
      'case "$cmd" in *"python3 -") stdin_code="$(cat)" ;; esac',
      'full=$(printf "%s\\n%s" "$cmd" "$stdin_code")',
      `printf '%s\\n---\\n' "$full" >> "${suLog}"`,
      'case "$full" in',
      // How the script asks the box which python pip --user will unpack the
      // cusparselt wheel under, instead of pinning the version it was written
      // against. A device answers "python3.10" (JetPack 6.2); the test host's
      // own python is irrelevant, so it is scripted here.
      '  *"sys.version_info"*) echo "${FAKE_PY_VERSION:-python3.10}"; exit 0 ;;',
      '  *"import kokoro, torch"*) exit "${KOKORO_IMPORT_EXIT:-1}" ;;',
      '  *"from kokoro import KPipeline"*) echo "Kokoro model ready on cuda"; exit "${WARMUP_EXIT:-0}" ;;',
      '  *"pip3 install"*) echo "Successfully installed"; exit "${PIP_EXIT:-0}" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  writeExec(
    path.join(bin, "uname"),
    [`[ "\${1:-}" = "-m" ] && { echo "\${FAKE_ARCH:-aarch64}"; exit 0; }`, 'exec /usr/bin/uname "$@"'].join(
      "\n",
    ),
  );
  // No network in a unit test: any download is a bug, and failing loudly here
  // makes it one the assertions can see.
  writeExec(path.join(bin, "curl"), [`printf '%s\\n' "$*" >> "${curlLog}"`, "exit 1"].join("\n"));
  // chown to a user that does not exist on the test host would otherwise fail
  // deploy_voice_scripts for a reason that has nothing to do with the code.
  // Logged as well as stubbed: this script runs as root in files the clawbox
  // user has to keep owning.
  writeExec(path.join(bin, "chown"), [`printf '%s\\n' "$*" >> "${chownLog}"`, "exit 0"].join("\n"));
  writeExec(path.join(bin, "loginctl"), "exit 0");
  if (env.WITH_CUDA === "1") {
    writeExec(path.join(bin, "nvcc"), 'echo "Cuda compilation tools, release 12.6, V12.6.68"');
  }

  // No second engine to pre-install: Kokoro is the only on-device voice, and
  // the pip/python steps that install it all go through the su stub above.

  const res = spawnSync("bash", [INSTALL_VOICE, mode], {
    encoding: "utf-8",
    timeout: 60_000,
    env: testEnv({
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      CLAWBOX_USER: "clawbox",
      CLAWBOX_HOME: home,
      // Point the /usr/local/cuda probe at nothing so a dev box or CI runner
      // that happens to have CUDA cannot turn the no-CUDA test green. With
      // WITH_CUDA_LIBS this is a real directory the block above created.
      CLAWBOX_CUDA_HOME: cudaHome,
      // Never /etc: the verdict file has to be somewhere a non-root test run
      // can actually write, or the "it publishes its verdict" assertions would
      // only ever be measuring the permission error.
      CLAWBOX_TTS_STATUS_FILE: ttsStatus,
      ...env,
    }),
  });

  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8") : "");
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    su: read(suLog).split("\n---\n").filter(Boolean),
    suSyntax: read(suSyntaxLog).trim(),
    curl: read(curlLog).trim().split("\n").filter(Boolean),
    chown: read(chownLog).trim().split("\n").filter(Boolean),
    ttsStatus: read(ttsStatus),
    home,
  };
}

// ── The step_openclaw_tts harness ───────────────────────────────────────────

/**
 * Run the real step_openclaw_tts against a stub `openclaw` and a stub
 * install-voice.sh whose exit code the test picks.
 *
 * @param voiceExit         the exit status the stub install-voice.sh reports.
 * @param currentProvider   what `openclaw config get messages.tts.provider`
 *                          answers. Non-empty puts the step on the
 *                          already-configured branch — the shipped-box update
 *                          path, which returns early.
 * @param ttsStatusContents what the stub "published" to $TTS_STATUS_FILE, or
 *                          null to leave the file absent. The step reads the
 *                          engine's REASON off this file, never off the exit
 *                          code, so a test about the wording has to write one.
 */
function runStep(voiceExit: number, currentProvider = "", ttsStatusContents: string | null = null, extraEnv: Record<string, string> = {}) {
  const projectDir = path.join(root, "project");
  const callsLog = path.join(root, "openclaw.log");
  const voiceArgs = path.join(root, "voice-args.log");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  writeExec(
    path.join(projectDir, "scripts", "install-voice.sh"),
    [`printf '%s\\n' "$*" >> "${voiceArgs}"`, `exit ${voiceExit}`].join("\n"),
  );
  const openclaw = path.join(root, "openclaw");
  writeExec(
    openclaw,
    [
      `echo "$*" >> "${callsLog}"`,
      'if [ "$1" = "config" ] && [ "$2" = "get" ]; then',
      `  [ "$3" = "messages.tts.provider" ] && printf '%s' "${currentProvider}"`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );

  const provisionLog = path.join(root, "provision-failures.log");
  const ttsStatus = path.join(root, "tts-status");
  if (ttsStatusContents !== null) writeFileSync(ttsStatus, ttsStatusContents);

  const program = [
    "set -uo pipefail",
    `PROJECT_DIR="${projectDir}"`,
    `OPENCLAW_BIN="${openclaw}"`,
    "CLAWBOX_USER=clawbox",
    'as_clawbox() { env "$@"; }',
    "is_hermes_edition() { return 1; }",
    // The real one appends to PROVISION_FAILURES, which the full install turns
    // into the summary, the exit status and the marker the flash host reads.
    // Logged here so a test can assert the step actually reaches for it: that
    // call is the difference between a failure the operator sees and one that
    // ends at a log line nobody greps.
    `record_provision_failure() { printf '%s\\n' "$1" >> "${provisionLog}"; }`,
    extractShellFn(INSTALL_SH, "oc_config_set"),
    extractShellFn(INSTALL_SH, "tts_ensure_provider_registered"),
    extractShellFn(INSTALL_SH, "tts_write_local_provider_definition"),
    // The real knob, not a stub: the test is about what the step does with it.
    extractShellFn(INSTALL_SH, "harness_has_no_gpu"),
    extractShellFn(INSTALL_SH, "step_openclaw_tts"),
    "step_openclaw_tts",
  ].join("\n");

  // TTS_STATUS_FILE travels as an environment variable rather than as an
  // interpolated shell assignment: JSON quoting is not shell quoting, and a
  // path is data, not script.
  const res = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...extraEnv, TTS_STATUS_FILE: ttsStatus },
  });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    voiceArgs: read(voiceArgs),
    openclaw: read(callsLog),
    /** Step names handed to record_provision_failure, one per entry. */
    provisionFailures: read(provisionLog),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kokoro-install-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasBash)("step_openclaw_tts installs the engine it advertises", () => {
  it("calls the Kokoro-capable mode, not --piper-only", () => {
    // The whole defect in one assertion: --piper-only cannot install Kokoro,
    // so a step that calls it can never make its own summary line true.
    const res = runStep(0);
    expect(res.status).toBe(0);
    expect(res.voiceArgs).toContain("--tts-only");
    expect(res.voiceArgs).not.toContain("--piper-only");
  });

  it("claims Kokoro only when install-voice.sh reports it ready", () => {
    const res = runStep(0);
    expect(res.stdout).toContain("On-device TTS configured (Kokoro GPU)");
    // And claims nothing behind it: there is no second engine to name.
    expect(res.stdout).not.toMatch(/fallback/i);
  });

  // 13 sits beside 12 in this table, and 10 and 11 are gone from it. The
  // two-engine release graded a no-CUDA board 10 ("the CPU fallback speaks")
  // and a non-aarch64 board 11; when the second engine was removed, this
  // branch briefly kept both codes and graded them CLEAN — "Kokoro does not
  // apply to this board, the gateway's cloud voice speaks for it". That
  // reading had a premise the installer cannot check: the cloud voice needs
  // the ClawBox AI link, which happens AFTER install. Every shipped ClawBox is
  // a Jetson a Kokoro build exists for, so a skipped Kokoro on real hardware
  // means something is wrong, and with no engine behind it that is a box with
  // no on-device voice at all. install-voice.sh exits 13 for it now and emits
  // neither 10 nor 11; the step records it. Both rows here are failures the
  // box survives — the difference is the fix, so the difference is the
  // sentence.
  it.each<[number, string | null, RegExp, RegExp]>([
    [13, "KOKORO=skipped:no-cuda\n", /NO working on-device TTS engine/, /declines Kokoro: no-cuda/],
    [12, null, /Kokoro is not available on this box/, /Kokoro GPU install failed/],
  ])("stays non-fatal and tells the truth when the voice install exits %i", (code, verdict, summary, reason) => {
    const res = runStep(code, "", verdict);
    // Non-fatal: the provider is still configured, because clawbox-tts.sh
    // reports a missing Kokoro as an exit-1 failure the gateway hands to its
    // cloud voice — refusing to configure TTS would cost the box that path too.
    expect(res.openclaw).toContain("config set messages.tts.provider tts-local-cli");
    // And the summary must not repeat the lie that hid this bug for a release,
    // nor swap it for a smaller one by naming a fallback the box does not have.
    expect(res.stdout).not.toContain("configured (Kokoro GPU)");
    expect(res.stdout).not.toMatch(/piper/i);
    expect(res.stdout).toMatch(summary);
    expect(res.stdout).toContain("cloud voice");
    expect(res.stdout).toMatch(reason);
  });

  it("exit 13 is a MUTE BOX: recorded, Kokoro and its reason named, and still non-fatal", () => {
    // The contract's 13, end to end. The two-engine release graded a board
    // that declined BOTH halves this way; the one-engine branch then argued a
    // box Kokoro declines "talks through the cloud voice" and graded it 0
    // with nothing recorded. That was the same class of untrue status line
    // pointed the other way: "Setup: 1/1 succeeded" over a box whose only
    // engine is absent, on the say-so of a cloud voice the installer has no
    // way to see.
    const res = runStep(13, "", "KOKORO=skipped:arch-x86_64\n");
    // 1. The caller's status — 13, the code step_openclaw_setup and
    //    step_post_update tolerate by name. The exact code, not merely
    //    non-zero: spawnSync reports null on a timeout, and null satisfies
    //    not.toBe(0).
    expect(res.status, "a box with no engine was graded a clean install").toBe(13);
    // 2. The provisioning record: summary + exit status + the marker file the
    //    flash host reads instead of parsing stdout.
    expect(res.provisionFailures, "a mute box was not recorded as a provisioning failure").toContain(
      "openclaw_tts",
    );
    // 3. Something an operator cannot scroll past — and it says WHICH engine
    //    is absent and WHY, off the verdict the run published. "No engine" on
    //    its own is not actionable: a board that declined for want of a Jetson
    //    build and one whose download failed lead to different fixes.
    expect(res.stderr).toMatch(/NO working on-device TTS engine/);
    expect(res.stderr).toMatch(/Kokoro/);
    expect(res.stderr).toMatch(/skipped:arch-x86_64/);
    expect(res.stderr).toMatch(/--step openclaw_tts/);
    // Not the 12 sentence: the engine was never REQUESTED on this board.
    expect(res.stderr).not.toMatch(/REQUESTED and did NOT install/);
    // 4. The summary line tells the same truth — no engine, the reason, and
    //    where the box's voice comes from once that CAN be checked — and names
    //    no engine the box does not have.
    expect(res.stdout).toMatch(/NO working on-device TTS engine/);
    expect(res.stdout).toContain("declines Kokoro: arch-x86_64");
    expect(res.stdout).toContain("cloud voice");
    expect(res.stdout).not.toContain("configured (Kokoro GPU)");
    expect(res.stdout).not.toMatch(/piper/i);
    // Still non-fatal for the box's voice: the provider is configured anyway,
    // so the box comes up reachable — and fixable.
    expect(res.openclaw).toContain("config set messages.tts.provider tts-local-cli");
  });

  it("on the GPU-less harness (CLAWBOX_TEST_NO_GPU=1) a declined Kokoro is still 13, still named, but not filed as a failure", () => {
    // The e2e-install container has no GPU by construction, so Kokoro
    // declines there on every run. The verdict, the return status and the
    // banner all stay — the harness must not be told it has a voice it lacks
    // — but the provisioning-failure record is withheld, because that record
    // is what fails service validation, and a check that fails every CI run
    // over a documented fact teaches everyone to ignore it where it matters.
    const res = runStep(13, "", "KOKORO=skipped:no-cuda\n", { CLAWBOX_TEST_NO_GPU: "1" });
    expect(res.status).toBe(13);
    expect(res.stderr).toMatch(/NO working on-device TTS engine/);
    expect(res.stdout).toContain("CLAWBOX_TEST_NO_GPU=1");
    expect(res.provisionFailures, "the harness's documented no-GPU state was filed as a provisioning failure").toEqual([]);
  });

  it("test mode alone does not soften the mute-box rule — only the explicit no-GPU knob does", () => {
    // Test mode is what the unit tests and the install harness both run the
    // installer under; the real-hardware rule has to survive it, or every
    // test that pins the rule would be pinning the exemption instead.
    const res = runStep(13, "", "KOKORO=skipped:no-cuda\n", { CLAWBOX_TEST_MODE: "1" });
    expect(res.status).toBe(13);
    expect(res.provisionFailures).toEqual(["openclaw_tts"]);
  });

  it("exit 13 with no verdict on file is still recorded, and invents no reason", () => {
    // The exit code says "no engine"; only the verdict file says why. When the
    // run published nothing, the step says so in as many words rather than
    // guessing at a board it cannot see — a made-up reason would send an
    // operator off to fix the wrong thing.
    const res = runStep(13);
    expect(res.status).toBe(13);
    expect(res.provisionFailures).toContain("openclaw_tts");
    expect(res.stderr).toMatch(/NO working on-device TTS engine/);
    expect(res.stderr).toMatch(/no verdict published/);
    expect(res.stdout).not.toMatch(/no-cuda|arch-/);
  });

  // ── Requested-and-failed is not the same outcome as never-requested ────────
  // The deeper defect, and the one that let a shell syntax error ship: the step
  // treated "this board has no CUDA" and "the GPU engine you asked for did not
  // install" as the same result — zero — so a flash host printed
  // "Setup: 1/1 succeeded" over a box that had told itself it was broken.
  // Both are failures now, and they are still kept apart: 13 is a board that
  // declines the only engine, 12 is an engine that was asked for and did not
  // arrive. Same silence for the listener, a different fix for the operator.

  it("exit 12 is a FAILURE: it leaves the step, the summary and the operator's screen", () => {
    const res = runStep(12);
    // 1. The caller's status. Under `set -e` this is what makes
    //    `install.sh --step openclaw_tts` — the form the in-app updater runs —
    //    exit non-zero instead of announcing a clean update.
    // The exact code, not merely non-zero: spawnSync reports status null on a
    // timeout, and `null` satisfies not.toBe(0) — a hung harness would score as
    // a pass for the very assertion this test exists to make.
    expect(res.status, "a requested engine that did not install still exited 0").toBe(12);
    // 2. The provisioning record: summary + exit status + the marker file the
    //    flash host reads instead of parsing stdout.
    expect(res.provisionFailures).toContain("openclaw_tts");
    // 3. Something an operator cannot scroll past, with the one command that
    //    retries it.
    expect(res.stderr).toMatch(/Kokoro GPU TTS was REQUESTED and did NOT install/);
    expect(res.stderr).toMatch(/--step openclaw_tts/);
    // Still non-fatal for the box's voice: the provider is configured anyway.
    // With Kokoro down, clawbox-tts.sh exits 1 with the reasons and the
    // gateway's cloud voice answers; the operator's screen says so.
    expect(res.openclaw).toContain("config set messages.tts.provider tts-local-cli");
    expect(res.stderr).toMatch(/cloud voice/);
  });

  it.each([12, 13])("carries a %i through even when the owner's provider is preserved", (code) => {
    // The update path on a shipped box: messages.tts.provider is already set,
    // so the step returns early. Returning 0 from there would drop the verdict
    // on exactly the population that has the defect — and without a provider in
    // the stub's answer this case never reaches that branch at all, it just
    // retreads the one above. 13 rides the same branch: a shipped box whose
    // only engine has gone missing on an update is still a recorded failure.
    const res = runStep(code, "tts-local-cli");
    expect(res.stdout, "the preserve branch was never reached").toContain("preserved");
    expect(res.status).toBe(code);
    expect(res.provisionFailures).toContain("openclaw_tts");
  });

  it("defines the on-device provider even when another provider is preserved", () => {
    // A box whose speech provider is the cloud voice used to return before
    // the tts-local-cli entry was ever written, so an installed Kokoro was
    // "not available" to the Local AI tab. The selection is still preserved;
    // only the DEFINITION is written, so the box can be switched later.
    const res = runStep(0, "openai");
    expect(res.stdout).toContain("preserving");
    expect(res.openclaw.some((c) => c.startsWith("config set messages.tts.providers.tts-local-cli "))).toBe(true);
    expect(res.openclaw).not.toContain("config set messages.tts.provider tts-local-cli");
    expect(res.openclaw.some((c) => c.startsWith("config set messages.tts.provider "))).toBe(false);
  });

  it("hands install-voice.sh the verdict path so both halves cannot drift", () => {
    // Two independent defaults for the same file is how the writer and the
    // health check end up looking at different paths and agreeing forever.
    const step = extractShellFn(INSTALL_SH, "step_openclaw_tts");
    expect(step).toContain("CLAWBOX_TTS_STATUS_FILE=");
  });

  it("warns about a failed script deploy in terms of the deploy, not of Kokoro", () => {
    // The old wording said "Kokoro still works, but a GPU failure will be
    // silent" — written when Kokoro was assumed present, which it never was.
    const res = runStep(1);
    // 14, not 0. Returning 0 here is what left PROVISION_FAILURES empty for a
    // box whose voice install had not completed, so the run printed Setup
    // Complete over it (TTS-01); the step now records the failure and says so
    // in its status. It stays out of the fatal range because a failed script
    // deploy must not abort an otherwise good install — see
    // step_openclaw_setup, which tolerates 12, 13 and 14 and nothing else. It
    // is deliberately NOT 13: that code means the box has no engine, and exit
    // 1 says nothing of the kind.
    expect(res.status).toBe(14);
    expect(res.stderr).toMatch(/voice scripts did not deploy/);
    expect(res.stderr).not.toMatch(/Kokoro still works/);
    // Exit 1 carries no engine verdict, so the summary must name none: not a
    // working Kokoro, and not the removed fallback either.
    expect(res.stdout).not.toContain("configured (Kokoro GPU)");
    expect(res.stdout).not.toMatch(/piper/i);
    // Nor the opposite lie. install-voice.sh returns 12, not 1, when Kokoro
    // itself failed, so "NO engine is confirmed installed" here would be a
    // failure report over something that may well have succeeded (TTS-01).
    expect(res.stdout).not.toContain("NO engine is confirmed installed");
    expect(res.stdout).toContain("the voice install did not complete");
  });
});

describe.skipIf(!hasBash)("install-voice.sh --tts-only on a fresh CUDA box", () => {
  it("installs the Jetson torch wheel, kokoro, and the model, then reports ready", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.status, res.stderr).toBe(0);

    const pip = res.su.filter((c) => c.includes("pip3 install"));
    const torchUrl = shellConst("JETSON_TORCH_URL");
    expect(pip.some((c) => c.includes(torchUrl)), "the Jetson CUDA torch wheel is never installed").toBe(true);
    expect(pip.some((c) => c.includes("nvidia-cusparselt-cu12"))).toBe(true);
    expect(pip.some((c) => c.includes("kokoro"))).toBe(true);
    // transformers<5 must stay its OWN pip step: pip 22's resolver will not
    // downgrade huggingface-hub inside a single command and silently picks 5.x.
    const combined = pip.find((c) => c.includes("kokoro"));
    expect(combined).not.toContain("transformers<5");
    expect(pip.some((c) => c.includes("transformers<5"))).toBe(true);

    // Warm the cache here, or the first spoken reply is a 300 MB download.
    expect(res.su.some((c) => c.includes("from kokoro import KPipeline"))).toBe(true);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=ready");
  });

  it("asks for a numpy the Jetson torch wheel can actually use", () => {
    // `numpy<2` on its own is a NO-OP on this hardware: JetPack ships numpy
    // 1.21.5 as an apt package in /usr/lib/python3/dist-packages, which
    // already satisfies it, so pip installed nothing and the torch wheel could
    // not use what was there —
    //   $ kokoro -t "..." -o /tmp/k1.wav -m af_heart -l a
    //   RuntimeError: Numpy is not available        (a 44-byte output file)
    // With the floor, 1.26.4 lands in user-site and the same command produced
    // 105,644 bytes of audio. A test that only checked the ceiling is what let
    // that ship, so this one reads the floor and refuses a missing one.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const step = res.su.filter((c) => c.includes("pip3 install")).find((c) => c.includes("kokoro"));
    expect(step, "no pip step installs kokoro at all").toBeDefined();

    // Read the requirement and its constraints rather than pattern-matching
    // the line. A regex that just looked for "<2" was satisfied by "<2.5" and
    // by "<20" — it matched the prefix and let the rest fall outside — which
    // is the numpy-2.x breakage the ceiling is here to prevent, passing CI.
    // The quotes are part of the requirement: `<` unquoted is a redirection.
    const req = /'(numpy[^']*)'/.exec(step!)?.[1];
    expect(req, `no quoted numpy requirement in: ${step}`).toBeDefined();
    const constraints = req!.slice("numpy".length).split(",").map((c) => c.trim());
    const version = (v: string) => {
      const [maj = 0, min = 0, patch = 0] = v.split(".").map(Number);
      return maj * 1_000_000 + min * 1_000 + patch;
    };
    const floor = constraints.find((c) => c.startsWith(">="));
    const ceiling = constraints.find((c) => /^<[^=]/.test(c));

    expect(
      floor,
      `numpy is pinned without a floor (${req}) — the board's apt numpy 1.21.5 already satisfies <2, so pip installs nothing`,
    ).toBeDefined();
    // The measured-good version is 1.26.4; 1.21.5 is the one that makes torch
    // raise "Numpy is not available".
    expect(version(floor!.slice(2)), `the numpy floor ${floor} is below 1.24`).toBeGreaterThanOrEqual(version("1.24"));
    // And the ceiling stays: torch 2.5.0a0+872d972e41.nv24.8 is a numpy-1.x
    // build, so an unbounded numpy breaks it the other way.
    expect(ceiling, `numpy is pinned without a ceiling (${req})`).toBeDefined();
    expect(version(ceiling!.slice(1)), `the numpy ceiling ${ceiling} admits numpy 2.x`).toBeLessThanOrEqual(
      version("2"),
    );
    // A floor at or above the ceiling is unsatisfiable — pip only says so at
    // install time, on the device, an hour into an update.
    expect(version(floor!.slice(2))).toBeLessThan(version(ceiling!.slice(1)));
  });

  it("writes the kokoro-server user unit and enables lingering", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const unit = path.join(res.home, ".config/systemd/user/kokoro-server.service");
    expect(existsSync(unit), "no kokoro-server unit was installed").toBe(true);
    const body = readFileSync(unit, "utf-8");
    expect(body).toContain("ExecStart=/usr/bin/python3");
    expect(body).toContain("kokoro-server.py");
    // The loader path has to name THIS box's home, not the one the script was
    // written against. Asserting only /cusparselt/ is what a hardcoded
    // /home/clawbox/.local/lib/python3.10/... satisfies just as happily.
    expect(unitLdPath(body), "the unit's LD_LIBRARY_PATH is not derived from CLAWBOX_HOME").toContain(
      `${res.home}/.local/lib`,
    );
    expect(unitLdPath(body)).toContain("cusparselt");
    expect(res.su.some((c) => c.includes("systemctl --user daemon-reload"))).toBe(true);
  });

  it("points the unit at the python that is on the box, not a pinned version", () => {
    // A wheel already unpacked under some python version is the authoritative
    // answer, and it is found with a python* glob — a unit pinned to
    // python3.10 would send this box's `import torch` at a directory that does
    // not exist, which is the ImportError this whole task exists to remove.
    const cusparselt = path.join(root, "home/clawbox/.local/lib/python3.13/site-packages/nvidia/cusparselt/lib");
    mkdirSync(cusparselt, { recursive: true });
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", FAKE_PY_VERSION: "python3.9" });
    const ld = unitLdPath(readFileSync(path.join(res.home, ".config/systemd/user/kokoro-server.service"), "utf-8"));
    expect(ld, "the real site-packages directory was not the one written").toContain(cusparselt);
    expect(ld).not.toContain("python3.10");
    expect(ld).not.toContain("python3.9");
  });

  it("still names the cusparselt directory when the wheels are not unpacked yet", () => {
    // The deliberate difference from clawbox-tts.sh, which runs at speech time
    // and can drop what is missing: this unit is written BEFORE the wheel is
    // installed and is then read for the life of the box. Filtering on
    // existence here would ship a unit with no cusparselt entry at all — the
    // same broken import, arrived at more quietly.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", FAKE_PY_VERSION: "python3.11" });
    const ld = unitLdPath(readFileSync(path.join(res.home, ".config/systemd/user/kokoro-server.service"), "utf-8"));
    expect(ld, "a missing directory was silently dropped from the unit").toContain(
      `${res.home}/.local/lib/python3.11/site-packages/nvidia/cusparselt/lib`,
    );
    // An empty entry means "the current directory" to the loader.
    expect(ld).not.toContain("::");
    expect(ld.startsWith(":") || ld.endsWith(":")).toBe(false);
  });

  it("leaves the .bashrc it appends to owned by the clawbox user", () => {
    // install_cuda_torch runs as ROOT and appends with `>>`, which creates the
    // file when it is missing — a box whose clawbox user had no .bashrc would
    // get a root-owned one it can never edit again. The exports still load,
    // so nothing here fails loudly; the user just loses their own file.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const bashrc = path.join(res.home, ".bashrc");
    const body = readFileSync(bashrc, "utf-8");
    expect(body, "the loader path is not exported for interactive shells").toContain("cusparselt");
    // Derived here too: this line is appended once and sourced for the life of
    // the box, so a pinned /home/clawbox would outlive the run that wrote it.
    expect(body).toContain(`${res.home}/.local/lib`);
    expect(res.chown.some((c) => c.includes("clawbox:clawbox") && c.includes(bashrc)), "the .bashrc was never chowned back to the user").toBe(true);
  });

  it("still deploys the TTS entrypoint and the server script alongside it", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const entrypoint = path.join(res.home, ".openclaw/workspace/scripts/openclaw/clawbox-tts.sh");
    expect(existsSync(entrypoint)).toBe(true);
    expect(existsSync(path.join(res.home, ".openclaw/workspace/scripts/kokoro-server.py"))).toBe(true);
    // And nothing else: no second engine is fetched, unpacked or reported.
    expect(res.curl, "something was downloaded by hand").toEqual([]);
    expect(res.stdout).not.toMatch(/piper/i);
  });

  it("never runs the STT half — it would add about an hour to every update", () => {
    // This path runs from step_post_update on EVERY in-app update. Pulling
    // faster-whisper, building CTranslate2 from source with CUDA, and
    // downloading the Whisper weights is roughly an hour on an Orin.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const all = res.su.join("\n");
    for (const forbidden of ["faster-whisper", "CTranslate2", "WhisperModel", "cmake", "git clone"]) {
      expect(all, `--tts-only ran the STT step: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe.skipIf(!hasBash)("install-voice.sh --tts-only is cheap on re-run", () => {
  it("downloads nothing when a previous run already finished the install", () => {
    // The update path. Re-fetching a ~300 MB wheel on a box that already works
    // is how a five-minute update becomes a twenty-minute one.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "0" }, true);
    expect(res.status, res.stderr).toBe(0);
    expect(res.su.filter((c) => c.includes("pip3 install")), "the heavy pip work ran again").toEqual([]);
    expect(
      res.su.filter((c) => c.includes("pipeline.model.parameters")),
      "the model pre-download ran again",
    ).toEqual([]);
    // The phonemiser check is deliberately NOT skipped on this path. A box that
    // already has the stack is exactly the box a broken espeakng-loader wheel is
    // found on — `import kokoro, torch` succeeds either way — and skipping it
    // here would mean the fleet update carrying the check never runs it. It
    // costs a pipeline construction against an already-cached model, not a
    // download; the curl assertion below is what pins that.
    expect(
      res.su.filter((c) => c.includes("zorblattic")),
      "the phonemiser check was skipped on the box that most needs it",
    ).toHaveLength(1);
    expect(res.curl, "something was downloaded on a no-op run").toEqual([]);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=ready");
  });

  it("still refreshes the scripts and the unit on that cheap run", () => {
    // Skipping the download must not skip the delivery: a box whose
    // kokoro-server.py or unit is stale after an update is a box that stops
    // speaking for a reason nobody changed.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "0" }, true);
    expect(existsSync(path.join(res.home, ".config/systemd/user/kokoro-server.service"))).toBe(true);
    expect(existsSync(path.join(res.home, ".openclaw/workspace/scripts/kokoro-server.py"))).toBe(true);
  });

  it("redoes the install on a box stamped by the release that got numpy wrong", () => {
    // The stamp makes an update cheap, and it is also how a fix to the pip
    // steps can miss exactly the boxes that need it. A box that installed
    // `numpy<2` — a no-op against the board's apt 1.21.5 — passes BOTH halves
    // of kokoro_stack_present(): the stamp is there, and `import kokoro,
    // torch` succeeds, because torch imports fine and only raises "Numpy is
    // not available" later at the tensor conversion. Bumping the version is
    // what makes such a box redo the pip steps.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "0" }, "1");
    expect(res.status, res.stderr).toBe(0);
    expect(
      res.su.some((c) => c.includes("pip3 install") && c.includes("numpy")),
      "a box stamped by the old version never redid the numpy step",
    ).toBe(true);
    expect(shellConst("KOKORO_STAMP_VERSION"), "the numpy fix shipped without bumping the stamp").not.toBe("1");
  });

  // One run per test: runTtsOnly reuses the per-test temp root, so a second
  // call in the same test would inherit the first one's stamp.
  it("records the completion stamp once every step has landed", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(existsSync(path.join(res.home, ".cache/clawbox/kokoro-installed"))).toBe(true);
  });

  it("does not stamp an install that failed part-way", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", WARMUP_EXIT: "1" });
    expect(res.status).toBe(12);
    expect(
      existsSync(path.join(res.home, ".cache/clawbox/kokoro-installed")),
      "a failed install was stamped as complete",
    ).toBe(false);
  });

  it("redoes a half-finished install instead of latching it in as ready", () => {
    // The trap this gate has to avoid. The packages land BEFORE the
    // transformers pin and BEFORE the model download, so a run that died at
    // either leaves `import kokoro, torch` working with the job half done.
    // Gating on importability alone would report that box ready on every
    // update from then on, while its first spoken reply still paid for the
    // 300 MB the warm-up was supposed to have fetched — the same over-claim
    // TASK-420 exists to remove, one layer deeper.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "0" }); // imports, but never stamped
    expect(res.status, res.stderr).toBe(0);
    expect(res.su.some((c) => c.includes("from kokoro import KPipeline")), "the model was never fetched").toBe(
      true,
    );
    expect(res.su.some((c) => c.includes("transformers<5")), "the transformers pin was never redone").toBe(true);
    expect(existsSync(path.join(res.home, ".cache/clawbox/kokoro-installed"))).toBe(true);
  });
});

describe.skipIf(!hasBash)("install-voice.sh --tts-only never costs the box its voice", () => {
  it("survives a failed pip: exit 12, entrypoint intact, no claim of Kokoro", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", PIP_EXIT: "1" });
    expect(res.status, "a GPU failure must be reported, not fatal").toBe(12);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=failed:torch");
    expect(res.stdout).not.toContain("CLAWBOX_TTS_KOKORO=ready");
    // The entrypoint is deployed BEFORE Kokoro is attempted precisely so this
    // is true: it is what turns "Kokoro is down" into an exit-1 report the
    // gateway can hand to its cloud voice, instead of a missing command.
    expect(existsSync(path.join(res.home, ".openclaw/workspace/scripts/openclaw/clawbox-tts.sh"))).toBe(true);
    expect(res.stderr).toMatch(/no on-device voice/);
  });

  it("survives a failed model pre-download the same way", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", WARMUP_EXIT: "1" });
    expect(res.status).toBe(12);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=failed:model");
  });

  it("skips Kokoro with a stated reason when there is no CUDA — a mute box, exit 13", () => {
    const res = runTtsOnly({ KOKORO_IMPORT_EXIT: "1" });
    // 13, not 10. 10 meant "GPU skipped, the CPU fallback speaks", and there
    // is no fallback to speak: a board Kokoro declines has no on-device voice,
    // and whether a cloud voice will ever be linked is not something this
    // installer can see. A run that exited clean here was scored a healthy
    // provision by install.sh, and the box answered spoken requests with
    // silence.
    expect(res.status).toBe(13);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=skipped:no-cuda");
    expect(res.stdout).toMatch(/no CUDA toolkit/);
    // Skipping means skipping: no wheel, no packages, no pretending.
    expect(res.su.filter((c) => c.includes("pip3 install"))).toEqual([]);
    // And the report names the engine and the concrete reason it is absent,
    // rather than sending the operator to the verdict file to find out.
    expect(res.stderr).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.stderr).toMatch(/SILENCE/);
    expect(res.stderr).toMatch(/Kokoro \(GPU\): SKIPPED \(no-cuda\)/);
    expect(res.stderr).toMatch(/Verdict recorded in/);
  });

  it("skips Kokoro on an architecture with no Jetson build, and fails the run", () => {
    // The CUDA torch wheel is aarch64-only; installing "something" and
    // reporting Kokoro would be the exact lie TASK-420 removed. So this board
    // declines the only engine and has nothing to speak with — 13, the code
    // install.sh records, rather than the 11 the one-engine branch briefly
    // handed back as a clean provision. The verdict is unchanged: which
    // engine skipped and why is still published, and it is the verdict, not
    // the exit code, that install.sh and the health check read.
    const res = runTtsOnly({ FAKE_ARCH: "x86_64", WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.status).toBe(13);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=skipped:arch-x86_64");
    expect(res.su.filter((c) => c.includes("pip3 install"))).toEqual([]);
    expect(res.stderr).toMatch(/Kokoro \(GPU\): SKIPPED \(arch-x86_64\)/);
    // A skip is not the 12 report: nothing was requested, so nothing "did NOT
    // install". The two are kept apart because they lead to different fixes.
    expect(res.stderr).not.toMatch(/did NOT install/);
  });
});

describe("the --piper-only entry point is gone with the engine it installed", () => {
  it("is named nowhere: not as a mode, not in the entrypoint's hint", () => {
    // It survived one release as "older devices' scripts call it". Nothing
    // does — install.sh and install-voice.sh update together — and keeping a
    // mode that installs a removed engine is how the engine comes back.
    const tts = readFileSync(path.join(REPO, "scripts/openclaw/clawbox-tts.sh"), "utf-8");
    expect(tts).not.toContain("--piper-only");
    expect(INSTALL_VOICE_SH).not.toContain("--piper-only");
    expect(INSTALL_VOICE_SH).not.toContain("install_piper");
  });

  it.skipIf(!hasBash)("is refused with exit 2 like any unknown option, not taken as the full pipeline", () => {
    // The no-flag path builds CTranslate2 from source — about an hour — and
    // the fallback-only flag used to land on it. A stale caller must hear "no
    // such mode" and nothing must run: no deploy, no pip, no verdict.
    const res = runTtsOnly({}, false, "--piper-only");
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown option '--piper-only'/);
    expect(res.su, "an unknown option ran an install step").toEqual([]);
    expect(res.ttsStatus, "an unknown option published a verdict").toBe("");
  });
});

// ── The payload every python step is handed must be shell a shell can run ────
//
// `su - clawbox -c "<payload>"` hands <payload> to the user's login shell, so a
// payload that shell cannot PARSE is a call that never happens. One shipped:
//
//   Pre-downloading Kokoro model...
//   -bash: -c: line 7: unexpected EOF while looking for matching `"'
//   -bash: -c: line 8: syntax error: unexpected end of file
//   ERROR: Kokoro model pre-download failed — leaving TTS on the Piper fallback
//
// captured from a factory-fresh box during its first-boot update. The cause was
// one line in clawbox_python():
//
//   ${ld:+export LD_LIBRARY_PATH=\"$ld\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\"}
//
// bash ends a ${var:+word} at the first UNESCAPED `}` — which was the one
// closing the INNER ${LD_LIBRARY_PATH:+...} — so the trailing `\"}` fell
// outside the expansion and emitted the quote and the brace in the wrong
// order: `...:$LD_LIBRARY_PATH"}` instead of `...:$LD_LIBRARY_PATH}"`. The
// stray quote swallowed the rest of the line and every payload became a syntax
// error, on every box where $ld resolved — which is every box that has CUDA.
// The graceful fallback to Piper then hid it: speech still worked, on the wrong
// engine, and the flash reported success.

describe.skipIf(!hasBash)("every su payload is shell a login shell can actually run", () => {
  it("hands su nothing bash refuses to parse, on a box whose loader path resolves", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", WITH_CUDA_LIBS: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(
      res.suSyntax,
      `bash refused to parse a payload install-voice.sh handed su:\n${res.suSyntax}`,
    ).toBe("");
    expect(res.status, res.stderr).toBe(0);
  });

  it("still parses when nothing resolved and the export is skipped", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.suSyntax, res.suSyntax).toBe("");
  });

  it("actually puts the cusparselt directory on LD_LIBRARY_PATH for the warm-up", () => {
    // The functional half. Without this export `import torch` on a Jetson dies
    // with `ImportError: libcusparseLt.so.0: cannot open shared object file` —
    // the library that ships inside the nvidia-cusparselt-cu12 wheel, under
    // user-site, where no loader looks by default. That is the error the
    // affected box answered with, which is how the missing export was
    // confirmed on device rather than inferred from the script.
    const res = runTtsOnly({ WITH_CUDA: "1", WITH_CUDA_LIBS: "1", KOKORO_IMPORT_EXIT: "1" });
    const warm = res.su.find((c) => c.includes("from kokoro import KPipeline"));
    expect(warm, "the model warm-up never ran at all").toBeDefined();
    expect(warm).toMatch(/export LD_LIBRARY_PATH=/);
    expect(warm).toContain("nvidia/cusparselt/lib");
  });

  it("omits the export rather than leading LD_LIBRARY_PATH with an empty entry", () => {
    // An empty entry means "the current directory" to the loader, which is not
    // a place to resolve .so files from.
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    const warm = res.su.find((c) => c.includes("from kokoro import KPipeline"));
    expect(warm).toBeDefined();
    expect(warm).not.toContain("LD_LIBRARY_PATH");
  });

  it("keeps the snippet out of the shell string entirely", () => {
    // The structural fix, asserted structurally: the python program travels on
    // stdin, so no amount of quoting inside it can terminate a shell quote.
    // Another layer of escaping would have passed the tests above and broken on
    // the next edit — this is the property that stops the bug class, not just
    // this instance of it.
    const fn = extractShellFn(INSTALL_VOICE_SH, "clawbox_python");
    expect(fn).toContain("python3 -");
    expect(fn).not.toContain('python3 -c \\"');
  });
});

// ── A hard failure must stop being reported as a soft fallback ───────────────

describe.skipIf(!hasBash)("the Kokoro verdict outlives the run", () => {
  it("publishes failed:model where something other than stdout can read it", () => {
    const res = runTtsOnly({
      WITH_CUDA: "1",
      WITH_CUDA_LIBS: "1",
      KOKORO_IMPORT_EXIT: "1",
      WARMUP_EXIT: "1",
    });
    expect(res.status).toBe(12);
    expect(res.ttsStatus).toContain("KOKORO=failed:model");
  });

  it("publishes skipped:* as its own verdict — never failed:*, never ready", () => {
    // The run itself is graded 13 (a mute box), but the VERDICT stays its own
    // word: install.sh and the health check read the file, not the exit code,
    // and "this board declines the engine" and "the engine did not install"
    // lead to different fixes.
    const res = runTtsOnly({ KOKORO_IMPORT_EXIT: "1" });
    expect(res.status).toBe(13);
    expect(res.ttsStatus).toContain("KOKORO=skipped:no-cuda");
    expect(res.ttsStatus).not.toContain("failed");
    expect(res.ttsStatus).not.toContain("ready");
  });

  it("publishes ready when the engine genuinely landed", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", WITH_CUDA_LIBS: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.ttsStatus).toContain("KOKORO=ready");
  });
});

// ── The health check that makes "flashed successfully" mean something ────────

/**
 * Run the real step_validate_services with everything except the TTS verdict
 * stubbed healthy. `ttsStatusContents` is written to the verdict file, or the
 * file is left absent when it is null.
 */
function runValidator(ttsStatusContents: string | null, extraEnv: Record<string, string> = {}): { status: number; out: string } {
  const ttsStatus = path.join(root, "validator-tts-status");
  if (ttsStatusContents !== null) writeFileSync(ttsStatus, ttsStatusContents);
  const clock = path.join(root, "clock");
  writeFileSync(clock, "1000\n");

  const program = [
    "set -uo pipefail",
    "CLAWBOX_EDITION=openclaw",
    "CLAWBOX_TEST_MODE=1",
    "PROJECT_DIR=/home/clawbox/clawbox",
    'IFACE_ENV="/nonexistent/network.env"',
    // The unit registry is another file's subject; empty lists keep this test
    // about the one probe it is here to pin.
    "EXPECTED_ACTIVE_SERVICES=()",
    "EXPECTED_INSTALLED_SERVICES=()",
    "FOREIGN_EDITION_UNITS=()",
    'is_test_mode() { [ "$CLAWBOX_TEST_MODE" = "1" ]; }',
    'is_hermes_edition() { [ "$CLAWBOX_EDITION" = "hermes" ]; }',
    "has_hermes_harness() { return 1; }",
    extractShellFn(INSTALL_SH, "harness_has_no_gpu"),
    "gateway_port_listening() { return 1; }",
    "systemctl() { return 0; }",
    "curl() { printf '200'; }",
    // The poll loop reads `date +%s` twice per pass and gives up after 30s. A
    // file-backed clock that jumps 100s per read makes a failing run finish in
    // one pass instead of polling for half a minute.
    `_CLOCK="${clock}"`,
    'date() { local n; n=$(( $(cat "$_CLOCK") + 100 )); echo "$n" > "$_CLOCK"; printf %s "$n"; }',
    "sleep() { :; }",
    extractShellFn(INSTALL_SH, "step_validate_services"),
    "step_validate_services",
  ].join("\n");

  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...extraEnv, TTS_STATUS_FILE: ttsStatus },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("service validation refuses to call a Kokoro-less box healthy", () => {
  it("fails the install when the GPU engine was requested and did not install", () => {
    // The probe's sentence used to end "— this box answers speech on the Piper
    // CPU fallback": a fallback claim made from an UNREPORTED verdict. There is
    // no fallback to claim now. The arm names the one engine, quotes the
    // verdict it read (an operator should not have to open the file to learn
    // what the run already knew), and says where the box's voice comes from
    // until it is fixed — without asserting an engine it has not seen.
    const res = runValidator("KOKORO=failed:model\n");
    expect(res.status, `validation passed a box with no GPU TTS:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/requested and did NOT install/);
    expect(res.out).toMatch(/failed:model/);
    expect(res.out).toMatch(/cloud voice/);
    expect(res.out, "a fallback was claimed from an unreported verdict").not.toMatch(/piper/i);
    expect(res.out).toMatch(/--step openclaw_tts/);
  });

  it("passes the GPU-less harness (CLAWBOX_TEST_NO_GPU=1) with the declined engine named, not hidden", () => {
    // Same verdict as the mute-box case above, on the one host that declares
    // it has no GPU by construction. The probe still says what it read — an
    // operator reading the harness log learns the engine declined and why —
    // it just does not count that as a failed probe there.
    const res = runValidator("KOKORO=skipped:no-cuda\n", { CLAWBOX_TEST_NO_GPU: "1" });
    expect(res.status, `the harness's documented no-GPU state failed validation:\n${res.out}`).toBe(0);
    expect(res.out).toMatch(/CLAWBOX_TEST_NO_GPU=1/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });

  it("the no-GPU knob excuses a DECLINED engine only — a requested Kokoro that failed still fails the harness", () => {
    // "No GPU here" explains a skip; it does not explain a GPU install that
    // was attempted and died, which on the harness would mean the install
    // path itself is broken.
    const res = runValidator("KOKORO=failed:model\n", { CLAWBOX_TEST_NO_GPU: "1" });
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/requested and did NOT install/);
  });

  it("is not rescued by a stale PIPER=ready line left by an earlier release", () => {
    // The fixture the two-engine probe used to reach its Kokoro-specific arm
    // — a failed Kokoro beside a ready Piper. The probe reads KOKORO= only
    // now; a PIPER= line is a leftover of a release that still shipped the
    // CPU fallback, and reading it as a working engine would put the removed
    // engine back into the health check by way of an old file.
    const res = runValidator("KOKORO=failed:model\nPIPER=ready\n");
    expect(res.status, `a stale fallback line passed a box with no GPU TTS:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/requested and did NOT install/);
    expect(res.out, "an engine that no longer exists was named").not.toMatch(/piper/i);
  });

  it("FAILS a board that was never going to run Kokoro — with one engine, a skip is a mute box", () => {
    // This probe briefly passed `skipped:*`: "no CUDA is not a defect, and
    // failing every non-Jetson install would teach everyone to ignore this
    // check". That reasoning had a second engine behind it. With Kokoro the
    // only on-device voice, a board that declines it has none, and whether
    // the cloud voice will speak for it is not something this installer can
    // see — that needs the ClawBox AI link, which happens after install.
    // Every shipped ClawBox is a Jetson a Kokoro build exists for, so a
    // skipped Kokoro on real hardware means something is wrong: the same
    // recorded, named 13 as step_openclaw_tts, checked again here from the
    // file. KOKORO= is the only key the probe reads.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `validation passed a box with no engine at all:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/skipped:no-cuda/);
    expect(res.out).toMatch(/cloud voice/);
    expect(res.out, "an engine that no longer exists was named").not.toMatch(/piper/i);
    expect(res.out).toMatch(/--step openclaw_tts/);
    // Not the failed:* sentence either: nothing was requested on this board.
    expect(res.out).not.toMatch(/requested and did NOT install/);
  });

  it("passes a box that has the engine", () => {
    expect(runValidator("KOKORO=ready\n").status).toBe(0);
  });

  it("reads a CRLF verdict rather than mistaking a ready engine for an unreadable one", () => {
    // The file is also restored from tarballs and edited by hand. `ready\r`
    // is `ready`, and `skipped:no-cuda\r` is still the mute box — named
    // without the stray carriage return, not refused as out of vocabulary.
    expect(runValidator("KOKORO=ready\r\n").status).toBe(0);
    const res = runValidator("KOKORO=skipped:no-cuda\r\n");
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/\(skipped:no-cuda\)/);
    expect(res.out).not.toMatch(/unrecognised/);
  });

  it("refuses to read a MISSING verdict as a healthy one", () => {
    // "No answer" scoring as a pass is the same bug one level up, and this
    // codebase has shipped it more than once.
    const res = runValidator(null);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/no on-device TTS verdict/);
  });
});

// ── The call site must not launder a hard failure into a warning ─────────────
//
// step_openclaw_tts returns 12 for "Kokoro was requested and did not install"
// and 13 for "this board declines the only engine" — both survivable (the box
// must come up reachable to be fixed) and both already carried by
// record_provision_failure, the marker and the validator's TTS probe. It
// also returns 1 from six OTHER paths that mean the box has no working speech
// path at all: no clawbox-tts.sh, a tts-local-cli plugin that will not resolve,
// a provider definition or selection that never landed.
//
// Those were fatal before the 12 case existed, because step_openclaw_setup is
// called bare under `set -e`. Tolerating every non-zero return here would have
// recreated this PR's own bug one layer up — a successful-looking flash over a
// box that cannot speak, with nothing in the marker to say so.

/**
 * Run the real step_openclaw_setup with the three steps before the TTS one
 * stubbed out and step_openclaw_tts scripted to exit `ttsExit`, so the call
 * site's handling of that status is what is under test.
 */
function runOpenclawSetup(ttsExit: number): { status: number; out: string } {
  const program = [
    "set -euo pipefail",
    "PROJECT_DIR=/nonexistent",
    "is_hermes_edition() { return 1; }",
    "step_openclaw_install() { :; }",
    "step_openclaw_patch() { :; }",
    "step_openclaw_config() { :; }",
    `step_openclaw_tts() { return ${ttsExit}; }`,
    extractShellFn(INSTALL_SH, "step_openclaw_setup"),
    "step_openclaw_setup",
    'echo "SETUP_COMPLETED=$?"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], { encoding: "utf-8", timeout: 60_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("the openclaw setup step weighs the TTS result", () => {
  it("continues when everything worked", () => {
    const res = runOpenclawSetup(0);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("SETUP_COMPLETED=0");
  });

  it("continues past a Kokoro-only failure, saying so", () => {
    const res = runOpenclawSetup(12);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("SETUP_COMPLETED=0");
    expect(res.out).toMatch(/Kokoro GPU TTS did not install/);
  });

  it("continues past a mute box, saying so", () => {
    // 13 is recorded by the step itself; the call site's job is to let the box
    // finish provisioning so it comes up reachable, and to say why in the same
    // words step_post_update uses for the code.
    const res = runOpenclawSetup(13);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("SETUP_COMPLETED=0");
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it.each([1, 2])("stays FATAL on a provider-configuration failure (exit %i)", (code) => {
    // A box with no configured speech path must not finish provisioning quietly.
    // `set -e` carries this out of step_openclaw_setup and aborts the install,
    // which is exactly what it did before the Kokoro tolerance was added.
    const res = runOpenclawSetup(code as number);
    // The exact code, not merely non-zero: `set -e` exits with the failing
    // command's own status, and asserting it rules out a null from a spawn
    // timeout quietly standing in for a propagated failure.
    expect(res.status, `a hard TTS failure was swallowed:\n${res.out}`).toBe(code);
    expect(res.out).not.toContain("SETUP_COMPLETED=");
  });
});
