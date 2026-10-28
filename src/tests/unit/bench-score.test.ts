import { describe, expect, it } from "vitest";
import { compareReports, median, overallScore, percentile, scoreArea, scoreMetric } from "../../../scripts/bench/lib/score.mjs";

// The bench's scoring (scripts/bench/lib/score.mjs) is what makes two runs
// comparable: a metric is 100 at its `good` anchor, 0 at `bad`, linear and
// clamped between, in either direction; an area is the (weighted) mean of its
// metrics; the overall score the weighted mean of the areas that scored.

describe("scoreMetric", () => {
  it("maps good→100 and bad→0 for lower-is-better", () => {
    expect(scoreMetric({ value: 10, good: 10, bad: 100 })).toBe(100);
    expect(scoreMetric({ value: 100, good: 10, bad: 100 })).toBe(0);
    expect(scoreMetric({ value: 55, good: 10, bad: 100 })).toBe(50);
  });
  it("maps the other direction when good > bad", () => {
    expect(scoreMetric({ value: 1, good: 1, bad: 0 })).toBe(100);
    expect(scoreMetric({ value: 0, good: 1, bad: 0 })).toBe(0);
    expect(scoreMetric({ value: 60, good: 50, bad: 8 })).toBe(100);
  });
  it("clamps past the anchors and refuses what it cannot score", () => {
    expect(scoreMetric({ value: 1, good: 10, bad: 100 })).toBe(100);
    expect(scoreMetric({ value: 5000, good: 10, bad: 100 })).toBe(0);
    expect(scoreMetric({ value: null, good: 10, bad: 100 })).toBeNull();
    expect(scoreMetric({ value: NaN, good: 10, bad: 100 })).toBeNull();
    expect(scoreMetric({ value: 5, good: 10, bad: 10 })).toBeNull();
    expect(scoreMetric(undefined)).toBeNull();
  });
});

describe("scoreArea / overallScore", () => {
  it("averages the scorable metrics with their weights and skips the rest", () => {
    const area = scoreArea({
      a: { value: 10, good: 10, bad: 100 }, // 100
      b: { value: 100, good: 10, bad: 100, weight: 3 }, // 0, weight 3
      c: { value: null, good: 1, bad: 0 }, // not scored
    });
    expect(area).toBe(25);
    expect(scoreArea({})).toBeNull();
    expect(scoreArea({ c: { value: null, good: 1, bad: 0 } })).toBeNull();
  });
  it("weights areas and leaves unscored areas out", () => {
    expect(overallScore({ x: { score: 100, weight: 1 }, y: { score: 0, weight: 3 }, z: { score: null, weight: 50 } })).toBe(25);
    expect(overallScore({ z: { score: null, weight: 50 } })).toBeNull();
  });
});

describe("median / percentile", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 50)).toBe(5);
  });
});

describe("compareReports", () => {
  const before = { overall: 70, scenarios: { chat: { score: 60, metrics: { ttft_ms: { value: 4000, dir: "lower", unit: "ms" } } }, api: { score: 80, metrics: {} } } };
  const after = { overall: 75, scenarios: { chat: { score: 70, metrics: { ttft_ms: { value: 2000, dir: "lower", unit: "ms" } } }, api: { score: 79, metrics: {} }, files: { score: 90, metrics: {} } } };
  it("calls a move past the threshold better or worse and the rest the same", () => {
    const cmp = compareReports(before, after, { threshold: 3 });
    expect(cmp.areas.chat.verdict).toBe("better");
    expect(cmp.areas.chat.delta).toBe(10);
    expect(cmp.areas.api.verdict).toBe("same");
    expect(cmp.areas.files.verdict).toBe("n/a");
    expect(cmp.overall).toMatchObject({ before: 70, after: 75, delta: 5, verdict: "better" });
  });
  it("reads a metric's direction so a lower latency counts as better", () => {
    const cmp = compareReports(before, after);
    expect(cmp.areas.chat.metrics.ttft_ms).toMatchObject({ before: 4000, after: 2000, delta: -2000, pct: -50, direction: "better" });
  });
  it("calls a regression worse", () => {
    const cmp = compareReports(after, before, { threshold: 3 });
    expect(cmp.areas.chat.verdict).toBe("worse");
    expect(cmp.overall.verdict).toBe("worse");
  });
});
