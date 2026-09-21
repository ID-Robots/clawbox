"use client";

import { useT } from "@/lib/i18n";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";

interface ClawboxAiPitchCardProps {
  /** Put the ClawBox AI sign-in in front of the owner (the device-code handoff
   *  the connect panel below this card already performs). */
  onConnect: () => void;
  /** Open Settings → Local AI, where the on-device engines are installed. */
  onLocalAi: () => void;
}

/**
 * Settings → Providers, on a box that holds NO ClawBox AI credential.
 *
 * The owner's decision of 2026-09-15: a subscriber's box runs the cloud models
 * by default and only goes local when the owner says so, and a box WITHOUT a
 * subscription is pitched the subscription — "use ClawBox AI for the best
 * experience" — with the way to stay local offered beside it.
 *
 * Both halves, and in that order. The sentence this replaces lived on the
 * cloud-defaults card inside Settings → Local AI and said only "not
 * connected"; the per-model inventory rewrite deleted that card, so an
 * unlinked box said nothing at all — no pitch, no subscribe path, and nothing
 * pointing an owner who WANTS to stay local at the tab that sets it up. The
 * pitch belongs here rather than back in Local AI because this is the page the
 * provider decision is made on, and Local AI is the plain inventory the owner
 * asked for.
 *
 * NOT AMBER, and no warning icon anywhere on it. A box with no subscription is
 * not broken: it runs every one of these engines on its own disk, which is
 * what it was sold able to do. This card is an offer, and the local half says
 * so in as many words.
 */
export default function ClawboxAiPitchCard({ onConnect, onLocalAi }: ClawboxAiPitchCardProps) {
  const { t } = useT();
  return (
    <section
      data-testid="clawai-pitch-card"
      aria-labelledby="clawai-pitch-title"
      className="rounded-2xl border border-[var(--coral-bright)]/25 bg-[var(--surface-card)] p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="material-symbols-rounded text-[var(--coral-bright)] shrink-0"
          style={{ fontSize: 22 }}
        >
          auto_awesome
        </span>
        <div className="min-w-0">
          <h3 id="clawai-pitch-title" className="text-sm font-semibold text-[var(--text-primary)]">
            {t("settings.clawaiPitch.title")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("settings.clawaiPitch.body")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onConnect}
          data-testid="clawai-pitch-connect"
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer border-none"
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>link</span>
          {t("settings.clawaiPitch.connect")}
        </button>
        {/* The portal, in a tab of its own: the plans and the payment are the
            account's, not the box's, and nothing here can show them. */}
        <a
          href={PORTAL_DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="clawai-pitch-plans"
          className="inline-flex items-center gap-1 text-xs text-[var(--coral-bright)] underline underline-offset-2"
        >
          {t("settings.clawaiPitch.plans")}
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>open_in_new</span>
        </a>
      </div>

      {/* The other route, stated plainly rather than hidden behind the offer. */}
      <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-3">
        <p className="text-xs font-medium text-[var(--text-primary)]">
          {t("settings.clawaiPitch.localTitle")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          {t("settings.clawaiPitch.localBody")}
        </p>
        <button
          type="button"
          onClick={onLocalAi}
          data-testid="clawai-pitch-local"
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--coral-bright)] bg-transparent border-none p-0 cursor-pointer underline underline-offset-2"
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>memory</span>
          {t("settings.clawaiPitch.localAction")}
        </button>
      </div>
    </section>
  );
}
