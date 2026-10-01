import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The cold-start wrapper kokoro-client.sh execs when the kokoro-server socket
// is down, run for real against a stub `kokoro` and a stub `ffmpeg`.
//
// TASK-1355 (found in the TASK-1352 lab2 hardware test): it called a bare
// `kokoro`, which `pip install --user` puts in ~/.local/bin — on PATH only for
// a login shell. From systemd and ssh commands every cold start failed with
// the CLI fully installed. So what is pinned here is the environment those
// callers hand it: a PATH with no ~/.local/bin and no profile read.

const SCRIPTS = ["scripts/kokoro-tts.sh", "scripts/openclaw/kokoro-tts.sh"];
const SYSTEM_PATH = "/usr/bin:/bin";

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
// The wrapper also looks in /home/clawbox/.local/bin, so on a real box (or any
// machine with a system-wide kokoro) "not installed" cannot be staged.
const kokoroOnThisMachine =
  existsSync("/home/clawbox/.local/bin/kokoro") ||
  spawnSync("bash", ["-c", "command -v kokoro"], { env: testEnv({ PATH: SYSTEM_PATH }), stdio: "ignore" }).status === 0;

let dir: string;
let home: string;
let stubBin: string;
let calls: string;
let output: string;

function writeStub(at: string, body: string) {
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(at, 0o755);
}

/** A kokoro that writes a non-empty WAV to its -o argument and says who ran. */
function kokoroStub(at: string) {
  writeStub(
    at,
    [
      'out=""; args="$*"',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done',
      'printf "RIFF\\0\\0\\0\\0WAVEfmt samples" > "$out"',
      'echo "$0 $args" >> "$CALLS"',
    ].join("\n"),
  );
}

/** Runs the script the way systemd or `ssh box cmd` would: no login shell. */
function run(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [path.resolve(process.cwd(), script), "Hello there", output], {
    env: testEnv({ PATH: `${stubBin}:${SYSTEM_PATH}`, HOME: home, CALLS: calls, ...env }),
    encoding: "utf-8",
  });
}

function ran(): string {
  return existsSync(calls) ? readFileSync(calls, "utf-8") : "";
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kokoro-tts-"));
  home = path.join(dir, "home");
  stubBin = path.join(dir, "bin");
  calls = path.join(dir, "calls.log");
  output = path.join(dir, "out", "reply.mp3");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  // ffmpeg's output is its last argument; write something there.
  writeStub(path.join(stubBin, "ffmpeg"), 'for last; do :; done; printf "audio" > "$last"');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("kokoro-tts.sh outside a login shell", () => {
  it("keeps the two shipped copies identical, so the fix cannot land in one only", () => {
    expect(readFileSync(SCRIPTS[1], "utf-8")).toBe(readFileSync(SCRIPTS[0], "utf-8"));
  });

  for (const script of SCRIPTS) {
    describe(script, () => {
      it("finds the CLI pip put in ~/.local/bin when PATH does not name it", () => {
        const userKokoro = path.join(home, ".local", "bin", "kokoro");
        kokoroStub(userKokoro);
        const res = run(script);
        expect(res.stderr).toBe("");
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe(output);
        expect(readFileSync(output, "utf-8")).toBe("audio");
        expect(ran()).toContain(`${userKokoro} -t Hello there -o `);
        expect(ran()).toContain("-m af_heart -l a");
      });

      it("still prefers a kokoro the caller's PATH already finds", () => {
        kokoroStub(path.join(home, ".local", "bin", "kokoro"));
        const onPath = path.join(stubBin, "kokoro");
        kokoroStub(onPath);
        expect(run(script).status).toBe(0);
        expect(ran().trim().split("\n")).toEqual([expect.stringMatching(new RegExp(`^${onPath} `))]);
      });

      it("runs KOKORO_BIN when one is named", () => {
        kokoroStub(path.join(home, ".local", "bin", "kokoro"));
        const other = path.join(dir, "elsewhere", "kokoro-build");
        kokoroStub(other);
        expect(run(script, { KOKORO_BIN: other }).status).toBe(0);
        expect(ran()).toMatch(new RegExp(`^${other} `));
      });

      it.skipIf(kokoroOnThisMachine)("says the CLI is missing, rather than a bare failure, when it is nowhere", () => {
        const res = run(script);
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/'kokoro' is not installed/);
        expect(res.stderr).toMatch(/~\/\.local\/bin/);
        expect(existsSync(output)).toBe(false);
      });
    });
  }
});
