/**
 * Orphans over the link graph (links.ts `contentReach`): a content page is an
 * orphan when no OTHER content page links to it — index.md, source pages and
 * pages outside the content folders do not count — and isolated when it
 * links to no content page either. Fixtures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { buildLinkGraph, contentReach, isContentPage } from "@/lib/prime-radiant/links";

const graphOf = (pages: Record<string, string>, indexBody: string | null = null) =>
  buildLinkGraph(Object.entries(pages).map(([path, body]) => ({ path, body })), indexBody);

describe("content pages", () => {
  it("are the concepts, entities and syntheses folders", () => {
    expect(["concepts/a.md", "entities/acme.md", "syntheses/hub.md"].every(isContentPage)).toBe(true);
    expect(["index.md", "overview.md", "sources/a.md", "reports/r.md", "_views/v.md", "concepts.md"].some(isContentPage)).toBe(false);
  });
});

describe("contentReach", () => {
  it("does not let index.md, a source page or a top-level page reach a page", () => {
    const g = graphOf(
      {
        "concepts/listed.md": "Listed.",
        "sources/doc.md": "From [[concepts/listed]].",
        "overview.md": "Start at [[concepts/listed]].",
      },
      "# Index\n\n- [[concepts/listed]]\n",
    );
    expect(g.indexed.has("concepts/listed.md")).toBe(true);
    const reach = contentReach(g);
    expect([...reach.orphans]).toEqual(["concepts/listed.md"]);
    expect([...reach.isolated]).toEqual(["concepts/listed.md"]);
  });

  it("counts a link from another content page, and tells an orphan that links out from an isolated one", () => {
    const reach = contentReach(
      graphOf({
        "concepts/a.md": "See [[concepts/b]].",
        "concepts/b.md": "Plain.",
        "entities/c.md": "Links to [[sources/doc]] only.",
        "sources/doc.md": "A source.",
      }),
    );
    // b is linked by a; a links out but nobody links it; c links only a source page.
    expect([...reach.orphans].sort()).toEqual(["concepts/a.md", "entities/c.md"]);
    expect([...reach.isolated]).toEqual(["entities/c.md"]);
  });

  it("never counts a page's link to itself", () => {
    const reach = contentReach({
      outbound: new Map([["concepts/self.md", new Set(["concepts/self.md"])]]),
      inbound: new Map([["concepts/self.md", new Set(["concepts/self.md"])]]),
    });
    expect([...reach.orphans]).toEqual(["concepts/self.md"]);
    expect([...reach.isolated]).toEqual(["concepts/self.md"]);
  });
});
