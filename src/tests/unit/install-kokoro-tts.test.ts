import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

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

/** Read a pinned constant (e.g. PIPER_EN_ONNX_SHA256) out of the real script. */
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
  /** Every command string handed to `su - clawbox -c`, one per line. */
  su: string[];
  curl: string[];
  /** Every `chown` argument list, one per line. */
  chown: string[];
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
function runTtsOnly(env: Record<string, string> = {}, stamped: boolean | string = false): VoiceRun {
  const home = path.join(root, "home", "clawbox");
  const bin = path.join(root, "bin");
  const suLog = path.join(root, "su.log");
  const curlLog = path.join(root, "curl.log");
  const chownLog = path.join(root, "chown.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
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
      `printf '%s\\n---\\n' "$cmd" >> "${suLog}"`,
      'case "$cmd" in',
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

  // Piper: pre-installed, so nothing here needs the network. sha256sum is
  // stubbed to report a file's own contents as its digest, which lets the
  // fixtures carry the real pinned values without shipping the real weights.
  const piperDir = path.join(root, "piper");
  mkdirSync(path.join(piperDir, "voices"), { recursive: true });
  writeExec(path.join(piperDir, "piper"), "exit 0");
  writeFileSync(path.join(piperDir, "voices", "en_US-lessac-medium.onnx"), shellConst("PIPER_EN_ONNX_SHA256"));
  writeFileSync(
    path.join(piperDir, "voices", "en_US-lessac-medium.onnx.json"),
    shellConst("PIPER_EN_JSON_SHA256"),
  );
  writeExec(path.join(bin, "sha256sum"), ['printf "%s  %s\\n" "$(head -c 64 "$1")" "$1"'].join("\n"));

  const res = spawnSync("bash", [INSTALL_VOICE, "--tts-only"], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      CLAWBOX_USER: "clawbox",
      CLAWBOX_HOME: home,
      PIPER_DIR: piperDir,
      // Point the /usr/local/cuda probe at nothing so a dev box or CI runner
      // that happens to have CUDA cannot turn the no-CUDA test green.
      CLAWBOX_CUDA_HOME: path.join(root, "no-such-cuda"),
      ...env,
    },
  });

  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8") : "");
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    su: read(suLog).split("\n---\n").filter(Boolean),
    curl: read(curlLog).trim().split("\n").filter(Boolean),
    chown: read(chownLog).trim().split("\n").filter(Boolean),
    home,
  };
}

// ── The step_openclaw_tts harness ───────────────────────────────────────────

/**
 * Run the real step_openclaw_tts against a stub `openclaw` and a stub
 * install-voice.sh whose exit code the test picks.
 */
