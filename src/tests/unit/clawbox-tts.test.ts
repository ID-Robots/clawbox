import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// These run the shipped scripts/openclaw/clawbox-tts.sh itself against stub
// `kokoro` and `piper` executables on PATH — not a reimplementation of its
// fallback chain in TypeScript. The engines are the part that breaks, so the
// stubs are scripted to break the way the real ones do: a kokoro that is not
// installed, one that exits non-zero when CUDA will not allocate, one that
// returns a WAV header with no samples in it, and a board with no memory left.
//
// The bug being fixed is silence. Until TASK-383 the box called kokoro-tts.sh,
// which printed "Kokoro TTS failed" and exited 1 for every one of those cases,
// so each test below asserts BOTH that the right engine ran and that audio
// came out — an exit code alone would have passed against the old script too.

const SCRIPT = path.resolve(process.cwd(), "scripts/openclaw/clawbox-tts.sh");
const INSTALL_SH = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");
const INSTALL_VOICE_SH = readFileSync(path.resolve(process.cwd(), "scripts/install-voice.sh"), "utf-8");

/** Pull a shell function body out of a script, for asserting on its shape. */
function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/** Every curl command in a script, line continuations folded in. */
function curlInvocations(source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/(^|[\s;(&|])curl\s/.test(lines[i])) continue;
    let cmd = lines[i];
    let j = i;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
      j += 1;
      cmd += " " + lines[j];
    }
    found.push(cmd);
  }
  return found;
}

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const canRun = hasBash && hasPython3;

let dir: string;
let binDir: string;
let voiceDir: string;
let callsLog: string;
let meminfo: string;
let voiceFile: string;
let wavWriter: string;
let outPath: string;
let servers: ChildProcess[] = [];

/** MemAvailable in MB, in the shape awk reads out of /proc/meminfo. */
function writeMeminfo(availableMb: number) {
  writeFileSync(
    meminfo,
    ["MemTotal:        7607000 kB", `MemAvailable:    ${availableMb * 1024} kB`, "SwapFree:              0 kB"].join("\n"),
  );
}

function writeStub(name: string, body: string, atDir = binDir) {
  const p = path.join(atDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * A kokoro CLI that honours -o/-m and can be told to fail or fall silent.
 * `atDir` is a parameter because WHERE the CLI is is itself under test: pip
 * --user puts it somewhere the exec PATH does not include.
 */
function stubKokoro(atDir = binDir, name = "kokoro") {
  return writeStub(
    name,
    [
      'echo "kokoro $*" >> "$CALLS_LOG"',
      // The loader path the engine was actually handed. torch does not import
      // without it, and the stub is the only place a test can observe it.
      'echo "ld=${LD_LIBRARY_PATH:-}" >> "$CALLS_LOG"',
      'out=""; voice=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -o) out="$2"; shift 2;;',
      '    -m) voice="$2"; shift 2;;',
      '    -t) shift 2;;',
      '    -l) echo "lang=$2" >> "$CALLS_LOG"; shift 2;;',
      "    *) shift;;",
      "  esac",
      "done",
      'echo "voice=$voice" >> "$CALLS_LOG"',
      'if [ "${KOKORO_FAIL:-0}" != "0" ]; then echo "CUDA out of memory" >&2; exit 1; fi',
      'python3 "$WAV_WRITER" "$out" "${KOKORO_SECONDS:-1}"',
    ].join("\n"),
  );
}

/** A piper CLI that reads text on stdin and honours -m/-f, like the real one. */
function stubPiper() {
  return writeStub(
    "piper",
    [
      'echo "piper $*" >> "$CALLS_LOG"',
      "cat > /dev/null",
      'out=""; model=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -f) out="$2"; shift 2;;',
      '    -m) model="$2"; shift 2;;',
      "    *) shift;;",
      "  esac",
      "done",
      'if [ "${PIPER_FAIL:-0}" != "0" ]; then exit 1; fi',
      'python3 "$WAV_WRITER" "$out" 1',
    ].join("\n"),
  );
}

function installPiperVoice(voice: string) {
  writeFileSync(path.join(voiceDir, `${voice}.onnx`), "stub-model");
  writeFileSync(path.join(voiceDir, `${voice}.onnx.json`), "{}");
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: dir,
    CALLS_LOG: callsLog,
    WAV_WRITER: wavWriter,
    CLAWBOX_TTS_MEMINFO: meminfo,
    CLAWBOX_TTS_VOICE_FILE: voiceFile,
    PIPER_BIN: path.join(binDir, "piper"),
    PIPER_VOICE_DIR: voiceDir,
    // A path that cannot be a socket, so the cold-start branch is what runs
    // unless a test deliberately stands a server up.
    KOKORO_SOCKET: path.join(dir, "no-such.sock"),
    ...extra,
  };
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: baseEnv(extraEnv),
    timeout: 60_000,
  });
}

