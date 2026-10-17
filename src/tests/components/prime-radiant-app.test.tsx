import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import PrimeRadiantApp from "@/components/PrimeRadiantApp";
import { I18nProvider, useT } from "@/lib/i18n";
import { OPEN_APP_EVENT } from "@/lib/ui-events";
import { PRIME_RADIANT_CHANGED_EVENT, prJson } from "@/components/prime-radiant-ui";
import { stubLocation } from "@/tests/helpers/session-switch";

/**
 * The Prime Radiant window over a fake set of its routes: the first open
 * creates the vault, and every tab reads and writes the route it is meant to.
 * Fixtures are synthetic company data only.
 *
 * `I18nProvider` loads its catalogue through a dynamic import, so the first
 * mount pays for that before a translated word is on screen (the Memory Shard
 * suite's reason for the same ceilings).
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const STATUS = {
  initialised: true,
  vault: { path: "/tmp/vault", pages: 2, invalidPages: 0, verifiedPages: 1, claims: 3, domains: ["sales"], truncated: false },
  git: { branch: "main", head: null, commits: 4 },
  plugin: { state: "wired", vault: "/tmp/vault" },
  lint: { errors: 0, warnings: 1, ok: true },
};

const FM = {
  type: "entity",
  title: "Acme Widgets Ltd",
  domain: "sales",
  owner: "sales-team",
  status: "stable",
  generated: { at: "2026-01-02T10:00:00.000Z", by: "flash" },
  verified: null,
  stale_after: null,
  sources: ["upload/batch-1/acme-overview.md"],
  privacy: "internal",
  checked_by: "flash",
  opus_pending: false,
  claims: [
    {
      id: "sales/acme-widgets/hq-city",
      text: "Acme Widgets Ltd is based in Springfield.",
      confidence: 0.9,
      status: "verified",
      updatedAt: "2026-01-02T10:00:00.000Z",
      evidence: [{ kind: "source", path: "upload/batch-1/acme-overview.md" }],
      verified: { at: "2026-01-03T10:00:00.000Z", by: "owner" },
    },
  ],
  retiredClaimIds: [],
};

const PAGE = {
  path: "entities/acme-widgets.md",
  valid: true,
  frontmatter: FM,
  errors: null,
  body: "Acme Widgets Ltd sells widgets.",
  summary: "Acme Widgets Ltd sells widgets.",
  verified: true,
  backlinks: ["concepts/widget-pricing.md"],
  links: [],
  inIndex: true,
  lint: { scope: ["entities/acme-widgets.md"], checked: 1, findings: [], errors: 0, warnings: 0, ok: true },
};

/** What the Map's graph route answers: the two pages, linked. */
const GRAPH = {
  revision: "f".repeat(40),
  truncated: false,
  nodes: [
    { id: "entities/acme-widgets.md", title: "Acme Widgets Ltd", domain: "sales", degree: 1, sources: 1 },
    { id: "concepts/widget-pricing.md", title: "Widget pricing", domain: "sales", degree: 1, sources: 0 },
  ],
  edges: [[0, 1, 1]],
};

const LIST_ENTRY = {
  path: "entities/acme-widgets.md", valid: true, title: "Acme Widgets Ltd", type: "entity", domain: "sales", owner: "sales-team",
  status: "stable", privacy: "internal", verified: true, claims: 1, summary: "Acme Widgets Ltd sells widgets.", bodyChars: 30, mtimeMs: 1,
};

const REVIEW_ITEM = {
  id: "rev-0123456789ab",
  kind: "contradiction",
  claimId: "sales/acme-widgets/employees",
  pages: ["entities/acme-widgets.md"],
  candidates: [
    { text: "Acme Widgets Ltd has 40 employees.", page: "entities/acme-widgets.md", claimId: "sales/acme-widgets/employees", evidence: [{ kind: "source", note: "2025 report" }] },
    { text: "Acme Widgets Ltd has 55 employees.", page: "concepts/widget-pricing.md", claimId: "sales/acme-widgets/headcount", evidence: [] },
  ],
  evidence: [{ kind: "judge", verdict: "contradiction" }],
  status: "open",
  createdAt: "2026-01-04T10:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  runId: null,
};

const JOB_BASE = {
  kind: "folders", folders: ["~/acme-docs"], total: 3, done: 0, failed: 0, skipped: 0, duplicates: 0, pages: 0, commits: 0, calls: 0,
  usdEstimate: 0, createdAt: "2026-01-06T10:00:00.000Z", updatedAt: "2026-01-06T10:00:00.000Z", finishedAt: null, error: null, notes: [],
  retryOf: null, requeued: 0, deadLetter: 0,
  skips: { codeProject: 0, excludedFolder: 0, boilerplate: 0, temp: 0, machineText: 0, tooLarge: 0, unsupported: 0 },
};
const NO_SKIPS = JOB_BASE.skips;
/** What the fake preview route answers for the picked folders. */
const PREVIEW = {
  documents: 3,
  skips: { ...NO_SKIPS, codeProject: 2, boilerplate: 4, machineText: 1, unsupported: 12 },
  topFolders: [{ label: "~/acme-docs/contracts", documents: 2 }, { label: "~/acme-docs", documents: 1 }],
  codeProjects: ["~/acme-docs/site", "~/acme-docs/tools"],
  truncated: false,
  limit: 5000,
  notes: [],
};
const RUNNING_JOB = { ...JOB_BASE, id: "job-run", status: "running", phase: "write" };
const DEAD_JOB = { ...JOB_BASE, id: "job-dead", status: "done", phase: "done", done: 2, failed: 1, pages: 2, deadLetter: 1, finishedAt: "2026-01-05T10:00:00.000Z" };

/** A stand-in for the browser's EventSource: the test plays the server's frames. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() { this.closed = true; }
}

interface Call { url: string; method: string; body: unknown }

const GOLDEN_Q = {
  id: "gq-00000000000a", question: "What does the blue widget cost?", expected: "10 EUR", owner: "Иван Иванов", domain: "sales",
  claimId: null, page: "entities/acme-widgets.md", createdAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-01-02T10:00:00.000Z",
};
const GOLDEN_SCORE = {
  questions: 1,
  last: { id: "run-0123456789ab", runId: "run-0123456789ab", at: "2026-01-05T03:10:00.000Z", asked: 4, correct: 3, wrong: 1, missing: 0, stale: 0, failed: 0, percent: 75 },
  trend: [{ at: "2026-01-04T03:10:00.000Z", percent: 50 }, { at: "2026-01-05T03:10:00.000Z", percent: 75 }],
  change: 25,
};
const DAILY_OWNERS = {
  initialised: true, outbound: false, perOwner: 5, owner: null, language: null, questions: [],
  owners: [{ owner: "Иван Иванов", domains: ["sales"], pages: 2, language: "bg", waiting: 1 }],
};
const DAILY_MINE = {
  ...DAILY_OWNERS, owner: "Иван Иванов", language: "bg",
  questions: [{
    kind: "claim", owner: "Иван Иванов", domain: "sales", page: "entities/acme-widgets.md", title: "Acme Widgets Ltd", claimId: "sales/acme-widgets/hq-city",
    text: "Based in Springfield.", question: "Още ли е вярно? „Based in Springfield.“ (Acme Widgets Ltd)",
    answer: { tool: "prime_radiant_claim_verify", args: { id: "sales/acme-widgets/hq-city" } },
  }],
};
let goldenQuestions: unknown[];
/** A settings PUT the server refuses (the Questions tab's Checks). */
let refuseSettingsPut: boolean;

