"use client";

import { useState } from "react";

import DeviceCodeCard from "./DeviceCodeCard";
import FreeTierUpgradeCard from "./FreeTierUpgradeCard";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";
import { readStoredUiTier } from "@/lib/clawbox-ai-tiers";
import { useT } from "@/lib/i18n";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { isPaidPlan, type PaidFeature, type PlanGate } from "@/lib/paid-plan-gate";
import type { ClawboxLoginState } from "@/lib/use-clawbox-login";

/**
 * The paid-plan gate, as the owner meets it: on the FIRST step of the Coding
 * Agent and Memory Shard wizards, and as one line on each feature's settings
 * page. Owner's decision, 2026-09-14.
 *
 * ONE component for both features because there is one answer to give. What
 * differs between them is two catalogue keys — the name and the description —
 * which is why {@link FEATURE_KEYS} is a table and not a branch.
 *
 * Three faces, and they are not the same refusal:
 *
 * - NOT CONNECTED — this box has no ClawBox AI account at all. Nothing to
 *   upgrade yet, so the answer is the device-code handoff the setup wizard and
 *   the Providers page already run (`useClawaiDeviceLogin`), not a link to a
 *   portal page that cannot reach this device.
 * - FREE — there is an account and it does not pay for this. That IS the
 *   upgrade card, the same one Remote Control shows.
 * - PAID — nothing at all; the wizard is unchanged.
 *
 * The server refuses the same three states in `coding-agent/enable` and
 * `clawkeep/memory/enable`; this is the half that stops the owner pressing a
 * button that was always going to bounce.
 */

/** The face to draw, derived from the login poll and nothing else. */
export type PaidGateFace = "loading" | "connect" | "upgrade" | "satisfied";

/**
 * How often a wizard sitting behind the gate re-asks what plan the box is on.
 *
 * Faster than `useClawboxLogin`'s 30 s default, and for the same reason the
 * ClawKeep overlay polls at 5 s: the two things that clear this gate — pairing
 * the box through the card below, and subscribing in another tab — both
 * finish somewhere else, and half a minute of a screen that has not noticed is
 * how an owner concludes it did not work. The route the poll hits caches the
 * portal's answer server-side, so the cost is a local request.
 */
export const PAID_GATE_POLL_MS = 5_000;

/**
 * `loading` is the poll's own first tick, and is deliberately NOT treated as
 * "no plan": the hook starts every mount at `loggedIn: false` and a gate that
 * read that as Free would flash an upgrade card at a Max subscriber on every
 * open. `tier !== null` is the paid test the hook's own docblock names.
 */
export function paidGateFace(login: ClawboxLoginState): PaidGateFace {
  if (login.loading) return "loading";
  if (!login.loggedIn) return "connect";
  return isPaidPlan(login.tier) ? "satisfied" : "upgrade";
}

const FEATURE_KEYS: Record<PaidFeature, { name: string; description: string }> = {
  coding_agent: {
    name: "paidGate.featureCodingAgent",
    description: "paidGate.codingAgentDescription",
  },
  memory_shard: {
    name: "paidGate.featureMemoryShard",
    description: "paidGate.memoryShardDescription",
  },
};

