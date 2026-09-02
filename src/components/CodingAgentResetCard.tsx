"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged } from "@/lib/ui-events";
import HelpTip from "./HelpTip";
import { BTN_DANGER, BTN_SECONDARY } from "./coding-agent-ui";

/** How long the confirming state stays armed. */
const CONFIRM_MS = 5_000;

/**
 * "Start over": switch the coding agent off, forget the folder, the effort, the
 * ceilings and the finished runs, and go back to the setup wizard.
 *
 * Its own component because it sits in the owner-tools row beside Test harness
 * and Clear history, not inside the settings form it undoes — and because those
 * three read as one row only if none of them owns the others' state.
 */
export default function CodingAgentResetCard({ onReset }: { onReset?: () => void }) {
  const { t } = useT();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setConfirm(false); }, CONFIRM_MS);
    setConfirm(true);
  };

  // Two taps, like every other step here that cannot be undone by pressing it
  // again. Everything it clears is re-enterable — but not by accident.
  const reset = async () => {
    if (!confirm) { arm(); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setConfirm(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/reset", { method: "POST" });
      if (!res.ok) {
        const out = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("codingAgent.resetFailed"));
      }
      notifyCodingAgentChanged();
      onReset?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.resetFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    // No heading: it said the button's own words twice. The button fills its
    // column so all three in the row are the same width, and the explanation
    // is on the question mark beside it.
    <>
      <button
        type="button"
        onClick={() => void reset()}
        disabled={busy}
        data-testid="coding-agent-reset"
        className={`${confirm ? BTN_DANGER : BTN_SECONDARY} flex-1`}
      >
        {confirm ? t("codingAgent.resetConfirm") : t("codingAgent.resetButton")}
      </button>
      <HelpTip
        text={t("codingAgent.resetHint")}
        label={t("codingAgent.resetTitle")}
        testId="coding-agent-reset-help"
      />
      {/* The host is a wrapping flex row: full-basis puts the message on its
          own line under the button instead of beside it as a third column. */}
      {error && <p className="basis-full mt-2 text-[11px] text-red-400" role="alert">{error}</p>}
    </>
  );
}
