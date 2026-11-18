/**
 * Settings → System → Cluster (TASK-2670): the types the route answers with and
 * the pure parsers behind them. No Node APIs, so the panel imports its types from
 * here without pulling the collector into the browser bundle.
 *
 * A ClawBox Workstation can be several DGX Sparks (GB10) running ONE inference
 * engine across all of them. The System page's own figures are the local
 * Spark's, which misleads there: memory is the local shard of the model, the GPU
 * idles because the engine spans every Spark, and `nvidia-smi` on a GB10 answers
 * N/A for memory (the GPU's memory IS the system's). This is the whole cluster
 * on one page.
 */

/** Why a Spark has no figures. A code, never the ssh error text: the panel words it. */
export type SparkFailure = "unreachable" | "timeout" | "auth" | "host_key" | "failed";

export interface SparkFigures {
  /** CPU use over a half-second window on the Spark itself, 0-100. */
  cpuPercent: number | null;
  /** System memory. On a unified-memory GPU (GB10) this is the GPU's memory too. */
  memory: { usedBytes: number; totalBytes: number; percent: number } | null;
  /**
   * The GPU shares the system memory: `nvidia-smi` named a GPU and answered N/A
   * for its memory, which is what a GB10 does. The panel then says "unified"
   * and shows `memory` as the GPU's.
   */
  unifiedMemory: boolean;
  gpu: {
    utilPercent: number | null;
    /** A discrete GPU's own memory; null on a unified-memory one. */
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
  };
  /** The GPU's temperature, else the hottest thermal zone; null when neither is readable. */
  temperatureC: number | null;
  /** The root filesystem. */
  disk: { usedBytes: number; totalBytes: number; percent: number } | null;
  uptimeSeconds: number | null;
}

export interface SparkCard {
  /** `local` for this box, `peer-1`, `peer-2`, … in the order they are configured. */
  id: string;
  local: boolean;
  online: boolean;
  /** The Spark's own hostname when it answered, else the host part of the configured address. */
  hostname: string;
  /** Present when `online` is false. */
  failure?: SparkFailure;
  /** When this card was read (ms since the epoch). */
  checkedAt: number;
  /** Present when `online` is true. */
  figures?: SparkFigures;
}

export type EngineGateReason =
  | "unreachable"
  | "not_lan"
  | "unauthorized"
  | "bad_response"
  | "address_refused";

export interface EngineView {
  /** An engine address is known (the external engine, or `CLAWBOX_CLUSTER_ENGINE_URL`). */
  configured: boolean;
  /** The model the owner named for it, when there is one. */
  model?: string;
  gate?: { online: boolean; reason?: EngineGateReason; latencyMs?: number };
  /**
   * The engine's own Prometheus `/metrics`. `available` is false when it has
   * none (or none this knows the names of): every figure is then null and the
   * panel prints "n/a" — never a zero, which would claim an idle engine.
   */
  metrics?: {
    available: boolean;
    active: number | null;
    queued: number | null;
    tokensPerSecond: number | null;
  };
}

export interface ClusterDisabled {
  enabled: false;
}

export interface ClusterSnapshot {
  enabled: true;
  generatedAt: number;
  sparks: SparkCard[];
  engine: EngineView;
}

export type ClusterAnswer = ClusterDisabled | ClusterSnapshot;

/** The Sparks that did not answer, in the order they are drawn. */
export function unreachableSparks(sparks: readonly SparkCard[]): SparkCard[] {
  return sparks.filter((s) => !s.online);
}

// ── What a Spark's collector prints ─────────────────────────────────────────────

/**
 * Every line the collector script prints starts with this word, so a login
 * banner, a shell warning or a stray "Warning: Permanently added …" cannot be
 * read as a figure.
 */
export const COLLECTOR_PREFIX = "CBX";

/** `[N/A]`, `N/A`, `[Not Supported]`, … as `nvidia-smi` spells "no figure". */
const NO_FIGURE_RE = /^\[?\s*(?:n\/a|not supported|not available|unknown error)\s*\]?$/i;

