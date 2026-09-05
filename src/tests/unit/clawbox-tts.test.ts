import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// These run the shipped scripts/openclaw/clawbox-tts.sh itself against a stub
// `kokoro` executable on PATH — not a reimplementation of its logic in
// TypeScript. The engine is the part that breaks, so the stub is scripted to
// break the way the real one does: a kokoro that is not installed, one that
// exits non-zero when CUDA will not allocate, one that returns a WAV header
// with no samples in it, one that hangs, and a board with no memory left.
//
// Kokoro is the ONLY on-device engine. Until 2026-08 the script fell through
// to a Piper CPU fallback on every one of those failures; the owner removed it
// (the chain is cloud → Kokoro, no second CPU engine), because a fallback that
// silently took over hid a broken GPU install for a whole release (TASK-420).
// So the contract these tests pin is now two-sided:
//
//   * when Kokoro works, audio comes out and the exit is 0;
//   * when Kokoro does not, the exit is non-zero with every reason on stderr,
//     NO output file exists, and nothing else is tried — the gateway's own
//     fallback (the cloud voice) is what answers next, and it can only do that
//     if this script reports the failure instead of absorbing it.
//
// An exit code alone would not do: the old kokoro-tts.sh also exited 1, with
// one message for every cause. Each failing case asserts on the reason too.

const SCRIPT = path.resolve(process.cwd(), "scripts/openclaw/clawbox-tts.sh");
const INSTALL_SH = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");
const INSTALL_VOICE_SH = readFileSync(path.resolve(process.cwd(), "scripts/install-voice.sh"), "utf-8");

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
    atDir,
  );
}

/**
 * A persistent kokoro-server on a unix socket, speaking the script's own
 * JSON-in / "OK"-out protocol. `mode` picks whether it answers with audio or
 * refuses the request, which is how the "collects every reason" case gets a
 * server-side reason and a cold-start reason in the same run.
 */
function startServer(mode: "ok" | "refuse"): string {
  const sock = path.join(dir, `kokoro-${mode}.sock`);
  const server = path.join(dir, `server-${mode}.py`);
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
      `if ${JSON.stringify(mode)} == 'refuse':`,
      "    conn.sendall(b'ERR model not loaded')",
      "    conn.close()",
      "    sys.exit(0)",
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
  return sock;
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: dir,
    CALLS_LOG: callsLog,
    WAV_WRITER: wavWriter,
    CLAWBOX_TTS_MEMINFO: meminfo,
    CLAWBOX_TTS_VOICE_FILE: voiceFile,
    // A path that cannot be a socket, so the cold-start branch is what runs
    // unless a test deliberately stands a server up.
    KOKORO_SOCKET: path.join(dir, "no-such.sock"),
    ...extra,
  });
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

/**
 * The failure contract, asserted the same way for every failing case: a
 * non-zero exit, the reasons on stderr, and — the half an exit code cannot
 * prove — no output file at all. A header-only or partial file at $OUTPUT
 * would be handed to the gateway as audio, which is the silence this script
 * exists to replace.
 */
