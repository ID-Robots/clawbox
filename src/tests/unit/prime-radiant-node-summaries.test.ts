/**
 * Node summaries written from their connections and sources (node-summary.ts,
 * node-summary-run.ts) and the entity hygiene beside them (entity-hygiene.ts):
 * the neighbourhood, the check step (nothing invented), owner-verified facts
 * first, idempotency, the skip of an unchanged neighbourhood, the cost cap,
 * duplicate entities as merge suggestions, the domain-mismatch lint, and the
 * page header / Map card reading the new summary. Every fixture is synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { domainMismatches, findDuplicateEntities, nameSkeleton, suggestDomain } from "@/lib/prime-radiant/entity-hygiene";
import { FlashCallError, type FlashClient, type FlashRequest } from "@/lib/prime-radiant/flash-client";
import { createStubFlashClient } from "@/lib/prime-radiant/flash-stub";
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import { readCosts } from "@/lib/prime-radiant/ingest-store";
import { LINT_RULES, lintVault } from "@/lib/prime-radiant/lint";
import {
  buildSummaryPrompt,
  checkSentences,
  factsSummary,
  generatedSummary,
  parseSummaryResponse,
  planSummaries,
  readSummaryItems,
  readSummaryMeta,
  summaryOwner,
  type Neighbourhood,
} from "@/lib/prime-radiant/node-summary";
import { runSummaries, SUMMARY_BATCH, summaryMaxTokens, worstCaseCallUsd } from "@/lib/prime-radiant/node-summary-run";
import { pageBlurb } from "@/lib/prime-radiant/page-blurb";
import { withPluginFields } from "@/lib/prime-radiant/plugin-compat";
import type { PageFrontmatter } from "@/lib/prime-radiant/schema";
import { defaultSettings, readSettings, readSettingsPatch, SettingsError, writeSettings, type PrimeRadiantSettings } from "@/lib/prime-radiant/settings";
import { listEntry, type VaultSnapshot, type VaultTx } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, vaultPage } from "../helpers/prime-radiant-fixtures";

const NOW = new Date("2026-10-17T03:00:00.000Z");
const DOMAINS = ["finance", "operations", "sales"];
const OWNER = { at: "2026-10-01T09:00:00.000Z", by: "owner" };

function page(fm: Partial<PageFrontmatter>, body: string): string {
  return serializePage(frontmatter({ type: "concept", domain: "finance", ...fm }), body);
}

/**
 * A small company wiki: an entity the connect pass left with its stub, the
 * pages around it (one owner-verified fact among them), a monthly hub, a
 * record leaf, a COO filed under finance, and a `-2` copy of her in Cyrillic.
 */
function vault(extra: Record<string, string> = {}): VaultSnapshot {
  const pages: Record<string, string> = {
    "entities/globex-ltd.md": page(
      {
        type: "entity",
        title: "Globex Ltd",
        generated: { at: "2026-09-01T00:00:00.000Z", by: "connect" },
        claims: [
          claim("finance/globex-ltd/structure-role", "Globex Ltd is the counterparty on 4 records in this wiki: 3 invoices, 1 bank transfer.", { origin: "structure", confidence: 0.9 }),
          claim("finance/globex-ltd/structure-totals", "The records with Globex Ltd total 12,400.00 EUR (2026-07 to 2026-09).", { origin: "structure", confidence: 0.9, as_of: "2026-09-28" }),
        ],
      },
      "Globex Ltd is named on 4 pages of this wiki.\n\n## Named on\n\n- [[concepts/globex-supply-agreement]]\n- [[concepts/globex-q3-review]]\n",
    ),
    "concepts/globex-supply-agreement.md": page(
      {
        title: "Globex supply agreement",
        domain: "operations",
        sources: ["sources/globex-msa.pdf"],
        claims: [claim("operations/globex-supply-agreement/supplier", "Globex Ltd supplies aluminium housings to Acme Widgets Ltd.", { verified: OWNER, status: "verified" })],
      },
      "The supply agreement with [[entities/globex-ltd]] and [[entities/acme-widgets-ltd]].\n",
    ),
    "concepts/globex-q3-review.md": page(
      {
        title: "Globex Q3 review",
        domain: "operations",
        sources: ["sources/globex-msa.pdf", "sources/q3-review.pdf"],
        claims: [
          claim("operations/globex-q3-review/deliveries", "Globex Ltd delivered 1,200 housings in Q3 2026.", { as_of: "2026-09-30", confidence: 0.85 }),
          claim("operations/globex-q3-review/meeting", "The review meeting took place in Sofia.", { confidence: 0.7 }),
        ],
      },
      "How [[entities/globex-ltd]] did in the third quarter.\n",
    ),
    "entities/acme-widgets-ltd.md": page(
      { type: "entity", title: "Acme Widgets Ltd", domain: "sales", claims: [claim("sales/acme-widgets-ltd/company", "Acme Widgets Ltd makes widgets.", { verified: OWNER, status: "verified" })] },
      "Our own company.\n",
    ),
    "syntheses/invoices-2026-09.md": page(
      { type: "synthesis", title: "Invoices 2026-09", structure: { kind: "record-hub", type: "invoice", month: "2026-09", leaves: 1 } },
      "<!-- prime-radiant:hub:start -->\nInvoices 2026-09: 1 invoice, 4,100.00 EUR in total.\n\n- [[concepts/invoice-inv-0917-globex-ltd]]\n- [[entities/globex-ltd]]\n<!-- prime-radiant:hub:end -->\n",
    ),
    "concepts/invoice-inv-0917-globex-ltd.md": page(
      { type: "reference", title: "Invoice INV-0917 Globex Ltd", record: { type: "invoice", month: "2026-09", hub: "syntheses/invoices-2026-09.md", by: "rules" }, claims: [claim("finance/invoice-inv-0917/total", "Invoice INV-0917 from Globex Ltd totals 4,100.00 EUR.")] },
      "Invoice INV-0917 from [[entities/globex-ltd]].\n",
    ),
    "entities/maria-ivanova.md": page(
      { type: "entity", title: "Maria Ivanova", domain: "finance", claims: [claim("finance/maria-ivanova/role", "Maria Ivanova is the COO of Acme Widgets Ltd.")] },
      "Maria Ivanova runs the day-to-day work at [[entities/acme-widgets-ltd]].\n",
    ),
    "entities/maria-ivanova-2.md": page(
      { type: "entity", title: "Мария Иванова", domain: "finance", generated: { at: "2026-09-01T00:00:00.000Z", by: "connect" } },
      "Мария Иванова is named on 6 pages of this wiki.\n",
    ),
    "concepts/ops-weekly.md": page(
      { title: "Operations weekly", domain: "operations", claims: [claim("operations/ops-weekly/chair", "Мария Иванова chairs the operations weekly.")] },
      "The weekly with [[entities/maria-ivanova-2]] and [[entities/maria-ivanova]].\n",
    ),
    "concepts/sales-plan.md": page({ title: "Sales plan", domain: "sales" }, "The plan for [[entities/acme-widgets-ltd]].\n"),
    ...extra,
  };
  return { vault: "/nonexistent", pages: Object.entries(pages).map(([p, t]) => vaultPage(p, t)), indexBody: null, truncated: false };
}

