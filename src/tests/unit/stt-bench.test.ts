import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// These run the shipped scripts/bench/stt-bench.py itself against a STUB
// faster_whisper: a fake WhisperModel that sleeps a known time and returns a
// known transcript, injected through PYTHONPATH. That makes the arithmetic
// checkable end to end — 0.2s of work over 2s of audio must come back as
// RTF 0.1 / 10x real time — and it means the test breaks if the script's
// worker contract drifts, which a reimplementation of the maths in TypeScript
// would not. A stub ctranslate2 stands in for the runtime probe, so the
// CPU-only-wheel case that this board is expected to hit is exercised here
// rather than only on hardware.

const SCRIPT = path.resolve(process.cwd(), "scripts/bench/stt-bench.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

interface BenchRow {
  sample: string;
  lang: string;
  audio_seconds: number;
  cold_wall_seconds: number | null;
  median_wall_seconds: number | null;
  median_rtf: number | null;
  median_x_realtime: number | null;
  wer: number | null;
  cer: number | null;
  substitutions?: number;
  insertions?: number;
  deletions?: number;
  hypothesis?: string;
  peak_rss_kb?: number;
  reps: number;
  skipped?: string;
}
interface BenchVariant {
  name: string;
  model: string;
  compute_type: string;
  requested_device: string;
  device: string;
  english_only: boolean;
  languages: Record<string, string>;
  model_load_seconds?: number;
  skipped?: string;
  rows: BenchRow[];
}
interface BenchReport {
  provenance: Record<string, unknown>;
  reps: number;
  language_hint: boolean;
  device: {
    requested: string;
    resolved: string;
    note: string;
    cpu: string[];
    cuda: string[];
    ctranslate2_version: string;
    faster_whisper_version: string;
  };
  samples_meta: Record<string, unknown>;
  samples: { id: string; lang: string; reference_words: number }[];
  variants: BenchVariant[];
  cloud: { model: string; skipped?: string; rows?: Record<string, unknown>[] };
}

interface ScoredPair {
  id: string;
  wer: number | null;
  cer: number | null;
  substitutions: number;
  insertions: number;
  deletions: number;
  reference_words: number;
  normalized_reference: string;
  normalized_hypothesis: string;
}

/** Config the stub interpreter reads; every test shapes the fake engine here. */
interface StubConfig {
  compute_types?: Record<string, string[]>;
  cuda_error?: string;
  load_delay?: number;
  delay?: number;
  cold_delay?: number;
  die_after?: number;
  device?: string;
  compute_type?: string;
  fail_models?: string[];
  default_text?: string;
  transcripts?: Record<string, string>;
}

let dir: string;
let cache: string;
let stubs: string;
let configPath: string;
let callsPath: string;

/** A silent 16-bit mono 16 kHz WAV of `seconds`, which is what a voice note is. */
function writeWav(file: string, seconds: number): void {
  const rate = 16000;
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

const CTRANSLATE2_STUB = [
  "import json, os",
  '__version__ = "4.5.0-stub"',
  'CFG = json.load(open(os.environ["STT_STUB_CONFIG"], encoding="utf-8"))',
  "def get_supported_compute_types(device):",
  '    types = CFG.get("compute_types", {}).get(device)',
  "    if types is None:",
  // A wheel with no CUDA raises here; that path is the whole point of the probe.
  '        raise RuntimeError(CFG.get(device + "_error", "no " + device + " support in this build"))',
  "    return set(types)",
].join("\n");

const FASTER_WHISPER_STUB = [
  "import json, os, sys, time",
  '__version__ = "1.1.1-stub"',
  'CFG = json.load(open(os.environ["STT_STUB_CONFIG"], encoding="utf-8"))',
  "_calls = 0",
  "",
  "def _record(entry):",
  '    path = os.environ.get("STT_STUB_CALLS")',
  "    if not path:",
  "        return",
  '    with open(path, "a", encoding="utf-8") as f:',
  '        f.write(json.dumps(entry, ensure_ascii=False) + "\\n")',
  "",
  "class _Inner:",
  "    def __init__(self, device, compute_type):",
  "        self.device = device",
  "        self.compute_type = compute_type",
  "",
  "class _Segment:",
  "    def __init__(self, text):",
  "        self.text = text",
  "",
  "class WhisperModel:",
  '    def __init__(self, model_size_or_path, device="cpu", compute_type="default", **kwargs):',
  '        _record({"load": model_size_or_path, "device": device, "compute_type": compute_type})',
  '        if model_size_or_path in CFG.get("fail_models", []):',
  '            raise RuntimeError("stub: no weights for " + model_size_or_path)',
  '        time.sleep(CFG.get("load_delay", 0.0))',
  // The harness reads the device back off the loaded model rather than
  // trusting what it asked for, so the stub gets to disagree with the request.
  '        self.model = _Inner(CFG.get("device", device), CFG.get("compute_type", compute_type))',
  "",
  "    def transcribe(self, audio, **kwargs):",
  "        global _calls",
  '        _record({"transcribe": os.path.basename(audio), "language": kwargs.get("language")})',
  '        if CFG.get("die_after") is not None and _calls >= CFG["die_after"]:',
  '            sys.stderr.write("stub worker crashed\\n")',
  "            sys.stderr.flush()",
  "            os._exit(3)",
  '        time.sleep(CFG.get("cold_delay", CFG.get("delay", 0.0)) if _calls == 0 else CFG.get("delay", 0.0))',
  "        _calls += 1",
  '        text = CFG.get("transcripts", {}).get(os.path.basename(audio), CFG.get("default_text", ""))',
  // Leading and trailing space on purpose: the worker is supposed to strip it.
  '        return iter([_Segment("  " + text + " ")]), {"language": kwargs.get("language")}',
].join("\n");

function configure(config: StubConfig): void {
  writeFileSync(configPath, JSON.stringify(config), "utf8");
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Deleted rather than emptied: an inherited key would turn the cloud
      // comparator on for the whole suite and send audio to OpenAI.
      OPENAI_API_KEY: undefined,
      PYTHONPATH: stubs,
      STT_STUB_CONFIG: configPath,
      STT_STUB_CALLS: callsPath,
      ...env,
    } as NodeJS.ProcessEnv,
    timeout: 120_000,
  });
}