function expectReportedFailure(r: ReturnType<typeof synth>) {
  expect(r.status, `expected a reported failure, got exit ${r.status}:\n${r.stderr}`).not.toBe(0);
  expect(r.status).not.toBeNull(); // null == killed by the harness timeout, i.e. it hung
  expect(r.stderr).toContain("Kokoro could not speak");
  expect(r.stderr).toMatch(/kokoro:/);
  expect(existsSync(outPath), "a failed run left an output file behind").toBe(false);
  // No second engine: nothing was "fallen back" to, and nothing pretends to be.
  expect(r.stderr).not.toMatch(/fell back|piper/i);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-tts-"));
  binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
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
  // The stub systemctl is not optional. After a cold start the script asks
  // systemd to bring the persistent server up, and $binDir is first on the
  // PATH these runs get — without a stub here that call would reach the REAL
  // /usr/bin/systemctl on whatever machine runs the suite and start a 2.5 GB
  // Kokoro server behind every cold-start test.
  writeStub("systemctl", 'echo "systemctl $*" >> "$CALLS_LOG"');
  writeMeminfo(6000);
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
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
    expect(r.stdout.trim()).toBe(outPath);
  });

  // ── Kokoro failing is REPORTED, never absorbed ─────────────────────────────
  // Every case below used to end in the CPU fallback speaking instead, with
  // the box quietly living on the wrong engine. Now each one has to leave the
  // script with a non-zero status, the reason on stderr, and no audio file —
  // so the gateway sees a failure it can hand to the cloud voice.

  it("exits non-zero with its reasons when kokoro is not installed — never silent audio", () => {
    const r = synth([]);
    expectReportedFailure(r);
    expect(r.stderr).toContain("is not installed");
    expect(calls()).toBe("");
  });

  it("reports a kokoro that fails instead of hiding it behind a second engine", () => {
    // This is what the old fallback chain hid: kokoro exits 1 (CUDA would not
    // allocate), and the user heard the CPU engine with nothing in the log.
    stubKokoro();
    const r = synth([], { KOKORO_FAIL: "1" });
    expectReportedFailure(r);
    expect(calls()).toContain("kokoro ");
    expect(r.stderr).toMatch(/kokoro: '.*' failed/);
    // Only Kokoro ran: one engine line in the calls log, and nothing else.
    expect(calls().split("\n").filter((l) => /^[a-z]+ /.test(l) && !l.startsWith("kokoro "))).toEqual([]);
  });

  it("treats a WAV with no samples in it as a failure, not as audio", () => {
    // A header-only WAV is the shape "success" takes when the model loaded but
    // synthesised nothing — exit code 0, file exists, no audio. Passing that
    // upstream as speech is the silent success the script must never produce.
    stubKokoro();
    const r = synth([], { KOKORO_SECONDS: "0" });
    expectReportedFailure(r);
    expect(r.stderr).toContain("produced no audio");
  });

  it("skips the COLD START entirely when the board has no memory headroom, and says so", () => {
    // kokoro-torch peaks at 2259-2636 MB (TASK-382) on a board whose 7607 MB
    // is shared with the GPU. Attempting it at 900 MB free does not fail
    // politely, it OOM-kills something else — so kokoro must never be
    // invoked. With no CPU engine to fall back on, the refusal itself is the
    // report the gateway acts on.
    stubKokoro();
    writeMeminfo(900);
    const r = synth([]);
    expectReportedFailure(r);
    expect(calls()).not.toContain("kokoro ");
    expect(r.stderr).toMatch(/kokoro: skipped, 900MB available/);
  });

  it("still speaks through the resident server on a board with no headroom left", () => {
    // The other half of the same guard, and the reason it moved: the server
    // is holding the model already, so its synthesis allocates nothing the
    // guard is protecting. Applied to this path too, the guard refused every
    // reply that followed an agent turn (ollama keeps its embedding model
    // resident for five minutes, which leaves ~2.8 GB) and the cloud voice
    // answered instead — on a box whose own voice was up and idle.
    const sock = startServer("ok");
    stubKokoro();
    writeMeminfo(900);
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).toContain("server voice=af_heart");
    // And the cold path is still refused: no CLI ran, no 2.6 GB was asked for.
    expect(calls()).not.toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("uses the GPU again once the headroom is back", () => {
    // Guards against a threshold that is simply always tripped.
    stubKokoro();
    writeMeminfo(3200);
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("honours an overridden memory threshold", () => {
    stubKokoro();
    writeMeminfo(3200);
    const r = synth([], { CLAWBOX_TTS_MIN_FREE_MB: "5000" });
    expectReportedFailure(r);
    expect(calls()).not.toContain("kokoro ");
  });

  it("gives up on a hung Kokoro inside its own slice and reports it, rather than waiting to be killed", () => {
    // The scenario the budget exists for, end to end: kokoro never returns.
    // With timeoutMs equal to KOKORO_TIMEOUT, OpenClaw killed this process at
    // the moment kokoro was given up on, so not even the reasons reached the
    // gateway. Timeouts are shrunk here so the test is quick; the property
    // under test is that the script ends on ITS deadline with a report.
    writeStub("kokoro", ['echo "kokoro $*" >> "$CALLS_LOG"', "sleep 30"].join("\n"));
    const started = Date.now();
    const r = synth([], { KOKORO_TIMEOUT: "2", KOKORO_SERVER_TIMEOUT: "1" });
    expectReportedFailure(r);
    expect(calls()).toContain("kokoro ");
    // It gave up on kokoro and reported, rather than waiting out the sleep.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("names every reason it collected, not just the last one", () => {
    // A server that refuses AND a cold start that fails: both reasons have to
    // reach stderr, because the gateway log is the only place an operator can
    // tell "the resident server is wedged" from "CUDA is gone".
    const sock = startServer("refuse");
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: sock, KOKORO_FAIL: "1" });
    expectReportedFailure(r);
    expect(r.stderr).toContain("refused the request");
    expect(r.stderr).toMatch(/kokoro: '.*' failed/);
  });

  it("exits non-zero with a diagnostic when no engine can run", () => {
    // Silence is the bug. Whatever else happens, the reason must reach stderr,
    // where OpenClaw surfaces it as `CLI TTS exit 1: <stderr>`.
    const r = synth([]);
    expectReportedFailure(r);
    expect(r.stderr).toMatch(/--step openclaw_tts/);
  });

  // ── Where the engine is, and what it can load ─────────────────────────────
  // Installing Kokoro was not enough. With the whole package set on disk and
  // `kokoro -t ... -o ...` producing 105 KB of audio from an interactive
  // shell, a real Orin still spoke through the CPU fallback: the CLI lives at
  // ~/.local/bin, which is not on the PATH OpenClaw execs this script with,
  // and torch cannot import libcusparseLt.so.0 without a loader path that
  // only ~/.bashrc and the systemd unit carried (TASK-420).

  it("finds the CLI pip --user installed, which the exec PATH does not include", () => {
    const userBin = path.join(dir, ".local", "bin");
    mkdirSync(userBin, { recursive: true });
    stubKokoro(userBin);
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("says where it looked when the CLI is in neither place", () => {
    const r = synth([]);
    expectReportedFailure(r);
    expect(r.stderr).toContain("is not installed");
    // "not installed" is what a box printed while Kokoro was installed and
    // working at exactly this path, so the note has to name the path it
    // checked rather than leave that as the reader's guess.
    expect(r.stderr).toContain(path.join(dir, ".local/bin/kokoro"));
  });

  it("lets an explicit KOKORO_BIN outrank both PATH and ~/.local/bin", () => {
    // The per-channel provider `env` sets it, and this suite drives the script
    // through it, so resolution must not quietly take the choice away.
    const userBin = path.join(dir, ".local", "bin");
    mkdirSync(userBin, { recursive: true });
    writeStub("kokoro", 'echo "wrong-kokoro-from-PATH $*" >> "$CALLS_LOG"; exit 1');
    writeStub("kokoro", 'echo "wrong-kokoro-from-user-site $*" >> "$CALLS_LOG"; exit 1', userBin);
    const explicit = stubKokoro(binDir, "kokoro-explicit");
    const r = synth([], { KOKORO_BIN: explicit });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(calls()).not.toContain("wrong-kokoro");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("hands Kokoro the CUDA loader path, appended to whatever was already set", () => {
    const cusparse = path.join(dir, ".local/lib/python3.10/site-packages/nvidia/cusparselt/lib");
    mkdirSync(cusparse, { recursive: true });
    stubKokoro();
    const r = synth([], { LD_LIBRARY_PATH: "/opt/already-here" });
    expect(r.status).toBe(0);
    const observed = calls().split("\n").find((l) => l.startsWith("ld=")) ?? "";
    // Split into entries rather than substring-matching the whole string:
    // $HOME/.local/lib is a PREFIX of the cusparselt path, so a toContain on
    // the joined value would be satisfied by the cusparselt entry alone and
    // would not notice $HOME/.local/lib going missing.
    const entries = observed.replace(/^ld=/, "").split(":");
    expect(entries, "the engine was invoked without the cusparselt path").toContain(cusparse);
    expect(entries, "the engine was invoked without the user-site lib dir").toContain(path.join(dir, ".local/lib"));
    // Appended, never replaced — and ours first, so it is not shadowed.
    expect(entries).toContain("/opt/already-here");
    expect(entries.indexOf(cusparse)).toBeLessThan(entries.indexOf("/opt/already-here"));
    // An empty entry means "the current directory" to the loader, which is not
    // somewhere to resolve .so files from.
    expect(entries.filter((e) => e === "")).toEqual([]);
  });

  // ── Voices ────────────────────────────────────────────────────────────────

  it("passes the selected voice through to Kokoro", () => {
    stubKokoro();
    const r = synth(["--voice", "am_michael"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=am_michael");
  });

  it("maps an OpenAI-style voice alias onto its Kokoro voice", () => {
    stubKokoro();
    const r = synth(["--voice", "onyx"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=am_michael");
  });

  it("degrades an unknown voice to the default instead of erroring", () => {
    stubKokoro();
    const r = synth(["--voice", "definitely-not-a-voice"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=af_heart");
    expect(r.stderr).toContain("unknown voice");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("offers no voice that no engine can speak", () => {
    // bg_dimitar existed only as a Piper voice (Kokoro has no Bulgarian voice,
    // TASK-382). With Piper gone, keeping it in the catalogue would make
    // `--set-voice bg_dimitar` a way of muting the box: every reply would fail
    // on "no Kokoro voice". So it is not a known voice at all — it degrades to
    // the default like any other unknown name, and cannot be persisted.
    stubKokoro();
    const listed = run(["--list-voices"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain("bg_dimitar");
    const r = synth(["--voice", "bg_dimitar"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("unknown voice");
    expect(calls()).toContain("voice=af_heart");
    const set = run(["--set-voice", "bg_dimitar"]);
    expect(set.status).not.toBe(0);
    expect(existsSync(voiceFile)).toBe(false);
  });

  it("persists a chosen voice and uses it on later runs", () => {
    stubKokoro();
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

  it("tells Kokoro the American language code for an American voice", () => {
    stubKokoro();
    const r = synth(["--voice", "af_heart"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("lang=a");
  });

  it("tells Kokoro the British language code for a British voice", () => {
    // kokoro does not fail on a mismatch — it warns "Language mismatch,
    // loading <voice> into <language> pipeline" and synthesises anyway, so
    // hardcoding -l a degraded pronunciation instead of erroring.
    stubKokoro();
    const r = synth(["--voice", "bm_george"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("voice=bm_george");
    expect(calls()).toContain("lang=b");
    expect(calls()).not.toContain("lang=a");
  });

  // ── Server first, cold start second ───────────────────────────────────────

  it("prefers the resident model server over a cold start", () => {
    // The persistent kokoro-server keeps the model on the GPU; cold-starting
    // the CLI instead is the difference between ~2s and a full model load.
    const sock = startServer("ok");
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).toContain("server voice=af_heart");
    // The whole point of the socket is not paying for a model load.
    expect(calls()).not.toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  it("cold-starts when the server socket is gone", () => {
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: path.join(dir, "absent.sock") });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
  });

  it("asks systemd for the persistent server once it has paid for a cold start", () => {
    // Nothing else on the box starts kokoro-server: the Local AI switch does,
    // and the server stops itself after five idle minutes. Without this every
    // reply of a conversation paid the full 13-19 s model load again.
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: path.join(dir, "absent.sock") });
    expect(r.status).toBe(0);
    expect(calls()).toContain("systemctl --user start --no-block kokoro-server.service");
  });

  it("warms the server even when a dead one left its socket file behind", () => {
    // The shape on a real box: kokoro-server.py's idle shutdown used to
    // os._exit without unlinking, so `[ -S … ]` answers yes for a socket
    // nothing is listening on. A warm-up that trusted that test would never
    // fire on exactly the boxes that need it.
    const sock = startServer("ok");
    for (const s of servers) s.kill("SIGKILL");
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).toContain("kokoro ");
    expect(calls()).toContain("systemctl --user start --no-block kokoro-server.service");
  });

  it("does not ask for the server it just spoke through", () => {
    const sock = startServer("ok");
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("systemctl ");
  });

  it("keeps the audio when systemd refuses to start the server", () => {
    // The warm-up runs AFTER the caller's audio is on disk, so nothing it does
    // may change the outcome of the utterance.
    writeStub("systemctl", 'echo "systemctl $*" >> "$CALLS_LOG"\nexit 1');
    stubKokoro();
    const r = synth([]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("systemctl ");
    expect(outputBytes()).toBeGreaterThan(1024);
    expect(r.stdout.trim()).toBe(outPath);
  });

  it("cold-starts when the server refuses, and still speaks", () => {
    // The server-then-CLI chain is the one fallback that stays: same engine,
    // same model, just not resident. A refused socket must not end the run
    // while the CLI can still answer.
    const sock = startServer("refuse");
    stubKokoro();
    const r = synth([], { KOKORO_SOCKET: sock });
    expect(r.status).toBe(0);
    expect(calls()).toContain("server voice=af_heart");
    expect(calls()).toContain("kokoro ");
    expect(outputBytes()).toBeGreaterThan(1024);
  });

  // ── Output ────────────────────────────────────────────────────────────────

  it("never writes WAV bytes into a file claiming to be something else", () => {
    // OpenClaw picks the extension from outputFormat. If a deployment asks for
    // mp3 on a box with no ffmpeg, handing back a mislabelled WAV is broken
    // audio; failing with a reason is not.
    stubKokoro();
    const mp3 = path.join(dir, "out", "speech.mp3");
    const r = run(["--", "Your ClawBox is ready.", mp3], { FFMPEG_BIN: path.join(dir, "no-ffmpeg") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ffmpeg");
    expect(existsSync(mp3)).toBe(false);
  });

  it("does not mistake reply text starting with -- for its own options", () => {
    stubKokoro();
    const r = run(["--", "--voice is a strange thing to say", outPath]);
    expect(r.status).toBe(0);
    expect(outputBytes()).toBeGreaterThan(1024);
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

  // ── The time budget ───────────────────────────────────────────────────────

  it("leaves room for the whole chain inside the caller's timeout", () => {
    // The regression this pins: timeoutMs and KOKORO_TIMEOUT were both 120s,
    // so OpenClaw killed the process at the moment Kokoro gave up and nothing
    // — not even the reasons — reached the gateway.
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    const providerMs = Number(spawnSync("bash", [SCRIPT, "--provider-timeout-ms"], { encoding: "utf8" }).stdout.trim());
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
    expect(providerMs).toBeGreaterThan(budget * 1000);
  });

  it("reports a budget that is really the sum of EVERY slice handed to timeout", () => {
    // Stops the budget from being a decorative number that drifts away from
    // the timeouts actually handed to `timeout`.
    //
    // SWEPT FROM THE SCRIPT, NOT LISTED HERE. A hand-written `parts` array is
    // blind to a slice added without a budget entry, which is exactly what
    // happened: the EMAIL: directive strip became a fourth `timeout` — running
    // before the engine chain, worth up to 15s — and this test could not see
    // it, so `--provider-timeout-ms` under-reported the worst case that
    // install.sh bakes into the provider. Ask the script which variables it
    // actually hands to `timeout` instead.
    const src = readFileSync(SCRIPT, "utf8");
    const slice = (name: string): number => {
      const m = src.match(new RegExp(`^${name}="\\$\\{${name}:-(\\d+)\\}"`, "m"));
      if (!m) throw new Error(`${name} default not found`);
      return Number(m[1]);
    };
    // `-k N` is part of a slice's worst case, so it is captured and counted too.
    const enforced = new Map<string, number>();
    for (const m of src.matchAll(/timeout (?:-k (\d+) )?"\$([A-Z0-9_]+)"/g)) {
      const name = m[2];
      enforced.set(name, Math.max(enforced.get(name) ?? 0, m[1] ? Number(m[1]) : 0));
    }
    // A sweep that sweeps nothing is a green no-op, which is the failure this
    // rewrite exists to refuse.
    expect(enforced.size).toBeGreaterThanOrEqual(4);
    let sum = 0;
    for (const [name, grace] of enforced) sum += slice(name) + grace;
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    expect(budget).toBe(sum);
  });

  it("pays for no slice an engine no longer uses", () => {
    // The Piper slice (15s) came out of the budget with the engine. Rope the
    // caller reserves for a step that never runs is 15s of extra silence on
    // every failure before the cloud voice gets its turn.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/PIPER_TIMEOUT/);
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    // 10 server + 40 cold start + 10 convert + (10 strip + 5 SIGKILL grace).
    expect(budget).toBe(75);
  });

  it.each([
    ["KOKORO_SERVER_TIMEOUT", "0"],
    ["KOKORO_SERVER_TIMEOUT", "abc"],
    ["KOKORO_TIMEOUT", "0"],
    ["KOKORO_TIMEOUT", "00"],
    ["KOKORO_TIMEOUT", "abc"],
    ["CONVERT_TIMEOUT", "0"],
    ["CONVERT_TIMEOUT", "abc"],
    ["TTS_BUDGET_MARGIN_SECONDS", "abc"],
    ["EMAIL_DIRECTIVES_TIMEOUT", "0"],
    ["EMAIL_DIRECTIVES_TIMEOUT", "abc"],
  ])("coerces a %s of %s rather than reporting a budget it does not keep", (name, value) => {
    // Every one of these reaches the script through the service environment,
    // and `${VAR:-N}` substitutes on unset and empty and on NOTHING else — so a
    // value already there is used exactly as given. Two spellings undo the
    // slice they name, silently:
    //
    //   `timeout 0` (and "00", "000") is NO timeout, so the step is unbounded
    //   while `--provider-timeout-ms` still reports a number the caller trusts
    //   — the script then outlives the timeout it just asked for, OpenClaw
    //   kills it, and nothing after that point reaches the gateway. That is
    //   verbatim the "hung GPU was silence with no diagnostic" regression the
    //   budget section exists to close.
    //
    //   a non-numeric duration makes `timeout` exit 125 WITHOUT running the
    //   command: `KOKORO_TIMEOUT=abc` is a local voice that never works,
    //   `CONVERT_TIMEOUT=abc` is no audio at all, and `EMAIL_DIRECTIVES_TIMEOUT=abc`
    //   is the box reading the uid aloud.
    //
    // The budget is the only place the script says what it will spend, so it is
    // where the coercion is read back.
    const r = spawnSync("bash", [SCRIPT, "--budget-seconds"], {
      encoding: "utf8",
      env: { ...process.env, [name]: value },
    });
    expect(r.status).toBe(0);
    expect(Number(r.stdout.trim())).toBe(75);
    // `set -u` turns an unvalidated non-numeric knob into an arithmetic abort
    // on the way past, which nothing reads: it must not happen at all.
    expect(r.stderr).not.toMatch(/unbound variable/);
  });

  it("keeps every engine slice short enough to fail over usefully", () => {
    // A spoken reply that takes even half a minute has already failed as an
    // interaction; the point of the budget is fast failover to the cloud
    // voice, not long rope.
    const budget = Number(spawnSync("bash", [SCRIPT, "--budget-seconds"], { encoding: "utf8" }).stdout.trim());
    expect(budget).toBeLessThanOrEqual(120);
  });

  // ── Kokoro-only, in the text as well as the behaviour ─────────────────────

  it("carries no second engine: no Piper code, no Piper hint", () => {
    const src = readFileSync(SCRIPT, "utf8");
    for (const gone of ["try_piper", "PIPER_BIN", "PIPER_VOICE_DIR", "piper_voice_for", "--piper-only", "fell back to"]) {
      expect(src, `${gone} is still in the script`).not.toContain(gone);
    }
    // The dispatch is Kokoro and nothing after it.
    expect(src).toMatch(/^if try_kokoro "\$TEXT" "\$TMPWAV" "\$VOICE"; then$/m);
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

  // The provider DEFINITION — script check, timeout, JSON, config set — lives
  // in a helper the step calls from both of its paths (fresh, and preserving
  // another selection), so the two are read together. The helper comes
  // second: the ordering assertions below walk the step first.
  const step = [
    extractShellFunction(INSTALL_SH, "step_openclaw_tts"),
    extractShellFunction(INSTALL_SH, "tts_write_local_provider_definition"),
  ].join("\n");

  it("seeds the provider only when the owner has not chosen one", () => {
    // Same contract as agents.defaults.model.primary: an owner who switched to
    // ElevenLabs must not be reset to the local CLI by every update.
    // OpenClaw 2 moved the speech block to a top-level tts object; the step
    // resolves the home once and speaks whichever dialect the box's binary
    // does. Pinning the mapping keeps a future edit from writing one
    // generation's keys to the other's gateway.
    expect(step).toContain('TTS_HOME="messages.tts"');
    expect(step).toContain('openclaw_is_v2 && TTS_HOME="tts"');
    expect(step).toContain('config get "$TTS_HOME.provider"');
    expect(step).toMatch(/CURRENT_TTS.*!=.*"null"|"\$CURRENT_TTS" != "null"/);
    expect(step).toContain("preserving");
    // The preserve branch must return BEFORE anything is written, otherwise
    // "seed-if-unset" is just "set". It returns $TTS_RC rather than a literal
    // 0: preserving the owner's provider says nothing about whether the GPU
    // engine installed, and a Kokoro that was requested and failed has to leave
    // the step on this path too — that population (already-configured, updating
    // in place) is exactly the one that had the defect.
    const guardIndex = step.indexOf("preserving");
    const setIndex = step.indexOf('oc_config_set "$TTS_HOME.provider"');
    expect(step.slice(guardIndex, setIndex)).toMatch(/return "\$TTS_RC"/);
    expect(setIndex).toBeGreaterThan(guardIndex);
  });

  it("does not select a provider it failed to define", () => {
    // oc_config_set retries 3x then returns 1. Naming tts-local-cli as THE
    // provider after its definition failed to land points the box at a
    // provider that does not exist and breaks every spoken reply.
    expect(step).toContain('if ! tts_write_local_provider_definition "$TTS_HOME" "$TTS_SCRIPT"; then');
    const defineIndex = step.indexOf('if ! tts_write_local_provider_definition "$TTS_HOME" "$TTS_SCRIPT"; then');
    const selectIndex = step.indexOf('oc_config_set "$TTS_HOME.provider" ');
    expect(selectIndex).toBeGreaterThan(defineIndex);
    expect(step.slice(defineIndex, selectIndex)).toContain("return 1");
    // And the helper itself writes through the retrying oc_config_set.
    expect(step).toContain('oc_config_set "$TTS_HOME.providers.tts-local-cli"');
  });

  it("refuses to wire the provider to a command that is not there", () => {
    expect(step).toContain('[ ! -x "$TTS_SCRIPT" ]');
    const checkIndex = step.indexOf('[ ! -x "$TTS_SCRIPT" ]');
    const setIndex = step.indexOf('oc_config_set "$TTS_HOME.providers');
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
    expect(step).toContain('oc_config_set "$TTS_HOME.providers.tts-local-cli"');
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

  it("installs Kokoro as part of the same step, and names no second engine", () => {
    expect(step).toContain("install-voice.sh");
    // A fallback-only flag until TASK-420, which installed the CPU fallback
    // and nothing else while this step claimed Kokoro GPU. --tts-only installs
    // Kokoro; behaviour is covered by install-kokoro-tts.test.ts, which
    // executes it.
    expect(step).toMatch(/install-voice\.sh" --tts-only/);
    // The step's own summary lines must not name an engine the box does not
    // have. Piper is gone; the only engine the step may claim is Kokoro.
    expect(step).not.toMatch(/piper/i);
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

describe("install-voice.sh installs no second engine", () => {
  it("has no Piper install step, mode flag, or pinned artifact left", () => {
    // The owner removed the CPU fallback outright. A half-removal — the
    // install step gone but the flag or the digests still there — is how a
    // "removed" engine comes back on the next update.
    for (const gone of ["install_piper", "piper_fetch", "--piper-only", "PIPER_DIR", "PIPER_TARBALL_SHA256", "INSTALL_BG_VOICE", "piper_report", "TTS_PIPER_VERDICT"]) {
      expect(INSTALL_VOICE_SH, `${gone} is still in install-voice.sh`).not.toContain(gone);
    }
  });

  it("downloads nothing by hand: the only fetches left are pip's", () => {
    // Every curl in this file belonged to the Piper artifacts. With them gone
    // there must be none: a new raw download here would be an unpinned,
    // unbounded fetch onto a customer device on every in-app update.
    expect(curlInvocations(INSTALL_VOICE_SH)).toEqual([]);
  });

  it("publishes exactly one engine key to the verdict file", () => {
    // install.sh's health check reads KOKORO= and nothing else now. A second
    // key would either be ignored (pointless) or scored (an engine that does
    // not exist deciding whether a box is healthy).
    const publish = INSTALL_VOICE_SH.slice(
      INSTALL_VOICE_SH.indexOf("tts_status_publish() {"),
      INSTALL_VOICE_SH.indexOf("\n}", INSTALL_VOICE_SH.indexOf("tts_status_publish() {")),
    );
    expect(publish).toContain("printf 'KOKORO=%s\\n'");
    expect(publish).not.toContain("PIPER=");
  });

  it("treats a missing TTS entrypoint as a deploy failure", () => {
    const fn = INSTALL_VOICE_SH.slice(
      INSTALL_VOICE_SH.indexOf("deploy_voice_scripts() {"),
      INSTALL_VOICE_SH.indexOf("\n}", INSTALL_VOICE_SH.indexOf("deploy_voice_scripts() {")),
    );
    expect(fn).toContain("clawbox-tts.sh is missing");
    expect(fn).toContain('return "$rc"');
  });

  it.skipIf(!hasBash)("refuses an option it does not know instead of running the hour-long full install", () => {
    // The removed flag used to be matched before the full-pipeline path. A
    // caller that still passes it must be told, not handed an hour of
    // CTranslate2 source builds and a Whisper download on a shipped device.
    // The check runs before anything is executed, so this is safe to invoke.
    const r = spawnSync("bash", [path.resolve(process.cwd(), "scripts/install-voice.sh"), "--piper-only"], {
      encoding: "utf8",
      env: testEnv({ PATH: "/usr/bin:/bin", HOME: tmpdir(), CLAWBOX_HOME: path.join(tmpdir(), "no-such-home") }),
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown option");
    expect(r.stdout).not.toContain("Voice Pipeline Installer");
  });
});
