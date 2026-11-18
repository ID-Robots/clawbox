import { describe, expect, it } from "vitest";
import {
  canonicalLabels,
  engineSampleFrom,
  engineSampleUsable,
  parsePrometheus,
  parsePrometheusSeries,
  parseSparkOutput,
  TOKEN_RATE_MAX_GAP_MS,
  tokensPerSecondBetween,
  unreachableSparks,
  type SparkCard,
} from "@/lib/cluster-shared";

/**
 * Settings → System → Cluster (TASK-2670): what a Spark's collector prints and
 * what an engine's Prometheus text says, read into figures. The GB10 case is the
 * reason the page exists: its GPU memory is N/A and its CPU and GPU share the
 * system memory.
 */

const GIB = 1024 ** 3;

function collector(overrides: Partial<Record<string, string | null>> = {}): string {
  const lines: Record<string, string | null> = {
    host: "spark-a",
    cpu1: "cpu  1000 0 500 8000 100 0 0 0 0 0",
    cpu2: "cpu  1100 0 550 8050 100 0 0 0 0 0",
    up: "86400.55 1000.0",
    mem: "MemTotal:       125829120 kB\nMemAvailable:    25165824 kB",
    gpu: "NVIDIA GB10, 37, 51, [N/A], [N/A]",
    temp: "47000\n50000\n12000",
    disk: "/dev/nvme0n1p2 976762584 488381292 488381292 50% /",
    ...overrides,
  };
  const out: string[] = ["Welcome to a login banner that is not the collector's"];
  for (const [key, value] of Object.entries(lines)) {
    if (value === null) continue;
    for (const part of value.split("\n")) out.push(`CBX ${key} ${part}`);
  }
  out.push("CBX end");
  return out.join("\n") + "\n";
}