function runStep(voiceExit: number) {
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
      'if [ "$1" = "config" ] && [ "$2" = "get" ]; then exit 0; fi',
      "exit 0",
    ].join("\n"),
  );

  const program = [
    "set -uo pipefail",
    `PROJECT_DIR="${projectDir}"`,
    `OPENCLAW_BIN="${openclaw}"`,
    "CLAWBOX_USER=clawbox",
    'as_clawbox() { env "$@"; }',
    "is_hermes_edition() { return 1; }",
    extractShellFn(INSTALL_SH, "oc_config_set"),
    extractShellFn(INSTALL_SH, "tts_ensure_provider_registered"),
    extractShellFn(INSTALL_SH, "step_openclaw_tts"),
    "step_openclaw_tts",
  ].join("\n");

  const res = spawnSync("bash", ["-c", program], { encoding: "utf-8", timeout: 60_000 });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    voiceArgs: read(voiceArgs),
    openclaw: read(callsLog),
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
    expect(res.stdout).toContain("On-device TTS configured (Kokoro GPU, Piper fallback)");
  });

  it.each([
    [10, /no CUDA toolkit/],
    [11, /CPU architecture/],
    [12, /Kokoro GPU install failed/],
  ])("stays non-fatal and tells the truth when the voice install exits %i", (code, reason) => {
    const res = runStep(code as number);
    // Non-fatal: a box must never lose its voice, or its install, to the GPU
    // path. TTS is still configured — through Piper.
    expect(res.status).toBe(0);
    expect(res.openclaw).toContain("config set messages.tts.provider tts-local-cli");
    // And the summary must not repeat the lie that hid this bug for a release.
    expect(res.stdout).not.toContain("Kokoro GPU, Piper fallback");
    expect(res.stdout).toContain("Piper CPU only");
    expect(res.stdout).toMatch(reason as RegExp);
  });

  it("warns about the fallback in terms of the fallback, not of Kokoro", () => {
    // The old wording said "Kokoro still works, but a GPU failure will be
    // silent" — written when Kokoro was assumed present, which it never was.
    const res = runStep(1);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/Piper CPU fallback did not install/);
    expect(res.stderr).not.toMatch(/Kokoro still works/);
    // Exit 1 is the Piper half failing, so claiming Piper is the active engine
    // would just be a smaller version of the same lie.
    expect(res.stdout).toContain("NO engine is confirmed installed");
    expect(res.stdout).not.toContain("Piper CPU only");
    expect(res.stdout).not.toContain("Kokoro GPU, Piper fallback");
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

  it("still deploys Piper and the TTS entrypoint alongside it", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.stdout).toMatch(/Piper voice ready/);
    const entrypoint = path.join(res.home, ".openclaw/workspace/scripts/openclaw/clawbox-tts.sh");
    expect(existsSync(entrypoint)).toBe(true);
    expect(existsSync(path.join(res.home, ".openclaw/workspace/scripts/kokoro-server.py"))).toBe(true);
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
    expect(res.su.filter((c) => c.includes("KPipeline")), "the warm-up ran again").toEqual([]);
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
  it("survives a failed pip: exit 12, Piper intact, no claim of Kokoro", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", PIP_EXIT: "1" });
    expect(res.status, "a GPU failure must be reported, not fatal").toBe(12);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=failed:torch");
    expect(res.stdout).not.toContain("CLAWBOX_TTS_KOKORO=ready");
    // Piper and the entrypoint are installed BEFORE Kokoro is attempted
    // precisely so this is true.
    expect(res.stdout).toMatch(/Piper voice ready/);
    expect(existsSync(path.join(res.home, ".openclaw/workspace/scripts/openclaw/clawbox-tts.sh"))).toBe(true);
  });

  it("survives a failed model pre-download the same way", () => {
    const res = runTtsOnly({ WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1", WARMUP_EXIT: "1" });
    expect(res.status).toBe(12);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=failed:model");
  });

  it("skips Kokoro with a stated reason when there is no CUDA", () => {
    const res = runTtsOnly({ KOKORO_IMPORT_EXIT: "1" });
    expect(res.status).toBe(10);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=skipped:no-cuda");
    expect(res.stdout).toMatch(/no CUDA toolkit/);
    // Skipping means skipping: no wheel, no packages, no pretending.
    expect(res.su.filter((c) => c.includes("pip3 install"))).toEqual([]);
    expect(res.stdout).toMatch(/Piper voice ready/);
  });

  it("skips Kokoro on an architecture with no Jetson build", () => {
    // install_piper already refuses to guess a digest off aarch64; the CUDA
    // torch wheel is just as aarch64-only.
    const res = runTtsOnly({ FAKE_ARCH: "x86_64", WITH_CUDA: "1", KOKORO_IMPORT_EXIT: "1" });
    expect(res.status).toBe(11);
    expect(res.stdout).toContain("CLAWBOX_TTS_KOKORO=skipped:arch-x86_64");
    expect(res.su.filter((c) => c.includes("pip3 install"))).toEqual([]);
  });
});

describe.skipIf(!hasBash)("the older --piper-only entry point still works", () => {
  it("is kept: clawbox-tts.sh names it and older devices' scripts call it", () => {
    // Removing it would break the hint a box prints when Piper is missing.
    const tts = readFileSync(path.join(REPO, "scripts/openclaw/clawbox-tts.sh"), "utf-8");
    expect(tts).toContain("--piper-only");
    expect(INSTALL_VOICE_SH).toContain('if [ "${1:-}" = "--piper-only" ]; then');
  });
});
