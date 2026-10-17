/**
 * The slice 3 routes over a real vault in a tmp dir: review (list, raise,
 * resolve), history, diff, revert, settings, costs and the nightly pass. The
 * reads never create anything; the writes that change the vault or spend the
 * owner's allowance are the owner's cookie or the assistant's MCP bearer, and
 * never another site (the assistant's own writes: prime-radiant-edit.test.ts).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => null),
  clawaiCredentialGeneration: vi.fn(() => 0),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);
const bearer = vi.hoisted(() => ({ verifyMcpBearer: vi.fn((h: string | null) => h === "Bearer test-assistant-bearer") }));
vi.mock("@/lib/mcp-token", () => bearer);

import { GET as reviewGET, POST as reviewPOST } from "@/app/setup-api/prime-radiant/review/route";
import { POST as resolvePOST } from "@/app/setup-api/prime-radiant/review/[id]/resolve/route";
import { GET as historyGET } from "@/app/setup-api/prime-radiant/history/[...path]/route";
import { GET as diffGET } from "@/app/setup-api/prime-radiant/diff/route";
import { POST as revertPOST } from "@/app/setup-api/prime-radiant/revert/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/setup-api/prime-radiant/settings/route";
import { GET as costsGET } from "@/app/setup-api/prime-radiant/costs/route";
import { GET as nightlyGET } from "@/app/setup-api/prime-radiant/nightly/route";
import { POST as nightlyRunPOST } from "@/app/setup-api/prime-radiant/nightly/run/route";
import { recordCost } from "@/lib/prime-radiant/ingest-store";
import { headCommit } from "@/lib/prime-radiant/git";
import { runningNightlyId } from "@/lib/prime-radiant/nightly";
import { stop as stopScheduler } from "@/lib/prime-radiant/nightly-scheduler";
import { stateDbPath } from "@/lib/prime-radiant/paths";
import { addReviewItem } from "@/lib/prime-radiant/review-store";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { setFlashClientOverride } from "@/lib/prime-radiant/flash-client";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

/** A synthetic token shape, built so no literal credential sits in the file. */
const FAKE_TOKEN = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-review-routes-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT };
let n = 0;
let root = "";
let filesRoot = "";

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;
const EVIL = { origin: "https://evil.example.com" };

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${API}${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const pathCtx = (p: string) => ({ params: Promise.resolve({ path: p.split("/") }) });

const A = claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR.");
const B = claim("acme-sales/catalogue/blue-widget", "The blue widget costs 12 EUR.");

async function seed() {
  await vaultOperation("seed: pages", async (tx) => {
    await tx.write("concepts/pricing.md", pageText({ claims: [A] }));
    await tx.write("concepts/catalogue.md", pageText({ title: "Catalogue", claims: [B] }));
    await tx.write("index.md", "# Index\n\n- [[concepts/pricing]]\n- [[concepts/catalogue]]\n");
  });
}

beforeEach(() => {
  auth.requireSession.mockReset().mockResolvedValue(null);
  owner.hasPersonSession.mockReset().mockResolvedValue(true);
  creds.resolveClawaiToken.mockReset().mockResolvedValue(null);
  setFlashClientOverride(null);
  const caseDir = path.join(base, `case-${++n}`);
  root = path.join(caseDir, "prime-radiant");
  filesRoot = path.join(caseDir, "home");
  fs.mkdirSync(path.join(filesRoot, "Documents"), { recursive: true });
  process.env.PRIME_RADIANT_DIR = root;
  process.env.FILES_ROOT = filesRoot;
});

afterAll(() => {
  stopScheduler();
  for (const [key, value] of [["PRIME_RADIANT_DIR", prev.dir], ["FILES_ROOT", prev.files]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("auth", () => {
  it("answers whatever requireSession answers, creating nothing", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "x", code: "unauthorized" }, { status: 401 }));
    for (const res of [
      await reviewGET(req("GET", "/review")),
      await reviewPOST(req("POST", "/review", { claimId: A.id })),
      await resolvePOST(req("POST", "/review/rev-000000000000/resolve", { action: "later" }), idCtx("rev-000000000000")),
      await historyGET(req("GET", "/history/concepts/pricing.md"), pathCtx("concepts/pricing.md")),
      await diffGET(req("GET", "/diff?commit=abcdef1")),
      await revertPOST(req("POST", "/revert", { commit: "abcdef1" })),
      await settingsGET(req("GET", "/settings")),
      await settingsPUT(req("PUT", "/settings", {})),
      await costsGET(req("GET", "/costs")),
      await nightlyGET(req("GET", "/nightly")),
      await nightlyRunPOST(req("POST", "/nightly/run", {})),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(fs.existsSync(root)).toBe(false);
  });

  it("refuses a caller with neither a person's cookie nor the assistant's bearer on the writes, but lets the session raise a review item", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    for (const res of [
      await resolvePOST(req("POST", "/review/rev-000000000000/resolve", { action: "later" }), idCtx("rev-000000000000")),
      await revertPOST(req("POST", "/revert", { commit: "abcdef1" })),
      await settingsPUT(req("PUT", "/settings", { nightly: { enabled: false } })),
      await nightlyRunPOST(req("POST", "/nightly/run", {})),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    await ensureVault();
    const raised = await reviewPOST(req("POST", "/review", { claimId: A.id, note: "Price changed" }));
    expect(raised.status).toBe(201);
    expect((await raised.json()).item.evidence[0]).toMatchObject({ kind: "raised-by", source: "assistant" });
  });

  it("lets the assistant change the schedule and the Opus cap, never what the cap is measured in", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const asAssistant = { authorization: "Bearer test-assistant-bearer" };
    for (const body of [
      { costRates: { "claude-opus-5-5": { input: 0, output: 0 } } },
      { opus: { enabled: true, model: "some-unpriced-model" } },
    ]) {
      const res = await settingsPUT(req("PUT", "/settings", body, asAssistant));
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    const ok = await settingsPUT(req("PUT", "/settings", { nightly: { time: "04:30" }, opus: { enabled: true, capUsd: 5 } }, asAssistant));
    expect(ok.status).toBe(200);
    expect((await ok.json()).settings).toMatchObject({ nightly: { time: "04:30" }, opus: { enabled: true, capUsd: 5 } });
    owner.hasPersonSession.mockResolvedValue(true);
    const owners = await settingsPUT(req("PUT", "/settings", { opus: { model: "claude-opus-5-5" } }));
    expect(owners.status).toBe(200);
  });

  it("refuses a cross-site page on every write", async () => {
    for (const res of [
      await reviewPOST(req("POST", "/review", { claimId: A.id }, EVIL)),
      await resolvePOST(req("POST", "/review/rev-000000000000/resolve", { action: "later" }, EVIL), idCtx("rev-000000000000")),
      await revertPOST(req("POST", "/revert", { commit: "abcdef1" }, EVIL)),
      await settingsPUT(req("PUT", "/settings", {}, EVIL)),
      await nightlyRunPOST(req("POST", "/nightly/run", {}, EVIL)),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_origin");
    }
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("fresh box", () => {
  it("every read answers empty and creates nothing", async () => {
    expect(await (await reviewGET(req("GET", "/review"))).json()).toEqual({ total: 0, counts: { open: 0, resolved: 0, later: 0 }, items: [] });
    expect((await historyGET(req("GET", "/history/concepts/pricing.md"), pathCtx("concepts/pricing.md"))).status).toBe(404);
    expect((await diffGET(req("GET", "/diff?commit=abcdef1"))).status).toBe(404);
    const costs = await (await costsGET(req("GET", "/costs"))).json();
    expect(costs).toMatchObject({ basis: "estimate", totals: { calls: 0, usdEstimate: 0 }, notMeasured: [{ operation: "embedding", reason: "no_usage_reported" }] });
    expect(await (await nightlyGET(req("GET", "/nightly"))).json()).toMatchObject({ running: null, runs: [] });
    const settings = await (await settingsGET(req("GET", "/settings"))).json();
    expect(settings.settings.nightly).toEqual({ enabled: true, time: "03:00" });
    expect(settings.settings.ingest).toHaveProperty("exclude");
    expect(fs.existsSync(root)).toBe(false);
  });

  it("refuses a raise, a revert and a nightly pass before the vault exists", async () => {
    expect((await reviewPOST(req("POST", "/review", { claimId: A.id }))).status).toBe(412);
    expect((await revertPOST(req("POST", "/revert", { commit: "abcdef1" }))).status).toBe(404);
    const run = await nightlyRunPOST(req("POST", "/nightly/run", {}));
    expect(run.status).toBe(412);
    expect((await run.json()).code).toBe("not_initialised");
    expect(fs.existsSync(stateDbPath())).toBe(false);
  });
});

describe("review", () => {
  it("lists, validates and resolves: pick verifies and retires in one commit", async () => {
    await seed();
    const { item } = addReviewItem(root + "/vault", {
      kind: "contradiction",
      claimId: A.id,
      pages: ["concepts/pricing.md", "concepts/catalogue.md"],
      candidates: [
        { text: A.text, page: "concepts/pricing.md", claimId: A.id, evidence: [] },
        { text: B.text, page: "concepts/catalogue.md", claimId: B.id, evidence: [] },
      ],
    });
    const list = await (await reviewGET(req("GET", "/review?status=open&kind=contradiction"))).json();
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    for (const q of ["?status=nope", "?kind=nope", "?claimId=Not%20An%20Id"]) expect((await reviewGET(req("GET", `/review${q}`))).status).toBe(400);

    expect((await resolvePOST(req("POST", "/x", { action: "pick", candidate: 1 }), idCtx("../etc"))).status).toBe(404);
    expect((await resolvePOST(req("POST", "/x", { action: "pick" }), idCtx(item.id))).status).toBe(400);
    expect((await resolvePOST(req("POST", "/x", { action: "pick", candidate: 7 }), idCtx(item.id))).status).toBe(400);

    const res = await resolvePOST(req("POST", "/x", { action: "pick", candidate: 0 }), idCtx(item.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ retired: [B.id], item: { status: "resolved" } });
    expect((await headCommit(root + "/vault"))?.subject).toBe(`verify: ${A.id}`);
    const again = await resolvePOST(req("POST", "/x", { action: "dismiss" }), idCtx(item.id));
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("already_resolved");
  });

  it("answers lint_blocked for an answer that carries a secret", async () => {
    await seed();
    const { item } = addReviewItem(root + "/vault", { kind: "contradiction", claimId: A.id, pages: ["concepts/pricing.md"] });
    const res = await resolvePOST(req("POST", "/x", { action: "new", text: `token ${FAKE_TOKEN}` }), idCtx(item.id));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("lint_blocked");
  });
});

describe("history, diff, revert", () => {
  it("serves a page's history and a commit's diff, then reverts it", async () => {
    await seed();
    await vaultOperation("edit: pricing", async (tx) => tx.write("concepts/pricing.md", pageText({ claims: [claim(A.id, "The blue widget costs 15 EUR.")] })));
    const h = await (await historyGET(req("GET", "/history/concepts/pricing.md?limit=5"), pathCtx("concepts/pricing.md"))).json();
    expect(h.commits.map((c: { subject: string }) => c.subject)).toEqual(["edit: pricing", "seed: pages"]);
    expect((await historyGET(req("GET", "/history/../../etc/passwd"), pathCtx("../../etc/passwd"))).status).toBe(404);

    const sha = h.commits[0].sha as string;
    const d = await (await diffGET(req("GET", `/diff?commit=${sha}&path=concepts/pricing.md`))).json();
    expect(d.diff).toContain("15 EUR");
    expect((await diffGET(req("GET", "/diff"))).status).toBe(400);
    expect((await diffGET(req("GET", "/diff?commit=HEAD~1"))).status).toBe(400);

    expect((await revertPOST(req("POST", "/revert", {}))).status).toBe(400);
    const r = await revertPOST(req("POST", "/revert", { commit: sha, path: "concepts/pricing.md" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ reverted: sha, changed: ["concepts/pricing.md"] });
    const conflict = await revertPOST(req("POST", "/revert", { commit: sha }));
    expect(conflict.status).toBe(409);
  });
});

describe("settings", () => {
  it("exposes every section, saves a patch, validates folders and refuses a bad field whole", async () => {
    const get = await (await settingsGET(req("GET", "/settings"))).json();
    expect(Object.keys(get.settings).sort()).toEqual(["contradictions", "costRates", "domains", "golden", "ingest", "nightly", "opus", "search", "structure", "verification"]);
    expect(get.limits.opusCapUsd).toEqual({ min: 0.01, max: 1000 });
    expect(get.limits.searchIndexLimitMb).toEqual({ min: 32, max: 4096 });
    expect(get.defaults.search).toEqual({ indexLimitMb: 160 });
    // The golden check, the daily questions and the structure pass answer their limits and defaults side by side.
    expect(get.limits).toMatchObject({
      goldenMaxQuestions: { min: 1, max: 500 },
      dailyPerOwner: { min: 1, max: 20 },
      structureEnrichTop: { min: 0, max: 200 },
      structureModelFallback: { min: 0, max: 500 },
    });
    expect(get.defaults.golden).toEqual({ enabled: true, maxQuestions: 50 });
    expect(get.defaults.verification).toEqual({ perOwner: 5, outbound: false, languages: [] });
    expect(get.defaults.structure).toMatchObject({ enabled: true, enrichTop: 25, modelFallback: 25 });
    expect(get.rates.basis).toBe("estimate");

    const saved = await settingsPUT(req("PUT", "/settings", { nightly: { time: "02:15" }, opus: { enabled: true, capUsd: 3 }, ingest: { folders: ["Documents"], parallel: 32 } }));
    expect(saved.status).toBe(200);
    const s = (await saved.json()).settings;
    expect(s.nightly.time).toBe("02:15");
    expect(s.opus).toMatchObject({ enabled: true, capUsd: 3 });
    expect(s.ingest).toMatchObject({ parallel: 32, folders: [fs.realpathSync(path.join(filesRoot, "Documents"))] });

    const missing = await settingsPUT(req("PUT", "/settings", { ingest: { folders: ["Documents", "nope"] } }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "folder_not_found", index: 1 });
    for (const bad of [{ nightly: { time: "9pm" } }, { opus: { capUsd: -1 } }, { unknown: 1 }, { opus: { budget: 1 } }]) {
      const res = await settingsPUT(req("PUT", "/settings", bad));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
    expect((await (await settingsGET(req("GET", "/settings"))).json()).settings.nightly.time).toBe("02:15");
  });
});

describe("costs and the nightly pass", () => {
  it("summarises costs by operation, model and run", async () => {
    await ensureVault();
    const vault = root + "/vault";
    const at = new Date().toISOString();
    recordCost(vault, { runId: "ing-0000000000aa", operation: "ingest.write", model: "deepseek-v4-flash", tokensIn: 1000, tokensOut: 100, usdEstimate: 0.5, at });
    recordCost(vault, { runId: "run-0000000000bb", operation: "contradiction-judge", model: "deepseek-v4-flash", tokensIn: 10, tokensOut: 1, usdEstimate: 0.25, at });
    const c = await (await costsGET(req("GET", "/costs"))).json();
    expect(c.totals).toEqual({ calls: 2, tokensIn: 1010, tokensOut: 101, usdEstimate: 0.75 });
    expect(c.byRun.map((r: { kind: string }) => r.kind).sort()).toEqual(["ingest", "nightly"]);
    const one = await (await costsGET(req("GET", "/costs?runId=run-0000000000bb"))).json();
    expect(one.totals.calls).toBe(1);
    expect((await costsGET(req("GET", "/costs?runId=bogus"))).status).toBe(400);
    expect((await costsGET(req("GET", "/costs?since=yesterday"))).status).toBe(400);
  });

  it("starts a pass (202), refuses a second (409) and records it", async () => {
    await ensureVault();
    const res = await nightlyRunPOST(req("POST", "/nightly/run", {}));
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run).toMatchObject({ status: "running", trigger: "manual" });
    const busy = await nightlyRunPOST(req("POST", "/nightly/run", {}));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "busy", runningId: run.id });
    while (runningNightlyId()) await new Promise((r) => setTimeout(r, 25));
    const status = await (await nightlyGET(req("GET", "/nightly"))).json();
    expect(status.runs[0]).toMatchObject({ id: run.id, status: "nothing" });
    const merge = await nightlyRunPOST(req("POST", "/nightly/run", { merge: "dream/2026-01-01" }));
    expect(merge.status).toBe(404);
  });
});
