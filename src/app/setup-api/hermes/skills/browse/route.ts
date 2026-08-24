export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  type BrowseResponse,
  type CatalogFacet,
  MAX_BROWSE_PAGE,
  clampInt,
  isBrowsableSource,
  isValidMeta,
  isValidQuery,
  isValidSort,
  isValidSource,
  sourceFlagValue,
  sourceLabel,
} from "@/lib/hermes-skills";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";
import {
  cliBrowse,
  cliSearch,
  isWarming,
  loadCatalog,
  queryCatalog,
  warmIndex,
} from "@/lib/hermes-skill-index";

// THE catalog endpoint for the store's Browse tab — listing, search, facets and
// paging all in one shape, because they are one question ("what can I install?")
// asked with different filters.
//
// Served from Hermes' own offline index (~90 600 skills) so paging past the
// first page, source facets and full-text search are instant and work with no
// network. The CLI is the fallback for a device whose index hasn't been built
// yet: `search --json` when there's a query, the `browse` table otherwise. Both
// are lossy and unpaged, so the response marks itself `degraded` and the UI says
// so instead of pretending page 2 exists.
//
// Safety: guard first (404 unless the active harness is Hermes); every value
// that can reach the CLI passes a strict validator and is sent as an argv
// element (never a shell); errors never leak the hermes binary path.

// Staleness is measured from when THIS device last downloaded the index, NOT
// from the index's `generated_at`: that field is baked in by the publisher and
// does not move when the device refetches, so keying off it flagged a
// just-downloaded catalogue as three weeks old and told the user to reconnect.
const STALE_AFTER_HOURS = 24 * 14;

function ageHours(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

const EMPTY_FACETS: { sources: CatalogFacet[]; providers: CatalogFacet[] } = {
  sources: [],
  providers: [],
};

export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  const source = (params.get("source") || "").trim();
  const provider = (params.get("provider") || "").trim();
  const sortRaw = (params.get("sort") || "").trim();
  const page = clampInt(params.get("page"), 1, MAX_BROWSE_PAGE, 1);
  const pageSize = clampInt(params.get("size"), 1, 48, 24);

  if (page === null) return NextResponse.json({ error: "Invalid page" }, { status: 400 });
  if (pageSize === null) return NextResponse.json({ error: "Invalid size" }, { status: 400 });
  if (q && !isValidQuery(q)) return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  // The in-memory filter accepts every source the catalog can contain; only the
  // CLI fallback is restricted to the flag allowlist (see below).
  if (source && !isBrowsableSource(source)) {
    return NextResponse.json({ error: "Unknown source" }, { status: 400 });
  }
  if (provider && !isValidMeta(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }
  if (sortRaw && !isValidSort(sortRaw)) {
    return NextResponse.json({ error: "Invalid sort" }, { status: 400 });
  }
  // Without a query "relevance" is meaningless, so the default listing is
  // ordered by trust — the most useful thing to show a customer first.
  const sort = isValidSort(sortRaw) ? sortRaw : q ? "relevance" : "trust";

  const state = await loadCatalog();
  if (state) {
    const result = queryCatalog(state, {
      q: q || undefined,
      source: source || undefined,
      provider: provider || undefined,
      sort,
      page,
      pageSize,
    });
    const age = ageHours(state.fetchedAt);
    // Only promise pages the client is allowed to ask for. Advertising
    // totalPages/hasMore past MAX_BROWSE_PAGE is what made the load-more
    // sentinel request a page this handler then rejected with a 400.
    const reachablePages = Math.min(Math.max(1, Math.ceil(result.total / pageSize)), MAX_BROWSE_PAGE);
    const body: BrowseResponse = {
      skills: result.skills,
      page,
      pageSize,
      total: result.total,
      totalPages: reachablePages,
      hasMore: page < reachablePages && page * pageSize < result.total,
      facets: { sources: result.sources, providers: source === "github" ? result.providers : [] },
      catalog: {
        origin: "index",
        generatedAt: state.generatedAt,
        fetchedAt: state.fetchedAt,
        skillCount: state.skillCount,
        stale: age !== null && age > STALE_AFTER_HOURS,
      },
      degraded: false,
    };
    return NextResponse.json(body);
  }

  // ── No index: answer from the CLI once, and kick a build for next time ──
  // Kick the build FIRST, then report. Asking `isWarming()` beforehand meant the
  // very first browse on a fresh device — the request that starts the build —
  // described itself as a plain CLI answer, so the UI had nothing to distinguish
  // "still preparing" from "genuinely nothing here" and showed the
  // empty-catalogue copy over a catalogue that was seconds from existing.
  // Still false when the post-failure cooldown declines to start another build,
  // and then "no index, not building" is the honest answer.
  warmIndex();
  const warming = isWarming();
  try {
    // A catalog-only source (skills.sh spelling, claude-marketplace, unknown)
    // has no `--source` flag — drop the filter rather than send hermes a value
    // it will reject.
    const mapped = source ? sourceFlagValue(source) : "";
    const flagSource = mapped && isValidSource(mapped) ? mapped : undefined;
    // The CLI call is queued and cancelled with the request, so a user who
    // scrolls away doesn't leave a pile of Python processes on the Jetson.
    const skills = q
      ? await cliSearch(q, flagSource, 50, request.signal)
      : (await cliBrowse(page, Math.min(pageSize, 50), flagSource, request.signal)).skills;
    const body: BrowseResponse = {
      skills,
      page,
      pageSize,
      total: skills.length,
      totalPages: 1,
      hasMore: false,
      facets: {
        ...EMPTY_FACETS,
        // Without the index the only honest facet is what came back.
        sources: Array.from(
          skills.reduce((m, s) => m.set(s.source || "unknown", (m.get(s.source || "unknown") || 0) + 1), new Map<string, number>()),
        )
          .map(([id, count]) => ({ id, label: sourceLabel(id), count }))
          .sort((a, b) => b.count - a.count),
      },
      catalog: { origin: warming ? "warming" : "cli" },
      degraded: true,
    };
    return NextResponse.json(body);
  } catch (err) {
    // runHermesCli rejects with a sanitized message ("Hermes is not installed on
    // this device", "hermes timed out") — never the binary path.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load skills" },
      { status: 502 },
    );
  }
}
