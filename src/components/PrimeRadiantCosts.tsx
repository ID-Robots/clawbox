"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import { API, errorText, formatCount, formatUsd, formatWhen, prJson, type CostSummary } from "./prime-radiant-ui";

/**
 * Costs: tokens in and out and the estimated dollars of every model call,
 * per run (each ingest and each night), per operation and per model. Every
 * figure is an ESTIMATE from public list rates — the box is not billed from
 * here — and the claim embeddings of the contradiction pass are listed as
 * not measured, because the embedder reports no usage: a total is never
 * presented as complete when it is not.
 */
export default function PrimeRadiantCosts({ revision }: { revision: number }) {
  const { t, locale } = useT();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<CostSummary>(`${API}/costs`, { signal: ctl.signal })
      .then((s) => { setSummary(s); setError(null); })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [revision, t]);

  const n = (v: number) => formatCount(v, locale);
  const usd = (v: number) => formatUsd(v, locale);

  return (
    <div className="space-y-4" data-testid="prime-radiant-costs">
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {summary && (
        <>
          <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.costs.estimateNote")}</p>
          <div className="grid grid-cols-2 @md:grid-cols-4 gap-2" data-testid="prime-radiant-cost-totals">
            {([
              ["primeRadiant.costs.calls", n(summary.totals.calls)],
              ["primeRadiant.costs.tokensIn", n(summary.totals.tokensIn)],
              ["primeRadiant.costs.tokensOut", n(summary.totals.tokensOut)],
              ["primeRadiant.costs.usd", usd(summary.totals.usdEstimate)],
            ] as const).map(([key, value]) => (
              <div key={key} className={`${INSET_SURFACE} px-3 py-2`}>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t(key)}</div>
                <div className="mt-0.5 text-base font-semibold text-[var(--text-primary)] tabular-nums">{value}</div>
              </div>
            ))}
          </div>

          {summary.notMeasured.length > 0 && (
            <ul className="text-[11px] text-amber-200" data-testid="prime-radiant-cost-not-measured">
              {summary.notMeasured.map((m) => (
                <li key={m.operation}>{t(`primeRadiant.costs.notMeasured.${m.operation}`)}</li>
              ))}
            </ul>
          )}

          <section className={`${CARD_SURFACE} p-3`}>
            <h3 className={SECTION_LABEL}>{t("primeRadiant.costs.byRun")}</h3>
            {summary.byRun.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--text-muted)]">{t("primeRadiant.costs.none")}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs" data-testid="prime-radiant-cost-runs">
                  <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    <tr>
                      <th className="text-left font-medium py-1 pr-2">{t("primeRadiant.costs.run")}</th>
                      <th className="text-left font-medium py-1 pr-2">{t("primeRadiant.costs.when")}</th>
                      <th className="text-right font-medium py-1 pr-2">{t("primeRadiant.costs.calls")}</th>
                      <th className="text-right font-medium py-1 pr-2">{t("primeRadiant.costs.tokensIn")}</th>
                      <th className="text-right font-medium py-1 pr-2">{t("primeRadiant.costs.tokensOut")}</th>
                      <th className="text-right font-medium py-1">{t("primeRadiant.costs.usd")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-[var(--text-secondary)] tabular-nums">
                    {summary.byRun.map((r) => (
                      <tr key={`${r.kind}:${r.runId ?? "none"}`} className="border-t border-white/[0.06]">
                        <td className="py-1 pr-2">{t(`primeRadiant.costs.kind.${r.kind}`)}</td>
                        <td className="py-1 pr-2">{formatWhen(r.firstAt, locale)}</td>
                        <td className="py-1 pr-2 text-right">{n(r.calls)}</td>
                        <td className="py-1 pr-2 text-right">{n(r.tokensIn)}</td>
                        <td className="py-1 pr-2 text-right">{n(r.tokensOut)}</td>
                        <td className="py-1 text-right">{usd(r.usdEstimate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid @md:grid-cols-2 gap-3">
            <section className={`${CARD_SURFACE} p-3`}>
              <h3 className={SECTION_LABEL}>{t("primeRadiant.costs.byOperation")}</h3>
              <ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">
                {summary.byOperation.map((o) => (
                  <li key={o.operation} className="flex justify-between gap-2">
                    <span className="font-mono">{o.operation}</span>
                    <span className="tabular-nums">{usd(o.usdEstimate)}</span>
                  </li>
                ))}
                {summary.byOperation.length === 0 && <li className="text-[var(--text-muted)]">{t("primeRadiant.costs.none")}</li>}
              </ul>
            </section>
            <section className={`${CARD_SURFACE} p-3`}>
              <h3 className={SECTION_LABEL}>{t("primeRadiant.costs.byModel")}</h3>
              <ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">
                {summary.byModel.map((m) => (
                  <li key={m.model} className="flex justify-between gap-2">
                    <span className="font-mono">{m.model}</span>
                    <span className="tabular-nums">{usd(m.usdEstimate)}</span>
                  </li>
                ))}
                {summary.byModel.length === 0 && <li className="text-[var(--text-muted)]">{t("primeRadiant.costs.none")}</li>}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
