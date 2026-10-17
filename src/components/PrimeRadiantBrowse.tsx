"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { BTN_PRIMARY, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import {
  API,
  PAGE_TYPES,
  errorText,
  formatWhen,
  keyPart,
  pageLabel,
  pageUrl,
  prJson,
  verifierKey,
  type PageDetail,
  type PageListEntry,
} from "./prime-radiant-ui";
import PrimeRadiantSearch, { type SearchRequest } from "./PrimeRadiantSearch";

interface Props {
  domains: string[];
  revision: number;
  /** The page shown in full, or null for the list (held by the app, so other tabs can open one). */
  selected: string | null;
  onSelect: (path: string | null) => void;
  onHistory: (path: string) => void;
  onIngest: () => void;
}

interface Filters {
  type: string;
  domain: string;
  verified: "" | "true" | "false";
  q: string;
}

const EMPTY: Filters = { type: "", domain: "", verified: "", q: "" };

/**
 * Pages (the `browse` tab): the vault's pages by domain and type, and one page
 * in full — its claims with their confidence and verification, where it came
 * from (the page's sources and each claim's evidence), and what links to it.
 * Its one search field filters the list by title or path as the owner types,
 * and Enter (or the button beside it) searches inside the pages through
 * Memory Shard, the hits shown above the list.
 */
