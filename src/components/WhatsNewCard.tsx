"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "@/lib/i18n";
import {
  displayVersion,
  hasPlanCta,
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_PLANS_URL,
  type WhatsNewState,
} from "@/lib/whats-new";

interface WhatsNewCardProps {
  state: WhatsNewState;
  /** The owner closed the card. The caller records the dismissal. */
  onDismiss: () => void;
}

/**
 * The 4.0 highlights, in the order the release notes list them. The copy is
 * taken from RELEASE-NOTES-4.0.0.md, so this list should only change when the
 * release notes do.
 */
const HIGHLIGHTS = [
  { icon: "code_blocks", title: "whatsNew.codingAgentTitle", body: "whatsNew.codingAgentBody" },
  { icon: "language", title: "whatsNew.hostnameTitle", body: "whatsNew.hostnameBody" },
  { icon: "mobile_chat", title: "whatsNew.phoneChatTitle", body: "whatsNew.phoneChatBody" },
  { icon: "tune", title: "whatsNew.modelPillsTitle", body: "whatsNew.modelPillsBody" },
] as const;

/**
 * "What's new in 4.0": a card in the desktop's top-right notice column, shown
 * after a box lands on 4.x until the owner dismisses it (TASK-1059).
 *
 * It has three parts. First the highlights. Then the docs page. Last, a plan
 * section that names only what the box's plan does not cover yet. A Max box
 * sees no plan section. A Pro box sees only the edition switch. The Hermes
 * edition is told about switching back to OpenClaw, not about switching to
 * Hermes.
 */
export default function WhatsNewCard({ state, onDismiss }: WhatsNewCardProps) {
  const { t } = useT();
  const version = displayVersion(state.version);
  const showPlan = hasPlanCta(state.cta);
  const listRef = useRef<HTMLDivElement>(null);
  const moreBelow = useMoreBelow(listRef);

  return (
    <section
      className="pointer-events-auto rounded-xl bg-[var(--bg-elevated)] border border-orange-400/25 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
      aria-labelledby="whats-new-title"
      data-testid="whats-new-card"
    >
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="w-9 h-9 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shrink-0">
          <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 20 }} aria-hidden="true">
            auto_awesome
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <h2 id="whats-new-title" className="text-sm font-semibold text-white m-0">
            {t("whatsNew.title")}
          </h2>
          {version && (
            <p className="text-xs text-white/60 mt-0.5 mb-0">{t("whatsNew.subtitle", { version })}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
          aria-label={t("whatsNew.dismiss")}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
        </button>
      </div>

      {/* The column is 320 px wide, and the longer locales wrap the highlights
          to twice the English height. A normal desktop shows the whole card.
          On a short screen the highlights scroll, and the docs link, the plan
          section and the buttons stay in reach. 350 px is the rest of the card,
          plus the column's top margin and the shelf. The desktop's scrollbar is
          nearly transparent, so while more is hidden below, the bottom edge
          fades out to show that the list scrolls. */}
      <div
        ref={listRef}
        className={`px-4 pb-2 max-h-[max(160px,calc(100dvh_-_350px))] overflow-y-auto${moreBelow ? " [mask-image:linear-gradient(to_bottom,black_calc(100%_-_40px),transparent)]" : ""}`}
        data-more-below={moreBelow ? "true" : undefined}
      >
        <ul className="list-none m-0 p-0 space-y-2.5" aria-label={t("whatsNew.highlightsLabel")}>
          {HIGHLIGHTS.map((item) => (
            <li key={item.title} className="flex items-start gap-2.5">
              <span
                className="material-symbols-rounded text-orange-300/90 shrink-0 mt-px"
                style={{ fontSize: 16 }}
                aria-hidden="true"
              >
                {item.icon}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white/90">{t(item.title)}</div>
                <div className="text-[11px] leading-snug text-white/60">{t(item.body)}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="px-4 pt-1">
        <a
          href={WHATS_NEW_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-orange-300 hover:text-orange-200 no-underline"
        >
          {t("whatsNew.readMore")}
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
        </a>
      </div>

      {showPlan && (
        <div className="mx-4 mt-3 rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/10 px-3 py-2" data-testid="whats-new-plan">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-fuchsia-100">
            <span className="material-symbols-rounded text-fuchsia-300" style={{ fontSize: 14 }} aria-hidden="true">
              workspace_premium
            </span>
            {t("whatsNew.planTitle")}
          </div>
          <ul className="list-none m-0 mt-1 p-0 space-y-0.5 text-[11px] leading-snug text-fuchsia-50/85">
            {state.cta.paidFeatures && <li>{t("whatsNew.planPaidFeatures")}</li>}
            {state.cta.editionSwitch === "hermes" && <li>{t("whatsNew.planSwitchToHermes")}</li>}
            {state.cta.editionSwitch === "openclaw" && <li>{t("whatsNew.planSwitchToOpenclaw")}</li>}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 pt-3 pb-3">
        {showPlan && (
          <a
            href={WHATS_NEW_PLANS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold transition-colors no-underline"
          >
            {t("whatsNew.seePlans")}
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
          </a>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className={`${showPlan ? "" : "flex-1 "}px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors cursor-pointer border-none`}
        >
          {t("whatsNew.gotIt")}
        </button>
      </div>
    </section>
  );
}

/**
 * Is part of this scroll box hidden below its bottom edge? This is checked on
 * scroll and whenever the box or the window changes size.
 */
function useMoreBelow(ref: RefObject<HTMLDivElement | null>): boolean {
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [ref]);
  return moreBelow;
}
