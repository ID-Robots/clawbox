/**
 * The contradiction judge against the answers a real model gives: fenced
 * JSON, prose around it, a truncated array, extra fields, a wrapper object —
 * and the pass that sends it small batches, asks an unreadable batch again in
 * halves, and loses only what still fails. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashEmbedder, JUDGE_BATCH_PAIRS, runContradictionPass } from "@/lib/prime-radiant/contradictions";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { FlashCallError, type FlashClient, type FlashRequest } from "@/lib/prime-radiant/flash-client";
import { jsonObjectsIn, JudgeParseError, parseJudgeResponse, readJudgeItems } from "@/lib/prime-radiant/judge";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-judge-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const noSleep = { sleep: async () => undefined, attempts: 1 };

describe("parseJudgeResponse: messy model answers", () => {
  it("reads a fenced JSON block with prose before and after it", () => {
    const text = [
      "Sure! Here are the verdicts for the pairs [0-2] you sent (one mentioned [REDACTED:EMAIL]):",
      "",
      "```json",
      '[{"i": 0, "verdict": "contradiction", "why": "10 EUR vs 12 EUR"},',
      ' {"i": 1, "verdict": "compatible", "why": "different products"},',
      ' {"i": 2, "verdict": "unsure", "why": "dates unclear"}]',
      "```",
      "",
      "Let me know if you need anything else {happy to help}.",
    ].join("\n");
    const m = parseJudgeResponse(text, 3);
    expect([...m.entries()].map(([i, v]) => [i, v.verdict])).toEqual([
      [0, "contradiction"],
      [1, "compatible"],
      [2, "unsure"],
    ]);
  });

  it("keeps the complete verdicts of a truncated array", () => {
    const text = '[{"i":0,"verdict":"compatible","why":"ok"},{"i":1,"verdict":"contradiction","why":"price differs"},{"i":2,"verdict":"contra';
    const m = parseJudgeResponse(text, 3);
    expect([...m.keys()]).toEqual([0, 1]);
    expect(m.get(1)?.verdict).toBe("contradiction");
  });

  it("survives extra fields, nested objects, a capitalised verdict and a string index", () => {
    const text =
      '[{"i":"0","verdict":"Contradiction","why":"figures {differ}","confidence":0.9,"meta":{"a":"x","b":[1,2]}},' +
      '{"i":1,"verdict":" compatible ","why":"fine","a":"The blue widget costs 10 EUR.","b":"Shipping takes 3 days."}]';
    const m = parseJudgeResponse(text, 2);
    expect(m.get(0)).toEqual({ verdict: "contradiction", why: "figures {differ}" });
    expect(m.get(1)?.verdict).toBe("compatible");
  });

  it("reads verdicts inside a wrapper object and one object per line", () => {
    expect([...parseJudgeResponse('{"results": [{"i":0,"verdict":"unsure"},{"i":1,"verdict":"compatible"}]}', 2).keys()]).toEqual([0, 1]);
    const lines = '{"i":0,"verdict":"compatible"}\n{"i":1,"verdict":"contradiction","why":"no"}\n';
    expect(parseJudgeResponse(lines, 2).get(1)?.verdict).toBe("contradiction");
  });

  it("fails only the pairs that are garbled, out of range or answered two ways", () => {
    const text =
      '[{"i":0,"verdict":"contradiction","why":"a"},{"i":0,"verdict":"compatible"},' +
      '{"i":1,"verdict":"maybe"},{"i":2,"verdict":"unsure","why":"mail me at someone@example.com"},' +
      '{"i":2,"verdict":"unsure"},{"i":9,"verdict":"contradiction"},{"verdict":"compatible"},{"i":3}]';
    const m = parseJudgeResponse(text, 4);
    expect([...m.keys()]).toEqual([2]);
    expect(m.get(2)?.why).toContain("[REDACTED:EMAIL]");
  });

  it("throws when the answer holds no verdict at all", () => {
    expect(() => parseJudgeResponse("I could not decide on these pairs.", 2)).toThrow(JudgeParseError);
    expect(() => parseJudgeResponse("[]", 2)).toThrow(JudgeParseError);
    expect(() => parseJudgeResponse('[{"i":0,"a":"x","b":"y"},{"i":1,"a":"x","b":"z"}]', 2)).toThrow(JudgeParseError);
    expect(() => parseJudgeResponse('[{"i":0,"verdict":"contra', 2)).toThrow(JudgeParseError);
  });

  it("walks strings with escapes, so a quote or brace in a why never ends an object", () => {
    expect(jsonObjectsIn('x {"why":"a \\"}\\" b","i":0} y {bad} {"i":1}')).toEqual([{ why: 'a "}" b', i: 0 }, { i: 1 }]);
  });
});

// ── the pass ──────────────────────────────────────────────────────────────

/** Seven pages of three priced widgets each: 21 claims, a few dozen candidate pairs. */
function manyClaims() {
  const pages: Record<string, string> = {};
  for (let p = 0; p < 7; p++) {
    pages[`concepts/catalogue-${p}.md`] = pageText({
      title: `Catalogue ${p}`,
      claims: [0, 1, 2].map((c) => claim(`acme-sales/catalogue-${p}/widget-${c}`, `The widget model ${c} costs ${10 + p} EUR per unit in region ${p}.`)),
    });
  }
  return snapshot(pages);
}

