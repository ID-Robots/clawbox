import { PORTAL_SUBSCRIBE_URL } from "@/lib/max-subscription";

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
  return (
    <div className="max-w-xl">
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
            {featureName} needs a paid plan
          </h3>
          <p className="text-sm text-[var(--text-muted)] leading-relaxed">
            {description}
          </p>
        </div>
        <a
          href={PORTAL_SUBSCRIBE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer no-underline"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
          Subscribe to Pro or Max
        </a>
      </div>
    </div>
  );
}
