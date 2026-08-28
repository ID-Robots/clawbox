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
 *   2. Its exit status carries what happened to Kokoro — 0 ready, 12 requested
 *      and did NOT install (`failed:*`), 13 NO engine at all (`skipped:*`) —
 *      and 1 when the scripts did not deploy behind a ready engine. The two
 *      failure codes are two different fixes for the operator, and they are
 *      both failures: a `skipped:*` verdict says WHY the engine is absent, it
 *      does not decide whether the run passed. That is the rule the two-engine
 *      release landed for "both halves skipped" (the box answered every spoken
 *      request with silence and was graded clean), and it does not change
 *      because there is one half now. 10 and 11 — "GPU skipped, the CPU
 *      fallback speaks" — described a box that cannot exist with one engine,
 *      so the script no longer emits them anywhere: install_kokoro_tts returns
 *      13 for a board it declines, and the manual full-pipeline install exits
 *      13 for the same verdict.
 *   3. step_openclaw_tts records every failure it is handed — 13 included, and
 *      any status outside the 0/13/12/1 contract as out-of-contract — stays
 *      non-fatal, names Kokoro with the reason it is absent, and never names
 *      an engine the box does not have. It has no arm for 10 or 11: nothing
 *      emits them, so nothing may name them.
 *   4. step_validate_services reads KOKORO= alone: only `ready` passes.
 *      `failed:*`, `skipped:*`, a missing verdict and a verdict outside the
 *      ready/skipped:<reason>/failed:<reason> vocabulary all fail, and a stale
 *      PIPER= line changes nothing either way.
 *
 * Why a skip is a failure and not a polite pass: the installer cannot know
 * whether the cloud voice exists — that needs the ClawBox AI link, which
 * happens after install — and every shipped ClawBox is a Jetson a Kokoro build
 * exists for, so a skipped Kokoro on real hardware means something is wrong
 * and has to be recorded. The runtime chain (cloud voice first, Kokoro behind
 * it) is the gateway's business, never an installer verdict.
 *
 * These tests EXECUTE the shipped artifacts — the real `--tts-only` dispatch
 * out of scripts/install-voice.sh, the real tail of its full pipeline, the
 * real step_openclaw_tts and the real step_validate_services out of install.sh
 * — against stubs. A rewrite that keeps the prose but drops the verdict fails
 * them.
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

