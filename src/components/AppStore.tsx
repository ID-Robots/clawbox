"use client";

import { useState, useEffect, useCallback, useId, useRef, useMemo } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useT } from "@/lib/i18n";
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR } from "@/lib/store-categories";
import { clawhubSkillUrl } from "@/lib/clawhub-url";
import { categoryLabelFromKey } from "@/lib/hermes-skill-facets";

const STORE_API = "/setup-api/apps/store";
const STORE_ICONS_BASE = "https://clawbox.com/store/icons";
// Upstream `/api/store/apps` caps any single response at 200 apps and offers
// no `offset`/`page` parameter, so on the "All" view we walk through each
// category (also capped at 200) to surface more of the 6000+ catalogue as
// the user scrolls. Per-category requests are deduped by slug against the
// firehose page we already have.
const STORE_PAGE_LIMIT = 200;

// Brand orange from clawbox.com
const BRAND_ORANGE = "#fe6e00";
const BRAND_ORANGE_LIGHT = "#ff8b1a";

interface StoreApp {
  id: string;
  name: string;
  description: string;
  rating: number;
  color: string;
  category: string;
  iconUrl: string;
  developer?: string;
  installs?: string;
  version?: string;
  url?: string;
  tags?: string[];
  /** First-party app (ClawHub channel === "official"). The `verified` flag is
   *  true for every listing, so `channel` is the only meaningful trust signal. */
  official?: boolean;
}

interface ApiApp {
  name: string;
  slug: string;
  summary: string;
  category: string;
  rating: number;
  installs: string;
  developer?: string;
  version?: string;
  url?: string;
  tags?: string[];
  channel?: string;
}

type SortBy = "popular" | "rating" | "name";

