import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

/**
 * TASK-1353. kokoro-tts.sh is the cold-start wrapper kokoro-client.sh execs
 * whenever /tmp/kokoro-server.sock is missing (right after boot, or once the
 * resident server has died). It ran
 *
 *     kokoro -t "$TEXT" -o "$TMPWAV" -m af_heart -l a 2>/dev/null
 *
 * and `kokoro` is the console script `pip3 install --user kokoro` puts in
 * ~/.local/bin — on PATH in a login shell only. The setup server, `ssh host
 * cmd`, cron and the gateway all run non-login shells, so on a nano-lab2
 * Jetson (beta 325d8f76) `which kokoro` was empty, the "command not found" went
 * to /dev/null, and every fallback ended in "Kokoro TTS failed".
 *
 * The wrapper now puts ~/.local/bin on PATH itself and keeps the synthesiser's
 * stderr in a small per-run log. The text checks pin both; the runs below
 * EXECUTE the real script under a PATH without ~/.local/bin — the board's
 * condition — against a stub `kokoro` there and a stub `ffmpeg`.
 */

// Starts real bash processes: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const WRAPPER = path.join(REPO, "scripts", "openclaw", "kokoro-tts.sh");
// What install-voice.sh's deploy_voice_scripts actually copies to
// ~/.openclaw/workspace/scripts/kokoro-tts.sh: the twin one directory up.
const DEPLOYED = path.join(REPO, "scripts", "kokoro-tts.sh");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/** The line that runs the synthesiser, and where it sits in the file. */
function kokoroCall(src: string): { line: string; at: number } {
  const m = /^kokoro\s.*$/m.exec(src);
  expect(m, "the wrapper no longer calls `kokoro` at the start of a line").not.toBeNull();
  return { line: m![0], at: m!.index };
}

describe.each([
  ["scripts/openclaw/kokoro-tts.sh", WRAPPER],
  ["scripts/kokoro-tts.sh (the copy install-voice.sh deploys)", DEPLOYED],
])("%s", (_name, file) => {
  const src = readFileSync(file, "utf-8");

  it("exports a PATH with ~/.local/bin in it before it calls kokoro", () => {
    const exp = /^export PATH="?\$(?:HOME|\{HOME\})\/\.local\/bin[:$"]/m.exec(src);
    expect(exp, "no `export PATH=\"$HOME/.local/bin...\"` at the top level of the wrapper").not.toBeNull();
    expect(exp!.index, "PATH is extended after the kokoro call, which is too late").toBeLessThan(kokoroCall(src).at);
    // Generic, not the one home the script was written against.
    expect(exp![0]).not.toContain("/home/clawbox");
  });

  it("keeps the synthesiser's stderr in a log instead of /dev/null", () => {
    const { line } = kokoroCall(src);
    expect(line, "the synthesiser's stderr is discarded again").not.toMatch(/2>\s*\/dev\/null/);
    expect(line).toMatch(/2>\s*"\$KOKORO_LOG"/);
    expect(src).toMatch(/^KOKORO_LOG="\$\{TMPDIR:-\/tmp\}\/kokoro-tts\.log"$/m);
  });
});

it("ships the same wrapper in both places, so the fix cannot land in only one", () => {
  expect(readFileSync(DEPLOYED, "utf-8")).toBe(readFileSync(WRAPPER, "utf-8"));
});

// ── The real wrapper, run the way a service runs it ─────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kokoro-tts-path-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeExec(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  log: string;
  /** The temporary WAV the stub kokoro was handed, or "" if it never ran. */
  tmpWav: string;
}

/**
 * Run the real wrapper with PATH limited to a stub directory and the system
 * bins — no ~/.local/bin, exactly what a non-login shell has on the board.
 *
 * `kokoro` decides what the stub in $HOME/.local/bin does: "ok" writes a WAV
 * and chatters on stderr the way the real CLI does, "fail" only complains,
 * "absent" installs no kokoro at all.
 */
function run(kokoro: "ok" | "fail" | "absent", opts: { tmpdir?: string } = {}): Run {
  const home = path.join(root, "home", "clawbox");
  const localBin = path.join(home, ".local", "bin");
  const stubBin = path.join(root, "bin");
  const tmp = opts.tmpdir ?? path.join(root, "tmp");
  const wavLog = path.join(root, "kokoro-wav.log");
  const outDir = path.join(root, "out");
  mkdirSync(localBin, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  if (!opts.tmpdir) mkdirSync(tmp, { recursive: true });

  if (kokoro !== "absent") {
    writeExec(
      path.join(localBin, "kokoro"),
      [
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
        `printf '%s' "$out" > "${wavLog}"`,
        kokoro === "ok"
          ? ['echo "stub-kokoro: Defaulting repo_id to hexgrad/Kokoro-82M" >&2', "printf 'RIFF-stub-wav' > \"$out\""].join("\n")
          : 'echo "stub-kokoro: RuntimeError: Numpy is not available" >&2; exit 1',
      ].join("\n"),
    );
  }
  // ffmpeg's last argument is its output; write something there so the
  // wrapper's own size checks see a conversion that worked.
  writeExec(path.join(stubBin, "ffmpeg"), ['for a in "$@"; do last="$a"; done', "printf 'stub-audio' > \"$last\""].join("\n"));

  const output = path.join(outDir, "reply.mp3");
  const res = spawnSync("bash", [WRAPPER, "Hello from the cold start.", output], {
    encoding: "utf-8",
    timeout: 20_000,
    env: testEnv({ PATH: `${stubBin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp }),
  });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8") : "");
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    output,
    log: read(path.join(tmp, "kokoro-tts.log")),
    tmpWav: read(wavLog),
  };
}

describe.skipIf(!hasBash || process.platform !== "linux")("kokoro-tts.sh from a non-login shell", () => {
  it("finds kokoro in ~/.local/bin and writes both the ogg and the mp3", () => {
    const res = run("ok");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim().split("\n").pop()).toBe(res.output);
    expect(readFileSync(res.output, "utf-8")).toBe("stub-audio");
    expect(readFileSync(res.output.replace(/\.mp3$/, ".ogg"), "utf-8")).toBe("stub-audio");
    // The synthesiser's chatter went to the log, not to the caller.
    expect(res.log).toContain("stub-kokoro: Defaulting repo_id");
    expect(res.stderr).not.toContain("stub-kokoro");
    // And the trap still cleans up the temporary WAV.
    expect(res.tmpWav).toMatch(/kokoro_.*\.wav$/);
    expect(existsSync(res.tmpWav)).toBe(false);
  });

  it("says why when the synthesiser fails — on stderr and in the log", () => {
    const res = run("fail");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Kokoro TTS failed");
    expect(res.stderr).toContain("Numpy is not available");
    expect(res.log).toContain("Numpy is not available");
    expect(existsSync(res.output)).toBe(false);
  });

  it("logs the old silent failure — a box with no kokoro at all — as the missing command it is", () => {
    const res = run("absent");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Kokoro TTS failed");
    expect(res.log).toMatch(/kokoro: command not found/);
  });

  it("still speaks when the log cannot be written", () => {
    // A redirection that fails skips its command, so an unwritable log must
    // fall back to /dev/null rather than cost the speech itself.
    const res = run("ok", { tmpdir: path.join(root, "no-such-dir") });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(res.output, "utf-8")).toBe("stub-audio");
  });
});
