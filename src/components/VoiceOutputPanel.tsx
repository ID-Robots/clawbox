"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  VoiceChoice,
  VoiceEngine,
  VoiceEngineId,
  VoiceOutputStatus,
} from "@/lib/voice-output";

const CHOICES: { id: VoiceChoice; title: string; blurb: string }[] = [
  {
    id: "auto",
    title: "Auto",
    blurb: "Let ClawBox choose. It prefers the cloud voice and speaks on the box when the cloud cannot.",
  },
  {
    id: "local",
    title: "On this box",
    blurb: "Speak with the on-device voice. Nothing to be spoken leaves the box unless it cannot speak at all.",
  },
  {
    id: "cloud",
    title: "ClawBox cloud",
    blurb: "Speak with the cloud voice. The words to be spoken leave this box.",
  },
];

const ENGINE_ORDER: VoiceEngineId[] = ["local", "cloud"];

function isEngine(value: unknown): value is VoiceEngine {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (!ENGINE_ORDER.includes(e.id as VoiceEngineId)) return false;
  if (typeof e.label !== "string" || typeof e.detail !== "string") return false;
  if (e.providerId !== null && typeof e.providerId !== "string") return false;
  return typeof e.configured === "boolean"
    && typeof e.proven === "boolean"
    && typeof e.usable === "boolean";
}

/**
 * An attempt is only adopted when every field the list below reads is really
 * there. `attempts: [null]` used to pass the array check and then throw on
 * `attempt.engine` one render later — the same guard-the-envelope-then-read-a-
 * sibling mistake this validator exists to prevent.
 */
function isAttempt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.providerId !== "string") return false;
  if (a.engine !== null && !ENGINE_ORDER.includes(a.engine as VoiceEngineId)) return false;
  if (typeof a.ok !== "boolean") return false;
  if (a.message !== null && typeof a.message !== "string") return false;
  return a.latencyMs === null || typeof a.latencyMs === "number";
}

/**
 * Validate every field the render reads, not just the first one.
 *
 * `{ engines: [] }` passing here and throwing one render later on
 * `status.choice` is the same mistake that took the whole ClawKeep window down
 * on TASK-398 and that CodeRabbit caught again on the Local Models tab: a panel
 * that cannot read the box must keep its last good reading, never take the
 * window with it.
 */
export function isVoiceStatus(value: unknown): value is VoiceOutputStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (!["auto", "local", "cloud"].includes(s.choice as string)) return false;
  if (!Array.isArray(s.engines) || !s.engines.every(isEngine)) return false;
  if (s.activeProviderId !== null && typeof s.activeProviderId !== "string") return false;
  if (s.activeEngine !== null && !ENGINE_ORDER.includes(s.activeEngine as VoiceEngineId)) return false;
  if (s.preferredEngine !== null && !ENGINE_ORDER.includes(s.preferredEngine as VoiceEngineId)) return false;
  if (typeof s.drifted !== "boolean") return false;
  if (s.warning !== null && typeof s.warning !== "string") return false;
  const last = s.lastCheck;
  if (last !== null) {
    if (!last || typeof last !== "object") return false;
    const c = last as Record<string, unknown>;
    if (typeof c.at !== "number" || typeof c.ok !== "boolean") return false;
    if (!Array.isArray(c.attempts) || !c.attempts.every(isAttempt)) return false;
    // Rendered directly when no engine matched, so an unvalidated value shows
    // the customer the literal word "undefined".
    if (c.servedByProviderId !== null && typeof c.servedByProviderId !== "string") return false;
    if (c.servedEngine !== null && !ENGINE_ORDER.includes(c.servedEngine as VoiceEngineId)) return false;
    if (c.message !== null && typeof c.message !== "string") return false;
  }
  return true;
}

