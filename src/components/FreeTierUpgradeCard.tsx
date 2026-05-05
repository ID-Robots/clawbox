import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { useT } from "@/lib/i18n";

interface FreeTierUpgradeCardProps {
  /** Feature being gated, used in the headline ("X needs a paid plan"). */
  featureName: string;
  /** Body copy. Should explain what unlocks at Pro vs. Max if relevant. */
  description: string;
}

/**
 * Cosmetic gate shown when a Free user attempts a Pro/Max-only feature.
 * The portal still rejects the underlying API call (paid_plan_required),
 * but rendering the upgrade CTA up-front avoids the user clicking a
 * working-looking button only to bounce off a server-side 402.
 */
export default function FreeTierUpgradeCard({ featureName, description }: FreeTierUpgradeCardProps) {
  const { t } = useT();
  return (
    <div className="max-w-xl flex flex-col gap-3">
      {/* Trial promo banner — kept in English to match the portal's
          "START 30-DAY FREE TRIAL" CTA wording (AIModelsStep uses the
          same hardcoded copy on the Max plan card during setup). */}
      <a
        href={PORTAL_DASHBOARD_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 bg-gradient-to-r from-fuchsia-500/15 to-pink-500/15 border border-fuchsia-400/30 hover:from-fuchsia-500/25 hover:to-pink-500/25 transition-colors no-underline"
      >
        <div className="flex items-center gap-3 text-left">
          <span
            aria-hidden="true"
            className="material-symbols-rounded text-fuchsia-300"
            style={{ fontSize: 22 }}
          >
            redeem
          </span>
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              {t("upgradeCard.trialBannerHeadline")}
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {t("upgradeCard.trialBannerSubtitle")}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)] whitespace-nowrap">
          {t("upgradeCard.startFreeTrial")}
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
        </span>
      </a>
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 flex flex-col items-center text-center gap-4">
        <img
          src="/clawbox-crab.png"
          alt=""
          width={64}
          height={64}
          className="select-none pointer-events-none drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]"
        />
        <div>
          <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
            {t("upgradeCard.needsPaidPlan", { feature: featureName })}
          </h3>
          <p className="text-sm text-[var(--text-muted)] leading-relaxed">
            {description}
          </p>
        </div>
        <a
          href={PORTAL_DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer no-underline"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
          {t("upgradeCard.subscribeButton")}
        </a>
      </div>
    </div>
  );
}