export default function PaidFeatureGate({
  feature,
  login,
}: {
  feature: PaidFeature;
  /** The caller's own `useClawboxLogin()` state — it needs the same answer to
   *  disable its button, and two polls for one question would be two. */
  login: ClawboxLoginState;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The handoff finished and the poll has not caught up yet.
   *
   * Without this the card drops straight back to its "Connect" button for a
   * few seconds after a pairing that WORKED — which reads as a failure. It
   * clears itself: the next poll either satisfies the gate (this whole card
   * goes) or reveals that the account just connected is on the Free plan (the
   * upgrade face), and both are answers.
   */
  const [connected, setConnected] = useState(false);
  const face = paidGateFace(login);

  const clawaiLogin = useClawaiDeviceLogin({
    scope: "primary",
    // The tier the connect flow last pre-selected, exactly as the Providers
    // panel resolves it. Choosing one here would either downgrade a Max
    // subscriber's badge or 402 a Pro one.
    getTier: () => readStoredUiTier(),
    onStart: () => setError(null),
    onBusyChange: setBusy,
    onComplete: () => {
      clawaiLogin.reset();
      setConnected(true);
    },
    onError: setError,
  });

  const name = t(FEATURE_KEYS[feature].name);

  if (face === "satisfied") return null;

  if (face === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("paidGate.loading")}
        data-testid="paid-gate"
        data-face="loading"
        className="max-w-xl flex items-center justify-center py-10 text-[var(--text-muted)]"
      >
        <span
          className="material-symbols-rounded motion-safe:animate-spin"
          style={{ fontSize: 24 }}
          aria-hidden="true"
        >
          progress_activity
        </span>
      </div>
    );
  }

  if (face === "upgrade") {
    return (
      <div data-testid="paid-gate" data-face="upgrade">
        <FreeTierUpgradeCard featureName={name} description={t(FEATURE_KEYS[feature].description)} />
      </div>
    );
  }

  return (
    <div data-testid="paid-gate" data-face="connect" className="max-w-xl">
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 flex flex-col items-center text-center gap-4">
        <img
          src="/clawbox-crab.png"
          alt=""
          width={48}
          height={48}
          className="select-none pointer-events-none drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]"
        />
        <div>
          <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
            {t("paidGate.signInTitle")}
          </h3>
          {/* The one line the brief asks for: WHICH plan, and for WHAT. */}
          <p className="text-sm text-[var(--text-muted)] leading-relaxed">
            {t("paidGate.signInBody", { feature: name })}
          </p>
        </div>

        {connected ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="paid-gate-connected"
            className="text-xs text-[var(--text-muted)]"
          >
            {t("paidGate.loading")}
          </p>
        ) : clawaiLogin.deviceCode && clawaiLogin.verificationUrl ? (
          <div className="w-full">
            <DeviceCodeCard
              code={clawaiLogin.deviceCode}
              verificationUrl={clawaiLogin.verificationUrl}
              polling={clawaiLogin.polling}
              onNewCode={() => void clawaiLogin.start()}
              testId="paid-gate-device"
              actions={
                <button
                  type="button"
                  onClick={() => clawaiLogin.reset()}
                  data-testid="paid-gate-connect-cancel"
                  className="bg-transparent border-none text-[var(--text-muted)] hover:text-white text-xs underline cursor-pointer p-0"
                >
                  {t("paidGate.signInCancel")}
                </button>
              }
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void clawaiLogin.start()}
            disabled={busy}
            data-testid="paid-gate-connect-start"
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer disabled:opacity-60 disabled:cursor-default"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">key</span>
            {busy ? t("paidGate.signInStarting") : t("paidGate.signInButton")}
          </button>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-300" data-testid="paid-gate-connect-error">{error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The settings-page half: one line saying the plan does not cover this
 * feature, with the way out beside it.
 *
 * Drawn from the STATUS payload's `planGate` rather than from the login poll,
 * because a settings page already has the box's own answer in hand and the
 * server's reading is the one the button will be judged by. Nothing at all is
 * drawn when the gate is satisfied, or when the server is older than it.
 */
export function PaidPlanNotice({ gate }: { gate?: PlanGate | null }) {
  const { t } = useT();
  if (!gate || !gate.required || gate.satisfied) return null;
  return (
    <p
      data-testid="paid-plan-notice"
      className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-amber-300/90"
    >
      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">workspace_premium</span>
      {t("paidGate.requiresPlan")}
      <a
        href={PORTAL_DASHBOARD_URL}
        target="_blank"
        rel="noreferrer"
        className="underline text-amber-200 hover:text-amber-100"
      >
        {t("paidGate.upgradeLink")}
      </a>
    </p>
  );
}
