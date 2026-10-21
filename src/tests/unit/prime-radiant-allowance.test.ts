/**
 * Prime Radiant on the ClawBox AI allowance: its model calls go through the
 * box's ClawBox AI sign-in, so they are counted against the plan's rolling
 * allowance like a chat turn. A spent allowance is therefore a refusal every
 * pass stops on after one call (never a busy proxy to retry), leaving what it
 * did not reach queued rather than dead-lettered, and the Usage view meters
 * what Prime Radiant took from the week. The Flash client's own reading of
 * the 429 is proved in prime-radiant-flash-client.test.ts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => "claw_" + "test-token"),
  clawaiCredentialGeneration: vi.fn(() => 1),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);
const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/route-auth", () => auth);
const portal = vi.hoisted(() => ({ fetchClawaiUsage: vi.fn() }));
vi.mock("@/lib/clawai-usage-portal", () => portal);

import { GET as costsGET } from "@/app/setup-api/prime-radiant/costs/route";
import { normalizeClawaiUsage } from "@/lib/clawai-usage";
import {
  ALLOWANCE_WINDOW_DAYS,
  allowanceAccountFrom,
  readAllowanceMeter,
} from "@/lib/prime-radiant/allowance-meter";
import { createClawboxAiFlashClient, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { getIngestJob, ingestFinished, listIngestJobs, NothingToRetryError, startIngest, stopIngest } from "@/lib/prime-radiant/ingest";
import { readDeadLetter, readFiles, readJob, recordCost } from "@/lib/prime-radiant/ingest-store";
import { ensureVault } from "@/lib/prime-radiant/vault";
import { readWriterItems } from "@/lib/prime-radiant/writer";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const RESET = "2026-10-23T14:05:00.000Z";

/** The proxy's 429 when an allowance is spent, as the website writes it. */
function allowanceRefusal(code: string, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { message, type: "usage_limit", code, resetAt: RESET } }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
}

const WEEKLY = () => allowanceRefusal("weekly_limit_exceeded", "Weekly token allowance used up. Enough frees up in 2d 5h.", { "retry-after": "30" });
const BURST = () => allowanceRefusal("burst_limit_exceeded", "Short-term burst limit reached.");

const noSleep = { sleep: async () => undefined };

