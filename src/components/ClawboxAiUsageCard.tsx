"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { formatFreesUpAt } from "@/lib/clawai-allowance";
import {
  CLAWAI_USAGE_METERS,
  PORTAL_CREDITS_URL,
  PORTAL_PLANS_URL,
  YEARLY_SAVINGS_PCT,
  formatCredits,
  formatUsageCount,
  formatUsageMinutes,
  offersYearlyBilling,
  type ClawaiUsage,
  type ClawaiUsageMeter,
  type ClawaiUsageWindow,
} from "@/lib/clawai-usage";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";

/**
 * Settings → Providers: how much of this box's ClawBox AI allowance is spent,
 * and when it comes back.
 *
 * Fed by `/setup-api/ai-models/usage`. Three things it can show:
 *  - a portal with rolling allowances: the weekly chat pool, the 5-hour burst
 *    ceiling, the four weekly meters, credits (or Upgrade on Free) and the
 *    yearly-billing offer for a monthly subscriber;
 *  - an older portal: its daily fields, as it sends them;
 *  - neither: a sentence saying why, never a zeroed bar — an empty bar over an
 *    allowance that could not be read tells the owner the opposite of the truth.
 */

/** Once a minute: the bars move with chat turns, and the route caches for half of that. */
const POLL_MS = 60_000;

type UsageResponse =
  | { available: true; timeZone?: string | null; usage: ClawaiUsage }
  | { available: false; reason: string };

/**
 * The label for each meter. A table rather than a key assembled from the meter
 * name, so the catalogue parity test can see every key.
 */
const METER_KEY: Record<ClawaiUsageMeter, string> = {
  images: "clawaiUsage.meterImages",
  speechSeconds: "clawaiUsage.meterSpeech",
  audioSeconds: "clawaiUsage.meterTranscription",
  embeddingsTokens: "clawaiUsage.meterEmbeddings",
};

const CARD_CLASS = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";

const LINK_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium no-underline cursor-pointer";