function settings(summaries: Partial<PrimeRadiantSettings["summaries"]> = {}): PrimeRadiantSettings {
  const s = defaultSettings();
  return { ...s, domains: DOMAINS.map((name) => ({ name, owner: "unassigned" })), summaries: { ...s.summaries, ...summaries } };
}

function fakeRun(snap: { current: VaultSnapshot }) {
  const commits: string[] = [];
  const run = async (message: string, fn: (tx: VaultTx) => Promise<void>) => {
    const tx = {
      vault: "/nonexistent",
      async read(rel: string) {
        return snap.current.pages.find((p) => p.path === rel) ?? null;
      },
      async write(rel: string, text: string) {
        snap.current = { ...snap.current, pages: [...snap.current.pages.filter((p) => p.path !== rel), vaultPage(rel, text)] };
        return rel;
      },
      async writePage(rel: string, f: PageFrontmatter, body: string) {
        return tx.write(rel, serializePage(withPluginFields(rel, f), body));
      },
    } as unknown as VaultTx;
    await fn(tx);
    commits.push(message);
    return { commit: `c${commits.length}` };
  };
  return { run, commits };
}

function fmOf(snap: VaultSnapshot, rel: string): PageFrontmatter {
  const p = snap.pages.find((x) => x.path === rel);
  if (!p || !p.parsed.ok) throw new Error(`no page ${rel}`);
  return p.parsed.frontmatter;
}

/** A model that answers every node with one sentence on its first fact and one it made up. */
function inventingClient(calls: FlashRequest[], usage?: (req: FlashRequest) => { promptTokens: number; completionTokens: number }): FlashClient {
  return {
    model: "deepseek-v4-flash",
    async complete(req) {
      calls.push(req);
      const nodes = readSummaryItems(req.user) ?? [];
      const text = JSON.stringify(
        nodes.map((n) => ({
          i: n.i,
          sentences: [
            { text: "It was founded in 1999 by Initech.", from: [n.facts[0]?.id ?? "F1"] },
            ...(n.facts[0] ? [{ text: n.facts[0].text, from: [n.facts[0].id] }] : []),
          ],
        })),
      );
      const u = usage?.(req) ?? { promptTokens: 400, completionTokens: 60 };
      return { text, model: "deepseek-v4-flash", usage: { ...u, cacheHitTokens: 0 } };
    },
  };
}

/** A vault folder of the test's own: the state database lives beside it (state-db.ts), inside the temp folder, never in the shared tmp. */
function tmpState(): string {
  const vaultDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr-summaries-")), "vault");
  fs.mkdirSync(vaultDir);
  return vaultDir;
}

function dropState(vaultDir: string): void {
  fs.rmSync(path.dirname(vaultDir), { recursive: true, force: true });
}

function hoodOf(snap: VaultSnapshot, rel: string): Neighbourhood {
  const job = planSummaries(snap, { domains: DOMAINS }).jobs.find((j) => j.hood.path === rel);
  if (!job) throw new Error(`no job for ${rel}`);
  return job.hood;
}

