"use client";

import {
  useEffect,
  useId,
  useReducer,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import { useT } from "@/lib/i18n";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import * as kv from "@/lib/client-kv";

// Announces account-tier transitions:
//   - upgrade (Free → Pro → Max): celebratory modal, shown once per tier
//   - downgrade to Free (paid → Free): informational "plan is now Free" modal
//   - intermediate downgrade (Max → Pro): silent
//
// Backed by client-kv so a poll re-reporting the same tier doesn't reopen
// the dialog, and so a later climb back to the same paid tier doesn't
// re-celebrate something the user already saw. A real cancel + resubscribe
// flow *does* re-celebrate, because the downgrade resets the seen marker.

const SEEN_KEY = "clawai_tier_seen";
const FREE_SEEN_VALUE = "free";

// Tier ordering. Keep aligned with normalizeClawboxAiTier on the server
// (flash = Pro plan, pro = Max plan).
const TIER_RANK: Record<string, number> = { flash: 1, pro: 2 };

function rankOf(tier: string | null | undefined): number {
  if (!tier) return 0;
  return TIER_RANK[tier] ?? 0;
}

type DialogState =
  | { kind: "upgrade"; tier: "flash" | "pro" }
  | { kind: "downgrade-free" };

type DialogAction =
  | { type: "OPEN_UPGRADE"; tier: "flash" | "pro" }
  | { type: "OPEN_DOWNGRADE" }
  | { type: "CLOSE" };

// Local reducer for the dialog's open/close lifecycle. CodeRabbit's
// review on PR #132 suggested wiring this through `useWindows.ts`,
// but that hook is purpose-built for desktop windows with z-order /
// minimize / maximize semantics — none of which apply to a transient
// centred modal. A local reducer captures the spirit of the
// "reducer pattern" coding guideline and silences the ESLint
// `set-state-in-effect` warning without forcing a fake `appId` /
// `icon` / `defaultWidth` through a window manager that has no
// business managing modals. The peer `ClawBoxLoginModal.tsx`
// follows the same shape.
function dialogReducer(
  state: DialogState | null,
  action: DialogAction,
): DialogState | null {
  switch (action.type) {
    case "OPEN_UPGRADE":
      // Latch the first transition we observe; a later effect tick
      // re-reporting the same paid tier must not bump the dialog
      // out from under the user.
      return state ?? { kind: "upgrade", tier: action.tier };
    case "OPEN_DOWNGRADE":
      return state ?? { kind: "downgrade-free" };
    case "CLOSE":
      return null;
  }
}

// Per-dialog content + presentation. Keyed by the upgrade tier
// ("flash" = Pro plan, "pro" = Max plan) or "free" for the downgrade.
// Translation keys are referenced literally here so the i18n
// invariant test can still discover them.
type ContentKey = "flash" | "pro" | "free";
type Tone = "paid" | "muted";

interface DialogContent {
  tone: Tone;
  badgeKey: string;
  headlineKey: string;
  bodyKey: string;
}

const CONTENT: Record<ContentKey, DialogContent> = {
  flash: {
    tone: "paid",
    badgeKey: "tierCelebration.proBadge",
    headlineKey: "tierCelebration.proHeadline",
    bodyKey: "tierCelebration.proBody",
  },
  pro: {
    tone: "paid",
    badgeKey: "tierCelebration.maxBadge",
    headlineKey: "tierCelebration.maxHeadline",
    bodyKey: "tierCelebration.maxBody",
  },
  free: {
    tone: "muted",
    badgeKey: "tierCelebration.freeBadge",
    headlineKey: "tierCelebration.freeHeadline",
    bodyKey: "tierCelebration.freeBody",
  },
};

export default function TierUpgradeCelebration() {
  const { tier, loading } = useClawboxLogin();
  const { t } = useT();
  const [dialog, dispatch] = useReducer(dialogReducer, null);

  useEffect(() => {
    if (loading) return;
    const seen = kv.get(SEEN_KEY);
    const currentSeenValue = tier ?? FREE_SEEN_VALUE;

    // First observation on this browser/device is a baseline, not a
    // transition. Without this guard, already-paid accounts see the
    // celebration every time this feature reaches a fresh client cache.
    if (seen === null) {
      kv.set(SEEN_KEY, currentSeenValue);
      return;
    }

    const currentRank = rankOf(tier);
    const seenRank = rankOf(seen);

    // Upgrade to a paid tier we haven't celebrated yet.
    if (currentRank > seenRank && (tier === "flash" || tier === "pro")) {
      dispatch({ type: "OPEN_UPGRADE", tier });
      return;
    }
    // Downgrade from any paid tier to Free.
    if (currentRank === 0 && seenRank > 0) {
      dispatch({ type: "OPEN_DOWNGRADE" });
      return;
    }
    // Intermediate downgrade (Max → Pro) or no-change tick: silently
    // sync `seen` so a later climb back to the same tier doesn't re-fire
    // the celebration the user already saw.
    if (seen !== currentSeenValue) kv.set(SEEN_KEY, currentSeenValue);
  }, [tier, loading]);

  if (!dialog) return null;

  const onClose = () => {
    if (dialog.kind === "upgrade") {
      kv.set(SEEN_KEY, dialog.tier);
    } else {
      kv.set(SEEN_KEY, FREE_SEEN_VALUE);
    }
    dispatch({ type: "CLOSE" });
  };

  const contentKey: ContentKey = dialog.kind === "upgrade" ? dialog.tier : "free";
  const content = CONTENT[contentKey];
  const primary = dialog.kind === "upgrade" ? (
    <button
      type="button"
      onClick={onClose}
      autoFocus
      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer w-full"
    >
      {t("tierCelebration.upgradeCta")}
    </button>
  ) : (
    <div className="flex flex-col gap-2">
      <a
        href={PORTAL_DASHBOARD_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => setTimeout(onClose, 50)}
        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer no-underline"
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
        {t("tierCelebration.resubscribe")}
      </a>
      <button
        type="button"
        onClick={onClose}
        autoFocus
        className="px-4 py-2 rounded-xl text-sm text-white/60 hover:text-white/85 hover:bg-white/[0.04] cursor-pointer"
      >
        {t("tierCelebration.freeCta")}
      </button>
    </div>
  );

  return (
    <CelebrationShell
      tone={content.tone}
      badge={t(content.badgeKey)}
      headline={t(content.headlineKey)}
      body={t(content.bodyKey)}
      onClose={onClose}
      primary={primary}
    />
  );
}

interface ShellProps {
  tone: Tone;
  badge: string;
  headline: string;
  body: string;
  primary: ReactNode;
  onClose: () => void;
}

function CelebrationShell({ tone, badge, headline, body, primary, onClose }: ShellProps) {
  // useId gives stable, collision-free IDs per dialog instance so
  // assistive tech can link aria-labelledby / aria-describedby
  // without us hand-rolling per-variant string IDs.
  const titleId = useId();
  const descriptionId = useId();

  // Esc closes — standard modal a11y. Listener mounts only while
  // the dialog is rendered (parent gates with `if (!dialog) return null`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const glowClass = tone === "paid"
    ? "drop-shadow-[0_0_18px_rgba(217,70,239,0.6)]"
    : "drop-shadow-[0_0_12px_rgba(255,255,255,0.18)]";
  const badgeClass = tone === "paid"
    ? "bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)]"
    : "bg-white/10 text-white/70 border border-white/15";

  // Close on backdrop click only. Previously the inner card stopped
  // propagation; using target === currentTarget is the same effect
  // expressed positively at the source (no stopPropagation gymnastics).
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={onOverlayClick}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1219] p-6 shadow-2xl text-center">
        <div className="flex flex-col items-center gap-4 mb-5">
          <img
            src="/clawbox-crab.png"
            alt=""
            width={72}
            height={72}
            className={"select-none pointer-events-none " + glowClass}
          />
          <span
            className={
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider " +
              badgeClass
            }
          >
            {badge}
          </span>
          <h2 id={titleId} className="text-lg font-semibold text-white">
            {headline}
          </h2>
          <p id={descriptionId} className="text-sm text-white/65 leading-relaxed">
            {body}
          </p>
        </div>
        {primary}
      </div>
    </div>
  );
}