/** The `--tts-only` dispatch block of install-voice.sh, as source. */
function ttsOnlyDispatch(): string {
  const start = INSTALL_VOICE_SH.indexOf('"${1:-}" = "--tts-only"');
  const end = INSTALL_VOICE_SH.indexOf("Voice Pipeline Installer");
  if (start < 0 || end < start) throw new Error("the --tts-only dispatch moved");
  return INSTALL_VOICE_SH.slice(start, end);
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
    // The verdict is the reason; the exit status is the outcome. 10 was a
    // clean exit on the two-engine release ONLY because it was reachable
    // behind a ready Piper — a no-CUDA board with nothing else on it has no
    // engine, and that is 13 (section 2), not a pass.
    const res = runTtsOnly({});
    expect(res.status, `a no-CUDA board with no engine exited ${res.status}:\n${res.out}`).toBe(13);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.verdict("PIPER")).toBeNull();
    // And the run says so, naming the engine and the reason it is absent.
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/no-cuda/);
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

  it("is not rescued by a stale PIPER=ready line on a board Kokoro declines", () => {
    // The two-engine release graded a no-CUDA board clean when the CPU engine
    // stood next to it. A line from that release is not an engine: the run
    // rewrites the file without it and still exits 13.
    const res = runTtsOnly({ priorStatus: "KOKORO=ready\nPIPER=ready\n" });
    expect(res.status, `a stale second-engine line passed a box with no engine:\n${res.out}`).toBe(13);
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("skipped:no-cuda");
    expect(res.verdict("PIPER")).toBeNull();
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

  it("exits 13 with skipped:* on a board no engine was ever going to run on", () => {
    // REVERSED, deliberately, and it stays reversed with one engine. x86_64:
    // no Jetson CUDA build, so Kokoro declines and the box has nothing to
    // speak with. This used to exit 11 and grade clean, on the grounds that
    // failing every install-x64.sh run would teach everyone to ignore the
    // check — but install-x64.sh never calls this script (it contains no
    // reference to voice, TTS or Kokoro at all), so the run being protected
    // does not exist and what the leniency passed was a box with no voice.
    // Nor may the installer lean on the gateway's cloud voice: whether that
    // voice exists is decided by the ClawBox AI link, which happens after
    // install, so at provisioning time a skipped Kokoro IS the silent box.
    // Kokoro still publishes `skipped:*`: WHY the engine is absent is a
    // sentence for the operator, not an input to whether the run passed.
    // See install-tts-mute-box-fails.test.ts.
    const res = runTtsOnly({ withCuda: true, arch: "x86_64" });
    expect(res.verdict("KOKORO"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.status, `a box with no engine at all exited clean:\n${res.out}`).toBe(13);
    // The engine, the concrete reason it is absent, and where the verdict is —
    // a report that sends someone to the status file to find out what the run
    // already knew is not a report.
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/arch-x86_64/);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/Verdict recorded in /);
  });

  it("exits 13 for a board with no engine and 12 for one whose engine failed — two fixes, both failures", () => {
    // 13 is not a leftover of the two-engine release: it is the code for "no
    // engine at all", and a board Kokoro declines is exactly that. 12 is "the
    // engine you asked for did not arrive". They send the operator to
    // different fixes (a board with no CUDA is not repaired by re-running the
    // install), which is why install.sh keeps an arm for each — and both are
    // recorded as failures, because the listener hears the same silence.
    const dispatch = ttsOnlyDispatch();
    expect(dispatch, "a board with no engine has no exit code of its own").toMatch(/exit 13/);
    expect(dispatch, "a failed engine has no exit code of its own").toMatch(/exit 12/);
  });

  it("no longer emits 10 or 11 anywhere — there is no fallback for them to describe", () => {
    // 10 meant "GPU skipped, the CPU fallback speaks" and 11 "GPU skipped for
    // the architecture, the CPU fallback speaks". Neither box can exist with
    // one engine, and install.sh graded both clean: keeping either code alive
    // is keeping the pass for a mute box alive. install_kokoro_tts returns 13
    // for the board it declines, the same code the dispatch exits with.
    expect(INSTALL_VOICE_SH, "install-voice.sh still exits or returns 10/11").not.toMatch(/\b(?:exit|return) 1[01]\b/);
    const kokoro = extractShellFn(INSTALL_VOICE_SH, "install_kokoro_tts");
    expect(kokoro).toMatch(/kokoro_report "skipped:arch-\$arch"\s*\n\s*return 13/);
    expect(kokoro).toMatch(/kokoro_report "skipped:no-cuda"\s*\n\s*return 13/);
  });

  it("decides 'did the engine arrive' from the published verdict, not from the return code", () => {
    // The rule the two-engine fix landed and the one-engine dispatch keeps:
    // install_kokoro_tts sets the verdict and the return code in the same
    // breath, so today they cannot disagree — but a future early return that
    // forgets kokoro_report, or a verdict outside the vocabulary, must land on
    // the failure arm (12, with the reason and the verdict file named) and
    // never on `exit "$KOKORO_RC"`. Nothing to read is not evidence of an
    // engine. Pinned structurally because the real script has no injectable
    // way to publish a verdict it did not compute.
    const dispatch = ttsOnlyDispatch();
    const verdictCase = dispatch.indexOf('case "$TTS_KOKORO_VERDICT" in');
    expect(verdictCase, "the --tts-only dispatch does not read the verdict it published").toBeGreaterThan(-1);
    // Absent, `failed:*` and unparseable all take the same arm: report, exit 12.
    expect(dispatch.slice(verdictCase)).toMatch(/\*\)\s*\n\s*tts_missing_engine_report\s*\n\s*exit 12/);
    // `skipped:?*` is read here too, on an arm of its own that reports the
    // mute box and exits 13. It is NOT bundled with `ready`: the two-engine
    // release's `ready|skipped` alternation is exactly what let a declined
    // engine fall through as one that exists.
    expect(dispatch.slice(verdictCase), "a skipped engine still shares an arm with a ready one").not.toMatch(
      /ready\|skipped:\?\*\)/,
    );
    expect(dispatch.slice(verdictCase), "no mute-box arm after the verdict is read").toMatch(
      /skipped:\?\*\)\s*\n\s*tts_mute_box_report\s*\n\s*exit 13/,
    );
    // And the guard runs BEFORE the exit code is trusted for anything. The
    // statement, not the comment above it that quotes the same words.
    const exitOnRc = dispatch.search(/^\s*exit "\$KOKORO_RC"\s*$/m);
    expect(exitOnRc, "the dispatch no longer exits on Kokoro's return code").toBeGreaterThan(-1);
    expect(verdictCase).toBeLessThan(exitOnRc);
    // Both reports name where the verdict lives.
    expect(INSTALL_VOICE_SH).toMatch(/tts_missing_engine_report\(\) \{[\s\S]*?Verdict recorded in \$TTS_STATUS_FILE/);
    expect(INSTALL_VOICE_SH).toMatch(/tts_mute_box_report\(\) \{[\s\S]*?Verdict recorded in \$TTS_STATUS_FILE/);
  });

  it("exits 1 when the voice scripts do not deploy behind a READY Kokoro, without erasing the verdict", () => {
    // 1 is "the scripts did not land, the engine did": a degraded box, not a
    // mute one, and it must not be reported as one (the mirror-image bug
    // class — a failure report over something that succeeded).
    const res = runTtsOnly({ withCuda: true, breakDeploy: true });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/did not deploy/);
    // Kokoro's own answer is still in the file for install.sh to read.
    expect(res.verdict("KOKORO"), res.ttsStatus).toBe("ready");
  });

  it("lets 'no engine' outrank a deploy failure", () => {
    // The same ordering the two-engine release fixed: "no engine at all" is
    // the more severe fact and must not be reported as the lesser one. A
    // no-CUDA board whose scripts also did not deploy is a box with no voice
    // first and a box with a broken workspace second.
    const res = runTtsOnly({ breakDeploy: true });
    expect(res.status, `a box with no engine was reported as a failed deploy:\n${res.out}`).toBe(13);
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

  it("refuses the removed engine's flag instead of running the hour-long full install", () => {
    const res = runTtsOnly({ args: ["--piper-only"] });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toMatch(/unknown option '--piper-only'/);
    expect(res.ttsStatus, "a refused option published a verdict").toBe("");
  });
});

