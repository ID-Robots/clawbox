"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// "Needs repair", with the reason and a Retry (TASK-606).
//
// A row in this state is not merely disconnected: the boot script could not
// install or consent the plugin behind it and switched that plugin OFF so the
// gateway could start at all. Without this the owner saw "Not connected" on a
// provider he had configured, with nothing to press and nothing to read — and
// before the boot script started switching plugins off, he saw a box with no
// agent for three quarters of an hour instead.
//
// ONE COMPONENT for both surfaces (Providers and Channels), so the badge cannot
// come to mean two different things in two panels.
//
// THE REASON IS THE DEVICE'S OWN SENTENCE, not a translated key: it is written
// by the boot script, in English, and says which step failed and what is likely
// behind it. Translating it would mean a key per failure and a boot script that
// knows the owner's language; the LABEL and the BUTTON are translated, which is
// what the eye reads first.

export interface PluginRepairInfo {
  pluginId: string;
  /** Mirrors `PluginRepairStage`, spelled out so this stays a client module. */
  stage: "install" | "consent" | "not-installed";
  reason: string;
  /**
   * True while the DEVICE is repairing it — the updater's after-update retry,
   * or a Retry pressed in another tab (TASK-1088). The row still needs repair
   * until that repair is proved, so the badge stays; what goes is the Retry,
   * which would start a second install over the first.
   */
  repairing?: boolean;
}

interface PluginRepairNoticeProps {
  repair: PluginRepairInfo;
  /** Called after a repair that the device verified, so the panel can re-read. */
  onRepaired?: () => void;
  /**
   * Re-read the panel WITHOUT claiming anything was repaired: while the device
   * says a repair is running, and after a Retry that did not work, so the row
   * shows the reason the device has just filed rather than the one it replaced.
   * Separate from `onRepaired` because a caller may act on that one — the
   * Channels panel drops the row there.
   */
  onRecheck?: () => void;
  className?: string;
}

type Phase = "idle" | "working" | "failed";

/** How often a row the device is repairing is re-read. */
const RECHECK_WHILE_REPAIRING_MS = 15_000;

export default function PluginRepairNotice({
  repair,
  onRepaired,
  onRecheck,
  className = "",
}: PluginRepairNoticeProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("idle");
  const deviceRepairing = repair.repairing === true;

  // Nothing else re-reads the panel on its own, and the answer this row is
  // waiting for — repaired, or re-filed with the cause — arrives on the device's
  // schedule, not on a click.
  useEffect(() => {
    if (!deviceRepairing || !onRecheck) return;
    const timer = setInterval(onRecheck, RECHECK_WHILE_REPAIRING_MS);
    return () => clearInterval(timer);
  }, [deviceRepairing, onRecheck]);

  async function retry() {
    setPhase("working");
    try {
      const r = await fetch("/setup-api/plugins/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: repair.pluginId }),
      });
      // Only an `ok: true` clears it. A 502 here is a repair that did not
      // happen — including the one the device could not verify — and the notice
      // has to stay up for it, or the owner is left believing a fix that is not
      // there.
      const body = (await r.json().catch(() => null)) as
        | { ok?: boolean; markerCleared?: boolean; code?: string }
        | null;
      if (r.ok && body?.ok === true) {
        setPhase("idle");
        // ONLY when the device also removed the record. The repair happened —
        // this is not a failure — but the row is what this notice is drawn
        // from, so telling the panel to re-read while the row is still there
        // would take the notice away and put it straight back. It stays, with
        // its Retry, until the box says the record is gone.
        if (body.markerCleared !== false) onRepaired?.();
        return;
      }
      // Another repair of this row is already running. Not a failure of this
      // press — re-read, and the row will say "Repairing…" itself.
      if (body?.code === "repair_in_progress") {
        setPhase("idle");
        onRecheck?.();
        return;
      }
      setPhase("failed");
      // The device may have filed the row again with the cause of THIS attempt
      // (a restart whose boot script switched the plugin off again does).
      onRecheck?.();
    } catch {
      setPhase("failed");
    }
  }

  return (
    <div
      data-testid={`plugin-repair-${repair.pluginId}`}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-snug ${className}`}
    >
      <span className="font-semibold text-[var(--amber-ink)]">
        {t("settings.providers.needsRepair")}
      </span>
      <span className="text-[var(--text-secondary)]">{repair.reason}</span>
      {deviceRepairing && phase !== "working" ? (
        <span
          data-testid={`plugin-repair-repairing-${repair.pluginId}`}
          className="font-semibold text-[var(--text-secondary)]"
        >
          {t("settings.providers.repairing")}
        </span>
      ) : (
        <button
          type="button"
          onClick={retry}
          disabled={phase === "working"}
          data-testid={`plugin-repair-retry-${repair.pluginId}`}
          className="font-semibold text-[var(--coral-bright)] underline underline-offset-2 disabled:opacity-60"
        >
          {phase === "working" ? t("settings.providers.repairing") : t("settings.providers.repairRetry")}
        </button>
      )}
      {phase === "failed" && !deviceRepairing && (
        <span className="text-[var(--amber-ink)]">{t("settings.providers.repairFailed")}</span>
      )}
    </div>
  );
}
