import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// The on-device voice must not read an `EMAIL:<id>` directive out loud.
//
// `EMAIL:<uid>` is how the agent tells a ClawBox CHAT that its reply refers to
// a message the owner can open — chat-email-refs.ts lifts the line out and the
// bubble shows a card instead. Speech has no cards. On the OpenClaw edition
// install.sh step_openclaw_tts wires this script in as the `tts-local-cli`
// provider with `args: ["--", "{{Text}}", "{{OutputPath}}"]` (install.sh:3221),
// so the reply text arrives here with the directive still in it and the box
// says "EMAIL four four seven one" after the summary. The Hermes edition
// reaches the same script through `--text-file`.
//
// These run the SHIPPED script against a stub `kokoro` that records the text it
// was handed, so what is asserted is the utterance the engine actually gets —
// not a reimplementation of the strip in TypeScript.

const SCRIPT = path.resolve(process.cwd(), "scripts/openclaw/clawbox-tts.sh");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasBash && hasPython3 ? describe : describe.skip;

let dir: string;
let binDir: string;
let spokenLog: string;
let meminfo: string;
let outPath: string;

function writeStub(name: string, body: string) {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A kokoro that writes the text it was told to speak, and a real WAV. */
function stubKokoro() {
  writeStub(
    "kokoro",
    [
      'out=""; text=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -o) out="$2"; shift 2;;',
      '    -t) text="$2"; shift 2;;',
      "    *) shift;;",
      "  esac",
      "done",
      // The utterance goes to a file rather than a log line, so a multi-line
      // reply is observed exactly as the engine received it.
      'printf "%s" "$text" > "$SPOKEN_LOG"',
      'python3 -c "',
      "import sys, wave",
      "w = wave.open(sys.argv[1], 'wb')",
      "w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)",
      "w.writeframes(b'\\x00\\x00' * 24000)",
      "w.close()",
      '" "$out"',
    ].join("\n"),
  );
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: testEnv({
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: dir,
      SPOKEN_LOG: spokenLog,
      CLAWBOX_TTS_MEMINFO: meminfo,
      CLAWBOX_TTS_VOICE_FILE: path.join(dir, "voice"),
      // Not a socket, so the cold-start branch (the stub above) is what runs.
      KOKORO_SOCKET: path.join(dir, "no-such.sock"),
      ...extraEnv,
    }),
    timeout: 60_000,
  });
}

/** What the engine was actually asked to say. */
function spoken(): string {
  return existsSync(spokenLog) ? readFileSync(spokenLog, "utf8") : "";
}

d("clawbox-tts.sh does not speak EMAIL: directives", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-tts-email-"));
    binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    spokenLog = path.join(dir, "spoken.txt");
    meminfo = path.join(dir, "meminfo");
    outPath = path.join(dir, "out.wav");
    writeFileSync(meminfo, ["MemTotal:        7607000 kB", "MemAvailable:    6000000 kB"].join("\n"));
    stubKokoro();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips the directive lines from the positional (OpenClaw) form", () => {
    const r = run(["--", "Here are your last two emails.\nEMAIL:4471\nEMAIL:4468", outPath]);
    expect(r.status).toBe(0);
    expect(spoken()).toBe("Here are your last two emails.");
    // The strip fails OPEN, so a parser it could not find would speak the id
    // and say so only on stderr. Asserting the absence of that line is what
    // makes a wrong path a failing test rather than a silent regression — it
    // already caught one, when the plugin directory was flattened and this
    // path was not moved with it.
    expect(r.stderr).not.toMatch(/EMAIL: directive/);
  });

  it("finds the parser through CLAWBOX_ROOT when run from a deployed copy", () => {
    // install-voice.sh's deploy_voice_scripts puts a second copy of this script
    // in the agent's workspace, where there is no scripts/hermes-plugins/ next
    // to it. That copy has to strip too.
    const deployed = path.join(dir, "workspace", "scripts", "openclaw");
    mkdirSync(deployed, { recursive: true });
    const copy = path.join(deployed, "clawbox-tts.sh");
    writeFileSync(copy, readFileSync(SCRIPT, "utf8"));
    const r = spawnSync("bash", [copy, "--", "Two of them.\nEMAIL:4471", outPath], {
      encoding: "utf8",
      env: testEnv({
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        SPOKEN_LOG: spokenLog,
        CLAWBOX_TTS_MEMINFO: meminfo,
        CLAWBOX_TTS_VOICE_FILE: path.join(dir, "voice"),
        KOKORO_SOCKET: path.join(dir, "no-such.sock"),
        CLAWBOX_ROOT: process.cwd(),
      }),
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(spoken()).toBe("Two of them.");
    expect(r.stderr).not.toMatch(/EMAIL: directive/);
  });

  it("speaks the reply as it arrived, and says so, when the parser is not there", () => {
    // Fail open, loudly: a directive read aloud is a blemish, a box that goes
    // silent because a helper moved is a broken appliance.
    const r = run(["--", "Two of them.\nEMAIL:4471", outPath], {
      EMAIL_DIRECTIVES_DIR: path.join(dir, "nowhere"),
    });
    expect(r.status).toBe(0);
    expect(spoken()).toBe("Two of them.\nEMAIL:4471");
    expect(r.stderr).toMatch(/no EMAIL: directive parser/);
  });

  it("strips the directive from the --text-file (Hermes) form", () => {
    const textFile = path.join(dir, "reply.txt");
    writeFileSync(textFile, "The email is waiting for your approval.\nEMAIL:`10960`");
    const r = run(["--text-file", textFile, "--", outPath]);
    expect(r.status).toBe(0);
    expect(spoken()).toBe("The email is waiting for your approval.");
  });

  it("leaves a reply with no directive exactly as it was", () => {
    const r = run(["--", "Your ClawBox is ready.", outPath]);
    expect(r.status).toBe(0);
    expect(spoken()).toBe("Your ClawBox is ready.");
  });

  it("keeps a line whose payload is not a usable id, rather than swallowing it", () => {
    // Same rule as splitEmailRefs: a directive that names nothing openable
    // stays as text, because dropping it would hide that the agent meant to
    // point at something.
    const r = run(["--", "Mail me at\nEMAIL:not-a-number", outPath]);
    expect(r.status).toBe(0);
    expect(spoken()).toBe("Mail me at\nEMAIL:not-a-number");
  });

  it("refuses to speak nothing when the reply was only directives", () => {
    // A reply that is nothing BUT directives strips to the empty string. The
    // script must not hand the engine an empty utterance and report success —
    // a silent success is indistinguishable from a working TTS upstream, which
    // is the failure this whole script exists to prevent.
    const r = run(["--", "EMAIL:4471", outPath]);
    expect(r.status).not.toBe(0);
    expect(existsSync(outPath)).toBe(false);
    expect(r.stderr).toMatch(/nothing left to speak|refusing to speak/i);
  });
});
