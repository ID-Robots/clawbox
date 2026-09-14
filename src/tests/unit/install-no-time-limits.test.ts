import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Owner's decision, 2026-09-14: "remove all limits for time from install.sh".
 *
 * The rule this file pins is not "no number anywhere" — it is that NOTHING in
 * the installers aborts, skips or downgrades work because a box was SLOW. Every
 * budget that used to do so was a guess about hardware and links the script
 * cannot see (a 900 s apt lock, a 300 s npm, a 600 s download, a 1800 s vendor
 * installer), and on a Jetson with a tired SD card and a rural uplink each of
 * them turned a long install into a FAILED one. A failed install is not cheaper
 * than a slow one; it is a box somebody has to drive out to.
 *
 * Two mechanically checkable halves:
 *
 *  1. `timeout N …` — the command that KILLS work — appears nowhere.
 *  2. `--max-time` — curl's cap on a whole TRANSFER, i.e. on a slow download —
 *     appears only on a LOOPBACK LIVENESS PROBE inside a retry loop, where it is
 *     what makes the probe a probe: a socket that accepts and never answers
 *     would otherwise hang the loop for ever. `--connect-timeout` is not in
 *     scope: it bounds a dead TCP handshake, never a slow transfer, and it is
 *     paired with `--retry` at every site that carries it.
 *
 * The wall-clock windows the installers keep are deliberate, each named in its
 * own comment, and NONE of them bounds work — every one of them sits after the
 * work is done and decides only how long to LOOK before reporting. They exist
 * because systemd reports the two halves of "not answering yet" identically: a
 * unit whose ExecStart has forked and is still coming up, and one that is up and
 * will never bind the port (a plugin awaiting capability consent holds that
 * state for ever) are both `active`. Unbounded, each of these would hang the
 * installer in exactly the state its report or its repair exists to address.
 * Every one asks the FACT first — `unit_is_coming_up`, the unit has stopped
 * trying — so the clock is the last resort rather than the first:
 *
 *   - install.sh `wait_for_gateway_port` (180 s, step-wide): the switch between
 *     waiting and running the `openclaw doctor` repair. Nothing fails.
 *   - install.sh `hermes_dashboard_restart_after_install` (120 s): the look for
 *     the restarted dashboard's new main pid. Both outcomes are a warning.
 *   - install.sh `restore_previous_build` (180 s) and `step_validate_services`
 *     (180 s): when to write the report. A report cannot be deferred for ever.
 *   - install-x64.sh `wait_for_http` (600 s): far outside every start measured
 *     on that path, so a slow gateway no longer fails the install.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = ["install.sh", "install-x64.sh", "scripts/install-voice.sh"] as const;

const NL = String.fromCharCode(10);

function allLinesOf(file: string): string[] {
  return readFileSync(path.join(REPO, file), "utf-8").split(NL);
}

function linesOf(file: string): { n: number; text: string }[] {
  return allLinesOf(file)
    .map((text, i) => ({ n: i + 1, text }))
    // Comments explain the rule; they are not the rule.
    .filter(({ text }) => !/^\s*#/.test(text));
}

/**
 * The body of the shell function a given 1-indexed line sits in, or "".
 *
 * Some of the facts a line has to satisfy are not ON the line: install-x64's
 * `wait_for_http` probes `"$url"`, and what makes that a LOOPBACK probe is the
 * guard at the top of the same function. Reading the enclosing function is what
 * lets the rule below be about the request rather than about its spelling.
 */
function enclosingFunction(file: string, line: number): string {
  const lines = allLinesOf(file);
  let start = -1;
  for (let i = line - 1; i >= 0; i--) {
    if (/^\s*}\s*$/.test(lines[i])) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^}\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end + 1).join(NL);
}