export default function PrimeRadiantBrowse({ domains, revision, selected, onSelect, onHistory, onIngest }: Props) {
  const { t, locale } = useT();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [list, setList] = useState<{ total: number; pages: PageListEntry[] } | null>(null);
  const [page, setPage] = useState<PageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A refused page read, filed under the path it was for. */
  const [pageError, setPageError] = useState<{ path: string; message: string } | null>(null);
  /** The search inside pages last asked for, and whether it is still out. */
  const [searched, setSearched] = useState<SearchRequest | null>(null);
  const [searching, setSearching] = useState(false);

  const loadList = useCallback(async (signal: AbortSignal) => {
    const q = new URLSearchParams();
    if (filters.type) q.set("type", filters.type);
    if (filters.domain) q.set("domain", filters.domain);
    if (filters.verified) q.set("verified", filters.verified);
    if (filters.q.trim()) q.set("q", filters.q.trim());
    q.set("limit", "500");
    try {
      const answer = await prJson<{ total: number; pages: PageListEntry[] }>(`${API}/pages?${q}`, { signal });
      // The filters moved on while this answer was in flight: it is not theirs.
      if (signal.aborted) return;
      setList(answer);
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || signal.aborted) return;
      setError(errorText(err, t));
    }
  }, [filters, t]);

  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => void loadList(ctl.signal), filters.q ? 200 : 0);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [loadList, filters.q, revision]);

  useEffect(() => {
    if (!selected) return;
    const ctl = new AbortController();
    prJson<PageDetail>(pageUrl(`${API}/pages`, selected), { signal: ctl.signal })
      .then((p) => {
        if (ctl.signal.aborted) return;
        setPage(p);
        setPageError(null);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setPageError({ path: selected, message: errorText(err, t) });
      });
    return () => ctl.abort();
  }, [selected, revision, t]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const searchInside = () => {
    const q = filters.q.trim();
    if (!q) return;
    setSearched((s) => ({ q, n: (s?.n ?? 0) + 1 }));
  };

  if (selected) {
    return (
      <PageView
        path={selected}
        page={page?.path === selected ? page : null}
        error={pageError?.path === selected ? pageError.message : null}
        onBack={() => onSelect(null)}
        onOpen={onSelect}
        onHistory={onHistory}
        locale={locale}
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="prime-radiant-browse">
      <div className="flex flex-wrap gap-2 items-center">
        <label className="sr-only" htmlFor="pr-browse-q">{t("primeRadiant.browse.searchPlaceholder")}</label>
        <input
          id="pr-browse-q"
          type="search"
          className={`${FIELD} text-xs flex-1 min-w-[12rem]`}
          placeholder={t("primeRadiant.browse.searchPlaceholder")}
          value={filters.q}
          maxLength={1000}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            searchInside();
          }}
          data-testid="prime-radiant-browse-q"
        />
        <button type="button" className={BTN_SECONDARY} onClick={searchInside} disabled={!filters.q.trim() || searching} data-testid="prime-radiant-search-go">
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">manage_search</span>
          {searching ? t("primeRadiant.search.searching") : t("primeRadiant.search.inside")}
        </button>
        <select
          className={`${FIELD} text-xs`}
          value={filters.domain}
          onChange={(e) => set({ domain: e.target.value })}
          aria-label={t("primeRadiant.browse.domain")}
          data-testid="prime-radiant-browse-domain"
        >
          <option value="">{t("primeRadiant.browse.allDomains")}</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          className={`${FIELD} text-xs`}
          value={filters.type}
          onChange={(e) => set({ type: e.target.value })}
          aria-label={t("primeRadiant.browse.type")}
          data-testid="prime-radiant-browse-type"
        >
          <option value="">{t("primeRadiant.browse.allTypes")}</option>
          {PAGE_TYPES.map((ty) => <option key={ty} value={ty}>{t(`primeRadiant.type.${ty}`)}</option>)}
        </select>
        <select
          className={`${FIELD} text-xs`}
          value={filters.verified}
          onChange={(e) => set({ verified: e.target.value as Filters["verified"] })}
          aria-label={t("primeRadiant.browse.verification")}
          data-testid="prime-radiant-browse-verified"
        >
          <option value="">{t("primeRadiant.browse.anyVerification")}</option>
          <option value="true">{t("primeRadiant.verified")}</option>
          <option value="false">{t("primeRadiant.notVerified")}</option>
        </select>
      </div>

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}

      {searched && (
        <PrimeRadiantSearch
          request={searched}
          onOpenPage={onSelect}
          onBusy={setSearching}
          onClose={() => {
            setSearched(null);
            setSearching(false);
          }}
        />
      )}

      {list && list.total === 0 && !filters.q && !filters.domain && !filters.type && !filters.verified ? (
        <div className={`${CARD_SURFACE} p-6 text-center space-y-3`} data-testid="prime-radiant-empty">
          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 36 }} aria-hidden="true">auto_stories</span>
          <p className="text-sm text-[var(--text-primary)]">{t("primeRadiant.browse.emptyTitle")}</p>
          <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.browse.emptyBody")}</p>
          <button type="button" className={BTN_PRIMARY} onClick={onIngest}>{t("primeRadiant.browse.addDocuments")}</button>
        </div>
      ) : (
        <>
          {list && (
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.browse.shown", { shown: list.pages.length, total: list.total })}</p>
          )}
          <ul className="space-y-1.5" data-testid="prime-radiant-page-list">
            {list?.pages.map((p) => (
              <li key={p.path}>
                <button
                  type="button"
                  onClick={() => onSelect(p.path)}
                  className={`${INSET_SURFACE} w-full text-left px-3 py-2 hover:bg-white/[0.06] cursor-pointer`}
                  data-testid="prime-radiant-page-row"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {p.verified && (
                      <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 15 }} aria-label={t("primeRadiant.verified")} role="img">verified</span>
                    )}
                    {!p.valid && (
                      <span className="material-symbols-rounded text-red-300" style={{ fontSize: 15 }} aria-label={t("primeRadiant.browse.invalid")} role="img">error</span>
                    )}
                    <span className="text-sm text-[var(--text-primary)] truncate">{p.title ?? pageLabel(p.path)}</span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                      {p.type ? t(`primeRadiant.type.${p.type}`) : "—"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] min-w-0">
                    <span className="shrink-0">{p.domain ?? "—"}</span>
                    <span className="shrink-0">{t("primeRadiant.claimsCount", { n: p.claims })}</span>
                    {p.summary && <span className="truncate">{p.summary}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function confidenceTone(c: number): string {
  if (c >= 0.8) return "bg-emerald-400";
  if (c >= 0.5) return "bg-amber-300";
  return "bg-red-400";
}

function PageView({ path, page, error, onBack, onOpen, onHistory, locale }: {
  path: string;
  page: PageDetail | null;
  error: string | null;
  onBack: () => void;
  onOpen: (path: string) => void;
  onHistory: (path: string) => void;
  locale: string;
}) {
  const { t } = useT();
  const fm = page?.frontmatter ?? null;
  const percent = (n: number) => new Intl.NumberFormat(locale, { style: "percent" }).format(Math.max(0, Math.min(1, n)));

  return (
    <div className="space-y-3" data-testid="prime-radiant-page">
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_SECONDARY} onClick={onBack} data-testid="prime-radiant-page-back">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">arrow_back</span>
          {t("primeRadiant.back")}
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={() => onHistory(path)} data-testid="prime-radiant-page-history">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">history</span>
          {t("primeRadiant.tab.history")}
        </button>
      </div>

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {!page && !error && <p className="text-xs text-[var(--text-muted)]" role="status">{t("primeRadiant.loading")}</p>}

      {page && (
        <>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              {fm?.title ?? pageLabel(page.path)}
              {page.verified && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 border border-emerald-400/30 rounded-full px-2 py-0.5">
                  <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">verified</span>
                  {t("primeRadiant.verified")}
                </span>
              )}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] break-all">{page.path}</p>
          </div>

          {fm ? (
            <dl className="grid grid-cols-2 @md:grid-cols-4 gap-2 text-xs">
              {([
                ["primeRadiant.page.type", t(`primeRadiant.type.${fm.type}`)],
                ["primeRadiant.page.domain", fm.domain],
                ["primeRadiant.page.owner", fm.owner],
                ["primeRadiant.page.status", t(`primeRadiant.status.${fm.status}`)],
                ["primeRadiant.page.privacy", t(`primeRadiant.privacy.${keyPart(fm.privacy)}`)],
                ["primeRadiant.page.checkedBy", t(`primeRadiant.checkedBy.${fm.checked_by}`)],
                ["primeRadiant.page.generated", formatWhen(fm.generated?.at, locale)],
                ["primeRadiant.page.staleAfter", fm.stale_after ?? "—"],
              ] as const).map(([key, value]) => (
                <div key={key} className={`${INSET_SURFACE} px-2.5 py-1.5`}>
                  <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t(key)}</dt>
                  <dd className="mt-0.5 text-[var(--text-primary)] truncate">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200" data-testid="prime-radiant-page-errors">
              <p className="font-semibold">{t("primeRadiant.page.invalid")}</p>
              <ul className="mt-1 list-disc pl-4">
                {page.errors?.map((e) => <li key={`${e.field}:${e.message}`}><code>{e.field}</code> {e.message}</li>)}
              </ul>
            </div>
          )}

          {fm?.opus_pending && (
            <p className="text-[11px] text-amber-200">{t("primeRadiant.page.opusPending")}</p>
          )}

          {fm && fm.claims.length > 0 && (
            <section className={`${CARD_SURFACE} p-3`} data-testid="prime-radiant-claims">
              <h3 className={SECTION_LABEL}>{t("primeRadiant.page.claims")}</h3>
              <ul className="mt-2 space-y-2">
                {fm.claims.map((c) => (
                  <li key={c.id} className={`${INSET_SURFACE} px-3 py-2`} data-testid="prime-radiant-claim">
                    <div className="flex items-start gap-2">
                      {c.verified && (
                        <span className="material-symbols-rounded text-emerald-400 shrink-0" style={{ fontSize: 15 }} aria-label={t("primeRadiant.verified")} role="img">verified</span>
                      )}
                      <p className="text-sm text-[var(--text-primary)] flex-1">{c.text}</p>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
                      <span className="font-mono">{c.id}</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-12 h-1 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
                          <span className={`block h-full ${confidenceTone(c.confidence)}`} style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                        </span>
                        {t("primeRadiant.page.confidence", { value: percent(c.confidence) })}
                      </span>
                      <span>{t(`primeRadiant.claimStatus.${c.status}`)}</span>
                      {c.verified && (
                        <span data-testid="prime-radiant-claim-verified">
                          {t(`primeRadiant.page.verifiedBy${verifierKey(c.verified) ?? ""}`, { by: c.verified.by, at: formatWhen(c.verified.at, locale) })}
                        </span>
                      )}
                    </div>
                    {c.evidence.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-[11px] text-[var(--text-secondary)]">
                        {c.evidence.map((e, i) => (
                          <li key={i} className="flex gap-1.5">
                            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 13 }} aria-hidden="true">link</span>
                            <span className="break-all">{[e.kind, e.path ?? e.sourceId, e.lines, e.note].filter(Boolean).join(" · ")}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={`${CARD_SURFACE} p-3`} data-testid="prime-radiant-sources">
            <h3 className={SECTION_LABEL}>{t("primeRadiant.page.sources")}</h3>
            {fm && fm.sources.length > 0 ? (
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-[var(--text-secondary)]">
                {fm.sources.map((s) => <li key={s} className="break-all">{s}</li>)}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-[var(--text-muted)]">{t("primeRadiant.page.noSources")}</p>
            )}
          </section>

          <div className="grid @md:grid-cols-2 gap-3">
            <LinkList title={t("primeRadiant.page.backlinks")} empty={t("primeRadiant.page.noBacklinks")} paths={page.backlinks} onOpen={onOpen} testId="prime-radiant-backlinks" />
            <LinkList title={t("primeRadiant.page.links")} empty={t("primeRadiant.page.noLinks")} paths={page.links} onOpen={onOpen} testId="prime-radiant-links" />
          </div>

          {page.lint.findings.length > 0 && (
            <section className={`${CARD_SURFACE} p-3`}>
              <h3 className={SECTION_LABEL}>{t("primeRadiant.tab.lint")}</h3>
              <ul className="mt-2 space-y-1 text-xs">
                {page.lint.findings.map((f, i) => (
                  <li key={`${f.rule}:${i}`} className={f.severity === "error" ? "text-red-300" : "text-amber-200"}>
                    <span className="font-mono">{f.rule}</span> — {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={`${CARD_SURFACE} p-4 text-sm text-[var(--text-secondary)] leading-relaxed`} data-testid="prime-radiant-page-body">
            {renderText(page.body, t("chat.table"))}
          </section>
        </>
      )}
    </div>
  );
}

function LinkList({ title, empty, paths, onOpen, testId }: {
  title: string;
  empty: string;
  paths: string[];
  onOpen: (path: string) => void;
  testId: string;
}) {
  return (
    <section className={`${CARD_SURFACE} p-3`} data-testid={testId}>
      <h3 className={SECTION_LABEL}>{title}</h3>
      {paths.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {paths.map((p) => (
            <li key={p}>
              <button type="button" onClick={() => onOpen(p)} className="text-xs text-[var(--coral-bright)] hover:underline cursor-pointer text-left break-all">
                {pageLabel(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