describe("the neighbourhood", () => {
  it("gathers the node's own facts, what its neighbours say about it, its hubs, its relations and shared sources — owner-verified first", () => {
    const hood = hoodOf(vault(), "entities/globex-ltd.md");
    expect(hood.tier).toBe("entity");
    // The owner-verified fact of a neighbour leads, whoever says it.
    expect(hood.facts[0]).toMatchObject({ kind: "neighbour-claim", verified: true, text: "Globex Ltd supplies aluminium housings to Acme Widgets Ltd.", on: "Globex supply agreement" });
    const kinds = new Set(hood.facts.map((f) => f.kind));
    expect([...kinds].sort()).toEqual(["claim", "hub", "neighbour-claim", "relation", "source"]);
    expect(hood.facts.find((f) => f.kind === "source")?.text).toMatch(/^Shares the source "(globex-msa\.pdf|acme-catalogue\.md)" with /);
    expect(hood.facts.find((f) => f.ref === "finance/globex-ltd/structure-totals")).toMatchObject({ kind: "claim", asOf: "2026-09-28" });
    expect(hood.facts.find((f) => f.kind === "hub")?.text).toBe('Listed in the hub "Invoices 2026-09"');
    // The connect stub is no fact; a neighbour's fact that does not name it is none either.
    expect(hood.facts.some((f) => /named on/.test(f.text))).toBe(false);
    expect(hood.facts.some((f) => /Sofia/.test(f.text))).toBe(false);
    expect(hood.facts.map((f) => f.id)).toEqual(hood.facts.map((_, i) => `F${i + 1}`));
  });

  it("is the same on the same vault (a stable hash) and changes when a neighbour says something new about it", () => {
    const a = hoodOf(vault(), "entities/globex-ltd.md");
    expect(hoodOf(vault(), "entities/globex-ltd.md").hash).toBe(a.hash);
    const b = hoodOf(
      vault({ "concepts/globex-audit.md": page({ title: "Globex audit", claims: [claim("finance/globex-audit/result", "Globex Ltd passed the 2026 supplier audit.")] }, "Audit of [[entities/globex-ltd]].\n") }),
      "entities/globex-ltd.md",
    );
    expect(b.hash).not.toBe(a.hash);
  });

  it("lends a page nothing from a neighbour of a stricter privacy tier", () => {
    const hood = hoodOf(
      vault({ "concepts/globex-dispute.md": page({ title: "Globex dispute", privacy: "confidential", claims: [claim("finance/globex-dispute/claim", "Globex Ltd disputes 2,000.00 EUR of penalties.")] }, "About [[entities/globex-ltd]].\n") }),
      "entities/globex-ltd.md",
    );
    expect(hood.facts.some((f) => /disputes|Globex dispute/.test(`${f.text} ${f.on ?? ""}`))).toBe(false);
  });
});

describe("the check step: nothing invented", () => {
  const hood = hoodOf(vault(), "entities/globex-ltd.md");
  const id = (re: RegExp) => hood.facts.find((f) => re.test(f.text))!.id;

  it("keeps a sentence every name, number and word of which its cited facts hold", () => {
    const r = checkSentences([{ text: "Globex Ltd delivered 1,200 housings in Q3 2026", from: [id(/delivered/)] }], hood);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual([{ text: "Globex Ltd delivered 1,200 housings in Q3 2026.", refs: ["operations/globex-q3-review/deliveries"], verified: false }]);
  });

  it("rejects an invented number, name or claim word, a sentence citing nothing, and markup", () => {
    const r = checkSentences(
      [
        { text: "Globex Ltd was founded in 1999.", from: [id(/supplies/)] },
        { text: "Globex Ltd is owned by Initech.", from: [id(/supplies/)] },
        { text: "Globex Ltd is a bankrupt supplier.", from: [id(/supplies/)] },
        { text: "Globex Ltd supplies aluminium housings.", from: [] },
        { text: "Globex Ltd supplies aluminium housings.", from: ["F99"] },
        { text: "Globex Ltd supplies [[aluminium]] housings.", from: [id(/supplies/)] },
        // Right words, wrong fact: the number is not in the fact it cites.
        { text: "Globex Ltd supplies 1,200 housings.", from: [id(/supplies/)] },
      ],
      hood,
    );
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "unsupported_number:1999",
      "unsupported_name:Initech",
      "unsupported_word:bankrupt",
      "no_source",
      "no_source",
      "markup",
      "unsupported_number:1200",
    ]);
  });

  it("reads a sentence's capitalised first word as the word it is, in English and in Bulgarian — never an invented name", () => {
    const bg = vault({
      "entities/globeks-ood.md": page({ type: "entity", title: "Глобекс ООД", domain: "operations" }, "Глобекс ООД is named on 2 pages of this wiki.\n"),
      "concepts/dostavki.md": page({ title: "Доставки", domain: "operations", claims: [claim("operations/dostavki/korpusi", "Глобекс ООД доставя алуминиеви корпуси на Акме ООД.")] }, "Доставки от [[entities/globeks-ood]].\n"),
    });
    const h = hoodOf(bg, "entities/globeks-ood.md");
    const f = h.facts.find((x) => /доставя/.test(x.text))!.id;
    const r = checkSentences(
      [
        { text: "Тя доставя алуминиеви корпуси на Акме ООД.", from: [f] },
        { text: "Иван Петров доставя корпуси.", from: [f] },
        { text: "Доставчик е на Акме ООД.", from: [f] },
      ],
      h,
    );
    expect(r.accepted.map((s) => s.text)).toEqual(["Тя доставя алуминиеви корпуси на Акме ООД.", "Доставчик е на Акме ООД."]);
    expect(r.rejected).toEqual([{ text: "Иван Петров доставя корпуси.", reason: "unsupported_name:Иван" }]);
    const en = checkSentences(
      [
        { text: "Delivering 1,200 housings in Q3 2026 is what Globex Ltd did.", from: [id(/delivered/)] },
        { text: "Initech delivered housings.", from: [id(/delivered/)] },
      ],
      hood,
    );
    expect(en.accepted).toHaveLength(1);
    expect(en.rejected).toEqual([expect.objectContaining({ reason: "unsupported_name:Initech" })]);
  });

  it("puts sentences resting on an owner-verified fact first, three at most, 400 characters together", () => {
    const r = checkSentences(
      [
        { text: "The records with Globex Ltd total 12,400.00 EUR (2026-07 to 2026-09).", from: [id(/total 12,400/)] },
        { text: "Globex Ltd supplies aluminium housings to Acme Widgets Ltd.", from: [id(/supplies/)] },
        { text: "Globex Ltd delivered 1,200 housings in Q3 2026.", from: [id(/delivered/)] },
        { text: "Globex Ltd is the counterparty on 4 records in this wiki: 3 invoices, 1 bank transfer.", from: [id(/counterparty/)] },
      ],
      hood,
    );
    expect(r.accepted.map((s) => s.verified)).toEqual([true, false, false]);
    expect(r.accepted[0].text).toMatch(/^Globex Ltd supplies/);
    expect(r.rejected).toEqual([expect.objectContaining({ reason: "over_length" })]);
    expect(r.accepted.map((s) => s.text).join(" ").length).toBeLessThanOrEqual(400);
  });

  it("composes a summary from the facts' own words that passes the check, verified first", () => {
    const drafts = factsSummary(hood);
    const r = checkSentences(drafts, hood);
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0]).toMatchObject({ text: "Globex Ltd supplies aluminium housings to Acme Widgets Ltd.", verified: true });
    expect(r.accepted.at(-1)?.text).toMatch(/^Globex Ltd is linked with /);
  });

  it("parses the model's answer wherever its array sits, dropping nodes out of range or answered twice", () => {
    const text = 'Here: [{"i":0,"sentences":[{"text":"A.","from":["F1"]}]},{"i":1,"sentences":[]},{"i":1,"sentences":[]},{"i":7,"sentences":[]}] done';
    const m = parseSummaryResponse(text, 3);
    expect([...m.keys()]).toEqual([0]);
    expect(m.get(0)).toEqual([{ text: "A.", from: ["F1"] }]);
    expect(parseSummaryResponse("no json", 2).size).toBe(0);
  });
});

