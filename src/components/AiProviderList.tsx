"use client";

import { useCallback, useState } from "react";
import AIProviderIcon from "./AIProviderIcon";
import { useProviderStatus } from "@/hooks/useProviderStatus";
import type { ProviderStatusRow } from "@/lib/provider-status";

/**
 * The providers the owner has connected — cloud and on-device — each row with
 * its state, whether it is the default, and a switch that takes it out of
 * routing without touching its credential. Providers without a sign-in are
 * not listed; connecting one is the panel below this list.
 *
 * WHY A SWITCH AND NOT "DISCONNECT": a disabled provider keeps its key (or its
 * OAuth grant, which has no re-auth path in this UI) and simply stops being
 * offered to the chat and the fallback chain. The one thing it can never do is
 * disable the provider that is currently the default — the switch is locked
 * with a hint instead, so nothing here re-routes the chat behind the owner's
 * back. Both rules live in the route (`/setup-api/providers/enabled`); this
 * component only reflects them.
 */

/** The `enabled` field is new; a box on an older build answers without it. */
type Row = ProviderStatusRow & { enabled?: boolean };

const STATE_WORD: Record<ProviderStatusRow["state"], string> = {
  connected: "Connected",
  disconnected: "Not connected",
  "needs-reauth": "Needs sign-in again",
  unknown: "Could not be read",
};

export default function AiProviderList({
  onOpen,
  filter,
}: {
  /** Open the tab that configures this row: cloud sign-in or the local model. */
  onOpen?: (tab: "cloud" | "local") => void;
  /** Show only the providers a tab owns: cloud sign-ins, or the on-device engines. */
  filter?: "cloud" | "local";
}) {
  const { summary, loading, error, settingDefault, defaultError, setDefault, refresh } = useProviderStatus();
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const setEnabled = useCallback(async (row: Row, enabled: boolean) => {
    setToggling(row.id);
    setToggleError(null);
    try {
      const res = await fetch("/setup-api/providers/enabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.id, enabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
      }
      refresh();
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : "Could not change the provider");
    } finally {
      setToggling(null);
    }
  }, [refresh]);

  // Only providers that actually hold a sign-in belong here: this list is
  // about which of the owner's providers answer, in what order, and which are
  // switched off. Connecting a new one is the panel below. A provider whose
  // sign-in needs refreshing is still theirs and stays listed.
  const rows = ((summary?.providers ?? []) as Row[]).filter((row) =>
    (row.state === "connected" || row.state === "needs-reauth")
    && (!filter || (filter === "local" ? row.section === "localAi" : row.section !== "localAi")),
  );

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="ai-provider-list">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {filter === "local" ? "On this box" : filter === "cloud" ? "Cloud providers" : "Providers"}
        </label>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-4 leading-relaxed">
        The default answers first; a switched-off provider keeps its sign-in but is never used.
      </p>

      {error && (
        <div role="alert" className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
          The provider list could not be read from the box. Showing the last known state.
        </div>
      )}
      {(defaultError || toggleError) && (
        <div role="alert" className="mb-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
          {defaultError ?? toggleError}
        </div>
      )}

      {loading ? (
        <div className="space-y-2" data-testid="ai-provider-list-loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-xl bg-white/[0.04] animate-pulse" />
          ))}
        </div>
      ) : (
        <ul className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]">
          {rows.map((row) => {
            const enabled = row.enabled !== false;
            const busy = toggling === row.id || settingDefault === row.id;
            const canMakeDefault = enabled && row.state === "connected" && !row.isDefault;
            return (
              <li key={row.id} className="flex items-center gap-3 px-3 py-2.5" data-testid={`ai-provider-${row.id}`}>
                <button
                  type="button"
                  onClick={() => onOpen?.(row.section === "localAi" ? "local" : "cloud")}
                  className="flex items-center gap-3 min-w-0 flex-1 text-left bg-transparent border-none cursor-pointer"
                >
                  <span className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-white/[0.06] ${enabled ? "" : "opacity-40"}`}>
                    <AIProviderIcon provider={row.id} size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className={`text-sm font-medium truncate ${enabled ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>
                        {row.label}
                      </span>
                      {row.isDefault && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40" data-testid={`ai-provider-default-${row.id}`}>
                          Default
                        </span>
                      )}
                    </span>
                    <span className={`block text-[11px] truncate ${
                      row.state === "connected" ? "text-emerald-400" : row.state === "needs-reauth" ? "text-amber-300" : "text-[var(--text-muted)]"
                    }`}>
                      {enabled ? STATE_WORD[row.state] : "Switched off"}
                    </span>
                  </span>
                </button>

                {canMakeDefault && (
                  <button
                    type="button"
                    onClick={() => void setDefault(row.id)}
                    disabled={busy}
                    data-testid={`ai-provider-make-default-${row.id}`}
                    className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 shrink-0"
                  >
                    Make default
                  </button>
                )}

                {/* The default cannot be switched off — the hint says what to do instead. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`Enable ${row.label}`}
                  aria-busy={busy}
                  disabled={busy || row.isDefault}
                  title={row.isDefault ? "Make another provider the default first." : undefined}
                  onClick={() => void setEnabled(row, !enabled)}
                  data-testid={`ai-provider-switch-${row.id}`}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${
                    enabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                  }`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
              {filter === "local" ? "No on-device model is set up yet." : "No provider is connected yet — connect one below."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