describe("parseSparkOutput", () => {
  it("reads a GB10: GPU memory N/A means the system memory IS the GPU's (unified)", () => {
    const parsed = parseSparkOutput(collector());
    expect(parsed).not.toBeNull();
    const { hostname, figures } = parsed!;
    expect(hostname).toBe("spark-a");
    expect(figures.unifiedMemory).toBe(true);
    // 125829120 kB total, 25165824 kB available → 96 GiB used of 120 GiB.
    expect(figures.memory).toEqual({ usedBytes: 96 * GIB, totalBytes: 120 * GIB, percent: 80 });
    expect(figures.gpu).toEqual({ utilPercent: 37, memoryUsedBytes: null, memoryTotalBytes: null });
    // The GPU's own temperature wins over the thermal zones.
    expect(figures.temperatureC).toBe(51);
    expect(figures.uptimeSeconds).toBe(86400);
  });

  it("computes CPU use from the two /proc/stat reads", () => {
    const { figures } = parseSparkOutput(collector())!;
    // Busy 1500 → 1650 of a total that went 9600 → 9800: 150 of 200 jiffies.
    expect(figures.cpuPercent).toBe(75);
  });

  it("reads the root filesystem from the right, whatever the filesystem is called", () => {
    const { figures } = parseSparkOutput(collector({ disk: "/dev/mapper/vg0-root fs 976762584 488381292 488381292 50% /" }))!;
    expect(figures.disk).toEqual({ usedBytes: 488381292 * 1024, totalBytes: 976762584 * 1024, percent: 50 });
  });

  it("keeps a discrete GPU's own memory and does not call it unified", () => {
    const { figures } = parseSparkOutput(collector({ gpu: "NVIDIA GeForce RTX 4090, 12, 61, 2048, 24576" }))!;
    expect(figures.unifiedMemory).toBe(false);
    expect(figures.gpu).toEqual({
      utilPercent: 12,
      memoryUsedBytes: 2048 * 1024 * 1024,
      memoryTotalBytes: 24576 * 1024 * 1024,
    });
  });

  it("knows unified memory by the GPU's name, never from a memory figure that is missing", () => {
    // A discrete GPU whose memory fields fail to read is not unified: its memory stays n/a.
    const broken = parseSparkOutput(collector({ gpu: "NVIDIA GeForce RTX 4090, 12, 61, [Unknown Error], [Unknown Error]" }))!.figures;
    expect(broken.unifiedMemory).toBe(false);
    expect(broken.gpu).toEqual({ utilPercent: 12, memoryUsedBytes: null, memoryTotalBytes: null });
    // A part this does not know, answering N/A: not called unified either.
    expect(parseSparkOutput(collector({ gpu: "Some Future GPU, 5, 40, [N/A], [N/A]" }))!.figures.unifiedMemory).toBe(false);
    // No name at all (a four-field line): the figures are read, the memory is not called unified.
    const nameless = parseSparkOutput(collector({ gpu: "37, 51, [N/A], [N/A]" }))!.figures;
    expect(nameless.unifiedMemory).toBe(false);
    expect(nameless.gpu.utilPercent).toBe(37);
    // A Jetson's integrated GPU is unified, and a name with a comma does not shift the figures.
    const orin = parseSparkOutput(collector({ gpu: "Orin (nvgpu), rev 1, 9, 44, [N/A], [N/A]" }))!.figures;
    expect(orin.unifiedMemory).toBe(true);
    expect(orin.gpu.utilPercent).toBe(9);
    expect(orin.temperatureC).toBe(44);
  });

  it("gives no uptime — not zero — when /proc/uptime could not be read, and keeps a real zero", () => {
    expect(parseSparkOutput(collector({ up: "" }))!.figures.uptimeSeconds).toBeNull();
    expect(parseSparkOutput(collector({ up: null }))!.figures.uptimeSeconds).toBeNull();
    expect(parseSparkOutput(collector({ up: "0.00 0.00" }))!.figures.uptimeSeconds).toBe(0);
  });

  it("falls back to the hottest thermal zone when the GPU gives no temperature", () => {
    const { figures } = parseSparkOutput(collector({ gpu: "NVIDIA GB10, 0, [N/A], [N/A], [N/A]" }))!;
    expect(figures.temperatureC).toBe(50);
  });

  it("answers null — never zero — for what is not there: no nvidia-smi, no thermal zones, no second CPU read", () => {
    const { figures } = parseSparkOutput(collector({ gpu: null, temp: null, cpu2: null }))!;
    expect(figures.unifiedMemory).toBe(false);
    expect(figures.gpu).toEqual({ utilPercent: null, memoryUsedBytes: null, memoryTotalBytes: null });
    expect(figures.temperatureC).toBeNull();
    expect(figures.cpuPercent).toBeNull();
  });

  it("treats every spelling nvidia-smi uses for 'no figure' as null", () => {
    for (const na of ["[N/A]", "N/A", "[Not Supported]", "Not Supported", "[Not Available]"]) {
      const { figures } = parseSparkOutput(collector({ gpu: `NVIDIA GB10, ${na}, ${na}, ${na}, ${na}` }))!;
      expect(figures.gpu.utilPercent, na).toBeNull();
      expect(figures.temperatureC, na).toBe(50);
    }
  });

  it("uses MemFree when the kernel has no MemAvailable", () => {
    const { figures } = parseSparkOutput(collector({ mem: "MemTotal: 1048576 kB\nMemFree: 524288 kB" }))!;
    expect(figures.memory).toEqual({ usedBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, percent: 50 });
  });

  it("is null for output that stopped before its last line, or never named the Spark", () => {
    expect(parseSparkOutput(collector().replace("CBX end\n", ""))).toBeNull();
    expect(parseSparkOutput(collector({ host: "" }))).toBeNull();
    expect(parseSparkOutput("")).toBeNull();
    expect(parseSparkOutput("Permission denied (publickey).\n")).toBeNull();
  });

  it("ignores any line that is not the collector's, a login banner or shell warning included", () => {
    const noisy = `Warning: something\nCBX-fake host evil\n${collector()}trailing junk\n`;
    expect(parseSparkOutput(noisy)?.hostname).toBe("spark-a");
  });

  it("bounds and cleans a hostname: it is text from another machine", () => {
    const long = "h".repeat(400);
    expect(parseSparkOutput(collector({ host: long }))!.hostname).toHaveLength(253);
    expect(parseSparkOutput(collector({ host: "spark\u0007-a\u001b[31m" }))!.hostname).toBe("spark-a[31m");
  });

  it("clamps what cannot be a percentage", () => {
    const { figures } = parseSparkOutput(collector({ gpu: "NVIDIA GB10, 250, 51, [N/A], [N/A]" }))!;
    expect(figures.gpu.utilPercent).toBe(100);
  });
});

describe("parsePrometheus", () => {
  it("sums series by metric name and skips comments, NaN and malformed lines", () => {
    const samples = parsePrometheus([
      "# HELP vllm:num_requests_running Number of requests in model execution batches.",
      "# TYPE vllm:num_requests_running gauge",
      'vllm:num_requests_running{engine="0",model_name="m"} 3.0',
      'vllm:num_requests_running{engine="1",model_name="m"} 2.0',
      'vllm:num_requests_waiting{model_name="a b}c"} 4 1700000000000',
      "vllm:broken NaN",
      "vllm:inf +Inf",
      "not a metric line at all",
      "",
    ].join("\n"));
    expect(samples.get("vllm:num_requests_running")).toBe(5);
    expect(samples.get("vllm:num_requests_waiting")).toBe(4);
    expect(samples.has("vllm:broken")).toBe(false);
    expect(samples.has("vllm:inf")).toBe(false);
  });
});