function synth(args: string[], extraEnv: Record<string, string> = {}) {
  return run([...args, "--", "Your ClawBox is ready.", outPath], extraEnv);
}

function calls(): string {
  return existsSync(callsLog) ? readFileSync(callsLog, "utf8") : "";
}

function outputBytes(): number {
  return existsSync(outPath) ? readFileSync(outPath).length : 0;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-tts-"));
  binDir = path.join(dir, "bin");
  voiceDir = path.join(dir, "voices");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(voiceDir, { recursive: true });
  callsLog = path.join(dir, "calls.log");
  meminfo = path.join(dir, "meminfo");
  voiceFile = path.join(dir, "tts-voice");
  outPath = path.join(dir, "out", "speech.wav");
  wavWriter = path.join(dir, "write_wav.py");
  writeFileSync(
    wavWriter,
    [
      "import sys, wave",
      "w = wave.open(sys.argv[1], 'wb')",
      "w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)",
      "w.writeframes(b'\\x00\\x00' * int(24000 * float(sys.argv[2])))",
      "w.close()",
    ].join("\n"),
  );
  writeMeminfo(6000);
  installPiperVoice("en_US-lessac-medium");
});

afterEach(() => {
  for (const s of servers) {
    try {
      s.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!canRun)("scripts/openclaw/clawbox-tts.sh", () => {
  it("speaks through Kokoro when the GPU path is available", () => {
    stubKokoro();
    stubPiper();
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    // Kokoro succeeded, so the CPU engine must not have been touched at all.
    expect(calls()).not.toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("falls back to Piper when kokoro is not installed at all", () => {
    stubPiper();
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
    // The reason has to be visible; a silent fallback hides a broken GPU box
    // that is quietly living on the CPU engine.
    expect(r.stderr).toContain("fell back to Piper");
    expect(r.stderr).toContain("is not installed");
  });

  // ── Where the engine is, and what it can load ─────────────────────────────
  // Installing Kokoro was not enough. With the whole package set on disk and
  // `kokoro -t ... -o ...` producing 105 KB of audio from an interactive
  // shell, a real Orin still spoke through Piper: the CLI lives at
  // ~/.local/bin, which is not on the PATH OpenClaw execs this script with,
  // and torch cannot import libcusparseLt.so.0 without a loader path that
  // only ~/.bashrc and the systemd unit carried (TASK-420).

  it("finds the CLI pip --user installed, which the exec PATH does not include", () => {
    const userBin = path.join(dir, ".local", "bin");
    mkdirSync(userBin, { recursive: true });
    stubKokoro(userBin);
    stubPiper();
    const r = synth([]);
    expect(r.status).toBe(0);
    // Kokoro is the engine that spoke — not Piper, and not "Piper with a note".
    expect(calls()).toContain("kokoro ");
    expect(calls()).not.toContain("piper ");
    expect(r.stderr).not.toContain("fell back to Piper");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("says where it looked when the CLI is in neither place", () => {
    stubPiper();
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("piper ");
    expect(r.stderr).toContain("is not installed");
    // "not installed" is what a box printed while Kokoro was installed and
    // working at exactly this path, so the note has to name the path it
    // checked rather than leave that as the reader's guess.
    expect(r.stderr).toContain(path.join(dir, ".local/bin/kokoro"));
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("lets an explicit KOKORO_BIN outrank both PATH and ~/.local/bin", () => {
    // The per-channel provider `env` sets it, and this suite drives the script
    // through it, so resolution must not quietly take the choice away.
    const userBin = path.join(dir, ".local", "bin");
    mkdirSync(userBin, { recursive: true });
    writeStub("kokoro", 'echo "wrong-kokoro-from-PATH $*" >> "$CALLS_LOG"; exit 1');
    writeStub("kokoro", 'echo "wrong-kokoro-from-user-site $*" >> "$CALLS_LOG"; exit 1', userBin);
    const explicit = stubKokoro(binDir, "kokoro-explicit");
    stubPiper();
    const r = synth([], { KOKORO_BIN: explicit });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(calls()).not.toContain("wrong-kokoro");
    expect(calls()).not.toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("hands Kokoro the CUDA loader path, appended to whatever was already set", () => {
    const cusparse = path.join(dir, ".local/lib/python3.10/site-packages/nvidia/cusparselt/lib");
    mkdirSync(cusparse, { recursive: true });
    stubKokoro();
    stubPiper();
    const r = synth([], { LD_LIBRARY_PATH: "/opt/already-here" });
    expect(r.status).toBe(0);
    const observed = calls().split("\n").find((l) => l.startsWith("ld=")) ?? "";
    expect(observed, "the engine was invoked without the cusparselt path").toContain(cusparse);
    expect(observed).toContain(path.join(dir, ".local/lib"));
    // Appended, never replaced — and ours first, so it is not shadowed.
    expect(observed).toContain("/opt/already-here");
    expect(observed.indexOf(cusparse)).toBeLessThan(observed.indexOf("/opt/already-here"));
    // An empty entry means "the current directory" to the loader, which is not
    // somewhere to resolve .so files from.
    expect(observed).not.toContain("::");
    expect(observed).not.toMatch(/^ld=:|:$/);
  });

  it("leaves Piper's own library path alone", () => {
    // Piper ships its own onnxruntime next to the binary; putting user-site
    // CUDA directories in front of that is not this change's business.
    writeStub("piper", ['echo "piper-ld=${LD_LIBRARY_PATH:-}" >> "$CALLS_LOG"', "cat > /dev/null", "exit 1"].join("\n"));
    mkdirSync(path.join(dir, ".local/lib/python3.10/site-packages/nvidia/cusparselt/lib"), { recursive: true });
    synth([]);
    const observed = calls().split("\n").find((l) => l.startsWith("piper-ld=")) ?? "";
    expect(observed).toContain(binDir);
    expect(observed).not.toContain("cusparselt");
  });

  it("falls back to Piper when kokoro fails, instead of exiting 1", () => {
    // This is the old behaviour, exactly: kokoro-tts.sh printed
    // "Kokoro TTS failed" and exited 1, and the user heard nothing.
    stubKokoro();
    stubPiper();
    const r = synth([], { KOKORO_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(calls()).toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("treats a WAV with no samples in it as a failure and falls back", () => {
    // A header-only WAV is the shape "success" takes when the model loaded but
    // synthesised nothing — exit code 0, file exists, no audio.
    stubKokoro();
    stubPiper();
    const r = synth([], { KOKORO_SECONDS: "0" });
    expect(r.status).toBe(0);
    expect(calls()).toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("skips the GPU entirely when the board has no memory headroom", () => {
    // kokoro-torch peaks at 2259-2636 MB (TASK-382) on a board whose 7607 MB
    // is shared with the GPU. Attempting it at 900 MB free does not fail
    // politely, it OOM-kills something else — so kokoro must never be invoked.
    stubKokoro();
    stubPiper();
    writeMeminfo(900);
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("kokoro ");
    expect(calls()).toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("uses the GPU again once the headroom is back", () => {
    // Guards against a threshold that is simply always tripped.
    stubKokoro();
    stubPiper();
    writeMeminfo(3200);
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
  });

  it("honours an overridden memory threshold", () => {
    stubKokoro();
    stubPiper();
    writeMeminfo(3200);
    const r = synth([], { CLAWBOX_TTS_MIN_FREE_MB: "5000" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("kokoro ");
    expect(calls()).toContain("piper ");
  });

  it("routes a voice Kokoro cannot speak to Piper's own voice for it", () => {
    // Bulgarian is deferred because Kokoro has no Bulgarian voice. The failure
    // to avoid is Kokoro speaking Bulgarian text in an English voice.
    stubKokoro();
    stubPiper();
    installPiperVoice("bg_BG-dimitar-medium");
    const r = synth(["--voice", "bg_dimitar"]);
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("kokoro ");
    expect(calls()).toContain("bg_BG-dimitar-medium.onnx");
    expect(calls()).not.toContain("en_US-lessac-medium.onnx");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("substitutes a same-language voice rather than going silent", () => {
    // bm_george maps to en_GB-alba-medium, which the installer does not ship.
    // On a box where Kokoro cannot run — the low-memory case the guard exists
    // for — refusing here would be exactly the silence this task is about.
    stubKokoro();
    stubPiper();
    writeMeminfo(900);
    const r = synth(["--voice", "bm_george"]);
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("kokoro ");
    expect(calls()).toContain("en_US-lessac-medium.onnx");
    expect(outputBytes()).toBeGreaterThan(1024);
    // The user is told the accent is not the one they picked.
    expect(r.stderr).toContain("en_GB-alba-medium");
    expect(r.stderr).toContain("en_US-lessac-medium");
    expect(r.stderr).toContain("bm_george");
  });

  it("prefers the voice's own model when it is installed", () => {
    // Guards the substitution against becoming a permanent downgrade.
    stubKokoro();
    stubPiper();
    installPiperVoice("en_GB-alba-medium");
    writeMeminfo(900);
    const r = synth(["--voice", "bm_george"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("en_GB-alba-medium.onnx");
    expect(calls()).not.toContain("en_US-lessac-medium.onnx");
    expect(r.stderr).not.toContain("instead");
  });

  it("still refuses to cross languages when only English is installed", () => {
    // Same-language substitution must not weaken this: an English model
    // reading Bulgarian is broken audio, which is worse than no audio.
    stubKokoro();
    stubPiper();
    writeMeminfo(900);
    const r = synth(["--voice", "bg_dimitar"]);
    expect(r.status).not.toBe(0);
    // Assert on what the engine was actually asked to load, not just the code.
    expect(calls()).not.toContain("en_US-lessac-medium.onnx");
    expect(calls()).not.toContain("piper ");
    expect(r.stderr).toContain("no voice model for language 'bg'");
    expect(existsSync(outPath)).toBe(false);
  });

  it("refuses to speak a missing-voice language in the wrong voice", () => {
    // With no Bulgarian model installed the honest answer is no audio and a
    // reason — NOT Bulgarian text read out by the English voice.
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "bg_dimitar"]);
    expect(r.status).not.toBe(0);
    expect(calls()).not.toContain("en_US-lessac-medium.onnx");
    expect(r.stderr).toContain("bg_dimitar");
    expect(r.stderr).toContain("bg_BG-dimitar-medium");
    expect(existsSync(outPath)).toBe(false);
  });

  it("exits non-zero with a diagnostic when no engine can run", () => {
    // Silence is the bug. Whatever else happens, the reason must reach stderr,
    // where OpenClaw surfaces it as `CLI TTS exit 1: <stderr>`.
    const r = synth([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no engine could speak");
    expect(r.stderr).toMatch(/kokoro/);
    expect(r.stderr).toMatch(/piper/);
    expect(existsSync(outPath)).toBe(false);
  });

  it("names both engines' reasons rather than just the last one", () => {
    stubKokoro();
    const r = synth([], { KOKORO_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("kokoro:");
    expect(r.stderr).toContain("piper: binary not found");
  });

  it("passes the selected voice through to Kokoro", () => {
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "am_michael"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=am_michael");
  });

  it("maps an OpenAI-style voice alias onto its Kokoro voice", () => {
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "onyx"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=am_michael");
  });

  it("degrades an unknown voice to the default instead of erroring", () => {
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "definitely-not-a-voice"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=af_heart");
    expect(r.stderr).toContain("unknown voice");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("persists a chosen voice and uses it on later runs", () => {
    stubKokoro();
    stubPiper();
    const set = run(["--set-voice", "bf_emma"]);
    expect(set.status).toBe(0);
    expect(readFileSync(voiceFile, "utf8").trim()).toBe("bf_emma");
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=bf_emma");
  });

  it("refuses to persist a voice the box cannot speak", () => {
    const set = run(["--set-voice", "nonsense"]);
    expect(set.status).not.toBe(0);
    expect(set.stderr).toContain("unknown voice");
    expect(existsSync(voiceFile)).toBe(false);
  });

  it("lets a per-scope override outrank the saved default", () => {
    // OpenClaw has no per-sender config layer; per-user selection rides on the
    // agent/channel/account overrides of the provider's `args` and `env`, so
    // both of those levers have to beat the device-wide saved voice.
    stubKokoro();
    stubPiper();
    writeFileSync(voiceFile, "bf_emma\n");

    const viaEnv = synth([], { CLAWBOX_TTS_VOICE: "am_adam" });
    expect(viaEnv.status).toBe(0);
    expect(calls()).toContain("voice=am_adam");

    rmSync(callsLog, { force: true });
    const viaArg = synth(["--voice", "af_bella"], { CLAWBOX_TTS_VOICE: "am_adam" });
    expect(viaArg.status).toBe(0);
    expect(calls()).toContain("voice=af_bella");
  });

  it("reports the voice it would use", () => {
    writeFileSync(voiceFile, "am_michael\n");
    const r = run(["--get-voice"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("am_michael");
  });

  it("prefers the resident model server over a cold start", () => {
    // The persistent kokoro-server keeps the model on the GPU; cold-starting
    // the CLI instead is the difference between ~2s and a full model load.
    const sock = path.join(dir, "kokoro.sock");
    const server = path.join(dir, "server.py");
    writeFileSync(
      server,
      [
        "import json, os, socket, sys, wave",
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "s.bind(sys.argv[1]); s.listen(1)",
        "open(sys.argv[1] + '.ready', 'w').close()",
        "conn, _ = s.accept()",
        "data = b''",
        "while True:",
        "    chunk = conn.recv(4096)",
        "    if not chunk: break",
        "    data += chunk",
        "req = json.loads(data.decode())",
        "open(os.environ['CALLS_LOG'], 'a').write('server voice=' + req.get('voice', '') + '\\n')",
        "w = wave.open(req['output'], 'wb')",
        "w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)",
        "w.writeframes(b'\\x00\\x00' * 24000)",
        "w.close()",
        "conn.sendall(b'OK')",
        "conn.close()",
      ].join("\n"),
    );
    const proc = spawn("python3", [server, sock], { env: { ...process.env, CALLS_LOG: callsLog }, stdio: "ignore" });
    servers.push(proc);
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${sock}.ready`) && Date.now() < deadline) {
      spawnSync("sleep", ["0.05"]);
    }
    expect(existsSync(`${sock}.ready`)).toBe(true);

    stubKokoro();
    stubPiper();
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).toContain("server voice=af_heart");
    // The whole point of the socket is not paying for a model load.
    expect(calls()).not.toContain("kokoro ");
    expect(calls()).not.toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("cold-starts when the server socket is gone", () => {
    stubKokoro();
    stubPiper();
    const r = synth([], { KOKORO_SOCKET: path.join(dir, "absent.sock") });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
  });

  it("never writes WAV bytes into a file claiming to be something else", () => {
    // OpenClaw picks the extension from outputFormat. If a deployment asks for
    // mp3 on a box with no ffmpeg, handing back a mislabelled WAV is broken
    // audio; failing with a reason is not.
    stubKokoro();
    stubPiper();
    const mp3 = path.join(dir, "out", "speech.mp3");
    const r = run(["--", "Your ClawBox is ready.", mp3], { FFMPEG_BIN: path.join(dir, "no-ffmpeg") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ffmpeg");
    expect(existsSync(mp3)).toBe(false);
  });

  it("rejects --voice with no value instead of spinning on it", () => {
    // `shift 2` with one argument left does not shift and returns non-zero;
    // swallowing that left $1 as --voice and span the parse loop on a core
    // until the caller's timeout killed it. The `timeout` wrapper means a
    // regression fails this test in 5s rather than hanging the suite.
    const r = spawnSync("timeout", ["5", "bash", SCRIPT, "--voice"], {
      encoding: "utf8",
      env: baseEnv(),
      timeout: 30_000,
    });
    expect(r.status).not.toBe(124); // 124 == killed by timeout, i.e. it hung
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--voice requires a value");
  });

  it("rejects --set-voice with no value", () => {
    const r = spawnSync("timeout", ["5", "bash", SCRIPT, "--set-voice"], {
      encoding: "utf8",
      env: baseEnv(),
      timeout: 30_000,
    });
    expect(r.status).not.toBe(124);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--set-voice requires a value");
  });

  it("tells Kokoro the American language code for an American voice", () => {
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "af_heart"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("lang=a");
  });

  it("tells Kokoro the British language code for a British voice", () => {
    // kokoro does not fail on a mismatch — it warns "Language mismatch,
    // loading <voice> into <language> pipeline" and synthesises anyway, so
    // hardcoding -l a degraded pronunciation instead of erroring.
    stubKokoro();
    stubPiper();
    const r = synth(["--voice", "bm_george"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=bm_george");
    expect(calls()).toContain("lang=b");
    expect(calls()).not.toContain("lang=a");
  });

  it("still reaches Piper when Kokoro hangs rather than fails", () => {
    // The scenario the budget exists for, end to end: kokoro never returns.
    // With timeoutMs equal to KOKORO_TIMEOUT, OpenClaw killed this process at
    // the moment kokoro was given up on, so Piper never ran and a wedged GPU
    // was still silence. Timeouts are shrunk here so the test is quick; the
    // relationship under test is the ordering, not the numbers.
    writeStub("kokoro", ['echo "kokoro $*" >> "$CALLS_LOG"', "sleep 30"].join("\n"));
    stubPiper();
    const started = Date.now();
    const r = synth([], { KOKORO_TIMEOUT: "2", KOKORO_SERVER_TIMEOUT: "1", PIPER_TIMEOUT: "10" });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(calls()).toContain("piper ");
    expect(outputBytes()).toBeGreaterThan(1024);
    // It gave up on kokoro and moved on, rather than waiting out the sleep.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("leaves room for the whole chain inside the caller's timeout", () => {
    // The regression this pins: timeoutMs and KOKORO_TIMEOUT were both 120s,
    // so OpenClaw killed the process at the moment Kokoro gave up and Piper
    // never ran. A hung GPU stayed silent — the exact bug this PR fixes.
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    const providerMs = Number(spawnSync("bash", [SCRIPT, "--provider-timeout-ms"], { encoding: "utf8" }).stdout.trim());
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
    expect(providerMs).toBeGreaterThan(budget * 1000);
  });

  it("reports a budget that is really the sum of its engine timeouts", () => {
    // Stops the budget from being a decorative number that drifts away from
    // the timeouts actually handed to `timeout`.
    const src = readFileSync(SCRIPT, "utf8");
    const slice = (name: string): number => {
      const m = src.match(new RegExp(`^${name}="\\$\\{${name}:-(\\d+)\\}"`, "m"));
      if (!m) throw new Error(`${name} default not found`);
      return Number(m[1]);
    };
    const parts = ["KOKORO_SERVER_TIMEOUT", "KOKORO_TIMEOUT", "PIPER_TIMEOUT", "CONVERT_TIMEOUT"];
    const sum = parts.reduce((acc, n) => acc + slice(n), 0);
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    expect(budget).toBe(sum);
    // And each slice is actually enforced, not just declared.
    for (const name of parts) {
      expect(src).toMatch(new RegExp(`timeout "\\$${name}"`));
    }
  });

  it("keeps every engine slice short enough to fail over usefully", () => {
    // A spoken reply that takes even half a minute has already failed as an
    // interaction; the point of the budget is fast failover, not long rope.
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    expect(budget).toBeLessThanOrEqual(120);
  });

  it("does not mistake reply text starting with -- for its own options", () => {
    stubKokoro();
    stubPiper();
    const r = run(["--", "--voice is a strange thing to say", outPath]);
    expect(r.status).toBe(0);
    expect(outputBytes()).toBeGreaterThan(1024);
  });
});

describe("install.sh wires TTS to the on-device chain", () => {
  function extractShellFunction(source: string, name: string): string {
    const start = source.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`${name} not found`);
    const end = source.indexOf("\n}", start);
    if (end < 0) throw new Error(`${name} has no closing brace`);
    return source.slice(start, end);
  }

  const step = extractShellFunction(INSTALL_SH, "step_openclaw_tts");

  it("seeds the provider only when the owner has not chosen one", () => {
    // Same contract as agents.defaults.model.primary: an owner who switched to
    // ElevenLabs must not be reset to the local CLI by every update.
    expect(step).toContain("config get messages.tts.provider");
    expect(step).toMatch(/CURRENT_TTS.*!=.*"null"|"\$CURRENT_TTS" != "null"/);
    expect(step).toContain("preserving");
    // The preserve branch must return BEFORE anything is written, otherwise
    // "seed-if-unset" is just "set".
    const guardIndex = step.indexOf("preserving");
    const setIndex = step.indexOf("oc_config_set messages.tts.provider");
    expect(step.slice(guardIndex, setIndex)).toContain("return 0");
    expect(setIndex).toBeGreaterThan(guardIndex);
  });

  it("does not select a provider it failed to define", () => {
    // oc_config_set retries 3x then returns 1. Naming tts-local-cli as THE
    // provider after its definition failed to land points the box at a
    // provider that does not exist and breaks every spoken reply.
    expect(step).toContain("if ! oc_config_set messages.tts.providers.tts-local-cli");
    const defineIndex = step.indexOf("oc_config_set messages.tts.providers.tts-local-cli");
    const selectIndex = step.indexOf("oc_config_set messages.tts.provider ");
    expect(step.slice(defineIndex, selectIndex)).toContain("return 1");
  });

  it("refuses to wire the provider to a command that is not there", () => {
    expect(step).toContain('[ ! -x "$TTS_SCRIPT" ]');
    const checkIndex = step.indexOf('[ ! -x "$TTS_SCRIPT" ]');
    const setIndex = step.indexOf("oc_config_set messages.tts.providers");
    expect(checkIndex).toBeLessThan(setIndex);
  });

  it("takes the provider timeout from the script instead of hardcoding one", () => {
    expect(step).toContain("--provider-timeout-ms");
    expect(step).toContain("timeoutMs:Number(process.argv[2])");
    // The old hardcoded value, and any other literal, must be gone: a second
    // copy of this number is how it drifted into equalling KOKORO_TIMEOUT.
    expect(step).not.toMatch(/timeoutMs:\s*\d+/);
  });

  it("refuses a provider timeout it cannot parse", () => {
    expect(step).toContain("did not report a usable provider timeout");
  });

  it("writes config through the retrying helper, not a raw config set", () => {
    expect(step).toContain("oc_config_set messages.tts.providers.tts-local-cli");
    expect(step).not.toMatch(/^\s*as_clawbox "\$OPENCLAW_BIN" config set/m);
  });

  it("uses the exact placeholder casing OpenClaw substitutes", () => {
    // applyTemplate normalizes to Firstupper+restlower and only then falls back
    // to the raw key, so {{outputPath}} silently becomes an empty string and
    // the script would be handed no destination at all.
    expect(step).toContain("{{OutputPath}}");
    expect(step).toContain("{{Text}}");
    // All three invalid spellings, written out literally. The previous version
    // of this test excluded "{{outputpath }}" — with a trailing space — which
    // no regression would ever produce, so it guarded nothing.
    expect(step).not.toContain("{{outputPath}}");
    expect(step).not.toContain("{{outputpath}}");
    expect(step).not.toContain("{{OUTPUTPATH}}");
  });

  it("points the provider at the shipped entrypoint", () => {
    expect(step).toContain("scripts/openclaw/clawbox-tts.sh");
    expect(step).toContain('outputFormat:"wav"');
  });

  it("installs both engines as part of the same step", () => {
    expect(step).toContain("install-voice.sh");
    // --piper-only until TASK-420, which installed the fallback and nothing
    // else while this step claimed Kokoro GPU. --tts-only installs both.
    // Behaviour is covered by install-kokoro-tts.test.ts, which executes it.
    expect(step).toMatch(/install-voice\.sh" --tts-only/);
  });

  it("runs on updated boxes and not just fresh installs", () => {
    // Without this the entire feature would be fresh-install-only and every
    // already-shipped box would keep answering a spoken request with silence.
    expect(extractShellFunction(INSTALL_SH, "step_post_update")).toContain("step_openclaw_tts");
    expect(extractShellFunction(INSTALL_SH, "step_openclaw_setup")).toContain("step_openclaw_tts");
  });

  it("is dispatchable by the in-app updater", () => {
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf(")", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    expect(dispatch).toContain("openclaw_tts");
  });
});

describe("install-voice.sh installs the fallback engine", () => {
  it("pins every downloaded artifact by sha256", () => {
    // An executable and model weights fetched onto a customer device.
    expect(INSTALL_VOICE_SH).toContain("PIPER_TARBALL_SHA256=");
    expect(INSTALL_VOICE_SH).toContain("PIPER_EN_ONNX_SHA256=");
    expect(INSTALL_VOICE_SH).toMatch(/piper_digest_ok "\$dest\.part" "\$want"/);
  });

  it("uses the same pinned bytes the benchmark measured", () => {
    const bench = readFileSync(path.resolve(process.cwd(), "scripts/bench/tts-bench.py"), "utf-8");
    for (const key of [
      "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
      "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    ]) {
      expect(bench).toContain(key);
      expect(INSTALL_VOICE_SH).toContain(key);
    }
  });

  it("is idempotent: a matching digest on disk is not re-downloaded", () => {
    expect(INSTALL_VOICE_SH).toMatch(/piper_digest_ok "\$dest" "\$want"[\s\S]{0,60}return 0/);
    expect(INSTALL_VOICE_SH).toContain("Piper binary already installed");
  });

  it("bounds EVERY download, not just one of them", () => {
    // Asserting the flags appear somewhere in the file would be satisfied by a
    // single bounded curl while an unbounded one was added elsewhere. This
    // runs from step_post_update on every in-app update of a shipped device,
    // so any unbounded transfer hangs the whole update.
    const invocations = curlInvocations(INSTALL_VOICE_SH);
    expect(invocations.length).toBeGreaterThan(0);
    for (const cmd of invocations) {
      expect(cmd).toContain("--connect-timeout");
      expect(cmd).toContain("--speed-limit");
      expect(cmd).toContain("--speed-time");
    }
  });

  describe.skipIf(!canRun)("piper_fetch against a recording curl", () => {
    // Runs the real function out of the shipped script with a stub curl on
    // PATH that records the argv it was handed, so the bound is checked on the
    // call as it is actually made rather than on the file's text.
    function runFetch(body: string, wantSha: string, times = 1) {
      const fetchDir = mkdtempSync(path.join(tmpdir(), "piper-fetch-"));
      const fetchBin = path.join(fetchDir, "bin");
      mkdirSync(fetchBin, { recursive: true });
      const curlArgs = path.join(fetchDir, "curl-args.log");
      const curl = path.join(fetchBin, "curl");
      writeFileSync(
        curl,
        [
          "#!/usr/bin/env bash",
          'printf "%s\n" "$*" >> "$CURL_ARGS"',
          'out=""',
          'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
          'printf "%s" "$CURL_BODY" > "$out"',
        ].join("\n"),
      );
      chmodSync(curl, 0o755);
      const dest = path.join(fetchDir, "artifact.bin");
      const harness = path.join(fetchDir, "harness.sh");
      writeFileSync(
        harness,
        [
          "set -uo pipefail",
          extractShellFn(INSTALL_VOICE_SH, "piper_digest_ok"),
          extractShellFn(INSTALL_VOICE_SH, "piper_fetch"),
          ...Array.from(
            { length: times },
            () => `piper_fetch "https://example.invalid/artifact.bin" "${dest}" "${wantSha}"`,
          ),
        ].join("\n"),
      );
      const r = spawnSync("bash", [harness], {
        encoding: "utf8",
        env: { PATH: `${fetchBin}:/usr/bin:/bin`, CURL_ARGS: curlArgs, CURL_BODY: body },
        timeout: 30_000,
      });
      const recorded = existsSync(curlArgs) ? readFileSync(curlArgs, "utf8") : "";
      return { r, recorded, dest, cleanup: () => rmSync(fetchDir, { recursive: true, force: true }) };
    }

    const BODY = "piper-artifact-bytes";
    // sha256 of BODY, computed here so the fixture cannot drift from it.
    //
    // In Node, not by shelling out to sha256sum: describe.skipIf still runs
    // this factory to COLLECT the tests even when canRun is false, and
    // spawnSync on a missing binary returns stdout undefined, so .trim() threw
    // a TypeError and took the whole FILE down instead of skipping it
    // cleanly. Anything evaluated out here has to survive a box with no bash.
    const SHA = createHash("sha256").update(BODY).digest("hex");

    it("passes the timeout bounds on the actual call", () => {
      const { r, recorded, cleanup } = runFetch(BODY, SHA);
      try {
        expect(r.status).toBe(0);
        expect(recorded).toContain("--connect-timeout");
        expect(recorded).toContain("--speed-limit");
        expect(recorded).toContain("--speed-time");
        expect(recorded).toContain("--retry");
      } finally {
        cleanup();
      }
    });

    it("refuses bytes whose digest does not match the pin", () => {
      const { r, dest, cleanup } = runFetch(BODY, "deadbeef");
      try {
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("does not match the pin");
        // Nothing half-written is left for the next run to trust.
        expect(existsSync(dest)).toBe(false);
        expect(existsSync(`${dest}.part`)).toBe(false);
      } finally {
        cleanup();
      }
    });

    it("does not re-download an artifact that is already correct", () => {
      // Called twice; the second call must be satisfied by the digest already
      // on disk. The updater re-runs this on every update of every device.
      const { r, recorded, cleanup } = runFetch(BODY, SHA, 2);
      try {
        expect(r.status).toBe(0);
        expect(recorded.trim().split("\n")).toHaveLength(1);
      } finally {
        cleanup();
      }
    });
  });

  it("proves the binary exists rather than discarding the chmod", () => {
    expect(INSTALL_VOICE_SH).toContain("the Piper tarball did not contain piper");
    expect(INSTALL_VOICE_SH).not.toMatch(/chmod \+x "\$PIPER_DIR\/piper" 2>\/dev\/null \|\| true/);
  });

  it("reports piper-only failure instead of exiting 0 regardless", () => {
    const branch = INSTALL_VOICE_SH.slice(
      INSTALL_VOICE_SH.indexOf('"${1:-}" = "--piper-only"'),
      INSTALL_VOICE_SH.indexOf("Piper fallback ready"),
    );
    expect(branch).toContain("install_piper || PIPER_ONLY_RC=1");
    expect(branch).toContain("deploy_voice_scripts || PIPER_ONLY_RC=1");
    expect(branch).toContain("exit 1");
  });

  it("treats a missing TTS entrypoint as a deploy failure", () => {
    const fn = INSTALL_VOICE_SH.slice(
      INSTALL_VOICE_SH.indexOf("deploy_voice_scripts() {"),
      INSTALL_VOICE_SH.indexOf("\n}", INSTALL_VOICE_SH.indexOf("deploy_voice_scripts() {")),
    );
    expect(fn).toContain("clawbox-tts.sh is missing");
    expect(fn).toContain('return "$rc"');
  });

  it("offers a cheap piper-only path for the updater", () => {
    expect(INSTALL_VOICE_SH).toContain('"${1:-}" = "--piper-only"');
  });

  it("ships an English voice by default and keeps Bulgarian opt-in", () => {
    // Bulgarian is deferred this release; the download stays behind a flag so
    // enabling it later is config, not a code change.
    expect(INSTALL_VOICE_SH).toContain("en_US-lessac-medium");
    expect(INSTALL_VOICE_SH).toContain('INSTALL_BG_VOICE="${CLAWBOX_TTS_INSTALL_BG_VOICE:-false}"');
  });
});
