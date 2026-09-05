/**
 * The bench loop's figures are pure functions over what it sampled and
 * captured: parallelism from the samples, cost from the per-model usage and
 * the pricing table, a cycle's summary, and the change against the cycle
 * before. Pinned here so the report never says what the numbers do not.
 */
import { describe, expect, it } from "vitest";
import { costOfUsage, formatUsd, loadPricing, ratesFor } from "../../../bench/lib/cost.mjs";
import fs from "fs";
import os from "os";
import path from "path";
import { appendFigure, readFigures } from "../../../bench/lib/figures-file.mjs";
import { deltaByTask, figureKey, formatMs, formatTokens, hints, parallelism, summarizeCycle, taskFigures } from "../../../bench/lib/metrics.mjs";

const PRICING = { currency: "USD", models: { "deepseek-v4-pro[1m]": { input: 1, output: 2, cacheRead: 0.1 }, "deepseek-v4-flash": { input: 0.1, output: 0.2 } } };

describe("cost", () => {
  it("prices each model's tokens per million, cache rates falling back to input, and answers no TOTAL while a model is unpriced", () => {
    const cost = costOfUsage({
      "deepseek-v4-pro[1m]": { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000, messages: 10 },
      "deepseek-v4-flash": { input: 3_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, messages: 4 },
      "gpt-mystery": { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, messages: 1 },
    }, PRICING);
    // pro: 1 + 1 + 0.2 + 0.1 (cacheWrite at input's rate) = 2.3; flash: 0.3 + 0.2 = 0.5
    expect(cost.byModel["deepseek-v4-pro[1m]"]).toEqual({ usd: 2.3, priced: true, tokens: 3_600_000 });
    expect(cost.byModel["deepseek-v4-flash"]).toEqual({ usd: 0.5, priced: true, tokens: 4_000_000 });
    expect(cost.byModel["gpt-mystery"]).toEqual({ usd: null, priced: false, tokens: 20 });
    // The priced subtotal is there; the total is not a number, because the
    // unpriced model is not free.
    expect(cost.pricedUsd).toBe(2.8);
    expect(cost.totalUsd).toBeNull();
    expect(cost.unpriced).toEqual(["gpt-mystery"]);
    expect(cost.tokens).toBe(7_600_020);
    const all = costOfUsage({ "deepseek-v4-flash": { input: 1_000_000, output: 0 } }, PRICING);
    expect(all).toMatchObject({ totalUsd: 0.1, pricedUsd: 0.1, unpriced: [] });
  });

  it("answers nothing for no usage, and rates only for a complete row", () => {
    expect(costOfUsage(null, PRICING)).toEqual({ totalUsd: 0, pricedUsd: 0, byModel: {}, unpriced: [], tokens: 0 });
    expect(ratesFor(PRICING, "deepseek-v4-flash")).toEqual({ input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1 });
    expect(ratesFor({ models: { broken: { input: "1" } } }, "broken")).toBeNull();
    expect(loadPricing("/nonexistent/pricing.json")).toEqual({ currency: "USD", models: {} });
  });

  it("prints money the way the report reads it", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.0456)).toBe("$0.046");
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(null)).toBe("n/a");
  });
});

describe("parallelism", () => {
  it("reads the peak, the helper-seconds and the share of the clock with a helper out from the samples", () => {
    const t0 = 1_000_000;
    const samples = [
      { t: t0, subagentsActive: 0 },
      { t: t0 + 10_000, subagentsActive: 2 },
      { t: t0 + 20_000, subagentsActive: 1 },
      { t: t0 + 30_000, subagentsActive: 0 },
      { t: t0 + 40_000, subagentsActive: 0 },
    ];
    const p = parallelism(samples, 40_000);
    expect(p).toEqual({ samples: 5, peakActive: 2, helperSeconds: 30, helperShare: 0.5, agentSecondsPerWallSecond: 1.75 });
  });

  it("is the main loop alone with no samples or no helpers", () => {
    expect(parallelism([], 0)).toEqual({ samples: 0, peakActive: 0, helperSeconds: 0, helperShare: 0, agentSecondsPerWallSecond: 1 });
    expect(parallelism([{ t: 1, subagentsActive: 0 }, { t: 60_001, subagentsActive: 0 }], 60_000).agentSecondsPerWallSecond).toBe(1);
  });
});