function UsageBar({ percent, over, size, label }: { percent: number; over: boolean; size: "lg" | "sm"; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = over ? "bg-red-500" : clamped >= 80 ? "bg-amber-400" : "bg-orange-500";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={`w-full overflow-hidden rounded-full bg-[var(--bg-deep,rgba(255,255,255,0.08))] ${size === "lg" ? "h-2.5" : "h-1.5"}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function OpenInNewIcon() {
  return (
    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
      open_in_new
    </span>
  );
}

export default function ClawboxAiUsageCard() {
  const { t, locale } = useT();
  const [response, setResponse] = useState<UsageResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/setup-api/ai-models/usage", { cache: "no-store" })
        .then((res) => res.json() as Promise<UsageResponse>)
        .then((body) => {
          if (!cancelled && body && typeof body === "object") setResponse(body);
        })
        .catch(() => {
          if (!cancelled) setResponse({ available: false, reason: "unreachable" });
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!response) {
    return (
      <div className={CARD_CLASS} data-testid="clawai-usage-card" aria-busy="true">
        <p className="text-xs text-[var(--text-muted)]">{t("clawaiUsage.loading")}</p>
      </div>
    );
  }

  if (!response.available) {
    // No ClawBox AI credential on the box: there is no allowance to describe.
    if (response.reason === "not_connected") return null;
    const refused = response.reason === "refused";
    return (
      <div className={CARD_CLASS} data-testid="clawai-usage-card">
        <CardHeader title={t("clawaiUsage.title")} plan={null} planLabel={null} />
        <p className="mt-3 text-xs text-[var(--text-muted)] leading-relaxed" data-testid="clawai-usage-unavailable">
          {refused ? t("clawaiUsage.refused") : t("clawaiUsage.unreachable")}
        </p>
        {refused && (
          <a
            href={PORTAL_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${LINK_BUTTON_CLASS} mt-3 border border-[var(--border-subtle)] text-[var(--text-primary)] hover:bg-white/5`}
          >
            <OpenInNewIcon />
            {t("clawaiUsage.openPortal")}
          </a>
        )}
      </div>
    );
  }

  const { usage } = response;
  const clock = (resetAt: string | null) => formatFreesUpAt(resetAt, { locale, timeZone: response.timeZone ?? null });
  const planLabel = usage.tierDisplayName ? t("clawaiUsage.planName", { plan: usage.tierDisplayName }) : null;

  if (usage.shape === "legacy") {
    const { legacy } = usage;
    return (
      <div className={CARD_CLASS} data-testid="clawai-usage-card" data-shape="legacy">
        <CardHeader title={t("clawaiUsage.title")} plan={usage.plan} planLabel={planLabel} />
        <div className="mt-4 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-[var(--text-primary)]">{t("clawaiUsage.legacyTitle")}</span>
            <span className="text-xs text-[var(--text-secondary)] tabular-nums">
              {t("clawaiUsage.percentUsed", { percent: legacy.percentUsed })}
            </span>
          </div>
          <UsageBar percent={legacy.percentUsed} over={legacy.isOverLimit} size="lg" label={t("clawaiUsage.legacyTitle")} />
          {legacy.resetIn && (
            <p className="text-xs text-[var(--text-muted)]">{t("clawaiUsage.legacyResetsIn", { time: legacy.resetIn })}</p>
          )}
          {legacy.isOverLimit && (
            <p className="text-xs text-red-400">{t("clawaiUsage.legacyOverLimit")}</p>
          )}
        </div>
      </div>
    );
  }

  const isFree = usage.plan === "free";
  const isPaid = !isFree && (usage.plan === "pro" || usage.plan === "max" || usage.credits?.canBuy === true);

  const valueFor = (meter: ClawaiUsageMeter | "tokens", window: ClawaiUsageWindow): string => {
    if (window.unavailable) return t("clawaiUsage.notReadable");
    if (window.limit <= 0) return t("clawaiUsage.notInPlan");
    if (meter === "speechSeconds" || meter === "audioSeconds") {
      return t("clawaiUsage.minutesOf", {
        used: formatUsageMinutes(window.used, locale, "up"),
        limit: formatUsageMinutes(window.limit, locale, "down"),
      });
    }
    const params = { used: formatUsageCount(window.used, locale), limit: formatUsageCount(window.limit, locale) };
    return meter === "images" ? t("clawaiUsage.countOf", params) : t("clawaiUsage.tokensOf", params);
  };

  // Only a window holding usage has anything to free up; a readable one with
  // nothing in it gets no clock rather than an instant that means nothing.
  const freesUp = (window: ClawaiUsageWindow): string | null => {
    if (window.unavailable || window.used <= 0) return null;
    const time = clock(window.resetAt);
    return time ? t("clawaiUsage.freesUpAt", { time }) : null;
  };

  // A window with no limit is "Not in your plan": no percentage, bar or clock beside it.
  const weeklyFreesUp = usage.weekly.limit > 0 ? freesUp(usage.weekly) : null;
  const burstFreesUp = usage.burst && usage.burst.limit > 0 ? freesUp(usage.burst) : null;
  const meters = CLAWAI_USAGE_METERS.filter((meter) => usage.meters[meter]);

  return (
    <div className={CARD_CLASS} data-testid="clawai-usage-card" data-shape="weekly">
      <CardHeader title={t("clawaiUsage.title")} plan={usage.plan} planLabel={planLabel} />

      {/* The weekly chat pool: the number that is actually enforced. */}
      <section className="mt-4 space-y-2" data-testid="clawai-usage-weekly">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-[var(--text-primary)]">{t("clawaiUsage.weeklyTitle")}</span>
          {!usage.weekly.unavailable && usage.weekly.limit > 0 && (
            <span className="text-xs text-[var(--text-secondary)] tabular-nums">
              {t("clawaiUsage.percentUsed", { percent: usage.weekly.percentUsed })}
            </span>
          )}
        </div>
        {!usage.weekly.unavailable && usage.weekly.limit > 0 && (
          <UsageBar percent={usage.weekly.percentUsed} over={usage.weekly.isOverLimit} size="lg" label={t("clawaiUsage.weeklyTitle")} />
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
          <span className="text-[var(--text-secondary)] tabular-nums">{valueFor("tokens", usage.weekly)}</span>
          {weeklyFreesUp && <span className="text-[var(--text-muted)]">{weeklyFreesUp}</span>}
        </div>
      </section>

      {/* The burst ceiling over it: smaller, because it is the short-term one. */}
      {usage.burst && (
        <section className="mt-4 space-y-1.5" data-testid="clawai-usage-burst">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-medium text-[var(--text-secondary)]">{t("clawaiUsage.burstTitle")}</span>
            <span className="text-[var(--text-muted)] tabular-nums">{valueFor("tokens", usage.burst)}</span>
          </div>
          {!usage.burst.unavailable && usage.burst.limit > 0 && (
            <UsageBar percent={usage.burst.percentUsed} over={usage.burst.isOverLimit} size="sm" label={t("clawaiUsage.burstTitle")} />
          )}
          {burstFreesUp && <p className="text-[11px] text-[var(--text-muted)]">{burstFreesUp}</p>}
        </section>
      )}

      {meters.length > 0 && (
        <section className="mt-5 border-t border-[var(--border-subtle)] pt-4" data-testid="clawai-usage-meters">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("clawaiUsage.metersTitle")}</h4>
          <ul className="mt-3 space-y-3">
            {meters.map((meter) => {
              const window = usage.meters[meter] as ClawaiUsageWindow;
              const meterFreesUp = window.limit > 0 ? freesUp(window) : null;
              return (
                <li key={meter} className="space-y-1" data-testid={`clawai-usage-meter-${meter}`}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-[var(--text-primary)]">{t(METER_KEY[meter])}</span>
                    <span className="text-[var(--text-secondary)] tabular-nums">{valueFor(meter, window)}</span>
                  </div>
                  {!window.unavailable && window.limit > 0 && (
                    <UsageBar percent={window.percentUsed} over={window.isOverLimit} size="sm" label={t(METER_KEY[meter])} />
                  )}
                  {meterFreesUp && <p className="text-[11px] text-[var(--text-muted)]">{meterFreesUp}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {isPaid && (
        <section className="mt-5 border-t border-[var(--border-subtle)] pt-4 space-y-2" data-testid="clawai-usage-credits">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("clawaiUsage.creditsTitle")}</h4>
          {usage.credits && (
            <dl className="space-y-1 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--text-primary)]">{t("clawaiUsage.creditsBalance")}</dt>
                <dd className="text-[var(--text-secondary)] tabular-nums" data-testid="clawai-usage-credits-balance">
                  {usage.credits.unavailable
                    ? t("clawaiUsage.notReadable")
                    : formatCredits(usage.credits.balanceCents, usage.credits.currency, locale)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--text-primary)]">{t("clawaiUsage.creditsUsedThisWeek")}</dt>
                <dd className="text-[var(--text-secondary)] tabular-nums" data-testid="clawai-usage-credits-used">
                  {usage.credits.unavailable
                    ? t("clawaiUsage.notReadable")
                    : formatCredits(usage.credits.usedThisWeekCents, usage.credits.currency, locale)}
                </dd>
              </div>
            </dl>
          )}
          <p className="text-[11px] text-[var(--text-muted)]">{t("clawaiUsage.creditsHint")}</p>
          <a
            href={PORTAL_CREDITS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${LINK_BUTTON_CLASS} btn-gradient text-white`}
            data-testid="clawai-usage-top-up"
          >
            <OpenInNewIcon />
            {t("clawaiUsage.topUp")}
          </a>
        </section>
      )}

      {isFree && (
        <section className="mt-5 border-t border-[var(--border-subtle)] pt-4 space-y-2" data-testid="clawai-usage-upgrade">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">{t("clawaiUsage.upgradeHint")}</p>
          <a
            href={PORTAL_PLANS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${LINK_BUTTON_CLASS} btn-gradient text-white`}
          >
            <OpenInNewIcon />
            {t("clawaiUsage.upgrade")}
          </a>
        </section>
      )}

      {offersYearlyBilling(usage) && (
        <a
          href={PORTAL_PLANS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 no-underline"
          data-testid="clawai-usage-yearly-offer"
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
            savings
          </span>
          {t("clawaiUsage.yearlyOffer", { percent: YEARLY_SAVINGS_PCT })}
        </a>
      )}
    </div>
  );
}

function CardHeader({ title, plan, planLabel }: { title: string; plan: string | null; planLabel: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="material-symbols-rounded text-orange-400" aria-hidden="true" style={{ fontSize: 18 }}>
          data_usage
        </span>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      </div>
      {planLabel && (
        <span
          className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]"
          data-plan={plan ?? undefined}
        >
          {planLabel}
        </span>
      )}
    </div>
  );
}