describe("the plan", () => {
  it("orders entities, then hubs, then concepts; leaves keep theirs, a verified page and a duplicate are skipped", () => {
    const plan = planSummaries(vault(), { domains: DOMAINS });
    const tiers = plan.jobs.map((j) => j.hood.tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => ["entity", "hub", "concept"].indexOf(a) - ["entity", "hub", "concept"].indexOf(b)));
    const paths = plan.jobs.map((j) => j.hood.path);
    expect(paths).toContain("entities/globex-ltd.md");
    expect(paths).toContain("syntheses/invoices-2026-09.md");
    expect(paths).not.toContain("concepts/invoice-inv-0917-globex-ltd.md");
    expect(paths).not.toContain("entities/acme-widgets-ltd.md");
    expect(paths).not.toContain("concepts/globex-supply-agreement.md");
    expect(paths).not.toContain("entities/maria-ivanova-2.md");
    expect(plan.stats).toMatchObject({ skippedVerified: 2, duplicates: 1, leaves: 1, secret: 0 });
  });

  it("gives a secret-ref page no summary: its facts never go to a model", () => {
    const plan = planSummaries(vault({ "concepts/vault-keys.md": page({ title: "Vault keys", privacy: "secret-ref", claims: [claim("finance/vault-keys/where", "Globex Ltd keeps the keys in the safe.")] }, "See [[entities/globex-ltd]].\n") }));
    expect(plan.jobs.map((j) => j.hood.path)).not.toContain("concepts/vault-keys.md");
    expect(plan.stats.secret).toBe(1);
    expect(plan.jobs.flatMap((j) => j.hood.facts).some((f) => /safe/.test(f.text))).toBe(false);
  });

  it("keeps a summary a person wrote, and one of ours a person edited since", () => {
    const person = vault({ "concepts/pricing.md": page({ title: "Pricing", summary: "Our price list.", claims: [claim("finance/pricing/eur", "Prices are in EUR.")] }, "Prices.\n") });
    expect(planSummaries(person).jobs.map((j) => j.hood.path)).not.toContain("concepts/pricing.md");
    const edited = { summary: "A person's words now.", summary_meta: { by: "summaries", method: "facts", hash: "x", digest: "000000000000", at: NOW.toISOString(), from: [] } };
    expect(summaryOwner(edited)).toBe("person");
    expect(generatedSummary(edited)).toBeNull();
  });
});