let status: Record<string, unknown>;
let calls: Call[];
let searchStatus: number;
let searchAnswer: Record<string, unknown>;
/** A held answer for `GET review?status=…`, released by the test. */
let reviewGate: Promise<void> | null;
let reviewItems: unknown[];
let nightlyRuns: unknown[];
const INGEST_COMMIT = { sha: "a".repeat(40), subject: "ingest: acme-overview.md", at: "2026-01-02T10:00:00.000Z", author: "Prime Radiant" };
let historyCommits: unknown[];
let pageOverride: unknown;
let ingestJobs: unknown[];
/** Refusals the fake answers the next `DELETE ingest/<id>` calls with, first first. */
let stopRefusals: number[];
let previewAnswer: Record<string, unknown> | null;
let skipCodeProjects: boolean;
/** The settings GET's Opus source and page cap; null answers as an older server (neither field). */
let opusExtras: { source: "api_key" | "subscription" | "none"; maxPages: number } | null;
/** The search index size limit, MB, on a server that has the setting (null: an older one). */
let searchIndexLimitMb: number | null;
/** The structure pass's settings section; null: a server from before it. */
let structureSettings: { enabled: boolean; company: string; enrichTop: number; modelFallback: number } | null;
/** What `POST init` says its one-time memory-wiki repair did. */
let initRepair: Record<string, unknown> | null;
/** What `GET pages?…` lists. */
let listed: unknown[];

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });
    const ok = (json: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => json });
    if (url.startsWith("/setup-api/preferences")) return ok({ ui_language: "en" });
    const p = "/setup-api/prime-radiant";
    if (url === `${p}/status`) return ok(status);
    if (url === `${p}/init` && method === "POST") {
      const created = !status.initialised;
      status = { ...status, initialised: true, plugin: { state: "wired", vault: "/tmp/vault" } };
      return ok({ created, plugin: { state: "wired", wrote: true }, repair: initRepair });
    }
    if (url.startsWith(`${p}/pages?`)) return ok({ total: listed.length, pages: listed });
    if (url === `${p}/graph`) return ok(listed.length > 0 ? GRAPH : { revision: null, truncated: false, nodes: [], edges: [] });
    if (url === `${p}/pages/entities/acme-widgets.md`) return ok(pageOverride ?? PAGE);
    if (url.startsWith(`${p}/search?`)) {
      if (searchStatus === 404) return ok({ error: "Not found" }, 404);
      return ok(searchAnswer);
    }
    if (url.startsWith(`${p}/review?`)) {
      if (reviewGate && url.includes("status=open")) await reviewGate;
      const items = reviewItems;
      return ok({ total: items.length, counts: { open: items.length, later: 0, resolved: 0 }, items });
    }
    if (url.startsWith(`${p}/review/`) && method === "POST") {
      reviewItems = [];
      return ok({ item: { ...REVIEW_ITEM, status: "resolved" }, commit: "abc1234", retired: [] });
    }
    if (url === `${p}/nightly`) return ok({ running: null, nextRunAt: null, runs: nightlyRuns });
    if (url === `${p}/nightly/run` && method === "POST") return ok({ branch: "dream/2026-01-05", commit: "def5678abc", changed: [] });
    if (url.startsWith(`${p}/history/`)) {
      return ok({ path: "entities/acme-widgets.md", commits: historyCommits });
    }
    if (url.startsWith(`${p}/diff?`)) return ok({ from: null, to: "a".repeat(40), path: "entities/acme-widgets.md", commit: null, files: [], diff: "+added line", truncated: false });
    if (url === `${p}/revert` && method === "POST") return ok({ reverted: "a".repeat(40), commit: "b".repeat(40), changed: [] });
    if (url.startsWith(`${p}/lint`)) return ok({ scope: "all", checked: 2, findings: [], errors: 0, warnings: 0, ok: true });
    if (url === `${p}/costs`) {
      return ok({
        basis: "estimate", currency: "USD", rates: {}, since: null,
        totals: { calls: 3, tokensIn: 1200, tokensOut: 300, usdEstimate: 0.0042 },
        byOperation: [{ operation: "ingest", calls: 3, tokensIn: 1200, tokensOut: 300, usdEstimate: 0.0042 }],
        byModel: [{ model: "deepseek-v4-flash", calls: 3, tokensIn: 1200, tokensOut: 300, usdEstimate: 0.0042 }],
        byRun: [
          { runId: "job-1", kind: "ingest", firstAt: "2026-01-02T10:00:00.000Z", lastAt: "2026-01-02T10:01:00.000Z", calls: 3, tokensIn: 1200, tokensOut: 300, usdEstimate: 0.0042 },
          { runId: "job-dead", kind: "ingest", firstAt: "2026-01-05T10:00:00.000Z", lastAt: "2026-01-05T10:01:00.000Z", calls: 2, tokensIn: 4000, tokensOut: 600, usdEstimate: 0.01 },
          { runId: "run-0123456789ab", kind: "nightly", firstAt: "2026-01-05T03:00:00.000Z", lastAt: "2026-01-05T03:05:00.000Z", calls: 1, tokensIn: 1000, tokensOut: 0, usdEstimate: 0.3 },
          { runId: "job-night", kind: "ingest", firstAt: "2026-01-05T03:01:00.000Z", lastAt: "2026-01-05T03:02:00.000Z", calls: 1, tokensIn: 400, tokensOut: 100, usdEstimate: 0.12 },
        ],
        notMeasured: [{ operation: "embedding", reason: "no_usage_reported" }],
      });
    }
    if (url.startsWith("/setup-api/coding-agent/browse")) {
      return ok({ root: "/srv/box", path: "/srv/box/acme-docs", parent: "/srv/box", entries: [] });
    }
    if (url === `${p}/ingest/preview` && method === "POST") {
      if (!previewAnswer) return ok({ error: "The folders could not be counted.", code: "preview_failed" }, 500);
      return ok({ preview: previewAnswer });
    }
    if (url === `${p}/ingest` && method === "POST") return ok({ job: RUNNING_JOB }, 202);
    if (url === `${p}/ingest`) return ok({ running: null, jobs: ingestJobs });
    if (url === `${p}/ingest/job-dead/retry` && method === "POST") return ok({ job: { ...RUNNING_JOB, id: "job-retry", kind: "retry" } }, 202);
    if (url === `${p}/ingest/job-dead`) return ok({ job: DEAD_JOB, deadLetter: [{ seq: 1, label: "~/acme-docs/broken.pdf", error: "unreadable", attempts: 2, bytes: 10 }] });
    if (url.startsWith(`${p}/ingest/`) && method === "DELETE") {
      const refusal = stopRefusals.shift();
      if (refusal) return ok({ error: "The job could not be stopped", code: "stop_failed" }, refusal);
      return ok({ stopping: true, job: RUNNING_JOB }, 202);
    }
    if (url === `${p}/golden` && method === "POST") {
      const question = { ...GOLDEN_Q, id: "gq-00000000000b", ...(body as Record<string, unknown>) };
      goldenQuestions = [...goldenQuestions, question];
      return ok({ question, commit: "c".repeat(40) }, 201);
    }
    if (url === `${p}/golden`) return ok({ questions: goldenQuestions, verdicts: { [GOLDEN_Q.id]: { verdict: "correct", why: "same", at: "2026-01-05T03:10:00.000Z" } }, score: GOLDEN_SCORE });
    if (url.startsWith(`${p}/golden/`) && method === "PATCH") {
      return ok({ error: "A golden question cannot hold a secret: it contains a password.", code: "lint_blocked" }, 409);
    }
    if (url.startsWith(`${p}/golden/`) && method === "DELETE") {
      goldenQuestions = goldenQuestions.filter((q) => !url.endsWith((q as { id: string }).id));
      return ok({ question: GOLDEN_Q, commit: "d".repeat(40) });
    }
    if (url.startsWith(`${p}/daily`)) return ok(url.includes("owner=") ? DAILY_MINE : DAILY_OWNERS);
    if (url === `${p}/settings` && method === "PUT" && refuseSettingsPut) return ok({ error: "The settings could not be saved.", code: "vault_unavailable" }, 503);
    if (url === `${p}/settings`) {
      const settings = {
        ingest: { exclude: [".git", "node_modules"], skipCodeProjects, parallel: 128, folders: [] },
        costRates: {}, nightly: { enabled: true, time: "03:00" },
        opus: { enabled: false, capUsd: 2, sampleRate: 0.02, model: "opus", ...(opusExtras ? { maxPages: opusExtras.maxPages } : {}) },
        contradictions: { enabled: true }, domains: [],
        golden: { enabled: true, maxQuestions: 50 }, verification: { perOwner: 5, outbound: false, languages: [] },
        ...(searchIndexLimitMb !== null ? { search: { indexLimitMb: searchIndexLimitMb } } : {}),
        ...(structureSettings ? { structure: structureSettings } : {}),
      };
      return ok({
        settings, defaults: searchIndexLimitMb !== null ? { ...settings, search: { indexLimitMb: 160 } } : settings,
        limits: {
          ingestParallel: { min: 1, max: 256 }, ingestFolders: 20, opusCapUsd: { min: 0.01, max: 1000 }, opusSampleRate: { min: 0, max: 1 }, domains: 100,
          ...(opusExtras ? { opusMaxPages: { min: 4, max: 2000 } } : {}),
          ...(searchIndexLimitMb !== null ? { searchIndexLimitMb: { min: 32, max: 4096 } } : {}),
        },
        nightly: { nextRunAt: null }, rates: {},
        ...(opusExtras ? { opusSource: opusExtras.source } : {}),
      });
    }
    return ok({}, 404);
  }));
}

