'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BrowseFailureCode,
  type BrowseResponse,
  type CatalogFacets,
  type CatalogMeta,
  type FacetScope,
  type HermesSkill,
  type SortOption,
  isBrowseFailureCode,
} from '@/lib/hermes-skills';

// Browse-tab data: one endpoint (/browse) serves listing, search, the facet rail
// and paging, so this hook owns the whole query state and the append-on-scroll
// list.

const BROWSE_URL = '/setup-api/hermes/skills/browse';
const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;
// The very first browse on a fresh device builds a ~41 MB index (about a
// minute). Anything slower than this gets the explanatory first-run copy
// instead of an unexplained spinner.
const SLOW_AFTER_MS = 4000;
// While the index builds, the endpoint ANSWERS — quickly, with zero results and
// `catalog.origin === 'warming'`. Nothing is in flight afterwards, so without a
// timer the view would sit on that empty answer until the user reopened the
// window or retyped their search. Re-ask on this cadence instead; polling stops
// by itself the moment the origin is no longer 'warming'.
const WARM_POLL_MS = 5000;

/** The rail's groups on the Browse tab, in the order it renders them. */
export const BROWSE_FACET_GROUPS = ['trust', 'source', 'category', 'provider'] as const;
export type BrowseFacetGroup = (typeof BROWSE_FACET_GROUPS)[number];

export type FacetSelection = Record<BrowseFacetGroup, string[]>;

const EMPTY_SELECTION: FacetSelection = { trust: [], source: [], category: [], provider: [] };
const EMPTY_FACETS: CatalogFacets = { sources: [], providers: [], trust: [], categories: [] };

/**
 * The one invariant a selection has to keep: the publisher facet describes
 * GitHub rows only, so a publisher left ticked once GitHub rows are out of
 * reach would silently filter every other source down to nothing. GitHub is
 * reachable while NO source is ticked as well as while GitHub itself is, which
 * is why this is not simply `includes('github')`.
 *
 * Applied in the state updater rather than in an effect — an effect would fire
 * a request for the inconsistent state first and correct it afterwards.
 */
function reconcile(selection: FacetSelection): FacetSelection {
  const githubReachable = selection.source.length === 0 || selection.source.includes('github');
  if (githubReachable || selection.provider.length === 0) return selection;
  return { ...selection, provider: [] };
}

export interface CatalogController {
  query: string;
  setQuery: (value: string) => void;
  sort: SortOption;
  setSort: (value: SortOption) => void;
  /** Ticked values per rail group. */
  selected: FacetSelection;
  toggleFacet: (group: BrowseFacetGroup, id: string) => void;
  removeFacet: (group: BrowseFacetGroup, id: string) => void;
  /** How many facet values are ticked across every group. */
  activeCount: number;
  results: HermesSkill[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  appending: boolean;
  slow: boolean;
  /**
   * The device is still building its offline index and has nothing to show yet.
   *
   * Deliberately NOT tied to `loading`: the browse endpoint completes while the
   * index warms (it answers from the CLI fallback, which on a fresh device has
   * nothing either), so by the time this is rendered no request is in flight.
   * Keying the first-run panel on `loading` therefore left the generic "nothing
   * here / try a different term" copy describing a catalogue of ~90 000 skills
   * that simply hadn't finished unpacking.
   */
  preparing: boolean;
  /**
   * The results on screen are NOT the answer to the filters on screen — a
   * request is in flight, or has not started yet because the selection changed
   * this render. Anything that reports a count (the polite announcement) has to
   * wait for this to clear, or it states the previous answer's total under the
   * new filters.
   */
  stale: boolean;
  /**
   * Why page 1 could not be loaded: the route's code, or 'unknown' for a
   * failure that carried none (an older device build, a transport error).
   * Never the message — that is English composed on the server, and the one
   * place it belongs is the console.
   */
  error: BrowseFailureCode | 'unknown' | null;
  degraded: boolean;
  catalog: CatalogMeta | null;
  facets: CatalogFacets;
  /** Rows in the current result set that carry a usable category. */
  categoryCoverage: number;
  /** Whether the counts were measured over the catalogue or this answer alone. */
  facetScope: FacetScope;
  loadMore: () => void;
  reload: () => void;
  clearFilters: () => void;
}

export function useSkillCatalog(active: boolean): CatalogController {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<FacetSelection>(EMPTY_SELECTION);
  const [sort, setSort] = useState<SortOption>('relevance');
  const [results, setResults] = useState<HermesSkill[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<BrowseFailureCode | 'unknown' | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [catalog, setCatalog] = useState<CatalogMeta | null>(null);
  const [facets, setFacets] = useState<CatalogFacets>(EMPTY_FACETS);
  const [categoryCoverage, setCategoryCoverage] = useState(0);
  const [facetScope, setFacetScope] = useState<FacetScope>('catalog');
  const [reloadKey, setReloadKey] = useState(0);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query]);

  const applySelection = useCallback((change: (prev: FacetSelection) => FacetSelection) => {
    setSelected((prev) => reconcile(change(prev)));
  }, []);

  const toggleFacet = useCallback(
    (group: BrowseFacetGroup, id: string) => {
      applySelection((prev) => {
        const current = prev[group];
        return {
          ...prev,
          [group]: current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
        };
      });
    },
    [applySelection],
  );

