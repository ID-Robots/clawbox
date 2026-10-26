"use client";

import { useCallback, useEffect, useState } from "react";

import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";

// Settings → System → Agent databases: OpenClaw's per-agent SQLite databases,
// how big they are, which ones the next maintenance run would compact, how the
// last run went, the nightly schedule and "Run now".
//
// The route's shape is DECLARED HERE rather than imported from
// `@/lib/openclaw-db-maintenance`, which reads the config store and spawns
// processes: what crosses this boundary is JSON over a fetch (the reason
// BackgroundJobsPanel gives for the same choice).
interface Database {
  key: string;
  label: string;
  kind: "agent" | "state";
  agentId: string | null;
  bytes: number;
  freeRatio: number | null;
  error: string | null;
  needs: string | null;
  blocked: string | null;
}

interface LastRun {
  trigger?: string;
  outcome: string;
  finishedAt?: string;
  startedAt?: string;
  beforeBytes?: number;
  afterBytes?: number;
  gatewayRestarted?: boolean;
}

interface Status {
  available: boolean;
  supported: boolean;
  totalBytes: number;
  diskFreeBytes: number | null;
  databases: Database[];
  running: { phase?: string } | null;
  lastRun: LastRun | null;
  schedule: { enabled: boolean; time: string };
  nextRunAt: number | null;
}

function isStatus(body: unknown): body is Status {
  const s = body as Partial<Status> | null;
  return (
    !!s
    && typeof s.available === "boolean"
    && Array.isArray(s.databases)
    && s.databases.every((d) => !!d && typeof d.key === "string" && typeof d.bytes === "number")
    && !!s.schedule
    && typeof s.schedule.enabled === "boolean"
    && typeof s.schedule.time === "string"
  );
}

// The run's phases, as scripts/openclaw-db-maintenance.py writes them.
const PHASES: Record<string, string> = {
  measuring: "dbMaintenance.phaseMeasuring",
  "waiting for the gateway to be idle": "dbMaintenance.phaseWaiting",
  "stopping the gateway": "dbMaintenance.phaseStopping",
  compacting: "dbMaintenance.phaseCompacting",
  "starting the gateway again": "dbMaintenance.phaseRestarting",
};

// The run's `lastRun.outcome` codes, and their catalogue keys (camelCase).
const OUTCOMES: Record<string, string> = {
  compacted: "compacted",
  partial: "partial",
  failed: "failed",
  nothing_to_do: "nothingToDo",
  skipped: "skipped",
  gateway_busy: "gatewayBusy",
  gateway_starting: "gatewayStarting",
  update_in_progress: "updateInProgress",
  unsupported_core: "unsupportedCore",
  no_databases: "noDatabases",
  hold_failed: "holdFailed",
  stop_failed: "stopFailed",
  dry_run: "dryRun",
};

const POLL_MS = 5_000;

