"use client";

import { useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import { API, errorText, formatCount, formatTokens, formatWhen, prJson, type CostSummary } from "./prime-radiant-ui";

/**
 * Tokens per run id — each ingest job and each night — from the usage route
 * (`GET costs`), read again whenever `key` changes and, with `everyMs`, on a
 * timer meanwhile (a job that is still running). Null until the first answer;
 * a refusal leaves whatever was there (usage is a footnote, never an error).
 */
export function useTokensByRun(key: unknown, everyMs = 0): ReadonlyMap<string, number> | null {
  const [byRun, setByRun] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const read = () =>
      prJson<CostSummary>(`${API}/costs`, { signal: ctl.signal })
        .then((s) => {
          if (ctl.signal.aborted || !Array.isArray(s?.byRun)) return;
          setByRun(new Map(s.byRun.flatMap((r) => (r.runId ? [[r.runId, r.tokensIn + r.tokensOut] as [string, number]] : []))));
        })
        .catch(() => undefined);
    void read();
    const timer = everyMs > 0 ? setInterval(() => void read(), everyMs) : null;
    return () => {
      ctl.abort();
      if (timer) clearInterval(timer);
    };
  }, [key, everyMs]);
  return byRun;
}

/**
 * Model usage, in Settings: tokens sent and received and the model calls
 * that used them — all told, by task and by model, and per import and night
 * on demand. Tokens only: Prime Radiant puts no price on screen. The claim
 * embeddings of the contradiction pass are named as not measured, because the
 * embedder reports no usage, so a total is never shown as complete when it
 * is not.
 */
export default function PrimeRadiantUsage({ revision }: { revision: number }) {
  const { t, locale } = useT();
  /** The "per run" heading names the table (two windows must not share an id). */
  const byRunId = useId();
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
  const tok = (v: number) => formatTokens(v, locale);
  const total = summary ? summary.totals.tokensIn + summary.totals.tokensOut : 0;

  return (
    <section className={`${CARD_SURFACE} p-4 space-y-2`} data-testid="prime-radiant-usage">
      <h3 className={SECTION_LABEL}>{t("primeRadiant.usage.title")}</h3>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {summary && (
        <>
          <p className="text-xs text-[var(--text-secondary)] tabular-nums" data-testid="prime-radiant-usage-total">
            {t("primeRadiant.usage.total", { tokens: tok(total), sent: tok(summary.totals.tokensIn), received: tok(summary.totals.tokensOut), calls: n(summary.totals.calls) })}
          </p>
          {summary.byOperation.length > 0 && (
            <p className="text-[11px] text-[var(--text-muted)] tabular-nums" data-testid="prime-radiant-usage-by-task">
              <span className="uppercase tracking-wider">{t("primeRadiant.costs.byOperation")}</span>{" "}
              {summary.byOperation.map((o) => `${o.operation} ${tok(o.tokensIn + o.tokensOut)}`).join(" · ")}
            </p>
          )}
          {summary.byModel.length > 0 && (
            <p className="text-[11px] text-[var(--text-muted)] tabular-nums" data-testid="prime-radiant-usage-by-model">
              <span className="uppercase tracking-wider">{t("primeRadiant.costs.byModel")}</span>{" "}
              {summary.byModel.map((m) => `${m.model} ${tok(m.tokensIn + m.tokensOut)}`).join(" · ")}
            </p>
          )}
          {(summary.byBasis ?? []).filter((b) => b.basis === "subscription" && b.calls > 0).map((b) => (
            <p key={b.basis} className="text-[11px] text-[var(--text-muted)] tabular-nums" data-testid="prime-radiant-usage-subscription">
              {t("primeRadiant.costs.subscriptionCalls", { calls: n(b.calls) })}
            </p>
          ))}
          {summary.notMeasured.length > 0 && (
            <ul className="text-[11px] text-amber-200" data-testid="prime-radiant-usage-not-measured">
              {summary.notMeasured.map((m) => (
                <li key={m.operation}>{t(`primeRadiant.costs.notMeasured.${m.operation}`)}</li>
              ))}
            </ul>
          )}
          {summary.byRun.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.costs.none")}</p>
          ) : (
            <details className="text-xs">
              <summary id={byRunId} className="cursor-pointer text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                {t("primeRadiant.usage.details")}
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table aria-labelledby={byRunId} className="w-full text-xs" data-testid="prime-radiant-usage-runs">
                  <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    <tr>
                      <th className="text-left font-medium py-1 pr-2">{t("primeRadiant.costs.run")}</th>
                      <th className="text-left font-medium py-1 pr-2">{t("primeRadiant.costs.when")}</th>
                      <th className="text-right font-medium py-1 pr-2">{t("primeRadiant.costs.calls")}</th>
                      <th className="text-right font-medium py-1 pr-2">{t("primeRadiant.costs.tokensIn")}</th>
                      <th className="text-right font-medium py-1">{t("primeRadiant.costs.tokensOut")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-[var(--text-secondary)] tabular-nums">
                    {summary.byRun.map((r) => (
                      <tr key={`${r.kind}:${r.runId ?? "none"}`} className="border-t border-white/[0.06]">
                        <td className="py-1 pr-2">{t(`primeRadiant.costs.kind.${r.kind}`)}</td>
                        <td className="py-1 pr-2">{formatWhen(r.firstAt, locale)}</td>
                        <td className="py-1 pr-2 text-right">{n(r.calls)}</td>
                        <td className="py-1 pr-2 text-right">{tok(r.tokensIn)}</td>
                        <td className="py-1 text-right">{tok(r.tokensOut)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
