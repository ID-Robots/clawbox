"use client";

import { useCallback, useEffect, useState } from "react";

interface HarnessEntry {
  id: string;
  label: string;
  healthy: boolean;
}
interface HarnessStatus {
  active: string;
  harnesses: HarnessEntry[];
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
    [switching, status, load],
  );

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>
          hub
        </span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          Agent harness
        </label>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        The engine that runs your agent. One shared identity; each harness keeps its own providers.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {(status?.harnesses ?? []).map((h) => {
          const active = status?.active === h.id;
          const busy = switching === h.id;
          return (
            <button
              key={h.id}
              onClick={() => select(h.id)}
              disabled={!!switching || active}
              className={`flex items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                active
                  ? "border-[var(--coral-bright)] bg-orange-500/10"
                  : "border-[var(--border-subtle)] hover:border-[var(--coral-bright)]/50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${h.healthy ? "bg-emerald-400" : "bg-white/25"}`} />
                <span className="text-sm text-[var(--text-primary)] font-medium">{h.label}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {busy ? "…" : active ? "Active" : h.healthy ? "Switch" : "Offline"}
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