// ── 3. The full pipeline is the other caller, and it once fell off its echo ──

/**
 * Execute the REAL engine-report block at the end of scripts/install-voice.sh —
 * everything from the summary's STT line to EOF, which is the engine line of
 * the summary and the final guard — with the Kokoro verdict preset. The
 * pipeline above it installs CUDA torch and builds CTranslate2 from source,
 * which no unit test can run; this block is the part that decides what the
 * operator is told and what status they get back.
 */
function runPipelineReport(kokoro: string): { status: number; out: string } {
  const marker = 'echo "  STT: Whisper (base)';
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
  it("exits 13 after printing that the only engine does not apply to this board", () => {
    // It printed "no Kokoro GPU engine applies to this board" and then exited
    // 0, because the script ended on an echo. The tail reads the verdict and
    // grades it the way --tts-only does: the same 13, the same report.
    const res = runPipelineReport("skipped:arch-x86_64");
    expect(res.status, `the manual installer reported a mute box as success:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/NO WORKING TTS ENGINE/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/arch-x86_64/);
    // The summary line above the guard tells the same story — not "the cloud
    // voice speaks", which the installer cannot know.
    expect(res.out).toMatch(/no on-device voice/);
    expect(res.out).not.toMatch(/cloud voice/);
  });

  it("exits 13 on a no-CUDA board too — there is no CPU engine to speak for it", () => {
    const res = runPipelineReport("skipped:no-cuda");
    expect(res.status, `a no-CUDA board with no engine exited ${res.status}:\n${res.out}`).toBe(13);
    expect(res.out).toMatch(/no-cuda/);
    expect(res.out).not.toMatch(/piper/i);
  });

  it("exits 12 when the engine was asked for and did not arrive, or published nothing", () => {
    const failed = runPipelineReport("failed:install");
    expect(failed.status, failed.out).toBe(12);
    expect(failed.out).toMatch(/did NOT install/);
    expect(runPipelineReport("").status, "no verdict graded as an engine").toBe(12);
    expect(runPipelineReport("skipped:").status, "a skip with its reason truncated away graded as a skip").toBe(12);
  });

  it("exits 0 when the engine is there", () => {
    const res = runPipelineReport("ready");
    expect(res.status, res.out).toBe(0);
    expect(res.out).toMatch(/Kokoro-82M/);
  });
});

// ── 4. install.sh must not launder any of that into a warning ───────────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh whose exit
 * code the test picks (and, optionally, the verdict file it leaves behind),
 * and report whether the step reached for record_provision_failure — the call
 * that is the difference between a failure the operator sees and one that
 * ends at a log line nobody greps — and what it asked the gateway to
 * configure.
 *
 * The contract has two sides, and the numbers in the test names below are
 * the INPUT side: what install-voice.sh --tts-only exits with. The step
 * answers with its own status, which differs for one of them:
 *
 *   install-voice.sh exits         step_openclaw_tts returns   recorded?
 *   0   Kokoro ready               0                           no
 *   13  the board declines the     13                          yes (withheld
 *       only engine — a mute box                               only in the
 *                                                              no-GPU harness)
 *   12  Kokoro was asked for and   12                          yes
 *       did not install
 *   1   the voice scripts did      14                          yes
 *       not deploy
 *   *   outside the contract       14                          yes
 *
 * 1 becomes 14 because step_openclaw_setup treats a 1 as fatal and a failed
 * script deploy must not abort an otherwise good install; and not 13, which
 * would call a box with a working Kokoro mute. An unknown status lands on 14
 * for the same reason: "something did not complete", not "there is no engine".
 */
function runStep(voiceExit: number, verdictFile?: string) {
  const projectDir = path.join(root, "project");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  const ttsStatus = path.join(root, "step-tts-status");
  if (verdictFile !== undefined) writeFileSync(ttsStatus, verdictFile);
  writeExec(path.join(projectDir, "scripts", "install-voice.sh"), `exit ${voiceExit}`);
  const openclaw = path.join(root, "openclaw");
  const openclawLog = path.join(root, "openclaw-calls.log");
  writeExec(openclaw, `printf '%s\\n' "$*" >> "${openclawLog}"\nexit 0`);

  const provisionLog = path.join(root, "provision-failures.log");

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
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  return {
    out,
    stepRc: /STEP_RC=(\d+)/.exec(out)?.[1] ?? "",
    provisionFailures: lines(provisionLog),
    openclawCalls: lines(openclawLog),
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

  it("RECORDS a 13 from a voice script that reports no engine, rather than grading it a clean provision", () => {
    // 13 is what --tts-only exits for a board Kokoro declines (section 2), so
    // this arm is live, not legacy: a box with no engine has to be recorded as
    // exactly that. Grading it clean is how a mute box printed
    // "=== ClawBox Setup Complete ===".
    const res = runStep(13);
    expect(res.provisionFailures, `a mute box was graded a clean provision:\n${res.out}`).toContain("openclaw_tts");
    expect(res.stepRc).toBe("13");
    expect(res.out).toMatch(/NO working on-device TTS engine/);
  });

  it("names Kokoro and its reason when the run published them, and says where the voice comes from", () => {
    // "No engine" is not an actionable report on its own: a board that
    // declined for want of CUDA and one whose download failed lead to
    // different fixes, so the verdict the run published is what gets printed
    // — and the operator is told the cloud voice takes over only once the box
    // is linked to ClawBox AI, which this installer cannot check.
    for (const verdict of ["skipped:no-cuda", "skipped:arch-x86_64"]) {
      const res = runStep(13, `KOKORO=${verdict}\n`);
      expect(res.stepRc).toBe("13");
      expect(res.out, `the report does not name the engine:\n${res.out}`).toMatch(/Kokoro/);
      expect(res.out, `the report does not carry the published verdict:\n${res.out}`).toContain(verdict);
      expect(res.out).toMatch(/linked to\s+ClawBox AI/);
    }
  });

  it("keeps the provider configured — a mute box must still come up fixable", () => {
    // Recorded, but not abandoned: the tts-local-cli provider is still written
    // and selected, so the box speaks the moment an engine (on-device or the
    // cloud voice behind the ClawBox AI link) becomes reachable.
    const res = runStep(13, "KOKORO=skipped:no-cuda\n");
    expect(res.openclawCalls.some((c) => c.includes("config set messages.tts.providers.tts-local-cli")), res.out).toBe(
      true,
    );
    expect(res.openclawCalls.some((c) => c.includes("config set messages.tts.provider tts-local-cli")), res.out).toBe(
      true,
    );
    expect(res.out).toMatch(/On-device TTS configured, but this box has NO working on-device TTS engine/);
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

  it("still grades a fully healthy box as clean (0)", () => {
    const res = runStep(0, "KOKORO=ready\n");
    expect(res.provisionFailures).toEqual([]);
    expect(res.stepRc).toBe("0");
    expect(res.out).toContain("On-device TTS configured (Kokoro GPU)");
  });

  it("never names an engine the box does not have", () => {
    // The trap the two-engine version walked into on its way out of the
    // original bug: a mute box told it speaks on a fallback it did not have,
    // in the summary line an operator actually reads. Now there is only one
    // engine to claim, and it may be claimed only on exit 0.
    for (const code of [1, 12, 13, 99]) {
      const res = runStep(code);
      expect(res.out, `exit ${code} claimed a working Kokoro:\n${res.out}`).not.toContain("configured (Kokoro GPU)");
      expect(res.out, `exit ${code} named the removed engine:\n${res.out}`).not.toMatch(/piper/i);
    }
    expect(runStep(0).out).toContain("On-device TTS configured (Kokoro GPU)");
  });

  it("has no arm for 10 or 11, and a 13) arm of its own", () => {
    // Structural, because a stub can only hand the step the codes that exist
    // today. The arm table is 0 / 13 / 12 / 1 / everything else: no `10)` or
    // `11)` arm of its own may reappear and route a board with no engine back
    // to TTS_RC=0, and neither code may be folded into another arm's label
    // either — nothing emits them any more, so a step that names them is
    // describing a script that no longer exists. A 10 or 11 that does arrive
    // takes the out-of-contract `*)` arm like any other unknown status.
    const step = extractShellFn(INSTALL_SH, "step_openclaw_tts");
    const armLabels = [...step.matchAll(/^\s*((?:\d+\|)*\d+)\)/gm)].map((m) => m[1]);
    expect(armLabels, "the mute-box arm is not 13 on its own").toContain("13");
    for (const label of armLabels) {
      for (const code of label.split("|")) {
        expect(["10", "11"], `step_openclaw_tts still has an arm labelled ${label}`).not.toContain(code);
      }
    }
    expect(step, "the function still names the removed engine").not.toMatch(/piper/i);
  });

  it("keeps both tolerated codes out of the fatal range step_openclaw_setup enforces", () => {
    // step_openclaw_setup returns any status it has no branch for, which aborts
    // the whole provision. 13 and 14 are the two it must carry rather than die
    // on, so a box that cannot speak still comes up reachable enough to fix.
    const setup = extractShellFn(INSTALL_SH, "step_openclaw_setup");
    for (const code of ["13)", "14)"]) {
      expect(setup, `step_openclaw_setup would abort the provision on ${code}`).toContain(code);
    }
    expect(setup).toMatch(/13\).*NO working on-device TTS engine/);
  });
});

// ── 5. The health check reads the one verdict there is ──────────────────────

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

  it("FAILS a board with no CUDA — no engine is no engine, however politely the board declined", () => {
    // REVERSED. This used to pass only while PIPER=ready stood next to it,
    // and the two-engine release then made "every engine skipped" a FAILURE:
    // a box that answers every spoken request with silence, which this probe
    // had scored healthy because the mute-box arm asked for a `failed:*`
    // first. With the CPU engine gone a skipped Kokoro is the whole verdict —
    // and the whole verdict is "no engine". The probe cannot lean on the
    // cloud voice either: whether it exists is decided by the ClawBox AI
    // link, after install. Same 13 treatment as step_openclaw_tts: named,
    // with the reason, failed. See install-tts-mute-box-fails.test.ts.
    const res = runValidator("KOKORO=skipped:no-cuda\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    // Named with the engine, the reason the run published, and the fix.
    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out).toMatch(/Kokoro/);
    expect(res.out).toMatch(/no-cuda/);
    expect(res.out).toMatch(/--step openclaw_tts/);
  });

  it("FAILS a verdict outside the vocabulary rather than falling through to a pass", () => {
    // The vocabulary is closed: `ready`, `skipped:<reason>`, `failed:<reason>`
    // or nothing. A truncated write, a typo or a stray value used to match no
    // arm and fall out of the chain as a silent PASS, while the strictly LESS
    // informative absent verdict correctly failed. Unparseable is at least as
    // suspicious as absent.
    const res = runValidator("KOKORO=installed\n");
    expect(res.status, `an unreadable verdict scored as healthy:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/unrecognised on-device TTS verdict/);
    // Without asserting an engine state it could not read.
    expect(res.out).not.toMatch(/requested and did NOT install/);
    expect(res.out).not.toMatch(/NO working on-device TTS engine/);
  });

  it("puts the unreadable-verdict check ahead of the engine-naming arms", () => {
    // Structural: the closed-vocabulary check has to be decided BEFORE any arm
    // that names Kokoro's state, or an unreadable value would be described as
    // a mute box (or a failed install) the probe never actually read.
    // Anchored on the failed_probe entries, not on the comments above them.
    const probe = extractShellFn(INSTALL_SH, "step_validate_services");
    const unreadable = probe.indexOf('failed_probe+=("TTS: unrecognised on-device TTS verdict');
    const mute = probe.indexOf('failed_probe+=("TTS: this box has NO working on-device TTS engine');
    const failed = probe.indexOf('failed_probe+=("TTS: Kokoro GPU TTS was requested and did NOT install');
    expect(unreadable).toBeGreaterThan(-1);
    expect(mute).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(-1);
    expect(unreadable, "the unreadable arm sits behind the mute-box arm").toBeLessThan(mute);
    expect(unreadable, "the unreadable arm sits behind the failed-engine arm").toBeLessThan(failed);
  });

  it("does not accept a skip with its reason truncated away", () => {
    // "This board declines the engine" is a claim, and a claim with its reason
    // cut off — exactly what a write that lost power mid-publish leaves — is
    // not evidence for it either.
    expect(runValidator("KOKORO=skipped:\n").status).toBe(1);
    expect(runValidator("KOKORO=failed:\n").status).toBe(1);
  });

  it("reads a CRLF verdict rather than mistaking a ready engine for an unreadable one", () => {
    // The file is also restored from tarballs and edited by hand; `ready\r` is
    // parsed as `ready`, not refused as a word outside the vocabulary.
    expect(runValidator("KOKORO=ready\r\n").status).toBe(0);
    expect(runValidator("KOKORO=failed:model\r\n").status).toBe(1);
    // And a CRLF skip is still the mute box, named with its reason.
    const skipped = runValidator("KOKORO=skipped:no-cuda\r\n");
    expect(skipped.status).toBe(1);
    expect(skipped.out).toMatch(/NO working on-device TTS engine/);
  });

  it("FAILS a board no engine was ever going to run on", () => {
    // REVERSED, same rule: no Jetson CUDA build for this architecture is
    // still a box with no voice, whatever the reason says.
    const res = runValidator("KOKORO=skipped:arch-x86_64\n");
    expect(res.status, `validation passed a box with no TTS engine:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out).toMatch(/arch-x86_64/);
  });

  it("passes a box that has the engine", () => {
    expect(runValidator("KOKORO=ready\n").status).toBe(0);
  });

  it("ignores a stale PIPER= line rather than scoring an engine that no longer exists", () => {
    // A box updated from a release that still shipped the CPU fallback may
    // carry its last verdict until the TTS step rewrites the file. That line
    // must neither fail a healthy box nor rescue a broken one — and a stale
    // PIPER=ready is not an engine a box with no Kokoro can speak on.
    expect(runValidator("KOKORO=ready\nPIPER=failed:download\n").status).toBe(0);
    expect(runValidator("KOKORO=skipped:no-cuda\nPIPER=failed:download\n").status).toBe(1);
    expect(runValidator("KOKORO=skipped:no-cuda\nPIPER=ready\n").status).toBe(1);
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
