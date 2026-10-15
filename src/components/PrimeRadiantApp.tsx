"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { APP_GROUND, BTN_PRIMARY, BTN_SECONDARY, SECTION_LABEL } from "./coding-agent-ui";
import {
  API,
  PRODUCT_NAME,
  announceVaultChanged,
  TABS,
  TAB_ICONS,
  errorText,
  jsonInit,
  prJson,
  type PrimeRadiantStatus,
  type Tab,
} from "./prime-radiant-ui";
import PrimeRadiantBrowse from "./PrimeRadiantBrowse";
import PrimeRadiantReview from "./PrimeRadiantReview";
import PrimeRadiantHistory from "./PrimeRadiantHistory";
import PrimeRadiantLint from "./PrimeRadiantLint";
import PrimeRadiantIngest from "./PrimeRadiantIngest";
import PrimeRadiantSettings from "./PrimeRadiantSettings";
import PrimeRadiantUsage from "./PrimeRadiantUsage";
import PrimeRadiantIcon from "./PrimeRadiantIcon";

/** The Map (WebGL, a layout worker) is fetched only when its tab is first drawn. */
const PrimeRadiantMap = lazy(() => import("./PrimeRadiantMap"));

/**
 * Prime Radiant — the "living wiki" — as its own desktop app.
 *
 * A separate app from Memory Shard on purpose: Memory Shard is the search
 * engine over everything the box remembers, Prime Radiant is the curated
 * vault of pages and claims that engine reads as one of its sources.
 *
 * The first open makes the vault: the status GET never creates anything
 * (no folder, no repository, no config write), so when it says
 * `initialised: false` the app asks `POST init` once, which builds the
 * repository and points the memory-wiki plugin at it. A refused init is
 * shown with a retry button rather than retried on its own — it writes the
 * agent's configuration, and doing that in a loop is the wrong failure mode.
 *
 * Five tabs: Map (the start page of a vault with pages; an empty vault opens
 * on Pages, whose empty state leads to Add), Pages (the list and its search,
 * each page with its history), Review (open questions, then failed checks),
 * Add, and Settings (with the token usage). The app shows no money anywhere.
 */