describe("the pass", () => {
  it("writes model summaries that passed the check (the invented sentence rejected), records the cost, and is idempotent", async () => {
    const state = tmpState();
    try {
      const snap = { current: vault() };
      const calls: FlashRequest[] = [];
      const { run, commits } = fakeRun(snap);
      const r = await runSummaries(snap.current, run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: inventingClient(calls), online: true, runId: "run-1", now: () => NOW });
      expect(r.written).toBe(r.planned);
      expect(r.byModel).toBe(r.planned);
      expect(r.rejected).toBe(r.planned);
      expect(r.model.calls).toBe(Math.ceil(r.planned / SUMMARY_BATCH));
      expect(commits).toHaveLength(1);
      const fm = fmOf(snap.current, "entities/globex-ltd.md");
      expect(fm.summary).toBe("Globex Ltd supplies aluminium housings to Acme Widgets Ltd.");
      expect(readSummaryMeta(fm)).toMatchObject({ by: "summaries", method: "model", from: [["operations/globex-supply-agreement/supplier"]] });
      expect(String(fm.summary)).not.toMatch(/1999|Initech/);
      // The prompt carries the node's facts and its own marker, never the writer's.
      expect(calls[0].user).toContain("NODES (JSON):");
      expect(calls[0].user).not.toContain("ITEMS (JSON):");
      expect(readCosts(state, "run-1").filter((c) => c.operation === "node-summaries")).toHaveLength(r.model.calls);

      // Again over what it wrote: nothing to do, the model never asked.
      const again = await runSummaries(snap.current, run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: inventingClient(calls), online: true, now: () => NOW });
      expect(again).toMatchObject({ planned: 0, written: 0, unchanged: r.planned });
      expect(again.model.calls).toBe(0);
      expect(commits).toHaveLength(1);
    } finally {
      dropState(state);
    }
  });

  it("asks the model once for a neighbourhood it could not summarise: the facts write it, the next run asks nothing", async () => {
    const state = tmpState();
    try {
      const snap = { current: vault() };
      const { run, commits } = fakeRun(snap);
      const calls: FlashRequest[] = [];
      const silent: FlashClient = { model: "deepseek-v4-flash", complete: async (req) => (calls.push(req), { text: "[]", model: "deepseek-v4-flash", usage: { promptTokens: 300, completionTokens: 2, cacheHitTokens: 0 } }) };
      const opts = { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: silent, online: true, now: () => NOW };
      const first = await runSummaries(snap.current, run, opts);
      expect(first.rejectedPages).toBe(first.planned);
      expect(first.byFacts).toBe(first.planned);
      expect(readSummaryMeta(fmOf(snap.current, "entities/globex-ltd.md"))).toMatchObject({ method: "facts", tried: true });
      const asked = calls.length;
      const again = await runSummaries(snap.current, run, opts);
      expect(again).toMatchObject({ planned: 0, written: 0 });
      expect(calls).toHaveLength(asked);
      expect(commits).toHaveLength(1);

      // A facts' summary written offline is due the model once it can write; until it does, it is left as it is.
      const offline = { current: vault() };
      const off = fakeRun(offline);
      await runSummaries(offline.current, off.run, { ...opts, online: false });
      const capped = await runSummaries(offline.current, off.run, { ...opts, settings: settings({ capUsd: 0 }) });
      expect(capped.byReason.upgrade).toBe(capped.planned);
      expect(capped).toMatchObject({ written: 0, byFacts: 0, model: { calls: 0, skipped: "cost_cap" } });
      expect(off.commits).toHaveLength(1);
    } finally {
      dropState(state);
    }
  });

  it("keeps a model summary whose neighbourhood changed until the model can write again, and never writes over a page edited since the plan", async () => {
    const state = tmpState();
    try {
      const snap = { current: vault() };
      const { run } = fakeRun(snap);
      await runSummaries(snap.current, run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: inventingClient([]), online: true, now: () => NOW });
      const before = fmOf(snap.current, "entities/globex-ltd.md");
      expect(readSummaryMeta(before)?.method).toBe("model");

      // A neighbour says something new; the model is off tonight: the model's summary stands, the page waits.
      const audit = vaultPage("concepts/globex-audit.md", page({ title: "Globex audit", claims: [claim("finance/globex-audit/result", "Globex Ltd passed the 2026 supplier audit.")] }, "Audit of [[entities/globex-ltd]].\n"));
      snap.current = { ...snap.current, pages: [...snap.current.pages, audit] };
      const offline = await runSummaries(snap.current, run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, online: false, now: () => NOW });
      expect(offline.waiting).toBeGreaterThanOrEqual(1);
      expect(fmOf(snap.current, "entities/globex-ltd.md")).toEqual(before);

      // A person edits the page between the plan and the write: their text stands, the write is skipped.
      const edited = { current: vault() };
      const racing = fakeRun(edited);
      const person = async (message: string, fn: (tx: VaultTx) => Promise<void>) => {
        const target = edited.current.pages.find((p) => p.path === "entities/globex-ltd.md")!;
        edited.current = { ...edited.current, pages: [...edited.current.pages.filter((p) => p !== target), vaultPage(target.path, `${target.text}\nA line a person added.\n`)] };
        return racing.run(message, fn);
      };
      const r = await runSummaries(edited.current, person, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, online: false, now: () => NOW });
      expect(r.written).toBe(r.planned - 1);
      const kept = edited.current.pages.find((p) => p.path === "entities/globex-ltd.md")!;
      expect(kept.text).toContain("A line a person added.");
      expect(kept.parsed.ok && kept.parsed.frontmatter.summary).toBeFalsy();
    } finally {
      dropState(state);
    }
  });

  it("never calls the model with summaries.maxPages 0 or offline, and says which: every summary is the facts'", async () => {
    const state = tmpState();
    try {
      for (const [opts, skipped] of [
        [{ settings: settings({ maxPages: 0 }), online: true }, "disabled"],
        [{ settings: settings(), online: false }, "offline"],
      ] as const) {
        const calls: FlashRequest[] = [];
        const snap = { current: vault() };
        const r = await runSummaries(snap.current, fakeRun(snap).run, { stateVault: state, rates: DEFAULT_COST_RATES, client: inventingClient(calls), now: () => NOW, ...opts });
        expect(calls).toHaveLength(0);
        expect(r.model).toMatchObject({ calls: 0, asked: 0, usdEstimate: 0, skipped });
        expect(r).toMatchObject({ byModel: 0, byFacts: r.planned, written: r.planned });
        expect(readSummaryMeta(fmOf(snap.current, "entities/globex-ltd.md"))).toMatchObject({ method: "facts" });
        expect(readSummaryMeta(fmOf(snap.current, "entities/globex-ltd.md"))?.tried).toBeUndefined();
      }
    } finally {
      dropState(state);
    }
  });

  it("skips an unchanged neighbourhood and writes a changed one again", async () => {
    const state = tmpState();
    try {
      const snap = { current: vault() };
      const { run } = fakeRun(snap);
      const opts = { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, online: false, now: () => NOW };
      await runSummaries(snap.current, run, opts);
      const audit = vaultPage("concepts/globex-audit.md", page({ title: "Globex audit", claims: [claim("finance/globex-audit/result", "Globex Ltd passed the 2026 supplier audit.", { verified: OWNER, status: "verified" })] }, "Audit of [[entities/globex-ltd]].\n"));
      snap.current = { ...snap.current, pages: [...snap.current.pages, audit] };
      const r = await runSummaries(snap.current, run, opts);
      const changed = planSummaries(snap.current, { domains: DOMAINS });
      expect(changed.jobs).toEqual([]);
      expect(r.byReason.changed).toBeGreaterThanOrEqual(1);
      expect(r.byReason.new).toBe(0);
      expect(fmOf(snap.current, "entities/globex-ltd.md").summary).toMatch(/2026 supplier audit|supplies aluminium/);
      expect(r.unchanged).toBeGreaterThan(0);
    } finally {
      dropState(state);
    }
  });

  it("never spends past the cost cap: a call whose worst case does not fit is not made, its pages get their facts' summary", async () => {
    const state = tmpState();
    try {
      const many: Record<string, string> = {};
      for (let i = 1; i <= 12; i++) many[`concepts/widget-line-${i}.md`] = page({ title: `Widget line ${i}`, claims: [claim(`finance/widget-line-${i}/margin`, `Widget line ${i} has a margin of ${10 + i} percent.`)] }, `Widget line ${i}, see [[entities/globex-ltd]].\n`);
      const snap = { current: vault(many) };
      const plan = planSummaries(snap.current, { domains: DOMAINS, modelAvailable: true });
      expect(plan.jobs.length).toBeGreaterThan(SUMMARY_BATCH);
      // A model that bills every call at its worst case: the cap fits exactly one call.
      const worst = (req: FlashRequest) => ({ promptTokens: Math.ceil((req.system.length + req.user.length) / 3) + 500, completionTokens: req.maxTokens });
      const first = buildSummaryPrompt(plan.jobs.slice(0, SUMMARY_BATCH).map((j) => j.hood));
      const capUsd = worstCaseCallUsd("deepseek-v4-flash", first, summaryMaxTokens(SUMMARY_BATCH), DEFAULT_COST_RATES) * 1.2;
      const calls: FlashRequest[] = [];
      const { run } = fakeRun(snap);
      const r = await runSummaries(snap.current, run, { stateVault: state, settings: settings({ capUsd }), rates: DEFAULT_COST_RATES, client: inventingClient(calls, worst), online: true, now: () => NOW });
      expect(r.model.calls).toBe(1);
      expect(r.model.skipped).toBe("cost_cap");
      expect(r.model.usdEstimate).toBeLessThanOrEqual(capUsd);
      expect(r.byModel).toBe(SUMMARY_BATCH);
      expect(r.byFacts).toBe(plan.jobs.length - SUMMARY_BATCH);
      expect(r.written).toBe(plan.jobs.length);

      // A cap no call fits: no call at all.
      const none = await runSummaries(vault(many), fakeRun({ current: vault(many) }).run, { stateVault: state, settings: settings({ capUsd: 0 }), rates: DEFAULT_COST_RATES, client: inventingClient([]), online: true, now: () => NOW });
      expect(none.model).toMatchObject({ calls: 0, skipped: "cost_cap", usdEstimate: 0 });
    } finally {
      dropState(state);
    }
  });

  it("keeps the pages under the page cap for the model; a failed call leaves the rest to their facts", async () => {
    const state = tmpState();
    try {
      const failing: FlashClient = { model: "deepseek-v4-flash", complete: async () => { throw new FlashCallError("refused", "no credit"); } };
      const r = await runSummaries(vault(), fakeRun({ current: vault() }).run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: failing, online: true, now: () => NOW });
      expect(r.model.skipped).toMatch(/^failed: no credit/);
      expect(r.byModel).toBe(0);
      expect(r.byFacts).toBe(r.planned);
      const capped = await runSummaries(vault(), fakeRun({ current: vault() }).run, { stateVault: state, settings: settings({ maxPages: 1 }), rates: DEFAULT_COST_RATES, client: inventingClient([]), online: true, now: () => NOW });
      expect(capped.model.asked).toBe(1);
      expect(capped.byModel).toBe(1);
      expect(capped.byFacts).toBe(capped.planned - 1);
    } finally {
      dropState(state);
    }
  });

  it("a dry run asks no model, writes nothing, and answers what it would write with the merge suggestions and domain mismatches", async () => {
    const state = tmpState();
    try {
      const calls: FlashRequest[] = [];
      const { run, commits } = fakeRun({ current: vault() });
      const r = await runSummaries(vault(), run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, client: inventingClient(calls), online: true, dryRun: true, now: () => NOW });
      expect(calls).toHaveLength(0);
      expect(commits).toHaveLength(0);
      expect(r).toMatchObject({ dryRun: true, written: 0, model: { skipped: "dry_run" } });
      expect(r.would?.[0]).toMatchObject({ path: "entities/globex-ltd.md", tier: "entity", reason: "new" });
      // The duplicate: the merge tool's own dry run, the summary on the canonical page.
      expect(r.mergeSuggestions).toEqual([
        expect.objectContaining({ into: "entities/maria-ivanova.md", from: ["entities/maria-ivanova-2.md"], reason: "suffix", ok: true, aliases: ["Мария Иванова"] }),
      ]);
      // Her role is hers: "… is the COO of Acme Widgets Ltd" says nothing of Acme's domain.
      expect(r.domainMismatches).toEqual([{ path: "entities/maria-ivanova.md", domain: "finance", suggested: "operations", reason: "role", evidence: 'its role "COO" points to operations' }]);
    } finally {
      dropState(state);
    }
  });

  it("answers the merge tool's refusal as the suggestion when a duplicate may not be merged away (both pages verified by a person)", async () => {
    const state = tmpState();
    try {
      const both = vault({
        "entities/initech.md": page({ type: "entity", title: "Initech", domain: "sales", verified: OWNER }, "Initech buys widgets.\n"),
        "entities/initech-2.md": page({ type: "entity", title: "Initech", domain: "sales", verified: OWNER }, "Initech pays on time.\n"),
      });
      const r = await runSummaries(both, fakeRun({ current: both }).run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, online: false, dryRun: true, now: () => NOW });
      const s = r.mergeSuggestions.find((m) => m.into === "entities/initech.md");
      expect(s).toMatchObject({ from: ["entities/initech-2.md"], reason: "suffix", ok: false, refused: { code: "verified" } });
      expect(s?.claims).toBeUndefined();
    } finally {
      dropState(state);
    }
  });

  it("the stub model answers a summary call with sentences the check keeps", async () => {
    const hood = hoodOf(vault(), "entities/globex-ltd.md");
    const { text } = await createStubFlashClient().complete({ ...buildSummaryPrompt([hood]), maxTokens: summaryMaxTokens(1) });
    const r = checkSentences(parseSummaryResponse(text, 1).get(0) ?? [], hood);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toEqual([]);
  });
});