function clientAnswering(answer: () => Response) {
  const fetchImpl = vi.fn(async () => answer());
  return { client: createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

/** A writer that makes one page per document: the run after the allowance freed up. */
function writingClient(): FlashClient {
  return {
    model: "deepseek-v4-flash",
    async complete(request) {
      const items = readWriterItems(request.user) ?? [];
      const cards = items.map((it) => ({
        i: it.i,
        useful: true,
        type: "concept",
        title: `Acme ${path.basename(it.path).replace(/\.\w+$/, "")}`,
        domain: "acme-sales",
        summary: "A synthetic Acme document.",
        facts: [{ fact: it.text.trim().slice(0, 200), confidence: 0.7 }],
        sensitivity: "internal",
        confidence: 0.7,
      }));
      return { text: JSON.stringify(cards), model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 50, cacheHitTokens: 0 } };
    },
  };
}

// ── over a real vault ─────────────────────────────────────────────────────

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-allowance-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let root = "";
let docs = "";
let vault = "";

beforeEach(() => {
  root = path.join(base, `case-${++n}`);
  docs = path.join(root, "docs");
  fs.mkdirSync(docs, { recursive: true });
  process.env.PRIME_RADIANT_DIR = path.join(root, "prime-radiant");
  vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");
  portal.fetchClawaiUsage.mockReset();
  creds.resolveClawaiToken.mockReset().mockResolvedValue("claw_" + "test-token");
});

afterEach(async () => {
  for (const j of listIngestJobs(vault)) {
    stopIngest(j.id);
    await ingestFinished(j.id);
  }
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("an import meeting a spent allowance", () => {
  it("stops at the one refused call, says when it frees up, and leaves every document queued — never a dead letter", async () => {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(docs, `f${i}.md`), `Doc ${i} about Acme.`);
    const { client, fetchImpl } = clientAnswering(WEEKLY);
    const started = await startIngest({ kind: "folders", folders: [docs] }, { vault, client, retry: noSleep, batchSize: 1, parallel: 1 });
    await ingestFinished(started.id);
    const job = getIngestJob(started.id, vault)!;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({ status: "interrupted", done: 0, failed: 0, deadLetter: 0, queued: 6, allowance: { kind: "weekly", resetAt: RESET } });
    expect(job.error).toMatch(/^ClawBox AI allowance spent, frees up at .+\. The documents not written yet wait for the next run of these folders, or Retry, once it frees up\.$/);
    expect(job.notes.join(" ")).toMatch(/6 document\(s\) wait for the ClawBox AI allowance/);
    expect(readFiles(vault, job.id).map((f) => [f.status, f.error])).toEqual(new Array(6).fill(["pending", "allowance_spent"]));
    expect(readDeadLetter(vault, job.id)).toEqual([]);
    // From the database too, once the job is no longer held in memory.
    expect(readJob(vault, job.id)).toMatchObject({ status: "interrupted", queued: 6, deadLetter: 0, failed: 0 });

    // Once it frees up, the next run of the same folders writes them all.
    const next = await startIngest({ kind: "folders", folders: [docs] }, { vault, client: writingClient(), retry: noSleep, batchSize: 3, parallel: 1 });
    await ingestFinished(next.id);
    expect(getIngestJob(next.id, vault)).toMatchObject({ status: "done", done: 6, failed: 0, queued: 0 });
  });

  it("stops on a spent burst ceiling the same way; Retry takes the queue over, once", async () => {
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(docs, `b${i}.md`), `Burst doc ${i} about Acme.`);
    const { client, fetchImpl } = clientAnswering(BURST);
    const started = await startIngest({ kind: "folders", folders: [docs] }, { vault, client, retry: noSleep, batchSize: 2, parallel: 1 });
    await ingestFinished(started.id);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getIngestJob(started.id, vault)).toMatchObject({ status: "interrupted", failed: 0, queued: 4, allowance: { kind: "burst" } });

    const retried = await startIngest({ kind: "retry", retryOf: started.id }, { vault, client: writingClient(), retry: noSleep, parallel: 1 });
    await ingestFinished(retried.id);
    expect(getIngestJob(retried.id, vault)).toMatchObject({ kind: "retry", total: 4, done: 4, failed: 0, deadLetter: 0, queued: 0 });
    expect(readJob(vault, started.id)).toMatchObject({ queued: 0, deadLetter: 0 });
    await expect(startIngest({ kind: "retry", retryOf: started.id }, { vault, client: writingClient() })).rejects.toBeInstanceOf(NothingToRetryError);
  });

  it("keeps a dropped batch's queued files past the drop, so Retry can still read them", async () => {
    const drop = path.join(root, "drop");
    fs.mkdirSync(drop, { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(drop, `d${i}.md`), `Dropped doc ${i} about Acme.`);
    const { client, fetchImpl } = clientAnswering(WEEKLY);
    const started = await startIngest({ kind: "upload", dir: drop, batch: "b-0001" }, { vault, client, retry: noSleep, batchSize: 3, parallel: 1 });
    await ingestFinished(started.id);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(drop)).toBe(false);
    expect(getIngestJob(started.id, vault)).toMatchObject({ status: "interrupted", failed: 0, queued: 3 });

    const retried = await startIngest({ kind: "retry", retryOf: started.id }, { vault, client: writingClient(), retry: noSleep, parallel: 1 });
    await ingestFinished(retried.id);
    expect(getIngestJob(retried.id, vault)).toMatchObject({ done: 3, failed: 0 });
  });
});