/** A status the window can draw: a vault that exists carries its counts and its wiring. */
function isDrawableStatus(s: unknown): s is PrimeRadiantStatus {
  if (!s || typeof s !== "object") return false;
  const st = s as Partial<PrimeRadiantStatus>;
  if (typeof st.initialised !== "boolean") return false;
  return !st.initialised || (!!st.vault && typeof st.vault === "object" && !!st.plugin && typeof st.plugin === "object");
}
export default function PrimeRadiantApp() {
  const { t } = useT();
  /** For what shows before the dictionaries load (the window can be the first thing on screen): English, never a key. */
  const tr = useTr();
  const [status, setStatus] = useState<PrimeRadiantStatus | null>(null);
  const [phase, setPhase] = useState<"loading" | "initialising" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("browse");
  /** The start tab is picked once, from the first status that has the vault. */
  const startPicked = useRef(false);
  /** A page opened from the Map goes back to the Map. */
  const backToMap = useRef(false);
  /** The page whose history Pages shows, opened from that page's own view (null: no history open). */
  const [historyPage, setHistoryPage] = useState<string | null>(null);
  /** The page Browse shows; Search, Review, Lint and History open one here too. */
  const [browsePage, setBrowsePage] = useState<string | null>(null);
  /** Bumped by anything that changed the vault, so every tab re-reads. */
  const [revision, setRevision] = useState(0);
  /**
   * The one `POST init` this window makes, shared by every read that finds
   * the vault missing: a remount (React's development double-mount, a window
   * reopened mid-request) joins the request already out instead of firing a
   * second config write. Never aborted — the server finishes it either way.
   */
  const initRequest = useRef<Promise<unknown> | null>(null);
  /** What the one-time repair took out of the vault, when this window's `POST init` ran it. */
  const [repaired, setRepaired] = useState<{ pages: number; files: number } | null>(null);

  /**
   * A vault that is there but whose memory-wiki wiring still needs a write
   * (keys a newer ClawBox added): the same one `POST init`, in the
   * background — the window is usable meanwhile, and a failure is only
   * logged (the status keeps saying `needs-write`; the next window asks again).
   */
  const rewire = useCallback((signal?: AbortSignal) => {
    initRequest.current ??= prJson(`${API}/init`, jsonInit("POST", {}));
    void initRequest.current
      .then(async (res) => {
        const repair = (res as { repair?: { cleaned?: unknown[]; removed?: unknown[] } | null } | null)?.repair;
        const pages = Array.isArray(repair?.cleaned) ? repair.cleaned.length : 0;
        const files = Array.isArray(repair?.removed) ? repair.removed.length : 0;
        if (pages + files > 0 && !signal?.aborted) setRepaired({ pages, files });
        const after = await prJson<PrimeRadiantStatus>(`${API}/status`, { signal });
        if (signal?.aborted || !isDrawableStatus(after) || !after.initialised) return;
        setStatus(after);
        if (pages + files > 0) {
          setRevision((r) => r + 1);
          announceVaultChanged();
        }
      })
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") console.warn("[prime-radiant] memory-wiki wiring:", err);
      });
  }, []);

  const pickStartTab = useCallback((s: PrimeRadiantStatus) => {
    if (startPicked.current || !s.initialised) return;
    startPicked.current = true;
    setTab(s.vault.pages > 0 ? "map" : "browse");
  }, []);

  /** What to do with a status: show it, or create the vault and read again. */
  const settle = useCallback(async (s: PrimeRadiantStatus, signal?: AbortSignal) => {
    if (!isDrawableStatus(s)) throw new Error("shape");
    setStatus(s);
    if (s.initialised) {
      pickStartTab(s);
      setPhase("ready");
      if (s.plugin.state === "needs-write") rewire(signal);
      return;
    }
    setPhase("initialising");
    initRequest.current ??= prJson(`${API}/init`, jsonInit("POST", {}));
    await initRequest.current;
    if (signal?.aborted) return;
    const after = await prJson<PrimeRadiantStatus>(`${API}/status`, { signal });
    if (signal?.aborted) return;
    if (!isDrawableStatus(after)) throw new Error("shape");
    setStatus(after);
    pickStartTab(after);
    setPhase(after.initialised ? "ready" : "failed");
    if (after.initialised) announceVaultChanged();
  }, [rewire, pickStartTab]);

  const fail = useCallback((err: unknown, signal?: AbortSignal) => {
    if ((err as Error)?.name === "AbortError" || signal?.aborted) return;
    // A refused init is shown with a retry button, never retried on its own.
    initRequest.current = null;
    setError(errorText(err, t));
    setPhase("failed");
  }, [t]);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<PrimeRadiantStatus>(`${API}/status`, { signal: ctl.signal })
      .then((s) => settle(s, ctl.signal))
      .catch((err) => fail(err, ctl.signal));
    return () => ctl.abort();
  }, [settle, fail]);

  const changed = useCallback(() => {
    setRevision((r) => r + 1);
    // Only a status the window can draw replaces the one on screen.
    void prJson<PrimeRadiantStatus>(`${API}/status`)
      .then((s) => {
        if (isDrawableStatus(s) && s.initialised) setStatus(s);
      })
      .catch(() => undefined);
    announceVaultChanged();
  }, []);

  const retryInit = () => {
    initRequest.current = null;
    setError(null);
    setPhase("loading");
    prJson<PrimeRadiantStatus>(`${API}/status`)
      .then((s) => settle(s))
      .catch((err) => fail(err));
  };

  const showTab = useCallback((id: Tab) => {
    backToMap.current = false;
    setHistoryPage(null);
    setTab(id);
  }, []);
  const openPage = useCallback((path: string) => {
    backToMap.current = false;
    setHistoryPage(null);
    setBrowsePage(path);
    setTab("browse");
  }, []);
  const openFromMap = useCallback((path: string) => {
    backToMap.current = true;
    setHistoryPage(null);
    setBrowsePage(path);
    setTab("browse");
  }, []);
  /** Browse's own navigation; its Back from a page the Map opened returns to the Map. */
  const selectInBrowse = useCallback((path: string | null) => {
    setBrowsePage(path);
    if (path === null && backToMap.current) {
      backToMap.current = false;
      setTab("map");
    }
  }, []);
  /** A page's history opens in Pages, over the page; Back returns to the page. */
  const openHistory = useCallback((path: string) => {
    setHistoryPage(path);
    setTab("browse");
  }, []);
  const toIngest = useCallback(() => showTab("ingest"), [showTab]);

  const ready = phase === "ready" && status?.initialised;

  return (
    <div
      className={`h-full flex flex-col ${APP_GROUND} text-white overflow-hidden @container`}
      data-testid="prime-radiant-app"
      data-help-bounds
    >
      <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <PrimeRadiantIcon className="w-5 h-5 shrink-0" />
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{PRODUCT_NAME}</h1>
          <span className="text-xs text-[var(--text-muted)] truncate" data-testid="prime-radiant-subtitle">
            {tr("primeRadiant.subtitle", "living wiki")}
          </span>
        </div>
        {ready && status && (
          <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)] shrink-0" data-testid="prime-radiant-counts">
            <span>{t("primeRadiant.countPages", { n: status.vault.pages })}</span>
            <span>{t("primeRadiant.countClaims", { n: status.vault.claims })}</span>
            <span>{t("primeRadiant.countVerified", { n: status.vault.verifiedPages })}</span>
          </div>
        )}
      </header>

      {ready && (
        <nav className="flex gap-1 px-3 py-2 border-b border-white/[0.06] overflow-x-auto" role="tablist" aria-label={t("primeRadiant.tabsLabel")}>
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-testid={`prime-radiant-tab-${id}`}
              onClick={() => showTab(id)}
              className={`inline-flex items-center gap-1.5 shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                tab === id
                  ? "bg-white/[0.12] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-white/[0.06]"
              }`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">{TAB_ICONS[id]}</span>
              {t(`primeRadiant.tab.${id}`)}
            </button>
          ))}
        </nav>
      )}

      <main
        className={`flex-1 min-h-0 px-5 py-4 ${ready && tab === "map" ? "overflow-hidden flex flex-col" : "overflow-y-auto"}`}
        role={ready ? "tabpanel" : undefined}
      >
        {error && phase === "ready" && (
          <p role="alert" className="mb-3 text-xs text-red-300">{error}</p>
        )}

        {(phase === "loading" || phase === "initialising") && (
          <div className="h-full flex flex-col items-center justify-center gap-3 py-10 text-sm text-[var(--text-muted)]" role="status" aria-live="polite" data-testid="prime-radiant-loading">
            <PrimeRadiantIcon className="w-10 h-10" />
            <p className="flex items-center gap-2">
              <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>
              {phase === "initialising" ? tr("primeRadiant.initialising", "Creating the wiki for the first time…") : tr("primeRadiant.loading", "Loading…")}
            </p>
          </div>
        )}

        {phase === "failed" && (
          <div className="max-w-md mx-auto py-10 text-center space-y-3" data-testid="prime-radiant-init-failed">
            <p className="text-sm text-[var(--text-primary)]">{t("primeRadiant.initFailed")}</p>
            {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
            <button type="button" className={BTN_PRIMARY} onClick={retryInit} data-testid="prime-radiant-init-retry">
              {t("primeRadiant.retry")}
            </button>
          </div>
        )}

        {ready && status && (
          <>
            {status.plugin.state === "conflict" && (tab === "browse" || tab === "map") && (
              <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200" data-testid="prime-radiant-wiring-conflict">
                {t(
                  status.plugin.conflicts.every((c) => c === "plugin-writes")
                    ? "primeRadiant.wiringConflictWrites"
                    : "primeRadiant.wiringConflict",
                )}
              </p>
            )}
            {repaired && (tab === "browse" || tab === "map") && (
              <p className="mb-3 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-200" data-testid="prime-radiant-repaired" role="status">
                {t("primeRadiant.repaired", { pages: repaired.pages, files: repaired.files })}
              </p>
            )}
            {tab === "map" && (
              <div className="flex-1 min-h-0">
                <Suspense
                  fallback={
                    <p className="flex items-center gap-2 py-10 justify-center text-sm text-[var(--text-muted)]" role="status">
                      <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>
                      {tr("primeRadiant.map.loading", "Drawing the map…")}
                    </p>
                  }
                >
                  <PrimeRadiantMap revision={revision} onOpenPage={openFromMap} onIngest={toIngest} />
                </Suspense>
              </div>
            )}
            {tab === "browse" && historyPage !== null && (
              <div className="space-y-3">
                <button type="button" className={BTN_SECONDARY} onClick={() => setHistoryPage(null)} data-testid="prime-radiant-history-back">
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">arrow_back</span>
                  {t("primeRadiant.back")}
                </button>
                <PrimeRadiantHistory key={historyPage} initialPage={historyPage} revision={revision} onChanged={changed} onOpenPage={openPage} />
              </div>
            )}
            {tab === "browse" && historyPage === null && (
              <PrimeRadiantBrowse
                domains={status.vault.domains}
                revision={revision}
                selected={browsePage}
                onSelect={selectInBrowse}
                onHistory={openHistory}
                onIngest={toIngest}
              />
            )}
            {tab === "review" && (
              <div className="space-y-6">
                <PrimeRadiantReview revision={revision} onChanged={changed} onOpenPage={openPage} onOpenSettings={() => showTab("settings")} />
                <section className="space-y-2" data-testid="prime-radiant-review-checks">
                  <h3 className={SECTION_LABEL}>{t("primeRadiant.tab.lint")}</h3>
                  <PrimeRadiantLint revision={revision} onOpenPage={openPage} />
                </section>
              </div>
            )}
            {tab === "ingest" && <PrimeRadiantIngest onChanged={changed} />}
            {tab === "settings" && (
              <div className="space-y-4">
                <PrimeRadiantSettings onChanged={changed} />
                <PrimeRadiantUsage revision={revision} />
              </div>
            )}
          </>
        )}
      </main>
      {ready && (
        <footer className="px-5 py-2 border-t border-white/[0.06] text-[11px] text-[var(--text-muted)] flex items-center justify-between gap-2">
          <span className="truncate">
            {status?.lint.ok ? t("primeRadiant.lintOk") : t("primeRadiant.lintIssues", { errors: status?.lint.errors ?? 0, warnings: status?.lint.warnings ?? 0 })}
          </span>
          <button type="button" className={BTN_SECONDARY} onClick={changed} data-testid="prime-radiant-refresh">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">refresh</span>
            {t("primeRadiant.refresh")}
          </button>
        </footer>
      )}
    </div>
  );
}
