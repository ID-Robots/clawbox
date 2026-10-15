"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_QUIET, CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import { API, PrimeRadiantError, errorText, pageLabel, prJson } from "./prime-radiant-ui";

/** One hit as the search route answers it (Memory Shard's engine over the vault). */
interface SearchHit {
  source?: string;
  path: string;
  id: string;
  kind: "page" | "claim";
  type: string;
  title: string;
  snippet: string;
  score: number;
  similarity?: number;
  verified: boolean;
}

interface SearchAnswer {
  initialised?: boolean;
  shardEnabled?: boolean;
  indexing?: boolean;
  results?: SearchHit[];
}

type Notice = "unavailable" | "shardOff" | "indexing" | "noResults" | null;

/**
 * The index stores every chunk led by its page's title (`Title\n\nbody…`,
 * `Title: claim`) so a chunk from the middle of a page still says what it is
 * about. The row already shows the title, so the snippet drops that lead.
 */
function snippetBody(hit: Pick<SearchHit, "title" | "snippet">): string {
  const title = hit.title.trim();
  const text = hit.snippet;
  if (title) {
    for (const lead of [`${title}\n\n`, `${title}: `]) {
      if (text.startsWith(lead)) return text.slice(lead.length).trim();
    }
  }
  return text.trim();
}

/** A content search Pages asked for: the words, and a count so the same words can be asked again. */
export interface SearchRequest {
  q: string;
  n: number;
}

/**
 * Searching inside pages, under the Pages tab's one search field: the vault
 * through Memory Shard's engine (`GET search`), run when the owner presses
 * Enter or the search button (typing alone only filters the list by title).
 * Memory Shard is the search engine; Prime Radiant is one of its sources, so
 * with Memory Shard switched off there is nothing to search and this says so.
 * A server that predates the route answers 404, which reads as "not on this
 * box yet" rather than as an error.
 */
export default function PrimeRadiantSearch({ request, onOpenPage, onClose, onBusy }: {
  request: SearchRequest;
  onOpenPage: (path: string) => void;
  onClose: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const { t, locale } = useT();
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    onBusy?.(true);
    prJson<SearchAnswer>(`${API}/search?${new URLSearchParams({ q: request.q, limit: "20" })}`, { signal: ctl.signal })
      .then((answer) => {
        if (ctl.signal.aborted) return;
        const hits = Array.isArray(answer?.results) ? answer.results : [];
        setResults(hits);
        setError(null);
        setNotice(answer?.shardEnabled === false ? "shardOff" : answer?.indexing ? "indexing" : hits.length === 0 ? "noResults" : null);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || ctl.signal.aborted) return;
        setResults(null);
        if (err instanceof PrimeRadiantError && err.status === 404) {
          setNotice("unavailable");
          setError(null);
        } else {
          setNotice(null);
          setError(errorText(err, t));
        }
      })
      .finally(() => {
        if (!ctl.signal.aborted) onBusy?.(false);
      });
    return () => ctl.abort();
    // `onBusy` is the parent's setter; a new request is what runs a search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, t]);

  const percent = (n: number) => new Intl.NumberFormat(locale, { style: "percent" }).format(Math.max(0, Math.min(1, n)));

  return (
    <section className={`${CARD_SURFACE} p-3 space-y-2`} data-testid="prime-radiant-search">
      <div className="flex items-center justify-between gap-2">
        <h3 className={SECTION_LABEL}>{t("primeRadiant.search.insideTitle")}</h3>
        <button type="button" className={`${BTN_QUIET} !px-1.5 !py-0.5`} onClick={onClose} aria-label={t("primeRadiant.search.close")} title={t("primeRadiant.search.close")} data-testid="prime-radiant-search-close">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
        </button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.search.hint")}</p>

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {notice && (
        <p role="status" className="text-xs text-[var(--text-secondary)]" data-testid="prime-radiant-search-notice" data-notice={notice}>
          {t(`primeRadiant.search.${notice}`)}
        </p>
      )}

      {results && results.length > 0 && (
        <ul className="space-y-1.5" data-testid="prime-radiant-search-results">
          {results.map((hit) => (
            <li key={`${hit.kind}:${hit.id}:${hit.path}`}>
              <button
                type="button"
                onClick={() => onOpenPage(hit.path)}
                className={`${INSET_SURFACE} w-full text-left px-3 py-2 hover:bg-white/[0.06] cursor-pointer`}
                data-testid="prime-radiant-search-hit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {hit.verified && (
                    <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 15 }} aria-label={t("primeRadiant.verified")} role="img">verified</span>
                  )}
                  <span className="text-sm text-[var(--text-primary)] truncate">{hit.title || pageLabel(hit.path)}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    {hit.kind === "claim" ? t("primeRadiant.search.claim") : t("primeRadiant.search.page")}
                    {hit.type ? ` · ${t(`primeRadiant.type.${hit.type}`)}` : ""}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)] line-clamp-2">{snippetBody(hit)}</p>
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)] font-mono truncate">
                  {hit.kind === "claim" ? hit.id : hit.path} · {t("primeRadiant.search.score", { value: percent(hit.score) })}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
