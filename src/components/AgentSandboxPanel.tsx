"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported: the server module
// behind it reads config files and spawns processes, and a client component
// must not stand one import away from that graph (the PathGuardPanel
// precedent). What crosses this boundary is JSON over a fetch.
interface AgentSandboxStatus {
  available: boolean;
  enabled: boolean;
  known: boolean;
  mode: string | null;
  runtime: "ready" | "missing" | "unknown" | null;
  provisioning: boolean | null;
  budget: { memoryBytes: number; diskBytes: number };
}

// The modes the posture writes for the switch (config/agent-sandbox.json).
const MODE_ON = "non-main";
const MODE_OFF = "off";
// While the switch is on and the runtime is still being installed, the card
// re-reads the route this often, so "installing" turns into "on" by itself.
const POLL_MS = 15_000;

// The owner's switch for the agent tool sandbox: OFF by default until its
// cost is measured on a Nano. On, every session except the main chat runs its
// tools in a rootless Podman container. The route is owner-only and
// same-origin, because the sandbox fences the agent in.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is AgentSandboxStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as { available?: unknown; enabled?: unknown; budget?: unknown };
  if (typeof b.available !== "boolean" || typeof b.enabled !== "boolean") return false;
  const budget = b.budget as { memoryBytes?: unknown; diskBytes?: unknown } | null | undefined;
  return !!budget && typeof budget.memoryBytes === "number" && typeof budget.diskBytes === "number";
}

/** 536870912 -> "512 MB", 2147483648 -> "2 GB": the caps as the owner reads them. */
export function formatBudgetBytes(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib && bytes % gib === 0) return `${bytes / gib} GB`;
  return `${Math.round(bytes / mib)} MB`;
}

export default function AgentSandboxPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<AgentSandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The route's own sentence for a refusal, in its own words; "" for a failure
  // that had none (a network error), which draws the catalogue line alone.
  const [failed, setFailed] = useState<string | null>(null);

  // Read on mount. `alive` because the answer comes back after an await and a
  // Settings tab is closed by clicking another one.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/settings/agent-sandbox", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to say and nothing to draw: the panel stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  const waitingForRuntime = !!status && status.available && status.enabled && status.runtime !== "ready";

  // Re-read while the runtime is being installed; stops once it is ready, the
  // switch goes off, or the tab closes.
  useEffect(() => {
    if (!waitingForRuntime || busy) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch("/setup-api/settings/agent-sandbox", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // The next tick asks again.
      }
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [waitingForRuntime, busy]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/setup-api/settings/agent-sandbox", {
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

  // A Hermes edition has no OpenClaw sandbox to switch: no card at all.
  if (!status || !status.available) return null;

  const expectedMode = status.enabled ? MODE_ON : MODE_OFF;
  const pending = !busy && status.known && status.mode !== null && status.mode !== expectedMode;

  return (
    <div className="max-w-xl" data-testid="agent-sandbox-panel">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          deployed_code
        </span>
        {/* A heading, not a `label`: the switch below names itself. */}
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.agentSandbox.title")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-1 leading-relaxed">{t("settings.agentSandbox.hint")}</p>
      <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed" data-testid="agent-sandbox-limits">
        {t("settings.agentSandbox.limits", {
          memory: formatBudgetBytes(status.budget.memoryBytes),
          disk: formatBudgetBytes(status.budget.diskBytes),
        })}
      </p>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span
              className={`block text-sm font-medium ${status.enabled ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
              data-testid="agent-sandbox-state"
            >
              {t(status.enabled ? "settings.agentSandbox.on" : "settings.agentSandbox.off")}
            </span>
            {busy && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="agent-sandbox-applying">
                {t("settings.agentSandbox.applying")}
              </span>
            )}
            {!busy && waitingForRuntime && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="agent-sandbox-runtime">
                {t(
                  status.provisioning === true
                    ? "settings.agentSandbox.preparing"
                    : status.runtime === "unknown"
                      ? "settings.agentSandbox.runtimeUnknown"
                      : "settings.agentSandbox.missing",
                )}
              </span>
            )}
            {!status.known && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="agent-sandbox-store-unknown">
                {t("settings.agentSandbox.storeUnknown")}
              </span>
            )}
            {pending && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="agent-sandbox-pending">
                {t("settings.agentSandbox.pending")}
              </span>
            )}
            {failed !== null && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="agent-sandbox-failed">
                {t("settings.agentSandbox.failed")}
                {failed ? ` ${failed}` : ""}
              </span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            aria-label={t("settings.agentSandbox.title")}
            aria-busy={busy}
            // The POST writes the key and restarts the assistant — seconds on
            // a Nano — and a second write started meanwhile could land its
            // older answer last.
            disabled={busy}
            data-testid="agent-sandbox-switch"
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
