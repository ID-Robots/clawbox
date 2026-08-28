"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  VoiceChoice,
  VoiceEngine,
  VoiceEngineId,
  VoiceOutputStatus,
} from "@/lib/voice-output";

/**
 * Speech output is a PRIMARY and a FALLBACK, never a single pick: the gateway
 * always falls through to the other engine when the first one cannot speak,
 * so the honest control is "which one goes first". The two orders map onto
 * the choices the tts route has always written — cloud-first is `auto`
 * (cloud preferred, on-device when the cloud cannot), box-first is `local`.
 * A legacy explicit `cloud` choice reads as cloud-first.
 */
const OUTPUT_ORDERS: { id: Extract<VoiceChoice, "auto" | "local">; title: string; blurb: string }[] = [
  {
    id: "auto",
    title: "Cloud first",
    blurb: "The ClawBox cloud voice speaks. If it cannot, the voice on this box answers instead.",
  },
  {
    id: "local",
    title: "On this box first",
    blurb: "The on-device voice speaks. Words only leave the box if it cannot speak at all.",
  },
];

/** Speech input has the same shape: cloud transcription first, or Whisper on the box first. */
type SttEngineId = "cloud" | "local";
interface SttStatus {
  primary: SttEngineId;
  engines: {
    cloud: { configured: boolean; label: string };
    local: { installed: boolean; label: string; detail?: string };
  };
  chain: SttEngineId[];
}
const INPUT_ORDERS: { id: SttEngineId; title: string; blurb: string }[] = [
  {
    id: "cloud",
    title: "Cloud first",
    blurb: "Recordings are transcribed by ClawBox cloud. If it cannot, Whisper on this box transcribes them.",
  },
  {
    id: "local",
    title: "On this box first",
    blurb: "Whisper on this box transcribes. Recordings only leave the box if it cannot.",
  },
];

function isSttStatus(value: unknown): value is SttStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (s.primary !== "cloud" && s.primary !== "local") return false;
  const engines = s.engines as Record<string, Record<string, unknown>> | undefined;
  if (!engines || typeof engines !== "object") return false;
  if (typeof engines.cloud?.configured !== "boolean" || typeof engines.cloud?.label !== "string") return false;
  if (typeof engines.local?.installed !== "boolean" || typeof engines.local?.label !== "string") return false;
  return Array.isArray(s.chain);
}

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

/**
 * The box says the whole feature is absent on this SKU. Read as its own field
 * rather than inferred from a missing engine list: "no voice is installed" and
 * "this edition has no voice at all" are different answers and the second one
 * must not be shown as the first, which reads as something the customer could
 * fix by installing a voice.
 */
function isEditionUnsupported(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as { supportedOnEdition?: unknown }).supportedOnEdition === false;
}

const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";
const BADGE = "text-[11px] px-2 py-0.5 rounded-full border";

