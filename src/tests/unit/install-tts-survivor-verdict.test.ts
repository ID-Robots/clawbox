import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The LAST residual of the TTS-01 fix (#519), and its class.
 *
 * #519 created the state "the engine survives, the run did not complete" and
 * gave it its own exit code: `install-voice.sh --tts-only` returns 1 when
 * Kokoro is `ready` and the voice-script deploy behind it did not land. With
 * one on-device engine that is the ONLY thing 1 can mean: a skipped Kokoro is
 * 13 and a failed one is 12, and both outrank the deploy failure, so exit 1
 * is always "Kokoro's own verdict stands; the workspace copy of the scripts
 * is what is missing".
 *
 * install.sh maps that 1 to TTS_RC=14 but left `KOKORO_READY` at false, and
 * the engine line was printed off that flag alone. So the step announced
 *
 *     Kokoro GPU TTS NOT installed: the voice install did not complete
 *
 * over a box whose GPU engine installed, warmed up and published `KOKORO=ready`
 * — and step_validate_services then contradicted it a moment later, reading
 * the same file and scoring the engine as present. One run, two mutually
 * exclusive facts about the same box.
 *
 * The class is the one this review round is hunting: an engine CLAIM derived
 * from a return code when the run has already PUBLISHED a verdict that answers
 * the question directly. #519 taught install-voice.sh's `--tts-only` guard and
 * step_validate_services' probe to read the verdict; step_openclaw_tts's own
 * prose was never converted, and neither was the full-pipeline summary — which
 * asserted the GPU engine from nothing at all.
 *
 * These tests EXECUTE the shipped step against stubs, like the two suites they
 * sit next to. The mute box (exit 13, `skipped:*`, recorded and non-fatal) is
 * those suites' subject; this one stays on the survivor.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE_SH = readFileSync(path.join(REPO, "scripts", "install-voice.sh"), "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Lift one shell function verbatim out of a script so the test runs the SHIPPED
 * body rather than a copy of it. Matches from `name() {` to the first
 * column-zero `}`, which is the style every function in install.sh is written
 * in.
 */
function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** Write an executable stub — the shebang and the +x bit, so PATH lookup finds it. */
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

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tts-survivor-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Run the real step_openclaw_tts against a stub install-voice.sh that PUBLISHES
 * the verdict the test picks and then exits with the code the test picks —
 * which is exactly what the real script does, in that order.
 *
 * `verdicts: null` leaves the status file absent: the case where the step has
 * nothing but the exit code to go on.
 */
function runStep(voiceExit: number, verdicts: Record<string, string> | null) {
  const projectDir = path.join(root, "project");
  mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
  writeExec(
    path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
    '[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0',
  );
  const publish =
    verdicts === null
      ? ""
      : Object.entries(verdicts)
          .map(([k, v]) => `printf '%s=%b\\n' ${k} '${v}' >> "$CLAWBOX_TTS_STATUS_FILE"`)
          .join("\n");
  writeExec(path.join(projectDir, "scripts", "install-voice.sh"), `${publish}\nexit ${voiceExit}`);
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

// The state #519 invented and then denied: the GPU engine is up, the script
// deploy behind it did not land. With one engine there is nothing else an
// exit 1 can carry.
const SURVIVOR = { KOKORO: "ready" };

describe.skipIf(!hasBash)("step_openclaw_tts reads the verdict before it denies an engine", () => {
  it("does not tell a box its Kokoro is missing when Kokoro published ready", () => {
    const res = runStep(1, SURVIVOR);
    expect(res.out, `a running GPU engine was reported as not installed:\n${res.out}`).not.toContain(
      "Kokoro GPU TTS NOT installed",
    );
    // The engine line names what actually did not land — the deploy — rather
    // than denying the engine the verdict just confirmed.
    expect(res.out, `the step never says what failed:\n${res.out}`).toMatch(
      /Kokoro GPU TTS installed, but the voice install did not complete/,
    );
    expect(res.out).toContain("the voice scripts did not deploy");
  });

  it("says so on the summary line an operator actually reads", () => {
    const res = runStep(1, SURVIVOR);
    const summary = res.out.split("\n").filter((l) => l.includes("On-device TTS configured"));
    expect(summary.length, `no summary line was printed:\n${res.out}`).toBeGreaterThan(0);
    expect(summary.join("\n"), `the summary hides the surviving engine:\n${res.out}`).toMatch(
      /Kokoro GPU is ready, but the voice install did not complete/,
    );
    // Not the clean-install line either: the engine is there, the run did not
    // finish, and the summary must not claim more than the verdict plus the
    // exit code together support.
    expect(summary.join("\n")).not.toContain("On-device TTS configured (Kokoro GPU)");
  });

  it("keeps #519's verdict: still recorded, still 14, still non-fatal", () => {
    // The engine line is the only thing that changes. A box whose voice
    // scripts did not deploy is still a provisioning failure.
    const res = runStep(1, SURVIVOR);
    expect(res.stepRc, `the step status changed:\n${res.out}`).toBe("14");
    expect(res.provisionFailures).toContain("openclaw_tts");
  });

  it.each([["failed:model"], ["skipped:no-cuda"]])(
    "does not swing the other way and claim Kokoro when Kokoro is not ready (%s)",
    (verdict) => {
      // The over-correction guard. Today's install-voice.sh never pairs exit 1
      // with a non-ready verdict — 13 and 12 both outrank the deploy failure —
      // but the step reads a FILE, and that file is also restored from
      // tarballs, edited by hand and written by older releases. Flipping
      // KOKORO_READY on exit 1 would name an engine the file denies; that is
      // the same lie in the other direction.
      const res = runStep(1, { KOKORO: verdict });
      expect(res.out, `an absent GPU engine was reported as installed:\n${res.out}`).not.toMatch(
        /Kokoro GPU TTS installed/,
      );
      expect(res.out).not.toContain("Kokoro GPU is ready");
      expect(res.stepRc).toBe("14");
    },
  );

  it("falls back to the exit code when the run published no verdict at all", () => {
    // Nothing to read is not licence to invent: with no status file the step
    // keeps exactly the wording #519 landed.
    const res = runStep(1, null);
    expect(res.out, `an unpublished run changed its story:\n${res.out}`).toContain(
      "Kokoro GPU TTS NOT installed",
    );
    expect(res.stepRc).toBe("14");
    expect(res.provisionFailures).toContain("openclaw_tts");
  });

  it("still announces the healthy box the same way", () => {
    const res = runStep(0, { KOKORO: "ready" });
    expect(res.out, `a healthy box lost its summary:\n${res.out}`).toContain("Kokoro GPU TTS installed");
    expect(res.out).toContain("On-device TTS configured (Kokoro GPU)");
    expect(res.stepRc).toBe("0");
    expect(res.provisionFailures).toEqual([]);
  });

  it("parses a CRLF verdict file rather than reading it as a missing engine", () => {
    // The other reader of this file, step_validate_services' probe, strips CR.
    // A reader that did not would report the survivor as absent again, for a
    // file restored from a tarball.
    const res = runStep(1, { KOKORO: "ready\\r" });
    expect(res.out, `a CRLF verdict denied a running engine:\n${res.out}`).not.toContain(
      "Kokoro GPU TTS NOT installed",
    );
    expect(res.out).toMatch(/Kokoro GPU is ready, but the voice install did not complete/);
  });
});

describe("the full pipeline names its GPU engine from the verdict too", () => {
  it("does not assert Kokoro in a summary no verdict ever agreed to", () => {
    // The mirror of the residual above, in the other direction: this path never
    // calls install_kokoro_tts, so it published no KOKORO verdict at all and
    // then printed "TTS: Kokoro-82M via on-demand server (~2s)" on every run —
    // including the runs where install_cuda_torch or the Kokoro package install
    // reported an error and KOKORO_FULL_OK is false.
    const start = INSTALL_VOICE_SH.indexOf("=== Voice Pipeline Installed ===");
    expect(start, "the full-pipeline summary is not in install-voice.sh").toBeGreaterThanOrEqual(0);
    const summary = INSTALL_VOICE_SH.slice(start);
    expect(summary, `the summary claims the GPU engine without reading its verdict:\n${summary}`).toContain(
      'case "$TTS_KOKORO_VERDICT" in',
    );
  });

  it("publishes a Kokoro verdict on the path that installs Kokoro inline", () => {
    // A run that leaves KOKORO= unwritten is also the run step_validate_services
    // reports as "no on-device TTS verdict for Kokoro". Anchored on the deploy
    // step by name rather than its number: the step count moved when the
    // second engine's step was removed, and a slice from -1 would test the
    // last byte of the file.
    const start = INSTALL_VOICE_SH.search(/\[\d+\/\d+\] Deploying voice server scripts/);
    expect(start, "the full pipeline's deploy step is not in install-voice.sh").toBeGreaterThanOrEqual(0);
    const pipeline = INSTALL_VOICE_SH.slice(start);
    expect(pipeline, `the full pipeline never publishes a Kokoro verdict:\n${pipeline}`).toContain(
      "kokoro_report",
    );
  });
});
