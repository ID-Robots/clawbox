"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported: the server module
// behind it reads config files and spawns processes, and a client component
// must not stand one import away from that graph (the PathGuardPanel
// precedent). What crosses this boundary is JSON over a fetch.
interface ComputerUseStatus {
  supported: boolean;
  /** The stored decision; null = unreadable (or no leg on this edition). */
  state: "on" | "off" | "unmanaged" | null;
  /** What the decision means for the agent; null = unknown. */
  enabled: boolean | null;
}

// The owner's switch for Hermes' built-in computer_use toolset (desktop
// control), src/lib/computer-use-switch.ts. DORMANT: the route answers 404
// unless CLAWBOX_COMPUTER_USE_SETTING=1, and a 404 draws nothing. On the
// OpenClaw edition there is no leg, so the card says so instead of offering a
// switch that would do nothing.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is ComputerUseStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as { supported?: unknown; state?: unknown; enabled?: unknown };
  return typeof b.supported === "boolean"
    && (b.state === null || b.state === "on" || b.state === "off" || b.state === "unmanaged")
    && (b.enabled === null || typeof b.enabled === "boolean");
}

const STATE_KEY = {
  on: "settings.computerUse.on",
  off: "settings.computerUse.off",
  unmanaged: "settings.computerUse.default",
} as const;

export default function ComputerUsePanel() {
  const { t } = useT();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The route's own sentence for a refusal; "" for a failure that had none.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/settings/computer-use", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to say and nothing to draw: the panel stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/setup-api/settings/computer-use", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body: unknown = await r.json().catch(() => null);
      // A 502 carries the re-read state beside its error: the switch IS saved.
      if (isStatus(body)) setStatus(body);
      if (!r.ok) {
        const error = (body as { error?: unknown } | null)?.error;
        setFailed(typeof error === "string" ? error : "");
      }
    } catch {
      setFailed("");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const on = status.enabled === true;

  return (
    <div className="max-w-xl" data-testid="computer-use-panel">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          mouse
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.computerUse.title")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{t("settings.computerUse.hint")}</p>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        {!status.supported ? (
          <p className="px-3 py-3 text-sm text-[var(--text-secondary)]" data-testid="computer-use-unsupported">
            {t("settings.computerUse.unsupported")}
          </p>
        ) : (
          <div className="flex items-start gap-3 px-3 py-3">
            <span className="flex-1 min-w-0">
              <span
                className={`block text-sm font-medium ${status.state === "off" ? "text-[var(--amber-ink)]" : "text-[var(--text-primary)]"}`}
                data-testid="computer-use-state"
              >
                {t(status.state ? STATE_KEY[status.state] : "settings.computerUse.unknown")}
              </span>
              {busy && (
                <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="computer-use-applying">
                  {t("settings.computerUse.applying")}
                </span>
              )}
              {failed !== null && (
                <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="computer-use-failed">
                  {t("settings.computerUse.failed")}
                  {failed ? ` ${failed}` : ""}
                </span>
              )}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={t("settings.computerUse.title")}
              aria-busy={busy}
              // The POST re-runs the Hermes registration under its config lock
              // and may restart the messaging gateway — seconds on an Orin — and
              // a second write started meanwhile could land its older answer last.
              disabled={busy}
              data-testid="computer-use-switch"
              onClick={() => void toggle(!on)}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`}
                aria-hidden="true"
              />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
