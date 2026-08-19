import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// These run the shipped scripts/bench/tts-bench.py itself against stub engines:
// a fake `piper` binary that writes a WAV of a known length after a known
// delay, and a fake worker interpreter that speaks the harness's own JSONL
// protocol. That makes the arithmetic checkable — a stub that takes 0.2s to
// produce 2s of audio must come back as RTF 0.1 / 10x real time — and it means
// the test breaks if the script's engine contract drifts, which a
// reimplementation of the maths in TypeScript would not.

const SCRIPT = path.resolve(process.cwd(), "scripts/bench/tts-bench.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let dir: string;
let cache: string;

/** A minimal 16-bit mono WAV of `seconds` duration, as a python one-liner. */
function wavWriter(seconds: number): string {
  return [
    "import sys, wave",
    "w = wave.open(sys.argv[1], 'wb')",
    "w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)",
    `w.writeframes(b'\\x00\\x00' * int(22050 * ${seconds}))`,
    "w.close()",
  ].join("\n");
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tts-bench-"));
  cache = path.join(dir, "cache");
  mkdirSync(cache, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stub piper: sleeps `delay` seconds, then writes `audio` seconds of WAV to the
 * path after -f. Also records that it was invoked with the expected voice.
 */
function stubPiper(delay: number, audio: number): { bin: string; voices: string } {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const writer = path.join(dir, "write_wav.py");
  writeFileSync(writer, wavWriter(audio));
  const bin = path.join(binDir, "piper");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'cat > /dev/null',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in -f) out="$2"; shift 2;; -m) echo "$2" >> "$PIPER_CALLS"; shift 2;; *) shift;; esac',
      "done",
      `sleep ${delay}`,
      `python3 "${writer}" "$out"`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  // The availability check requires both voice models to exist on disk.
  const voices = path.join(dir, "voices");
  mkdirSync(voices, { recursive: true });
  for (const voice of ["en_US-lessac-medium", "bg_BG-dimitar-medium"]) {
    writeFileSync(path.join(voices, `${voice}.onnx`), "stub");
    writeFileSync(path.join(voices, `${voice}.onnx.json`), "{}");
  }
  return { bin, voices };
}

/**
 * Stub worker interpreter: ignores the harness's python source, answers the
 * ready handshake, then answers each request with fixed timings and a real WAV.
 */
function stubWorker(audio: number, wall: number, opts: { dieAfter?: number; failStart?: boolean } = {}): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  // The worker program lives in its own file and is exec'd, so the harness's
  // JSONL requests reach it on stdin. A heredoc would eat that stdin.
  const prog = path.join(dir, "worker.py");
  writeFileSync(
    prog,
    [
      "import json, sys, wave",
      "TAG = '__ttsbench__ '",
      // Real engines print banners before we get a word in — torch, spaCy and
      // kokoro all do it on the device. The harness must step over them.
      "print('WARNING: Defaulting repo_id to hexgrad/Kokoro-82M.', flush=True)",
      "print(TAG + json.dumps({'ready': True, 'rss_kb': 512000, 'device': 'cuda:0'}), flush=True)",
      "served = 0",
      "for line in sys.stdin:",
      "    line = line.strip()",
      "    if not line:",
      "        continue",
      "    req = json.loads(line)",
      "    if req.get('quit'):",
      "        break",
      `    if ${opts.dieAfter ?? -1} >= 0 and served >= ${opts.dieAfter ?? -1}:`,
      "        sys.stderr.write('worker crashed'); sys.stderr.flush(); sys.exit(3)",
      "    w = wave.open(req['out'], 'wb')",
      "    w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)",
      `    w.writeframes(b'\\x00\\x00' * int(24000 * ${audio}))`,
      "    w.close()",
      "    served += 1",
      "    print('some library logging to stdout mid-run', flush=True)",
      `    print(TAG + json.dumps({'wall': ${wall}, 'audio': ${audio}, 'rss_kb': 640000}), flush=True)`,
    ].join("\n"),
  );
  const worker = path.join(binDir, "fakepython");
  const body = opts.failStart
    ? ["#!/usr/bin/env bash", 'echo "no module named kokoro" >&2', "exit 1"].join("\n")
    : ["#!/usr/bin/env bash", `exec python3 "${prog}"`].join("\n");
  writeFileSync(worker, body);
  chmodSync(worker, 0o755);
  return worker;
}

