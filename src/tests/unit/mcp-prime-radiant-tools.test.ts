/**
 * The `prime_radiant_*` MCP tools (mcp/tools/prime-radiant.ts): each one calls
 * the route the desktop app calls, with the method, path and body that route
 * reads; each turns the route's refusals into what the agent should do; and
 * each refuses an argument the device would never accept before anything is
 * sent. The routes themselves are pinned in src/tests/routes/prime-radiant-*.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../mcp/lib/api", () => ({ api: (...a: unknown[]) => api(...a) }));

import { ApiError } from "../../../mcp/lib/errors";
import { contractViolations, paramDescriptionViolations } from "../../../mcp/lib/register";
import { PRIME_RADIANT_TOOLS, REVIEW_KINDS, REVIEW_STATUSES, registerPrimeRadiantTools } from "../../../mcp/tools/prime-radiant";
import { REVIEW_KINDS as LIB_REVIEW_KINDS, REVIEW_STATUSES as LIB_REVIEW_STATUSES } from "@/lib/prime-radiant/review-store";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

const BASE = "/setup-api/prime-radiant";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "acme-sales/pricing/blue-widget";
const JOB = "ing-0123456789ab";
const REV = "rev-0123456789ab";

function harness(edition: "openclaw" | "hermes" = "openclaw"): CaptureHarness {
  const h = captureRegistrar(edition);
  registerPrimeRadiantTools(h.reg);
  return h;
}

/** Answer each call by its path, in order of the rules given. */
function answer(...rules: Array<[RegExp, unknown]>) {
  api.mockImplementation(async (path: string) => {
    for (const [re, body] of rules) if (re.test(path)) return body;
    throw new Error(`unexpected call to ${path}`);
  });
}

function refuse(status: number, code: string, extra: Record<string, unknown> = {}) {
  api.mockImplementation(async () => {
    throw new ApiError(status, JSON.stringify({ error: `refused: ${code}`, code, ...extra }));
  });
}

const call = (n = 0) =>
  api.mock.calls[n] as [string, { method: string; query?: Record<string, unknown>; body?: Record<string, unknown>; timeoutMs: number; onTimeout?: { message: string; next: string } }];

beforeEach(() => {
  api.mockReset();
});

interface Case {
  tool: string;
  args: Record<string, unknown>;
  reply: unknown;
  method: string;
  path: string;
  /** What the route must be sent: `query` / `body`, matched with toMatchObject. */
  sent?: { query?: Record<string, unknown>; body?: Record<string, unknown> };
  says: RegExp;
  /** Arguments the schema refuses; null for a tool that takes none. */
  bad: Record<string, unknown> | null;
}