describe("the allowance meter", () => {
  const NOW = new Date("2026-10-21T12:00:00.000Z");
  const daysAgo = (d: number, from = NOW) => new Date(from.getTime() - d * 86_400_000).toISOString();

  async function seedCosts(now = NOW) {
    const ago = (d: number) => daysAgo(d, now);
    await ensureVault();
    const row = { model: "deepseek-v4-flash", usdEstimate: 0.01 };
    recordCost(vault, { ...row, runId: "ing-0000000000aa", operation: "ingest.write", tokensIn: 1000, tokensOut: 100, at: ago(1) });
    recordCost(vault, { ...row, runId: "run-0000000000bb", operation: "contradiction-judge", tokensIn: 200, tokensOut: 20, at: ago(6.9) });
    // Older than the rolling week: it has aged out of the allowance.
    recordCost(vault, { ...row, runId: "run-0000000000cc", operation: "golden", tokensIn: 5000, tokensOut: 500, at: ago(7.1) });
    // The Opus tier answers from the owner's own Anthropic key or subscription: never the ClawBox AI allowance.
    recordCost(vault, { runId: "run-0000000000bb", operation: "opus-review", model: "claude-opus-5-5", tokensIn: 9000, tokensOut: 900, usdEstimate: 0, at: ago(1), basis: "subscription" });
  }

  it("counts the ClawBox AI calls of the rolling week, never the Opus tier's, never older ones", async () => {
    await seedCosts();
    const meter = await readAllowanceMeter(vault, { now: () => NOW, account: null });
    expect(ALLOWANCE_WINDOW_DAYS).toBe(7);
    expect(meter).toEqual({
      countedAgainst: "clawbox-ai",
      windowDays: 7,
      since: daysAgo(7),
      primeRadiant: { calls: 2, tokensIn: 1200, tokensOut: 120, usdEstimate: 0.02 },
      account: null,
    });
  });

  it("is zero, creating nothing, before any call", async () => {
    const meter = await readAllowanceMeter(vault, { now: () => NOW, account: null });
    expect(meter.primeRadiant).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, usdEstimate: 0 });
    expect(fs.existsSync(path.join(path.dirname(vault), "prime-radiant.sqlite"))).toBe(false);
  });

  it("reads the account's weekly pool and burst ceiling from the portal's answer, and says why when it cannot", () => {
    const usage = normalizeClawaiUsage({
      tier: "max",
      weekly: { used: 7_000_000, limit: 10_000_000, resetAt: RESET },
      burst: { used: 10, limit: 10, isOverLimit: true, resetAt: "2026-10-21T15:00:00.000Z" },
    })!;
    expect(allowanceAccountFrom({ available: true, usage }, "Europe/Sofia")).toEqual({
      available: true,
      plan: "max",
      timeZone: "Europe/Sofia",
      weekly: { used: 7_000_000, limit: 10_000_000, percentUsed: 70, isOverLimit: false, resetAt: RESET },
      burst: { used: 10, limit: 10, percentUsed: 100, isOverLimit: true, resetAt: "2026-10-21T15:00:00.000Z" },
    });
    const legacy = normalizeClawaiUsage({ tier: "pro", percentUsed: 40, isOverLimit: false })!;
    expect(allowanceAccountFrom({ available: true, usage: legacy }, null)).toMatchObject({
      available: true,
      plan: "pro",
      weekly: { percentUsed: 40, isOverLimit: false, resetAt: null },
      burst: null,
    });
    const unread = normalizeClawaiUsage({ tier: "max", weekly: { used: 0, limit: 0, unavailable: true } })!;
    expect(allowanceAccountFrom({ available: true, usage: unread }, null)).toEqual({ available: false, reason: "unreachable" });
    expect(allowanceAccountFrom({ available: false, reason: "refused" }, null)).toEqual({ available: false, reason: "refused" });
  });

  it("rides on the costs route only when asked for, the portal asked with the box's own sign-in", async () => {
    await seedCosts(new Date());
    portal.fetchClawaiUsage.mockResolvedValue({
      available: true,
      usage: normalizeClawaiUsage({ tier: "max", weekly: { used: 10_000_000, limit: 10_000_000, resetAt: RESET } }),
    });
    const plain = await (await costsGET(new Request("http://clawbox.local/setup-api/prime-radiant/costs"))).json();
    expect(plain.allowance).toBeUndefined();
    expect(portal.fetchClawaiUsage).not.toHaveBeenCalled();

    const asked = await (await costsGET(new Request("http://clawbox.local/setup-api/prime-radiant/costs?allowance=1"))).json();
    expect(portal.fetchClawaiUsage).toHaveBeenCalledWith("claw_" + "test-token");
    expect(asked.totals.calls).toBe(4);
    expect(asked.allowance).toMatchObject({
      countedAgainst: "clawbox-ai",
      windowDays: 7,
      account: { available: true, plan: "max", weekly: { percentUsed: 100, isOverLimit: true, resetAt: RESET } },
    });
    expect(asked.allowance.primeRadiant).toEqual({ calls: 2, tokensIn: 1200, tokensOut: 120, usdEstimate: 0.02 });

    creds.resolveClawaiToken.mockResolvedValue(null);
    portal.fetchClawaiUsage.mockClear();
    const signedOut = await (await costsGET(new Request("http://clawbox.local/setup-api/prime-radiant/costs?allowance=1"))).json();
    expect(signedOut.allowance.account).toEqual({ available: false, reason: "not_connected" });
    expect(portal.fetchClawaiUsage).not.toHaveBeenCalled();
  });
});
