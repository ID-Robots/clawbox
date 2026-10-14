"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_PRIMARY, FIELD, INSET_SURFACE } from "./coding-agent-ui";
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

/**
 * Search: the vault through Memory Shard's engine (`GET search`). Memory Shard
 * is the search engine; Prime Radiant is one of its sources, so with Memory
 * Shard switched off there is nothing to search and the tab says so. A server
 * that predates the route answers 404, which reads as "not on this box yet"
 * rather than as an error.
 */
export default function PrimeRadiantSearch({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const { t, locale } = useT();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await prJson<SearchAnswer>(`${API}/search?${new URLSearchParams({ q, limit: "20" })}`);
      const hits = Array.isArray(answer?.results) ? answer.results : [];
      setResults(hits);
      if (answer?.shardEnabled === false) setNotice("shardOff");
      else if (answer?.indexing) setNotice("indexing");
      else if (hits.length === 0) setNotice("noResults");
    } catch (err) {
      setResults(null);
      if (err instanceof PrimeRadiantError && err.status === 404) setNotice("unavailable");
      else setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const percent = (n: number) => new Intl.NumberFormat(locale, { style: "percent" }).format(Math.max(0, Math.min(1, n)));

  return (
    <div className="space-y-3" data-testid="prime-radiant-search">
      <form className="flex gap-2" onSubmit={run}>
        <label className="sr-only" htmlFor="pr-search-q">{t("primeRadiant.search.placeholder")}</label>
        <input
          id="pr-search-q"
          className={`${FIELD} text-sm flex-1`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("primeRadiant.search.placeholder")}
          maxLength={1000}
          data-testid="prime-radiant-search-q"
        />
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !query.trim()} data-testid="prime-radiant-search-go">
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">search</span>
          {busy ? t("primeRadiant.search.searching") : t("primeRadiant.search.go")}
        </button>
      </form>
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
    </div>
  );
}