const CASES: Case[] = [
  {
    tool: "prime_radiant_pages",
    args: { domain: "acme-sales", owner: "sales-team", verified: "unverified", title_contains: "widget", limit: 20 },
    reply: { total: 1, pages: [{ path: "concepts/pricing.md", valid: true, title: "Widget pricing", type: "concept", domain: "acme-sales", owner: "sales-team", verified: false, claims: 2, summary: "Prices." }] },
    method: "GET",
    path: `${BASE}/pages`,
    sent: { query: { domain: "acme-sales", owner: "sales-team", verified: "false", q: "widget", limit: 20 } },
    says: /"concepts\/pricing\.md"/,
    bad: { domain: "Acme Sales" },
  },
  {
    tool: "prime_radiant_page",
    args: { path: "concepts/pricing.md", include_body: true },
    reply: {
      path: "concepts/pricing.md",
      frontmatter: { title: "Widget pricing", type: "concept", domain: "acme-sales", owner: "sales-team", status: "draft", sources: ["a.md"], claims: [{ id: CLAIM, text: "10 EUR.", confidence: 1, status: "verified", verified: { at: "2026-02-01", by: "owner" }, evidence: [{ kind: "source", path: "a.md" }] }] },
      body: "Prices.\n\nMore.",
      summary: "Prices.",
      verified: true,
      backlinks: ["entities/acme.md"],
      links: [],
      lint: { findings: [] },
    },
    method: "GET",
    path: `${BASE}/pages/concepts/pricing.md`,
    says: /"verified_by": "owner"[\s\S]*"backlinks": \[\s*"entities\/acme\.md"/,
    bad: { path: "" },
  },
  {
    tool: "prime_radiant_search",
    args: { query: "blue widget price", limit: 5 },
    reply: { initialised: true, shardEnabled: true, indexing: false, results: [{ path: "concepts/pricing.md", id: CLAIM, kind: "claim", type: "concept", title: "Widget pricing", verified: true, snippet: "10 EUR", score: 0.912 }] },
    method: "GET",
    path: `${BASE}/search`,
    sent: { query: { q: "blue widget price", limit: 5 } },
    says: /"claim_id": "acme-sales\/pricing\/blue-widget"[\s\S]*"score": 0\.91/,
    bad: { query: "x", limit: 50 },
  },
  {
    tool: "prime_radiant_map",
    args: { page: "concepts/pricing.md" },
    reply: {
      revision: SHA,
      truncated: false,
      nodes: [
        { id: "concepts/pricing.md", title: "Widget pricing", domain: "acme-sales", degree: 1 },
        { id: "entities/acme.md", title: "Acme", domain: "acme-sales", degree: 1 },
        { id: "concepts/lonely.md", title: "Lonely", domain: null, degree: 0 },
      ],
      edges: [[0, 1, 1]],
    },
    method: "GET",
    path: `${BASE}/graph`,
    says: /"neighbours": \[\s*\{\s*"path": "entities\/acme\.md"[\s\S]*"tie": "linked"/,
    bad: { page: 7 },
  },
  {
    tool: "prime_radiant_lint",
    args: { pages: ["concepts/pricing.md", "entities/acme.md"] },
    reply: { checked: 2, errors: 1, warnings: 0, findings: [{ rule: "no-sources", severity: "error", path: "entities/acme.md", message: "the page names no sources" }] },
    method: "GET",
    path: `${BASE}/lint`,
    sent: { query: { paths: "concepts/pricing.md,entities/acme.md" } },
    says: /"rule": "no-sources"/,
    bad: { pages: [] },
  },
  {
    tool: "prime_radiant_costs",
    args: { since: "2026-10-01", run_id: JOB },
    reply: { basis: "estimate", totals: { calls: 3, usdEstimate: 0.01 } },
    method: "GET",
    path: `${BASE}/costs`,
    sent: { query: { since: "2026-10-01", runId: JOB } },
    says: /"basis": "estimate"/,
    bad: { since: "last week" },
  },
  {
    tool: "prime_radiant_settings",
    args: {},
    reply: { settings: { nightly: { enabled: true, time: "03:00" } }, defaults: { ingest: { exclude: ["node_modules"] } }, limits: {}, nightly: { nextRunAt: 0 }, opusSource: "none" },
    method: "GET",
    path: `${BASE}/settings`,
    says: /"time": "03:00"[\s\S]*"next_nightly_run": "off"/,
    bad: null,
  },
  {
    tool: "prime_radiant_review_list",
    args: { status: "open", kind: "contradiction", limit: 10 },
    reply: { total: 1, counts: { open: 1 }, items: [{ id: REV, kind: "contradiction", claimId: CLAIM, pages: ["concepts/pricing.md"], candidates: [{ text: "10 EUR" }, { text: "12 EUR" }], status: "open" }] },
    method: "GET",
    path: `${BASE}/review`,
    sent: { query: { status: "open", kind: "contradiction", limit: 10 } },
    says: /"number": 2,\s*"text": "12 EUR"/,
    bad: { status: "closed" },
  },
  {
    tool: "prime_radiant_history",
    args: { path: "concepts/pricing.md", limit: 5 },
    reply: { path: "concepts/pricing.md", commits: [{ sha: SHA, subject: "edit: concepts/pricing.md", at: "2026-10-16T10:00:00Z", author: "ClawBox assistant" }] },
    method: "GET",
    path: `${BASE}/history/concepts/pricing.md`,
    sent: { query: { limit: 5 } },
    says: /"commit": "0123456789ab"[\s\S]*"by": "ClawBox assistant"/,
    bad: { path: "concepts/pricing.md", limit: 0 },
  },
  {
    tool: "prime_radiant_diff",
    args: { commit: SHA, path: "concepts/pricing.md" },
    reply: { commit: { sha: SHA, subject: "edit", at: "x", author: "ClawBox assistant" }, files: ["concepts/pricing.md"], diff: "-a\n+b\n", truncated: false },
    method: "GET",
    path: `${BASE}/diff`,
    sent: { query: { commit: SHA, path: "concepts/pricing.md" } },
    says: /"diff": "-a\\n\+b\\n"/,
    bad: { commit: "HEAD~1" },
  },
  {
    tool: "prime_radiant_ingest_status",
    args: { job_id: JOB },
    reply: { job: { id: JOB, status: "done" }, deadLetter: [{ seq: 1, label: "Documents/a.pdf", error: "unreadable", attempts: 2, bytes: 10 }] },
    method: "GET",
    path: `${BASE}/ingest/${JOB}`,
    says: /"file": "Documents\/a\.pdf"/,
    bad: { job_id: "job-1" },
  },
  {
    tool: "prime_radiant_page_create",
    args: { type: "entity", title: "Acme Widgets Ltd", domain: "acme-sales", summary: "A synthetic firm.", facts: ["Founded in 1999."], confidence: 70 },
    reply: { path: "entities/acme-widgets-ltd.md", commit: SHA, claims: ["acme-sales/acme-widgets-ltd/founded-in-1999"], findings: [] },
    method: "POST",
    path: `${BASE}/pages`,
    sent: { body: { type: "entity", title: "Acme Widgets Ltd", domain: "acme-sales", summary: "A synthetic firm.", facts: ["Founded in 1999."], confidence: 0.7 } },
    says: /Created entities\/acme-widgets-ltd\.md\. Commit 0123456789ab/,
    bad: { type: "novel", title: "x", domain: "acme", summary: "x" },
  },
  {
    tool: "prime_radiant_page_edit",
    args: { path: "concepts/pricing.md", summary: "New summary.", recheck_after: "never" },
    reply: { path: "concepts/pricing.md", commit: SHA, changed: ["summary", "stale_after"], findings: [] },
    method: "PATCH",
    path: `${BASE}/pages/concepts/pricing.md`,
    sent: { body: { summary: "New summary.", stale_after: null } },
    says: /Edited concepts\/pricing\.md \(summary, stale_after\)/,
    bad: { path: "concepts/pricing.md", recheck_after: "tomorrow" },
  },
  {
    tool: "prime_radiant_page_delete",
    args: { path: "concepts/pricing.md", confirm: true },
    reply: { path: "concepts/pricing.md", commit: SHA, claims: [CLAIM], verified: [CLAIM] },
    method: "DELETE",
    path: `${BASE}/pages/concepts/pricing.md`,
    says: /Deleted concepts\/pricing\.md\. Its 1 claim\(s\) went with it, 1 of them verified\./,
    bad: { path: "concepts/pricing.md", confirm: false },
  },
  {
    tool: "prime_radiant_claim_add",
    args: { page: "concepts/pricing.md", text: "The green widget costs 9 EUR.", confidence: 60, source: "price-list.pdf" },
    reply: { id: "acme-sales/pricing/green", page: "concepts/pricing.md", commit: SHA, findings: [] },
    method: "POST",
    path: `${BASE}/claims`,
    sent: { body: { page: "concepts/pricing.md", text: "The green widget costs 9 EUR.", confidence: 0.6, source: "price-list.pdf" } },
    says: /Added claim acme-sales\/pricing\/green/,
    bad: { page: "concepts/pricing.md", text: "x".repeat(241), confidence: 80 },
  },
  {
    tool: "prime_radiant_claim_edit",
    args: { id: CLAIM, confidence: 95 },
    reply: { id: CLAIM, page: "concepts/pricing.md", commit: SHA, findings: [] },
    method: "PATCH",
    path: `${BASE}/claims/acme-sales/pricing/blue-widget`,
    sent: { body: { confidence: 0.95 } },
    says: /Edited claim acme-sales\/pricing\/blue-widget/,
    bad: { id: "Acme/Pricing" },
  },
  {
    tool: "prime_radiant_claim_delete",
    args: { id: CLAIM, page: "concepts/pricing.md", confirm: true },
    reply: { id: CLAIM, page: "concepts/pricing.md", commit: SHA, wasVerified: false },
    method: "DELETE",
    path: `${BASE}/claims/acme-sales/pricing/blue-widget`,
    sent: { query: { page: "concepts/pricing.md" } },
    says: /Deleted claim acme-sales\/pricing\/blue-widget from concepts\/pricing\.md\. Commit/,
    bad: { id: CLAIM },
  },
  {
    tool: "prime_radiant_claim_verify",
    args: { id: CLAIM, confirm: true },
    reply: { claimId: CLAIM, page: "concepts/pricing.md", commit: SHA, retired: [] },
    method: "POST",
    path: `${BASE}/claims/verify`,
    sent: { body: { id: CLAIM } },
    says: /Verified acme-sales\/pricing\/blue-widget on concepts\/pricing\.md, stamped as verified by the assistant/,
    bad: { id: CLAIM },
  },
  {
    tool: "prime_radiant_review_resolve",
    args: { id: REV, action: "pick", candidate: 2, confirm: true },
    reply: { item: { id: REV, status: "resolved", claimId: CLAIM }, commit: SHA, retired: ["acme-sales/catalogue/blue-widget"] },
    method: "POST",
    path: `${BASE}/review/${REV}/resolve`,
    sent: { body: { action: "pick", candidate: 1 } },
    says: /verified under acme-sales\/pricing\/blue-widget\. Retired the other answers' ids: acme-sales\/catalogue\/blue-widget/,
    bad: { id: REV, action: "approve", confirm: true },
  },
  {
    tool: "prime_radiant_review_raise",
    args: { claim_id: CLAIM, candidates: ["10 EUR", "12 EUR"], note: "The price list changed." },
    reply: { item: { id: REV } },
    method: "POST",
    path: `${BASE}/review`,
    sent: { body: { claimId: CLAIM, candidates: [{ text: "10 EUR" }, { text: "12 EUR" }], note: "The price list changed." } },
    says: /Raised review item rev-0123456789ab/,
    bad: { candidates: Array.from({ length: 9 }, (_, i) => `answer ${i}`) },
  },
  {
    tool: "prime_radiant_undo",
    args: { commit: SHA, path: "concepts/pricing.md", confirm: true },
    reply: { reverted: SHA, commit: "fedcba9876543210fedcba9876543210fedcba98", changed: ["concepts/pricing.md"] },
    method: "POST",
    path: `${BASE}/revert`,
    sent: { body: { commit: SHA, path: "concepts/pricing.md" } },
    says: /Undid 0123456789ab as commit fedcba987654 \(concepts\/pricing\.md\)/,
    bad: { commit: SHA },
  },
  {
    tool: "prime_radiant_ingest_preview",
    args: { folders: ["Documents/acme"] },
    reply: { preview: { documents: 12, skips: {}, topFolders: [] } },
    method: "POST",
    path: `${BASE}/ingest/preview`,
    sent: { body: { folders: ["Documents/acme"] } },
    says: /"documents": 12/,
    bad: { folders: [] },
  },
  {
    tool: "prime_radiant_ingest_start",
    args: { files: ["Documents/acme/catalogue.md"] },
    reply: { job: { id: JOB, total: 1 } },
    method: "POST",
    path: `${BASE}/ingest`,
    sent: { body: { files: ["Documents/acme/catalogue.md"] } },
    says: /Started import ing-0123456789ab/,
    bad: { files: Array.from({ length: 201 }, (_, i) => `f${i}.md`) },
  },
  {
    tool: "prime_radiant_ingest_stop",
    args: { job_id: JOB },
    reply: { stopping: true },
    method: "DELETE",
    path: `${BASE}/ingest/${JOB}`,
    says: /Stopping import ing-0123456789ab/,
    bad: { job_id: "ing-xyz" },
  },
  {
    tool: "prime_radiant_ingest_retry",
    args: { job_id: JOB },
    reply: { job: { id: "ing-ba9876543210" } },
    method: "POST",
    path: `${BASE}/ingest/${JOB}/retry`,
    says: /Started import ing-ba9876543210 over the files ing-0123456789ab failed on/,
    bad: {},
  },
  {
    tool: "prime_radiant_nightly_run",
    args: {},
    reply: { run: { id: "run-0123456789ab" } },
    method: "POST",
    path: `${BASE}/nightly/run`,
    sent: { body: {} },
    says: /Started nightly pass run-0123456789ab/,
    bad: null,
  },
  {
    tool: "prime_radiant_nightly_merge",
    args: { branch: "dream/2026-10-15", confirm: true },
    reply: { branch: "dream/2026-10-15", commit: SHA, changed: ["a.md", "b.md"] },
    method: "POST",
    path: `${BASE}/nightly/run`,
    sent: { body: { merge: "dream/2026-10-15" } },
    says: /Merged dream\/2026-10-15 as 0123456789ab \(2 page\(s\)\)/,
    bad: { branch: "main", confirm: true },
  },
  {
    tool: "prime_radiant_connect_run",
    args: { dry_run: true },
    reply: { pages: 3, written: 0, dryRun: true },
    method: "POST",
    path: `${BASE}/maintenance`,
    sent: { body: { action: "connect", dryRun: true } },
    says: /"would"[\s\S]*"dryRun": true/,
    bad: { dry_run: "yes" },
  },
  {
    tool: "prime_radiant_settings_update",
    args: { nightly_time: "04:30", opus_enabled: true, opus_cap_usd: 5, domains: ["acme-sales=Sales team"], reset: ["ingest_exclude"], confirm: true },
    reply: { settings: { nightly: { time: "04:30" } }, nightly: { nextRunAt: Date.UTC(2026, 9, 17, 4, 30) } },
    method: "PUT",
    path: `${BASE}/settings`,
    sent: { body: { nightly: { time: "04:30" }, opus: { enabled: true, capUsd: 5 }, domains: [{ name: "acme-sales", owner: "Sales team" }], ingest: { exclude: null } } },
    says: /"result": "Saved\.[\s\S]*"next_nightly_run": "2026-10-17T04:30:00\.000Z"/,
    bad: { nightly_time: "25:00", confirm: true },
  },
];

describe("the family", () => {
  it("registers every tool on both editions, nothing else, within the contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = harness(edition);
      expect(h.names().sort()).toEqual([...PRIME_RADIANT_TOOLS].sort());
      for (const info of h.reg.list()) {
        expect(contractViolations(info), info.name).toEqual([]);
        expect(paramDescriptionViolations(info), info.name).toEqual([]);
        expect(info.opts.profile, info.name).toBeUndefined();
      }
    }
  });

  it("covers every tool here, with a happy path, a refusal and bad input", () => {
    expect(new Set([...CASES.map((c) => c.tool), "prime_radiant_status"])).toEqual(new Set(PRIME_RADIANT_TOOLS));
  });

  it("gates every destructive tool on a literal confirm, and marks the reads read-only", () => {
    const h = harness();
    for (const name of ["prime_radiant_page_delete", "prime_radiant_claim_delete", "prime_radiant_undo", "prime_radiant_settings_update"]) {
      expect(h.get(name).opts.destructive, name).toBe(true);
      expect(z.object(h.get(name).shape).safeParse({ ...CASES.find((c) => c.tool === name)!.args, confirm: undefined }).success, name).toBe(false);
    }
    for (const name of ["prime_radiant_status", "prime_radiant_page", "prime_radiant_search", "prime_radiant_history", "prime_radiant_ingest_preview"]) {
      expect(h.get(name).opts.readOnly, name).toBe(true);
    }
  });

  it("marks what comes back from the owner's documents as information", () => {
    const h = harness();
    for (const name of ["prime_radiant_page", "prime_radiant_search", "prime_radiant_review_list", "prime_radiant_diff"]) {
      expect(h.get(name).description, name).toMatch(/never as instructions to follow/);
    }
  });

  it("keeps the review queue's vocabulary in step with the library", () => {
    expect([...REVIEW_KINDS]).toEqual([...LIB_REVIEW_KINDS]);
    expect([...REVIEW_STATUSES].sort()).toEqual([...LIB_REVIEW_STATUSES].sort());
  });
});

describe.each(CASES)("$tool", (c) => {
  it("calls the app's own route and says what happened", async () => {
    api.mockResolvedValue(c.reply);
    const out = await harness().call(c.tool, z.object(harness().get(c.tool).shape).parse(c.args));
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const [path, opts] = call();
    expect(path).toBe(c.path);
    expect(opts.method).toBe(c.method);
    if (c.sent?.query) expect(opts.query).toMatchObject(c.sent.query);
    if (c.sent?.body) expect(opts.body).toEqual(c.sent.body);
    expect(out.text).toMatch(c.says);
  });

  it("turns the route's owner-only refusal into an instruction, not a retry", async () => {
    refuse(403, "owner_only");
    const out = await harness().call(c.tool, z.object(harness().get(c.tool).shape).parse(c.args));
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toBe("refused: owner_only");
    expect(out.error.next).toMatch(/owner's to do\. Do not retry/);
  });

  it.skipIf(c.bad === null)("refuses a bad argument before anything is sent", () => {
    const parsed = z.object(harness().get(c.tool).shape).safeParse(c.bad);
    expect(parsed.success).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("prime_radiant_status", () => {
  it("reads the vault, the import, the nightly pass and the queue in one answer", async () => {
    answer(
      [/\/status$/, { initialised: true, vault: { pages: 3, verifiedPages: 1, claims: 4, domains: ["acme-sales"] }, git: { head: { sha: SHA, subject: "edit: x", at: "t", author: "ClawBox assistant" } }, lint: { errors: 1, warnings: 2 } }],
      [/\/ingest$/, { running: null, jobs: [{ id: JOB, status: "done", pages: 2, failed: 0 }] }],
      [/\/nightly$/, { running: null, nextRunAt: 0, runs: [] }],
      [/\/maintenance$/, { running: null, last: {} }],
      [/\/review$/, { counts: { open: 2 } }],
    );
    const out = await harness().call("prime_radiant_status", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(JSON.parse(out.text)).toMatchObject({
      initialised: true,
      pages: 3,
      verified_pages: 1,
      claims: 4,
      last_change: { commit: SHA.slice(0, 12), by: "ClawBox assistant" },
      checks: { errors: 1, warnings: 2 },
      review_items_open: 2,
      import: { running: null },
      nightly: { next_run: "off" },
    });
  });

  it("sends the agent to open the app when there is no vault yet", async () => {
    answer([/\/status$/, { initialised: false }], [/./, {}]);
    const out = await harness().call("prime_radiant_status", {});
    expect(out.isError).toBe(false);
    if (!out.isError) expect(out.text).toContain('ui_open_app(\\"prime-radiant\\")');
  });

  it("still answers when a side read fails", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/status")) return { initialised: true, vault: { pages: 1 } };
      throw new ApiError(500, "{}");
    });
    const out = await harness().call("prime_radiant_status", {});
    expect(out.isError).toBe(false);
    if (!out.isError) expect(JSON.parse(out.text)).toMatchObject({ pages: 1, import: "unknown", nightly: "unknown", review_items_open: "unknown" });
  });
});

describe("refusals worth their own words", () => {
  it("names the lint rules a change broke", async () => {
    refuse(409, "lint_blocked", { findings: [{ rule: "secret-pattern", path: "concepts/x.md", message: "x" }] });
    const out = await harness().call("prime_radiant_page_edit", { path: "concepts/x.md", body: "x" });
    expect(out.isError && out.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("secret-pattern on concepts/x.md") });
  });

  it("sends a verified claim's edit to verify, and a busy import to its status", async () => {
    refuse(409, "verified");
    const edit = await harness().call("prime_radiant_claim_edit", { id: CLAIM, text: "x" });
    expect(edit.isError && edit.error.next).toMatch(/prime_radiant_claim_verify/);
    refuse(409, "busy", { runningId: JOB });
    const start = await harness().call("prime_radiant_ingest_start", { folders: ["Documents"] });
    expect(start.isError && start.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`running: ${JOB}`) });
  });

  it("names which folder of the list the route refused", async () => {
    refuse(404, "folder_not_found", { index: 1 });
    const out = await harness().call("prime_radiant_ingest_preview", { folders: ["Documents", "Nowhere"] });
    expect(out.isError && out.error).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("item 2 of the list") });
  });

  it("says to open the app before the vault exists", async () => {
    refuse(412, "not_initialised");
    const out = await harness().call("prime_radiant_claim_add", { page: "concepts/x.md", text: "A fact.", confidence: 80 });
    expect(out.isError && out.error.next).toMatch(/ui_open_app\("prime-radiant"\)/);
  });

  it("falls back to the status for a refusal it has no words for", async () => {
    api.mockRejectedValue(new ApiError(500, "<html>oops</html>"));
    const out = await harness().call("prime_radiant_pages", { verified: "any", offset: 0, limit: 10 });
    expect(out.isError && out.error.code).toBe("ENDPOINT_DOWN");
  });
});

