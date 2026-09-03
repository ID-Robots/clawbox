import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
 *     EspeakFallback constructed OK
 *     PHONEMES: 'ðə zɔɹblˈæTɪk fɹˈɑbnᵻkˌATəɹ skwˈɪbᵊld'   (all three out-of-vocabulary)
 *     KPipeline(lang_code='a').g2p.fallback -> EspeakFallback
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
 * `fallback=None` (kokoro/pipeline.py:108-113). A box that lands in that arm
 * still publishes `KOKORO=ready` and then silently drops every
 * out-of-vocabulary word — names, brands, "ClawBox" itself — from speech. So
 * the warm-up now fails on a pipeline with no fallback, and these tests run
 * the shipped warm-up payload against a fake `kokoro` module to prove it.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_VOICE_SH = readFileSync(path.join(REPO, "scripts", "install-voice.sh"), "utf-8");

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-voice-espeak-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("install-voice.sh declares no system package install.sh does not provide", () => {
  /**
   * Every system package the script's header names as required. The installer
   * is the only thing that could satisfy one, so a name here that install.sh
   * never `apt-get install`s is either a missing install or a stale claim.
   */
  const declared = [...INSTALL_VOICE_SH.matchAll(/Requires ([a-z0-9][a-z0-9.+-]*) to be installed \(system package\)/g)].map(
    (m) => m[1],
  );

  it("names no required system package that install.sh never installs", () => {
    const missing = declared.filter((pkg) => !new RegExp(`\\b${pkg}\\b`).test(INSTALL_SH));
    expect(missing).toEqual([]);
  });

  it("says where the espeak-ng library actually comes from", () => {
    // Not decoration: the next person to read this file has to know that the
    // phonemiser is satisfied by a wheel, or they will "fix" the missing apt
    // package that was never needed.
    expect(INSTALL_VOICE_SH).toMatch(/espeakng-loader/);
  });
});

describe.runIf(hasPython)("the Kokoro warm-up refuses a pipeline with no phonemiser fallback", () => {
  /** The python program the warm-up hands to the box, lifted verbatim. */
  const PAYLOAD = (() => {
    const start = INSTALL_VOICE_SH.indexOf("kokoro_predownload_model() {");
    if (start < 0) throw new Error("kokoro_predownload_model not found in install-voice.sh");
    const end = INSTALL_VOICE_SH.indexOf("\n}", start);
    if (end < 0) throw new Error("kokoro_predownload_model has no closing brace");
    const fn = INSTALL_VOICE_SH.slice(start, end);
    const open = fn.indexOf('clawbox_python "');
    const close = fn.indexOf('" 2>&1', open);
    if (open < 0 || close < 0) throw new Error("the warm-up payload is no longer a clawbox_python string");
    const body = fn.slice(open + 'clawbox_python "'.length, close);
    if (!body.includes("from kokoro import KPipeline")) {
      throw new Error("the warm-up payload was extracted TRUNCATED");
    }
    return body;
  })();

  /**
   * Run the payload against a fake `kokoro` module. `fallback` is what
   * kokoro's own pipeline sets to None when it cannot build an EspeakFallback.
   */
  function warmUp(fallback: "present" | "none"): { status: number | null; out: string } {
    const pkg = path.join(root, "fake", "kokoro");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "__init__.py"),
      [
        "from types import SimpleNamespace",
        "",
        "class _Param:",
        "    device = 'cuda:0'",
        "",
        "class _Model:",
        "    def parameters(self):",
        "        return iter([_Param()])",
        "",
        "class KPipeline:",
        "    def __init__(self, lang_code):",
        "        self.model = _Model()",
        `        self.g2p = SimpleNamespace(fallback=${fallback === "present" ? "object()" : "None"})`,
        "",
      ].join("\n"),
    );
    const script = path.join(root, "payload.py");
    writeFileSync(script, `${PAYLOAD}\n`);
    const run = spawnSync("python3", [script], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, PYTHONPATH: path.join(root, "fake") },
    });
    return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  }

  it("reports the device when the fallback is there", () => {
    const run = warmUp("present");
    expect(run.status).toBe(0);
    expect(run.out).toContain("Kokoro model ready on");
  });

  it("fails, naming the phonemiser, when kokoro could not build one", () => {
    // Today: exit 0 and "Kokoro model ready on cuda:0" — the box publishes
    // KOKORO=ready and drops every out-of-vocabulary word from speech.
    const run = warmUp("none");
    expect(run.status).not.toBe(0);
    expect(run.out).toMatch(/espeak|phonemis/i);
  });
});