function utteranceFile(): string {
  const p = path.join(dir, "utterances.json");
  writeFileSync(
    p,
    JSON.stringify([
      { id: "en-short", lang: "en", text: "Your ClawBox is ready." },
      { id: "bg-short", lang: "bg", text: "Кутията ви е готова." },
    ]),
  );
  return p;
}

describe.skipIf(!hasPython3)("scripts/bench/tts-bench.py", () => {
  it("reports RTF as wall over audio, from the engine it actually ran", () => {
    const { bin, voices } = stubPiper(0.2, 2.0);
    const out = path.join(dir, "report.json");
    const r = run(
      [
        "--engines", "piper",
        "--reps", "3",
        "--cache", cache,
        "--piper-bin", bin,
        "--piper-voices", voices,
        "--utterances", utteranceFile(),
        "--out", out,
      ],
      { PIPER_CALLS: path.join(dir, "calls.log") },
    );
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const piper = report.engines.find((e: any) => e.name === "piper");
    expect(piper.skipped).toBeUndefined();
    expect(piper.rows).toHaveLength(2);
    for (const row of piper.rows) {
      expect(row.audio_seconds).toBeCloseTo(2.0, 1);
      // 0.2s of work for 2s of audio: RTF 0.1, i.e. 10x real time. Generous
      // bounds so a loaded CI box cannot make this flaky, tight enough that a
      // swapped numerator and denominator fails.
      expect(row.median_rtf).toBeGreaterThan(0.05);
      expect(row.median_rtf).toBeLessThan(0.4);
      expect(row.median_x_realtime).toBeGreaterThan(2.5);
      expect(row.reps).toBe(3);
    }
  });

  it("uses the language's own voice, not the first one it finds", () => {
    const { bin, voices } = stubPiper(0.05, 1.0);
    const calls = path.join(dir, "calls.log");
    const r = run(
      ["--engines", "piper", "--reps", "1", "--cache", cache, "--piper-bin", bin,
       "--piper-voices", voices, "--utterances", utteranceFile()],
      { PIPER_CALLS: calls },
    );
    expect(r.status).toBe(0);
    const used = readFileSync(calls, "utf8");
    expect(used).toContain("en_US-lessac-medium.onnx");
    expect(used).toContain("bg_BG-dimitar-medium.onnx");
  });

  it("excludes the cold run from the median and reports it separately", () => {
    // First call sleeps 1s, the rest are instant: a median that included the
    // cold run would be dragged far above the warm ones.
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const writer = path.join(dir, "w.py");
    writeFileSync(writer, wavWriter(1.0));
    const bin = path.join(binDir, "piper");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env bash",
        "cat > /dev/null",
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2;; *) shift;; esac; done',
        'n=$(cat "$COUNTER" 2>/dev/null || echo 0)',
        'echo $((n + 1)) > "$COUNTER"',
        'if [ "$n" -eq 0 ]; then sleep 1; fi',
        `python3 "${writer}" "$out"`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    const voices = path.join(dir, "voices");
    mkdirSync(voices, { recursive: true });
    for (const v of ["en_US-lessac-medium", "bg_BG-dimitar-medium"]) {
      writeFileSync(path.join(voices, `${v}.onnx`), "stub");
    }
    const single = path.join(dir, "one.json");
    writeFileSync(single, JSON.stringify([{ id: "en-short", lang: "en", text: "hi" }]));
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "piper", "--reps", "4", "--cache", cache, "--piper-bin", bin,
                   "--piper-voices", voices, "--utterances", single, "--out", out],
                  { COUNTER: path.join(dir, "counter") });
    expect(r.status).toBe(0);
    const row = JSON.parse(readFileSync(out, "utf8")).engines[0].rows[0];
    expect(row.cold_wall_seconds).toBeGreaterThan(0.9);
    expect(row.median_wall_seconds).toBeLessThan(0.5);
  });

  it("keeps one audio sample per case for a human to listen to", () => {
    const { bin, voices } = stubPiper(0.02, 1.0);
    const audioDir = path.join(dir, "audio");
    const r = run(["--engines", "piper", "--reps", "3", "--cache", cache, "--piper-bin", bin,
                   "--piper-voices", voices, "--utterances", utteranceFile(), "--audio-dir", audioDir],
                  { PIPER_CALLS: path.join(dir, "calls.log") });
    expect(r.status).toBe(0);
    const files = readdirSync(audioDir).sort();
    // One file per utterance, the last rep — not one per rep.
    expect(files).toEqual(["piper_bg-short_2.wav", "piper_en-short_2.wav"]);
  });

  it("fails loudly when a requested engine cannot run", () => {
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "piper", "--reps", "1", "--cache", cache,
                   "--piper-bin", path.join(dir, "nope"), "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).not.toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.engines[0].skipped).toContain("piper binary not found");
    expect(r.stdout).toContain("Not measured");
  });

  it("still exits zero with --skip-missing, but says what was not measured", () => {
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "piper", "--reps", "1", "--cache", cache, "--skip-missing",
                   "--piper-bin", path.join(dir, "nope"), "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Not measured");
    expect(JSON.parse(readFileSync(out, "utf8")).engines[0].rows).toHaveLength(0);
  });

  it("measures a worker engine without charging model load to every utterance", () => {
    const worker = stubWorker(2.0, 0.25);
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "kokoro-torch", "--reps", "3", "--cache", cache,
                   "--python-bin", worker, "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).toBe(0);
    const engine = JSON.parse(readFileSync(out, "utf8")).engines[0];
    expect(engine.device).toBe("cuda:0");
    expect(engine.rows[0].median_rtf).toBeCloseTo(0.125, 2);
    // VmHWM comes from the worker itself; a sampled RSS would miss the peak.
    expect(engine.rows[0].peak_rss_kb).toBe(640000);
  });

  it("steps over library banners on the worker's stdout instead of parsing them", () => {
    // The first device run of kokoro-torch failed exactly here: torch and
    // spaCy print to stdout before the worker's handshake.
    const worker = stubWorker(2.0, 0.5);
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "kokoro-torch", "--reps", "2", "--cache", cache,
                   "--python-bin", worker, "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).toBe(0);
    const engine = JSON.parse(readFileSync(out, "utf8")).engines[0];
    expect(engine.skipped).toBeUndefined();
    expect(engine.rows[0].median_rtf).toBeCloseTo(0.25, 2);
  });

  it("records a worker that dies mid-run as a failure, not as fast", () => {
    const worker = stubWorker(1.0, 0.1, { dieAfter: 1 });
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "kokoro-onnx", "--reps", "3", "--cache", cache,
                   "--python-bin", worker, "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).not.toBe(0);
    const engine = JSON.parse(readFileSync(out, "utf8")).engines[0];
    expect(engine.rows).toHaveLength(0);
    expect(engine.skipped).toBeTruthy();
  });

  it("reports an engine that cannot even start with the reason", () => {
    const worker = stubWorker(1, 1, { failStart: true });
    const out = path.join(dir, "report.json");
    const r = run(["--engines", "kokoro-torch", "--reps", "1", "--cache", cache,
                   "--python-bin", worker, "--utterances", utteranceFile(), "--out", out]);
    expect(r.status).not.toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).engines[0].skipped).toContain("worker did not start");
  });

  it("states the Bulgarian position of every engine, measured or not", () => {
    const out = path.join(dir, "report.json");
    const md = path.join(dir, "report.md");
    const r = run(["--engines", "piper,kokoro-onnx", "--reps", "1", "--cache", cache, "--skip-missing",
                   "--piper-bin", path.join(dir, "nope"), "--python-bin", path.join(dir, "nope"),
                   "--utterances", utteranceFile(), "--out", out, "--markdown", md]);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const piper = report.engines.find((e: any) => e.name === "piper");
    const kokoro = report.engines.find((e: any) => e.name === "kokoro-onnx");
    expect(piper.languages.bg).toContain("native voice");
    expect(kokoro.languages.bg).toContain("NO Bulgarian voice");
    // The Bulgarian verdict has to survive into the report a human reads.
    expect(readFileSync(md, "utf8")).toContain("NO Bulgarian voice");
  });

  it("refuses a rep count that cannot produce a median", () => {
    const r = run(["--engines", "piper", "--reps", "0", "--cache", cache, "--utterances", utteranceFile()]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--reps must be at least 1");
  });
});
