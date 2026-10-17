/**
 * GET /setup-api/prime-radiant/{status,pages,pages/<path>,lint} and
 * POST /setup-api/prime-radiant/init over a real vault in a tmp dir.
 * Owner-only like every other setup-api route; the GETs never create the vault.
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
const oc = vi.hoisted(() => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfigStrict: vi.fn(async () => ({})),
  runOpenclawConfigSetBatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/openclaw-config", () => oc);
// The vault's Memory Shard index: stubbed (it embeds), pinned in its own suite.
const shard = vi.hoisted(() => ({
  scheduleReindexAfterCommit: vi.fn(),
  reindexPrimeRadiantVault: vi.fn(async () => null),
  searchPrimeRadiant: vi.fn(async (): Promise<unknown[]> => []),
  vaultIndexStatus: vi.fn(async () => ({ exists: true, pages: 3, chunks: 6, identity: "valid", needsFullScan: false, builtAt: 1 })),
}));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);
const memoryShard = vi.hoisted(() => ({ getMemoryShardEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/memory-shard", () => memoryShard);

import { GET as statusGET } from "@/app/setup-api/prime-radiant/status/route";
import { GET as pagesGET } from "@/app/setup-api/prime-radiant/pages/route";
import { GET as pageGET } from "@/app/setup-api/prime-radiant/pages/[...path]/route";
import { GET as lintGET } from "@/app/setup-api/prime-radiant/lint/route";
import { POST as initPOST } from "@/app/setup-api/prime-radiant/init/route";
import { GET as searchGET } from "@/app/setup-api/prime-radiant/search/route";
import { MEMORY_WIKI_PLUGIN_ID } from "@/lib/prime-radiant/plugin-wiring";
import { vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

// Real git processes, in series: give them room on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-routes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
const prevStateDir = process.env.OPENCLAW_STATE_DIR;
// memory-wiki's default vault (vault.path unset) is looked into before it is re-pointed: never the real one.
process.env.OPENCLAW_STATE_DIR = path.join(base, "openclaw-state");
let n = 0;

const ORIGIN = "http://clawbox.local/setup-api/prime-radiant";
const req = (p: string) => new Request(`${ORIGIN}${p}`);
const initReq = (headers: Record<string, string> = {}) =>
  initPOST(new Request(`${ORIGIN}/init`, { method: "POST", headers: { origin: "http://clawbox.local", ...headers } }));
const pageReq = (segments: string[]) => pageGET(req(`/pages/${segments.join("/")}`), { params: Promise.resolve({ path: segments }) });

async function seed() {
  await vaultOperation("ingest: seed", async (tx) => {
    await tx.write(
      "entities/acme-widgets.md",
      pageText(
        { type: "entity", title: "Acme Widgets Ltd", domain: "acme-sales", verified: { at: "2026-02-01T00:00:00Z", by: "owner" } },
        "Acme Widgets Ltd is a synthetic company.\n\nPrices: [[concepts/pricing]].\n",
      ),
    );
    await tx.write("concepts/pricing.md", pageText({ claims: [claim("acme-sales/widgets/sizes")] }));
    await tx.write("concepts/support.md", pageText({ title: "Support hours", domain: "acme-support", status: "stable", sources: [] }, "Support answers on weekdays.\n"));
    await tx.write("index.md", "# Index\n\n- [[entities/acme-widgets]]\n");
  });
}

beforeEach(() => {
  auth.requireSession.mockResolvedValue(null);
  owner.hasPersonSession.mockResolvedValue(true);
  oc.runOpenclawConfigSetBatch.mockReset().mockResolvedValue(undefined);
  oc.openclawIsAbsent.mockReturnValue(false);
  oc.readConfigStrict.mockResolvedValue({});
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevStateDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("prime radiant routes: auth", () => {
  it("answers whatever requireSession answers, before touching the vault", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "owner_only", code: "owner_only" }, { status: 403 }));
    for (const res of [
      await statusGET(req("/status")),
      await pagesGET(req("/pages")),
      await lintGET(req("/lint")),
      await pageReq(["concepts", "x.md"]),
      await initReq(),
      await searchGET(req("/search?q=widgets")),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
    expect(auth.requireSession).toHaveBeenCalledWith(expect.any(Request));
  });
});

describe("GET routes on a vault that does not exist yet", () => {
  it("create nothing: no folder, no repository, no state database", async () => {
    const root = process.env.PRIME_RADIANT_DIR!;
    const status = await statusGET(req("/status"));
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const body = await status.json();
    expect(body).toMatchObject({
      initialised: false,
      vault: { pages: 0, claims: 0, domains: [] },
      git: { branch: null, head: null, commits: 0 },
      plugin: { state: "needs-write" },
      lint: { errors: 0, warnings: 0, ok: true },
    });

    expect(await (await pagesGET(req("/pages"))).json()).toEqual({ total: 0, pages: [] });
    const lint = await (await lintGET(req("/lint"))).json();
    expect(lint).toMatchObject({ checked: 0, findings: [], ok: true });
    const page = await pageReq(["concepts", "pricing.md"]);
    expect(page.status).toBe(404);
    expect((await page.json()).code).toBe("not_found");

    expect(fs.existsSync(root)).toBe(false);
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("leave an existing empty folder alone (no git init inside it)", async () => {
    const vault = path.join(process.env.PRIME_RADIANT_DIR!, "vault");
    fs.mkdirSync(vault, { recursive: true });
    expect((await (await statusGET(req("/status"))).json()).initialised).toBe(false);
    expect(fs.readdirSync(vault)).toEqual([]);
    expect(fs.readdirSync(process.env.PRIME_RADIANT_DIR!)).toEqual(["vault"]);
  });
});

describe("POST /init", () => {
  it("makes the vault and wires memory-wiki, once", async () => {
    const res = await initReq();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.plugin.wrote).toBe(true);
    // A new vault has nothing of memory-wiki's to take out; the repair is marked done all the same.
    expect(body.repair).toEqual({ ran: true, cleaned: [], removed: [], commit: null });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    const keys = (oc.runOpenclawConfigSetBatch.mock.calls[0] as unknown as [Array<[string, string, string]>])[0].map((a) => a[0]);
    expect(keys.every((k) => k.startsWith(`plugins.entries.${MEMORY_WIKI_PLUGIN_ID}.`))).toBe(true);

    const status = await (await statusGET(req("/status"))).json();
    expect(status).toMatchObject({ initialised: true, vault: { pages: 0 } });
    expect(status.git).toMatchObject({ branch: "main", commits: 1, head: { subject: "init: vault" } });

    // The config now says what we wrote: a second init makes and writes nothing.
    const vault = path.join(process.env.PRIME_RADIANT_DIR!, "vault");
    oc.readConfigStrict.mockResolvedValue({
      plugins: {
        entries: {
          [MEMORY_WIKI_PLUGIN_ID]: {
            enabled: true,
            config: {
              vaultMode: "isolated",
              vault: { path: vault },
              ingest: { autoCompile: false },
              render: { createBacklinks: false, createDashboards: false },
            },
          },
        },
      },
    });
    const again = await (await initReq()).json();
    expect(again).toMatchObject({ created: false, plugin: { state: "wired", wrote: false }, repair: { ran: false } });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect((await (await statusGET(req("/status"))).json()).git.commits).toBe(1);
  });

  it("makes the vault even where there is no OpenClaw to wire", async () => {
    oc.openclawIsAbsent.mockReturnValue(true);
    const body = await (await initReq()).json();
    expect(body).toMatchObject({ created: true, plugin: { state: "unavailable", reason: "no-openclaw", wrote: false } });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("refuses the MCP bearer and a cross-site page before touching anything", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const bearer = await initReq();
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).code).toBe("owner_only");

    owner.hasPersonSession.mockResolvedValue(true);
    const cross = await initReq({ origin: "http://evil.example.com" });
    expect(cross.status).toBe(403);
    expect((await cross.json()).code).toBe("cross_origin");

    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("answers wiring_failed when the vault is made but the config write fails", async () => {
    oc.runOpenclawConfigSetBatch.mockRejectedValue(new Error("config locked"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await initReq();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "wiring_failed" });
    expect((await (await statusGET(req("/status"))).json()).initialised).toBe(true);
    spy.mockRestore();
  });

  it("answers vault_unavailable when the vault cannot be made", async () => {
    const blocker = path.join(base, `blocker-init-${n}`);
    fs.writeFileSync(blocker, "a file where the folder should be");
    process.env.PRIME_RADIANT_DIR = blocker;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await initReq();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "vault_unavailable" });
    spy.mockRestore();
  });
});

describe("GET /status", () => {
  it("counts pages, claims, verification and domains", async () => {
    await seed();
    const body = await (await statusGET(req("/status"))).json();
    expect(body.vault).toMatchObject({ pages: 3, invalidPages: 0, verifiedPages: 1, claims: 1, domains: ["acme-sales", "acme-support"] });
    expect(body.git.commits).toBe(2);
    expect(body.lint.errors).toBeGreaterThan(0); // support page names no sources
  });
});

describe("GET /pages", () => {
  it("lists pages without bodies, filtered", async () => {
    await seed();
    const all = await (await pagesGET(req("/pages"))).json();
    expect(all.total).toBe(3);
    expect(all.pages.map((p: { path: string }) => p.path)).toEqual(["concepts/pricing.md", "concepts/support.md", "entities/acme-widgets.md"]);
    expect(all.pages[0]).not.toHaveProperty("body");
    expect(all.pages[2]).toMatchObject({ type: "entity", verified: true, summary: "Acme Widgets Ltd is a synthetic company." });

    const ofType = await (await pagesGET(req("/pages?type=entity"))).json();
    expect(ofType.total).toBe(1);
    const byDomain = await (await pagesGET(req("/pages?domain=acme-support&status=stable"))).json();
    expect(byDomain.pages.map((p: { path: string }) => p.path)).toEqual(["concepts/support.md"]);
    const q = await (await pagesGET(req("/pages?q=PRICING"))).json();
    expect(q.total).toBe(1);
    const verified = await (await pagesGET(req("/pages?verified=false&limit=1&offset=1"))).json();
    expect(verified).toMatchObject({ total: 2, pages: [{ path: "concepts/support.md" }] });
  });

  it("refuses bad filters", async () => {
    for (const q of ["type=poem", "status=final", "domain=Acme%20Sales", "verified=yes", "limit=-1", "offset=abc"]) {
      const res = await pagesGET(req(`/pages?${q}`));
      expect(res.status, q).toBe(400);
      expect((await res.json()).code).toMatch(/^invalid_/);
    }
  });
});

describe("GET /pages/<path>", () => {
  it("answers one page with its links and lint", async () => {
    await seed();
    const res = await pageReq(["concepts", "pricing.md"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      path: "concepts/pricing.md",
      valid: true,
      backlinks: ["entities/acme-widgets.md"],
      links: ["entities/acme-widgets.md"],
      inIndex: false,
      verified: false,
    });
    expect(body.frontmatter.claims[0].id).toBe("acme-sales/widgets/sizes");
    expect(body.lint.scope).toEqual(["concepts/pricing.md"]);
    expect(body.body).toContain("Acme Widgets Ltd sells widgets");
    // The extension is optional.
    expect((await pageReq(["concepts", "pricing"])).status).toBe(200);
  });

  it("answers 404 for missing pages, bookkeeping and unsafe paths alike", async () => {
    await seed();
    for (const segments of [["concepts", "nope.md"], ["index.md"], ["AGENTS.md"], ["..", "prime-radiant.sqlite"], [".git", "config"], ["reports", "x.md"]]) {
      const res = await pageReq(segments);
      expect(res.status, segments.join("/")).toBe(404);
      expect((await res.json()).code).toBe("not_found");
    }
  });

  it("answers only a short summary with ?view=summary, for the Map's card", async () => {
    await seed();
    await vaultOperation("ingest: summaries", async (tx) => {
      await tx.write("concepts/returns.md", pageText({ title: "Returns", summary: "Returns are taken within **30 days**." } as never, "Body that the summary outranks.\n"));
      await tx.write("concepts/facts.md", pageText({ title: "Facts" }, "## Facts\n\n- one\n- two\n"));
    });
    const summary = async (segments: string[]) => {
      const res = await pageGET(req(`/pages/${segments.join("/")}?view=summary`), { params: Promise.resolve({ path: segments }) });
      return { status: res.status, body: await res.json() };
    };
    // The first prose paragraph, Markdown out; nothing else of the page.
    expect(await summary(["concepts", "support.md"])).toEqual({ status: 200, body: { path: "concepts/support.md", summary: "Support answers on weekdays." } });
    expect((await summary(["entities", "acme-widgets.md"])).body.summary).toBe("Acme Widgets Ltd is a synthetic company.");
    // The frontmatter's own summary first; a page without prose says null.
    expect((await summary(["concepts", "returns.md"])).body.summary).toBe("Returns are taken within 30 days.");
    expect((await summary(["concepts", "facts.md"])).body).toEqual({ path: "concepts/facts.md", summary: null });
    // Missing and unsafe pages answer 404, as without it.
    for (const segments of [["concepts", "nope.md"], ["..", "prime-radiant.sqlite"], ["index.md"]]) expect((await summary(segments)).status).toBe(404);
  });
});

describe("GET /lint", () => {
  it("lints the whole vault, or only the named pages", async () => {
    await seed();
    const all = await (await lintGET(req("/lint"))).json();
    expect(all.scope).toBe("all");
    expect(all.checked).toBe(3);
    expect(all.findings.some((f: { rule: string; path: string }) => f.rule === "no-sources" && f.path === "concepts/support.md")).toBe(true);

    const one = await (await lintGET(req("/lint?path=concepts/pricing.md"))).json();
    expect(one).toMatchObject({ scope: ["concepts/pricing.md"], checked: 1 });
    const two = await (await lintGET(req("/lint?paths=concepts/pricing.md,concepts/support"))).json();
    expect(two.checked).toBe(2);
    const unsafe = await (await lintGET(req("/lint?path=../../etc/passwd"))).json();
    expect(unsafe.checked).toBe(0);
  });

  it("refuses an oversized scope", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `path=p${i}.md`).join("&");
    expect((await lintGET(req(`/lint?${many}`))).status).toBe(400);
  });

  it("treats a file where the vault folder should be as no vault", async () => {
    const blocker = path.join(base, `blocker-${n}`);
    fs.writeFileSync(blocker, "a file where the folder should be");
    process.env.PRIME_RADIANT_DIR = blocker;
    const res = await lintGET(req("/lint"));
    expect(res.status).toBe(200);
    expect((await res.json()).checked).toBe(0);
    expect(fs.readFileSync(blocker, "utf8")).toBe("a file where the folder should be");
  });
});

describe("GET /search", () => {
  const VALID = { exists: true, pages: 3, chunks: 6, identity: "valid", needsFullScan: false, builtAt: 1 };
  beforeEach(() => {
    shard.searchPrimeRadiant.mockReset().mockResolvedValue([]);
    shard.reindexPrimeRadiantVault.mockReset().mockResolvedValue(null);
    shard.vaultIndexStatus.mockReset().mockResolvedValue(VALID);
    memoryShard.getMemoryShardEnabled.mockReset().mockResolvedValue(true);
  });

  it("asks for a query and creates nothing without a vault", async () => {
    expect((await searchGET(req("/search"))).status).toBe(400);
    const res = await searchGET(req("/search?q=widgets"));
    expect(await res.json()).toEqual({ initialised: false, shardEnabled: true, indexing: false, results: [] });
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
    expect(shard.reindexPrimeRadiantVault).not.toHaveBeenCalled();
  });

  it("answers the vault's hits with path, id and type", async () => {
    await seed();
    const hit = {
      source: "prime-radiant", path: "entities/acme-widgets.md", id: "entities/acme-widgets", kind: "page",
      type: "entity", title: "Acme Widgets Ltd", snippet: "Acme Widgets Ltd is a synthetic company.", score: 0.9, similarity: 0.8, verified: true,
    };
    shard.searchPrimeRadiant.mockResolvedValue([hit]);
    const res = await searchGET(req("/search?q=acme&limit=99"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ initialised: true, shardEnabled: true, indexing: false, index: VALID, results: [hit] });
    expect(shard.searchPrimeRadiant).toHaveBeenCalledWith("acme", 20, expect.any(AbortSignal));
    expect(shard.reindexPrimeRadiantVault).not.toHaveBeenCalled();
  });

  it("answers nothing and starts no index while Memory Shard is switched off", async () => {
    await seed();
    memoryShard.getMemoryShardEnabled.mockResolvedValue(false);
    shard.vaultIndexStatus.mockResolvedValue({ ...VALID, exists: false, identity: "missing" });
    const res = await searchGET(req("/search?q=acme"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ initialised: true, shardEnabled: false, indexing: false, results: [] });
    expect(shard.reindexPrimeRadiantVault).not.toHaveBeenCalled();
    expect(shard.searchPrimeRadiant).not.toHaveBeenCalled();
  });

  it("starts a whole-vault index when there is none yet, and says so", async () => {
    await seed();
    shard.vaultIndexStatus.mockResolvedValue({ ...VALID, exists: false, identity: "missing" });
    const body = await (await searchGET(req("/search?q=acme"))).json();
    expect(body).toMatchObject({ initialised: true, indexing: true, results: [] });
    expect(shard.reindexPrimeRadiantVault).toHaveBeenCalledTimes(1);
    expect(shard.searchPrimeRadiant).not.toHaveBeenCalled();
  });

  it("answers 503 when the embedder cannot take the query", async () => {
    await seed();
    shard.searchPrimeRadiant.mockRejectedValue(new Error("The embedding model did not answer: HTTP 502"));
    const res = await searchGET(req("/search?q=acme"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("search_failed");
  });
});
