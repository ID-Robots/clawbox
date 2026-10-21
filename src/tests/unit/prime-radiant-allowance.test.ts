/**
 * Prime Radiant on the ClawBox AI allowance: its model calls go through the
 * box's ClawBox AI sign-in, so they are counted against the plan's rolling
 * allowance like a chat turn. A spent allowance is therefore a refusal every
 * pass stops on (never a busy proxy to retry until the documents dead-letter),
 * and the Usage view meters what Prime Radiant took from the week.
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
import { FlashCallError, completeWithRetry, createClawboxAiFlashClient } from "@/lib/prime-radiant/flash-client";
import { getIngestJob, ingestFinished, listIngestJobs, startIngest, stopIngest } from "@/lib/prime-radiant/ingest";
import { readFiles, recordCost } from "@/lib/prime-radiant/ingest-store";
import { ensureVault } from "@/lib/prime-radiant/vault";

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
const BUSY = () => new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429, headers: { "retry-after": "30" } });

const req = { system: "sys", user: "user", maxTokens: 100 };
const noSleep = { sleep: async () => undefined };

function clientAnswering(answer: () => Response) {
  const fetchImpl = vi.fn(async () => answer());
  return { client: createClawboxAiFlashClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}

describe("the Flash client meeting a spent allowance", () => {
  it("names a spent weekly allowance as an `allowance` refusal with its frees-up instant, not a busy proxy", async () => {
    const { client } = clientAnswering(WEEKLY);
    const err = await client.complete(req).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlashCallError);
    const e = err as FlashCallError;
    expect(e).toMatchObject({ kind: "allowance", status: 429 });
    expect(e.retryable).toBe(false);
    expect(e.allowance).toEqual({ kind: "weekly", resetAt: RESET, message: "Weekly token allowance used up. Enough frees up in 2d 5h." });
    expect(e.message).toMatch(/weekly allowance is used up/i);
  });

  it("names the 5-hour burst ceiling the same way", async () => {
    const { client } = clientAnswering(BURST);
    const e = (await client.complete(req).then(() => null, (x: unknown) => x)) as FlashCallError;
    expect(e).toMatchObject({ kind: "allowance", allowance: { kind: "burst", resetAt: RESET } });
    expect(e.message).toMatch(/burst limit/i);
  });

  it("keeps a 429 that names no allowance a retryable busy proxy, Retry-After and all", async () => {
    const { client } = clientAnswering(BUSY);
    const e = (await client.complete(req).then(() => null, (x: unknown) => x)) as FlashCallError;
    expect(e).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 30_000, allowance: null });
    expect(e.retryable).toBe(true);
  });

  it("reads no more of a 429's body than a refusal needs", async () => {
    // A megabyte of something else, the allowance code past the read: still just busy.
    const huge = () => new Response("x".repeat(1_000_000) + "weekly_limit_exceeded", { status: 429 });
    const { client } = clientAnswering(huge);
    const e = (await client.complete(req).then(() => null, (x: unknown) => x)) as FlashCallError;
    expect(e.kind).toBe("rate_limited");
  });

  it("sends a spent allowance once — retries are for a busy proxy, which still gets all four", async () => {
    const spent = clientAnswering(WEEKLY);
    await expect(completeWithRetry(spent.client, req, noSleep)).rejects.toMatchObject({ kind: "allowance" });
    expect(spent.fetchImpl).toHaveBeenCalledTimes(1);

    const busy = clientAnswering(BUSY);
    await expect(completeWithRetry(busy.client, req, noSleep)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(busy.fetchImpl).toHaveBeenCalledTimes(4);
  });
});

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
  it("stops at the first refusal, says so, and leaves every document to retry once it frees up", async () => {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(docs, `f${i}.md`), `Doc ${i} about Acme.`);
    const { client, fetchImpl } = clientAnswering(WEEKLY);
    const started = await startIngest({ kind: "folders", folders: [docs] }, { vault, client, retry: noSleep, batchSize: 1, parallel: 1 });
    await ingestFinished(started.id);
    const job = getIngestJob(started.id, vault)!;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/weekly allowance is used up/i);
    expect(job.error).toMatch(/retried once it frees up/i);
    expect(job.failed).toBe(6);
    const files = readFiles(vault, job.id);
    expect(files.every((f) => f.status === "failed" && /allowance/i.test(f.error ?? ""))).toBe(true);
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
