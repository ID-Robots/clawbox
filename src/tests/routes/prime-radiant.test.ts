/**
 * GET /setup-api/prime-radiant/{status,pages,pages/<path>,lint} over a real
 * vault in a tmp dir. Owner-only like every other setup-api route.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const oc = vi.hoisted(() => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfigStrict: vi.fn(async () => ({})),
  runOpenclawConfigSetBatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/openclaw-config", () => oc);

import { GET as statusGET } from "@/app/setup-api/prime-radiant/status/route";
import { GET as pagesGET } from "@/app/setup-api/prime-radiant/pages/route";
import { GET as pageGET } from "@/app/setup-api/prime-radiant/pages/[...path]/route";
import { GET as lintGET } from "@/app/setup-api/prime-radiant/lint/route";
import { vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

// Real git processes, in series: give them room on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-routes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

const ORIGIN = "http://clawbox.local/setup-api/prime-radiant";
const req = (p: string) => new Request(`${ORIGIN}${p}`);
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
  oc.openclawIsAbsent.mockReturnValue(false);
  oc.readConfigStrict.mockResolvedValue({});
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("prime radiant routes: auth", () => {
  it("answers whatever requireSession answers, before touching the vault", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "owner_only", code: "owner_only" }, { status: 403 }));
    for (const res of [await statusGET(req("/status")), await pagesGET(req("/pages")), await lintGET(req("/lint")), await pageReq(["concepts", "x.md"])]) {
      expect(res.status).toBe(403);
    }
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
    expect(auth.requireSession).toHaveBeenCalledWith(expect.any(Request));
  });
});

describe("GET /status", () => {
  it("creates the vault on first use and reports it", async () => {
    const res = await statusGET(req("/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.vault).toMatchObject({ created: true, pages: 0, claims: 0 });
    expect(body.git).toMatchObject({ branch: "main", commits: 1, head: { subject: "init: vault" } });
    expect(body.plugin).toMatchObject({ state: "needs-write" });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    const again = await (await statusGET(req("/status"))).json();
    expect(again.vault.created).toBe(false);
  });

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

  it("answers 500 with a code when the vault cannot be made", async () => {
    const blocker = path.join(base, `blocker-${n}`);
    fs.writeFileSync(blocker, "a file where the folder should be");
    process.env.PRIME_RADIANT_DIR = blocker;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await lintGET(req("/lint"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "vault_unavailable" });
    spy.mockRestore();
  });
});