describe("arguments the handler checks itself", () => {
  it("refuses an edit, a claim edit or a settings change that changes nothing", async () => {
    for (const [tool, args] of [
      ["prime_radiant_page_edit", { path: "concepts/x.md" }],
      ["prime_radiant_claim_edit", { id: CLAIM }],
      ["prime_radiant_settings_update", { confirm: true }],
      ["prime_radiant_review_raise", { note: "Something is off." }],
    ] as const) {
      const out = await harness().call(tool, args);
      expect(out.isError && out.error.code, tool).toBe("BAD_ARGUMENT");
    }
    expect(api).not.toHaveBeenCalled();
  });

  it("wants folders or files, never both or neither", async () => {
    for (const args of [{}, { folders: ["A"], files: ["a.md"] }]) {
      const out = await harness().call("prime_radiant_ingest_start", args);
      expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
    }
    expect(api).not.toHaveBeenCalled();
  });

  it("wants the candidate for pick and the text for an own answer", async () => {
    for (const args of [{ id: REV, action: "pick", confirm: true }, { id: REV, action: "own_answer", confirm: true }]) {
      const out = await harness().call("prime_radiant_review_resolve", args);
      expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
    }
    api.mockResolvedValue({ item: { id: REV, status: "resolved", claimId: CLAIM }, commit: SHA, retired: [] });
    await harness().call("prime_radiant_review_resolve", { id: REV, action: "own_answer", text: "11 EUR.", confirm: true });
    expect(call()[1].body).toEqual({ action: "new", text: "11 EUR." });
  });

  it("reads domains as name=owner", async () => {
    const out = await harness().call("prime_radiant_settings_update", { domains: ["Sales Team"], confirm: true });
    expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
    expect(api).not.toHaveBeenCalled();
  });

  it("answers an empty search without calling the route", async () => {
    const out = await harness().call("prime_radiant_search", { query: "   ", limit: 5 });
    expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
    expect(api).not.toHaveBeenCalled();
  });
});