describe("parsePrometheusSeries", () => {
  it("keeps every series of a metric apart, by its label set as written", () => {
    const series = parsePrometheusSeries([
      'vllm:generation_tokens_total{engine="0",model_name="m"} 1000',
      'vllm:generation_tokens_total{engine="1",model_name="m"} 100',
      "vllm:num_requests_running 3",
      "vllm:broken NaN",
      "",
    ].join("\n"));
    expect([...series.get("vllm:generation_tokens_total")!]).toEqual([
      ['{engine="0",model_name="m"}', 1000],
      ['{engine="1",model_name="m"}', 100],
    ]);
    expect([...series.get("vllm:num_requests_running")!]).toEqual([["", 3]]);
    expect(series.has("vllm:broken")).toBe(false);
  });
});

describe("engineSampleFrom", () => {
  it("reads vLLM's names", () => {
    const sample = engineSampleFrom(parsePrometheusSeries(
      "vllm:num_requests_running 4\nvllm:num_requests_waiting 1\nvllm:generation_tokens_total 9000\n",
    ));
    expect(sample).toEqual({ active: 4, queued: 1, rate: null, tokens: { "vllm:generation_tokens_total": 9000 } });
    expect(engineSampleUsable(sample)).toBe(true);
  });

  it("sums the gauges across series, and keeps the token counter's series apart", () => {
    const sample = engineSampleFrom(parsePrometheusSeries([
      'vllm:num_requests_running{engine="0"} 2',
      'vllm:num_requests_running{engine="1"} 3',
      'vllm:generation_tokens_total{engine="0"} 1000',
      'vllm:generation_tokens_total{engine="1"} 100',
    ].join("\n")));
    expect(sample.active).toBe(5);
    expect(sample.tokens).toEqual({
      'vllm:generation_tokens_total{engine="0"}': 1000,
      'vllm:generation_tokens_total{engine="1"}': 100,
    });
  });

  it("reads SGLang's names, including the rate it publishes itself", () => {
    const sample = engineSampleFrom(parsePrometheusSeries(
      'sglang:num_running_reqs{tp_rank="0"} 2\nsglang:num_queue_reqs{tp_rank="0"} 0\nsglang:gen_throughput{tp_rank="0"} 31.4\n',
    ));
    expect(sample).toEqual({ active: 2, queued: 0, rate: 31.4, tokens: null });
  });

  it("reads llama.cpp's names", () => {
    const sample = engineSampleFrom(parsePrometheusSeries(
      "llamacpp:requests_processing 1\nllamacpp:requests_deferred 0\nllamacpp:tokens_predicted_total 120\n",
    ));
    expect(sample).toEqual({ active: 1, queued: 0, rate: null, tokens: { "llamacpp:tokens_predicted_total": 120 } });
  });

  it("is not usable for an engine whose metrics have none of those names", () => {
    const sample = engineSampleFrom(parsePrometheusSeries("process_cpu_seconds_total 12\nhttp_requests_total 9\n"));
    expect(sample).toEqual({ active: null, queued: null, rate: null, tokens: null });
    expect(engineSampleUsable(sample)).toBe(false);
  });
});

describe("canonicalLabels", () => {
  it("spells a label set one way whatever order it was printed in", () => {
    expect(canonicalLabels('{model_name="m",engine="0"}')).toBe('{engine="0",model_name="m"}');
    expect(canonicalLabels('{engine="0", model_name="m"}')).toBe('{engine="0",model_name="m"}');
    expect(canonicalLabels('{note="a \\"quoted\\" b",engine="1"}')).toBe('{engine="1",note="a \\"quoted\\" b"}');
    expect(canonicalLabels("")).toBe("");
    expect(canonicalLabels("{}")).toBe("");
  });

  it("reads a quoted label name as the same name, and an empty value as the label absent", () => {
    expect(canonicalLabels('{"engine"="0",model_name="m"}')).toBe('{engine="0",model_name="m"}');
    expect(canonicalLabels('{"engine"="0"}')).not.toBe(canonicalLabels('{"engine"="1"}'));
    expect(canonicalLabels('{"gpu.rank"="0"}')).toBe('{"gpu.rank"="0"}');
    expect(canonicalLabels('{engine="0",model_name=""}')).toBe(canonicalLabels('{engine="0"}'));
    expect(canonicalLabels('{model_name=""}')).toBe("");
  });

  it("keeps a block that is not a label set as its own series", () => {
    expect(canonicalLabels("{not a label set}")).toBe("{not a label set}");
    expect(canonicalLabels('{engine="0}')).toBe('{engine="0}');
  });

  it("reads a crafted megabyte-long label block in one pass, without stalling", () => {
    const long = `vllm:generation_tokens_total{${"a".repeat(1024 * 1024)}} 5\n`;
    const started = Date.now();
    const series = parsePrometheusSeries(long);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(series.get("vllm:generation_tokens_total")?.size).toBe(1);
    const quoted = `vllm:generation_tokens_total{${'"x'.repeat(200_000)}} 5\n`;
    const begun = Date.now();
    parsePrometheusSeries(quoted);
    expect(Date.now() - begun).toBeLessThan(2_000);
  });

  it("keeps a counter one series when the engine reorders its labels between reads", () => {
    const first = engineSampleFrom(parsePrometheusSeries('vllm:generation_tokens_total{engine="0",model_name="m"} 100\n'));
    const second = engineSampleFrom(parsePrometheusSeries('vllm:generation_tokens_total{model_name="m",engine="0"} 200\n'));
    expect(tokensPerSecondBetween({ at: 0, tokens: first.tokens! }, { at: 10_000, tokens: second.tokens! })).toBe(10);
  });
});

