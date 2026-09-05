"use client";

import { useState } from "react";

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
  stage: "install" | "consent";
  reason: string;
}

interface PluginRepairNoticeProps {
  repair: PluginRepairInfo;
  /** Called after a repair that the device verified, so the panel can re-read. */
  onRepaired?: () => void;
  className?: string;
}

type Phase = "idle" | "working" | "failed";

export default function PluginRepairNotice({
  repair,
  onRepaired,
  className = "",
}: PluginRepairNoticeProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("idle");

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
      const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
      if (r.ok && body?.ok === true) {
        setPhase("idle");
        onRepaired?.();
        return;
      }
      setPhase("failed");
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
      <button
        type="button"
        onClick={retry}
        disabled={phase === "working"}
        data-testid={`plugin-repair-retry-${repair.pluginId}`}
        className="font-semibold text-[var(--coral)] underline underline-offset-2 disabled:opacity-60"
      >
        {phase === "working" ? t("settings.providers.repairing") : t("settings.providers.repairRetry")}
      </button>
      {phase === "failed" && (
        <span className="text-[var(--amber-ink)]">{t("settings.providers.repairFailed")}</span>
      )}
    </div>
  );
}