  const removeFacet = useCallback(
    (group: BrowseFacetGroup, id: string) => {
      applySelection((prev) => ({ ...prev, [group]: prev[group].filter((v) => v !== id) }));
    },
    [applySelection],
  );

  /**
   * "Most installed" only exists for browse.sh — the one source with an install
   * counter. Derived rather than reset on selection change, so unticking
   * browse.sh and ticking it again brings the user's chosen order back instead
   * of quietly leaving them on "Best match".
   */
  const effectiveSort: SortOption =
    sort === 'popular' && !selected.source.includes('browse-sh') ? 'relevance' : sort;

  const buildUrl = useCallback(
    (targetPage: number) => {
      const params = new URLSearchParams({
        page: String(targetPage),
        size: String(PAGE_SIZE),
        sort: effectiveSort,
      });
      if (debounced) params.set('q', debounced);
      // One repeated parameter per ticked value: `?source=github&source=clawhub`.
      for (const id of selected.source) params.append('source', id);
      for (const id of selected.trust) params.append('trust', id);
      for (const id of selected.category) params.append('category', id);
      for (const id of selected.provider) params.append('provider', id);
      return `${BROWSE_URL}?${params}`;
    },
    [debounced, selected, effectiveSort],
  );

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean, key?: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      if (append) setAppending(true);
      else {
        setLoading(true);
        setError(null);
      }
      const slowTimer = append ? null : setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      let failure: BrowseFailureCode | 'unknown' = 'unknown';
      try {
        const res = await fetch(buildUrl(targetPage), { signal: controller.signal, cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as Partial<BrowseResponse> & {
          error?: string;
          code?: string;
        };
        if (!res.ok) {
          if (isBrowseFailureCode(data?.code)) failure = data.code;
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const incoming = Array.isArray(data.skills) ? data.skills : [];
        if (append) {
          const fresh = incoming.filter((s) => !seenIds.current.has(s.id));
          for (const s of fresh) seenIds.current.add(s.id);
          setResults((prev) => [...prev, ...fresh]);
        } else {
          seenIds.current = new Set(incoming.map((s) => s.id));
          setResults(incoming);
        }
        setPage(targetPage);
        setTotal(data.total ?? incoming.length);
        setHasMore(!!data.hasMore);
        setDegraded(!!data.degraded);
        setCatalog(data.catalog ?? null);
        if (!append) {
          setFacets({ ...EMPTY_FACETS, ...(data.facets ?? {}) });
          setCategoryCoverage(data.categoryCoverage ?? 0);
          setFacetScope(data.facetScope === 'loaded' ? 'loaded' : 'catalog');
          if (key) setSettledKey(key);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (!append) {
          console.error('[skills browse]', err);
          setError(failure);
          setResults([]);
          setTotal(0);
          setHasMore(false);
        }
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
        if (inFlight.current === controller) inFlight.current = null;
        if (append) setAppending(false);
        else {
          setLoading(false);
          setSlow(false);
        }
      }
    },
    [buildUrl],
  );

  // The query the current `results` were loaded for. Without it, flipping the
  // tab away and back re-ran page 1 and threw away every page the user had
  // scrolled into the list.
  const loadedKey = useRef<string | null>(null);
  const queryKey = `${buildUrl(1)}#${reloadKey}`;

  useEffect(() => {
    if (!active) return;
    if (loadedKey.current === queryKey) return; // same query, already loaded
    loadedKey.current = queryKey;
    fetchPage(1, false, queryKey);
    return () => inFlight.current?.abort();
  }, [active, queryKey, fetchPage]);

  const preparing = catalog?.origin === 'warming' && results.length === 0 && !error;

  // Self-healing poll for the state above. `catalog` is a fresh object on every
  // response, so each answer that is still 'warming' schedules the next ask and
  // the first non-warming one ends the chain — no separate attempt counter, and
  // nothing left running once the index is ready or the tab is left.
  useEffect(() => {
    if (!active || !preparing || catalog?.origin !== 'warming') return;
    const t = setTimeout(() => setReloadKey((k) => k + 1), WARM_POLL_MS);
    return () => clearTimeout(t);
  }, [active, preparing, catalog]);

  const loadMore = useCallback(() => {
    if (loading || appending || !hasMore) return;
    fetchPage(page + 1, true);
  }, [loading, appending, hasMore, page, fetchPage]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const clearFilters = useCallback(() => setSelected(EMPTY_SELECTION), []);

  const activeCount =
    selected.trust.length + selected.source.length + selected.category.length + selected.provider.length;

  return useMemo(
    () => ({
      query,
      setQuery,
      sort: effectiveSort,
      setSort,
      selected,
      toggleFacet,
      removeFacet,
      activeCount,
      results,
      total,
      hasMore,
      loading,
      appending,
      slow,
      preparing,
      stale: settledKey !== queryKey,
      error,
      degraded,
      catalog,
      facets,
      categoryCoverage,
      facetScope,
      loadMore,
      reload,
      clearFilters,
    }),
    [
      query,
      effectiveSort,
      selected,
      toggleFacet,
      removeFacet,
      activeCount,
      results,
      total,
      hasMore,
      loading,
      appending,
      slow,
      preparing,
      settledKey,
      queryKey,
      error,
      degraded,
      catalog,
      facets,
      categoryCoverage,
      facetScope,
      loadMore,
      reload,
      clearFilters,
    ],
  );
}

export { PAGE_SIZE };
