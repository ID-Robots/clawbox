"use client";

import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import { shellScanEn } from "@/lib/hermes-translations/en-shell-scan";

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
  /** Hermes pre-exec shell scanning. Null/absent on a harness that has none. */
  shellScan?: ShellScanRow | null;
}

interface ShellScanRow {
  state?: string;
  reason?: string;
  failOpen?: boolean;
  retrySuppressedUntil?: string | null;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * `t`, but this card never renders a raw key.
 *
 * `I18nProvider` serves `t(key) === key` until its dynamic import of the
 * catalogue resolves — and forever if that import fails, which it explicitly
 * contemplates ("the device is offline mid-update"). Everything else on this
 * card is hardcoded English and would look normal beside it, so the one
 * sentence in the product that says a security control is off would be the only
 * thing on screen reading `shellScan.offTitle`. The English table is imported
 * statically, so it cannot be the thing that failed to load.
 */
function scanCopy(t: Translate, key: string, params?: Record<string, string | number>): string {
  const translated = t(key, params);
  if (translated !== key) return translated;
  const english = shellScanEn[key] ?? key;
  return params ? english.replace(/\{(\w+)\}/g, (m, name) => String(params[name] ?? m)) : english;
}

/**
 * What to say about pre-exec shell scanning, or null when there is nothing to
 * say. Returning null for a healthy box is the point: a box whose scanner is
 * installed must not be warned at, or the warning stops meaning anything.
 *
 * `severe` separates the two live regions below. "Off" and "blocked" are a
 * security control not doing its job; "unknown" is only this box failing to
 * read its own settings.
 */
function shellScanWarning(
  scan: ShellScanRow | null | undefined,
  t: Translate,
  locale: string,
): { title: string; detail: string; severe: boolean } | null {
  if (!scan || scan.state === "on") return null;
  if (scan.state === "unknown") {
    return { title: scanCopy(t, "shellScan.unknownTitle"), detail: scanCopy(t, "shellScan.unknownDetail"), severe: false };
  }
  if (scan.reason === "disabled-by-config") {
    return { title: scanCopy(t, "shellScan.offTitle"), detail: scanCopy(t, "shellScan.disabledDetail"), severe: true };
  }
  // Upstream suppresses the re-download for 24 h after a failure, so "connect
  // it to the internet" is not the whole story and the owner has to be told.
  const until = scan.retrySuppressedUntil
    // The UI locale, not the runtime default: the rest of this sentence is
    // already in the owner's language, so the timestamp inside it has to be.
    ? ` ${scanCopy(t, "shellScan.retryAfter", { time: new Date(scan.retrySuppressedUntil).toLocaleString(locale) })}`
    : "";
  // The two outcomes are opposites, not degrees: fail-open runs the command
  // unchecked, fail-closed refuses to run it at all.
  return scan.failOpen
    ? { title: scanCopy(t, "shellScan.offTitle"), detail: `${scanCopy(t, "shellScan.missingDetail")}${until}`, severe: true }
    : { title: scanCopy(t, "shellScan.blockedTitle"), detail: `${scanCopy(t, "shellScan.blockedDetail")}${until}`, severe: true };
}

// Lets the user pick which agent harness (OpenClaw / Hermes) backs the device.
// Both share one identity; providers stay per-harness. Self-contained so it
// drops into Settings → System with a single import.
export default function HarnessPicker() {
  const { t, locale } = useT();
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
  const warning = shellScanWarning(status?.shellScan, t, locale);

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>
          hub
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest m-0">
          Agent harness
        </h3>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        The engine that runs your agent. One shared identity; each harness keeps its own providers.
      </p>
      {status?.locked ? (
        // Single-harness edition: no switcher, just a read-only badge for the
        // one agent this device runs.
        <div className="flex items-center justify-between rounded-xl border border-[var(--coral-bright)] bg-orange-500/10 p-3">
          <span className="flex items-center gap-2">
            {/* Same dot convention as the switcher below. A fixed green read
                "online" even when the status route had just reported the one
                harness this edition has as down — and here the badge is the
                only health signal the user gets. */}
            <span
              data-testid="harness-locked-dot"
              title={activeEntry && !activeEntry.healthy ? `${activeEntry.label} is not running` : undefined}
              className={`w-2 h-2 rounded-full ${activeEntry?.healthy ? "bg-emerald-400" : "bg-white/25"}`}
            />
            <span className="text-sm text-[var(--text-primary)] font-medium">
              {activeEntry?.label ?? status.active}
            </span>
          </span>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
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
      )}
      {warning && (
        <div
          data-testid="shell-scan-warning"
          role={warning.severe ? "alert" : "status"}
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3"
        >
          <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 16 }} aria-hidden="true">
            warning
          </span>
          <div className="text-xs text-[var(--text-secondary)]">
            <h4 className="text-xs font-medium text-[var(--text-primary)] m-0">{warning.title}</h4>
            <p className="m-0 mt-0.5">{warning.detail}</p>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