/** Parse ClawHub's display install count ("5000+", "1.2k") into a sortable number. */
function parseInstalls(installs?: string): number {
  if (!installs) return 0;
  const m = installs.replace(/,/g, "").match(/([\d.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "k" ? n * 1e3 : unit === "m" ? n * 1e6 : n;
}

// Ordering is applied when a list is BUILT (the fresh page, an explicit sort
// pick, each load-more batch on its own) and never on render — re-sorting the
// whole loaded set as batches arrive inserted newcomers above what the user
// was reading. "popular" keeps ClawHub's own order (already roughly
// install-count desc).
function sortApps(list: StoreApp[], sortBy: SortBy): StoreApp[] {
  if (sortBy === "popular") return list;
  if (sortBy === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
  // rating: parse the install count once per app (tiebreak), not per comparison.
  return list
    .map(a => ({ a, installs: parseInstalls(a.installs) }))
    .sort((x, y) => (y.a.rating - x.a.rating) || (y.installs - x.installs))
    .map(x => x.a);
}

interface ApiCategory {
  id: string;
  name: string;
  count: number;
}

interface ApiResponse {
  total: number;
  categories: ApiCategory[];
  apps: ApiApp[];
}

/** Richer per-skill metadata from the detail endpoint (not in the list). */
interface AppDetail {
  featured?: boolean;
  createdAt?: string;
  updatedAt?: string;
  installsAllTime?: number;
  executesCode?: boolean;
  /** The publisher ClawHub itself names — null when it could not name one. */
  ownerHandle?: string | null;
  clawhubUrl?: string;
}

function apiToStoreApp(app: ApiApp): StoreApp {
  return {
    id: app.slug,
    name: app.name,
    description: app.summary,
    rating: app.rating,
    color: CATEGORY_COLORS[app.category] || DEFAULT_CATEGORY_COLOR,
    category: app.category,
    iconUrl: `${STORE_ICONS_BASE}/${app.slug}.png`,
    developer: app.developer,
    installs: app.installs,
    version: app.version,
    url: app.url,
    tags: app.tags,
    official: app.channel === "official",
  };
}

// One source only: the icon route walks local-then-remote itself, so the
// client never needs a second URL to fall back to — just the letter tile.
function StoreAppIcon({ appId, name, color, size = "w-12 h-12" }: { appId: string; name: string; color: string; size?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`${size} shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg overflow-hidden`} style={{ backgroundColor: color }}>
      {failed ? name[0] : (
        <img
          src={`/setup-api/apps/icon/${appId}`}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** One publisher's skill under an ambiguous slug, from the install route's 409. */
interface PublisherMatch {
  ownerHandle: string;
  /** `@owner/slug` — what the install route takes as `appId` on the re-post. */
  ref: string;
  url?: string;
}

interface InstallProgress {
  appId: string;
  status: "installing" | "success" | "error" | "ambiguous";
  message?: string;
  rateLimited?: boolean;
  /** False when retrying the same request cannot succeed (Retry is hidden). */
  retryable?: boolean;
  /** The publishers to choose between when the slug is ambiguous on ClawHub. */
  matches?: PublisherMatch[];
}

interface AppStoreProps {
  installedAppIds: string[];
  onInstall: (app: StoreApp) => void;
  onUninstall: (appId: string) => void;
}

export default function AppStore({ installedAppIds, onInstall, onUninstall }: AppStoreProps) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const [installProgress, setInstallProgress] = useState<Record<string, InstallProgress>>({});
  const [category, setCategory] = useState<string>("All");
  // Top rated on open: an unranked list of 9,000 skills is a list nobody can
  // act on, and rating is the signal a first-time visitor actually wants.
  const [sortBy, setSortBy] = useState<SortBy>("rating");
  const [apps, setApps] = useState<StoreApp[]>([]);
  const [categories, setCategories] = useState<ApiCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed list fetch is a state of its own — an empty grid after it would
  // read as "no apps found", which claims an empty catalogue when the store
  // was simply unreachable. `attempt` is the Retry button's fetch-effect dep.
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [totalApps, setTotalApps] = useState(0);
  const [selectedApp, setSelectedApp] = useState<StoreApp | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [confirmInstall, setConfirmInstall] = useState<StoreApp | null>(null);
  // Categories still to lazy-fetch when the user scrolls the "All" view.
  // Resets to the full list on every category/search change. Each batch is
  // appended below what is already on screen (sorted within itself by
  // `sortApps`), so the user sees a stable, growing list rather than a
  // reshuffle — the whole list re-sorts only on an explicit sort pick.
  const [pendingCategories, setPendingCategories] = useState<string[]>([]);
  const seenSlugsRef = useRef<Set<string>>(new Set());
  // The active sort, readable from the fetch effect and loadMore without
  // making either re-run on a sort change (same pattern as loadMoreRef below).
  const sortByRef = useRef(sortBy);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (category === "Installed") return;
    const controller = new AbortController();
    const doFetch = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const params = new URLSearchParams({ limit: String(STORE_PAGE_LIMIT) });
        if (category && category !== "All") params.set("category", category);
        if (search) params.set("q", search);
        const res = await fetch(`${STORE_API}?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ApiResponse = await res.json();
        // A response whose filter was abandoned must not overwrite the list
        // the next filter is already building. `fetch` normally rejects when
        // aborted, but a mock, cache hit, or fully-received body may still
        // resolve after cleanup has fired.
        if (controller.signal.aborted) return;
        const fresh = sortApps(data.apps.map(apiToStoreApp), sortByRef.current);
        setApps(fresh);
        seenSlugsRef.current = new Set(fresh.map(a => a.id));
        if (data.categories.length > 0) setCategories(data.categories);
        // The header's count is the CATALOGUE size; a search/category fetch
        // answers the filter's total and must not rewrite it.
        if (category === "All" && !search) setTotalApps(data.total);
        // Only the firehose "All" view (no search) gets the per-category
        // sweep — a category-filtered or search-filtered request already
        // exhausts what the upstream can return for that scope.
        if (category === "All" && !search && data.categories.length > 0) {
          setPendingCategories(data.categories.map(c => c.id));
        } else {
          setPendingCategories([]);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[AppStore] fetch failed:", err);
          // A failed re-fetch must not leave the previous scope's cards on
          // screen under the new filter — the same stale-response rule the
          // load-more cancellation below enforces.
          setLoadError(true);
          setApps([]);
          seenSlugsRef.current = new Set();
          setPendingCategories([]);
        }
      } finally {
        // The replacement request owns loading now. Clearing it from this
        // stale effect would flash an empty-state over its in-flight result.
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const timer = setTimeout(doFetch, search ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [category, search, attempt]);

  /**
   * Complete the Installed view from its real source of truth: installed ids.
   *
   * The catalogue's first response is capped at 200 rows. Filtering only that
   * page made a perfectly healthy installed skill disappear whenever its row
   * lived in a later category batch. The per-slug endpoint is deliberately
   * used here so entering Installed fetches only the missing rows, while rows
   * already present in `apps` remain instant and incur no extra request.
   */
  useEffect(() => {
    if (category !== "Installed") return;

    const missingIds = installedAppIds.filter((id) => !seenSlugsRef.current.has(id));
    if (missingIds.length === 0) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    void Promise.all(missingIds.map(async (id): Promise<StoreApp | null> => {
      try {
        const res = await fetch(`${STORE_API}?slug=${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!res.ok) return null;
        const app = await res.json() as Partial<ApiApp>;
        if (
          app.slug !== id
          || typeof app.name !== "string"
          || typeof app.summary !== "string"
          || typeof app.category !== "string"
          || typeof app.rating !== "number"
          || typeof app.installs !== "string"
        ) return null;
        return apiToStoreApp(app as ApiApp);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(`[AppStore] installed app lookup failed for ${id}:`, err);
        }
        return null;
      }
    })).then((found) => {
      if (controller.signal.aborted) return;
      const additions = found.filter((app): app is StoreApp => app !== null);
      if (additions.length === 0) return;
      additions.forEach((app) => seenSlugsRef.current.add(app.id));
      setApps((current) => {
        const currentIds = new Set(current.map((app) => app.id));
        const unseen = additions.filter((app) => !currentIds.has(app.id));
        return unseen.length > 0
          ? [...current, ...sortApps(unseen, sortByRef.current)]
          : current;
      });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });

    return () => controller.abort();
  }, [category, installedAppIds]);

  // Pull richer per-skill metadata when a detail view opens (featured, dates,
  // precise install count, executes-code). Best-effort — the modal still works
  // from the list data if this fails.
  useEffect(() => {
    setDetail(null);
    if (!selectedApp) return;
    const controller = new AbortController();
    fetch(`${STORE_API}?slug=${encodeURIComponent(selectedApp.id)}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setDetail(d as AppDetail); })
      .catch(err => { if ((err as Error).name !== "AbortError") console.error("[AppStore] detail fetch failed:", err); });
    return () => { controller.abort(); };
  }, [selectedApp]);

  // Pull the next category off the queue, fetch its apps, append the unseen
  // slugs. Idempotent against rapid-fire scroll triggers via loadingMore.
  // The fetch is cancellable so a pending request from the previous
  // category/search/filter resolves into setApps after the user has
  // already moved on.
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    if (pendingCategories.length === 0) return;
    const nextCat = pendingCategories[0];
    setLoadingMore(true);
    loadMoreControllerRef.current?.abort();
    const ctrl = new AbortController();
    loadMoreControllerRef.current = ctrl;
    try {
      const params = new URLSearchParams({
        limit: String(STORE_PAGE_LIMIT),
        category: nextCat,
      });
      const res = await fetch(`${STORE_API}?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiResponse = await res.json();
      if (ctrl.signal.aborted) return;
      const additions: StoreApp[] = [];
      for (const raw of data.apps) {
        if (seenSlugsRef.current.has(raw.slug)) continue;
        seenSlugsRef.current.add(raw.slug);
        additions.push(apiToStoreApp(raw));
      }
      if (additions.length > 0) {
        // Sorted within the batch, appended below everything already
        // rendered — never merged into it (see the pendingCategories comment).
        setApps(prev => [...prev, ...sortApps(additions, sortByRef.current)]);
      }
    } catch (err) {
      // Aborts are expected (category/search changed mid-flight); only
      // log genuine failures.
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error("[AppStore] load-more failed:", err);
      }
    } finally {
      if (loadMoreControllerRef.current === ctrl) {
        loadMoreControllerRef.current = null;
      }
      if (!ctrl.signal.aborted) {
        // Drop the just-fetched category regardless of outcome — retrying
        // the same category in a tight scroll loop wastes round trips.
        setPendingCategories(prev => prev.slice(1));
      }
      setLoadingMore(false);
    }
  }, [loading, loadingMore, pendingCategories]);

  // Stable observer callback via ref — without this, the IntersectionObserver
  // effect below was tearing down + rebuilding on every loadMore identity
  // change (which is every pendingCategories slice). The ref keeps the
  // observer attached to the same DOM node for the lifetime of the
  // sentinel + scroll container.
  const loadMoreRef = useRef(loadMore);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // IntersectionObserver against a sentinel just below the grid. Fires
  // loadMore (via the ref) whenever the sentinel enters the scroll viewport.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    if (pendingCategories.length === 0) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        loadMoreRef.current();
      }
    }, { root, rootMargin: "400px" });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [pendingCategories.length]);

  // Cancel any in-flight load-more when the category/search filter changes
  // — those filters reset `pendingCategories` upstream, and a stale
  // response slipping into `setApps` would mix the old filter's apps in.
  useEffect(() => {
    return () => {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, [category, search]);

  const requestInstall = useCallback((app: StoreApp) => {
    setConfirmInstall(app);
  }, []);

  const dismissConfirmInstall = useCallback(() => setConfirmInstall(null), []);
  // Generated, not hardcoded: dialogs on this desktop can stack, and two
  // elements sharing an id would point aria-labelledby at whichever the
  // browser found first.
  const confirmTitleId = useId();
  // Focus containment for the install confirmation below. `open` is the hook's
  // normal contract for a dialog whose panel is rendered conditionally from a
  // component that stays mounted — not a workaround for anything here.
  const confirmPanelRef = useModalDialog<HTMLDivElement>({
    open: confirmInstall !== null,
    onClose: dismissConfirmInstall,
  });

  const clearProgress = useCallback((appId: string) => {
    setInstallProgress(prev => { const n = { ...prev }; delete n[appId]; return n; });
  }, []);

  // `ref` is the `@owner/slug` a publisher pick posts back; a first attempt
  // sends the bare slug and lets the route resolve the publisher.
  const handleInstall = useCallback(async (app: StoreApp, ref?: string) => {
    setConfirmInstall(null);
    setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "installing" } }));
    try {
      const res = await fetch("/setup-api/apps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: ref ?? app.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false || (data?.clawhub && !data.clawhub.success)) {
        // A 409 "ambiguous" is not a failure to retry: ClawHub lists several
        // publishers for this slug and the choice is the owner's. The picker
        // stays up until they pick or dismiss — no auto-clear timer.
        const matches = Array.isArray(data?.matches)
          ? (data.matches as PublisherMatch[]).filter(m => m && typeof m.ownerHandle === "string" && typeof m.ref === "string")
          : [];
        if (data?.code === "ambiguous" && matches.length > 0) {
          setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "ambiguous", matches } }));
          return;
        }
        const rateLimited = data?.code === "rate_limited" || !!data?.clawhub?.rateLimited;
        // Absent on an older server: assume retryable, which keeps the old
        // behaviour of always offering Retry.
        const retryable = typeof data?.retryable === "boolean" ? data.retryable
          : typeof data?.clawhub?.retryable === "boolean" ? data.clawhub.retryable
          : true;
        const errMsg = rateLimited
          ? t("store.rateLimited")
          : (data?.clawhub?.error || data?.error || t("store.installFailed"));
        setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "error", message: errMsg, rateLimited, retryable } }));
        // Linger longer on rate-limit so the user has time to read it before
        // hitting Retry — the typical ClawHub bucket refills within ~10s.
        setTimeout(() => clearProgress(app.id), rateLimited ? 12000 : 6000);
        return;
      }
      setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "success" } }));
      onInstall(app);
      // Notify chat to refresh agent skills
      window.dispatchEvent(new CustomEvent('clawbox-skill-installed', { detail: { action: 'install', name: app.name, id: app.id } }));
      setTimeout(() => clearProgress(app.id), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "error", message: msg } }));
      setTimeout(() => clearProgress(app.id), 6000);
    }
  }, [clearProgress, onInstall, t]);

  const categoryTabs = ["All", ...categories.map(c => c.name)];
  const categoryIdMap: Record<string, string> = {};
  categories.forEach(c => { categoryIdMap[c.name] = c.id; });

  const handleCategoryClick = (cat: string) => {
    if (cat === "All" || cat === "Installed") {
      setCategory(cat);
    } else {
      setCategory(categoryIdMap[cat] || cat);
    }
  };

  const activeCategoryLabel = category === "All" || category === "Installed" ? category : categories.find(c => c.id === category)?.name || category;

  // ClawHub stamps category ids on apps that its own categories list omits
  // ("ai" on thousands of them), so an unlisted id gets a readable label
  // instead of the raw slug. Used by the cards and the detail view alike.
  const categoryLabel = (id: string) => categories.find(c => c.id === id)?.name || categoryLabelFromKey(id);

  // An explicit sort pick is the one place a full reshuffle of the loaded set
  // is what the user asked for; everything else keeps `apps` in display order
  // (see sortApps).
  const handleSortChange = (next: SortBy) => {
    setSortBy(next);
    sortByRef.current = next;
    setApps(prev => sortApps(prev, next));
  };

  // ClawHub ignores sort params, so `apps` is kept sorted client-side as it is
  // built — this only applies the Installed filter. Memoized so an incidental
  // re-render (install progress, modal open) doesn't re-filter the whole
  // loaded catalogue.
  const displayApps = useMemo(() => {
    return category === "Installed"
      ? apps.filter(app => installedAppIds.includes(app.id)).filter(app => !search || app.name.toLowerCase().includes(search.toLowerCase()))
      : apps;
  }, [apps, installedAppIds, search, category]);

  const renderInstallButton = (app: StoreApp, compact = false) => {
    const isInstalled = installedAppIds.includes(app.id);
    const progress = installProgress[app.id];
    const isInstalling = progress?.status === "installing";
    const isError = progress?.status === "error";
    const isSuccess = progress?.status === "success";
    const isAmbiguous = progress?.status === "ambiguous";

    if (isInstalled && !progress) {
      return (
        <button onClick={(e) => { e.stopPropagation(); onUninstall(app.id); }}
          className="px-3 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer">
          {t("store.uninstall")}
        </button>
      );
    }
    if (isInstalling) {
      return (
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-white/50 shrink-0">{t("store.installing")}</span>
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden min-w-[60px]">
            <div className="h-full rounded-full" style={{ backgroundColor: BRAND_ORANGE, animation: "indeterminate 1.5s ease-in-out infinite" }} />
          </div>
        </div>
      );
    }
    if (isSuccess) {
      return (
        <span className="flex items-center gap-1 text-xs font-medium" style={{ color: BRAND_ORANGE_LIGHT }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
          {t("store.installed")}
        </span>
      );
    }
    if (isAmbiguous && progress.matches) {
      return (
        <div className="flex flex-col gap-1.5 min-w-0" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-white/60">{t("store.choosePublisher")}</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {progress.matches.map((m) => (
              <button key={m.ref}
                onClick={(e) => { e.stopPropagation(); handleInstall(app, m.ref); }}
                className="px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer"
                style={{ backgroundColor: `${BRAND_ORANGE}1a`, color: BRAND_ORANGE_LIGHT }}>
                @{m.ownerHandle}
              </button>
            ))}
            <button onClick={(e) => { e.stopPropagation(); clearProgress(app.id); }}
              className="px-2 py-0.5 rounded text-xs text-white/40 hover:text-white/70 transition-colors cursor-pointer">
              {t("cancel")}
            </button>
          </div>
        </div>
      );
    }
    if (isError) {
      return (
        <div className={`flex items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
          <span className="text-xs text-red-400 line-clamp-1" title={progress.message}>
            {progress.message}
          </span>
          {/* No Retry on a definitive refusal — repeating the same request
              cannot make ClawHub grow the skill. */}
          {progress.retryable !== false && (
            <button onClick={(e) => { e.stopPropagation(); requestInstall(app); }}
              className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer shrink-0">
              {t("store.retry")}
            </button>
          )}
        </div>
      );
    }
    return (
      <button onClick={(e) => { e.stopPropagation(); requestInstall(app); }}
        className={`rounded-md font-medium transition-colors cursor-pointer ${compact ? "px-3 py-1 text-xs" : "px-6 py-2 text-sm"}`}
        style={{ backgroundColor: `${BRAND_ORANGE}1a`, color: BRAND_ORANGE_LIGHT }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${BRAND_ORANGE}33`)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = `${BRAND_ORANGE}1a`)}>
        {t("store.install")}
      </button>
    );
  };

  // Install confirmation modal — shared across all views.
  //
  // The dialog role sits on the PANEL, not on the full-screen backdrop: on the
  // backdrop the accessible dialog is the entire viewport and its accessible
  // name absorbs everything behind the scrim. Escape used to be an onKeyDown on
  // that same backdrop div, which never fired — a div is not focusable, so the
  // key event was never routed to it. useModalDialog owns Escape, the Tab
  // cycle, focus-in on open and focus-restore on close.
  const confirmModal = confirmInstall && (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={dismissConfirmInstall}>
      <div
        ref={confirmPanelRef}
        role="dialog" aria-modal="true" aria-labelledby={confirmTitleId}
        className="bg-[var(--bg-elevated)] border border-white/10 rounded-2xl p-6 max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: BRAND_ORANGE }}>
            <span className="material-symbols-rounded text-white" style={{ fontSize: 22 }} aria-hidden="true">download</span>
          </div>
          <h3 id={confirmTitleId} className="text-lg font-semibold">{t("store.confirmTitle", { name: confirmInstall.name })}</h3>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 mb-4">
          <div className="flex gap-2">
            <span className="material-symbols-rounded text-yellow-400 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
            <p className="text-sm text-yellow-200/80">
              {t("store.confirmMessage")}
            </p>
          </div>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={dismissConfirmInstall}
            className="px-4 py-2 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => handleInstall(confirmInstall)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors cursor-pointer"
            style={{ backgroundColor: BRAND_ORANGE }}
          >
            {t("store.installAnyway")}
          </button>
        </div>
      </div>
    </div>
  );

  // Detail view
  if (selectedApp) {
    const isInstalled = installedAppIds.includes(selectedApp.id);
    const catName = categoryLabel(selectedApp.category);
    // installsAllTime from the detail endpoint is unreliable — it comes back 0
    // even for apps with thousands of installs — so only trust it when positive
    // and otherwise fall back to the list's bucketed "2800+" string. One value
    // feeds both the header and the Downloads stat so they can't disagree.
    const installDisplay = detail?.installsAllTime && detail.installsAllTime > 0 ? detail.installsAllTime.toLocaleString() : selectedApp.installs;
    // The publisher namespace is what makes a ClawHub URL real. Best is the
    // handle ClawHub itself named (`ownerHandle`, via the detail proxy); the
    // store's `developer` is a guess that is only for an old server whose
    // LOADED detail has no ownerHandle field at all — an explicit null means
    // ClawHub could not name the publisher, and rebuilding the link from
    // `developer` would resurrect the dead URL the server removed. While the
    // detail is still in flight (`detail === null`) nothing is known yet, so
    // the guess must not fire either — a click in that window would open the
    // dead page under a "view on ClawHub" label. The store's own page is the
    // honest fallback — labelled as the store page, not as ClawHub. See
    // src/lib/clawhub-url.ts.
    const hubUrl = clawhubSkillUrl(selectedApp.id, detail?.ownerHandle || undefined)
      || (detail === null || "ownerHandle" in detail ? undefined : clawhubSkillUrl(selectedApp.id, selectedApp.developer))
      || selectedApp.url;
    const hubIsClawhub = !!hubUrl && hubUrl.startsWith("https://clawhub.ai/");

    return (
      <div className="h-full flex flex-col bg-[var(--bg-deep)] text-white" data-testid="app-store">
        {confirmModal}
        {/* Back header */}
        <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center gap-3">
          <button onClick={() => setSelectedApp(null)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors cursor-pointer">
            <span className="material-symbols-rounded text-white/70" style={{ fontSize: 20 }}>arrow_back</span>
          </button>
          <span className="text-sm font-medium text-white/70">{t("store.appStore")}</span>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* App header */}
          <div className="flex gap-4 mb-6">
            <StoreAppIcon appId={selectedApp.id} name={selectedApp.name} color={selectedApp.color} size="w-20 h-20" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold">{selectedApp.name}</h2>
                {detail?.featured && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: `${BRAND_ORANGE}26`, color: BRAND_ORANGE_LIGHT }}>{t("store.featured")}</span>
                )}
                {selectedApp.official && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-white/60" title={t("store.official")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13, color: BRAND_ORANGE_LIGHT }}>verified</span>
                    {t("store.official")}
                  </span>
                )}
              </div>
              <p className="text-sm text-white/50">{selectedApp.developer || t("store.unknownDeveloper")}</p>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <div className="flex items-center gap-1 text-yellow-400 text-sm">
                  <span>★</span>
                  <span className="font-semibold">{selectedApp.rating.toFixed(1)}</span>
                </div>
                {installDisplay && (
                  <span className="text-xs text-white/40">{t("store.installs", { count: installDisplay })}</span>
                )}
                {selectedApp.version && (
                  <span className="text-xs text-white/30">v{selectedApp.version}</span>
                )}
                {detail?.updatedAt && (
                  <span className="text-xs text-white/30">{t("store.updated", { date: detail.updatedAt })}</span>
                )}
                {detail?.executesCode && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-amber-400/80" title={t("store.runsCode")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13 }}>code</span>
                    {t("store.runsCode")}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2">
                {renderInstallButton(selectedApp)}
                {isInstalled && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: BRAND_ORANGE_LIGHT }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                    {t("store.installed")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Description. The store summary is hard-capped at 200 chars
              upstream, often mid-word — mark the cut, and put the link to the
              full write-up right under it rather than at the bottom. */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">{t("store.about")}</h3>
            <p className="text-sm text-white/70 leading-relaxed whitespace-pre-line">
              {selectedApp.description}{selectedApp.description.length >= 200 && "…"}
            </p>
            {hubUrl && (
              <a href={hubUrl} target="_blank" rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs transition-colors"
                style={{ color: BRAND_ORANGE_LIGHT }}>
                {hubIsClawhub ? t("store.viewOnHub") : t("store.viewInStore")}
                <span className="material-symbols-rounded" style={{ fontSize: 12 }}>open_in_new</span>
              </a>
            )}
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">{t("store.category")}</span>
              <div className="text-sm text-white/80 mt-0.5">{catName}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">{t("store.developer")}</span>
              <div className="text-sm text-white/80 mt-0.5">{selectedApp.developer || "—"}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">{t("store.downloads")}</span>
              <div className="text-sm text-white/80 mt-0.5">{installDisplay || "—"}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">{t("store.version")}</span>
              <div className="text-sm text-white/80 mt-0.5">{selectedApp.version || "—"}</div>
            </div>
          </div>

          {/* Tags */}
          {selectedApp.tags && selectedApp.tags.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">{t("store.tags")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {selectedApp.tags.map(tag => (
                  <span key={tag} className="px-2.5 py-1 rounded-full text-xs bg-white/5 text-white/60">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    );
  }

  return (
    // @container on the root so the header can size itself to the WINDOW, not
    // the viewport — this is a desktop window the owner can resize freely.
    <div className="h-full flex flex-col bg-[var(--bg-deep)] text-white @container" data-testid="app-store">
      {confirmModal}
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: BRAND_ORANGE }}>
            <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }}>storefront</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold">{t("store.title")}</h1>
            {/* No made-up count: before the first successful load (and after a
                failed one) the subtitle carries no number at all. */}
            <p className="text-xs text-white/50">{totalApps > 0 ? t("store.poweredBy", { count: totalApps }) : t("store.poweredByNoCount")}</p>
          </div>
        </div>

        {/* Search and sort share one row: the sort had a whole line to itself
            and a label the select already says. */}
        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1 min-w-0">
            <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/40" style={{ fontSize: 16 }}>search</span>
            <input
              type="text"
              placeholder={t("store.searchApps")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none"
              style={{ ["--tw-ring-color" as string]: BRAND_ORANGE }}
              onFocus={(e) => (e.currentTarget.style.borderColor = `${BRAND_ORANGE}80`)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "")}
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => handleSortChange(e.target.value as SortBy)}
            aria-label={t("store.sort")}
            className="h-9 px-2 shrink-0 bg-white/5 border border-white/10 rounded-lg text-xs text-white/80 focus:outline-none cursor-pointer"
          >
            <option value="rating" className="bg-[var(--bg-elevated)]">{t("store.sortRating")}</option>
            <option value="popular" className="bg-[var(--bg-elevated)]">{t("store.sortPopular")}</option>
            <option value="name" className="bg-[var(--bg-elevated)]">{t("store.sortName")}</option>
          </select>
        </div>

        {/* Fourteen categories wrapped to three rows on a phone and pushed the
            apps off the screen. Narrow: one row that scrolls sideways. Wide:
            wrap as before, since there is room. */}
        <div className="flex gap-1.5 pb-1 overflow-x-auto @2xl:flex-wrap @2xl:overflow-x-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {["Installed", ...categoryTabs].map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryClick(cat)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                activeCategoryLabel === cat
                  ? "text-white"
                  : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
              style={activeCategoryLabel === cat ? { backgroundColor: BRAND_ORANGE } : undefined}
            >
              {cat === "All" ? t("store.all") : cat === "Installed" ? t("store.installed") : cat}
            </button>
          ))}
        </div>
      </div>

      {/* App Grid */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 @container">
        {loading && apps.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
          </div>
        ) : (
          <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 gap-3">
            {displayApps.map((app) => {
              const progress = installProgress[app.id];
              const isInstalling = progress?.status === "installing";
              const isInstalled = installedAppIds.includes(app.id);
              const isError = progress?.status === "error";
              const isSuccess = progress?.status === "success";
              return (
                <div
                  key={app.id}
                  onClick={() => setSelectedApp(app)}
                  className={`rounded-xl border p-3 transition-all duration-300 cursor-pointer ${
                    isInstalling ? "scale-[0.98]" : ""
                  } ${
                    isError
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                  }`}
                  style={
                    (isInstalled || isSuccess) && !isError
                      ? { borderColor: `${BRAND_ORANGE}4d`, backgroundColor: `${BRAND_ORANGE}0d` }
                      : undefined
                  }
                >
                  <div className="flex gap-3">
                    <StoreAppIcon appId={app.id} name={app.name} color={app.color} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <h3 className="font-medium text-sm truncate">{app.name}</h3>
                            {app.official && (
                              <span title={t("store.official")} aria-label={t("store.official")} className="shrink-0 inline-flex" style={{ color: BRAND_ORANGE_LIGHT }}>
                                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>verified</span>
                              </span>
                            )}
                          </div>
                          <span className="block text-xs text-white/40 truncate">{categoryLabel(app.category)}</span>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                          <div className="flex items-center gap-0.5 text-yellow-400 text-xs">
                            <span>★</span>
                            <span>{app.rating.toFixed(1)}</span>
                          </div>
                          {app.installs && <span className="text-[10px] text-white/40">{app.installs}</span>}
                        </div>
                      </div>
                      <p className="text-xs text-white/50 mt-1 line-clamp-2">{app.description}</p>
                      <div className="mt-2 flex items-center gap-2">
                        {renderInstallButton(app, true)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* A load failure is its own state; "No apps found" is reserved for a
            successful fetch that genuinely matched nothing. The Installed view
            never fetches, so it keeps its own empty copy even after a failure. */}
        {!loading && loadError && category !== "Installed" && (
          <div className="text-center py-12">
            <span className="material-symbols-rounded text-white/30" style={{ fontSize: 40 }} aria-hidden="true">cloud_off</span>
            <p className="text-sm text-white/50 mt-2">{t("store.loadError")}</p>
            <button onClick={() => setAttempt(a => a + 1)}
              className="mt-3 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer"
              style={{ backgroundColor: `${BRAND_ORANGE}1a`, color: BRAND_ORANGE_LIGHT }}>
              {t("store.retry")}
            </button>
          </div>
        )}

        {!loading && displayApps.length === 0 && (category === "Installed" || !loadError) && (
          <div className="text-center py-12 text-white/40">
            <p className="text-sm">{category === "Installed" ? t("store.noInstalledApps") : t("store.noAppsFound")}</p>
          </div>
        )}

        {/* Infinite-scroll sentinel + loading spinner. Only shown on the
            "All" view while there are still per-category pages to fetch. */}
        {category === "All" && !search && pendingCategories.length > 0 && (
          <div ref={sentinelRef} className="flex items-center justify-center py-6">
            {loadingMore && (
              <div className="w-5 h-5 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type { StoreApp };
