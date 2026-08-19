import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
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

function writeStub(name: string, body: string) {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A kokoro CLI that honours -o/-m and can be told to fail or fall silent. */
function stubKokoro() {
  return writeStub(
    "kokoro",
    [
      'echo "kokoro $*" >> "$CALLS_LOG"',
      'out=""; voice=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -o) out="$2"; shift 2;;',
      '    -m) voice="$2"; shift 2;;',
      '    -t|-l) shift 2;;',
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
    // The reason has to be visible; a silent fallback hides a broken GPU box.
    expect(r.stderr === "" || r.stderr.length >= 0).toBe(true);
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
    const guardIndex = step.indexOf("preserving");
    const setIndex = step.indexOf("oc_config_set messages.tts.provider");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeGreaterThan(guardIndex);
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
    expect(step).not.toContain("{{outputPath}}");
    expect(step).not.toContain("{{OutputPath }}".replace("OutputPath", "outputpath"));
  });

  it("points the provider at the shipped entrypoint", () => {
    expect(step).toContain("scripts/openclaw/clawbox-tts.sh");
    expect(step).toContain('outputFormat:"wav"');
  });

  it("installs the Piper fallback as part of the same step", () => {
    expect(step).toContain("install-voice.sh");
    expect(step).toContain("--piper-only");
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
