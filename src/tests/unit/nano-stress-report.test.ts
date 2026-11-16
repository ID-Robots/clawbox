import { describe, expect, it } from "vitest";
import {
  findingsOf,
  percentile,
  renderMarkdown,
  samplesFor,
  summarizeRaw,
} from "../../../scripts/nano-stress/report.mjs";
import { parseOptions, replyHolds, takeSseFrames } from "../../../scripts/nano-stress/board-stress.mjs";

// scripts/nano-stress/report.mjs turns a board stress run's raw records (every
// turn, a sample every few seconds, each unit's MainPID/NRestarts at a step's
// edges) into per-step numbers and the markdown summary (TASK-2500).

const MB = 1024;
const sample = (t: number, over: Record<string, number | null> = {}) => ({
  t,
  memAvailableKb: 5000 * MB,
  swapUsedKb: 100 * MB,
  cpuBusyPct: 10,
  load1: 0.5,
  tempMaxC: 50,
  tempCpuC: 49,
  tempTjC: 50,
  selfRssKb: 60 * MB,
  gatewayRssKb: 400 * MB,
  gatewayCgroupKb: 500 * MB,
  gatewayProcs: 3,
  webRssKb: 250 * MB,
  webCgroupKb: 300 * MB,
  webProcs: 1,
  ...over,
});
const units = (gwPid: number, gwRestarts: number) => ({
  gateway: { unit: "clawbox-gateway", mainPid: gwPid, restarts: gwRestarts, active: "active", cgroup: "/system.slice/clawbox-gateway.service" },
  web: { unit: "clawbox-setup", mainPid: 20, restarts: 0, active: "active", cgroup: "/system.slice/clawbox-setup.service" },
});
const turn = (step: string, idx: number, latencyMs: number | null, over: Record<string, unknown> = {}) => ({
  step, chat: `${step}-c1`, idx, kind: "echo", startedAt: 0, ok: true, latencyMs, firstTokenMs: latencyMs === null ? null : latencyMs / 2, ackMs: 5, toolCalls: 0, replyChars: 10, ...over,
});

function raw() {
  return {
    version: 1,
    tool: "clawbox-nano-stress",
    runId: "abcd1234",
    final: true,
    startedAt: "2026-11-16T21:00:00.000Z",
    endedAt: "2026-11-16T21:30:00.000Z",
    runtime: "openclaw",
    units: { gateway: "clawbox-gateway", web: "clawbox-setup" },
    board: { model: "Jetson test board", memTotalMb: 7607, swapTotalMb: 11996, cpus: 6, clawboxSha: "0123456789abcdef", clawboxBranch: "beta" },
    config: { turnTimeoutS: 240 },
    cleanup: { sessions: 3, deleted: 2, left: ["agent:main:clawbox-stress-x-long"] },
    steps: [
      { id: "ramp-1", kind: "ramp", concurrency: 1, startedAt: 1000, endedAt: 20_000, unitsBefore: units(10, 0), unitsAfter: units(10, 0), oomKillsBefore: 0, oomKillsAfter: 0, healthyAfter: true },
      { id: "ramp-8", kind: "ramp", concurrency: 8, startedAt: 30_000, endedAt: 90_000, unitsBefore: units(10, 0), unitsAfter: units(11, 1), oomKillsBefore: 0, oomKillsAfter: 2, healthyAfter: false, slowChatSends: { count: 4, maxMs: 6235, maxPreparationMs: 4235 } },
      { id: "long", kind: "long", concurrency: 1, startedAt: 100_000, endedAt: 200_000, unitsBefore: units(11, 1), unitsAfter: units(11, 1), oomKillsBefore: 2, oomKillsAfter: 2, healthyAfter: true },
    ],
    turns: [
      turn("ramp-1", 1, 4000),
      turn("ramp-1", 2, 2000),
      turn("ramp-8", 1, 10_000),
      turn("ramp-8", 2, 30_000, { ok: false, error: { kind: "wrong-answer", message: "reply lacks the expected \"STRESS-1\"" } }),
      turn("ramp-8", 3, 240_000, { ok: false, error: { kind: "timeout", message: "no final within 240 s" } }),
      turn("long", 1, 1000, { kind: "remember", model: "test-model" }),
      ...[2, 3, 4, 5, 6, 7].map((k) => turn("long", k, k * 1000, { kind: "chat", model: "test-model" })),
      turn("long", 8, 9000, { kind: "recall", ok: false, error: { kind: "wrong-answer", message: "reply lacks the code word" } }),
    ],
    samples: [
      sample(500, { memAvailableKb: 5200 * MB, gatewayRssKb: 380 * MB }),
      sample(10_000),
      sample(25_000),
      sample(31_000, { memAvailableKb: 900 * MB }),
      sample(60_000, { memAvailableKb: 250 * MB, swapUsedKb: 2000 * MB, tempMaxC: 71.26, gatewayRssKb: 1200 * MB, gatewayCgroupKb: 900 * MB }),
      sample(89_000, { memAvailableKb: 1500 * MB }),
      sample(150_000),
    ],
  };
}