describe("duplicate entities", () => {
  const ents = (list: Array<[string, string, Partial<PageFrontmatter>?]>) =>
    list.map(([p, title, extra]) => ({ path: p, fm: frontmatter({ type: "entity", title, ...extra }) }));

  it("groups a -2 copy, a Latin/Cyrillic pair and a punctuation variant; never two different people", () => {
    const groups = findDuplicateEntities(
      ents([
        ["entities/globex-ltd.md", "Globex Ltd"],
        ["entities/globex-ltd-2.md", "Globex Ltd."],
        ["entities/ivan-ivanov.md", "Ivan Ivanov"],
        ["entities/ivan-ivanov-cyr.md", "Иван Иванов"],
        ["entities/ivan-petrov.md", "Ivan Petrov"],
        ["entities/petar-petrov.md", "Petar Petrov"],
        ["entities/petar-petrov-bg.md", "Петър Петров"],
      ]),
    );
    expect(groups).toEqual([
      { canonical: "entities/globex-ltd.md", duplicates: ["entities/globex-ltd-2.md"], reason: "suffix", key: "globeks ltd" },
      { canonical: "entities/ivan-ivanov.md", duplicates: ["entities/ivan-ivanov-cyr.md"], reason: "script", key: "ivan ivanov" },
      { canonical: "entities/petar-petrov.md", duplicates: ["entities/petar-petrov-bg.md"], reason: "script", key: "petar petrov" },
    ]);
  });

  it("makes a verified page, then the most linked one, the canonical page", () => {
    const [g] = findDuplicateEntities(ents([["entities/acme.md", "Acme"], ["entities/acme-2.md", "ACME", { verified: OWNER }]]));
    expect(g.canonical).toBe("entities/acme-2.md");
    const [h] = findDuplicateEntities(ents([["entities/initech.md", "Initech"], ["entities/initech-co.md", "Initech"]]), (p) => (p === "entities/initech-co.md" ? 9 : 1));
    expect(h.canonical).toBe("entities/initech-co.md");
  });

  it("spells names alike whatever the transliteration", () => {
    expect(nameSkeleton("Мария Иванова")).toBe(nameSkeleton("Maria Ivanova"));
    expect(nameSkeleton("Цветан Цветанов")).toBe(nameSkeleton("Tsvetan Tsvetanov"));
    expect(nameSkeleton("Ivan Ivanov")).not.toBe(nameSkeleton("Ivan Petrov"));
  });
});