export default function DbMaintenancePanel() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<{ key: string; warn: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);

  const size = (bytes: number | null | undefined) => formatBytes(typeof bytes === "number" ? bytes : null, locale) ?? "0 B";
  const when = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  };

  const load = useCallback(async (): Promise<Status | null> => {
    try {
      const r = await fetch("/setup-api/gateway/db-maintenance", { cache: "no-store" });
      if (!r.ok) return null;
      const body: unknown = await r.json();
      return isStatus(body) ? body : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void load().then((s) => {
      if (alive && s) setStatus(s);
    });
    return () => { alive = false; };
  }, [load]);

  // While a run goes, follow it; the last poll after it ends shows its result.
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      void load().then((s) => {
        if (alive && s) setStatus(s);
      });
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [running, load]);

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; code?: string; status: number; body: Record<string, unknown> | null }> {
    const r = await fetch("/setup-api/gateway/db-maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: r.ok && parsed?.ok === true, code: typeof parsed?.code === "string" ? parsed.code : undefined, status: r.status, body: parsed };
  }

  async function runNow() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await post({ action: "run" });
      if (res.ok) {
        setNotice({ key: "dbMaintenance.started", warn: false });
        // The run writes its record a moment after it starts.
        setStatus((s) => (s ? { ...s, running: s.running ?? { phase: "measuring" } } : s));
      } else if (res.code === "already_running") {
        setNotice({ key: "dbMaintenance.alreadyRunning", warn: false });
      } else if (res.code === "update_in_progress") {
        setNotice({ key: "dbMaintenance.updateRunning", warn: true });
      } else {
        setNotice({ key: "dbMaintenance.startFailed", warn: true });
      }
    } catch {
      setNotice({ key: "dbMaintenance.startFailed", warn: true });
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(next: { enabled?: boolean; time?: string }) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await post({ action: "schedule", ...next });
      const schedule = res.body?.schedule as Status["schedule"] | undefined;
      if (res.ok && schedule && typeof schedule.enabled === "boolean" && typeof schedule.time === "string") {
        const nextRunAt = typeof res.body?.nextRunAt === "number" ? res.body.nextRunAt : null;
        setStatus((s) => (s ? { ...s, schedule, nextRunAt } : s));
        setTimeDraft(null);
      } else {
        setNotice({ key: "dbMaintenance.saveFailed", warn: true });
      }
    } catch {
      setNotice({ key: "dbMaintenance.saveFailed", warn: true });
    } finally {
      setBusy(false);
    }
  }

  if (!status || !status.available) return null;

  const last = status.lastRun;
  const lastOutcome = (last && Object.hasOwn(OUTCOMES, last.outcome) ? OUTCOMES[last.outcome] : undefined) ?? "failed";
  const reclaimed = last && typeof last.beforeBytes === "number" && typeof last.afterBytes === "number"
    ? Math.max(0, last.beforeBytes - last.afterBytes)
    : null;
  const phaseKey = status.running?.phase ? PHASES[status.running.phase] : undefined;
  const time = timeDraft ?? status.schedule.time;

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-db-maintenance">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">database</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("dbMaintenance.title")}</h3>
        <span className="ml-auto text-xs font-mono text-[var(--text-secondary)]" data-testid="db-maintenance-total">
          {t("dbMaintenance.total", { size: size(status.totalBytes), count: status.databases.length })}
        </span>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] opacity-70 mb-3 leading-relaxed">{t("dbMaintenance.help")}</p>

      {!status.supported && (
        <p className="text-[11px] text-[var(--amber-ink)] mb-3" data-testid="db-maintenance-unsupported">{t("dbMaintenance.unsupported")}</p>
      )}

      {status.databases.length > 0 && (
        <div className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06] mb-3">
          {status.databases.map((db) => (
            <div key={db.key} className="flex items-center gap-3 px-3 py-2" data-testid={`db-maintenance-db-${db.key}`}>
              <span className="flex-1 min-w-0 text-xs text-[var(--text-primary)] truncate">
                {db.kind === "state" ? t("dbMaintenance.stateDb") : t("dbMaintenance.agentDb", { id: db.agentId ?? "?" })}
              </span>
              {typeof db.freeRatio === "number" && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  {t("dbMaintenance.freePages", { percent: Math.round(db.freeRatio * 100) })}
                </span>
              )}
              {db.needs && (
                <span className="text-[10px] text-[var(--coral-bright)] bg-orange-500/10 px-1.5 py-0.5 rounded" data-testid={`db-maintenance-needs-${db.key}`}>
                  {t("dbMaintenance.needsCompaction")}
                </span>
              )}
              <span className="text-xs font-mono text-white/50 w-20 text-right">{size(db.bytes)}</span>
            </div>
          ))}
        </div>
      )}
      {typeof status.diskFreeBytes === "number" && (
        <p className="text-[10px] text-[var(--text-muted)] opacity-60 mb-3">{t("settings.freeAmount", { amount: size(status.diskFreeBytes) })}</p>
      )}

      {status.running ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] mb-3" role="status" data-testid="db-maintenance-running">
          <div className="w-3.5 h-3.5 border-2 border-white/20 rounded-full motion-safe:animate-spin" style={{ borderTopColor: "#fe6e00" }} aria-hidden="true" />
          {t("dbMaintenance.running", { phase: t(phaseKey ?? "dbMaintenance.phaseRunning") })}
        </div>
      ) : last ? (
        <p className="text-[11px] text-[var(--text-secondary)] mb-3 leading-relaxed" data-testid="db-maintenance-last">
          {t("dbMaintenance.lastRun", {
            when: when(last.finishedAt ?? last.startedAt),
            result: t(`dbMaintenance.outcome.${lastOutcome}`, {
              before: size(last.beforeBytes),
              after: size(last.afterBytes),
              reclaimed: size(reclaimed),
            }),
          })}
          {last.gatewayRestarted === false && (
            <span className="block text-[var(--amber-ink)]" data-testid="db-maintenance-gateway-down">{t("dbMaintenance.gatewayDown")}</span>
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={status.schedule.enabled}
          aria-label={t("dbMaintenance.scheduleLabel")}
          disabled={busy}
          data-testid="db-maintenance-schedule-switch"
          onClick={() => void saveSchedule({ enabled: !status.schedule.enabled })}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.schedule.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.schedule.enabled ? "left-[22px]" : "left-0.5"}`} aria-hidden="true" />
        </button>
        <span className="text-xs text-[var(--text-primary)]">{t("dbMaintenance.scheduleLabel")}</span>
        <label className="sr-only" htmlFor="db-maintenance-time">{t("dbMaintenance.time")}</label>
        <input
          id="db-maintenance-time"
          type="time"
          value={time}
          disabled={busy || !status.schedule.enabled}
          data-testid="db-maintenance-time"
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={() => {
            if (timeDraft && timeDraft !== status.schedule.time) void saveSchedule({ time: timeDraft });
          }}
          className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || !!status.running || !status.supported}
          data-testid="db-maintenance-run"
          onClick={() => void runNow()}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-[var(--text-primary)] disabled:opacity-40"
        >
          {t("dbMaintenance.runNow")}
        </button>
      </div>
      {status.schedule.enabled && status.nextRunAt && (
        <p className="text-[10px] text-[var(--text-muted)] opacity-60 mt-2" data-testid="db-maintenance-next">
          {t("dbMaintenance.nextRun", { when: when(status.nextRunAt) })}
        </p>
      )}
      <p className="text-[10px] text-[var(--text-muted)] opacity-60 mt-1">{t("dbMaintenance.scheduleHelp")}</p>
      {notice && (
        <p className={`text-[11px] mt-2 ${notice.warn ? "text-[var(--amber-ink)]" : "text-[var(--text-secondary)]"}`} role="status" data-testid="db-maintenance-notice">
          {t(notice.key)}
        </p>
      )}
    </div>
  );
}