describe("tokensPerSecondBetween: several series", () => {
  const A = 'vllm:generation_tokens_total{engine="0"}';
  const B = 'vllm:generation_tokens_total{engine="1"}';

  it("is the sum of each series' own change", () => {
    expect(tokensPerSecondBetween({ at: 0, tokens: { [A]: 1_000, [B]: 100 } }, { at: 10_000, tokens: { [A]: 1_600, [B]: 600 } })).toBe(110);
  });

  it("is null when one series was reset, even though the sum went up", () => {
    // Summed first, 1,100 → 1,205 would read as 10.5 tok/s; the reset makes the real rate unknown.
    expect(tokensPerSecondBetween({ at: 0, tokens: { [A]: 1_000, [B]: 100 } }, { at: 10_000, tokens: { [A]: 5, [B]: 1_200 } })).toBeNull();
  });

  it("is null when the reads do not hold the same series", () => {
    expect(tokensPerSecondBetween({ at: 0, tokens: { [A]: 1_000 } }, { at: 10_000, tokens: { [A]: 1_100, [B]: 50 } })).toBeNull();
    expect(tokensPerSecondBetween({ at: 0, tokens: { [A]: 1_000, [B]: 50 } }, { at: 10_000, tokens: { [A]: 1_100 } })).toBeNull();
    expect(tokensPerSecondBetween({ at: 0, tokens: { [A]: 1_000 } }, { at: 10_000, tokens: { [B]: 1_100 } })).toBeNull();
  });
});

describe("tokensPerSecondBetween", () => {
  it("is the change between two reads over the time between them", () => {
    expect(tokensPerSecondBetween({ at: 1_000, tokens: 100 }, { at: 11_000, tokens: 350 })).toBe(25);
  });

  it("is null — not zero — for a first read, reads under a second apart, and a total that went down", () => {
    expect(tokensPerSecondBetween(null, { at: 1_000, tokens: 100 })).toBeNull();
    expect(tokensPerSecondBetween({ at: 1_000, tokens: 100 }, { at: 1_500, tokens: 200 })).toBeNull();
    expect(tokensPerSecondBetween({ at: 1_000, tokens: 500 }, { at: 9_000, tokens: 10 })).toBeNull();
  });

  it("is null for reads too far apart to be 'now': an average over an hour nobody watched is not the current speed", () => {
    expect(tokensPerSecondBetween({ at: 0, tokens: 0 }, { at: TOKEN_RATE_MAX_GAP_MS, tokens: 3_000 })).toBe(100);
    expect(tokensPerSecondBetween({ at: 0, tokens: 0 }, { at: TOKEN_RATE_MAX_GAP_MS + 1, tokens: 3_000 })).toBeNull();
    expect(tokensPerSecondBetween({ at: 0, tokens: 0 }, { at: 3_600_000, tokens: 360_000 })).toBeNull();
  });

  it("is a real zero for an engine that generated nothing in the window", () => {
    expect(tokensPerSecondBetween({ at: 1_000, tokens: 100 }, { at: 6_000, tokens: 100 })).toBe(0);
  });
});

describe("unreachableSparks", () => {
  it("picks the Sparks that did not answer, in order", () => {
    const card = (id: string, online: boolean): SparkCard => ({ id, local: id === "local", online, hostname: id, checkedAt: 0 });
    const down = unreachableSparks([card("local", true), card("peer-1", false), card("peer-2", true), card("peer-3", false)]);
    expect(down.map((s) => s.id)).toEqual(["peer-1", "peer-3"]);
  });
});