describe("domain mismatch", () => {
  const known = new Set(DOMAINS);

  it("suggests the domain a role names, when that domain exists", () => {
    expect(suggestDomain("finance", ["Maria Ivanova is the COO of Acme Widgets Ltd."], [], known)).toMatchObject({ suggested: "operations", reason: "role" });
    // "coo" inside a word is no COO; a domain the vault lacks is never suggested.
    expect(suggestDomain("finance", ["The cooperation runs well."], [], known)).toBeNull();
    expect(suggestDomain("finance", ["She is our general counsel."], [], known)).toBeNull();
    expect(suggestDomain("operations", ["Maria Ivanova is the COO."], [], known)).toBeNull();
  });

  it("else the domain a clear majority of its linked pages share", () => {
    expect(suggestDomain("sales", [], ["finance", "finance", "finance", "finance", "operations", "general"], known)).toMatchObject({ suggested: "finance", reason: "neighbours", evidence: "4 of 5 linked pages are in finance" });
    expect(suggestDomain("sales", [], ["finance", "finance", "operations", "operations", "sales"], known)).toBeNull();
    expect(suggestDomain("sales", [], ["finance", "finance", "finance"], known)).toBeNull();
  });

  it("is a lint warning with the suggested domain, beside the duplicate-entity warning", () => {
    const report = lintVault(vault(), { domains: DOMAINS });
    expect(LINT_RULES).toContain("domain-mismatch");
    const mismatch = report.findings.filter((f) => f.rule === "domain-mismatch");
    expect(mismatch).toEqual([
      expect.objectContaining({ path: "entities/maria-ivanova.md", severity: "warning", blocksCommit: false, details: { domain: "finance", suggested: "operations", reason: "role" } }),
    ]);
    expect(mismatch[0].message).toBe('filed under finance, but its role "COO" points to operations; suggested domain: operations');
    const dup = report.findings.filter((f) => f.rule === "duplicate-entity");
    expect(dup).toEqual([expect.objectContaining({ path: "entities/maria-ivanova-2.md", severity: "warning", details: { canonical: "entities/maria-ivanova.md", reason: "suffix" } })]);
    // Scoped lint judges only the scoped pages.
    expect(lintVault(vault(), { domains: DOMAINS, scope: ["entities/globex-ltd.md"] }).findings.filter((f) => f.rule === "domain-mismatch" || f.rule === "duplicate-entity")).toEqual([]);
  });

  it("judges every entity when asked over the whole vault, and none when the vault knows one domain", () => {
    const pages = [{ path: "entities/x-corp.md", fm: frontmatter({ type: "entity", title: "X Corp", domain: "finance", claims: [claim("finance/x-corp/cfo", "X Corp's CFO signs the budget.")] }) }];
    expect(domainMismatches(pages, () => [], { configured: ["finance"] })).toEqual([]);
  });
});

