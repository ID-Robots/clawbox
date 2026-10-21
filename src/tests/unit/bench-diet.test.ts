/**
 * The token-diet suite's two judgements that are pure: where a run's tokens
 * went (from its transcripts) and whether a lever is kept. Pinned because the
 * loop changes product defaults on what these say.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { splitPhases, toolStats } from "../../../bench/diet/lib/phases.mjs";
import { decide, tokensOf } from "../../../bench/diet/lib/report.mjs";

function writeJsonl(dir: string, name: string, events: unknown[]): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const msg = (id: string, ts: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: ts,
  message: { id, model: "m", usage, content: [] },
  ...extra,
});

describe("splitPhases", () => {
  it("counts each message once with its largest usage, and splits main, helpers, review and attempts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diet-phases-"));
    const main = writeJsonl(dir, "s.jsonl", [
      // One message written as two lines: the first carries output 0.
      msg("a", "2026-10-18T10:00:00Z", { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0 }),
      msg("a", "2026-10-18T10:00:01Z", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }),
      msg("b", "2026-10-18T10:05:00Z", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }), // attempt 2
      msg("c", "2026-10-18T10:10:00Z", { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 200 }), // review
    ]);
    const side = writeJsonl(dir, "s/subagents/agent-1.jsonl", [
      msg("h", "2026-10-18T10:00:30Z", { input_tokens: 30, output_tokens: 3 }),
    ]);
    const p = splitPhases([main, side], {
      attemptStarts: [Date.parse("2026-10-18T10:04:00Z")],
      reviewStart: Date.parse("2026-10-18T10:09:00Z"),
    });
    expect(p.main.total).toBe(150);
    expect(p.attempts.total).toBe(1015);
    expect(p.review.total).toBe(225);
    expect(p.subagents.total).toBe(33);
    expect(p.subagentsBy.main).toBe(33);
    expect(p.total).toBe(150 + 1015 + 225 + 33);
  });

  it("counts a message that appears in two files (a resumed session) once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diet-phases-"));
    const e = [msg("x", "2026-10-18T10:00:00Z", { input_tokens: 7, output_tokens: 3 })];
    const p = splitPhases([writeJsonl(dir, "one.jsonl", e), writeJsonl(dir, "two.jsonl", e)]);
    expect(p.total).toBe(10);
  });
});

describe("toolStats", () => {
  it("counts tool calls once and repeated reads of the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diet-tools-"));
    const read = (id: string, file: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] } });
    const f = writeJsonl(dir, "s.jsonl", [read("1", "/p/a.js"), read("1", "/p/a.js"), read("2", "/p/a.js"), read("3", "/p/b.js")]);
    const t = toolStats([f]);
    expect(t.mainCalls).toBe(3);
    expect(t.reads).toBe(3);
    expect(t.repeatedReads).toBe(1);
  });
});

describe("decide", () => {
  const r = (spec: string, pass: boolean, total: number, judge: number | null, specHash = "h") => ({
    spec, pass, specHash, phases: { total }, ...(judge === null ? {} : { judge: { overall: judge } }),
  });

  it("keeps a lever that saves tokens without losing acceptance or 0.5 of judge score", () => {
    const d = decide([r("a", true, 1000, 8), r("b", false, 1000, 5)], [r("a", true, 400, 7.8), r("b", false, 300, 5)]);
    expect(d.keep).toBe(true);
    expect(d.tokenRatio).toBeCloseTo(0.35);
    expect(d.geoRatio).toBeCloseTo(Math.sqrt(0.4 * 0.3));
  });

  it("rejects a lever that breaks a spec that passed, however cheap", () => {
    const d = decide([r("a", true, 1000, 8)], [r("a", false, 100, 8)]);
    expect(d.keep).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/acceptance regressed on a/);
  });

  it("rejects a judge drop of 0.5 or more", () => {
    expect(decide([r("a", true, 1000, 8)], [r("a", true, 500, 7.5)]).keep).toBe(false);
    expect(decide([r("a", true, 1000, 8)], [r("a", true, 500, 7.6)]).keep).toBe(true);
  });

  it("judges tokens per spec, so the largest spec alone cannot decide", () => {
    // The big spec got 10% dearer, the three small ones halved: kept.
    const base = [r("big", true, 10_000, 8), r("a", true, 100, 8), r("b", true, 100, 8), r("c", true, 100, 8)];
    const cand = [r("big", true, 11_000, 8), r("a", true, 50, 8), r("b", true, 50, 8), r("c", true, 50, 8)];
    const d = decide(base, cand);
    expect(d.tokenRatio).toBeGreaterThan(1);
    expect(d.keep).toBe(true);
  });

  it("rejects when tokens do not fall, and refuses to compare changed specs", () => {
    expect(decide([r("a", true, 1000, 8)], [r("a", true, 1000, 8)]).keep).toBe(false);
    const d = decide([r("a", true, 1000, 8, "h1")], [r("a", true, 10, 8, "h2")]);
    expect(d.keep).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/not comparable/);
  });

  it("reads tokens from the transcript split, not the box records that double count a review", () => {
    expect(tokensOf({ phases: { total: 270 }, totalTokens: 395 })).toBe(270);
    expect(tokensOf({ totalTokens: 395 })).toBe(395);
  });
});
