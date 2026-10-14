"use client";

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { CARD_SURFACE, INSET_SURFACE } from "./coding-agent-ui";
import { API, errorText, pageLabel, prJson, type LintFinding, type LintReport } from "./prime-radiant-ui";

/**
 * Lint: the whole vault against its rules — size caps, summaries, orphans,
 * sources, staleness, secrets and the claim-id namespace. An error holds the
 * nightly merge; a "blocks saving" rule refuses the change outright. A page
 * over its cap carries the split the rule suggests: headings as child pages,
 * the page itself left as the hub.
 */
export default function PrimeRadiantLint({ revision, onOpenPage }: { revision: number; onOpenPage: (path: string) => void }) {
  const { t, locale } = useT();
  const [report, setReport] = useState<LintReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<LintReport>(`${API}/lint`, { signal: ctl.signal })
      .then((r) => { setReport(r); setError(null); })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [revision, t]);

  const byPage = useMemo(() => {
    const groups = new Map<string, LintFinding[]>();
    for (const f of report?.findings ?? []) groups.set(f.path, [...(groups.get(f.path) ?? []), f]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [report]);

  return (
    <div className="space-y-3" data-testid="prime-radiant-lint">
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {report && (
        <div className="grid grid-cols-3 gap-2">
          {([
            ["primeRadiant.lint.checked", report.checked],
            ["primeRadiant.lint.errors", report.errors],
            ["primeRadiant.lint.warnings", report.warnings],
          ] as const).map(([key, n]) => (
            <div key={key} className={`${INSET_SURFACE} px-3 py-2`}>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t(key)}</div>
              <div className="mt-0.5 text-base font-semibold text-[var(--text-primary)] tabular-nums">{n.toLocaleString(locale)}</div>
            </div>
          ))}
        </div>
      )}
      {report && report.findings.length === 0 && (
        <p className="py-6 text-center text-sm text-emerald-300" data-testid="prime-radiant-lint-clean">{t("primeRadiant.lint.clean")}</p>
      )}
      <ul className="space-y-2">
        {byPage.map(([path, findings]) => (
          <li key={path} className={`${CARD_SURFACE} p-3`} data-testid="prime-radiant-lint-page">
            <button type="button" onClick={() => onOpenPage(path)} className="text-sm text-[var(--coral-bright)] hover:underline cursor-pointer text-left break-all">
              {pageLabel(path)}
            </button>
            <ul className="mt-1.5 space-y-1.5">
              {findings.map((f, i) => (
                <li key={`${f.rule}:${i}`} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 border ${f.severity === "error" ? "text-red-300 border-red-400/30" : "text-amber-200 border-amber-300/30"}`}>
                      {f.severity === "error" ? t("primeRadiant.lint.error") : t("primeRadiant.lint.warning")}
                    </span>
                    <span className="font-mono text-[var(--text-muted)]">{f.rule}</span>
                    {f.blocksCommit && <span className="text-[10px] text-red-300">{t("primeRadiant.lint.blocks")}</span>}
                  </div>
                  <p className="mt-0.5 text-[var(--text-secondary)]">{f.message}</p>
                  {f.split && f.split.children.length > 0 && (
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                      <p>{t("primeRadiant.lint.split", { n: f.split.children.length })}</p>
                      <ul className="mt-0.5 list-disc pl-4">
                        {f.split.children.map((c) => <li key={c.path}>{c.title}</li>)}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