describe("where the summary shows", () => {
  it("the Map card, the page list and the page header read the generated summary; the stub is the fallback", async () => {
    const state = tmpState();
    try {
      const snap = { current: vault() };
      const stub = snap.current.pages.find((p) => p.path === "entities/globex-ltd.md")!;
      expect(listEntry(stub).summary).toBe("Globex Ltd is named on 4 pages of this wiki.");
      await runSummaries(snap.current, fakeRun(snap).run, { stateVault: state, settings: settings(), rates: DEFAULT_COST_RATES, online: false, now: () => NOW });
      const written = snap.current.pages.find((p) => p.path === "entities/globex-ltd.md")!;
      if (!written.parsed.ok) throw new Error("unparsed");
      const fm = written.parsed.frontmatter;
      expect(generatedSummary(fm)).toMatchObject({ method: "facts", text: expect.stringMatching(/^Globex Ltd supplies aluminium housings to Acme Widgets Ltd\./) });
      expect(pageBlurb(fm, written.parsed.body)).toBe(generatedSummary(fm)!.text);
      expect(listEntry(written).summary).toBe(generatedSummary(fm)!.text);
      // The body keeps its line, byte for byte: the fallback when the summary goes.
      expect(written.parsed.body).toContain("Globex Ltd is named on 4 pages of this wiki.");
    } finally {
      dropState(state);
    }
  });
});

describe("settings", () => {
  it("has a summaries section with caps, validated whole", () => {
    expect(defaultSettings().summaries).toEqual({ enabled: true, maxPages: 150, capUsd: 0.25 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-summaries-settings-"));
    try {
      expect(writeSettings({ summaries: { maxPages: 10, capUsd: 1.5 } }, root).summaries).toEqual({ enabled: true, maxPages: 10, capUsd: 1.5 });
      expect(readSettings(root).summaries.maxPages).toBe(10);
      expect(() => writeSettings({ summaries: { maxPages: -1 } }, root)).toThrow(SettingsError);
      expect(() => writeSettings({ summaries: { capUsd: 1000 } }, root)).toThrow(SettingsError);
      expect(() => readSettingsPatch({ summaries: { model: "x" } })).toThrow(/Unknown setting: summaries\.model/);
      expect(writeSettings({ summaries: null }, root).summaries).toEqual(defaultSettings().summaries);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
