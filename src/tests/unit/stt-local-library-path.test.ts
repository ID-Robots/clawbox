import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The STT probe has to be able to LOAD what the installer built.
 *
 * install-voice.sh builds CTranslate2 with CUDA and
 * `-DCMAKE_INSTALL_PREFIX=$CLAWBOX_HOME/.local`, so `libctranslate2.so.4`
 * lands in a directory the dynamic linker does not search — `ldconfig -p` has
 * no entry for it. Any process that does not name that directory itself fails:
 *
 *   ImportError: libctranslate2.so.4: cannot open shared object file
 *
 * `whisper-server.service` sets LD_LIBRARY_PATH, which is why TRANSCRIPTION
 * works. `childEnv()` builds a deliberately clean environment for the probe and
 * did not, so Settings → Local AI showed
 *
 *   "faster-whisper is not installed for python3."
 *
 * on a box where it was installed, imported and serving — measured on hardware
 * 2026-09-04, minutes after the install reported success. The engine was fine;
 * the reader was blind.
 */
const SRC = readFileSync(path.join(process.cwd(), "src/lib/stt-local.ts"), "utf-8");

describe("the STT probe can load the CUDA CTranslate2 build", () => {
  it("passes LD_LIBRARY_PATH to the children it spawns", () => {
    const at = SRC.indexOf("function childEnv()");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf("\n}", at));
    expect(body, "childEnv must carry the library path").toContain("LD_LIBRARY_PATH");
  });

  it("names the directory the installer actually writes to", () => {
    // -DCMAKE_INSTALL_PREFIX=$CLAWBOX_HOME/.local puts the .so in .local/lib.
    expect(SRC).toContain(".local/lib");
  });

  it("carries the CUDA runtime beside it", () => {
    // ctranslate2's CUDA build links libcublas/libcudnn; without this the
    // import fails one library later than it used to.
    expect(SRC).toContain("/usr/local/cuda/lib64");
  });

  it("agrees with the unit the installer writes", () => {
    // Three readers disagreeing about where the library lives is exactly how
    // this went unnoticed: the unit worked, the probe did not, and the box
    // reported the engine missing while it was answering.
    const installVoice = readFileSync(path.join(process.cwd(), "scripts/install-voice.sh"), "utf-8");
    expect(installVoice, "the unit must still set the path this mirrors").toContain("LD_LIBRARY_PATH");
  });
});