export default function VoiceOutputPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<VoiceOutputStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"select" | "check" | null>(null);
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const [sttBusy, setSttBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/tts", { cache: "no-store" });
      const data = await res.json();
      if (isEditionUnsupported(data)) {
        setUnsupported(true);
        return;
      }
      if (!isVoiceStatus(data)) return;
      setStatus(data);
    } catch {
      /* keep the last good reading rather than blanking the panel */
    }
  }, []);

  const loadStt = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/stt", { cache: "no-store" });
      const data = await res.json();
      if (isSttStatus(data)) setStt(data);
    } catch {
      /* same rule: last good reading, never a blank card */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
    loadStt();
  }, [active, load, loadStt]);

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

  const selectStt = useCallback(async (primary: SttEngineId) => {
    setSttBusy(true);
    setSttError(null);
    try {
      const res = await fetch("/setup-api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primary }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSttError(typeof data?.error === "string" ? data.error : "Could not change speech input.");
        return;
      }
      if (isSttStatus(data)) setStt(data);
    } catch {
      setSttError("Could not reach the box.");
    } finally {
      setSttBusy(false);
    }
  }, []);

  // Auto is a standing instruction, not a one-off write: if the engine it
  // resolves to is not the one the box is configured for — because a cloud
  // voice appeared, or the one in use stopped working — move the box rather
  // than telling the customer to click their own choice again. Once per mount,
  // so a write that does not clear the drift cannot become a loop.
  const reconciled = useRef(false);
  useEffect(() => {
    if (!active || !status || busy) return;
    if (status.choice !== "auto" || !status.drifted) return;
    if (reconciled.current) return;
    reconciled.current = true;
    void post({ action: "select", choice: "auto" }, "select");
  }, [active, status, busy, post]);

  // Before the skeleton: a box that will never answer with a status must stop
  // here rather than pulse three grey cards forever.
  if (unsupported) {
    return (
      <div className="max-w-2xl" data-testid="voice-output-unsupported">
        <div className={`${CARD} space-y-2`}>
          <div className="flex items-center gap-2">
            <span
              className="material-symbols-rounded text-[var(--text-muted)]"
              style={{ fontSize: 22 }}
              aria-hidden="true"
            >
              voice_over_off
            </span>
            <h2 className="font-semibold text-[var(--text-primary)]">Not available on this edition</h2>
          </div>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Speaking out loud is an OpenClaw feature, and this ClawBox does not run OpenClaw.
            There is nothing to choose here and nothing to check — the box will answer in text.
          </p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="voice-output-loading">
        {[0, 1, 2].map(i => (
          <div key={i} className={`${CARD} animate-pulse`}>
            <div className="h-3 w-40 rounded bg-white/[0.08]" />
            <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
          </div>
        ))}
      </div>
    );
  }

  const engineById = (id: VoiceEngineId | null) =>
    id ? status.engines.find(e => e.id === id) ?? null : null;
  // What will ACTUALLY speak, not what is written in the config. When a chosen
  // engine stops working the gateway falls back at request time, so naming the
  // configured primary here would tell the customer the one thing this panel
  // exists to stop them believing.
  const speaking = engineById(status.preferredEngine) ?? engineById(status.activeEngine);
  const chosen = status.choice === "auto" ? null : engineById(status.choice as VoiceEngineId);
  const fellBack = chosen !== null && speaking !== null && chosen.id !== speaking.id;
  const last = status.lastCheck;
  const servedEngine = engineById(last?.servedEngine ?? null);
  const warning = status.warning;
  /** The order the box runs: `cloud` (explicit, legacy) reads as cloud-first. */
  const outputOrder: "auto" | "local" = status.choice === "local" ? "local" : "auto";

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Every voice feature has a first choice and a fallback: the box tells you which one actually
        answered, because a setting that quietly does something else is what these controls exist
        to prevent.
      </p>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ── Speech output ── */}
      <h3 className="text-xs uppercase tracking-widest font-semibold text-[var(--text-muted)] pt-2">Speech output</h3>

      <div data-testid="voice-speaking-now" className={CARD}>
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Speaking now</div>
        <div className="text-sm font-semibold text-[var(--text-primary)] mt-1">
          {speaking ? speaking.label : "No voice is selected on this box."}
        </div>
        {fellBack && (
          <p className="text-sm text-amber-200 mt-2" data-testid="voice-drift">
            You chose {chosen.label}, but it cannot speak right now, so {speaking.label} answers
            instead.
          </p>
        )}
        {warning && (
          <p role="alert" className="text-sm text-amber-200 mt-2" data-testid="voice-cloud-warning">
            ⚠️ {warning}
          </p>
        )}
      </div>

      <div role="radiogroup" aria-label="Voice output" className="space-y-3">
        {OUTPUT_ORDERS.map(order => {
          const selected = outputOrder === order.id;
          const primary = engineById(order.id === "auto" ? "cloud" : "local");
          const fallback = engineById(order.id === "auto" ? "local" : "cloud");
          // Absent and broken are different answers, and only one of them
          // means "you cannot pick this". A voice whose last check failed is
          // still offered — refusing it would make the failure permanent,
          // because nothing else would ever route a check through it again.
          const unavailable = primary !== null && !primary.configured;
          const failing = primary !== null && primary.configured && !primary.usable;
          return (
            <button
              key={order.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={unavailable || busy !== null}
              disabled={busy !== null}
              data-testid={`voice-choice-${order.id}`}
              onClick={() => post({ action: "select", choice: order.id }, "select")}
              className={`w-full text-left rounded-2xl border p-5 transition-colors cursor-pointer disabled:opacity-60 ${
                selected
                  ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/[0.08]"
                  : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-[var(--text-primary)]">{order.title}</span>
                {selected && (
                  <span className={`${BADGE} bg-cyan-500/10 text-cyan-300 border-cyan-400/20`}>Chosen</span>
                )}
                {unavailable && (
                  <span className={`${BADGE} bg-amber-500/10 text-amber-300 border-amber-400/20`}>Not available</span>
                )}
                {failing && (
                  <span className={`${BADGE} bg-amber-500/10 text-amber-300 border-amber-400/20`}>Last check failed</span>
                )}
                {primary?.proven && (
                  <span className={`${BADGE} bg-white/[0.06] text-[var(--text-secondary)] border-white/10`}>Proven on this box</span>
                )}
              </div>
              <p className="text-sm text-[var(--text-secondary)] mt-2">{order.blurb}</p>
              {primary && (
                <p className="text-xs text-[var(--text-muted)] mt-2">{primary.detail}</p>
              )}
              <p className="text-xs text-[var(--text-muted)] mt-2">
                Primary: {primary?.label ?? "—"} · Fallback: {fallback?.label ?? "—"}
                {fallback && !fallback.configured ? " (not available)" : ""}
              </p>
            </button>
          );
        })}
      </div>

      <div className={CARD}>
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

      {/* ── Speech input ── */}
      <h3 className="text-xs uppercase tracking-widest font-semibold text-[var(--text-muted)] pt-2">Speech input</h3>

      {sttError && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {sttError}
        </div>
      )}

      {stt ? (
        <div role="radiogroup" aria-label="Speech input" className="space-y-3" data-testid="stt-orders">
          {INPUT_ORDERS.map(order => {
            const selected = stt.primary === order.id;
            const primaryReady = order.id === "cloud" ? stt.engines.cloud.configured : stt.engines.local.installed;
            const fallbackReady = order.id === "cloud" ? stt.engines.local.installed : stt.engines.cloud.configured;
            const primaryLabel = order.id === "cloud" ? stt.engines.cloud.label : stt.engines.local.label;
            const fallbackLabel = order.id === "cloud" ? stt.engines.local.label : stt.engines.cloud.label;
            return (
              <button
                key={order.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!primaryReady || sttBusy}
                disabled={sttBusy}
                data-testid={`stt-choice-${order.id}`}
                onClick={() => void selectStt(order.id)}
                className={`w-full text-left rounded-2xl border p-5 transition-colors cursor-pointer disabled:opacity-60 ${
                  selected
                    ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/[0.08]"
                    : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{order.title}</span>
                  {selected && (
                    <span className={`${BADGE} bg-cyan-500/10 text-cyan-300 border-cyan-400/20`}>Chosen</span>
                  )}
                  {!primaryReady && (
                    <span className={`${BADGE} bg-amber-500/10 text-amber-300 border-amber-400/20`}>
                      {order.id === "local" ? "Not installed" : "Not connected"}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[var(--text-secondary)] mt-2">{order.blurb}</p>
                <p className="text-xs text-[var(--text-muted)] mt-2">
                  Primary: {primaryLabel} · Fallback: {fallbackLabel}{fallbackReady ? "" : " (not available)"}
                </p>
              </button>
            );
          })}
          {stt.engines.local.detail && (
            <p className="text-xs text-[var(--text-muted)]" data-testid="stt-local-detail">{stt.engines.local.detail}</p>
          )}
        </div>
      ) : (
        <div className={`${CARD} animate-pulse`} data-testid="stt-loading">
          <div className="h-3 w-40 rounded bg-white/[0.08]" />
          <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
        </div>
      )}

      <p className="text-xs text-[var(--text-muted)]">
        A voice shown as not available is genuinely missing from this box — it is not a switch that
        can be turned on here.
      </p>
    </div>
  );
}