/** Write a manifest of {id, lang, audio, reference} and the WAVs it points at. */
function manifestFile(
  samples: { id: string; lang: string; seconds: number; reference: string }[],
  meta: Record<string, unknown> = {},
): string {
  const audioDir = path.join(dir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const entries = samples.map((sample) => {
    const audio = `${sample.id}.wav`;
    writeWav(path.join(audioDir, audio), sample.seconds);
    return { id: sample.id, lang: sample.lang, audio, reference: sample.reference };
  });
  const file = path.join(audioDir, "manifest.json");
  // A bare list is the documented minimum; metadata turns it into an object.
  writeFileSync(file, JSON.stringify(Object.keys(meta).length ? { ...meta, samples: entries } : entries), "utf8");
  return file;
}

function bilingualManifest(seconds = 2.0): string {
  return manifestFile([
    { id: "en-1", lang: "en", seconds, reference: "Your ClawBox is ready." },
    { id: "bg-1", lang: "bg", seconds, reference: "Кутията ви е готова." },
  ]);
}

function readReport(file: string): BenchReport {
  return JSON.parse(readFileSync(file, "utf8")) as BenchReport;
}

function score(pairs: { id: string; reference: string; hypothesis: string }[]): Record<string, ScoredPair> {
  const file = path.join(dir, "pairs.json");
  writeFileSync(file, JSON.stringify(pairs), "utf8");
  const result = run(["--score-only", file]);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout) as { pairs: ScoredPair[] };
  return Object.fromEntries(parsed.pairs.map((pair) => [pair.id, pair]));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "stt-bench-"));
  cache = path.join(dir, "cache");
  stubs = path.join(dir, "stubs");
  mkdirSync(cache, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  writeFileSync(path.join(stubs, "ctranslate2.py"), CTRANSLATE2_STUB, "utf8");
  writeFileSync(path.join(stubs, "faster_whisper.py"), FASTER_WHISPER_STUB, "utf8");
  configPath = path.join(dir, "stub-config.json");
  callsPath = path.join(dir, "stub-calls.jsonl");
  configure({ compute_types: { cpu: ["int8", "float32"] }, delay: 0.1 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)("scripts/bench/stt-bench.py", () => {
  it("reports RTF as wall over audio and x-realtime as its reciprocal", () => {
    configure({
      compute_types: { cpu: ["int8"] },
      delay: 0.2,
      transcripts: { "en-1.wav": "your clawbox is ready", "bg-1.wav": "Кутията ви е готова" },
    });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny",
      "--compute", "int8",
      "--reps", "3",
      "--cache", cache,
      "--samples", bilingualManifest(2.0),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const variant = readReport(out).variants[0];
    expect(variant.skipped).toBeUndefined();
    expect(variant.rows).toHaveLength(2);
    for (const row of variant.rows) {
      expect(row.audio_seconds).toBeCloseTo(2.0, 1);
      // 0.2s of work for 2s of audio: RTF 0.1, i.e. 10x real time. Generous
      // bounds so a loaded CI box cannot make this flaky, tight enough that a
      // swapped numerator and denominator fails.
      expect(row.median_rtf).toBeGreaterThan(0.05);
      expect(row.median_rtf).toBeLessThan(0.4);
      expect(row.median_x_realtime).toBeGreaterThan(2.5);
      expect(row.median_x_realtime).toBeLessThan(20);
      expect(row.reps).toBe(3);
    }
  });

  it("excludes the cold run from the median and reports it separately", () => {
    // The first transcription after the load sleeps a full second, the rest are
    // near-instant: a median that included the cold run would be dragged far
    // above the warm ones, which is exactly how a resident server gets
    // misreported as slow.
    configure({ compute_types: { cpu: ["int8"] }, cold_delay: 1.0, delay: 0.02, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny",
      "--compute", "int8",
      "--reps", "4",
      "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const row = readReport(out).variants[0].rows[0];
    expect(row.cold_wall_seconds).toBeGreaterThan(0.9);
    expect(row.median_wall_seconds).toBeLessThan(0.5);
  });

  it("charges model load to the variant, not to every transcription", () => {
    configure({ compute_types: { cpu: ["int8"] }, load_delay: 0.8, delay: 0.05, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "3", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const variant = readReport(out).variants[0];
    expect(variant.model_load_seconds).toBeGreaterThan(0.7);
    // The load happened once and none of it landed on a transcription.
    expect(variant.rows[0].cold_wall_seconds).toBeLessThan(0.5);
  });

  it("does not count case or punctuation as recognition errors", () => {
    const scored = score([
      { id: "clean", reference: "Your ClawBox is ready.", hypothesis: "your clawbox is ready" },
      { id: "punctuated", reference: "Yes — it is, finally!", hypothesis: "yes it is finally" },
      { id: "apostrophes", reference: "I don't think it's ready", hypothesis: "i dont think its ready" },
      { id: "hyphen", reference: "a well-known problem", hypothesis: "a well known problem" },
    ]);
    for (const id of ["clean", "punctuated", "apostrophes", "hyphen"]) {
      expect(scored[id].wer).toBe(0);
      expect(scored[id].cer).toBe(0);
    }
    expect(scored.clean.normalized_reference).toBe("your clawbox is ready");
  });

  it("scores substitutions, insertions and deletions apart from each other", () => {
    const scored = score([
      { id: "sub", reference: "the quick brown fox", hypothesis: "the quick brown box" },
      { id: "ins", reference: "the quick brown fox", hypothesis: "the very quick brown fox" },
      { id: "del", reference: "the quick brown fox", hypothesis: "the brown fox" },
    ]);
    expect(scored.sub).toMatchObject({ wer: 0.25, substitutions: 1, insertions: 0, deletions: 0 });
    expect(scored.ins).toMatchObject({ wer: 0.25, substitutions: 0, insertions: 1, deletions: 0 });
    expect(scored.del).toMatchObject({ wer: 0.25, substitutions: 0, insertions: 0, deletions: 1 });
    expect(scored.sub.reference_words).toBe(4);
  });

  it("scores Bulgarian on its own terms, where WER and CER disagree", () => {
    const scored = score([
      // Cyrillic punctuation and case fold away exactly like Latin does; an
      // ASCII-only normaliser would score this above zero.
      { id: "bg-clean", reference: "Здравей, свят!", hypothesis: "здравей свят" },
      // Bulgarian quotation marks and the em dash are punctuation too, and
      // "й" arrives decomposed here (и + combining breve) as it does from a
      // system that hands over NFD text. NFC has to happen before the compare.
      {
        id: "bg-typography",
        reference: "Той каза „готово“ — и излезе.",
        hypothesis: "Той каза готово и излезе".normalize("NFD"),
      },
      // Every word ending slightly wrong: the WER says "unusable", the CER says
      // "nearly right", and that gap is the whole recommendation.
      {
        id: "bg-endings",
        reference: "Обновяването приключи и рестартирах шлюза",
        hypothesis: "обновяването приключи и рестартира шлюзът",
      },
    ]);
    expect(scored["bg-clean"].wer).toBe(0);
    expect(scored["bg-clean"].cer).toBe(0);
    expect(scored["bg-typography"].wer).toBe(0);
    expect(scored["bg-typography"].cer).toBe(0);
    expect(scored["bg-endings"].wer).toBeGreaterThanOrEqual(0.4);
    expect(scored["bg-endings"].cer).toBeLessThan(scored["bg-endings"].wer! / 3);
    expect(scored["bg-endings"].reference_words).toBe(5);
  });

  it("uses the same scorer for the report as for --score-only", () => {
    configure({
      compute_types: { cpu: ["int8"] },
      delay: 0.02,
      transcripts: { "bg-1.wav": "кутията ви е готово" },
    });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "2", "--cache", cache,
      "--samples", manifestFile([{ id: "bg-1", lang: "bg", seconds: 1.0, reference: "Кутията ви е готова." }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const row = readReport(out).variants[0].rows[0];
    const standalone = score([
      { id: "same", reference: "Кутията ви е готова.", hypothesis: "кутията ви е готово" },
    ]).same;
    expect(row.wer).toBe(standalone.wer);
    expect(row.cer).toBe(standalone.cer);
    expect(row.wer).toBe(0.25);
    expect(row.hypothesis).toBe("кутията ви е готово");
  });

  it("reports distil-small.en as English-only instead of inventing a Bulgarian number", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, default_text: "your clawbox is ready" });
    const out = path.join(dir, "report.json");
    const md = path.join(dir, "report.md");
    const r = run([
      "--models", "distil-small.en", "--compute", "int8", "--reps", "2", "--cache", cache,
      "--samples", bilingualManifest(1.0), "--out", out, "--markdown", md,
    ]);
    expect(r.status).toBe(0);
    const variant = readReport(out).variants[0];
    expect(variant.english_only).toBe(true);
    expect(variant.languages.bg).toContain("ENGLISH-ONLY");
    const bg = variant.rows.find((row) => row.lang === "bg")!;
    // The row is present and honest rather than dropped, and it carries no
    // number that could be quoted as a Bulgarian result.
    expect(bg.skipped).toContain("English-only");
    expect(bg.wer).toBeNull();
    expect(bg.cer).toBeNull();
    expect(bg.median_rtf).toBeNull();
    expect(variant.rows.find((row) => row.lang === "en")!.wer).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("ENGLISH-ONLY");
  });

  it("reports a compute type the runtime does not have as a skipped variant", () => {
    // The expected outcome on this board: the PyPI aarch64 wheel is CPU-only,
    // so float16 has nowhere to run and must not be quietly measured as int8.
    configure({ compute_types: { cpu: ["int8", "float32"] }, cuda_error: "CUDA runtime not found", delay: 0.02 });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "int8,float16", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).not.toBe(0);
    const report = readReport(out);
    const float16 = report.variants.find((v) => v.compute_type === "float16")!;
    expect(float16.skipped).toContain("float16");
    expect(float16.rows).toHaveLength(0);
    expect(report.variants.find((v) => v.compute_type === "int8")!.rows).toHaveLength(1);
    expect(r.stdout).toContain("Variants not measured");
  });

  it("records that CUDA is missing from this wheel and carries on with the CPU", () => {
    configure({ compute_types: { cpu: ["int8"] }, cuda_error: "libcudart.so.12: cannot open shared object file", delay: 0.02 });
    const out = path.join(dir, "report.json");
    const md = path.join(dir, "report.md");
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out, "--markdown", md,
    ]);
    // A CPU-only wheel is a result, not a crash: the run completes.
    expect(r.status).toBe(0);
    const report = readReport(out);
    expect(report.device.resolved).toBe("cpu");
    expect(report.device.note).toContain("CUDA not available on this wheel");
    expect(report.device.cuda).toEqual([]);
    expect(report.device.cuda_error).toContain("libcudart");
    expect(report.variants[0].rows).toHaveLength(1);
    expect(readFileSync(md, "utf8")).toContain("CUDA not available on this wheel");
  });

  it("labels every number with the device that produced it, not the one requested", () => {
    // ctranslate2 advertises CUDA but the loaded model comes back on the CPU.
    // The report must say cpu, or a CPU number gets quoted as a GPU number.
    configure({
      compute_types: { cpu: ["int8"], cuda: ["float16"] },
      device: "cpu",
      compute_type: "int8",
      delay: 0.02,
    });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "float16", "--device", "cuda", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const variant = readReport(out).variants[0];
    expect(variant.requested_device).toBe("cuda");
    expect(variant.device).toBe("cpu");
    expect(variant.compute_type).toBe("int8");
  });

  it("fails loudly when a requested variant cannot load, and says why", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, fail_models: ["small"], default_text: "hello" });
    const out = path.join(dir, "report.json");
    const args = [
      "--models", "tiny,small", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ];
    const r = run(args);
    expect(r.status).not.toBe(0);
    const report = readReport(out);
    const small = report.variants.find((v) => v.model === "small")!;
    expect(small.skipped).toContain("no weights for small");
    expect(small.rows).toHaveLength(0);
    // The variant that did work is still measured and still reported.
    expect(report.variants.find((v) => v.model === "tiny")!.rows).toHaveLength(1);

    const lenient = run([...args, "--skip-missing"]);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("Variants not measured");
  });

  it("records a worker that dies mid-run as a failure, not as fast", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, die_after: 1, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "3", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).not.toBe(0);
    const variant = readReport(out).variants[0];
    expect(variant.rows).toHaveLength(0);
    expect(variant.skipped).toBeTruthy();
  });

  it("records the cloud baseline skip reason instead of dropping the section", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const md = path.join(dir, "report.md");
    const samples = manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]);

    // No key: the comparator must say so rather than vanish from the report.
    const requested = run([
      "--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", samples, "--cloud-baseline", "--out", out, "--markdown", md,
    ]);
    expect(requested.status).toBe(0);
    const withFlag = readReport(out);
    expect(withFlag.cloud.model).toBe("gpt-4o-mini-transcribe");
    expect(withFlag.cloud.skipped).toBe("OPENAI_API_KEY not set");
    expect(readFileSync(md, "utf8")).toContain("OPENAI_API_KEY not set");

    // Off by default, and still recorded as off.
    const offByDefault = run([
      "--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", samples, "--out", out,
    ]);
    expect(offByDefault.status).toBe(0);
    expect(readReport(out).cloud.skipped).toContain("--cloud-baseline");
  });

  it("carries provenance and the runtime it measured with into the report", () => {
    configure({ compute_types: { cpu: ["int8"], cuda: ["float16", "int8"] }, device: "cuda:0", delay: 0.02, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    const report = readReport(out);
    expect(report.provenance).toHaveProperty("uname");
    expect(report.provenance).toHaveProperty("mem_total_kb");
    expect(report.provenance.timestamp_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.device.resolved).toBe("cuda");
    expect(report.device.ctranslate2_version).toBe("4.5.0-stub");
    expect(report.device.faster_whisper_version).toBe("1.1.1-stub");
    expect(report.variants[0].device).toBe("cuda:0");
    expect(report.reps).toBe(1);
  });

  it("tells the model which language it is hearing unless asked to auto-detect", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, default_text: "hello" });
    const samples = bilingualManifest(1.0);
    const base = ["--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache, "--samples", samples];
    expect(run(base).status).toBe(0);
    const hinted = readFileSync(callsPath, "utf8");
    expect(hinted).toContain('"language": "bg"');

    rmSync(callsPath, { force: true });
    expect(run([...base, "--auto-detect-language"]).status).toBe(0);
    const auto = readFileSync(callsPath, "utf8");
    expect(auto).toContain('"language": null');
    expect(auto).not.toContain('"language": "bg"');
  });

  it("says in the report a human reads that a synthetic corpus is synthetic", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, default_text: "hello" });
    const md = path.join(dir, "report.md");
    const samples = manifestFile(
      [{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }],
      { synthetic: true, warning: "The reference is the exact text fed to Piper." },
    );
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache,
      "--samples", samples, "--markdown", md,
    ]);
    expect(r.status).toBe(0);
    const rendered = readFileSync(md, "utf8");
    expect(rendered).toContain("SYNTHETIC speech");
    expect(rendered).toContain("The reference is the exact text fed to Piper.");
    // The memory budget the reader is comparing against travels with the table.
    expect(rendered).toContain("2259-2636 MB");
    expect(rendered).toContain("7607 MB");
  });

  it("refuses a manifest that points at audio which is not there", () => {
    const audioDir = path.join(dir, "audio");
    mkdirSync(audioDir, { recursive: true });
    const file = path.join(audioDir, "manifest.json");
    writeFileSync(file, JSON.stringify([{ id: "en-1", lang: "en", audio: "missing.wav", reference: "hello" }]), "utf8");
    const r = run(["--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache, "--samples", file]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("audio not found");
  });

  it("says so when one rep means the cold run IS the median", () => {
    // --reps 1 is a legitimate smoke run, but there is no warm run to take a
    // median of, and a header claiming the cold run was excluded would be a lie
    // exactly where nobody checks.
    configure({ compute_types: { cpu: ["int8"] }, cold_delay: 0.4, delay: 0.02, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const md = path.join(dir, "report.md");
    const samples = manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]);
    const base = ["--models", "tiny", "--compute", "int8", "--cache", cache, "--samples", samples, "--out", out];

    expect(run([...base, "--reps", "1", "--markdown", md]).status).toBe(0);
    const single = readReport(out).variants[0].rows[0];
    expect(single.cold_excluded_from_median).toBe(false);
    expect(single.median_wall_seconds).toBe(single.cold_wall_seconds);
    expect(readFileSync(md, "utf8")).toContain("THE COLD RUN *IS* THE MEDIAN");

    expect(run([...base, "--reps", "3", "--markdown", md]).status).toBe(0);
    const repeated = readReport(out).variants[0].rows[0];
    expect(repeated.cold_excluded_from_median).toBe(true);
    expect(repeated.median_wall_seconds).toBeLessThan(repeated.cold_wall_seconds!);
    expect(readFileSync(md, "utf8")).toContain("excluded from the median");
  });

  it("runs one variant per distinct model and compute type, not one per repeat", () => {
    configure({ compute_types: { cpu: ["int8"] }, delay: 0.02, default_text: "hello" });
    const out = path.join(dir, "report.json");
    const r = run([
      "--models", "tiny,tiny", "--compute", "int8,int8", "--reps", "1", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
      "--out", out,
    ]);
    expect(r.status).toBe(0);
    // Four spellings of one variant would read as four independent runs.
    expect(readReport(out).variants.map((v) => v.name)).toEqual(["tiny/int8"]);
  });

  it("names the audio file it cannot read instead of dying in a traceback", () => {
    const audioDir = path.join(dir, "audio");
    mkdirSync(audioDir, { recursive: true });
    // What comes out of a phone: a voice note that is not a RIFF WAV at all.
    writeFileSync(path.join(audioDir, "note.mp3"), Buffer.from("ID3not audio"));
    const file = path.join(audioDir, "manifest.json");
    writeFileSync(file, JSON.stringify([{ id: "en-1", lang: "en", audio: "note.mp3", reference: "hello" }]), "utf8");
    const r = run(["--models", "tiny", "--compute", "int8", "--reps", "1", "--cache", cache, "--samples", file]);
    expect(r.status).not.toBe(0);
    const output = r.stderr + r.stdout;
    expect(output).toContain("is not a WAV this harness can measure");
    expect(output).toContain("note.mp3");
    expect(output).not.toContain("Traceback");
  });

  it("synthesises a labelled SYNTHETIC corpus with a short and a long sample per language", () => {
    // --setup is the path that lets the harness run on a bare box, and the
    // "this is TTS audio, so the WER is a floor" caveat is the part of it that
    // must not quietly fall out of the manifest.
    const binDir = path.join(dir, "piper-bin");
    const voices = path.join(dir, "piper-voices");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(voices, { recursive: true });
    for (const voice of ["en_US-lessac-medium", "bg_BG-dimitar-medium"]) {
      writeFileSync(path.join(voices, `${voice}.onnx`), "stub");
      writeFileSync(path.join(voices, `${voice}.onnx.json`), "{}");
    }
    // Stub piper: speaks at a fixed 150 words per minute, so the long sample
    // really is longer than the short one, and records the text it was asked
    // to say. The WAV writer lives in its own file rather than in a `python3
    // -c` string, so the shell never gets a chance to mangle it.
    const writer = path.join(dir, "say.py");
    writeFileSync(
      writer,
      [
        "import sys, wave",
        "out, words = sys.argv[1], int(sys.argv[2])",
        "w = wave.open(out, 'wb')",
        "w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)",
        "w.writeframes(b'\\x00\\x00' * int(22050 * max(1.0, words / 2.5)))",
        "w.close()",
      ].join("\n"),
    );
    const piper = path.join(binDir, "piper");
    writeFileSync(
      piper,
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2;; -m) shift 2;; *) shift;; esac; done',
        "text=$(cat)",
        'printf "%s\\n" "$text" >> "$PIPER_SAID"',
        'python3 "' + writer + '" "$out" "$(printf "%s" "$text" | wc -w)"',
      ].join("\n"),
    );
    chmodSync(piper, 0o755);

    const said = path.join(dir, "said.txt");
    const r = run(
      ["--setup", "--cache", cache, "--models", "tiny", "--piper-bin", piper, "--piper-voices", voices],
      { PIPER_SAID: said },
    );
    expect(r.status).toBe(0);

    const manifest = JSON.parse(readFileSync(path.join(cache, "samples", "manifest.json"), "utf8"));
    expect(manifest.synthetic).toBe(true);
    expect(String(manifest.warning)).toContain("floor");
    expect(manifest.samples.map((s: { id: string }) => s.id).sort()).toEqual([
      "bg-30s", "bg-3min", "en-30s", "en-3min",
    ]);
    for (const sample of manifest.samples) {
      // Ground truth is exactly what was handed to the synthesiser.
      expect(readFileSync(said, "utf8")).toContain(sample.reference);
      expect(sample.audio_seconds).toBeGreaterThan(0);
    }
    const byId = Object.fromEntries(manifest.samples.map((s: { id: string }) => [s.id, s]));
    expect(byId["en-3min"].audio_seconds).toBeGreaterThan(byId["en-30s"].audio_seconds * 3);
    expect(byId["bg-3min"].audio_seconds).toBeGreaterThan(byId["bg-30s"].audio_seconds * 3);
    // Cyrillic really did reach the Bulgarian voice, not a transliteration.
    expect(byId["bg-30s"].reference).toMatch(/[Ѐ-ӿ]/);
    // The corpus lands in the benchmark's own cache. Writing the Bulgarian
    // voice into ~/.local/share/piper would switch on a shipped feature that
    // scripts/install-voice.sh deliberately gates behind an opt-in.
    expect(existsSync(path.join(cache, "samples", "en-30s.wav"))).toBe(true);
  });

  it("refuses a rep count that cannot produce a median", () => {
    const r = run([
      "--models", "tiny", "--compute", "int8", "--reps", "0", "--cache", cache,
      "--samples", manifestFile([{ id: "en-1", lang: "en", seconds: 1.0, reference: "hello" }]),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--reps must be at least 1");
  });

  it("refuses an artifact whose digest does not match the pin", () => {
    // --setup fetches the Piper binary and voices used to synthesise the
    // corpus; those are executables downloaded onto a device.
    const artifact = path.join(dir, "artifact.bin");
    writeFileSync(artifact, "not the pinned bytes");
    const dest = path.join(dir, "fetched.bin");
    const r = spawnSync(
      "python3",
      ["-c",
       [
         "import importlib.util, sys",
         `spec = importlib.util.spec_from_file_location('b', ${JSON.stringify(SCRIPT)})`,
         "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
         "from pathlib import Path",
         "try:",
         `    m.download('file://${artifact}', Path(${JSON.stringify(dest)}), 'deadbeef')`,
         "except RuntimeError as e:",
         "    print('REFUSED', e); sys.exit(0)",
         "print('ACCEPTED'); sys.exit(1)",
       ].join("\n")],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REFUSED");
    // Nothing half-written is left behind for the next run to trust.
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