/** Reads one word through the provider's own `t`: it is English only once the catalogue is in. */
function CatalogueProbe() {
  const { t } = useT();
  return <span hidden data-testid="catalogue-probe">{t("primeRadiant.subtitle")}</span>;
}

/** Mount, and wait for the catalogue: every assertion here is about words. */
async function mount() {
  const view = render(<I18nProvider><CatalogueProbe /><PrimeRadiantApp /></I18nProvider>);
  await waitFor(() => expect(screen.getByTestId("catalogue-probe")).toHaveTextContent("living wiki"));
  return view;
}

async function openTab(id: string) {
  fireEvent.click(await screen.findByTestId(`prime-radiant-tab-${id}`));
}

/** Pick the browse listing's folder in Add documents and wait until it is counted. */
async function pickFolder() {
  fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-add"));
  fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-use"));
  await waitFor(() => expect(screen.getByTestId("prime-radiant-ingest-start")).not.toBeDisabled());
}

beforeEach(() => {
  status = { ...STATUS };
  calls = [];
  searchStatus = 200;
  // The route's real shape: the index leads every chunk with the page title.
  searchAnswer = {
    initialised: true, shardEnabled: true, indexing: false,
    index: { exists: true, pages: 2, chunks: 5, identity: "valid", needsFullScan: false, builtAt: 1 },
    results: [{
      source: "prime-radiant", path: "entities/acme-widgets.md", id: "sales/acme-widgets/hq-city", kind: "claim", type: "entity",
      title: "Acme Widgets Ltd", snippet: "Acme Widgets Ltd: Based in Springfield.", score: 0.92, similarity: 0.82, verified: true,
    }],
  };
  reviewGate = null;
  reviewItems = [REVIEW_ITEM];
  nightlyRuns = [];
  historyCommits = [INGEST_COMMIT];
  pageOverride = null;
  ingestJobs = [];
  stopRefusals = [];
  previewAnswer = PREVIEW;
  skipCodeProjects = true;
  opusExtras = null;
  searchIndexLimitMb = null;
  structureSettings = null;
  initRepair = { ran: true, cleaned: [], removed: [], commit: null };
  window.localStorage.removeItem("clawbox.primeRadiant.repairNoticeSeen");
  listed = [LIST_ENTRY];
  goldenQuestions = [GOLDEN_Q];
  refuseSettingsPut = false;
  FakeEventSource.last = null;
  installFetch();
  // The Map's canvas: no WebGL or 2D context in jsdom (its own suite mocks one), so it lists the pages.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrimeRadiantApp", () => {
  it("shows English, never a key, before the catalogue is in", () => {
    // No provider: `t` answers every key with itself, as before the catalogue loads.
    render(<PrimeRadiantApp />);
    expect(screen.getByTestId("prime-radiant-subtitle")).toHaveTextContent("living wiki");
    expect(screen.getByTestId("prime-radiant-loading")).toHaveTextContent("Loading…");
    expect(screen.getByTestId("prime-radiant-app").textContent).not.toMatch(/primeRadiant\./);
  });

  it("creates the vault once on the first open, then shows the wiki", async () => {
    status = { ...STATUS, initialised: false };
    await mount();
    expect(await screen.findByTestId("prime-radiant-tab-browse")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/init") && c.method === "POST")).toHaveLength(1);
    expect(screen.getByTestId("prime-radiant-subtitle")).toHaveTextContent("living wiki");
  });

  it("does not create anything when the vault is already there", async () => {
    await mount();
    await screen.findByTestId("prime-radiant-tab-browse");
    expect(calls.some((c) => c.url.endsWith("/init"))).toBe(false);
  });

  // The live test: a box wired before memory-wiki's vault writers were known
  // let the plugin compile into the vault. Its wiring now `needs-write`.
  it("re-wires a vault whose memory-wiki wiring still needs a write, once, in the background, and says what was cleaned once, over Pages", async () => {
    status = { ...STATUS, plugin: { state: "needs-write", vault: "/tmp/vault", writes: [{ key: "plugins.entries.memory-wiki.config.render.createBacklinks", value: false }] } };
    initRepair = { ran: true, cleaned: ["concepts/a.md", "concepts/b.md", "index.md"], removed: ["WIKI.md", "entities/index.md"], commit: "abc1234" };
    await mount();
    expect(await screen.findByTestId("prime-radiant-tab-map")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/status")).length).toBeGreaterThanOrEqual(2));
    // Never over the Map.
    expect(screen.queryByTestId("prime-radiant-repaired")).toBeNull();
    fireEvent.click(screen.getByTestId("prime-radiant-tab-browse"));
    const notice = await screen.findByTestId("prime-radiant-repaired");
    expect(notice).toHaveTextContent("3 page(s) cleaned, 2 file(s) removed");
    expect(calls.filter((c) => c.url.endsWith("/init") && c.method === "POST")).toHaveLength(1);
    // Said once: remembered as soon as it is on screen, and it can be put away.
    expect(window.localStorage.getItem("clawbox.primeRadiant.repairNoticeSeen")).toBe("1");
    fireEvent.click(within(notice).getByTestId("prime-radiant-repaired-dismiss"));
    expect(screen.queryByTestId("prime-radiant-repaired")).toBeNull();
  });

  it("says what the repair cleaned when the first open of an existing vault runs it", async () => {
    // Not initialised yet, but the folder already held plugin writes: the
    // first POST init runs the one-time repair, and its answer is not lost.
    status = { ...STATUS, initialised: false };
    initRepair = { ran: true, cleaned: ["concepts/a.md"], removed: ["WIKI.md"], commit: "abc1234" };
    await mount();
    fireEvent.click(await screen.findByTestId("prime-radiant-tab-browse"));
    const notice = await screen.findByTestId("prime-radiant-repaired");
    expect(notice).toHaveTextContent("1 page(s) cleaned, 1 file(s) removed");
    expect(calls.filter((c) => c.url.endsWith("/init") && c.method === "POST")).toHaveLength(1);
  });

  it("does not say what the repair cleaned again once it has been seen", async () => {
    window.localStorage.setItem("clawbox.primeRadiant.repairNoticeSeen", "1");
    status = { ...STATUS, plugin: { state: "needs-write", vault: "/tmp/vault", writes: [{ key: "plugins.entries.memory-wiki.config.render.createBacklinks", value: false }] } };
    initRepair = { ran: true, cleaned: ["concepts/a.md"], removed: [], commit: "abc1234" };
    await mount();
    fireEvent.click(await screen.findByTestId("prime-radiant-tab-browse"));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/status")).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId("prime-radiant-repaired")).toBeNull();
  });

  it("says the plugin was set by hand to write into the wiki when that is the only conflict", async () => {
    status = { ...STATUS, plugin: { state: "conflict", vault: "/tmp/vault", conflicts: ["plugin-writes"], writes: [] } };
    await mount();
    expect(await screen.findByTestId("prime-radiant-wiring-conflict")).toHaveTextContent("write its own links, indexes and reports");
    expect(calls.some((c) => c.url.endsWith("/init"))).toBe(false);
  });

  it("keeps the general conflict text for any other conflict", async () => {
    status = { ...STATUS, plugin: { state: "conflict", vault: "/tmp/vault", conflicts: ["other-vault-path", "plugin-writes"], writes: [] } };
    await mount();
    expect(await screen.findByTestId("prime-radiant-wiring-conflict")).toHaveTextContent("may not read this wiki");
  });

  it("opens on the Map when the vault has pages", async () => {
    await mount();
    expect(await screen.findByTestId("prime-radiant-tab-map")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")[0]).toBe(screen.getByTestId("prime-radiant-tab-map"));
    expect(await screen.findByTestId("prime-radiant-map")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/setup-api/prime-radiant/graph")).toBe(true);
  });

  it("has six tabs: Map, Pages, Review, Questions, Add and Settings", async () => {
    await mount();
    await screen.findByTestId("prime-radiant-tab-map");
    const labels = screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");
    expect(labels).toHaveLength(6);
    ["Map", "Pages", "Review", "Questions", "Add", "Settings"].forEach((label, i) => expect(labels[i].endsWith(label)).toBe(true));
  });

  it("lists the failed checks under Review, after the questions", async () => {
    await mount();
    await openTab("review");
    const checks = await screen.findByTestId("prime-radiant-review-checks");
    expect(within(checks).getByText("Checks")).toBeInTheDocument();
    expect(await within(checks).findByTestId("prime-radiant-lint")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-review")).toBeInTheDocument();
  });

  it("opens on Browse, with its call to add documents, when the vault is empty", async () => {
    status = { ...STATUS, vault: { ...STATUS.vault, pages: 0, claims: 0, verifiedPages: 0, domains: [] } };
    listed = [];
    await mount();
    expect(await screen.findByTestId("prime-radiant-tab-browse")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("prime-radiant-empty")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/setup-api/prime-radiant/graph")).toBe(false);
    // The Map, asked for anyway, says the same.
    await openTab("map");
    const empty = await screen.findByTestId("prime-radiant-map-empty");
    fireEvent.click(within(empty).getByRole("button"));
    expect(await screen.findByTestId("prime-radiant-tab-ingest")).toHaveAttribute("aria-selected", "true");
  });

  it("opens a page from the Map in Browse, and Back returns to the Map", async () => {
    await mount();
    const list = await screen.findByTestId("prime-radiant-map-list");
    fireEvent.click(within(list).getAllByRole("button")[0]);
    expect(await screen.findByTestId("prime-radiant-claim")).toHaveTextContent("Acme Widgets Ltd is based in Springfield.");
    expect(screen.getByTestId("prime-radiant-tab-browse")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("prime-radiant-page-back"));
    expect(await screen.findByTestId("prime-radiant-map")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-tab-map")).toHaveAttribute("aria-selected", "true");
  });

  it("opens a page with its facts, confidence, sources and backlinks", async () => {
    await mount();
    await openTab("browse");
    fireEvent.click(await screen.findByTestId("prime-radiant-page-row"));
    const claim = await screen.findByTestId("prime-radiant-claim");
    expect(claim).toHaveTextContent("Acme Widgets Ltd is based in Springfield.");
    expect(claim).toHaveTextContent("sales/acme-widgets/hq-city");
    expect(claim).toHaveTextContent("90%");
    expect(screen.getByTestId("prime-radiant-sources")).toHaveTextContent("upload/batch-1/acme-overview.md");
    expect(screen.getByTestId("prime-radiant-backlinks")).toHaveTextContent("widget-pricing");
  });

  it("says who verified a fact: the owner, the owner via the assistant, or the assistant", async () => {
    const stamp = (verified: Record<string, string>) => ({ ...PAGE, frontmatter: { ...FM, claims: [{ ...FM.claims[0], verified }] } });
    for (const [verified, words] of [
      [{ at: "2026-01-03T10:00:00.000Z", by: "owner", via: "assistant" }, "Verified by the owner (via the assistant)"],
      [{ at: "2026-01-03T10:00:00.000Z", by: "owner" }, "Verified by the owner,"],
      [{ at: "2026-01-03T10:00:00.000Z", by: "assistant" }, "Verified by the assistant,"],
    ] as const) {
      pageOverride = stamp(verified);
      const view = await mount();
      await openTab("browse");
      fireEvent.click(await screen.findByTestId("prime-radiant-page-row"));
      expect(await screen.findByTestId("prime-radiant-claim-verified")).toHaveTextContent(words);
      view.unmount();
    }
  });

  it("filters the page list by domain and type", async () => {
    await mount();
    await openTab("browse");
    await screen.findByTestId("prime-radiant-page-row");
    fireEvent.change(screen.getByTestId("prime-radiant-browse-type"), { target: { value: "entity" } });
    fireEvent.change(screen.getByTestId("prime-radiant-browse-domain"), { target: { value: "sales" } });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/pages?") && c.url.includes("type=entity") && c.url.includes("domain=sales"))).toBe(true);
    });
  });

  it("shows the median links per page beside the counts, flagged while under its target", async () => {
    status = { ...STATUS, links: { pages: 10, median: 3, mean: 3.2, atTarget: 2, target: 5 } };
    await mount();
    const links = await screen.findByTestId("prime-radiant-links");
    expect(links).toHaveTextContent("3 links/page");
    expect(links).toHaveAttribute("title", "Median meaningful links per page (target 5)");
    expect(links.className).toMatch(/amber/);
  });

  it("keeps the window drawn when a refresh answers a status it cannot draw", async () => {
    await mount();
    expect(await screen.findByTestId("prime-radiant-counts")).toBeInTheDocument();
    const reads = () => calls.filter((c) => c.url === "/setup-api/prime-radiant/status").length;
    const before = reads();
    status = { initialised: true } as typeof status;
    fireEvent.click(screen.getByTestId("prime-radiant-refresh"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("prime-radiant-counts")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-app")).toBeInTheDocument();
  });

  it("keeps a candidate answer as the verified fact", async () => {
    await mount();
    await openTab("review");
    const item = await screen.findByTestId("prime-radiant-review-item");
    expect(within(item).getByTestId("prime-radiant-review-claim")).toHaveTextContent("sales/acme-widgets/employees");
    expect(within(item).getAllByTestId("prime-radiant-review-candidate")).toHaveLength(2);
    fireEvent.click(within(item).getAllByTestId("prime-radiant-review-pick")[1]);
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes("/review/rev-0123456789ab/resolve"));
      expect(post?.body).toEqual({ action: "pick", candidate: 1 });
    });
    expect(await screen.findByTestId("prime-radiant-review-empty")).toBeInTheDocument();
  });

  it("never lets a late read for one filter draw over another's queue", async () => {
    await mount();
    await openTab("review");
    await screen.findByTestId("prime-radiant-review-item");
    // The resolve's re-read of the OPEN queue hangs; meanwhile the owner moves to Later.
    let release: () => void = () => undefined;
    reviewGate = new Promise<void>((r) => { release = r; });
    fireEvent.click(screen.getByTestId("prime-radiant-review-later"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/resolve"))).toBe(true));
    reviewItems = [];
    fireEvent.click(screen.getByTestId("prime-radiant-review-status-later"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=later"))).toBe(true));
    expect(await screen.findByTestId("prime-radiant-review-empty")).toBeInTheDocument();
    // The open queue's answer arrives late, still holding the item: it is not drawn.
    reviewItems = [REVIEW_ITEM];
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("prime-radiant-review-item")).toBeNull();
    expect(screen.getByTestId("prime-radiant-review-empty")).toBeInTheDocument();
  });

  it("writes a new answer, and sets an item aside for later", async () => {
    await mount();
    await openTab("review");
    fireEvent.click(await screen.findByTestId("prime-radiant-review-add-new"));
    fireEvent.change(screen.getByTestId("prime-radiant-review-answer"), { target: { value: "Acme Widgets Ltd has 48 employees." } });
    fireEvent.click(screen.getByTestId("prime-radiant-review-save-new"));
    await waitFor(() => {
      expect(calls.find((c) => c.url.includes("/resolve"))?.body).toEqual({ action: "new", text: "Acme Widgets Ltd has 48 employees." });
    });

    reviewItems = [REVIEW_ITEM];
    calls = [];
    fireEvent.click(screen.getByTestId("prime-radiant-review-status-later"));
    fireEvent.click(screen.getByTestId("prime-radiant-review-status-open"));
    fireEvent.click(await screen.findByTestId("prime-radiant-review-later"));
    await waitFor(() => {
      expect(calls.find((c) => c.url.includes("/resolve"))?.body).toEqual({ action: "later" });
    });
  });

  it("searches inside pages from the Pages field and opens a hit", async () => {
    await mount();
    await openTab("browse");
    fireEvent.change(await screen.findByTestId("prime-radiant-browse-q"), { target: { value: "headquarters" } });
    fireEvent.keyDown(screen.getByTestId("prime-radiant-browse-q"), { key: "Enter" });
    const hit = await screen.findByTestId("prime-radiant-search-hit");
    expect(calls.find((c) => c.url.includes("/search?"))?.url).toContain("limit=20");
    // The title is the row's; the snippet drops the lead the index gave it.
    expect(hit).toHaveTextContent("Based in Springfield.");
    expect(hit.textContent?.match(/Acme Widgets Ltd/g)).toHaveLength(1);
    expect(hit).toHaveTextContent("sales/acme-widgets/hq-city");
    expect(hit).toHaveTextContent("92%");
    fireEvent.click(hit);
    expect(await screen.findByTestId("prime-radiant-page")).toBeInTheDocument();
  });

  it("filters the list as the owner types, and searches inside pages only when asked", async () => {
    await mount();
    await openTab("browse");
    fireEvent.change(await screen.findByTestId("prime-radiant-browse-q"), { target: { value: "acme" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("/pages?") && c.url.includes("q=acme"))).toBe(true));
    expect(calls.some((c) => c.url.includes("/search?"))).toBe(false);
    fireEvent.click(screen.getByTestId("prime-radiant-search-go"));
    expect(await screen.findByTestId("prime-radiant-search-hit")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prime-radiant-search-close"));
    expect(screen.queryByTestId("prime-radiant-search")).toBeNull();
    expect(screen.getByTestId("prime-radiant-search-go")).not.toBeDisabled();
  });

  it("says when Memory Shard is off and when the index is still being built", async () => {
    await mount();
    await openTab("browse");
    searchAnswer = { initialised: true, shardEnabled: false, indexing: false, results: [] };
    fireEvent.change(await screen.findByTestId("prime-radiant-browse-q"), { target: { value: "widgets" } });
    fireEvent.click(screen.getByTestId("prime-radiant-search-go"));
    await waitFor(() => expect(screen.getByTestId("prime-radiant-search-notice")).toHaveAttribute("data-notice", "shardOff"));

    searchAnswer = {
      initialised: true, shardEnabled: true, indexing: true,
      index: { exists: false, pages: 0, chunks: 0, identity: "missing", needsFullScan: true, builtAt: null }, results: [],
    };
    await waitFor(() => expect(screen.getByTestId("prime-radiant-search-go")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("prime-radiant-search-go"));
    await waitFor(() => expect(screen.getByTestId("prime-radiant-search-notice")).toHaveAttribute("data-notice", "indexing"));
    expect(screen.queryByTestId("prime-radiant-search-hit")).toBeNull();
  });

  it("says search is not on this box yet when the route is missing", async () => {
    searchStatus = 404;
    await mount();
    await openTab("browse");
    fireEvent.change(await screen.findByTestId("prime-radiant-browse-q"), { target: { value: "widgets" } });
    fireEvent.click(screen.getByTestId("prime-radiant-search-go"));
    const notice = await screen.findByTestId("prime-radiant-search-notice");
    expect(notice).toHaveAttribute("data-notice", "unavailable");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("labels a verification in History: verified by the owner (via the assistant)", async () => {
    historyCommits = [
      { sha: "c".repeat(40), subject: "verify: sales/acme-widgets/hq-city", at: "2026-01-03T10:00:00.000Z", author: "ClawBox assistant", verified: { by: "owner", via: "assistant" } },
      { sha: "d".repeat(40), subject: "verify: sales/acme-widgets/founded", at: "2026-01-02T12:00:00.000Z", author: "Prime Radiant", verified: { by: "owner" } },
      INGEST_COMMIT,
    ];
    await mount();
    await openTab("browse");
    fireEvent.click(await screen.findByTestId("prime-radiant-page-row"));
    fireEvent.click(await screen.findByTestId("prime-radiant-page-history"));
    const [viaAssistant, owners, ingest] = await screen.findAllByTestId("prime-radiant-commit");
    expect(within(viaAssistant).getByTestId("prime-radiant-commit-verified")).toHaveTextContent("verified by the owner (via the assistant)");
    expect(viaAssistant).toHaveTextContent("ClawBox assistant");
    expect(within(owners).getByTestId("prime-radiant-commit-verified")).toHaveTextContent(/^· verified by the owner$/);
    expect(within(ingest).queryByTestId("prime-radiant-commit-verified")).toBeNull();
  });

  it("shows a page's history and undoes a change after confirmation", async () => {
    await mount();
    await openTab("browse");
    fireEvent.click(await screen.findByTestId("prime-radiant-page-row"));
    fireEvent.click(await screen.findByTestId("prime-radiant-page-history"));
    const commit = await screen.findByTestId("prime-radiant-commit");
    expect(commit).toHaveTextContent("ingest: acme-overview.md");
    fireEvent.click(within(commit).getByTestId("prime-radiant-revert"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
    await waitFor(() => {
      expect(calls.find((c) => c.url.endsWith("/revert"))?.body).toEqual({ commit: "a".repeat(40), path: "entities/acme-widgets.md" });
    });
    // History is part of Pages now, not a tab of its own; Back returns to the page.
    expect(screen.getByTestId("prime-radiant-tab-browse")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("prime-radiant-history-back"));
    expect(await screen.findByTestId("prime-radiant-page")).toBeInTheDocument();
  });

  it("sends one undo however fast Confirm is pressed twice", async () => {
    await mount();
    await openTab("browse");
    fireEvent.click(await screen.findByTestId("prime-radiant-page-row"));
    fireEvent.click(await screen.findByTestId("prime-radiant-page-history"));
    const commit = await screen.findByTestId("prime-radiant-commit");
    fireEvent.click(within(commit).getByTestId("prime-radiant-revert"));
    const confirm = within(await screen.findByRole("dialog")).getAllByRole("button").at(-1) as HTMLElement;
    // Both clicks land before React re-renders, as a fast double click can.
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/revert"))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls.filter((c) => c.url.endsWith("/revert"))).toHaveLength(1);
  });

  it("shows model usage in Settings as tokens, never money, and names embeddings as not measured", async () => {
    await mount();
    await openTab("settings");
    const total = await screen.findByTestId("prime-radiant-usage-total");
    expect(total).toHaveTextContent("Tokens: 1.5K (sent 1.2K, received 300) · Model calls: 3");
    expect(screen.getByTestId("prime-radiant-usage-not-measured")).toHaveTextContent(/not measured/i);
    expect(screen.getByTestId("prime-radiant-usage-by-task")).toHaveTextContent("ingest 1.5K");
    expect(screen.getByRole("table", { name: "Per import and night" })).toHaveTextContent("1.2K");
    expect(screen.getByTestId("prime-radiant-app").textContent).not.toMatch(/\$|USD|US dollars|cost/i);
  });

  it("merges a held night from the nightly card", async () => {
    nightlyRuns = [{
      id: "run-0123456789ab", kind: "nightly", branch: "dream/2026-01-05", status: "held", trigger: "schedule",
      startedAt: "2026-01-05T03:00:00.000Z", finishedAt: "2026-01-05T03:10:00.000Z", usdEstimate: 0.01, summary: { held: ["verified"] },
    }];
    await mount();
    await openTab("settings");
    fireEvent.click(await screen.findByTestId("prime-radiant-nightly-merge"));
    await waitFor(() => {
      expect(calls.find((c) => c.url.endsWith("/nightly/run"))?.body).toEqual({ merge: "dream/2026-01-05" });
    });
  });

  it("switches the second opinion on without a price on screen, keeping the cap the box has", async () => {
    await mount();
    await openTab("settings");
    fireEvent.click(await screen.findByTestId("prime-radiant-opus-enabled"));
    expect(screen.queryByTestId("prime-radiant-opus-cap")).toBeNull();
    expect(screen.getByTestId("prime-radiant-settings").textContent).not.toMatch(/\$|USD|spending/i);
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { opus: unknown }).opus).toEqual({ enabled: true, capUsd: 2 });
    });
  });

  it("says the second opinion runs on the Claude subscription and saves the pages-per-night cap", async () => {
    opusExtras = { source: "subscription", maxPages: 100 };
    await mount();
    await openTab("settings");
    const source = await screen.findByTestId("prime-radiant-opus-source");
    expect(source).toHaveAttribute("data-source", "subscription");
    expect(source).toHaveTextContent(/Claude subscription/);
    expect(screen.getByTestId("prime-radiant-settings").textContent).not.toMatch(/needs an Anthropic API key/i);
    fireEvent.click(screen.getByTestId("prime-radiant-opus-enabled"));
    const pages = screen.getByTestId("prime-radiant-opus-max-pages");
    expect(pages).toHaveValue(100);
    fireEvent.change(pages, { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pages per night must be a whole number from 4 to 2000.");
    fireEvent.change(pages, { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { opus: unknown }).opus).toEqual({ enabled: true, capUsd: 2, maxPages: 40 });
    });
  });

  it("shows the company field and the structure switch, and saves them with the rest", async () => {
    structureSettings = { enabled: true, company: "", enrichTop: 25, modelFallback: 25 };
    await mount();
    await openTab("settings");
    fireEvent.change(await screen.findByTestId("prime-radiant-company"), { target: { value: "  Acme Widgets Ltd " } });
    fireEvent.click(screen.getByTestId("prime-radiant-structure"));
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { structure: unknown }).structure).toEqual({ enabled: false, company: "Acme Widgets Ltd" });
    });
  });

  it("offers no structure fields to a server from before them, and sends none", async () => {
    await mount();
    await openTab("settings");
    await screen.findByTestId("prime-radiant-settings-save");
    expect(screen.queryByTestId("prime-radiant-company")).toBeNull();
    expect(screen.queryByTestId("prime-radiant-structure")).toBeNull();
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect(put).toBeDefined();
      expect((put?.body as Record<string, unknown>).structure).toBeUndefined();
    });
  });

  it("never lets the page cap block a save while the second opinion is off", async () => {
    opusExtras = { source: "api_key", maxPages: 100 };
    await mount();
    await openTab("settings");
    fireEvent.change(await screen.findByTestId("prime-radiant-opus-max-pages"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { opus: unknown }).opus).toEqual({ enabled: false, capUsd: 2 });
    });
  });

  it("says when no account can give a second opinion", async () => {
    opusExtras = { source: "none", maxPages: 100 };
    await mount();
    await openTab("settings");
    expect(await screen.findByTestId("prime-radiant-opus-source")).toHaveTextContent(/no Anthropic API key and no Claude sign-in/);
  });

  it("shows the search index size limit with its default, refuses one out of range and saves it", async () => {
    searchIndexLimitMb = 256;
    await mount();
    await openTab("settings");
    const limit = await screen.findByTestId("prime-radiant-search-index-limit");
    expect(limit).toHaveValue(256);
    expect(screen.getByTestId("prime-radiant-settings")).toHaveTextContent("The default is 160 MB");
    fireEvent.change(limit, { target: { value: "16" } });
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The search index size limit must be a whole number of MB from 32 to 4096.");
    expect(calls.some((c) => c.url.endsWith("/settings") && c.method === "PUT")).toBe(false);
    fireEvent.change(limit, { target: { value: "512" } });
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { search: unknown }).search).toEqual({ indexLimitMb: 512 });
    });
  });

  it("offers no index size limit to a server that does not know it, and sends none", async () => {
    await mount();
    await openTab("settings");
    await screen.findByTestId("prime-radiant-settings-save");
    expect(screen.queryByTestId("prime-radiant-search-index-limit")).toBeNull();
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect(put?.body).not.toHaveProperty("search");
    });
  });

  it("shows the tokens an import and a night used, and no money", async () => {
    ingestJobs = [DEAD_JOB];
    nightlyRuns = [{
      id: "run-0123456789ab", kind: "nightly", branch: null, status: "done", trigger: "schedule",
      startedAt: "2026-01-05T03:00:00.000Z", finishedAt: "2026-01-05T03:10:00.000Z", usdEstimate: 0.42,
      summary: { ingest: { jobId: "job-night" } },
    }];
    await mount();
    await openTab("ingest");
    const job = await screen.findByTestId("prime-radiant-ingest-job");
    await waitFor(() => expect(job).toHaveTextContent("2 pages from 2 of 3 files · 4.6K tokens"));
    expect(screen.getByTestId("prime-radiant-app").textContent).not.toMatch(/\$|USD/);
    await openTab("settings");
    // The night's own calls and those of the import it ran.
    expect(await screen.findByTestId("prime-radiant-nightly-tokens")).toHaveTextContent("1.5K tokens");
    expect(screen.getByTestId("prime-radiant-nightly").textContent).not.toMatch(/\$|0\.42/);
  });

  it("refuses a dropped file it cannot read before uploading anything", async () => {
    await mount();
    await openTab("ingest");
    const input = await screen.findByTestId("prime-radiant-file-input");
    fireEvent.change(input, { target: { files: [new File(["x"], "photo.png", { type: "image/png" })] } });
    expect(await screen.findByText(/photo\.png/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/ingest/upload"))).toBe(false);
  });

  it("ingests a picked folder, follows its progress over SSE and can stop it", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    await mount();
    await openTab("ingest");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    await waitFor(() => {
      expect(calls.find((c) => c.url.endsWith("/ingest") && c.method === "POST")?.body).toEqual({ folders: ["/srv/box/acme-docs"] });
    });
    const running = await screen.findByTestId("prime-radiant-ingest-running");
    expect(FakeEventSource.last?.url).toBe("/setup-api/prime-radiant/ingest/job-run/events");

    act(() => {
      FakeEventSource.last?.emit("job", { ...RUNNING_JOB, done: 1, pages: 1 });
      FakeEventSource.last?.emit("file", { seq: 1, label: "~/acme-docs/overview.md", status: "done", pages: ["entities/acme-widgets.md"] });
    });
    expect(await within(running).findByTestId("prime-radiant-ingest-files")).toHaveTextContent("overview.md");
    expect(within(running).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33");

    fireEvent.click(within(running).getByTestId("prime-radiant-ingest-stop"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/ingest/job-run") && c.method === "DELETE")).toBe(true);
    });

    act(() => { FakeEventSource.last?.emit("end", { ...RUNNING_JOB, status: "interrupted", phase: "done" }); });
    await waitFor(() => expect(screen.queryByTestId("prime-radiant-ingest-running")).toBeNull());
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("clears a failed stop's error when the next stop goes through", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    stopRefusals = [500];
    await mount();
    await openTab("ingest");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    const running = await screen.findByTestId("prime-radiant-ingest-running");
    fireEvent.click(within(running).getByTestId("prime-radiant-ingest-stop"));
    expect(await screen.findByText(/could not be stopped/)).toBeInTheDocument();
    await waitFor(() => expect(within(running).getByTestId("prime-radiant-ingest-stop")).not.toBeDisabled());
    fireEvent.click(within(running).getByTestId("prime-radiant-ingest-stop"));
    await waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith("/ingest/job-run") && c.method === "DELETE")).toHaveLength(2);
    });
    await waitFor(() => expect(screen.queryByText(/could not be stopped/)).toBeNull());
  });

  it("stops polling a job the box no longer has after the stream drops", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    await mount();
    await openTab("ingest");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    await screen.findByTestId("prime-radiant-ingest-running");
    // The stream drops; the job read that follows answers 404 (the fake has no job-run GET).
    act(() => { FakeEventSource.last?.onerror?.(); });
    await waitFor(() => expect(screen.queryByTestId("prime-radiant-ingest-running")).toBeNull(), { timeout: 5000 });
    const reads = () => calls.filter((c) => c.url.endsWith("/ingest/job-run") && c.method === "GET").length;
    const seen = reads();
    expect(seen).toBe(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    expect(reads()).toBe(seen);
  });

  it("counts the picked folders before Start: documents, where they are, and what is left out and why", async () => {
    await mount();
    await openTab("ingest");
    expect(screen.getByTestId("prime-radiant-ingest-start")).toBeDisabled();
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-add"));
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-use"));
    // Start waits for the count.
    expect(screen.getByTestId("prime-radiant-ingest-start")).toBeDisabled();
    await screen.findByTestId("prime-radiant-ingest-preview", {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveAttribute("data-state", "ready"));
    expect(calls.find((c) => c.url.endsWith("/ingest/preview"))?.body).toEqual({ folders: ["/srv/box/acme-docs"] });
    expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveTextContent("Documents to read: 3");
    expect(screen.getByTestId("prime-radiant-ingest-preview-folders")).toHaveTextContent("~/acme-docs/contracts");
    const skips = screen.getByTestId("prime-radiant-ingest-preview-skips");
    expect(skips).toHaveTextContent("Code projects: 2");
    expect(skips).toHaveTextContent("Licence, changelog and similar files: 4");
    expect(skips).toHaveTextContent("Logs and data exports: 1");
    expect(skips).toHaveTextContent("Other kinds of files: 12");
    expect(skips).not.toHaveTextContent("Temporary");
    expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveTextContent("~/acme-docs/site");
    // Under the threshold: Start starts at once.
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ingest") && c.method === "POST")).toBe(true));
    expect(screen.queryByTestId("prime-radiant-ingest-confirm")).toBeNull();
  });

  it("asks before starting an import of more than 500 documents, and Cancel starts nothing", async () => {
    previewAnswer = { ...PREVIEW, documents: 1234, truncated: false };
    vi.stubGlobal("EventSource", FakeEventSource);
    await mount();
    await openTab("ingest");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    const confirm = await screen.findByTestId("prime-radiant-ingest-confirm");
    expect(confirm).toHaveTextContent("Read 1,234 documents?");
    expect(calls.some((c) => c.url.endsWith("/ingest") && c.method === "POST")).toBe(false);
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-confirm-cancel"));
    expect(screen.queryByTestId("prime-radiant-ingest-confirm")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/ingest") && c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-confirm-start"));
    await waitFor(() => {
      expect(calls.find((c) => c.url.endsWith("/ingest") && c.method === "POST")?.body).toEqual({ folders: ["/srv/box/acme-docs"] });
    });
  });

  it("asks before starting when the folders could not be counted", async () => {
    previewAnswer = null;
    await mount();
    await openTab("ingest");
    await pickFolder();
    expect(await screen.findByTestId("prime-radiant-ingest-preview")).toHaveTextContent("could not be counted");
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    expect(await screen.findByTestId("prime-radiant-ingest-confirm")).toHaveTextContent("Start the import anyway?");
    expect(calls.some((c) => c.url.endsWith("/ingest") && c.method === "POST")).toBe(false);
  });

  it("starts 500 documents without asking (only more than 500 asks)", async () => {
    previewAnswer = { ...PREVIEW, documents: 500 };
    await mount();
    await openTab("ingest");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ingest") && c.method === "POST")).toBe(true));
  });

  it("keeps Start off when the folders hold nothing to read", async () => {
    previewAnswer = { ...PREVIEW, documents: 0, topFolders: [] };
    await mount();
    await openTab("ingest");
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-add"));
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-use"));
    await waitFor(() => expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveAttribute("data-state", "ready"));
    expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveTextContent("nothing to read");
    expect(screen.getByTestId("prime-radiant-ingest-start")).toBeDisabled();
  });

  it("says when one import cannot read every document", async () => {
    previewAnswer = { ...PREVIEW, documents: 5000, truncated: true };
    await mount();
    await openTab("ingest");
    await pickFolder();
    expect(screen.getByTestId("prime-radiant-ingest-preview")).toHaveTextContent("One import reads at most 5,000 documents");
  });

  it("adds the home folder in one click", async () => {
    await mount();
    await openTab("ingest");
    fireEvent.click(await screen.findByTestId("prime-radiant-ingest-folders-home"));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/ingest/preview"))?.body).toEqual({ folders: ["/srv/box"] }));
    expect(screen.getByTestId("prime-radiant-ingest-folders")).toHaveTextContent("/srv/box");
    await waitFor(() => expect(screen.getByTestId("prime-radiant-ingest-folders-home")).toBeDisabled());
  });

  it("shows what a running and a finished job left out, by reason", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    ingestJobs = [{ ...DEAD_JOB, skips: { ...NO_SKIPS, temp: 3 } }];
    await mount();
    await openTab("ingest");
    expect(await screen.findByTestId("prime-radiant-ingest-job-skips")).toHaveTextContent("Temporary or partial files: 3");
    await pickFolder();
    fireEvent.click(screen.getByTestId("prime-radiant-ingest-start"));
    const running = await screen.findByTestId("prime-radiant-ingest-running");
    act(() => { FakeEventSource.last?.emit("job", { ...RUNNING_JOB, skips: { ...NO_SKIPS, codeProject: 4, tooLarge: 1 } }); });
    const line = await within(running).findByTestId("prime-radiant-ingest-skips");
    expect(line).toHaveTextContent("Left out: Code projects: 4 · Too large to read: 1");
  });

  it("saves Skip code projects with the other ingest settings", async () => {
    await mount();
    await openTab("settings");
    const toggle = await screen.findByTestId("prime-radiant-skip-code-projects");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("prime-radiant-settings-save"));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith("/settings") && c.method === "PUT");
      expect((put?.body as { ingest: { skipCodeProjects: boolean } }).ingest.skipCodeProjects).toBe(false);
    });
  });

  it("lists a job's dead letters and retries them", async () => {
    ingestJobs = [DEAD_JOB];
    await mount();
    await openTab("ingest");
    fireEvent.click(await screen.findByTestId("prime-radiant-dead-letter-toggle"));
    expect(await screen.findByTestId("prime-radiant-dead-letter")).toHaveTextContent("broken.pdf");
    fireEvent.click(screen.getByTestId("prime-radiant-dead-letter-retry"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/ingest/job-dead/retry") && c.method === "POST")).toBe(true);
    });
  });
});