describe("a cycle's figures", () => {
  const line = (over: Record<string, unknown>) => ({
    task: "m-01", tier: "M", runId: "run-1", outcome: "completed", score: 90, wallMs: 300_000, commitLagMs: 2_000, numTurns: 20, tokensUsed: 1_000_000, thinkingTokens: 100_000,
    filesTouched: 8, permissionDenials: 0, subagentsTotal: 2, subagentsByType: { explorer: 1, reviewer: 1 }, modelsUsed: ["deepseek-v4-pro[1m]"], usageByModel: null, ...over,
  });
  const fig = (over: Record<string, unknown>, parallel = parallelism([], 0), rep = 1) =>
    taskFigures({ line: line(over), cost: costOfUsage({ "deepseek-v4-flash": { input: 1_000_000, output: 0 } }, PRICING), parallel, cycle: "c1", rep });

  it("keeps the commit lag apart from the time to settle, and adds the two up as the time to finish", () => {
    const f = fig({ wallMs: 300_000, commitLagMs: 2_000 });
    expect(f).toMatchObject({ wallMs: 300_000, commitLagMs: 2_000, endToEndMs: 302_000, rep: 1 });
    expect(fig({ commitLagMs: null }).endToEndMs).toBe(300_000);
    expect(fig({ wallMs: null }).endToEndMs).toBeNull();
  });

  it("sums a cycle and reads the change per task and repetition against the cycle before", () => {
    const before = [fig({ task: "a", wallMs: 100_000, tokensUsed: 1000, score: 80 }), fig({ task: "b", outcome: "failed", score: 20 })];
    const after = [fig({ task: "a", wallMs: 50_000, tokensUsed: 1500, score: 90 }), fig({ task: "b", score: 70 }), fig({ task: "c" })];
    const summary = summarizeCycle(after);
    expect(summary).toMatchObject({ runs: 3, completed: 3, successRate: 1, meanScore: 83.3, costUsd: 0.3, pricedUsd: 0.3, unpriced: [], endToEndMs: 656_000 });
    const d = deltaByTask(before, after);
    expect(d[0]).toMatchObject({ task: "a", rep: 1, wallMs: { before: 100_000, after: 50_000, pct: -50 }, endToEndMs: { before: 102_000, after: 52_000 }, tokensUsed: { pct: 50 }, score: { pct: 12.5 } });
    expect(d[1].outcome).toEqual({ before: "failed", after: "completed" });
    expect(d[2]).toEqual({ task: "c", rep: 1, fresh: true });
  });

  it("compares a repeated task by its repetition, never by the last one alone", () => {
    const before = [fig({ task: "a", wallMs: 100_000 }, undefined, 1), fig({ task: "a", wallMs: 200_000 }, undefined, 2)];
    const after = [fig({ task: "a", wallMs: 110_000 }, undefined, 1), fig({ task: "a", wallMs: 100_000 }, undefined, 2)];
    expect(figureKey(before[1])).toBe("a#2");
    const d = deltaByTask(before, after);
    expect(d.map((x) => [x.rep, x.wallMs?.pct])).toEqual([[1, 10], [2, -50]]);
  });

  it("keeps the cycle's cost a number when a run never started — zero usage is zero cost, not unknown", () => {
    const notStarted = taskFigures({ line: { task: "b", tier: "S", runId: null, outcome: "not-started", wallMs: null, subagentsByType: {}, modelsUsed: [] }, cost: costOfUsage(null, PRICING), parallel: parallelism([], 0), cycle: "c1" });
    expect(notStarted).toMatchObject({ costUsd: 0, pricedUsd: 0, unpricedModels: [] });
    const summary = summarizeCycle([fig({ task: "a" }), notStarted]);
    expect(summary.costUsd).toBe(0.1);
    expect(summary.completed).toBe(1);
  });

  it("answers no cycle cost while any run has an unpriced model", () => {
    const unpriced = taskFigures({ line: line({ task: "u" }), cost: costOfUsage({ mystery: { input: 10, output: 0 } }, PRICING), parallel: parallelism([], 0), cycle: "c1" });
    const summary = summarizeCycle([fig({ task: "a" }), unpriced]);
    expect(summary.costUsd).toBeNull();
    expect(summary.pricedUsd).toBe(0.1);
    expect(summary.unpriced).toEqual(["mystery"]);
  });

  it("hints at what to look at, and only from the numbers", () => {
    const quiet = fig({ task: "long", wallMs: 20 * 60_000, subagentsTotal: 0, subagentsByType: {} });
    const refused = fig({ task: "refused", permissionDenials: 2 });
    const thinker = fig({ task: "thinker", thinkingTokens: 500_000 });
    const fine = fig({ task: "fine" });
    const out = hints([quiet, refused, thinker, fine]);
    expect(out).toEqual([
      expect.stringMatching(/^long: 20 min with no helper/),
      expect.stringMatching(/^refused: 2 refused action/),
      expect.stringMatching(/^thinker: 50% of the tokens were thinking/),
    ]);
  });

  it("formats time and tokens the way the tables read", () => {
    expect(formatMs(65_000)).toBe("1m 5s");
    expect(formatMs(4_000)).toBe("4s");
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatTokens(45_600)).toBe("46k");
  });
});

describe("the cycle's figures on disk", () => {
  it("keeps a run that never started beside the ones that did, and reads the cycle back as it was", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-figures-"));
    const file = path.join(dir, "v1", "loop-c1.jsonl");
    try {
      expect(readFigures(file)).toBeNull();
      const started = taskFigures({ line: { task: "a", tier: "S", runId: "run-1", outcome: "completed", score: 90, wallMs: 1000, subagentsByType: {}, modelsUsed: [] }, cost: costOfUsage({ "deepseek-v4-flash": { input: 1_000_000, output: 0 } }, PRICING), parallel: parallelism([], 0), cycle: "c1" });
      const refused = taskFigures({ line: { task: "b", tier: "S", runId: null, outcome: "not-started", wallMs: null, subagentsByType: {}, modelsUsed: [] }, cost: costOfUsage(null, PRICING), parallel: parallelism([], 0), cycle: "c1" });
      appendFigure(file, started);
      appendFigure(file, refused);
      const back = readFigures(file);
      expect(back).toEqual([started, refused]);
      expect(summarizeCycle(back!)).toMatchObject({ runs: 2, completed: 1, costUsd: 0.1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
