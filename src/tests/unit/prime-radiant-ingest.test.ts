/**
 * Ingest jobs over a real vault (git) in a tmp dir, with the model replaced:
 * pages and claims committed one commit per batch, redaction before the call,
 * hash-first dedupe across and within jobs, per-item and per-batch failures,
 * retries, a refused credential stopping the job, the parallel cap, costs,
 * events, uploads, one job at a time, and restart settlement.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashCallError, type FlashClient, type FlashRequest } from "@/lib/prime-radiant/flash-client";
import {
  DEFAULT_PARALLEL,
  IngestBusyError,
  NothingToRetryError,
  UnknownJobError,
  getIngestJob,
  ingestFinished,
  listIngestJobs,
  safeJobId,
  startIngest,
  stopIngest,
  subscribeIngest,
  type IngestDeps,
  type IngestEvent,
} from "@/lib/prime-radiant/ingest";
import { insertFiles, insertJob, readCosts, readDeadLetter, readFiles, type IngestJob } from "@/lib/prime-radiant/ingest-store";
import { deadLetterRoot } from "@/lib/prime-radiant/ingest-dead-letter";
import { emptySkipCounts } from "@/lib/prime-radiant/ingest-exclude";
import { writeSettings } from "@/lib/prime-radiant/settings";
import { readPage, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { withStateDb } from "@/lib/prime-radiant/state-db";
import { readWriterItems, type WriterItem } from "@/lib/prime-radiant/writer";
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import { claim, frontmatter } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-ingest-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let root: string;
let docs: string;
let vault: string;

const FAKE_CARD = "4111 1111 1111 1111";

function write(rel: string, text: string) {
  const abs = path.join(docs, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

type Answer = (items: WriterItem[], call: number) => unknown[] | string | FlashCallError;

/** A model that answers a card per item unless told otherwise. */
function fakeClient(answer: Answer = (items) => items.map(cardFor), delayMs = 0) {
  const prompts: FlashRequest[] = [];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const client: FlashClient = {
    model: "deepseek-v4-flash",
    async complete(request) {
      prompts.push(request);
      const call = ++calls;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const items = readWriterItems(request.user) ?? [];
        const out = answer(items, call);
        if (out instanceof FlashCallError) throw out;
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return { text, model: "deepseek-v4-flash", usage: { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 0 } };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { client, prompts, get calls() { return calls; }, get maxInFlight() { return maxInFlight; } };
}

function cardFor(item: WriterItem) {
  const name = path.basename(item.path).replace(/\.\w+$/, "");
  return {
    i: item.i,
    useful: true,
    type: "concept",
    title: `Acme ${name}`,
    domain: "sales",
    summary: `Notes about Acme ${name}.`,
    details: "",
    facts: [{ fact: `Acme ${name} is a synthetic document.`, quote: "synthetic", confidence: 0.7 }],
    sensitivity: "internal",
    confidence: 0.7,
  };
}

const noSleep = { sleep: async () => undefined };

function deps(extra: Partial<IngestDeps> = {}): IngestDeps {
  return { vault, retry: noSleep, extractor: async (_in, out) => (fs.writeFileSync(out, "Extracted PDF text about Acme invoices."), true), ...extra };
}

async function run(input: Parameters<typeof startIngest>[0], d: IngestDeps) {
  const job = await startIngest(input, d);
  await ingestFinished(job.id);
  return getIngestJob(job.id, vault)!;
}

function commitsOf(v: string): string[] {
  return execFileSync("git", ["-C", v, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
}

beforeEach(() => {
  root = path.join(base, `case-${++n}`);
  docs = path.join(root, "docs");
  fs.mkdirSync(docs, { recursive: true });
  process.env.PRIME_RADIANT_DIR = path.join(root, "prime-radiant");
  vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");
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

describe("an ingest job", () => {
  it("turns documents into pages with claims, one commit per batch, costs recorded", async () => {
    write("catalogue.md", "# Catalogue\n\nAcme Widgets Ltd sells blue widgets.");
    write("support.txt", "Support answers on weekdays.");
    write("invoices.pdf", "%PDF-1.4 fake");
    const fake = fakeClient();
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client, batchSize: 2 }));
    expect(job).toMatchObject({ status: "done", phase: "done", total: 3, done: 3, failed: 0, pages: 3, commits: 2, calls: 2 });
    expect(job.usdEstimate).toBeGreaterThan(0);
    expect(fake.calls).toBe(2);

    const snap = await readVaultSnapshot(vault);
    expect(snap.pages.map((p) => p.path).sort()).toEqual(["concepts/acme-catalogue.md", "concepts/acme-invoices.md", "concepts/acme-support.md"]);
    for (const p of snap.pages) {
      expect(p.parsed.ok).toBe(true);
      if (!p.parsed.ok) continue;
      expect(p.parsed.frontmatter.claims[0].id).toMatch(/^sales\/acme-[a-z]+\/acme-[a-z]+-is-a-synthetic-document$/);
      expect(p.parsed.frontmatter.sources[0]).toMatch(/\/docs\/(catalogue\.md|support\.txt|invoices\.pdf)$/);
      expect(snap.indexBody).toContain(`[[${p.path.replace(/\.md$/, "")}]]`);
    }
    const commits = commitsOf(vault);
    expect(commits.filter((c) => c.startsWith("ingest:"))).toHaveLength(2);
    expect(commits.at(-1)).toBe("init: vault");

    const costs = readCosts(vault, job.id);
    expect(costs).toHaveLength(2);
    expect(costs[0]).toMatchObject({ operation: "ingest.write", model: "deepseek-v4-flash", tokensIn: 1000, tokensOut: 100 });
    const files = readFiles(vault, job.id);
    expect(files.every((f) => f.status === "done" && f.sha256 && f.pages.length === 1)).toBe(true);
    const ledger = withStateDb(vault, (db) => db.prepare("SELECT COUNT(*) AS n FROM claim_registry WHERE state = 'active'").get()) as { n: number };
    expect(ledger.n).toBe(3);
  });

  it("redacts text and the path label before the model sees them", async () => {
    write("payments/orders@example.com/receipt.md", `Paid with card ${FAKE_CARD} on Monday.`);
    const fake = fakeClient();
    await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    const sent = fake.prompts.map((p) => p.user).join("\n");
    expect(sent).not.toContain(FAKE_CARD);
    expect(sent).not.toContain("orders@example.com");
    expect(sent).toContain("[REDACTED:CARD]");
    expect(sent).toContain("[REDACTED:EMAIL]");
  });

  it("skips documents already ingested (hash first) and duplicates inside one job", async () => {
    write("a.md", "Acme Widgets Ltd sells blue widgets.");
    write("copy-of-a.md", "Acme Widgets Ltd sells blue widgets.");
    const fake = fakeClient();
    const first = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(first).toMatchObject({ done: 1, duplicates: 1, pages: 1 });
    const again = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(again).toMatchObject({ total: 2, done: 0, duplicates: 2, calls: 0, commits: 0 });
    expect(fake.calls).toBe(1);
  });

  it("updates a changed document's page in place instead of making a second one", async () => {
    write("a.md", "First version about Acme.");
    const fake = fakeClient();
    await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    write("a.md", "Second version about Acme.");
    const second = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(second).toMatchObject({ done: 1, pages: 1 });
    expect((await readVaultSnapshot(vault)).pages).toHaveLength(1);
  });

  it("never overwrites a verified page", async () => {
    const abs = write("a.md", "Acme pricing notes.");
    const label = abs.replace(os.homedir(), "~");
    await vaultOperation("seed: verified", async (tx) => {
      await tx.write(
        "concepts/acme-a.md",
        serializePage(frontmatter({ title: "Acme a", sources: [label], verified: { at: "2026-01-01T00:00:00Z", by: "owner" }, claims: [claim("sales/acme-a/fact")] }), "Verified body.\n"),
      );
    }, { vault });
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    expect(job).toMatchObject({ done: 0, skipped: 1, pages: 0 });
    expect((await readPage("concepts/acme-a.md", vault))?.text).toContain("Verified body.");
    expect(readFiles(vault, job.id)[0]).toMatchObject({ status: "skipped", error: "its page is verified" });
  });

  it("gives two facts that slug alike on one page distinct claim ids instead of a lint refusal", async () => {
    write("twin.md", "Doc twin.");
    const fake = fakeClient((items) =>
      items.map((it) => ({ ...cardFor(it), facts: [{ fact: "Same fact.", quote: "x", confidence: 0.7 }, { fact: "Same fact!", quote: "x", confidence: 0.6 }] })),
    );
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(job).toMatchObject({ done: 1, failed: 0, pages: 1, commits: 1 });
    const page = (await readVaultSnapshot(vault)).pages[0];
    expect(page.parsed.ok).toBe(true);
    if (page.parsed.ok) {
      const ids = page.parsed.frontmatter.claims.map((c) => c.id);
      expect(new Set(ids).size).toBe(2);
    }
  });

  it("fails only the item the model dropped or garbled, and skips what it called useless", async () => {
    write("a.md", "Doc a.");
    write("b.md", "Doc b.");
    write("c.md", "Doc c.");
    const fake = fakeClient((items, call) =>
      call === 1 ? [cardFor(items[0]), { i: items[1].i, useful: false }, { i: items[2].i, title: "" }] : items.map((it) => ({ i: it.i, title: "" })),
    );
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(job).toMatchObject({ done: 1, skipped: 1, failed: 1, pages: 1, commits: 1, status: "done", requeued: 1, deadLetter: 1 });
    expect(fake.calls).toBe(2);
    expect(fake.prompts[1].user).toContain("c.md");
    expect(fake.prompts[1].user).not.toContain("a.md");
    expect(readFiles(vault, job.id).map((f) => [f.status, f.attempts])).toEqual([["done", 1], ["skipped", 1], ["failed", 2]]);
  });

  it("asks once more for an unreadable answer, then fails the batch", async () => {
    write("a.md", "Doc a.");
    const garbled = fakeClient(() => "I am sorry, I cannot do that.");
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: garbled.client }));
    // Two calls in the first round, two more in the retry queue's round.
    expect(garbled.calls).toBe(4);
    expect(job).toMatchObject({ failed: 1, done: 0, calls: 4, status: "done", requeued: 1, deadLetter: 1 });
    expect(readCosts(vault, job.id)).toHaveLength(4);

    write("b.md", "Doc b.");
    const second = fakeClient((items, call) => (call === 1 ? "nope" : items.map(cardFor)));
    const ok = await run({ kind: "folders", folders: [docs] }, deps({ client: second.client }));
    expect(ok).toMatchObject({ done: 2, pages: 2 });
  });

  it("retries a busy proxy and fails the batch after the attempts", async () => {
    write("a.md", "Doc a.");
    const flaky = fakeClient((items, call) => (call < 3 ? new FlashCallError("rate_limited", "busy", 429) : items.map(cardFor)));
    expect(await run({ kind: "folders", folders: [docs] }, deps({ client: flaky.client }))).toMatchObject({ done: 1 });
    expect(flaky.calls).toBe(3);

    write("b.md", "Doc b.");
    const down = fakeClient(() => new FlashCallError("server", "down", 503));
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: down.client, retry: { ...noSleep, attempts: 2 } }));
    expect(job).toMatchObject({ status: "done", failed: 1, done: 0, calls: 0 });
    expect(readFiles(vault, job.id).find((f) => f.status === "failed")?.error).toBe("model call failed (server)");
  });

  it("stops the whole job on a refused credential and says why", async () => {
    for (let i = 0; i < 6; i++) write(`f${i}.md`, `Doc ${i}.`);
    const refused = fakeClient(() => new FlashCallError("auth", "refused", 401));
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: refused.client, batchSize: 1, parallel: 1 }));
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/refused this box's sign-in/);
    expect(job.failed).toBe(6);
    expect(refused.calls).toBe(1);
    const files = readFiles(vault, job.id);
    expect(files.every((f) => f.status === "failed")).toBe(true);
  });

  it("keeps at most `parallel` calls in flight", async () => {
    for (let i = 0; i < 9; i++) write(`f${i}.md`, `Document number ${i}.`);
    const slow = fakeClient(undefined, 30);
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: slow.client, batchSize: 1, parallel: 3 }));
    expect(job).toMatchObject({ done: 9, commits: 9 });
    expect(slow.maxInFlight).toBe(3);
  });

  it("splits a batch at the character budget", async () => {
    write("a.md", "x".repeat(500));
    write("b.md", "y".repeat(500));
    const fake = fakeClient();
    await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client, maxBatchChars: 600 }));
    expect(fake.calls).toBe(2);
  });

  it("marks a document that could not be extracted and one with no text", async () => {
    write("broken.pdf", "%PDF");
    write("empty.md", "   \n\n");
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client, extractor: async () => false }));
    expect(job).toMatchObject({ failed: 1, skipped: 1, calls: 0 });
    expect(readFiles(vault, job.id).map((f) => f.error).sort()).toEqual(["empty", "extract-failed"]);
  });

  it("streams file and job events to a subscriber until the end", async () => {
    write("a.md", "Doc a.");
    write("b.md", "Doc b.");
    const fake = fakeClient(undefined, 20);
    const job = await startIngest({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    const events: IngestEvent[] = [];
    const off = subscribeIngest(job.id, (e) => events.push(e));
    expect(off).not.toBeNull();
    await ingestFinished(job.id);
    off?.();
    const files = events.filter((e) => e.type === "file");
    expect(files.map((e) => e.type === "file" && e.status)).toEqual(["done", "done"]);
    const last = events.at(-1);
    expect(last?.type === "job" && last.job.status).toBe("done");
    expect(subscribeIngest("ing-000000000000", () => undefined)).toBeNull();
  });

  it("runs one job at a time", async () => {
    write("a.md", "Doc a.");
    const slow = fakeClient(undefined, 100);
    const first = await startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client }));
    await expect(startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client }))).rejects.toBeInstanceOf(IngestBusyError);
    await ingestFinished(first.id);
  });

  it("refuses a second start that arrives while the first is still starting", async () => {
    write("a.md", "Doc a.");
    await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    write("b.md", "Doc b.");
    // Kept copies to look through make the start's own housekeeping take a while.
    for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(deadLetterRoot(), `ing-${String(i).padStart(12, "0")}`), { recursive: true });
    const slow = fakeClient(undefined, 50);
    const starts = await Promise.allSettled([
      startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client })),
      startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client })),
    ]);
    const started = starts.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const refused = starts.flatMap((s) => (s.status === "rejected" ? [s.reason] : []));
    expect(started).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(IngestBusyError);
    // An orphan sweep while it starts must not settle the job that is running.
    expect(getIngestJob(started[0].id, vault)?.status).toBe("running");
    await ingestFinished(started[0].id);
    expect(getIngestJob(started[0].id, vault)?.status).toBe("done");
  });

  // The live test: one call writing two documents left a claim on the first one's page with the second one's evidence.
  it("writes two documents of one call as two pages, each with only its own document's claims", async () => {
    write("pricing.md", "The blue widget costs 10 EUR per unit.");
    write("shipping.md", "Orders ship within three working days.");
    const fake = fakeClient((items) =>
      items.map((it) => ({
        ...cardFor(it),
        // Every card also states the other document's fact, quoting it.
        facts: items.map((other) => ({ fact: other.text.trim(), quote: other.text.trim().replace(/\.$/, ""), confidence: 0.8 })),
      })),
    );
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client, batchSize: 2 }));
    expect(job).toMatchObject({ done: 2, pages: 2 });
    expect(fake.calls).toBe(1);
    const pages = (await readVaultSnapshot(vault)).pages.flatMap((p) => (p.parsed.ok ? [p.parsed.frontmatter] : []));
    expect(pages).toHaveLength(2);
    for (const fm of pages) {
      expect(fm.sources).toHaveLength(1);
      expect(fm.claims).toHaveLength(1);
      // Evidence is the file the claim came from: the page's own document.
      for (const c of fm.claims) expect(c.evidence.map((e) => e.path)).toEqual(fm.sources);
    }
    const textOf = (source: RegExp) => pages.find((fm) => source.test(fm.sources[0]))!.claims.map((c) => c.text);
    expect(textOf(/pricing\.md$/)).toEqual(["The blue widget costs 10 EUR per unit."]);
    expect(textOf(/shipping\.md$/)).toEqual(["Orders ship within three working days."]);
  });

  it("keeps two dropped files of the same name apart", async () => {
    const fake = fakeClient((items) => items.map((it) => ({ ...cardFor(it), title: `Acme notes ${fake.calls}` })));
    for (const [batch, text] of [["0123456789abcdef", "Acme notes, spring."], ["fedcba9876543210", "Acme notes, autumn."]] as const) {
      const staged = path.join(root, `staged-${batch}`);
      fs.mkdirSync(staged);
      fs.writeFileSync(path.join(staged, "notes.md"), text);
      await run({ kind: "upload", dir: staged, batch }, deps({ client: fake.client }));
    }
    const pages = (await readVaultSnapshot(vault)).pages;
    expect(pages).toHaveLength(2);
    // Each by the name the owner dropped it under; the second numbered as a clash is.
    expect(pages.flatMap((p) => (p.parsed.ok ? p.parsed.frontmatter.sources : [])).sort()).toEqual(["notes (2).md", "notes.md"]);
  });

  it("keeps two documents apart whose paths read alike once redacted", async () => {
    write("orders@example.com/notes.md", "Acme notes for the first mailbox.");
    write("billing@example.com/notes.md", "Acme notes for the second mailbox.");
    const fake = fakeClient((items) => items.map((it, k) => ({ ...cardFor(it), title: `Acme mailbox ${k}` })));
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fake.client }));
    expect(job).toMatchObject({ done: 2, pages: 2 });
    expect((await readVaultSnapshot(vault)).pages).toHaveLength(2);
    const sent = fake.prompts.map((p) => p.user).join("\n");
    expect(sent).not.toContain("example.com");
    // A changed document still updates its own page, not the other one.
    write("orders@example.com/notes.md", "Acme notes for the first mailbox, revised.");
    const again = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    expect(again).toMatchObject({ done: 1, duplicates: 1 });
    expect((await readVaultSnapshot(vault)).pages).toHaveLength(2);
  });

  it("can be stopped; what it did not reach stays retryable", async () => {
    for (let i = 0; i < 4; i++) write(`f${i}.md`, `Doc ${i}.`);
    const slow = fakeClient(undefined, 80);
    const job = await startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client, batchSize: 1, parallel: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(stopIngest(job.id)).toBe(true);
    await ingestFinished(job.id);
    const final = getIngestJob(job.id, vault)!;
    expect(final.error).toBe("The ingest was stopped.");
    expect(final.done).toBeLessThan(4);
    const rerun = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    expect(rerun.done + rerun.duplicates).toBe(4);
  });

  it("ingests an upload batch and removes it afterwards", async () => {
    const staged = path.join(root, "staged");
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, "price-list.md"), "Acme price list for widgets.");
    const fake = fakeClient();
    const job = await run({ kind: "upload", dir: staged, batch: "0123456789abcdef" }, deps({ client: fake.client }));
    expect(job).toMatchObject({ kind: "upload", folders: ["upload/0123456789abcdef"], done: 1 });
    expect(fake.prompts[0].user).toContain('"path":"price-list.md"');
    expect(fs.existsSync(staged)).toBe(false);
    // The page's source is the file's own name, not the staging folder's path.
    const page = (await readVaultSnapshot(vault)).pages[0];
    expect(page.parsed.ok && page.parsed.frontmatter.sources).toEqual(["price-list.md"]);
    expect(page.parsed.ok && page.parsed.frontmatter.claims.every((c) => c.evidence[0].path === "price-list.md")).toBe(true);
    expect(page.parsed.body).toContain("## Sources\n\n- `price-list.md`");
  });
  it("redacts a dropped file's name before the model sees it, and keeps redacted twins apart", async () => {
    const staged = path.join(root, "staged-pii");
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, "555-010-0199-acme-notes.md"), "Acme notes from the first call.");
    fs.writeFileSync(path.join(staged, "555-010-0142-acme-notes.md"), "Acme notes from the second call.");
    fs.writeFileSync(path.join(staged, "+44 20 7946 0958 acme.md"), "Acme notes from the third call.");
    const fake = fakeClient((items) => items.map((it, k) => ({ ...cardFor(it), title: `Acme call ${k}` })));
    const job = await run({ kind: "upload", dir: staged, batch: "0123456789abcdef" }, deps({ client: fake.client }));
    expect(job).toMatchObject({ done: 3, pages: 3 });
    const paths = fake.prompts.flatMap((p) => (readWriterItems(p.user) ?? []).map((it) => it.path));
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      expect(p).not.toMatch(/555|7946|0958/);
      expect(p).toMatch(/^[^/]*\[REDACTED:PHONE\].*#[0-9a-f]{12}$/);
    }
    // Two names that read alike once redacted stay two documents.
    expect(new Set(paths).size).toBe(3);
    expect((await readVaultSnapshot(vault)).pages).toHaveLength(3);
  });
});