describe("PrimeRadiantShardSource", () => {
  it("names the wiki on Memory Shard's home once the wiki exists", async () => {
    const { default: PrimeRadiantShardSource } = await import("@/components/PrimeRadiantShardSource");
    render(<I18nProvider><PrimeRadiantShardSource /></I18nProvider>);
    const line = await screen.findByTestId("memory-shard-prime-radiant-source");
    await waitFor(() => expect(line).toHaveTextContent("Prime Radiant wiki (pages: 2)"));
  });

  it("reads again when a Prime Radiant window makes the wiki", async () => {
    status = { ...STATUS, initialised: false };
    const { default: PrimeRadiantShardSource } = await import("@/components/PrimeRadiantShardSource");
    render(<I18nProvider><PrimeRadiantShardSource /></I18nProvider>);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/prime-radiant/status"))).toBe(true));
    expect(screen.queryByTestId("memory-shard-prime-radiant-source")).toBeNull();
    status = { ...STATUS };
    act(() => { window.dispatchEvent(new Event(PRIME_RADIANT_CHANGED_EVENT)); });
    expect(await screen.findByTestId("memory-shard-prime-radiant-source")).toHaveTextContent("pages: 2");
  });

  it("opens the wiki as a window on the desktop and navigates on the standalone page", async () => {
    const { default: PrimeRadiantShardSource } = await import("@/components/PrimeRadiantShardSource");
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    try {
      const view = render(<I18nProvider><PrimeRadiantShardSource /></I18nProvider>);
      fireEvent.click(await screen.findByTestId("memory-shard-prime-radiant-open"));
      expect(opened).toEqual(["prime-radiant"]);
      view.unmount();

      const location = stubLocation("/app/memory-shard");
      try {
        render(<I18nProvider><PrimeRadiantShardSource /></I18nProvider>);
        fireEvent.click(await screen.findByTestId("memory-shard-prime-radiant-open"));
        expect(location.assign).toHaveBeenCalledWith("/app/prime-radiant");
        expect(opened).toEqual(["prime-radiant"]);
      } finally {
        location.restore();
      }
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
    }
  });

  it("draws nothing before the wiki is created", async () => {
    status = { ...STATUS, initialised: false };
    const { default: PrimeRadiantShardSource } = await import("@/components/PrimeRadiantShardSource");
    render(<I18nProvider><PrimeRadiantShardSource /></I18nProvider>);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/prime-radiant/status"))).toBe(true));
    expect(screen.queryByTestId("memory-shard-prime-radiant-source")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/init"))).toBe(false);
  });
});

describe("prJson", () => {
  it("reports an abort that lands while the body is arriving as an abort, not as an empty answer", async () => {
    const ctl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        ctl.abort();
        throw new SyntaxError("Unexpected end of JSON input");
      },
    })));
    await expect(prJson("/setup-api/prime-radiant/pages", { signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("PrimeRadiantApp — Questions", () => {
  it("shows the accuracy with its change and trend, keeps the golden questions, and lists an owner's daily questions in their language", async () => {
    status = { ...STATUS, golden: GOLDEN_SCORE };
    mount();
    expect(await screen.findByTestId("prime-radiant-count-accuracy")).toHaveTextContent("Accuracy 75%");
    await openTab("questions");
    expect(await screen.findByTestId("prime-radiant-accuracy-percent")).toHaveTextContent("75% correct");
    expect(screen.getByTestId("prime-radiant-accuracy-change")).toHaveTextContent("+25 points since the last check");
    expect(screen.getByTestId("prime-radiant-accuracy-trend")).toBeInTheDocument();
    const row = await screen.findByTestId("prime-radiant-golden-row");
    expect(row).toHaveAttribute("data-verdict", "correct");
    expect(row).toHaveTextContent("What does the blue widget cost?");

    fireEvent.click(screen.getByTestId("prime-radiant-golden-add"));
    fireEvent.change(screen.getByTestId("prime-radiant-golden-question"), { target: { value: "Where is Acme based?" } });
    fireEvent.change(screen.getByTestId("prime-radiant-golden-expected"), { target: { value: "Springfield" } });
    fireEvent.click(screen.getByTestId("prime-radiant-golden-save"));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/setup-api/prime-radiant/golden" && c.method === "POST")?.body).toEqual({ question: "Where is Acme based?", expected: "Springfield", domain: "sales" }),
    );
    await waitFor(() => expect(screen.getAllByTestId("prime-radiant-golden-row")).toHaveLength(2));

    fireEvent.click((await screen.findAllByTestId("prime-radiant-golden-delete"))[0]);
    fireEvent.click(await screen.findByTestId("prime-radiant-golden-delete-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/golden/${GOLDEN_Q.id}`))).toBe(true));

    const daily = await screen.findAllByTestId("prime-radiant-daily-question");
    expect(daily).toHaveLength(1);
    expect(daily[0]).toHaveAttribute("data-kind", "claim");
    expect(daily[0]).toHaveTextContent("Още ли е вярно?");
    expect(screen.getByTestId("prime-radiant-daily-language")).toHaveValue("bg");
    const outbound = screen.getByTestId("prime-radiant-daily-outbound");
    expect(outbound).not.toBeChecked();
    expect(screen.getByTestId("prime-radiant-daily")).toHaveTextContent("Nothing is sent on its own.");
    fireEvent.click(outbound);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/settings"))?.body).toEqual({ verification: { outbound: true } }));
  });

  it("keeps an edit open with what was typed when the save is refused, and shows the claim and a missing owner", async () => {
    goldenQuestions = [{ ...GOLDEN_Q, owner: "unassigned", claimId: "sales/acme-widgets/price" }];
    mount();
    await openTab("questions");
    const row = await screen.findByTestId("prime-radiant-golden-row");
    expect(row).toHaveTextContent("No owner");
    expect(screen.getByTestId("prime-radiant-golden-row-claim")).toHaveTextContent("sales/acme-widgets/price");
    fireEvent.click(screen.getByTestId("prime-radiant-golden-edit"));
    expect(screen.getByTestId("prime-radiant-golden-owner")).toHaveValue("");
    expect(screen.getByTestId("prime-radiant-golden-claim")).toHaveValue("sales/acme-widgets/price");
    fireEvent.change(screen.getByTestId("prime-radiant-golden-expected"), { target: { value: "12 EUR" } });
    fireEvent.change(screen.getByTestId("prime-radiant-golden-claim"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("prime-radiant-golden-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ expected: "12 EUR", claimId: null, owner: null }));
    expect(await within(screen.getByTestId("prime-radiant-golden")).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-golden-form")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-golden-expected")).toHaveValue("12 EUR");
  });

  it("sets the nightly golden check and the daily questions an owner gets under Checks", async () => {
    mount();
    await openTab("questions");
    const enabled = await screen.findByTestId("prime-radiant-golden-enabled");
    expect(enabled).toBeChecked();
    expect(screen.getByTestId("prime-radiant-golden-max")).toHaveValue(50);
    fireEvent.click(enabled);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/settings")).map((c) => c.body)).toContainEqual({ golden: { enabled: false } }));
    const perOwner = screen.getByTestId("prime-radiant-daily-per-owner");
    fireEvent.change(perOwner, { target: { value: "99" } });
    fireEvent.blur(perOwner);
    expect(perOwner).toHaveValue(5);
    fireEvent.change(perOwner, { target: { value: "3" } });
    fireEvent.blur(perOwner);
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/settings")).map((c) => c.body)).toContainEqual({ verification: { perOwner: 3 } }));
    expect(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/settings")).map((c) => c.body)).not.toContainEqual({ verification: { perOwner: 99 } });
  });

  it("puts back the value in force when the server refuses a Checks save", async () => {
    refuseSettingsPut = true;
    mount();
    await openTab("questions");
    const perOwner = await screen.findByTestId("prime-radiant-daily-per-owner");
    fireEvent.change(perOwner, { target: { value: "3" } });
    fireEvent.blur(perOwner);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/settings"))).toBe(true));
    expect(await within(screen.getByTestId("prime-radiant-checks")).findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(perOwner).toHaveValue(5));
  });

  it("says so when there are no golden questions, no score and no owners yet", async () => {
    goldenQuestions = [];
    mount();
    await openTab("questions");
    expect(await screen.findByTestId("prime-radiant-golden-empty")).toBeInTheDocument();
    expect(screen.getByTestId("prime-radiant-accuracy")).toHaveTextContent("Not checked yet");
    expect(screen.queryByTestId("prime-radiant-count-accuracy")).toBeNull();
  });
});
