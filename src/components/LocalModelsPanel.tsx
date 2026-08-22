"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalModelEntry, LocalModelsSnapshot, RunState } from "@/lib/local-models";

const KIND_LABEL: Record<LocalModelEntry["kind"], string> = {
  llm: "Language",
  tts: "Speech out",
  stt: "Speech in",
  embedding: "Memory",
};

const KIND_ICON: Record<LocalModelEntry["kind"], string> = {
  llm: "smart_toy",
  tts: "record_voice_over",
  stt: "mic",
  embedding: "database",
};

/**
 * One state, one sentence. Collapsing "not installed" into "off" is the exact
 * drift this panel exists to make visible (TASK-420: the installer announced
 * Kokoro on boxes that had never had it) — and "not on this edition" is kept
 * apart from "not installed" for the same reason: one is fixable, one is not.
 */
const RUN_LABEL: Record<RunState, string> = {
  running: "Running",
  idle: "Stopped",
  "on-demand": "On demand",
  "not-installed": "Not installed",
  "not-on-this-edition": "Not on this edition",
};

const RUN_TONE: Record<RunState, string> = {
  running: "bg-cyan-500/10 text-cyan-300 border-cyan-400/20",
  idle: "bg-white/[0.06] text-[var(--text-secondary)] border-white/10",
  "on-demand": "bg-white/[0.06] text-[var(--text-secondary)] border-white/10",
  "not-installed": "bg-amber-500/10 text-amber-300 border-amber-400/20",
  // Neutral, not amber: amber says "look at this", and there is nothing here
  // for the customer to act on.
  "not-on-this-edition": "bg-white/[0.06] text-[var(--text-muted)] border-white/10",
};

/**
 * Deliberately the same arithmetic and the same rounding rule as ClawKeep's
 * formatBytes: the two panels can end up quoting the same number (the memory
 * index, the embedding model) and must not disagree about it. Returns null
 * rather than "0 B" so an unknown figure is omitted instead of asserted.
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const RUN_STATES = Object.keys(RUN_LABEL) as RunState[];
const KINDS = Object.keys(KIND_LABEL) as LocalModelEntry["kind"][];
const CONTROLS = ["none", "user-unit", "system-unit"];

/**
 * A payload is only adopted when it is really an inventory — EVERY field the
 * render reads, not just the one it reads first. `{ "models": [] }` used to
 * pass here and then threw on `snapshot.unavailable.length` a few lines later,
 * which is the same "guard the shape, then read an unguarded sibling" mistake
 * that took the whole ClawKeep window down on TASK-398.
 *
 * The enums are checked against the lookup tables themselves rather than a
 * hand-written list, so a state added to the model but not to the copy is
 * rejected here instead of rendering as a blank pill.
 */
function isEntry(value: unknown): value is LocalModelEntry {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  for (const key of ["id", "name", "runtime", "detail"]) {
    if (typeof m[key] !== "string") return false;
  }
  if (typeof m.installed !== "boolean") return false;
  if (m.enabled !== null && typeof m.enabled !== "boolean") return false;
  for (const key of ["diskBytes", "memoryBytes"]) {
    if (m[key] !== null && typeof m[key] !== "number") return false;
  }
  return KINDS.includes(m.kind as LocalModelEntry["kind"])
    && RUN_STATES.includes(m.running as RunState)
    && CONTROLS.includes(m.control as string);
}

function isSnapshot(value: unknown): value is LocalModelsSnapshot {
  if (!value || typeof value !== "object") return false;
  const models = (value as { models?: unknown }).models;
  const unavailable = (value as { unavailable?: unknown }).unavailable;
  if (!Array.isArray(models) || !Array.isArray(unavailable)) return false;
  if (!unavailable.every(u => typeof u === "string")) return false;
  return models.every(isEntry);
}

export default function LocalModelsPanel({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<LocalModelsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // A toggle takes seconds; without this the poll below would overwrite the
  // optimistic row with the pre-toggle reading mid-flight.
  const pendingRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (pendingRef.current) return;
    try {
      const res = await fetch("/setup-api/local-models", { cache: "no-store" });
      const data = await res.json();
      if (!isSnapshot(data)) return;
      setSnapshot(data);
    } catch {
      /* keep the last good reading rather than blanking the tab */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const t = setInterval(() => { refresh().catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const toggle = useCallback(async (entry: LocalModelEntry, next: boolean) => {
    pendingRef.current = entry.id;
    setPendingId(entry.id);
    setError(null);
    try {
      const res = await fetch("/setup-api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not change that model.");
        return;
      }
      if (isSnapshot(data)) setSnapshot(data);
    } catch {
      setError("Could not reach the box to change that model.");
    } finally {
      pendingRef.current = null;
      setPendingId(null);
    }
  }, []);

  if (!snapshot) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="local-models-loading">
        {[0, 1, 2].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 animate-pulse">
            <div className="h-3 w-40 rounded bg-white/[0.08]" />
            <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Everything that can run on the box itself, and what it is doing right now. Anything shown as
        not installed is genuinely absent — it is not a setting you can switch on here.
      </p>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {snapshot.unavailable.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
          Could not read the state of: {snapshot.unavailable.join(", ")}.
        </div>
      )}

      {snapshot.models.map(entry => {
        const disk = formatBytes(entry.diskBytes);
        const memory = formatBytes(entry.memoryBytes);
        const busy = pendingId === entry.id;
        return (
          <div
            key={entry.id}
            data-testid={`local-model-${entry.id}`}
            className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
          >
            <div className="flex items-start gap-4">
              <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.06] shrink-0">
                <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 20 }} aria-hidden="true">
                  {KIND_ICON[entry.kind]}
                </span>
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{entry.name}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${RUN_TONE[entry.running]}`}>
                    {RUN_LABEL[entry.running]}
                  </span>
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">
                  {KIND_LABEL[entry.kind]} · {entry.runtime}
                </div>
                <p className="text-sm text-[var(--text-secondary)] mt-2">{entry.detail}</p>
                {(disk || memory) && (
                  <div className="flex gap-4 mt-2 text-xs text-[var(--text-muted)]">
                    {disk && <span>Disk {disk}</span>}
                    {memory && <span>Memory in use {memory}</span>}
                  </div>
                )}
                {entry.managedBy === "clawkeep" && (
                  <p className="text-xs text-[var(--text-muted)] mt-2">Managed in ClawKeep.</p>
                )}
                {entry.managedBy === "localAi" && (
                  <p className="text-xs text-[var(--text-muted)] mt-2">Managed in Settings → Local AI.</p>
                )}
              </div>
              {entry.control !== "none" && entry.enabled !== null && (
                <div className="flex items-center gap-2 shrink-0">
                  {busy && (
                    <span className="material-symbols-rounded animate-spin text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
                      progress_activity
                    </span>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-label={`${entry.name} enabled`}
                    aria-checked={entry.enabled}
                    aria-busy={busy}
                    disabled={busy}
                    onClick={() => toggle(entry, !entry.enabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                      entry.enabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${entry.enabled ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}

      <p className="text-xs text-[var(--text-muted)]">
        Turning a model off stops it now and keeps it off after a reboot.
      </p>
    </div>
  );
}