describe("job records", () => {
  it("settles a job the database calls running that no process runs", async () => {
    write("a.md", "Doc a.");
    await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    const orphan: IngestJob = {
      id: "ing-aaaaaaaaaaaa",
      kind: "folders",
      status: "running",
      phase: "write",
      folders: ["~/docs"],
      total: 5,
      done: 2,
      failed: 0,
      skipped: 0,
      duplicates: 0,
      pages: 2,
      commits: 1,
      calls: 1,
      usdEstimate: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      error: null,
      retryOf: null,
      requeued: 0,
      deadLetter: 0,
      notes: [],
      skips: { ...emptySkipCounts(), codeProject: 2, unsupported: 7 },
    };
    insertJob(vault, orphan);
    expect(getIngestJob(orphan.id, vault)).toMatchObject({ status: "interrupted", phase: "done", error: expect.stringMatching(/restarted/) });
    // What the job left out survives the round trip through the database.
    expect(getIngestJob(orphan.id, vault)?.skips).toEqual({ ...emptySkipCounts(), codeProject: 2, unsupported: 7 });
    expect(listIngestJobs(vault).map((j) => j.id)).toContain(orphan.id);
  });

  it("reads nothing into existence on a box with no state database", () => {
    expect(listIngestJobs(vault)).toEqual([]);
    expect(getIngestJob("ing-aaaaaaaaaaaa", vault)).toBeNull();
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("rebuilds job ids from their alphabet", () => {
    expect(safeJobId("ing-0123456789ab")).toBe("ing-0123456789ab");
    for (const bad of ["ing-0123456789aB", "ing-../../../x", "job-0123456789ab", "ing-0123456789abc", 5]) expect(safeJobId(bad)).toBeNull();
  });
});

describe("the retry queue and the dead-letter list", () => {
  it("tries a failed batch once more after a cooldown, in batches half the size", async () => {
    for (let i = 0; i < 4; i++) write(`f${i}.md`, `Doc ${i}.`);
    const sleeps: number[] = [];
    // The first call keeps failing through its retries; everything after it answers.
    const flaky = fakeClient((items, call) => (call <= 2 ? new FlashCallError("rate_limited", "busy", 429) : items.map(cardFor)));
    const job = await run(
      { kind: "folders", folders: [docs] },
      deps({ client: flaky.client, batchSize: 4, retry: { attempts: 2, sleep: async (ms) => void sleeps.push(ms) }, requeueDelayMs: 1234 }),
    );
    expect(job).toMatchObject({ status: "done", done: 4, failed: 0, requeued: 4, deadLetter: 0, commits: 2 });
    expect(job.notes.join(" ")).toMatch(/4 document\(s\) failed their first round/);
    expect(sleeps).toContain(1234);
    // Round two sent two batches of two.
    expect(flaky.prompts.slice(2).map((p) => (readWriterItems(p.user) ?? []).length)).toEqual([2, 2]);
    expect(readFiles(vault, job.id).every((f) => f.status === "done" && f.attempts === 2)).toBe(true);
  });

  it("does not requeue what a second round cannot fix: a stop, a refused credential, an unextractable file", async () => {
    write("a.md", "Doc a.");
    write("broken.pdf", "%PDF");
    const refused = fakeClient(() => new FlashCallError("auth", "refused", 401));
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: refused.client, extractor: async () => false }));
    expect(job.requeued).toBe(0);
    expect(refused.calls).toBe(1);
  });

  it("keeps what still fails as dead letters, and a retry job takes them over exactly once", async () => {
    write("a.md", "Doc a.");
    write("b.md", "Doc b.");
    const down = fakeClient(() => new FlashCallError("server", "down", 503));
    const failed = await run({ kind: "folders", folders: [docs] }, deps({ client: down.client, retry: { ...noSleep, attempts: 1 } }));
    expect(failed).toMatchObject({ done: 0, failed: 2, requeued: 2, deadLetter: 2 });
    expect(failed.notes.join(" ")).toMatch(/2 document\(s\) still failed; they can be retried/);
    const dead = readDeadLetter(vault, failed.id);
    expect(dead.map((d) => [d.error, d.attempts])).toEqual([["model call failed (server)", 2], ["model call failed (server)", 2]]);
    expect(dead.every((d) => !("source" in d))).toBe(true);

    const fake = fakeClient();
    const retried = await run({ kind: "retry", retryOf: failed.id }, deps({ client: fake.client }));
    expect(retried).toMatchObject({ kind: "retry", retryOf: failed.id, folders: [`retry/${failed.id}`], total: 2, done: 2, deadLetter: 0 });
    expect(getIngestJob(failed.id, vault)?.deadLetter).toBe(0);
    expect(readFiles(vault, failed.id).every((f) => f.retriedBy === retried.id)).toBe(true);
    expect((await readVaultSnapshot(vault)).pages).toHaveLength(2);

    await expect(startIngest({ kind: "retry", retryOf: failed.id }, deps({ client: fake.client }))).rejects.toBeInstanceOf(NothingToRetryError);
    await expect(startIngest({ kind: "retry", retryOf: "ing-ffffffffffff" }, deps({ client: fake.client }))).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("makes the files a stop never reached dead letters", async () => {
    for (let i = 0; i < 4; i++) write(`f${i}.md`, `Doc ${i}.`);
    const slow = fakeClient(undefined, 80);
    const job = await startIngest({ kind: "folders", folders: [docs] }, deps({ client: slow.client, batchSize: 1, parallel: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    stopIngest(job.id);
    await ingestFinished(job.id);
    const final = getIngestJob(job.id, vault)!;
    expect(final.deadLetter).toBe(4 - final.done);
    expect(final.deadLetter).toBeGreaterThan(0);
  });

  it("keeps a dropped file that still failed, retries it from the kept copy, then removes the copy", async () => {
    const staged = path.join(root, "staged");
    fs.mkdirSync(path.join(staged, "sub"), { recursive: true });
    fs.writeFileSync(path.join(staged, "sub", "price-list.md"), "Acme price list for widgets.");
    const down = fakeClient(() => new FlashCallError("server", "down", 503));
    const failed = await run({ kind: "upload", dir: staged, batch: "0123456789abcdef" }, deps({ client: down.client, retry: { ...noSleep, attempts: 1 } }));
    expect(failed.deadLetter).toBe(1);
    expect(fs.existsSync(staged)).toBe(false);
    const kept = path.join(deadLetterRoot(), failed.id, "sub", "price-list.md");
    expect(fs.readFileSync(kept, "utf8")).toBe("Acme price list for widgets.");

    const retried = await run({ kind: "retry", retryOf: failed.id }, deps({ client: fakeClient().client }));
    expect(retried).toMatchObject({ done: 1, deadLetter: 0 });
    expect(fs.existsSync(kept)).toBe(false);
    expect(fs.existsSync(path.join(deadLetterRoot(), failed.id))).toBe(false);
  });

  it("drops a dead letter whose file is gone instead of listing it for ever", async () => {
    const a = write("a.md", "Doc a.");
    const down = fakeClient(() => new FlashCallError("server", "down", 503));
    const failed = await run({ kind: "folders", folders: [docs] }, deps({ client: down.client, retry: { ...noSleep, attempts: 1 } }));
    fs.rmSync(a);
    const retried = await run({ kind: "retry", retryOf: failed.id }, deps({ client: fakeClient().client }));
    expect(retried).toMatchObject({ failed: 1, deadLetter: 0 });
    expect(readFiles(vault, retried.id)[0].error).toBe("gone");
  });

  it("turns a restart's unreached files into dead letters", async () => {
    write("a.md", "Doc a.");
    await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    const orphan = { ...(getIngestJob(listIngestJobs(vault)[0].id, vault) as IngestJob), id: "ing-bbbbbbbbbbbb", status: "running" as const, finishedAt: null };
    insertJob(vault, orphan);
    insertFiles(vault, orphan.id, [{ seq: 0, label: "~/docs/x.md", source: path.join(docs, "x.md") }]);
    expect(getIngestJob(orphan.id, vault)).toMatchObject({ status: "interrupted", deadLetter: 1 });
    expect(readDeadLetter(vault, orphan.id)[0]).toMatchObject({ label: "~/docs/x.md", error: "interrupted" });
  });
});

describe("settings an ingest follows", () => {
  it("runs 128 calls at once by default, or what the settings file says", async () => {
    expect(DEFAULT_PARALLEL).toBe(128);
    writeSettings({ ingest: { parallel: 2 } });
    for (let i = 0; i < 6; i++) write(`f${i}.md`, `Document number ${i}.`);
    const slow = fakeClient(undefined, 30);
    const { parallel: _p, ...rest } = deps({ client: slow.client, batchSize: 1 });
    void _p;
    const job = await run({ kind: "folders", folders: [docs] }, rest);
    expect(job.done).toBe(6);
    expect(slow.maxInFlight).toBe(2);
  });

  it("walks with the settings file's exclude list and says what it left out", async () => {
    write("a.md", "Doc a.");
    write("drafts/b.md", "Doc b.");
    writeSettings({ ingest: { exclude: ["drafts"] } });
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    expect(job).toMatchObject({ total: 1, done: 1 });
    expect(job.notes).toContain("1 folder(s) were left out by the exclude list.");
  });

  it("leaves out code projects, boilerplate, temporary files and machine text, counting each reason", async () => {
    write("notes/plan.md", "Our plan for the Acme launch is to start in spring with the northern stores first.");
    write("notes/LICENSE.md", "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.");
    write("notes/~$budget.docx", "lock");
    write("notes/plan.md~", "backup");
    write("app/package.json", "{}");
    write("app/README.md", "The app's readme.");
    const log = Array.from({ length: 20 }, (_, i) => `2026-10-15 10:00:${String(i).padStart(2, "0")} INFO worker-${i} started job ${i}`).join("\n");
    write("notes/worker.log.txt", log);
    const model = fakeClient();
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: model.client }));
    expect(job).toMatchObject({ total: 2, done: 1, skipped: 1 });
    expect(job.skips).toMatchObject({ codeProject: 1, boilerplate: 1, temp: 2, machineText: 1 });
    expect(job.notes).toContain("1 code project(s) were left out.");
    expect(job.notes).toContain("1 machine-generated text file(s) (logs, data exports) were left out.");
    // The log never reached the model.
    expect(model.prompts.map((p) => p.user).join("\n")).not.toContain("worker-3");
    expect(readFiles(vault, job.id).find((f) => f.label.endsWith("worker.log.txt"))).toMatchObject({ status: "skipped", error: "machine-text" });
    expect(getIngestJob(job.id, vault)?.skips).toEqual(job.skips);
  });

  it("reads code projects too when the settings say not to skip them", async () => {
    write("app/package.json", "{}");
    write("app/docs/guide.md", "How the Acme app is deployed to the stores.");
    writeSettings({ ingest: { skipCodeProjects: false } });
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    expect(job).toMatchObject({ total: 1, done: 1 });
    expect(job.skips.codeProject).toBe(0);
  });

  it("reads a dropped file whatever its name or content: the owner chose it", async () => {
    const drop = path.join(root, "drop");
    fs.mkdirSync(drop, { recursive: true });
    fs.writeFileSync(path.join(drop, "CHANGELOG.md"), "Changes to the Acme price list this quarter, written by the owner.");
    fs.writeFileSync(path.join(drop, "export.txt"), Array.from({ length: 12 }, (_, i) => `${i},acme,${i * 3},eur`).join("\n"));
    const job = await run({ kind: "upload", dir: drop, batch: "0123456789abcdef" }, deps({ client: fakeClient().client }));
    expect(job).toMatchObject({ total: 2, done: 2 });
    expect(job.skips).toEqual(emptySkipCounts());
  });

  it("prices calls with the settings file's rates", async () => {
    write("a.md", "Doc a.");
    writeSettings({ costRates: { "deepseek-v4-flash": { input: 1000, output: 1000 } } });
    const job = await run({ kind: "folders", folders: [docs] }, deps({ client: fakeClient().client }));
    // 1000 prompt + 100 completion tokens at 1000 USD per million each.
    expect(job.usdEstimate).toBeCloseTo(1.1, 6);
    expect(readCosts(vault, job.id)[0].usdEstimate).toBeCloseTo(1.1, 6);
  });
});
