"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported: the server module
// behind it reads config files and spawns processes, and a client component
// must not stand one import away from that graph (the BackgroundJobsPanel
// precedent). What crosses this boundary is JSON over a fetch.
interface PathGuardStatus {
  enabled: boolean;
  loaded: boolean | null;
}

// The owner's switch for the protected-path guard (TASK-1661): on by default,
// it stops the agent from deleting, moving, overwriting or truncating the
// ClawBox tree and the local models (TASK-605). The route is owner-only and
// same-origin, because the guard protects the box FROM the agent.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is PathGuardStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as { enabled?: unknown };
  return typeof b.enabled === "boolean";
}

export default function PathGuardPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<PathGuardStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The route's own sentence for a refusal, in its own words; "" for a failure
  // that had none (a network error), which draws the catalogue line alone.
  const [failed, setFailed] = useState<string | null>(null);

  // Read once, on mount. `alive` because the answer comes back after an await
  // and a Settings tab is closed by clicking another one.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/settings/path-guard", { cache: "no-store" });
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
      const r = await fetch("/setup-api/settings/path-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body: unknown = await r.json().catch(() => null);
      // A 502 carries the re-read state beside its error: the switch IS
      // saved, and the card draws that rather than the state it started from.
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

  return (
    <div className="max-w-xl" data-testid="path-guard-panel">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          shield_lock
        </span>
        {/* A heading, not a `label`: the switch below names itself. */}
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.pathGuard.title")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{t("settings.pathGuard.hint")}</p>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span
              className={`block text-sm font-medium ${status.enabled ? "text-[var(--text-primary)]" : "text-[var(--amber-ink)]"}`}
              data-testid="path-guard-state"
            >
              {t(status.enabled ? "settings.pathGuard.on" : "settings.pathGuard.off")}
            </span>
            {busy && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="path-guard-restarting">
                {t("settings.pathGuard.applying")}
              </span>
            )}
            {failed !== null && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="path-guard-failed">
                {t("settings.pathGuard.failed")}
                {failed ? ` ${failed}` : ""}
              </span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            aria-label={t("settings.pathGuard.title")}
            aria-busy={busy}
            // The POST writes the key, rewrites each harness's config and
            // restarts the assistant — seconds on an Orin — and a second write
            // started meanwhile could land its older answer last.
            disabled={busy}
            data-testid="path-guard-switch"
            onClick={() => void toggle(!status.enabled)}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.enabled ? "left-[22px]" : "left-0.5"}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
