"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { ConfirmDialog } from "./clawkeep-ui";
import { BTN_DANGER, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE } from "./coding-agent-ui";
import {
  API,
  PrimeRadiantError,
  errorText,
  formatWhen,
  jsonInit,
  pageLabel,
  pageUrl,
  prJson,
  shortSha,
  type CommitInfo,
  type DiffResult,
  type PageListEntry,
} from "./prime-radiant-ui";

/**
 * History: one page's commits (every change to the vault is one commit by
 * "Prime Radiant"), the diff of any of them, and Undo — a revert of that
 * commit's change to the page, as one new commit, linted like any other.
 * The route is owner-only and refuses an undo that would break a rule (undoing
 * a verification brings a retired claim id back, which the lint refuses).
 */
export default function PrimeRadiantHistory({ initialPage, revision, onChanged, onOpenPage }: {
  initialPage: string | null;
  revision: number;
  onChanged: () => void;
  onOpenPage: (path: string) => void;
}) {
  const { t, locale } = useT();
  const [pages, setPages] = useState<PageListEntry[]>([]);
  const [path, setPath] = useState<string | null>(initialPage);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CommitInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  /**
   * Held from the first Confirm until the revert answers. A ref, not `busy`:
   * a double click fires both handlers before React re-renders, and each
   * would read `busy` as false and POST a second, non-idempotent revert.
   */
  const reverting = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<{ pages: PageListEntry[] }>(`${API}/pages?limit=500`, { signal: ctl.signal })
      .then((a) => setPages(a.pages ?? []))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [revision]);

  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    prJson<{ commits: CommitInfo[] }>(pageUrl(`${API}/history`, path), { signal: ctl.signal })
      .then((a) => {
        if (ctl.signal.aborted) return;
        setCommits(a.commits ?? []);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setCommits(null);
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [path, revision, t]);

  useEffect(() => {
    if (!selected || !path) return;
    const ctl = new AbortController();
    prJson<DiffResult>(`${API}/diff?${new URLSearchParams({ commit: selected, path })}`, { signal: ctl.signal })
      .then((d) => { if (!ctl.signal.aborted) setDiff(d); })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setDiff(null);
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [selected, path, t]);

  const revert = async (commit: CommitInfo) => {
    setConfirm(null);
    if (!path || reverting.current) return;
    reverting.current = true;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await prJson<{ commit: string | null }>(`${API}/revert`, jsonInit("POST", { commit: commit.sha, path }));
      setDone(t("primeRadiant.history.reverted", { sha: shortSha(r.commit) }));
      setSelected(null);
      setDiff(null);
      onChanged();
    } catch (err) {
      const findings = err instanceof PrimeRadiantError && Array.isArray(err.body?.findings)
        ? (err.body.findings as Array<{ rule?: string }>).map((f) => f.rule).filter(Boolean).join(", ")
        : "";
      setError(findings ? `${errorText(err, t)} (${findings})` : errorText(err, t));
    } finally {
      reverting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="prime-radiant-history">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-[var(--text-muted)]" htmlFor="pr-history-page">{t("primeRadiant.history.page")}</label>
        <select
          id="pr-history-page"
          className={`${FIELD} text-xs flex-1 min-w-[12rem]`}
          value={path ?? ""}
          onChange={(e) => { setPath(e.target.value || null); setSelected(null); setDiff(null); setDone(null); setError(null); }}
          data-testid="prime-radiant-history-page"
        >
          <option value="">{t("primeRadiant.history.choose")}</option>
          {path && !pages.some((p) => p.path === path) && <option value={path}>{pageLabel(path)}</option>}
          {pages.map((p) => <option key={p.path} value={p.path}>{p.title ?? pageLabel(p.path)}</option>)}
        </select>
        {path && (
          <button type="button" className={BTN_SECONDARY} onClick={() => onOpenPage(path)}>{t("primeRadiant.history.openPage")}</button>
        )}
      </div>

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {done && <p role="status" className="text-xs text-emerald-300">{done}</p>}
      {!path && <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("primeRadiant.history.hint")}</p>}

      {path && commits && (
        <ul className="space-y-1.5" data-testid="prime-radiant-commits">
          {commits.length === 0 && <li className="text-xs text-[var(--text-muted)]">{t("primeRadiant.history.none")}</li>}
          {commits.map((c) => (
            <li key={c.sha} className={`${INSET_SURFACE} px-3 py-2`} data-testid="prime-radiant-commit">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setSelected(selected === c.sha ? null : c.sha)}
                  aria-expanded={selected === c.sha}
                  className="flex-1 min-w-0 text-left cursor-pointer"
                >
                  <span className="block text-sm text-[var(--text-primary)] truncate">{c.subject}</span>
                  <span className="block text-[11px] text-[var(--text-muted)]">
                    <span className="font-mono">{shortSha(c.sha)}</span> · {c.author} · {formatWhen(c.at, locale)}
                  </span>
                </button>
                <button
                    type="button"
                    className={BTN_DANGER}
                    disabled={busy}
                    onClick={() => setConfirm(c)}
                    data-testid="prime-radiant-revert"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">undo</span>
                    {t("primeRadiant.history.undo")}
                  </button>
              </div>
              {selected === c.sha && diff && diff.to === c.sha && (
                <pre className={`${CARD_SURFACE} mt-2 p-2 max-h-80 overflow-auto text-[11px] leading-snug font-mono whitespace-pre`} data-testid="prime-radiant-diff">
                  {diff.diff.split("\n").map((line, j) => (
                    <span
                      key={j}
                      className={`block ${line.startsWith("+") && !line.startsWith("+++") ? "text-emerald-300" : line.startsWith("-") && !line.startsWith("---") ? "text-red-300" : line.startsWith("@@") ? "text-sky-300" : "text-[var(--text-secondary)]"}`}
                    >
                      {line || " "}
                    </span>
                  ))}
                  {diff.truncated && <span className="block text-amber-200">{t("primeRadiant.history.truncated")}</span>}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <ConfirmDialog
          title={t("primeRadiant.history.confirmTitle")}
          body={t("primeRadiant.history.confirmBody", { subject: confirm.subject })}
          confirmLabel={t("primeRadiant.history.undo")}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void revert(confirm)}
        />
      )}
    </div>
  );
}