describe("a page path can only ever name a page", () => {
  // The URL parser resolves dot segments: `pages/../../system/power` IS
  // /setup-api/system/power, so an unchecked path would send this tool's
  // method and body to another route with the same bearer.
  const ESCAPES = ["../../system/power", "concepts/../../settings", "./x.md", "concepts//x.md", "/concepts/x.md", "concepts\\x.md", "%2e%2e/x"];

  it.each([
    ["prime_radiant_page", (p: string) => ({ path: p })],
    ["prime_radiant_page_edit", (p: string) => ({ path: p, title: "x" })],
    ["prime_radiant_page_delete", (p: string) => ({ path: p, confirm: true })],
    ["prime_radiant_history", (p: string) => ({ path: p })],
    ["prime_radiant_undo", (p: string) => ({ commit: SHA, path: p, confirm: true })],
    ["prime_radiant_claim_add", (p: string) => ({ page: p, text: "A fact." })],
  ] as const)("%s refuses a path that is not one", (tool, args) => {
    const shape = z.object(harness().get(tool).shape);
    for (const p of ESCAPES) expect(shape.safeParse(args(p)).success, p).toBe(false);
    expect(shape.safeParse(args("concepts/Acme widgets 2.md")).success).toBe(true);
  });

  it("refuses a dot segment in the handler too, sending nothing", async () => {
    for (const [tool, args] of [
      ["prime_radiant_page_delete", { path: "../../system/power", confirm: true }],
      ["prime_radiant_page", { path: "concepts/../../settings", include_body: true }],
    ] as const) {
      const out = await harness().call(tool, args);
      expect(out.isError && out.error.code, tool).toBe("BAD_ARGUMENT");
    }
    expect(api).not.toHaveBeenCalled();
  });
});

