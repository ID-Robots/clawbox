/**
 * The nightly pass's parts with every model replaced: the contradiction pass
 * (kNN blocking, the judge, its caches), the Opus tier (queue, hard cap,
 * absent provider), the scheduler's clock and the new settings sections.
 * Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectClaims,
  createHashEmbedder,
  nearestPairs,
  pairHash,
  runContradictionPass,
  type ClaimEmbedder,
} from "@/lib/prime-radiant/contradictions";
import { DEFAULT_COST_RATES, mergeCostRates } from "@/lib/prime-radiant/cost-rates";
import { FlashCallError, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { createStubFlashClient, stubVerdict } from "@/lib/prime-radiant/flash-stub";
import { buildJudgePrompt, parseJudgeResponse, readJudgeItems } from "@/lib/prime-radiant/judge";
import { computeNextNightlyMs } from "@/lib/prime-radiant/nightly-scheduler";
import { buildOpusQueue, createAnthropicOpusClient, OpusUnavailableError, parseOpusResponse, runOpusTier, worstCaseUsd, type OpusClient } from "@/lib/prime-radiant/opus";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { listReviewItems } from "@/lib/prime-radiant/review-store";
import { readCostSummary } from "@/lib/prime-radiant/runs";
import { readSettings, readSettingsPatch, SettingsError, writeSettings } from "@/lib/prime-radiant/settings";
import { readPage, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-passes-"));
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

const PAGES = {
  "concepts/pricing.md": pageText({ claims: [claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR per unit.")] }),
  "concepts/catalogue.md": pageText({
    title: "Catalogue",
    claims: [
      claim("acme-sales/catalogue/blue-widget", "The blue widget costs 12 EUR per unit."),
      claim("acme-sales/catalogue/support", "Support answers mail at help@example.com on weekdays."),
    ],
  }),
  "concepts/shipping.md": pageText({ title: "Shipping", claims: [claim("acme-ops/shipping/days", "Orders ship within three working days.")] }),
};

function judge(verdict: (a: string, b: string) => string, onCall?: (user: string) => void): FlashClient & { calls: number } {
  const c = {
    model: "deepseek-v4-flash",
    calls: 0,
    async complete(request: { user: string }) {
      c.calls += 1;
      onCall?.(request.user);
      const items = readJudgeItems(request.user) ?? [];
      const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: verdict(it.a, it.b), why: "figures differ" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 0 } };
    },
  };
  return c;
}

describe("contradiction pass: pieces", () => {
  it("collects active claims redacted", () => {
    const claims = collectClaims(snapshot(PAGES));
    expect(claims).toHaveLength(4);
    expect(claims.find((c) => c.id === "acme-sales/catalogue/support")?.text).toContain("[REDACTED:EMAIL]");
  });

  it("pairs each query with its nearest neighbours on other pages, each pair once", () => {
    const claims = [
      { id: "a/b/c", page: "p1" },
      { id: "a/b/d", page: "p1" },
      { id: "a/e/c", page: "p2" },
      { id: "a/f/c", page: "p3" },
    ];
    const v = (x: number, y: number) => Float32Array.from([x, y]);
    const vectors = [v(1, 0), v(0.99, 0.1), v(0.98, 0.2), v(0, 1)];
    const pairs = nearestPairs(claims, vectors, [0, 2], 1);
    // Closest first: claim 1 is nearer claim 2 than claim 0 is.
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 2], [0, 2]]);
  });

  it("hashes a pair the same both ways round", () => {
    expect(pairHash("x", "y")).toBe(pairHash("y", "x"));
    expect(pairHash("x", "y")).not.toBe(pairHash("x", "z"));
  });

  it("reads the judge's answer strictly", () => {
    const m = parseJudgeResponse(
      'Sure: [{"i":0,"verdict":"contradiction","why":"price differs"},{"i":0,"verdict":"compatible"},{"i":5,"verdict":"contradiction"},{"i":1,"verdict":"maybe"},{"i":2,"verdict":"unsure","why":"mail me at a@example.com"}]',
      3,
    );
    expect([...m.keys()]).toEqual([0, 2]);
    expect(m.get(2)?.why).toContain("[REDACTED:EMAIL]");
    expect(parseJudgeResponse("no json", 2).size).toBe(0);
    const { user } = buildJudgePrompt([{ a: "x", b: "y" }]);
    expect(readJudgeItems(user)).toEqual([{ i: 0, a: "x", b: "y" }]);
  });

  it("the stub judge flags same subject, different figures", () => {
    expect(stubVerdict("The blue widget costs 10 EUR.", "The blue widget costs 12 EUR.")).toBe("contradiction");
    expect(stubVerdict("The blue widget costs 10 EUR.", "Shipping takes 3 days.")).toBe("compatible");
  });
});

describe("contradiction pass", () => {
  async function seedVault() {
    await vaultOperation("seed: pages", async (tx) => {
      for (const [p, t] of Object.entries(PAGES)) await tx.write(p, t);
    });
    return readVaultSnapshot();
  }

  it("finds a planted contradiction, raises one review item, and pays for nothing twice", async () => {
    const snap = await seedVault();
    const sent: string[] = [];
    const client = judge((a, b) => (/costs/.test(a) && /costs/.test(b) ? "contradiction" : "compatible"), (u) => sent.push(u));
    const embedder = createHashEmbedder();
    const embed = vi.spyOn(embedder, "embed");
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client, embedder, rates: DEFAULT_COST_RATES, runId: "run-0000000000aa", k: 2 });
    expect(r.skipped).toBeNull();
    expect(r.findings).toHaveLength(1);
    expect([r.findings[0].a.id, r.findings[0].b.id].sort()).toEqual(["acme-sales/catalogue/blue-widget", "acme-sales/pricing/blue-widget"]);
    expect(r.reviewItems).toHaveLength(1);
    expect(r.reviewItems[0]).toMatchObject({ kind: "contradiction", runId: "run-0000000000aa" });
    expect(r.reviewItems[0].candidates).toHaveLength(2);
    expect(r.calls).toBe(1);
    expect(sent.join("\n")).not.toContain("help@example.com");
    const summary = readCostSummary(vaultDir(), DEFAULT_COST_RATES);
    expect(summary.byOperation.map((o) => o.operation)).toEqual(["contradiction-judge"]);
    // The embedder reports no usage: embeddings are said to be unmeasured, never summed as free.
    expect(summary.notMeasured).toEqual([{ operation: "embedding", reason: "no_usage_reported" }]);

    const again = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client, embedder, rates: DEFAULT_COST_RATES, k: 2 });
    expect(again.embedded).toBe(0);
    expect(again.judged).toBe(0);
    expect(client.calls).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(again.findings).toHaveLength(1);
    // Still one waiting item for the same pair.
    expect(listReviewItems(vaultDir()).total).toBe(1);
  });

  it("queries only the claims in scope", async () => {
    const snap = await seedVault();
    const r = await runContradictionPass(snap, {
      stateVault: vaultDir(),
      scope: ["concepts/shipping.md"],
      client: judge(() => "compatible"),
      embedder: createHashEmbedder(),
      raiseItems: false,
    });
    expect(r.queried).toBe(1);
  });

  it("skips, never throws, when the embedder or the judge cannot answer", async () => {
    const snap = await seedVault();
    const broken: ClaimEmbedder = {
      identity: async () => "broken",
      embed: async () => {
        throw new Error("embed unit is down");
      },
    };
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: judge(() => "contradiction"), embedder: broken });
    expect(r.skipped).toBe("embedder_unavailable");
    expect(r.findings).toEqual([]);

    const refused: FlashClient = {
      model: "deepseek-v4-flash",
      complete: async () => {
        throw new FlashCallError("no_credential", "not signed in");
      },
    };
    const q = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: refused, embedder: createHashEmbedder() });
    expect(q.skipped).toBe("judge_unavailable");
    expect(q.findings).toEqual([]);
  });

  it("works with the deterministic stub model", async () => {
    const snap = await seedVault();
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: createStubFlashClient(), embedder: createHashEmbedder(), k: 3 });
    expect(r.findings.some((f) => f.verdict === "contradiction")).toBe(true);
  });
});

describe("opus tier", () => {
  const verified = { status: "verified" as const, verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" } };

  it("queues owed, changed, reviewed and sampled pages; never verified or human ones", () => {
    const snap = snapshot({
      "concepts/a.md": pageText({ opus_pending: true }),
      "concepts/b.md": pageText(),
      "concepts/c.md": pageText(),
      "concepts/d.md": pageText({ claims: [claim("acme-sales/d/x", "Verified fact.", verified)] }),
      "concepts/e.md": pageText({ checked_by: "human" }),
      "concepts/f.md": pageText(),
    });
    const q = buildOpusQueue(snap.pages, {
      changed: new Set(["concepts/b.md", "concepts/d.md"]),
      reviewPages: new Set(["concepts/c.md", "concepts/e.md"]),
      sampleRate: 0.5,
      random: () => 0.1,
    });
    expect(q).toEqual([
      { path: "concepts/a.md", reason: "pending" },
      { path: "concepts/b.md", reason: "changed" },
      { path: "concepts/c.md", reason: "review" },
      { path: "concepts/f.md", reason: "sample" },
    ]);
  });

  it("reads Opus's answer strictly", () => {
    const m = parseOpusResponse('[{"k":0,"verdict":"edit","claims":[{"id":"a/b/c","text":"New.","why":"body says so"},{"text":"no id"}],"note":"one fix"},{"k":1,"verdict":"bogus"}]', 2);
    expect(m.get(0)).toEqual({ verdict: "edit", claims: [{ id: "a/b/c", text: "New.", why: "body says so" }], note: "one fix" });
    expect(m.has(1)).toBe(false);
  });

  async function seedOpus() {
    await vaultOperation("seed: pages", async (tx) => {
      for (const [p, t] of Object.entries(PAGES)) await tx.write(p, t);
    });
  }

  it("marks every page pending when no provider can answer, and the operation still commits", async () => {
    await seedOpus();
    const absent: OpusClient = {
      model: "claude-opus-5-5",
      complete: async () => {
        throw new OpusUnavailableError("no Anthropic provider is connected");
      },
    };
    const queue = Object.keys(PAGES).map((p) => ({ path: p, reason: "changed" as const }));
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 5, rates: DEFAULT_COST_RATES, client: absent }),
    );
    expect(op.result).toMatchObject({ reviewed: 0, pending: 3, stopped: "unavailable" });
    const page = await readPage("concepts/pricing.md");
    expect(page!.parsed.ok && page!.parsed.frontmatter.opus_pending).toBe(true);
  });

  it("reviews within the cap, raises an item for a proposed edit, and stops at the cap", async () => {
    await seedOpus();
    let calls = 0;
    const opus: OpusClient = {
      model: "claude-opus-5-5",
      async complete() {
        calls += 1;
        return {
          text: JSON.stringify([
            { k: 0, verdict: "edit", claims: [{ id: "acme-sales/pricing/blue-widget", text: "The blue widget costs 11 EUR per unit.", why: "body" }], note: "price" },
          ]),
          model: "claude-opus-5-5",
          usage: { promptTokens: 2000, completionTokens: 500, cacheHitTokens: 0 },
        };
      },
    };
    const queue = Object.keys(PAGES).map((p) => ({ path: p, reason: "sample" as const }));
    // One call's worst case fits under this cap, two do not.
    const oneCall = worstCaseUsd("claude-opus-5-5", 3000, DEFAULT_COST_RATES);
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: oneCall * 1.2, rates: DEFAULT_COST_RATES, client: opus, runId: "run-0000000000bb" }),
    );
    expect(calls).toBe(1);
    expect(op.result.reviewed).toBeGreaterThanOrEqual(1);
    expect(op.result.usdEstimate).toBeLessThanOrEqual(oneCall * 1.2);
    expect(op.result.reviewItems).toHaveLength(1);
    expect(op.result.reviewItems[0]).toMatchObject({ kind: "opus", claimId: "acme-sales/pricing/blue-widget" });
    const first = await readPage(queue[0].path);
    expect(first!.parsed.ok && first!.parsed.frontmatter.checked_by).toBe("opus");

    // Smaller than one call's worst case: nothing is sent.
    calls = 0;
    const capped = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, queue, { stateVault: vaultDir(), capUsd: 0.01, rates: DEFAULT_COST_RATES, client: opus }),
    );
    expect(calls).toBe(0);
    expect(capped.result.stopped).toBe("cap");
  });

  it("calls Anthropic with an API key only, and is unavailable without one", async () => {
    const ok = {
      content: [{ type: "text", text: "[]" }],
      usage: { input_tokens: 10, output_tokens: 2 },
      stop_reason: "end_turn",
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    const withKey = createAnthropicOpusClient("claude-opus-5-5", fetchImpl as unknown as typeof fetch, async () => "sk-ant-api03-placeholder");
    await expect(withKey.complete({ system: "s", user: "u", maxTokens: 10 })).resolves.toMatchObject({ text: "[]" });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-placeholder");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();

    fetchImpl.mockClear();
    const noKey = createAnthropicOpusClient("claude-opus-5-5", fetchImpl as unknown as typeof fetch, async () => null);
    await expect(noKey.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toBeInstanceOf(OpusUnavailableError);
    const throwing = createAnthropicOpusClient("claude-opus-5-5", fetchImpl as unknown as typeof fetch, async () => {
      throw new Error("store unreadable");
    });
    await expect(throwing.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toBeInstanceOf(OpusUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not start without a rate for the model, because the cap could not be kept", async () => {
    await seedOpus();
    const opus: OpusClient = { model: "some-unpriced-model", complete: vi.fn() };
    const op = await vaultOperation("nightly: opus check", (tx) =>
      runOpusTier(tx, [{ path: "concepts/pricing.md", reason: "sample" }], { stateVault: vaultDir(), capUsd: 100, rates: mergeCostRates({}), client: opus }),
    );
    expect(opus.complete).not.toHaveBeenCalled();
    expect(op.result).toMatchObject({ stopped: "cap", pending: 1 });
  });
});

describe("nightly schedule", () => {
  it("arms the next local HH:MM, tomorrow once today's has passed, and nothing when off", () => {
    const now = new Date(2026, 2, 10, 2, 30);
    expect(computeNextNightlyMs({ enabled: true, time: "03:00" }, now)).toBe(new Date(2026, 2, 10, 3, 0).getTime());
    expect(computeNextNightlyMs({ enabled: true, time: "02:00" }, now)).toBe(new Date(2026, 2, 11, 2, 0).getTime());
    expect(computeNextNightlyMs({ enabled: false, time: "03:00" }, now)).toBe(0);
    expect(computeNextNightlyMs({ enabled: true, time: "25:00" }, now)).toBe(0);
  });
});

describe("settings: the slice 3 sections", () => {
  it("defaults: nightly on at 03:00, Opus off with a cap, contradictions on, no domains", () => {
    const s = readSettings();
    expect(s.nightly).toEqual({ enabled: true, time: "03:00" });
    expect(s.opus).toMatchObject({ enabled: false, capUsd: 2, sampleRate: 0.02, model: "claude-opus-5-5" });
    expect(s.contradictions).toEqual({ enabled: true });
    expect(s.domains).toEqual([]);
    expect(s.ingest.folders).toEqual([]);
  });

  it("writes and resets fields, and refuses a bad one whole", () => {
    const s = writeSettings({
      nightly: { time: "04:30" },
      opus: { enabled: true, capUsd: 5 },
      domains: [{ name: "acme-sales", owner: "Sales team" }],
      ingest: { folders: ["/srv/docs", "/srv/docs/"] },
    });
    expect(s.nightly).toEqual({ enabled: true, time: "04:30" });
    expect(s.opus).toMatchObject({ enabled: true, capUsd: 5 });
    expect(s.domains).toEqual([{ name: "acme-sales", owner: "Sales team" }]);
    expect(s.ingest.folders).toEqual(["/srv/docs"]);
    for (const bad of [
      { nightly: { time: "4:30" } },
      { opus: { capUsd: 0 } },
      { opus: { capUsd: 5000 } },
      { opus: { sampleRate: 2 } },
      { domains: [{ name: "Acme Sales", owner: "x" }] },
      { domains: [{ name: "a", owner: "x" }, { name: "a", owner: "y" }] },
      { ingest: { folders: ["relative/path"] } },
    ]) {
      expect(() => writeSettings(bad as never)).toThrow(SettingsError);
    }
    expect(readSettings().nightly.time).toBe("04:30");
    expect(writeSettings({ opus: null }).opus.enabled).toBe(false);
    expect(writeSettings({ nightly: { time: null } }).nightly.time).toBe("03:00");
  });

  it("refuses unknown sections and keys in a patch", () => {
    expect(() => readSettingsPatch({ schedule: "x" })).toThrow(SettingsError);
    expect(() => readSettingsPatch({ opus: { budget: 1 } })).toThrow(SettingsError);
    expect(() => readSettingsPatch([])).toThrow(SettingsError);
    expect(readSettingsPatch({ opus: { enabled: true } })).toEqual({ opus: { enabled: true } });
  });
});
