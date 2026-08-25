"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";

/**
 * Settings → System → Coding agent.
 *
 * The owner's switch for letting the assistant delegate coding work to a
 * headless Claude Code run (src/lib/coding-agent.ts), what such a run needs
 * and whether it is there, and the recent runs with their summaries.
 *
 * The switch is the CONSENT for a feature that edits files unattended, which
 * is why the route behind it refuses the agent's own credential — see
 * src/app/setup-api/coding-agent/enable/route.ts. Like SystemProfilePanel the
 * switch is not optimistic: it renders the state the route answers with.
 *
 * This is not the "Coding Agent" desktop app (the interactive terminal); the
 * copy says so, because both carry the same name.
 */

interface Readiness {
  ready: boolean;
  wrapperInstalled: boolean;
  claudeInstalled: boolean;
  clawaiConnected: boolean;
  problems: string[];
}

interface AgentStatus {
  enabled: boolean;
  ready: boolean;
  readiness: Readiness;
  running: number;
}

interface Run {
  id: string;
  task: string;
  directory: string;
  projectId: string | null;
  source: "agent" | "owner";
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
  numTurns: number;
  filesTouched: string[];
  permissionDenials: number;
  progress: string[];
}

const RECENT_RUNS = 5;
const POLL_MS = 5_000;

function Switch({
  checked, busy, disabled, label, onChange,
}: {
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        <span className="material-symbols-rounded animate-spin text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
          progress_activity
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-busy={busy}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        data-testid="coding-agent-switch"
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? "bg-[var(--coral-bright)]" : "bg-gray-600"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

function duration(run: Run): string {
  const s = Math.max(0, Math.round(((run.completedAt ?? Date.now()) - run.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

function firstLine(text: string, max = 100): string {
  const line = text.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const STATUS_CLASS: Record<Run["status"], string> = {
  running: "text-amber-400 border-amber-400/40",
  completed: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-400 border-red-400/40",
  stopped: "text-[var(--text-muted)] border-white/20",
};

export default function CodingAgentPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // `load` must not re-run because a translation function was re-created: a
  // refetch on every render would overwrite a freshly toggled switch with the
  // stale status it read a moment earlier. Read `t` through a ref instead.
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        fetch("/setup-api/coding-agent/status", { cache: "no-store" }),
        fetch(`/setup-api/coding-agent/runs?limit=${RECENT_RUNS}`, { cache: "no-store" }),
      ]);
      if (!s.ok) throw new Error("status");
      setStatus(await s.json() as AgentStatus);
      if (r.ok) {
        const data = await r.json() as { runs?: Run[] };
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      }
    } catch {
      setError(tRef.current("codingAgent.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A running run changes every few seconds; nothing else here does.
  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  const readError = async (res: Response, fallback: string) => {
    try {
      const data = await res.json() as { error?: string };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  const toggle = async (next: boolean) => {
    setBusy("switch");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.toggleFailed")));
      setStatus(await res.json() as AgentStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.toggleFailed"));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.stopFailed")));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.stopFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;

  const readiness = status?.readiness;
  const checks: { label: string; ok: boolean; okText: string; badText: string }[] = readiness
    ? [
      { label: t("codingAgent.claudeCode"), ok: readiness.claudeInstalled, okText: t("codingAgent.installed"), badText: t("codingAgent.missing") },
      { label: t("codingAgent.wrapper"), ok: readiness.wrapperInstalled, okText: t("codingAgent.installed"), badText: t("codingAgent.missing") },
      { label: t("codingAgent.clawai"), ok: readiness.clawaiConnected, okText: t("codingAgent.connected"), badText: t("codingAgent.notConnected") },
    ]
    : [];

  const statusLabel = (s: Run["status"]) => t(`codingAgent.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="coding-agent-panel">
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("codingAgent.title")}
        </label>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)]">{t("codingAgent.switchLabel")}</p>
          <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
            {t("codingAgent.switchHelp")}
          </p>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          busy={busy === "switch"}
          disabled={!status}
          label={t("codingAgent.switchLabel")}
          onChange={toggle}
        />
      </div>

      {readiness && (
        <div className="mt-4 rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
          <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
            {t("codingAgent.readiness")}
          </div>
          <ul className="space-y-1">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-xs">
                <span
                  className={`material-symbols-rounded ${c.ok ? "text-emerald-400" : "text-red-400"}`}
                  style={{ fontSize: 16 }}
                  aria-hidden="true"
                >
                  {c.ok ? "check_circle" : "cancel"}
                </span>
                <span className="text-[var(--text-primary)]">{c.label}</span>
                <span className="text-[var(--text-muted)]">· {c.ok ? c.okText : c.badText}</span>
              </li>
            ))}
          </ul>
          {!readiness.ready && readiness.problems.length > 0 && (
            <p className="text-[11px] text-amber-400 mt-2 leading-relaxed" role="alert">
              {readiness.problems.join(" ")}
            </p>
          )}
        </div>
      )}

      <div className="h-px bg-white/[0.06] my-4" />

      <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
        {t("codingAgent.recentRuns")}
      </div>
      {runs.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t("codingAgent.noRuns")}</p>
      ) : (
        <ul className="space-y-2" data-testid="coding-agent-runs">
          {runs.map((run) => {
            const details = [run.error, run.summary].filter(Boolean).join("\n\n");
            const open = expanded === run.id;
            return (
              <li key={run.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${STATUS_CLASS[run.status]}`}>
                        {statusLabel(run.status)}
                      </span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)]">{run.id}</span>
                      {run.projectId && (
                        <span className="text-[11px] text-[var(--text-muted)]">· {run.projectId}</span>
                      )}
                    </div>
                    <p className="text-sm text-[var(--text-primary)] mt-1 break-words">{firstLine(run.task)}</p>
                    <p className="text-[11px] text-[var(--text-muted)] mt-1">
                      {t("codingAgent.runMeta", { turns: run.numTurns, files: run.filesTouched.length, duration: duration(run) })}
                      {" · "}
                      {run.source === "owner" ? t("codingAgent.startedByOwner") : t("codingAgent.startedByAgent")}
                    </p>
                    {run.permissionDenials > 0 && (
                      <p className="text-[11px] text-amber-400 mt-1">{t("codingAgent.denials", { n: run.permissionDenials })}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {run.status === "running" && (
                      <button
                        type="button"
                        onClick={() => stop(run.id)}
                        disabled={busy === run.id}
                        className="text-xs px-3 py-1 rounded-lg border border-white/10 text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-50"
                      >
                        {t("codingAgent.stop")}
                      </button>
                    )}
                    {details && (
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : run.id)}
                        aria-expanded={open}
                        className="text-xs px-3 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                      >
                        {open ? t("codingAgent.hideDetails") : t("codingAgent.showDetails")}
                      </button>
                    )}
                  </div>
                </div>
                {open && details && (
                  <pre className="mt-3 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-72 overflow-y-auto font-sans leading-relaxed">
                    {details}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
    </div>
  );
}
