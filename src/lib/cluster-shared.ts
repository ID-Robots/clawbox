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
   * The GPU shares the system memory: `nvidia-smi` named a part that has no
   * memory of its own (a GB10, a Jetson's integrated GPU) and reported none for
   * it. Known by the part's NAME, never inferred from a memory figure that is
   * missing — a discrete GPU whose memory reads "Unknown Error" is not unified.
   * The panel then says "unified" and shows `memory` as the GPU's.
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

/**
 * Why the engine was not read at all: its saved record could not be read
 * ("unreadable" — not the same as "none is set up"), the AI settings were
 * being changed at that moment ("changing"), when the saved address and the key
 * file may not belong to the same engine, or the key file was written after the
 * record beside it ("unbound": a save that failed half way and could not put
 * the old key back), so the key is not that engine's. The key is sent nowhere.
 */
export type EngineUnread = "unreadable" | "changing" | "unbound";

export interface EngineView {
  /** An engine address is known (the external engine, or `CLAWBOX_CLUSTER_ENGINE_URL`). */
  configured: boolean;
  /** Present when nothing was read; `configured` then says only what could be told. */
  unread?: EngineUnread;
  /** The model the owner named for it, when there is one. */
  model?: string;
  /** When this reading was taken (ms since the epoch); absent where nothing was read. */
  checkedAt?: number;
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
  /** The OLDEST reading in the answer — a Spark card's or the engine's — not the moment it was sent. */
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

/**
 * The GPUs that have no memory of their own and use the system's: the GB10 of a
 * DGX Spark ("NVIDIA GB10"), and the integrated GPU of a Jetson (Orin, Thor,
 * Xavier — Tegra parts). A part not named here is never called unified.
 */
export const UNIFIED_MEMORY_GPU_RE = /\b(?:GB10|Orin|Thor|Xavier|Tegra)\b/i;

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

  // GPU: `name, util %, temp C, mem used MiB, mem total MiB`. The four figures
  // are read from the right, so a name with a comma in it cannot shift them.
  const gpuLine = lines.get("gpu")?.[0];
  const gpuFields = gpuLine ? gpuLine.split(",").map((f) => f.trim()) : [];
  const gpuFigures = gpuFields.length >= 4 ? gpuFields.slice(-4) : [];
  const gpuName = gpuFields.length > 4 ? gpuFields.slice(0, -4).join(",").trim() : "";
  const gpuUtil = figure(gpuFigures[0]);
  const gpuTemp = figure(gpuFigures[1]);
  const gpuMemUsedMiB = figure(gpuFigures[2]);
  const gpuMemTotalMiB = figure(gpuFigures[3]);
  const ownMemory = gpuMemTotalMiB !== null && gpuMemTotalMiB > 0;
  // Unified memory is a property of the part, told by its name — not of a figure
  // that is missing: a discrete GPU can answer "Unknown Error" for its memory too.
  const unified = !ownMemory && UNIFIED_MEMORY_GPU_RE.test(gpuName);

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

  // `/proc/uptime` unreadable leaves an empty `up` line: no figure, not a zero.
  const upField = (lines.get("up")?.[0] ?? "").trim().split(/\s+/)[0] ?? "";
  const up = upField ? Number(upField) : Number.NaN;

  return {
    hostname,
    figures: {
      cpuPercent,
      memory,
      unifiedMemory: unified,
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
const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)(?:\s+-?\d+)?\s*$/;

/** Metric name → its series (the label set in canonical form, `""` for none) → value. */
export type PrometheusSeries = Map<string, Map<string, number>>;

// name="value" inside a label set; the value may hold escaped quotes.
// A label name as written bare: letters, digits and underscores.
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isNameChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** A quoted string starting at `i` (which is `"`): its content (escapes kept) and the index after it, or null when it never closes. */
function readQuoted(text: string, i: number): [string, number] | null {
  for (let j = i + 1; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) j++; // a backslash: the next character is the escaped one
    else if (c === 34) return [text.slice(i + 1, j), j + 1];
  }
  return null;
}

/**
 * The label pairs of a `{…}` block, in ONE pass over it (no backtracking: a
 * crafted megabyte-long line costs a megabyte of steps). A name may be bare or
 * quoted (`"engine"="0"`, as newer engines may print it). Null when the block
 * is not a label set.
 */
function parseLabelPairs(raw: string): [string, string][] | null {
  const n = raw.length;
  let i = raw.charCodeAt(0) === 123 ? 1 : 0; // after `{`
  const pairs: [string, string][] = [];
  const skip = (alsoComma: boolean) => {
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (c === 32 || c === 9 || (alsoComma && c === 44)) i++;
      else break;
    }
  };
  for (;;) {
    skip(true);
    if (i >= n || raw.charCodeAt(i) === 125) return pairs; // `}` or the end
    let name: string;
    if (raw.charCodeAt(i) === 34) {
      const quoted = readQuoted(raw, i);
      if (!quoted) return null;
      [name, i] = quoted;
    } else {
      const start = i;
      while (i < n && isNameChar(raw.charCodeAt(i))) i++;
      if (i === start) return null;
      name = raw.slice(start, i);
    }
    skip(false);
    if (raw.charCodeAt(i) !== 61) return null; // `=`
    i++;
    skip(false);
    if (raw.charCodeAt(i) !== 34) return null;
    const value = readQuoted(raw, i);
    if (!value) return null;
    i = value[1];
    pairs.push([name, value[0]]);
  }
}

/**
 * A label set as ONE spelling, whatever order the engine printed it in:
 * `{model_name="m",engine="0"}` and `{engine="0",model_name="m"}` are the same
 * series, so is `{"engine"="0"}` and `{engine="0"}`, and a label with an empty
 * value is the label absent (as Prometheus has it). Pairs sorted by name; no
 * labels is `""`. A block that is not a label set keeps its own text, so it is
 * still a series of its own.
 */
export function canonicalLabels(raw: string): string {
  if (!raw) return "";
  const parsed = parseLabelPairs(raw);
  if (parsed === null) return raw;
  const pairs = parsed.filter(([, value]) => value !== "");
  if (pairs.length === 0) return "";
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${pairs.map(([name, value]) => `${LABEL_NAME_RE.test(name) ? name : `"${name}"`}="${value}"`).join(",")}}`;
}

/**
 * Every sample of a Prometheus text exposition, one value per series. NaN and
 * infinities are not samples.
 */
export function parsePrometheusSeries(text: string): PrometheusSeries {
  const out: PrometheusSeries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = canonicalLabels(m[2] ?? "");
    const series = out.get(m[1]) ?? new Map<string, number>();
    series.set(labels, (series.get(labels) ?? 0) + value);
    out.set(m[1], series);
  }
  return out;
}

function sumOf(series: Map<string, number>): number {
  let total = 0;
  for (const value of series.values()) total += value;
  return total;
}

/**
 * Every sample summed by metric name: an engine that reports one series per
 * rank or per model answers one number. Right for a gauge (requests running
 * now); a counter's rate is taken per series instead (`tokensPerSecondBetween`).
 */
export function parsePrometheus(text: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [name, series] of parsePrometheusSeries(text)) totals.set(name, sumOf(series));
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

/**
 * A token counter's series as one read saw them: `name{labels}` → the running
 * total. Kept apart, not summed, so a rate is the sum of each series' own change
 * and a series that was reset is seen as reset.
 */
export type TokenCounters = Readonly<Record<string, number>>;

export interface EngineSample {
  active: number | null;
  queued: number | null;
  /** The engine's own rate, when it publishes one. */
  rate: number | null;
  /** Generated tokens so far, per series, when the engine counts them. */
  tokens: TokenCounters | null;
}

function tokenCountersOf(series: PrometheusSeries): TokenCounters | null {
  for (const name of ENGINE_METRIC_NAMES.tokens) {
    const found = series.get(name);
    if (!found || found.size === 0) continue;
    const counters: Record<string, number> = {};
    for (const [labels, value] of found) counters[`${name}${labels}`] = value;
    return counters;
  }
  return null;
}

export function engineSampleFrom(series: PrometheusSeries): EngineSample {
  const totals = new Map<string, number>();
  for (const [name, values] of series) totals.set(name, sumOf(values));
  return {
    active: firstOf(totals, ENGINE_METRIC_NAMES.active),
    queued: firstOf(totals, ENGINE_METRIC_NAMES.queued),
    rate: firstOf(totals, ENGINE_METRIC_NAMES.rate),
    tokens: tokenCountersOf(series),
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

/** One read of the token counters: a single running total, or the series of `TokenCounters`. */
export interface TokenRead {
  at: number;
  tokens: number | TokenCounters;
}

function countersOf(tokens: number | TokenCounters): TokenCounters {
  return typeof tokens === "number" ? { "": tokens } : tokens;
}

/**
 * Tokens per second from two reads of the running totals: each series' own
 * change, summed. Null for the first read, for reads closer than a second or
 * further apart than `TOKEN_RATE_MAX_GAP_MS`, for a series that went DOWN (that
 * rank or the engine restarted, and what it made in the window is unknown), and
 * for reads that do not hold the same series (one appeared or went away, so the
 * change is not the whole engine's): none of those is a rate, and zero would
 * claim an idle engine.
 */
export function tokensPerSecondBetween(previous: TokenRead | null, current: TokenRead): number | null {
  if (!previous) return null;
  const gap = current.at - previous.at;
  if (gap < 1_000 || gap > TOKEN_RATE_MAX_GAP_MS) return null;
  const before = countersOf(previous.tokens);
  const now = countersOf(current.tokens);
  const keys = Object.keys(now);
  if (keys.length === 0 || keys.length !== Object.keys(before).length) return null;
  let made = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) return null;
    const change = now[key] - before[key];
    if (!Number.isFinite(change) || change < 0) return null;
    made += change;
  }
  return Math.round((made / (gap / 1000)) * 10) / 10;
}
