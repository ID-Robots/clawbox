/**
 * GET /setup-api/prime-radiant/graph — the Map's graph over a real vault in a
 * tmp dir: owner-only, never creates the vault, compact numeric shape, the
 * edge rules (links; shared sources without cliques; related hints for the
 * pages no link reaches) and the cache kept per vault revision.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
// The vault's Memory Shard index: stubbed (it embeds), pinned in its own suite.
const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { GET as graphGET } from "@/app/setup-api/prime-radiant/graph/route";
import {
  buildVaultGraph,
  clearGraphCache,
  getVaultGraph,
  MAX_RELATED_EDGES,
  MAX_SOURCE_EDGES,
  pageTopics,
  RELATED_WEIGHT,
  SOURCE_WEIGHT,
  topicKey,
  type GraphPage,
  type VaultGraph,
} from "@/lib/prime-radiant/graph";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, pageText } from "../helpers/prime-radiant-fixtures";

// Real git processes, in series: give them room on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-graph-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

const req = () => new Request("http://clawbox.local/setup-api/prime-radiant/graph");
const getGraph = async (): Promise<VaultGraph> => {
  const res = await graphGET(req());
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json();
};

async function seed() {
  await vaultOperation("ingest: seed", async (tx) => {
    await tx.write(
      "entities/acme-widgets.md",
      pageText(
        { type: "entity", title: "Acme Widgets Ltd", domain: "acme-sales", sources: ["upload/acme-overview.pdf", "upload/acme-prices.csv"] },
        "Acme Widgets Ltd sells widgets.\n\nPrices: [[concepts/pricing]]. Support: [hours](../concepts/support.md).\n",
      ),
    );
    // Links back: the pair stays one edge.
    await tx.write("concepts/pricing.md", pageText({ title: "Widget pricing", sources: ["upload/acme-prices.csv"] }, "Prices for [[Acme Widgets Ltd]].\n"));
    // Shares a source with acme-widgets and links nowhere.
    await tx.write("concepts/support.md", pageText({ title: "Support hours", domain: "acme-support", sources: ["upload/acme-overview.pdf"] }, "Support answers on weekdays.\n"));
    // Nothing in common with anything.
    await tx.write("concepts/holidays.md", pageText({ title: "Office holidays", domain: "acme-support", sources: [] }, "The office closes in August.\n"));
  });
}

beforeEach(() => {
  auth.requireSession.mockResolvedValue(null);
  clearGraphCache();
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GET /setup-api/prime-radiant/graph", () => {
  it("answers whatever requireSession answers, before touching the vault", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "owner_only", code: "owner_only" }, { status: 403 }));
    const res = await graphGET(req());
    expect(res.status).toBe(403);
    expect(auth.requireSession).toHaveBeenCalledWith(expect.any(Request));
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("answers an empty graph for a vault that does not exist yet, and creates nothing", async () => {
    expect(await getGraph()).toEqual({ revision: null, truncated: false, nodes: [], edges: [] });
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("answers every page as a node and the links and shared sources as numeric edges", async () => {
    await seed();
    const graph = await getGraph();
    expect(graph.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(graph.truncated).toBe(false);
    const ids = graph.nodes.map((x) => x.id);
    expect(ids.sort()).toEqual(["concepts/holidays.md", "concepts/pricing.md", "concepts/support.md", "entities/acme-widgets.md"]);
    const at = (id: string) => graph.nodes.findIndex((x) => x.id === id);
    const widgets = graph.nodes[at("entities/acme-widgets.md")];
    expect(widgets).toEqual({ id: "entities/acme-widgets.md", title: "Acme Widgets Ltd", domain: "acme-sales", degree: 2, links: 2, sources: 2 });
    expect(graph.nodes[at("concepts/holidays.md")]).toMatchObject({ links: 0, sources: 0, domain: "acme-support" });

    // Every edge is [a, b, w] with a < b, indexes into nodes, one per pair.
    for (const [a, b, w] of graph.edges) {
      expect(Number.isInteger(a) && Number.isInteger(b) && a < b && b < graph.nodes.length).toBe(true);
      expect([1, SOURCE_WEIGHT, RELATED_WEIGHT]).toContain(w);
    }
    const edge = (x: string, y: string) => graph.edges.find(([a, b]) => (a === at(x) && b === at(y)) || (a === at(y) && b === at(x)));
    // A wikilink one way and one back: one link edge.
    expect(edge("entities/acme-widgets.md", "concepts/pricing.md")?.[2]).toBe(1);
    // A Markdown link and a shared source: the link wins.
    expect(edge("entities/acme-widgets.md", "concepts/support.md")?.[2]).toBe(1);
    // Holidays links nowhere: a related hint to its domain's other page, not counted as a connection.
    expect(edge("concepts/holidays.md", "concepts/support.md")?.[2]).toBe(RELATED_WEIGHT);
    expect(graph.nodes[at("concepts/holidays.md")].links).toBe(0);
    expect(graph.edges).toHaveLength(3);
    expect(edge("concepts/holidays.md", "concepts/pricing.md")).toBeUndefined();
  });

  it("gives a vault of pages from separate documents, none linked, related hints by domain", async () => {
    // The owner's vault: 48 pages, no wikilinks, a source each, 24 domains.
    await vaultOperation("ingest: separate documents", async (tx) => {
      for (let i = 0; i < 48; i++) {
        await tx.write(
          `concepts/note-${String(i).padStart(2, "0")}.md`,
          pageText({ title: `Note ${i}`, domain: `domain-${Math.floor(i / 2)}`, sources: [`upload/doc-${i}.pdf`] }, `Note ${i} stands alone.\n`),
        );
      }
    });
    const graph = await getGraph();
    expect(graph.nodes).toHaveLength(48);
    expect(graph.edges.length).toBe(24);
    const touched = new Set<number>();
    for (const [a, b, w] of graph.edges) {
      expect(w).toBe(RELATED_WEIGHT);
      expect(graph.nodes[a].domain).toBe(graph.nodes[b].domain);
      touched.add(a).add(b);
    }
    expect(touched.size).toBe(48);
    // Still no links: every page has no link, but its hints count in its degree.
    expect(graph.nodes.every((x) => x.links === 0)).toBe(true);
    expect(graph.nodes.every((x) => x.degree > 0)).toBe(true);
  });

  it("ties unlinked pages that share a tag or a claim's subject, across domains", async () => {
    await vaultOperation("ingest: topics", async (tx) => {
      await tx.write("concepts/a.md", pageText({ title: "Alpha", domain: "acme-sales", sources: [], tags: ["Acme Widgets"] } as never, "Alpha.\n"));
      await tx.write(
        "concepts/b.md",
        pageText({ title: "Beta", domain: "acme-support", sources: [], claims: [claim("acme-support/acme-widgets/answers-weekdays", "Acme Widgets Ltd answers on weekdays.")] }, "Beta.\n"),
      );
    });
    const graph = await getGraph();
    expect(graph.edges).toEqual([[0, 1, RELATED_WEIGHT]]);
  });

  it("ties pages that share only a source with a half-weight edge", async () => {
    await vaultOperation("ingest: shared", async (tx) => {
      await tx.write("concepts/a.md", pageText({ title: "Alpha", sources: ["upload/acme-catalogue.pdf"] }, "Alpha.\n"));
      await tx.write("concepts/b.md", pageText({ title: "Beta", sources: ["upload/acme-catalogue.pdf"] }, "Beta.\n"));
    });
    const graph = await getGraph();
    expect(graph.edges).toEqual([[0, 1, SOURCE_WEIGHT]]);
    expect(graph.nodes.map((x) => x.degree)).toEqual([1, 1]);
  });

  it("keeps the graph for the revision, and builds it again once the vault moves", async () => {
    await seed();
    const vault = vaultDir();
    const first = await getVaultGraph(vault);
    // Nothing changed: the very same graph, no page read again.
    expect(await getVaultGraph(vault)).toBe(first);

    // A commit moves HEAD.
    await vaultOperation("ingest: more", async (tx) => {
      await tx.write("concepts/returns.md", pageText({ title: "Returns", sources: [] }, "See [[concepts/pricing]].\n"));
    });
    const second = await getVaultGraph(vault);
    expect(second).not.toBe(first);
    expect(second.revision).not.toBe(first.revision);
    expect(second.nodes).toHaveLength(5);

    // A page written without a commit (memory-wiki's own writes) counts too.
    fs.writeFileSync(path.join(vault, "concepts", "loose.md"), pageText({ title: "Loose page", sources: [] }, "Loose.\n"));
    const third = await getVaultGraph(vault);
    expect(third.revision).toMatch(/^[0-9a-f]{40}\+[0-9a-f]{12}$/);
    expect(third.nodes.map((x) => x.id)).toContain("concepts/loose.md");
    expect(await getVaultGraph(vault)).toBe(third);

    // A second edit to the same uncommitted page is a new revision again.
    fs.writeFileSync(path.join(vault, "concepts", "loose.md"), pageText({ title: "Loose page, renamed", sources: [] }, "Loose, longer now.\n"));
    const fourth = await getVaultGraph(vault);
    expect(fourth.revision).not.toBe(third.revision);
    expect(fourth.nodes.find((x) => x.id === "concepts/loose.md")?.title).toBe("Loose page, renamed");
  });

  it("shares one build between two requests for the same revision", async () => {
    await seed();
    const [a, b] = await Promise.all([getVaultGraph(), getVaultGraph()]);
    expect(a).toBe(b);
  });
});

describe("buildVaultGraph", () => {
  const page = (p: string, extra: Partial<GraphPage> = {}): GraphPage => ({ path: p, title: null, domain: "acme-sales", sources: [], body: "", ...extra });

  it("never makes a clique of a source many pages share", () => {
    const pages = Array.from({ length: 40 }, (_, i) => page(`concepts/p${i}.md`, { sources: ["upload/acme-handbook.pdf"] }));
    const graph = buildVaultGraph(pages, "rev");
    // A ring to the next two: about 2 edges a page, far from 40·39/2.
    expect(graph.edges.length).toBeLessThanOrEqual(80);
    expect(graph.edges.length).toBeGreaterThanOrEqual(40);
    expect(graph.edges.every(([, , w]) => w === SOURCE_WEIGHT)).toBe(true);
    expect(Math.max(...graph.nodes.map((x) => x.degree))).toBeLessThanOrEqual(MAX_SOURCE_EDGES);
  });

  it("caps a page's shared-source edges across all its sources", () => {
    const sources = Array.from({ length: 10 }, (_, i) => `upload/doc-${i}.pdf`);
    const hub = page("entities/acme-widgets.md", { sources });
    const others = sources.flatMap((s, i) => [page(`concepts/a${i}.md`, { sources: [s] }), page(`concepts/b${i}.md`, { sources: [s] })]);
    const graph = buildVaultGraph([hub, ...others], "rev");
    expect(graph.nodes[0].degree).toBe(MAX_SOURCE_EDGES);
    expect(graph.nodes[0].sources).toBe(10);
  });

  it("ties every page of a small source together, once per pair however many sources they share", () => {
    const shared = ["upload/x.pdf", "upload/y.pdf"];
    const graph = buildVaultGraph([page("a.md", { sources: shared }), page("b.md", { sources: shared }), page("c.md", { sources: ["upload/x.pdf"] })], "rev");
    expect(graph.edges.map(([a, b]) => `${a}-${b}`).sort()).toEqual(["0-1", "0-2", "1-2"]);
  });

  it("titles a page without a valid title by its file name, and keeps a missing domain as null", () => {
    const graph = buildVaultGraph([page("concepts/widget-sizes.md", { domain: null })], null);
    expect(graph.nodes[0]).toEqual({ id: "concepts/widget-sizes.md", title: "widget-sizes", domain: null, degree: 0, links: 0, sources: 0 });
  });

  it("ties the pages no link reaches: a shared topic first, else neighbours in their own domain", () => {
    const pages = [
      page("p0.md", { domain: "sales", topics: ["Acme Widgets"] }),
      page("p1.md", { domain: "support", topics: ["acme-widgets"] }),
      page("p2.md", { domain: "sales" }),
      page("p3.md", { domain: "legal", topics: ["ACME widgets"], body: "[[p4]]" }),
      page("p4.md", { domain: "legal" }),
      page("p5.md", { domain: null }),
      page("p6.md", { domain: null }),
    ];
    const graph = buildVaultGraph(pages, "rev");
    const w = (x: number, y: number) => graph.edges.find(([a, b]) => a === Math.min(x, y) && b === Math.max(x, y))?.[2];
    expect(w(3, 4)).toBe(1);
    // One topic, three spellings: the two unlinked pages, and each to the linked page that shares it.
    expect(w(0, 1)).toBe(RELATED_WEIGHT);
    expect(w(0, 3)).toBe(RELATED_WEIGHT);
    expect(w(1, 3)).toBe(RELATED_WEIGHT);
    // p2 shares nothing: its domain's other page.
    expect(w(2, 0)).toBe(RELATED_WEIGHT);
    // Pages with no domain and no topic have nothing to go by.
    expect(graph.edges.some(([a, b]) => a >= 5 || b >= 5)).toBe(false);
    expect(graph.edges).toHaveLength(5);
    // Hints are not links, but they are edges of the node.
    expect(graph.nodes.map((x) => x.links)).toEqual([0, 0, 0, 1, 1, 0, 0]);
    expect(graph.nodes.map((x) => x.degree)).toEqual([3, 2, 1, 3, 1, 0, 0]);
  });

  it("keeps related hints to a ring, a few per page, however many pages share a topic", () => {
    const pages = Array.from({ length: 300 }, (_, i) => page(`concepts/p${i}.md`, { domain: `d${i % 7}`, topics: ["widgets"] }));
    const graph = buildVaultGraph(pages, "rev");
    const per = new Uint32Array(300);
    for (const [a, b, w] of graph.edges) {
      expect(w).toBe(RELATED_WEIGHT);
      per[a]++;
      per[b]++;
    }
    expect(Math.max(...per)).toBeLessThanOrEqual(MAX_RELATED_EDGES);
    expect(Math.min(...per)).toBeGreaterThanOrEqual(1);
    expect(graph.edges.length).toBeLessThanOrEqual(600);
  });

  it("adds no hint to a page a link already reaches", () => {
    const graph = buildVaultGraph([page("a.md", { body: "[[b]]", topics: ["x"] }), page("b.md", { topics: ["x"] }), page("c.md", { body: "[[d]]" }), page("d.md")], "rev");
    expect(graph.edges).toEqual([[0, 1, 1], [2, 3, 1]]);
  });

  it("reads topics from a page's entities, subjects, tags and claims, in any script", () => {
    const fm = frontmatter({ claims: [claim("acme-sales/acme-widgets/ships-blue")], tags: ["Финанси", "#Pricing"], entities: "Acme Widgets Ltd", subject: 4 } as never);
    expect(pageTopics(fm).map(topicKey)).toEqual(["acme-widgets-ltd", "финанси", "pricing", "acme-widgets"]);
    expect(topicKey("Café Crème")).toBe(topicKey("cafe-creme"));
  });

  it("drops links to pages that do not exist and self-links", () => {
    const graph = buildVaultGraph([page("a.md", { title: "A", body: "[[a]] [[missing]] [[b]]" }), page("b.md", { title: "B" })], "rev");
    expect(graph.edges).toEqual([[0, 1, 1]]);
  });
});
