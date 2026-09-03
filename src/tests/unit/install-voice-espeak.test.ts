import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/install-voice.sh` declared "Requires espeak-ng to be installed
 * (system package)" and install.sh installs espeak-ng nowhere, on any edition
 * (TASK-686). One of those two statements had to be wrong.
 *
 * Measured read-only on both a shipped openclaw box and a shipped hermes box
 * (2026-09-04): no `espeak-ng` package and no `espeak-ng` binary, and the
 * phonemiser works anyway —
 *
 *     bundled lib: ~/.local/lib/python3.10/site-packages/espeakng_loader/libespeak-ng.so
 *     KPipeline(lang_code='a').g2p.fallback -> EspeakFallback
 *     WORKING     -> 'zɔɹblˈæTɪk fɹˈɑbnᵻkˌATəɹ skwˈɪbᵊld'
 *
 * `misaki/espeak.py` calls `EspeakWrapper.set_library(espeakng_loader.get_library_path())`
 * at import, and the `espeakng-loader` wheel — pulled in by `kokoro` →
 * `misaki[en]`, which `install_kokoro_packages` installs — vendors both the
 * shared library and the espeak-ng data. So the system package is not a
 * dependency and the header was stale.
 *
 * What the stale line was standing in for IS real, though, and nothing checked
 * it: kokoro builds its espeak fallback in a `try/except` that degrades to
 * `logger.warning("EspeakFallback not Enabled: OOD words will be skipped")` and
 * `fallback=None`. A box in that arm still publishes `KOKORO=ready` and then
 * silently drops every out-of-vocabulary word — names, brands, "ClawBox"
 * itself — from speech. Measured on the same box, with the fallback removed:
 *
 *     NO FALLBACK unk=""  -> '  '
 *     NO FALLBACK unk="?" -> '❓ ❓ ❓'
 *
 * So `kokoro_check_phonemiser` phonemises a line no lexicon has and fails on
 * either of those, and it runs OUTSIDE the idempotence gate — a box that
 * already has the Kokoro stack is exactly the box a broken wheel is found on,
 * and `--tts-only` runs on every in-app update.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE_SH = readFileSync(path.join(REPO, "scripts", "install-voice.sh"), "utf-8");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const canRun = hasBash && hasPython;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-voice-espeak-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Every system package a script's header names as required. The installer is
 * the only thing that could satisfy one, so a name here that install.sh never
 * installs is either a missing install or a stale claim.
 */
const REQUIRES_SYSTEM_PACKAGE = /Requires ([a-z0-9][a-z0-9.+-]*) to be installed \(system package\)/g;

function declaredSystemPackages(source: string): string[] {
  return [...source.matchAll(REQUIRES_SYSTEM_PACKAGE)].map((m) => m[1]);
}

describe("install-voice.sh declares no system package install.sh does not provide", () => {
  it("the matcher can still catch one — a control that fails", () => {
    // Without this the assertion below passes over an empty list the day the
    // wording changes, and a re-introduced claim is invisible.
    expect(declaredSystemPackages("# Requires frobnicator to be installed (system package).")).toEqual([
      "frobnicator",
    ]);
  });

  it("names no required system package that install.sh never installs", () => {
    const missing = declaredSystemPackages(INSTALL_VOICE_SH).filter(
      (pkg) => !new RegExp(`\\b${pkg}\\b`).test(INSTALL_SH),
    );
    expect(missing).toEqual([]);
  });

  it("says where the espeak-ng library actually comes from", () => {
    // Not decoration: the next person to read this file has to know the
    // phonemiser is satisfied by a wheel, or they will "fix" the missing apt
    // package that was never needed.
    expect(INSTALL_VOICE_SH).toMatch(/espeakng-loader/);
  });
});

describe("the phonemiser check runs on a box that already has Kokoro", () => {
  const fn = (() => {
    const start = INSTALL_VOICE_SH.indexOf("install_kokoro_tts() {");
    if (start < 0) throw new Error("install_kokoro_tts not found");
    const end = INSTALL_VOICE_SH.indexOf("\n}", start);
    if (end < 0) throw new Error("install_kokoro_tts has no closing brace");
    return INSTALL_VOICE_SH.slice(start, end);
  })();

  it("is called after the idempotence gate closes, not inside its else arm", () => {
    // `kokoro_stack_present` proves `import kokoro, torch` works, which a
    // broken espeakng-loader does not disturb — misaki degrades rather than
    // raising. A check inside the else arm would skip every box on the fleet,
    // including the ones being updated to get this very fix.
    const gateEnd = fn.indexOf("\n    kokoro_mark_installed\n  fi\n");
    const call = fn.indexOf("kokoro_check_phonemiser");
    expect(gateEnd, "the idempotence gate is no longer shaped as this test expects").toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gateEnd);
  });

  it("refuses the ready verdict when it fails", () => {
    expect(fn).toMatch(/kokoro_check_phonemiser; then[\s\S]*kokoro_report "failed:phonemiser"/);
    expect(fn.indexOf('kokoro_report "failed:phonemiser"')).toBeLessThan(fn.indexOf('kokoro_report "ready"') + fn.length);
  });
});

describe.runIf(canRun)("kokoro_check_phonemiser fails a box that drops out-of-vocabulary words", () => {
  /**
   * The python program the check hands the box, captured THROUGH bash.
   *
   * It is a double-quoted shell string on the way to `clawbox_python`, so `$`,
   * a backtick or a backslash in it would be expanded before the device ever
   * saw it. Lifting the literal file text out with `indexOf` would not see
   * that; evaluating the real function with a stub that dumps its argument
   * gives byte-for-byte what a device gets.
   */
  function capturePayload(): string {
    const start = INSTALL_VOICE_SH.indexOf("kokoro_check_phonemiser() {");
    if (start < 0) throw new Error("kokoro_check_phonemiser not found in install-voice.sh");
    const end = INSTALL_VOICE_SH.indexOf("\n}", start);
    if (end < 0) throw new Error("kokoro_check_phonemiser has no closing brace");
    const body = INSTALL_VOICE_SH.slice(start, end + 2);
    if (!body.includes("from kokoro import KPipeline")) {
      throw new Error("kokoro_check_phonemiser was extracted TRUNCATED");
    }
    const out = path.join(root, "payload.py");
    const harness = path.join(root, "capture.sh");
    writeFileSync(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `clawbox_python() { printf '%s' "$1" > ${JSON.stringify(out)}; return 0; }`,
        body,
        "kokoro_check_phonemiser >/dev/null 2>&1 || true",
        "",
      ].join("\n"),
    );
    const run = spawnSync("bash", [harness], { encoding: "utf-8", timeout: 30_000 });
    if (!existsSync(out)) throw new Error(`the payload was never handed to clawbox_python: ${run.stderr}`);
    return readFileSync(out, "utf-8");
  }

  /**
   * Fault to inject into the fake `kokoro` the payload imports.
   *
   * A string is what the pipeline's g2p returns for the out-of-vocabulary line;
   * the named modes are the ways the box itself, rather than the phonemiser,
   * can be broken or merely different.
   */
  type Fault =
    | string
    | "raise" // g2p throws
    | "no-g2p" // the pipeline has no g2p attribute
    | "no-module" // `kokoro` is not installed at all
    | "init-raise" // KPipeline() throws (torch/CUDA init, a CUDA OOM, an HF fetch)
    | "model-must-be-false"; // KPipeline() refuses to load TTS weights

  /**
   * Write a fake `kokoro` package and return the PYTHONPATH that finds it, or
   * null for the box where `kokoro` is absent.
   *
   * `KPipeline.__init__` takes `model` because the real one does: the check
   * wants the G2P only, and constructing with the weights is a torch import
   * plus a KModel load onto a Jetson's shared GPU on every in-app update.
   */
  function writeFakeKokoro(fault: Fault): string | null {
    if (fault === "no-module") return null;
    const pkg = path.join(root, "fake", "kokoro");
    mkdirSync(pkg, { recursive: true });
    const g2p =
      fault === "raise"
        ? "    def __call__(self, text):\n        raise RuntimeError('boom')"
        : `    def __call__(self, text):\n        return (${JSON.stringify(
            NAMED_FAULTS.has(fault) ? WORKING_PHONEMES : fault,
          )}, [])`;
    const init: string[] = [];
    if (fault === "init-raise") {
      // What a box under memory pressure actually raises: kokoro-server.service
      // already holds the model on ~8 GB of shared Orin memory.
      init.push("        raise RuntimeError('CUDA out of memory')");
    } else if (fault === "model-must-be-false") {
      // SystemExit, not Exception, so a check that catches broadly still fails
      // here: this pins the kwarg, not the error handling.
      init.push("        if model is not False:");
      init.push("            raise SystemExit('the check loaded the TTS model')");
      init.push("        self.g2p = _G2P()");
    } else if (fault === "no-g2p") {
      init.push("        pass");
    } else {
      init.push("        self.g2p = _G2P()");
    }
    writeFileSync(
      path.join(pkg, "__init__.py"),
      ["class _G2P:", g2p, "", "class KPipeline:", "    def __init__(self, lang_code, model=True):", ...init, ""].join(
        "\n",
      ),
    );
    return path.join(root, "fake");
  }

  const NAMED_FAULTS = new Set(["raise", "no-g2p", "no-module", "init-raise", "model-must-be-false"]);
  /** What a shipped Orin with a working espeakng-loader wheel actually returns. */
  const WORKING_PHONEMES = "zɔɹblˈæTɪk fɹˈɑbnᵻkˌATəɹ skwˈɪbᵊld";

  /** Run the captured payload against a fake `kokoro` carrying `fault`. */
  function check(fault: Fault): { status: number | null; out: string } {
    const payload = capturePayload();
    const pythonPath = writeFakeKokoro(fault);
    const script = path.join(root, "run-payload.py");
    writeFileSync(script, payload.endsWith("\n") ? payload : `${payload}\n`);
    const run = spawnSync("python3", [script], {
      encoding: "utf-8",
      timeout: 30_000,
      // An empty PYTHONPATH is the box with no kokoro: the import must fail.
      env: { ...process.env, PYTHONPATH: pythonPath ?? path.join(root, "empty") },
    });
    return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  }

  /**
   * The verdict the CALLER reaches, running the shipped `if ! ... ; then`
   * arm out of `install_kokoro_tts` rather than a paraphrase of it. The payload
   * exiting non-zero is only interesting because of what this arm does with it:
   * `failed:phonemiser`, return 12, and install.sh's "Kokoro GPU TTS was
   * REQUESTED and did NOT install" banner plus a recorded provision failure.
   */
  function verdict(fault: Fault): { rc: number; out: string } {
    const armStart = INSTALL_VOICE_SH.indexOf("  if ! kokoro_check_phonemiser; then");
    if (armStart < 0) throw new Error("the install_kokoro_tts phonemiser arm is no longer shaped as this test expects");
    const armEnd = INSTALL_VOICE_SH.indexOf("\n  fi\n", armStart);
    if (armEnd < 0) throw new Error("the phonemiser arm has no closing fi");
    const arm = INSTALL_VOICE_SH.slice(armStart, armEnd + "\n  fi".length);

    const start = INSTALL_VOICE_SH.indexOf("kokoro_check_phonemiser() {");
    const end = INSTALL_VOICE_SH.indexOf("\n}", start);
    const body = INSTALL_VOICE_SH.slice(start, end + 2);

    const pythonPath = writeFakeKokoro(fault) ?? path.join(root, "empty");
    const harness = path.join(root, "verdict.sh");
    writeFileSync(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'kokoro_report() { echo "REPORT $1"; }',
        `clawbox_python() { PYTHONPATH=${JSON.stringify(pythonPath)} python3 -c "$1"; }`,
        body,
        "caller() {",
        arm,
        "  return 0",
        "}",
        "rc=0",
        "caller || rc=$?",
        'echo "RC=$rc"',
        "",
      ].join("\n"),
    );
    const run = spawnSync("bash", [harness], { encoding: "utf-8", timeout: 60_000 });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const m = out.match(/RC=(\d+)/);
    if (!m) throw new Error(`the harness never reached its verdict: ${out}`);
    return { rc: Number(m[1]), out };
  }

  it("carries no shell metacharacter, so what bash builds is what was written", () => {
    // The historical clawbox_python quoting bug (see the comment above
    // clawbox_python) shipped because a payload grew a character bash reads.
    expect(capturePayload()).not.toMatch(/[$`\\]/);
  });

  it("passes a box whose out-of-vocabulary words phonemise", () => {
    // Measured on a shipped Orin with a working espeakng-loader wheel.
    const run = check("zɔɹblˈæTɪk fɹˈɑbnᵻkˌATəɹ skwˈɪbᵊld");
    expect(run.status).toBe(0);
    expect(run.out).toContain("Phonemiser OK");
  });

  for (const [name, phonemes] of [
    // kokoro builds its G2P with unk='' — a dropped word leaves whitespace.
    ["kokoro's own unk=''", "  "],
    // misaki's default marker, for a G2P built without that argument.
    ["misaki's unknown marker", "❓ ❓ ❓"],
  ] as const) {
    it(`fails, naming espeak, when the fallback is gone (${name})`, () => {
      const run = check(phonemes);
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/espeak/i);
    });
  }

  for (const [name, mode] of [
    ["the g2p raises", "raise"],
    ["the pipeline has no g2p at all", "no-g2p"],
    // The two the check used to run OUTSIDE its own try/except. Neither says
    // anything about the phonemiser: `kokoro` absent is a box that was never
    // asked for GPU TTS or whose pip install is gone, and a constructor that
    // raises is torch/CUDA init, a CUDA OOM while kokoro-server already holds
    // the model on ~8 GB of shared Orin memory, or a HuggingFace fetch.
    ["kokoro is not installed at all", "no-module"],
    ["the pipeline constructor raises", "init-raise"],
  ] as const) {
    it(`warns rather than failing a working box when ${name}`, () => {
      // `kokoro` is installed unpinned, so a shape this cannot read is an
      // upstream rename, not a broken box. Grading it as a failure would print
      // "Kokoro was REQUESTED and did NOT install" over a box that speaks —
      // on the manufacturing line, on both editions.
      const run = check(mode);
      expect(run.status).toBe(0);
      expect(run.out).toMatch(/WARN/);
    });
  }

  it("builds the G2P only, without loading the TTS model", () => {
    // --tts-only runs on EVERY in-app update of every box on the fleet, so a
    // full pipeline construction here is a torch import and a KModel load onto
    // a GPU kokoro-server.service may already be holding — and it is what makes
    // the check need the HuggingFace cache, and a network round trip, at all.
    // The probe uses `pipeline.g2p`, which is built whatever `model` says.
    const run = check("model-must-be-false");
    expect(run.out).not.toContain("the check loaded the TTS model");
    expect(run.status).toBe(0);
    expect(run.out).toContain("Phonemiser OK");
  });

  describe("a box that is merely different is never graded as a failed provision", () => {
    /**
     * The shipped caller arm turns a non-zero check into `failed:phonemiser` and
     * `return 12`, which install.sh reads as VOICE_RC=12 -> TTS_RC=12 -> "Kokoro
     * GPU TTS was REQUESTED and did NOT install" + record_provision_failure. So
     * every fault that is not "this box drops out-of-vocabulary words" has to
     * stop before it.
     */
    for (const [name, mode] of [
      ["kokoro is not installed at all", "no-module"],
      ["the pipeline constructor raises (CUDA OOM, torch init, an HF fetch)", "init-raise"],
    ] as const) {
      it(`does not fail the provision when ${name}`, () => {
        const run = verdict(mode);
        expect(run.out).not.toContain("REPORT failed:phonemiser");
        expect(run.rc, `the arm returned ${run.rc}:\n${run.out}`).toBe(0);
      });
    }

    it("still fails the provision for the fault it exists to catch", () => {
      // The control: without this, the two assertions above would also pass over
      // a check that had been quietly turned into a no-op.
      const run = verdict("  ");
      expect(run.out).toContain("REPORT failed:phonemiser");
      expect(run.rc).toBe(12);
    });
  });
});
