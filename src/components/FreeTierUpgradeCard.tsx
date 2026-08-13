import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { useT } from "@/lib/i18n";
import { SettingsGroup } from "./settings";

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
 *
 * COLOUR: the banner used to be a fuchsia→pink gradient with a fuchsia border
 * and a `rgba(217,70,239,.3)` glow — five literals that no palette could follow,
 * and a sixth accent competing with the pane's two-accent system (coral = ACTION,
 * cyan = DONE). Both CTAs here are the same statement — "go to the portal and
 * pay" — so they are ACTION, and action is `--set-primary` in every edition.
 * Nothing in this file carries a colour literal any more, which is what lets it
 * render correctly under `[data-agent="hermes"]`.
 */
export default function FreeTierUpgradeCard({ featureName, description }: FreeTierUpgradeCardProps) {
  const { t } = useT();
  return (
    /* Single `max-w-xl` root div — the desktop shell centres direct children
       only, so this must stay one element with no sibling roots. */
    <div className="max-w-xl flex flex-col gap-[12px]">
      {/* Trial promo banner — kept in English to match the portal's
          "START 30-DAY FREE TRIAL" CTA wording (AIModelsStep uses the
          same hardcoded copy on the Max plan card during setup). */}
      <a
        href={PORTAL_DASHBOARD_URL}
        target="_blank"
        rel="noreferrer"
        /* `flex-wrap` is the 360px story: the chip drops onto its own line
           instead of crushing the headline, and the row keeps a 44px target. */
        className="flex min-h-[44px] flex-wrap items-center justify-between gap-[12px] rounded-[16px] bg-[var(--set-surface-container)] px-[16px] py-[12px] no-underline transition-colors hover:bg-[color-mix(in_srgb,var(--set-on-surface)_8%,var(--set-surface-container))] active:bg-[color-mix(in_srgb,var(--set-on-surface)_12%,var(--set-surface-container))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
      >
        {/* `min-w-[180px]` rather than `min-w-0`: with a shrinkable floor the
            nowrap chip would hold the row together at 360px and squeeze the
            headline into four lines. At 180px the flex line can no longer seat
            both, so the chip wraps under the copy — which is the readable
            answer on a phone and costs nothing in the desktop pane. */}
        <div className="flex min-w-[180px] flex-1 items-center gap-[12px] text-left">
          <span
            aria-hidden="true"
            className="material-symbols-rounded shrink-0 text-[var(--set-primary)]"
            style={{ fontSize: 22 }}
          >
            redeem
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-medium leading-[1.3] text-[var(--set-on-surface)]">
              {t("upgradeCard.trialBannerHeadline")}
            </div>
            <div className="text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">
              {t("upgradeCard.trialBannerSubtitle")}
            </div>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-[4px] whitespace-nowrap rounded-[8px] bg-[var(--set-primary)] px-[12px] py-[6px] text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--set-on-primary)]">
          {t("upgradeCard.startFreeTrial")}
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
        </span>
      </a>
      <SettingsGroup divided={false}>
        <div className="flex flex-col items-center gap-[16px] px-[16px] py-[24px] text-center">
          <img
            src="/clawbox-crab.png"
            alt=""
            width={64}
            height={64}
            /* The glow was `rgba(249,115,22,.5)` — the same coral the pane calls
               `--set-primary`, so it is spelled as the role. `drop-shadow` is a
               filter, but it sits on this leaf `<img>`, never on an ancestor of
               the pane, so it creates no containing block for the portalled
               factory-reset / reboot overlays. */
            className="pointer-events-none select-none"
            style={{ filter: "drop-shadow(0 0 12px color-mix(in srgb, var(--set-primary) 50%, transparent))" }}
          />
          <div>
            <h3 className="mb-[4px] text-[16px] font-medium leading-[1.3] text-[var(--set-on-surface)]">
              {t("upgradeCard.needsPaidPlan", { feature: featureName })}
            </h3>
            <p className="text-[14px] leading-[1.5] text-[var(--set-on-surface-variant)]">
              {description}
            </p>
          </div>
          <a
            href={PORTAL_DASHBOARD_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-[8px] rounded-[22px] border-none bg-[var(--set-primary)] px-[24px] text-[14px] font-medium leading-[1.2] text-[var(--set-on-primary)] no-underline transition-colors hover:bg-[color-mix(in_srgb,var(--set-on-primary)_8%,var(--set-primary))] active:bg-[color-mix(in_srgb,var(--set-on-primary)_12%,var(--set-primary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
            {t("upgradeCard.subscribeButton")}
          </a>
        </div>
      </SettingsGroup>
    </div>
  );
}
