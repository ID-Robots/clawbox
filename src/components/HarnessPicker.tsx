"use client";

import { useCallback, useEffect, useState } from "react";

interface HarnessEntry {
  id: string;
  label: string;
  healthy: boolean;
}
interface HarnessStatus {
  active: string;
  /** Optional on purpose: this is unvalidated JSON off the status route, and a
      response that omits the list must render an empty picker, not throw. */
  harnesses?: HarnessEntry[];
  /** Single-harness edition (or dual without a premium license) → no switcher. */
  locked?: boolean;
  edition?: string;
}

// Lets the user pick which agent harness (OpenClaw / Hermes) backs the device.
// Both share one identity; providers stay per-harness. Self-contained so it
// drops into Settings → System with a single import.
export default function HarnessPicker() {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/harness/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus(await res.json());
    } catch {
      setError("Could not load harness status");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(
    async (id: string) => {
      if (switching || status?.active === id) return;
      setSwitching(id);
      setError("");
      try {
        const res = await fetch("/setup-api/harness/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ harness: id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Switch failed");
        // The desktop chat resolves its harness on mount and stays mounted, so
        // a live switch wouldn't reach an already-open chat. Reload so the whole
        // desktop re-mounts against the newly-selected harness — a clean, sure
        // apply for a deliberate engine switch.
        window.location.reload();
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Switch failed");
        setSwitching(null);
      }
    },
    [switching, status],
  );

  const activeEntry = status?.harnesses?.find((h) => h.id === status.active);

  return (
    // Settings-only, and the first thing in Settings → System: a borderless
    // `--set-surface-container` group, exactly what `SettingsGroup` draws, so
    // it stops being a navy card among teal ones.
    <div className="rounded-2xl bg-[var(--set-surface-container)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-rounded text-[var(--set-primary)]" style={{ fontSize: 18 }}>
          hub
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--set-on-surface-variant)] uppercase tracking-widest m-0">
          Agent harness
        </h3>
      </div>
      <p className="text-xs text-[var(--set-on-surface-variant)] mb-3">
        The engine that runs your agent. One shared identity; each harness keeps its own providers.
      </p>
      {status?.locked ? (
        // Single-harness edition: no switcher, just a read-only badge for the
        // one agent this device runs.
        <div className="flex items-center justify-between rounded-xl border border-[var(--set-primary)] bg-[color-mix(in_srgb,var(--set-primary)_10%,transparent)] p-3">
          <span className="flex items-center gap-2">
            {/* Same dot convention as the switcher below. A fixed green read
                "online" even when the status route had just reported the one
                harness this edition has as down — and here the badge is the
                only health signal the user gets. */}
            <span
              data-testid="harness-locked-dot"
              title={activeEntry && !activeEntry.healthy ? `${activeEntry.label} is not running` : undefined}
              className={`w-2 h-2 rounded-full ${activeEntry?.healthy ? "bg-[var(--set-success)]" : "bg-[var(--set-outline)]"}`}
            />
            <span className="text-sm text-[var(--set-on-surface)] font-medium">
              {activeEntry?.label ?? status.active}
            </span>
          </span>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--set-on-surface-variant)]">
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>lock</span>
            This edition
          </span>
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-3">
        {(status?.harnesses ?? []).map((h) => {
          const active = status?.active === h.id;
          const busy = switching === h.id;
          return (
            <button
              key={h.id}
              onClick={() => select(h.id)}
              disabled={!!switching || active || !h.healthy}
              title={!h.healthy ? `${h.label} is not available on this device` : undefined}
              className={`flex items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                active
                  ? "border-[var(--set-primary)] bg-[color-mix(in_srgb,var(--set-primary)_10%,transparent)]"
                  : "border-[var(--set-outline-variant)] hover:border-[color-mix(in_srgb,var(--set-primary)_50%,transparent)] hover:bg-[var(--set-state-hover)]"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${h.healthy ? "bg-[var(--set-success)]" : "bg-[var(--set-outline)]"}`} />
                <span className="text-sm text-[var(--set-on-surface)] font-medium">{h.label}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--set-on-surface-variant)]">
                {busy ? "…" : active ? "Active" : h.healthy ? "Switch" : "Offline"}
              </span>
            </button>
          );
        })}
      </div>
      )}
      {error && <p className="text-xs text-[var(--set-error)] mt-3">{error}</p>}
    </div>
  );
}
