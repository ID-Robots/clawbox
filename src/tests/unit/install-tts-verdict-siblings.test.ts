import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The SIBLINGS of the TTS-01 fix (#519).
 *
 * #519 taught ONE caller of each half to stop reporting success from a return
 * code and read the published verdict instead. Every other caller was left as
 * it was, which is the shape this review round exists to catch — a bug fixed in
 * one of two identical paths:
 *
 *   1. `install-voice.sh --piper-only`, the second caller of install_piper,
 *      still judged the outcome by `install_piper || PIPER_ONLY_RC=1`.
 *      install_piper returns 0 for "there is no pinned artifact for this
 *      board", so the mode printed "=== Piper fallback ready ===" and exited 0
 *      having installed nothing — in the mode clawbox-tts.sh's own
 *      "Piper not installed" hint tells an operator to run.
 *   2. The full-pipeline path, the third caller, asserted "Piper CPU fallback"
 *      in its summary on every run whatever the verdict said.
 *   3. install.sh bucketed VOICE_RC 11 with 10 and 12 and printed "Piper CPU
 *      only". 11 means `uname -m` is not aarch64 — exactly when install_piper
 *      has no artifact either — so it named a fallback that does not exist one
 *      line after install-voice.sh said no engine applies.
 *   4. step_validate_services' probe is an if/elif chain whose fall-through is
 *      a PASS, so a verdict outside the `ready` / `skipped:` / `failed:`
 *      vocabulary (a
 *      torn write, a CRLF-terminated `PIPER=ready`) scored better than an
 *      absent one.
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

// ── 1. --piper-only, the second caller of install_piper ─────────────────────

interface VoiceRun {
  status: number | null;
  out: string;
  ttsStatus: string;
  verdict: (key: string) => string | null;
}

/**
 * Build a fake device root and a PATH of stubs, then run the REAL
 * `scripts/install-voice.sh --piper-only`.
 *
 * `piper: "ready"` puts the pinned binary and voices on disk so nothing is
 * downloaded; `"broken"` leaves the disk empty with every fetch failing, which
 * is the flaky download half of this defect. `arch` picks what `uname -m`
 * answers: on anything but aarch64 install_piper_engine declines for want of a
 * pinned artifact and returns 0.
 */
function runPiperOnly(opts: { piper?: "ready" | "broken"; arch?: string } = {}): VoiceRun {
  const { piper = "ready", arch = "aarch64" } = opts;
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const ttsStatus = path.join(root, "tts-status");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeExec(
    path.join(bin, "uname"),
    [`[ "\${1:-}" = "-m" ] && { echo "\${FAKE_ARCH:-aarch64}"; exit 0; }`, 'exec /usr/bin/uname "$@"'].join("\n"),
  );
  // No network in a unit test, and the ONE injected fault in the "broken" case.
  writeExec(path.join(bin, "curl"), "exit 1");
  writeExec(path.join(bin, "wget"), "exit 1");
  writeExec(path.join(bin, "chown"), "exit 0");
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

  const res = spawnSync("bash", [INSTALL_VOICE, "--piper-only"], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin${HOST_PATH_SUFFIX}`,
      HOME: home,
      CLAWBOX_USER: "clawbox",
      CLAWBOX_HOME: home,
      PIPER_DIR: piperDir,
      CLAWBOX_TTS_STATUS_FILE: ttsStatus,
      FAKE_ARCH: arch,
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

describe.skipIf(!hasBash)("--piper-only reports the engine it published, not its return code", () => {
  it("does not announce a fallback on a board that has no pinned artifact", () => {
    // The residual. install_piper_engine returns 0 here — a clean decline, not
    // an engine — and the mode printed "=== Piper fallback ready ===" over a
    // box where nothing was installed.
    const res = runPiperOnly({ piper: "broken", arch: "x86_64" });
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^skipped:/);
    expect(res.out, `a board with no artifact was told it has a fallback:\n${res.out}`).not.toContain(
      "Piper fallback ready",
    );
    expect(res.out).toMatch(/no Piper artifact applies/i);
  });

  it("still exits 0 there — a board that declines an engine is not a failure", () => {
    // The mirror-image over-correction. `skipped:*` means nothing was asked for
    // and nothing is missing, the same rule --tts-only and the health check
    // already follow; failing every x86 run would only teach everyone to
    // ignore this mode.
    const res = runPiperOnly({ piper: "broken", arch: "x86_64" });
    expect(res.status, `a board with no applicable engine was called broken:\n${res.out}`).toBe(0);
  });

  it("announces the fallback when the engine is genuinely installed", () => {
    const res = runPiperOnly({ piper: "ready" });
    expect(res.verdict("PIPER"), res.ttsStatus).toBe("ready");
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Piper fallback ready");
  });

  it("fails when the engine was asked for and did not arrive", () => {
    const res = runPiperOnly({ piper: "broken" });
    expect(res.verdict("PIPER"), res.ttsStatus).toMatch(/^failed:/);
    expect(res.status, `a failed install reported success:\n${res.out}`).not.toBe(0);
    expect(res.out).not.toContain("Piper fallback ready");
  });
});

describe("the full pipeline names the fallback from the verdict too", () => {
  it("does not assert a Piper fallback in a summary the verdict never agreed to", () => {
    // The THIRD caller of install_piper: the default path printed
    // "Piper CPU fallback" unconditionally, including on the x86 runs where
    // install_piper_engine declines and on the runs where its download failed.
    const summary = INSTALL_VOICE_SH.slice(INSTALL_VOICE_SH.indexOf("=== Voice Pipeline Installed ==="));
    expect(summary, "the full-pipeline summary is not in install-voice.sh").not.toBe("");
    expect(summary, `the summary claims an engine without reading its verdict:\n${summary}`).toContain(
      'case "$TTS_PIPER_VERDICT" in',
    );
  });
});

// ── 2. install.sh must not name an engine exit 11 does not carry ────────────

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh whose exit
 * code the test picks — the #519 harness, unchanged.
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

describe.skipIf(!hasBash)("step_openclaw_tts names only the engines the exit code carries", () => {
  it("does not name a Piper fallback on the architecture that has none (11)", () => {
    // 11 is "no Jetson CUDA build for this architecture", which is the same
    // `uname -m` test that leaves install_piper without a pinned artifact — so
    // both halves published `skipped:arch-*` and install-voice.sh has just
    // said no engine applies. Bucketing it with 10 and 12 put the name of a
    // working fallback on a box that answers with silence.
    const res = runStep(11);
    expect(res.out, `an architecture with no engine was told it speaks on Piper:\n${res.out}`).not.toContain(
      "Piper CPU only",
    );
    expect(res.out).toMatch(/SILENCE/);
  });

  it("keeps naming Piper for the codes that genuinely carry it (10 and 12)", () => {
    // The over-correction guard. 10 (no CUDA toolkit) and 12 (Kokoro asked for
    // and failed) are both reachable only with a READY Piper — --tts-only
    // returns 13 or 1 otherwise — so the fallback claim there is true.
    for (const code of [10, 12]) {
      const res = runStep(code);
      expect(res.out, `code ${code} stopped naming the engine it does have:\n${res.out}`).toContain(
        "Piper CPU only",
      );
    }
  });

  it("still records nothing for a board neither engine ships for (11)", () => {
    // Nothing was asked for and nothing is missing: 11 stays a clean provision,
    // exactly as #519 decided for two `skipped:*` verdicts.
    const res = runStep(11);
    expect(res.provisionFailures).toEqual([]);
    expect(res.stepRc).toBe("0");
  });
});

// ── 3. The health check must not score garbage above silence ────────────────

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
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=redy\n");
    expect(res.status, `an unparseable verdict scored a pass:\n${res.out}`).not.toBe(0);
    expect(res.out).toMatch(/unrecognised/i);
  });

  it("reads a CRLF verdict rather than mistaking a ready engine for a mute box", () => {
    // A file edited on Windows or restored from a tarball ends the verdict as
    // `ready\r`, which is not `ready`. With Kokoro ready and Piper failed that
    // put "this box has NO working TTS engine" over a box whose GPU engine is
    // running — a failure report over something that succeeded.
    const res = runValidator("KOKORO=ready\r\nPIPER=failed:download\r\n");
    expect(res.out, `a CRLF file was misread as a mute box:\n${res.out}`).not.toMatch(/NO working TTS engine/);
    // Still a failure — the fallback really is gone — just the honest one.
    expect(res.status, res.out).not.toBe(0);
    expect(res.out).toMatch(/Piper CPU fallback was requested and did NOT install/);
  });

  it("still passes a box whose engines both reported ready", () => {
    // The reason the guard is an `elif` and not the trailing `else` the report
    // suggested: the chain's fall-through is where the HEALTHY box lands, so an
    // unconditional `else` would fail every good box on the shelf.
    const res = runValidator("KOKORO=ready\nPIPER=ready\n");
    expect(res.status, `a healthy box was failed by the new guard:\n${res.out}`).toBe(0);
  });

  it("still passes a board that runs neither engine by design", () => {
    const res = runValidator("KOKORO=skipped:no-cuda\nPIPER=skipped:arch-x86_64\n");
    expect(res.status, res.out).toBe(0);
  });
});

// ── 4. The update path is the second caller of step_openclaw_tts ────────────

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
    // around it — on the path that reaches already-shipped boxes.
    const res = runPostUpdate(13);
    expect(res.out, `a mute box was reported like a skipped VNC refresh:\n${res.out}`).toMatch(/SILENCE/);
  });

  it("does not call a degraded box mute, or a mute box degraded", () => {
    const degraded = runPostUpdate(14);
    const kokoroGone = runPostUpdate(12);
    expect(degraded.out).not.toMatch(/SILENCE/);
    expect(kokoroGone.out).not.toMatch(/SILENCE/);
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

// ── 5. A dispatched step's recorded failures must reach the marker ──────────

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