describe("percentile", () => {
  it("is nearest-rank over the finite values", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([null, NaN, 4, undefined], 50)).toBe(4);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("samplesFor", () => {
  it("takes the samples inside the step and the last one before it as its start", () => {
    const s = raw().samples;
    const { inside, start, end } = samplesFor(s, 30_000, 90_000);
    expect(inside.map((x) => x.t)).toEqual([31_000, 60_000, 89_000]);
    expect(start?.t).toBe(25_000);
    expect(end?.t).toBe(89_000);
  });
});

describe("summarizeRaw", () => {
  const report = summarizeRaw(raw());

  it("counts turns and leaves a timed-out turn out of the latency", () => {
    const r8 = report.steps.find((s) => s.id === "ramp-8")!;
    expect(r8.turns).toEqual({ total: 3, ok: 1, failed: 2 });
    expect(r8.errors.kinds).toEqual({ "wrong-answer": 1, timeout: 1 });
    expect(r8.latencyMs.p50).toBe(10_000);
    expect(r8.latencyMs.max).toBe(30_000);
    const r1 = report.steps.find((s) => s.id === "ramp-1")!;
    expect(r1.latencyMs.p50).toBe(2000);
    expect(r1.latencyMs.p95).toBe(4000);
    expect(r1.latencyMs.firstTokenP50).toBe(1000);
  });

  it("reads memory, swap, temperature and RSS over the step in MB", () => {
    const x = report.steps.find((s) => s.id === "ramp-8")!.resources;
    expect(x.memAvailableMb).toEqual({ start: 5000, min: 250, end: 1500 });
    expect(x.swapUsedMb.max).toBe(2000);
    expect(x.tempC.max).toBe(71.3);
    expect(x.gatewayRssMb).toEqual({ start: 400, max: 1200, end: 400 });
    expect(x.gatewayCgroupMb).toEqual({ start: 500, max: 900, end: 500 });
  });

  it("finds restarts, a new main process, OOM kills and an unhealthy runtime", () => {
    const r8 = report.steps.find((s) => s.id === "ramp-8")!;
    expect(r8.units.gateway).toMatchObject({ restarts: 1, pidChanged: true });
    expect(r8.oomKills).toBe(2);
    expect(report.totals).toMatchObject({ turns: 13, ok: 10, failed: 3, oomKills: 2, restarts: 1, memAvailableMinMb: 250 });
    expect(report.findings).toEqual(expect.arrayContaining([
      "ramp-8: 2/3 turns failed (wrong-answer 1, timeout 1)",
      "ramp-8: 2 OOM kill(s)",
      "ramp-8: clawbox-gateway restarted 1 time(s)",
      "ramp-8: openclaw not healthy within 120 s after the step",
      "ramp-8: MemAvailable fell to 250 MB",
      "long: recalled the code word 0/1 times",
      "cleanup: 1 of 3 sessions could not be deleted",
    ]));
    expect(findingsOf({ ...report, cleanup: null, steps: [report.steps[0]] })).toEqual([]);
  });

  it("compares the long session's first and last turns", () => {
    const long = report.steps.find((s) => s.id === "long")!;
    expect(long.long).toEqual({ firstFiveP50Ms: 4000, lastFiveP50Ms: 5000, recall: { asked: 1, ok: 0 } });
    expect(report.models).toEqual(["test-model"]);
  });

  it("refuses a file that is not a stress record", () => {
    expect(() => summarizeRaw({ tool: "something-else" })).toThrow(/not a clawbox-nano-stress record/);
  });
});

describe("renderMarkdown", () => {
  it("writes one table row per step and the findings", () => {
    const md = renderMarkdown([summarizeRaw(raw())]);
    expect(md).toContain("## OpenClaw");
    expect(md).toContain("`0123456789ab` (beta)");
    expect(md).toContain("| ramp-8 | 8 | 1/3 | 10.0 | 30.0 | 30.0 | 5.0 | 5000→250 | 2000 | 71.3 | 10 | 500→900 | 1200 | 3 | 250 | 1 | 2 |");
    expect(md).toContain("- ramp-8: 2 OOM kill(s)");
    expect(md).toContain("code word recalled 0/1");
    expect(md).toContain('Gateway "slow chat send" log lines: ramp-8 4 (max 6.2 s, preparation 4.2 s).');
  });

  it("says so when nothing went wrong", () => {
    const clean = raw();
    clean.steps = [clean.steps[0]];
    clean.cleanup = { sessions: 1, deleted: 1, left: [] };
    clean.turns = clean.turns.filter((t) => t.step === "ramp-1");
    const md = renderMarkdown([summarizeRaw(clean)]);
    expect(md).toContain("Findings: none");
    expect(md).toContain("Cleanup: 1/1 test sessions deleted.");
  });
});

// The board side's own checks (scripts/nano-stress/board-stress.mjs): what
// counts as the right answer, and how a streamed Hermes turn is read.
describe("replyHolds", () => {
  it("wants the expected text as a whole token", () => {
    expect(replyHolds("9", "9")).toBe(true);
    expect(replyHolds("The answer is 9.", "9")).toBe(true);
    expect(replyHolds("19", "9")).toBe(false);
    expect(replyHolds("137", "37")).toBe(false);
    expect(replyHolds("STRESS-AB12CD", "STRESS-AB12CD")).toBe(true);
    expect(replyHolds("/tmp/x/sub/a.txt\n", "/tmp/x/sub/a.txt")).toBe(true);
  });
  it("does not count an echo of the prompt", () => {
    const prompt = "Reply with exactly this text and nothing else: STRESS-AB12CD";
    expect(replyHolds(prompt, "STRESS-AB12CD", prompt)).toBe(false);
    expect(replyHolds(`${prompt}\nSTRESS-AB12CD`, "STRESS-AB12CD", prompt)).toBe(true);
    expect(replyHolds("Reply with only OK.", "OK", "Reply with only OK.")).toBe(false);
  });
  it("tests a RegExp as it is (a hash prefix may run on)", () => {
    const want = /(?:^|[^0-9a-f])0123456789abcdef/;
    expect(replyHolds("0123456789abcdef", want)).toBe(true);
    expect(replyHolds("0123456789abcdef0011223344", want)).toBe(true);
    expect(replyHolds("f0123456789abcdef", want)).toBe(false);
  });
});

describe("takeSseFrames", () => {
  it("returns the complete frames and keeps a partial one for the next read", () => {
    const { frames, rest } = takeSseFrames('event: delta\ndata: {"text":"po"}\n\nevent: tool\ndata: {"name":"terminal"}\n\nevent: done\ndata: {"te');
    expect(frames).toEqual([
      { event: "delta", data: { text: "po" } },
      { event: "tool", data: { name: "terminal" } },
    ]);
    const next = takeSseFrames(rest + 'xt":"pong","sessionId":"s1"}\r\n\r\n');
    expect(next.frames).toEqual([{ event: "done", data: { text: "pong", sessionId: "s1" } }]);
    expect(next.rest).toBe("");
  });
  it("keeps a frame whose data is not JSON, with null data", () => {
    expect(takeSseFrames("event: ping\ndata: hello\n\n").frames).toEqual([{ event: "ping", data: null }]);
  });
});

describe("parseOptions", () => {
  it("has the defaults the doc names and a work folder of the run's own", () => {
    const { out, cfg } = parseOptions(["--out", "/tmp/clawbox-stress-x/raw.json"]);
    expect(out).toBe("/tmp/clawbox-stress-x/raw.json");
    expect(cfg).toMatchObject({ runtime: "auto", ramp: [1, 2, 4, 8], rampTurns: 3, longTurns: 32, toolTurns: 8, steps: ["idle", "ramp", "long", "tool"], turnTimeoutS: 240 });
    expect(cfg.workDir).toMatch(/^\/tmp\/clawbox-stress-x\/stress-work-[0-9a-f]{8}$/);
  });
  it("refuses a missing record path and bad numbers", () => {
    expect(() => parseOptions([])).toThrow(/usage/);
    expect(() => parseOptions(["--out", "/tmp/r.json", "--ramp-turns", "0"])).toThrow(/rampTurns/);
    expect(() => parseOptions(["--out", "/tmp/r.json", "--ramp", "x"])).toThrow(/--ramp/);
    expect(() => parseOptions(["--out", "/tmp/r.json", "--runtime", "other"])).toThrow(/--runtime/);
    expect(() => parseOptions(["--out", "/tmp/r.json", "--settle", "-1"])).toThrow(/settleS/);
  });
});
