'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowseResponse, CatalogFacet, CatalogMeta, HermesSkill, SortOption } from '@/lib/hermes-skills';

// Browse-tab data: one endpoint (/browse) serves listing, search, facets and
// paging, so this hook owns the whole query state and the append-on-scroll list.

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

export interface CatalogController {
  query: string;
  setQuery: (value: string) => void;
  source: string;
  setSource: (value: string) => void;
  provider: string;
  setProvider: (value: string) => void;
  sort: SortOption;
  setSort: (value: SortOption) => void;
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
  error: string | null;
  degraded: boolean;
  catalog: CatalogMeta | null;
  sources: CatalogFacet[];
  providers: CatalogFacet[];
  loadMore: () => void;
  reload: () => void;
  clearFilters: () => void;
}

export function useSkillCatalog(active: boolean): CatalogController {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [source, setSource] = useState('all');
  const [provider, setProvider] = useState('');
  const [sort, setSort] = useState<SortOption>('relevance');
  const [results, setResults] = useState<HermesSkill[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [catalog, setCatalog] = useState<CatalogMeta | null>(null);
  const [sources, setSources] = useState<CatalogFacet[]>([]);
  const [providers, setProviders] = useState<CatalogFacet[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const seenIds = useRef<Set<string>>(new Set());
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query]);

  /**
   * Changing the source has to clean up after itself:
   *  - the publisher facet only exists for GitHub skills, so a stale provider
   *    would silently filter every other source down to nothing;
   *  - "Most installed" only exists for browse.sh (the only source with an
   *    install counter), so leaving it selected would show an option that is no
   *    longer in the list.
   */
  const changeSource = useCallback(
    (value: string) => {
      setSource(value);
      if (value !== 'github') setProvider('');
      if (value !== 'browse-sh') setSort((s) => (s === 'popular' ? 'relevance' : s));
    },
    [],
  );

  const buildUrl = useCallback(
    (targetPage: number) => {
      const params = new URLSearchParams({ page: String(targetPage), size: String(PAGE_SIZE), sort });
      if (debounced) params.set('q', debounced);
      if (source && source !== 'all') params.set('source', source);
      if (provider) params.set('provider', provider);
      return `${BROWSE_URL}?${params}`;
    },
    [debounced, source, provider, sort],
  );

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      if (append) setAppending(true);
      else {
        setLoading(true);
        setError(null);
      }
      const slowTimer = append ? null : setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      try {
        const res = await fetch(buildUrl(targetPage), { signal: controller.signal, cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as Partial<BrowseResponse> & { error?: string };
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
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
          setSources(data.facets?.sources ?? []);
          setProviders(data.facets?.providers ?? []);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (!append) {
          setError(err instanceof Error ? err.message : 'Couldn’t load skills');
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
    fetchPage(1, false);
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
  const clearFilters = useCallback(() => {
    changeSource('all');
  }, [changeSource]);

  return useMemo(
    () => ({
      query,
      setQuery,
      source,
      setSource: changeSource,
      provider,
      setProvider,
      sort,
      setSort,
      results,
      total,
      hasMore,
      loading,
      appending,
      slow,
      preparing,
      error,
      degraded,
      catalog,
      sources,
      providers,
      loadMore,
      reload,
      clearFilters,
    }),
    [
      query,
      source,
      provider,
      sort,
      results,
      total,
      hasMore,
      loading,
      appending,
      slow,
      preparing,
      error,
      degraded,
      catalog,
      sources,
      providers,
      loadMore,
      reload,
      clearFilters,
      changeSource,
    ],
  );
}

export { PAGE_SIZE };