describe("the installers kill no work on a clock", () => {
  for (const file of FILES) {
    it(`${file} invokes \`timeout\` nowhere`, () => {
      // `timeout` as a COMMAND: at the start of a line, after a pipe/&&/;, or at
      // the start of a quoted command string handed to su/runuser/
      // as_clawbox_login — with any of its own flags (`-k 30`) in between, and
      // then ANY argument. Deliberately not `[0-9]`: `timeout "$BUDGET" curl …`
      // kills slow work exactly as hard as `timeout 600` does, and a rule that
      // only saw the literal would wave the variable through. The character
      // class excludes `-`, which is what keeps `--connect-timeout 15` (an
      // option of curl, and not a killer) out, and the argument must look like a
      // DURATION — a digit or an expansion — which is what keeps the word out of
      // the English in an `echo` ("did not report a usable provider timeout").
      const COMMAND_TIMEOUT = /(^|[|&;("']|\s)timeout\s+(-[a-zA-Z]\s+\S+\s+)*["'$0-9]/;
      const hits = linesOf(file).filter(({ text }) => COMMAND_TIMEOUT.test(text));
      expect(
        hits.map(({ n, text }) => `${file}:${n}: ${text.trim()}`),
        "a `timeout N` kills work for being slow — see the header of this file",
      ).toEqual([]);
    });

    it(`${file} caps a curl transfer only on a loopback liveness probe`, () => {
      const LOOPBACK = /127\.0\.0\.1|localhost|\[::1\]/;
      const hits = linesOf(file).filter(({ text }) => text.includes("--max-time"));
      for (const { n, text } of hits) {
        const seconds = Number(/--max-time\s+([0-9]+)/.exec(text)?.[1] ?? NaN);
        // Three things together make a request a liveness probe, and no two of
        // them are enough. It must go to a socket on THIS machine (a remote
        // `--max-time 5 -o /dev/null` is a transfer deadline wearing a probe's
        // clothes) — proved on the line, or by the guard in the function around
        // it, since one of these probes takes its URL as an argument. It must
        // throw the body away. And its budget must be probe-sized: any cap big
        // enough to let a real download through is one big enough to kill one.
        expect(
          LOOPBACK.test(text) || LOOPBACK.test(enclosingFunction(file, n)),
          `${file}:${n} caps a transfer to somewhere that is not this machine: ${text.trim()}`,
        ).toBe(true);
        expect(
          /-o\s+\/dev\/null|>\s*\/dev\/null/.test(text),
          `${file}:${n} caps a curl that keeps what it fetches: ${text.trim()}`,
        ).toBe(true);
        expect(
          seconds <= 5,
          `${file}:${n} caps a transfer with a download-sized budget: ${text.trim()}`,
        ).toBe(true);
      }
    });
  }

  it("install.sh waits for the apt lock rather than giving up on it", () => {
    const sh = readFileSync(path.join(REPO, "install.sh"), "utf-8");
    const start = sh.indexOf("wait_for_apt() {");
    expect(start).toBeGreaterThan(-1);
    const body = sh.slice(start, sh.indexOf(`${String.fromCharCode(10)}}`, start));
    expect(body).not.toMatch(/max_wait/);
    // The heartbeat is what makes an unbounded wait readable rather than a hang.
    expect(body).toContain("wait_note");
  });

  it("every download the installers run is retried rather than time-boxed", () => {
    // A `--connect-timeout` with no `--retry` beside it is a cap that can still
    // answer "unreachable" for a link that merely blinked.
    for (const file of FILES) {
      for (const { n, text } of linesOf(file)) {
        if (!text.includes("--connect-timeout")) continue;
        expect(
          text.includes("--retry"),
          `${file}:${n} bounds a connect without retrying it: ${text.trim()}`,
        ).toBe(true);
      }
    }
  });
});

/**
 * CUDA and JetPack are laid down ONCE — by the factory image, or by the first
 * `install.sh` run on a bare board. "Update everything" must not re-run them:
 * on a healthy box that was minutes of Jetson apt for a no-op, and on a box
 * whose mirror had moved it could pull a JetPack change nobody asked for into an
 * update the owner started for ClawBox itself. (Owner's decision, 2026-09-14.)
 *
 * The behavioural assertion — the step list the updater actually builds, on
 * every edition — lives in updater.test.ts. This one guards the two halves that
 * make the repair path still reachable, and would otherwise be quietly deleted
 * along with the update step.
 */
describe("JetPack is installed once, and stays repairable by hand", () => {
  const SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

  it("is off the automatic update path", () => {
    const updater = readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");
    const start = updater.indexOf("const UPDATE_STEPS: UpdateStepDef[] = [");
    expect(start).toBeGreaterThan(-1);
    const list = updater.slice(start, updater.indexOf(`${String.fromCharCode(10)}];`, start));
    expect(list).not.toMatch(/id:\s*"nvidia_jetpack"/);
  });

  it("is still dispatchable, and still runs on a first install", () => {
    expect(SH).toContain("step_nvidia_jetpack()");
    // `--step nvidia_jetpack`, and the main flow's own call.
    expect(SH).toMatch(/DISPATCH_STEPS=\([\s\S]*?nvidia_jetpack/);
    expect(SH).toMatch(/^step_nvidia_jetpack$/m);
  });

  it("does not build llama.cpp's CUDA toolchain outside its own step", () => {
    // The ~19-minute native cmake build. It has never been on the update path
    // and must not drift onto it: only step_llamacpp_install may run it.
    const updater = readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");
    const start = updater.indexOf("const UPDATE_STEPS: UpdateStepDef[] = [");
    const list = updater.slice(start, updater.indexOf(`${String.fromCharCode(10)}];`, start));
    expect(list).not.toMatch(/id:\s*"llamacpp_install"/);
  });
});

/**
 * The four models a ClawBox installs, and no others (owner's decision,
 * 2026-09-14). Anything else a box runs locally is the owner's own explicit
 * pull from the UI — install.sh does not choose it for them.
 */
describe("install.sh downloads only the four blessed local models", () => {
  const BLESSED = [
    // Gemma 4 E2B (the offline chat model, llama.cpp)
    "google/gemma-4-E2B-it-qat-q4_0-gguf",
    // Qwen3-Embedding-0.6B (memory search)
    "Qwen/Qwen3-Embedding-0.6B-GGUF",
  ];

  it("fetches exactly the two GGUFs from Hugging Face, by their pinned repos", () => {
    const sh = readFileSync(path.join(REPO, "install.sh"), "utf-8");
    for (const repo of BLESSED) expect(sh).toContain(repo);
    // Every `hf download` in the file is one of those two: both read their repo
    // and file from $HF_REPO/$HF_FILE, which the two functions above set from
    // the pinned defaults.
    const downloads = sh
      .split(String.fromCharCode(10))
      .filter((l) => !/^\s*#/.test(l) && /\bhf download\b/.test(l));
    expect(downloads).toHaveLength(2);
    for (const line of downloads) {
      // Both read the repo and the file from the pinned defaults above; a third
      // download, or one with a literal repo spliced in, fails here.
      expect(line).toMatch(/hf download \\?"\$HF_REPO\\?" \\?"\$HF_FILE\\?"/);
    }
  });

  it("pulls no Ollama model — the daemon only, the models are the owner's pick", () => {
    for (const file of ["install.sh", "install-x64.sh", "scripts/install-voice.sh"]) {
      const lines = linesOf(file).filter(({ text }) => /\bollama\s+(pull|run)\b/.test(text));
      expect(
        lines.map(({ n, text }) => `${file}:${n}: ${text.trim()}`),
        "install must not choose a local chat model for the owner",
      ).toEqual([]);
    }
  });

  it("pre-fetches exactly the two voice models, Kokoro and faster-whisper base", () => {
    const voice = readFileSync(path.join(REPO, "scripts/install-voice.sh"), "utf-8");
    expect(voice).toContain("kokoro_predownload_model");
    expect(voice).toContain("whisper_predownload_model");
    // `base`, not a larger Whisper: the runtime default in whisper-server.py.
    expect(voice).toMatch(/WhisperModel\("base"/);
    const whisperServer = readFileSync(path.join(REPO, "scripts/whisper-server.py"), "utf-8");
    expect(whisperServer).toMatch(/MODEL_SIZE = os\.environ\.get\("WHISPER_MODEL", "base"\)/);
  });

  it("re-downloads neither of them on a box that already has them", () => {
    const voice = readFileSync(path.join(REPO, "scripts/install-voice.sh"), "utf-8");
    // The CUDA torch wheel and the Whisper weights are asked about directly,
    // not inferred from a stamp under .cache that a factory reset removes.
    expect(voice).toContain("cuda_torch_present()");
    expect(voice).toContain("whisper_model_cached()");
    expect(voice).toMatch(/install_cuda_torch\(\) \{\s*\n\s*if cuda_torch_present; then/);
  });
});