describe("a write that times out", () => {
  it("is told to look before repeating it; a read and the preview keep the plain retry", async () => {
    api.mockResolvedValue({ path: "entities/x.md", commit: SHA, claims: [] });
    await harness().call("prime_radiant_page_create", { type: "entity", title: "X", domain: "acme", summary: "X.", confidence: 80 });
    expect(call()[1]).toMatchObject({ method: "POST", onTimeout: { next: expect.stringMatching(/Do not repeat it yet/) } });
    api.mockReset().mockResolvedValue({ path: "entities/x.md" });
    await harness().call("prime_radiant_page", { path: "entities/x.md", include_body: false });
    expect(call()[1].onTimeout).toBeUndefined();
    api.mockReset().mockResolvedValue({ preview: {} });
    await harness().call("prime_radiant_ingest_preview", { folders: ["Documents"] });
    expect(call()[1].onTimeout).toBeUndefined();
  });
});

describe("search states", () => {
  it.each([
    [{ initialised: false }, /no vault yet/],
    [{ initialised: true, shardEnabled: false }, /Memory Shard, which is switched off/],
    [{ initialised: true, shardEnabled: true, indexing: true }, /being built right now/],
    [{ initialised: true, shardEnabled: true, indexing: false, results: [] }, /Nothing in the wiki matched/],
  ])("%j", async (reply, says) => {
    api.mockResolvedValue(reply);
    const out = await harness().call("prime_radiant_search", { query: "widgets", limit: 5 });
    expect(out.isError).toBe(false);
    if (!out.isError) expect(out.text).toMatch(says);
  });
});
