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
   * Run the captured payload against a fake `kokoro`. `phonemes` is what the
   * pipeline's g2p returns for the out-of-vocabulary line, or "raise" to make
   * it throw, or "no-g2p" to remove the attribute entirely.
   */
  function check(phonemes: string | "raise" | "no-g2p"): { status: number | null; out: string } {
    const payload = capturePayload();
    const pkg = path.join(root, "fake", "kokoro");
    mkdirSync(pkg, { recursive: true });
    const g2p =
      phonemes === "raise"
        ? "    def __call__(self, text):\n        raise RuntimeError('boom')"
        : `    def __call__(self, text):\n        return (${JSON.stringify(phonemes)}, [])`;
    writeFileSync(
      path.join(pkg, "__init__.py"),
      [
        "class _G2P:",
        g2p,
        "",
        "class KPipeline:",
        "    def __init__(self, lang_code):",
        phonemes === "no-g2p" ? "        pass" : "        self.g2p = _G2P()",
        "",
      ].join("\n"),
    );
    const script = path.join(root, "run-payload.py");
    writeFileSync(script, payload.endsWith("\n") ? payload : `${payload}\n`);
    const run = spawnSync("python3", [script], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, PYTHONPATH: path.join(root, "fake") },
    });
    return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
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
});