type Answer = (items: Array<{ i: number; a: string; b: string }>, call: number) => string;

function scripted(answer: Answer): FlashClient & { sizes: number[]; maxInFlight: number } {
  let inFlight = 0;
  const c = {
    model: "deepseek-v4-flash",
    sizes: [] as number[],
    maxInFlight: 0,
    async complete(request: FlashRequest) {
      const items = readJudgeItems(request.user) ?? [];
      const call = c.sizes.length;
      c.sizes.push(items.length);
      inFlight += 1;
      c.maxInFlight = Math.max(c.maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return { text: answer(items, call), model: "deepseek-v4-flash", usage: { promptTokens: 500, completionTokens: 80, cacheHitTokens: 0 } };
    },
  };
  return c;
}

const fenced = (items: Array<{ i: number }>, verdict = "compatible") =>
  "Here you go:\n```json\n" + JSON.stringify(items.map((it) => ({ i: it.i, verdict, why: "different regions", extra: { note: "x" } }))) + "\n```\nDone.";

describe("contradiction pass: small batches", () => {
  it("sends at most JUDGE_BATCH_PAIRS pairs a call, within the parallelism it is given", async () => {
    const client = scripted((items) => fenced(items));
    const r = await runContradictionPass(manyClaims(), {
      stateVault: vaultDir(),
      scope: null,
      client,
      embedder: createHashEmbedder(),
      rates: DEFAULT_COST_RATES,
      retry: noSleep,
      parallel: 2,
    });
    expect(r.pairs).toBeGreaterThan(JUDGE_BATCH_PAIRS * 2);
    expect(Math.max(...client.sizes)).toBeLessThanOrEqual(JUDGE_BATCH_PAIRS);
    expect(client.sizes.reduce((x, y) => x + y, 0)).toBe(r.pairs);
    expect(client.maxInFlight).toBeLessThanOrEqual(2);
    expect(r.judged).toBe(r.pairs);
    expect(r.failedBatches).toBe(0);
    expect(r.deferredPairs).toBe(0);
    expect(r.skipped).toBeNull();
  });

  it("asks an unreadable batch again as two halves, and loses nothing when they answer", async () => {
    // The first call rambles with no JSON; every later call answers properly.
    const client = scripted((items, call) => (call === 0 ? "Thinking about these pairs carefully, the prices seem" : fenced(items, "contradiction")));
    const r = await runContradictionPass(manyClaims(), {
      stateVault: vaultDir(),
      scope: null,
      client,
      embedder: createHashEmbedder(),
      retry: noSleep,
      parallel: 1,
      raiseItems: false,
    });
    expect(client.sizes[0]).toBe(JUDGE_BATCH_PAIRS);
    expect(client.sizes.slice(1, 3)).toEqual([JUDGE_BATCH_PAIRS / 2, JUDGE_BATCH_PAIRS / 2]);
    expect(r.failedBatches).toBe(0);
    expect(r.judged).toBe(r.pairs);
    expect(r.findings).toHaveLength(r.pairs);
    expect(r.notes.join(" ")).not.toContain("judge call failed");
  });

  it("loses only the batch that keeps failing, counts it, and still raises the rest", async () => {
    let poisoned: Set<string> | null = null;
    const client = scripted((items, call) => {
      if (call === 0) poisoned = new Set(items.map((it) => `${it.a}|${it.b}`));
      if (items.every((it) => poisoned!.has(`${it.a}|${it.b}`))) return '[{"i":0,"verdict":"contra'; // truncated, no verdict
      return fenced(items, "contradiction");
    });
    const r = await runContradictionPass(manyClaims(), {
      stateVault: vaultDir(),
      scope: null,
      client,
      embedder: createHashEmbedder(),
      retry: noSleep,
      parallel: 1,
    });
    expect(r.failedBatches).toBe(2); // both halves of the first batch
    expect(r.deferredPairs).toBe(JUDGE_BATCH_PAIRS);
    expect(r.judged).toBe(r.pairs - JUDGE_BATCH_PAIRS);
    expect(r.reviewItems.length).toBe(r.pairs - JUDGE_BATCH_PAIRS);
    expect(r.notes).toContain("2 judge calls failed (bad_response); their pairs are judged next pass.");
    expect(r.skipped).toBeNull();

    // The next pass asks only the deferred pairs.
    const next = scripted((items) => fenced(items));
    const again = await runContradictionPass(manyClaims(), { stateVault: vaultDir(), scope: null, client: next, embedder: createHashEmbedder(), retry: noSleep });
    expect(next.sizes.reduce((x, y) => x + y, 0)).toBe(JUDGE_BATCH_PAIRS);
    expect(again.deferredPairs).toBe(0);
  });

  it("fails a single pair the answer leaves out, not its batch", async () => {
    const client = scripted((items) => "Verdicts:\n" + JSON.stringify(items.filter((it) => it.i !== 3).map((it) => ({ i: it.i, verdict: "compatible" }))));
    const r = await runContradictionPass(manyClaims(), { stateVault: vaultDir(), scope: null, client, embedder: createHashEmbedder(), retry: noSleep });
    const batches = Math.ceil(r.pairs / JUDGE_BATCH_PAIRS);
    expect(client.sizes).toHaveLength(batches); // no half-size retry: the answer was readable
    expect(r.failedBatches).toBe(0);
    expect(r.deferredPairs).toBe(client.sizes.filter((s) => s > 3).length);
    expect(r.judged).toBe(r.pairs - r.deferredPairs);
  });

  it("does not halve a batch whose call failed for another reason", async () => {
    const client: FlashClient & { calls: number } = {
      model: "deepseek-v4-flash",
      calls: 0,
      async complete() {
        this.calls += 1;
        throw new FlashCallError("server", "upstream 502");
      },
    };
    const r = await runContradictionPass(manyClaims(), { stateVault: vaultDir(), scope: null, client, embedder: createHashEmbedder(), retry: noSleep });
    const batches = Math.ceil(r.pairs / JUDGE_BATCH_PAIRS);
    expect(client.calls).toBe(batches);
    expect(r.failedBatches).toBe(batches);
    expect(r.deferredPairs).toBe(r.pairs);
    expect(r.judged).toBe(0);
  });
});