function checkedAt(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return "";
  }
}

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function VoiceOutputPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<VoiceOutputStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"select" | "check" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/tts", { cache: "no-store" });
      const data = await res.json();
      if (!isVoiceStatus(data)) return;
      setStatus(data);
    } catch {
      /* keep the last good reading rather than blanking the panel */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
  }, [active, load]);

  const post = useCallback(async (body: Record<string, unknown>, kind: "select" | "check") => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch("/setup-api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not change the voice.");
        return;
      }
      if (isVoiceStatus(data)) setStatus(data);
    } catch {
      setError("Could not reach the box.");
    } finally {
      setBusy(null);
    }
  }, []);

  if (!status) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="voice-output-loading">
        {[0, 1, 2].map(i => (
          <div key={i} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 animate-pulse">
            <div className="h-3 w-40 rounded bg-white/[0.08]" />
            <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
          </div>
        ))}
      </div>
    );
  }

  const engineById = (id: VoiceEngineId | null) =>
    id ? status.engines.find(e => e.id === id) ?? null : null;
  const speaking = engineById(status.activeEngine);
  const preferred = engineById(status.preferredEngine);
  const last = status.lastCheck;
  const servedEngine = engineById(last?.servedEngine ?? null);
  const warning = status.warning;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Who speaks when your ClawBox talks back. Whatever you pick here, the box tells you which
        voice actually answered — a choice that quietly does something else is the thing this
        setting exists to prevent.
      </p>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div
        data-testid="voice-speaking-now"
        className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
      >
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Speaking now</div>
        <div className="text-sm font-semibold text-[var(--text-primary)] mt-1">
          {speaking ? speaking.label : "No voice is selected on this box."}
        </div>
        {status.drifted && preferred && (
          <p className="text-sm text-amber-200 mt-2" data-testid="voice-drift">
            Your choice would use {preferred.label}. Pick it again to move this box over.
          </p>
        )}
        {warning && (
          <p role="alert" className="text-sm text-amber-200 mt-2" data-testid="voice-cloud-warning">
            ⚠️ {warning}
          </p>
        )}
      </div>

      <div role="radiogroup" aria-label="Voice output" className="space-y-3">
        {CHOICES.map(choice => {
          const selected = status.choice === choice.id;
          const engine = choice.id === "auto" ? null : engineById(choice.id as VoiceEngineId);
          const unavailable = engine !== null && !engine.usable;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={unavailable || busy !== null}
              disabled={busy !== null}
              data-testid={`voice-choice-${choice.id}`}
              onClick={() => post({ action: "select", choice: choice.id }, "select")}
              className={`w-full text-left rounded-2xl border p-5 transition-colors cursor-pointer disabled:opacity-60 ${
                selected
                  ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/[0.08]"
                  : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-[var(--text-primary)]">{choice.title}</span>
                {selected && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-cyan-500/10 text-cyan-300 border-cyan-400/20">
                    Chosen
                  </span>
                )}
                {unavailable && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-500/10 text-amber-300 border-amber-400/20">
                    Not available
                  </span>
                )}
                {engine?.proven && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-white/[0.06] text-[var(--text-secondary)] border-white/10">
                    Proven on this box
                  </span>
                )}
              </div>
              <p className="text-sm text-[var(--text-secondary)] mt-2">{choice.blurb}</p>
              {engine && (
                <p className="text-xs text-[var(--text-muted)] mt-2">{engine.detail}</p>
              )}
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">Voice check</div>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Speaks one short phrase for real and reports which voice produced it.
            </p>
          </div>
          <button
            type="button"
            data-testid="voice-check"
            disabled={busy !== null}
            aria-busy={busy === "check"}
            onClick={() => post({ action: "check" }, "check")}
            className="rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--text-primary)] cursor-pointer disabled:opacity-50 shrink-0"
          >
            {busy === "check" ? "Checking…" : "Check voice"}
          </button>
        </div>

        {last && (
          <div className="mt-4 space-y-2" data-testid="voice-last-check">
            <div className="text-xs text-[var(--text-muted)]">Last checked {checkedAt(last.at)}</div>
            <div className={`text-sm ${last.ok ? "text-[var(--text-primary)]" : "text-red-300"}`}>
              {last.ok
                ? `${servedEngine?.label ?? last.servedByProviderId ?? "A voice"} spoke.`
                : last.message
                  ? `No voice could speak: ${last.message}`
                  : "No voice could speak."}
            </div>
            {last.attempts.length > 0 && (
              <ul className="text-xs text-[var(--text-muted)] space-y-1">
                {last.attempts.map((attempt, i) => {
                  const label = engineById(attempt.engine)?.label ?? attempt.providerId;
                  const took = seconds(attempt.latencyMs);
                  return (
                    <li key={`${attempt.providerId}-${i}`}>
                      {attempt.ok
                        ? `${label} spoke${took ? ` in ${took}` : ""}.`
                        : `${label} could not speak${attempt.message ? `: ${attempt.message}` : "."}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        A voice shown as not available is genuinely missing from this box — it is not a switch that
        can be turned on here.
      </p>
    </div>
  );
}