function figure(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!text || NO_FIGURE_RE.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

function percentOf(used: number, total: number): number {
  return total > 0 ? clampPercent((used / total) * 100) : 0;
}

/** A `cpu  user nice system idle iowait irq softirq steal …` line as [busy, total] jiffies. */
function cpuJiffies(line: string | undefined): { busy: number; total: number } | null {
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "cpu") return null;
  const n = parts.slice(1, 9).map((p) => Number(p));
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  const total = n.reduce((a, b) => a + b, 0);
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  return { busy: total - idle, total };
}

export interface ParsedSpark {
  hostname: string;
  figures: SparkFigures;
}

/**
 * The collector's output as figures, or null when it is not one: the run
 * stopped before its last line (`CBX end`), or never said who it was. A partly
 * readable answer is not drawn as a Spark with zeros.
 */
export function parseSparkOutput(stdout: string): ParsedSpark | null {
  const lines = new Map<string, string[]>();
  let ended = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith(`${COLLECTOR_PREFIX} `)) continue;
    const rest = line.slice(COLLECTOR_PREFIX.length + 1);
    const space = rest.indexOf(" ");
    const key = space < 0 ? rest : rest.slice(0, space);
    const value = space < 0 ? "" : rest.slice(space + 1).trim();
    if (key === "end") ended = true;
    const list = lines.get(key) ?? [];
    list.push(value);
    lines.set(key, list);
  }
  if (!ended) return null;
  // A name is text from another machine: bounded, and printable.
  const hostname = (lines.get("host")?.[0] ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 253);
  if (!hostname) return null;

  // CPU: two /proc/stat reads half a second apart on the Spark.
  const first = cpuJiffies(lines.get("cpu1")?.[0]);
  const second = cpuJiffies(lines.get("cpu2")?.[0]);
  let cpuPercent: number | null = null;
  if (first && second && second.total > first.total) {
    cpuPercent = clampPercent(((second.busy - first.busy) / (second.total - first.total)) * 100);
  }

  // Memory: kB from /proc/meminfo. MemAvailable is what is free to use; a
  // kernel without it falls back to MemFree rather than reporting nothing.
  const mem: Record<string, number> = {};
  for (const entry of lines.get("mem") ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(entry);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = mem.MemTotal;
  const memFree = mem.MemAvailable ?? mem.MemFree;
  const memory = memTotal > 0 && memFree !== undefined
    ? {
        usedBytes: Math.max(0, memTotal - memFree),
        totalBytes: memTotal,
        percent: percentOf(Math.max(0, memTotal - memFree), memTotal),
      }
    : null;

  // GPU: `util %, temp C, mem used MiB, mem total MiB`; N/A where the GPU has no memory of its own.
  const gpuLine = lines.get("gpu")?.[0];
  const gpuFields = gpuLine ? gpuLine.split(",").map((f) => f.trim()) : [];
  const gpuUtil = gpuLine ? figure(gpuFields[0]) : null;
  const gpuTemp = gpuLine ? figure(gpuFields[1]) : null;
  const gpuMemUsedMiB = gpuLine ? figure(gpuFields[2]) : null;
  const gpuMemTotalMiB = gpuLine ? figure(gpuFields[3]) : null;
  const gpuNamed = gpuLine !== undefined;
  const ownMemory = gpuMemTotalMiB !== null && gpuMemTotalMiB > 0;

  // Temperature: the GPU's own reading, else the hottest thermal zone (milli-°C).
  let temperatureC: number | null = gpuTemp !== null && gpuTemp > 0 && gpuTemp < 150 ? gpuTemp : null;
  if (temperatureC === null) {
    for (const z of lines.get("temp") ?? []) {
      const milli = figure(z);
      if (milli === null) continue;
      const c = milli / 1000;
      if (c > 0 && c < 150 && (temperatureC === null || c > temperatureC)) temperatureC = c;
    }
  }

  // Disk: `df -P -k /`, read from the right so a filesystem name with a space cannot shift it.
  let disk: SparkFigures["disk"] = null;
  const diskLine = lines.get("disk")?.[0];
  if (diskLine) {
    const t = diskLine.split(/\s+/);
    const blocks = Number(t[t.length - 5]);
    const used = Number(t[t.length - 4]);
    if (Number.isFinite(blocks) && Number.isFinite(used) && blocks > 0) {
      disk = { usedBytes: used * 1024, totalBytes: blocks * 1024, percent: percentOf(used, blocks) };
    }
  }

  const up = Number((lines.get("up")?.[0] ?? "").split(/\s+/)[0]);

  return {
    hostname,
    figures: {
      cpuPercent,
      memory,
      unifiedMemory: gpuNamed && !ownMemory,
      gpu: {
        utilPercent: gpuUtil === null ? null : clampPercent(gpuUtil),
        memoryUsedBytes: ownMemory && gpuMemUsedMiB !== null ? gpuMemUsedMiB * 1024 * 1024 : null,
        memoryTotalBytes: ownMemory ? (gpuMemTotalMiB as number) * 1024 * 1024 : null,
      },
      temperatureC: temperatureC === null ? null : Math.round(temperatureC * 10) / 10,
      disk,
      uptimeSeconds: Number.isFinite(up) && up >= 0 ? Math.floor(up) : null,
    },
  };
}

