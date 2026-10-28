"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { dispatchOpenSettingsSection, onStandaloneAppPage, standaloneSettingsHref } from "@/lib/ui-events";

/**
 * The configure route's refusals about the ClawBox AI credential slot, and
 * the hook's own give-up, mapped to what the panel says in the owner's
 * language. The route's English sentence stays the fallback for any other code.
 */
export const CLAWAI_SLOT_ERROR_KEYS: Readonly<Record<string, string>> = {
  clawai_slot_owner_key: "ai.clawaiSlot.ownerKeyError",
  clawai_slot_conflict: "ai.clawaiSlot.conflictError",
  clawai_slot_backup_failed: "ai.clawaiSlot.backupError",
  clawai_configuring_timeout: "ai.clawaiSlot.timeoutError",
};

/** The profile id the slot is, when a refusal does not name it. */
const DEFAULT_PROFILE_ID = "deepseek:default";

type SlotState = "free" | "clawai" | "stale" | "owner-key";

/**
 * Open Settings → Providers on ClawBox AI's panel. On the desktop that is a
 * window of its own (the same handoff the desktop's ClawBox AI offer makes);
 * on the setup wizard and on a standalone app page nothing listens for that,
 * so the link navigates — answered `false` to let it.
 */
function openProvidersOnDesktop(): boolean {
  if (typeof window === "undefined" || onStandaloneAppPage() || window.location.pathname.startsWith("/setup")) return false;
  const w = window as Window & { __clawboxPendingAiProvider?: string };
  w.__clawboxPendingAiProvider = "clawai";
  window.dispatchEvent(new CustomEvent("clawbox:select-ai-provider", { detail: { providerId: "clawai" } }));
  dispatchOpenSettingsSection("ai");
  return true;
}

interface ClawaiSlotNoticeProps {
  /** Inside Settings → Providers already: no link to it. */
  embedded: boolean;
  /** Changed whenever the slot is worth reading again — a refusal just arrived. */
  refreshKey: number;
  /** The slot was cleared; the host drops the refusal it is showing and says so. */
  onRemoved?: () => void;
}

/**
 * What holds the ClawBox AI slot when it is not ClawBox AI's to take — the
 * owner's own DeepSeek key, or an old sign-in — and the one button that
 * clears it (`POST /setup-api/ai-models/clawai/slot`, which keeps a copy).
 * Renders nothing while the slot is free, so it can sit under the ClawBox AI
 * panel on every box.
 */
export default function ClawaiSlotNotice({ embedded, refreshKey, onRemoved }: ClawaiSlotNoticeProps) {
  const { t } = useT();
  const [slot, setSlot] = useState<{ state: SlotState; profileId: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/ai-models/clawai/slot", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { state?: unknown; profileId?: unknown } | null) => {
        if (!data || typeof data.state !== "string") return;
        setSlot({
          state: data.state as SlotState,
          profileId: typeof data.profileId === "string" && data.profileId ? data.profileId : DEFAULT_PROFILE_ID,
        });
      })
      .catch(() => {
        // Offline or mid-restart: say nothing rather than guess at the slot.
      });
    return () => controller.abort();
  }, [refreshKey]);

  // A new refusal is a new question: the last removal's answer is not about it.
  useEffect(() => {
    setFailed(false);
  }, [refreshKey]);

  const remove = useCallback(async () => {
    setRemoving(true);
    setFailed(false);
    try {
      const res = await fetch("/setup-api/ai-models/clawai/slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove" }),
      });
      const data = await res.json().catch(() => ({})) as { removed?: unknown; state?: unknown };
      if (res.ok && data.state === "free") {
        // Nothing left to show here: the host says it was removed.
        setSlot((current) => (current ? { ...current, state: "free" } : current));
        onRemoved?.();
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setRemoving(false);
    }
  }, [onRemoved]);

  if (!slot || (slot.state !== "owner-key" && slot.state !== "stale")) return null;

  return (
    <div
      data-testid="clawai-slot-notice"
      className="mt-3 px-3.5 py-2.5 rounded-lg text-xs leading-relaxed bg-amber-400/10 text-amber-300 border border-amber-400/20"
    >
      <p>
        {t(slot.state === "owner-key" ? "ai.clawaiSlot.ownerKeyNotice" : "ai.clawaiSlot.staleNotice", {
          profileId: slot.profileId,
        })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="clawai-slot-remove"
          onClick={() => void remove()}
          disabled={removing}
          className="px-3 py-1.5 rounded-md border border-amber-400/40 text-amber-200 hover:bg-amber-400/10 disabled:opacity-60"
        >
          {removing ? t("ai.clawaiSlot.removing") : t("ai.clawaiSlot.remove")}
        </button>
        {!embedded && (
          <a
            href={standaloneSettingsHref("ai")}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              if (openProvidersOnDesktop()) event.preventDefault();
            }}
            data-testid="clawai-slot-open-providers"
            className="underline text-amber-200"
          >
            {t("ai.clawaiSlot.openProviders")}
          </a>
        )}
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-red-400">
          {t("ai.clawaiSlot.removeFailed")}
        </p>
      )}
    </div>
  );
}
