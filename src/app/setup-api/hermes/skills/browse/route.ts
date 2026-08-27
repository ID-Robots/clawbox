export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  type BrowseResponse,
  type CatalogFacets,
  type HermesSkill,
  MAX_BROWSE_PAGE,
  MAX_FACET_SELECTION,
  MAX_FACET_VALUES,
  clampInt,
  isBrowsableSource,
  isValidMeta,
  isValidQuery,
  isValidSort,
  isValidSource,
  sourceFlagValue,
  sourceLabel,
} from "@/lib/hermes-skills";
import {
  type TrustBucket,
  TRUST_BUCKETS,
  categoryLabelFromKey,
  fixedFacets,
  isTrustBucket,
  isValidCategoryKey,
  normalizeCategory,
  rankFacets,
  trustBucket,
} from "@/lib/hermes-skill-facets";
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
// first page, the facet rail and full-text search are instant and work with no
// network. The CLI is the fallback for a device whose index hasn't been built
// yet: `search --json` when there's a query, the `browse` table otherwise. Both
// are lossy and unpaged, so the response marks itself `degraded`, its facets
// `facetScope: "loaded"`, and the UI says so instead of pretending page 2
// exists or that a page count is a catalogue count.
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

/**
 * A multi-select facet parameter. Accepts repeats (`?trust=a&trust=b`) and
 * comma lists (`?trust=a,b`) so a bookmarked URL is readable, and de-duplicates
 * so a caller cannot make the filter loop do work by repeating one value.
 * `null` = the value list contained something invalid, which is a 400 rather
 * than a filter silently dropped.
 */
function facetParam(
  values: string[],
  valid: (value: string) => boolean,
): string[] | null {
  const out: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (!v) continue;
      if (!valid(v)) return null;
      if (!out.includes(v)) out.push(v);
      if (out.length > MAX_FACET_SELECTION) return null;
    }
  }
  return out;
}

/** Facets for the CLI fallback: the only honest scope is what came back. */
function facetsOfRows(
  skills: HermesSkill[],
  selected: { sources: string[]; trust: string[]; categories: string[] },
): { facets: CatalogFacets; categoryCoverage: number } {
  const sources = new Map<string, number>();
  const trust = new Map<string, number>();
  const categories = new Map<string, number>();
  let categoryCoverage = 0;
  for (const s of skills) {
    const sourceId = sourceFlagValue(s.source || "unknown");
    sources.set(sourceId, (sources.get(sourceId) || 0) + 1);
    const bucket = trustBucket(s.trust);
    trust.set(bucket, (trust.get(bucket) || 0) + 1);
    const category = normalizeCategory(s.category)?.key;
    if (category) {
      categories.set(category, (categories.get(category) || 0) + 1);
      categoryCoverage++;
    }
  }
  return {
    facets: {
      sources: rankFacets(sources, selected.sources, sourceLabel, MAX_FACET_VALUES),
      providers: [],
      trust: fixedFacets(TRUST_BUCKETS, trust, selected.trust, (id: TrustBucket) => id),
      categories: rankFacets(categories, selected.categories, categoryLabelFromKey, MAX_FACET_VALUES),
    },
    categoryCoverage,
  };
}

export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  const sortRaw = (params.get("sort") || "").trim();
  const page = clampInt(params.get("page"), 1, MAX_BROWSE_PAGE, 1);
  const pageSize = clampInt(params.get("size"), 1, 48, 24);

  if (page === null) return NextResponse.json({ error: "Invalid page" }, { status: 400 });
  if (pageSize === null) return NextResponse.json({ error: "Invalid size" }, { status: 400 });
  if (q && !isValidQuery(q)) return NextResponse.json({ error: "Invalid query" }, { status: 400 });

  // The in-memory filter accepts every source the catalog can contain; only the
  // CLI fallback is restricted to the flag allowlist (see below). `?source=`
  // stays single-valued for the MCP tool and any bookmarked link; the rail
  // sends the same name repeated.
  const sources = facetParam(params.getAll("source"), isBrowsableSource);
  if (sources === null) return NextResponse.json({ error: "Unknown source" }, { status: 400 });
  const providers = facetParam(params.getAll("provider"), (v) => isValidMeta(v));
  if (providers === null) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  const trust = facetParam(params.getAll("trust"), isTrustBucket);
  if (trust === null) return NextResponse.json({ error: "Invalid trust" }, { status: 400 });
  const categories = facetParam(params.getAll("category"), isValidCategoryKey);
  if (categories === null) return NextResponse.json({ error: "Invalid category" }, { status: 400 });

  if (sortRaw && !isValidSort(sortRaw)) {
    return NextResponse.json({ error: "Invalid sort" }, { status: 400 });
  }
  // Without a query "relevance" is meaningless, so the default listing is
  // ordered by trust — the most useful thing to show a customer first.
  const sort = isValidSort(sortRaw) ? sortRaw : q ? "relevance" : "trust";
  // Both spellings of skills.sh reach this handler; the facet ids the response
  // carries — and therefore the ones the rail sends back — are the flag ones.
  const wantSources = sources.map(sourceFlagValue);

  const state = await loadCatalog();
  if (state) {
    const result = queryCatalog(state, {
      q: q || undefined,
      sources: wantSources,
      providers,
      trust,
      categories,
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
      facets: {
        sources: result.sources,
        // The publisher facet exists only for GitHub-sourced skills, so it is
        // offered only while GitHub is one of the selected sources.
        providers: wantSources.includes("github") ? result.providers : [],
        trust: result.trust,
        categories: result.categories,
      },
      categoryCoverage: result.categoryCoverage,
      facetScope: "catalog",
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
    // has no `--source` flag, and the CLI takes ONE source — so the flag is
    // sent only for a single selection it recognises. Everything else is
    // filtered in memory below, over whatever the CLI returned.
    const only = wantSources.length === 1 ? wantSources[0] : "";
    const flagSource = only && isValidSource(only) ? only : undefined;
    // The CLI call is queued and cancelled with the request, so a user who
    // scrolls away doesn't leave a pile of Python processes on the Jetson.
    const fetched = q
      ? await cliSearch(q, flagSource, 50, request.signal)
      : (await cliBrowse(page, Math.min(pageSize, 50), flagSource, request.signal)).skills;
    // Whatever the flag could not express is applied here, so a rail selection
    // never appears to be ignored just because the index is still building.
    const skills = fetched.filter((s) => {
      if (wantSources.length && !wantSources.includes(sourceFlagValue(s.source || "unknown"))) return false;
      if (trust.length && !trust.includes(trustBucket(s.trust))) return false;
      if (categories.length) {
        const key = normalizeCategory(s.category)?.key;
        if (!key || !categories.includes(key)) return false;
      }
      return true;
    });
    const { facets, categoryCoverage } = facetsOfRows(skills, {
      sources: wantSources,
      trust,
      categories,
    });
    const body: BrowseResponse = {
      skills,
      page,
      pageSize,
      total: skills.length,
      totalPages: 1,
      hasMore: false,
      facets,
      categoryCoverage,
      // Counted over this answer alone — there is no index to count against.
      facetScope: "loaded",
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