// ── The engine's Prometheus text ────────────────────────────────────────────────

// name{labels} value [timestamp] — a quoted label value may hold `}` or spaces.
const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)(?:\s+-?\d+)?\s*$/;

/**
 * Every sample of a Prometheus text exposition, summed by metric name: an
 * engine that reports one series per rank or per model answers one number.
 * NaN and infinities are not samples.
 */
export function parsePrometheus(text: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    totals.set(m[1], (totals.get(m[1]) ?? 0) + value);
  }
  return totals;
}

/**
 * The metric names the engines this box runs publish. Not a wish list: each is
 * the name that engine's own metrics reference gives for the same quantity.
 * An engine with none of them reports `available: false`.
 */
export const ENGINE_METRIC_NAMES = {
  active: ["vllm:num_requests_running", "sglang:num_running_reqs", "llamacpp:requests_processing"],
  queued: ["vllm:num_requests_waiting", "sglang:num_queue_reqs", "llamacpp:requests_deferred"],
  /** An engine that publishes the rate itself. */
  rate: ["sglang:gen_throughput", "vllm:avg_generation_throughput_toks_per_s"],
  /** A running total of generated tokens: the rate is the change between two reads. */
  tokens: ["vllm:generation_tokens_total", "sglang:generation_tokens_total", "llamacpp:tokens_predicted_total"],
} as const;

function firstOf(samples: Map<string, number>, names: readonly string[]): number | null {
  for (const name of names) {
    const v = samples.get(name);
    if (v !== undefined) return v;
  }
  return null;
}

export interface EngineSample {
  active: number | null;
  queued: number | null;
  /** The engine's own rate, when it publishes one. */
  rate: number | null;
  /** Generated tokens so far, when the engine counts them. */
  tokens: number | null;
}

export function engineSampleFrom(samples: Map<string, number>): EngineSample {
  return {
    active: firstOf(samples, ENGINE_METRIC_NAMES.active),
    queued: firstOf(samples, ENGINE_METRIC_NAMES.queued),
    rate: firstOf(samples, ENGINE_METRIC_NAMES.rate),
    tokens: firstOf(samples, ENGINE_METRIC_NAMES.tokens),
  };
}

/** Does the sample carry anything this panel can draw? */
export function engineSampleUsable(s: EngineSample): boolean {
  return s.active !== null || s.queued !== null || s.rate !== null || s.tokens !== null;
}

/**
 * A rate is "now" only for reads this close together. Further apart, the change
 * is an average over however long nobody was looking (the owner closed the page
 * and came back an hour later) and would be shown as the current speed.
 */
export const TOKEN_RATE_MAX_GAP_MS = 30_000;

/**
 * Tokens per second from two reads of a running total. Null for the first read,
 * for reads closer than a second or further apart than `TOKEN_RATE_MAX_GAP_MS`,
 * and for a total that went DOWN (the engine restarted): none of those is a
 * rate, and zero would claim an idle engine.
 */
export function tokensPerSecondBetween(
  previous: { at: number; tokens: number } | null,
  current: { at: number; tokens: number },
): number | null {
  if (!previous) return null;
  const gap = current.at - previous.at;
  if (gap < 1_000 || gap > TOKEN_RATE_MAX_GAP_MS || current.tokens < previous.tokens) return null;
  return Math.round(((current.tokens - previous.tokens) / (gap / 1000)) * 10) / 10;
}
