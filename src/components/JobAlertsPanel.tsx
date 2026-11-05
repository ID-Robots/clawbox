"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The scheduled-job alerts' card in Settings → Harness (src/lib/job-alerts.ts,
// docs/design/scheduled-job-alerts.md): the owner's switch — ON by default —
// and what the last check found. The desktop notice and the Telegram message
// point here, and this is the one place that keeps saying which job is in
// trouble after the notice has gone.
//
// The route's shape is DECLARED HERE rather than imported from the server
// module, for the reason BackgroundJobsPanel gives: that module reads the
// config and the harness stores, and a type import is still an edge into a
// server-only graph for the bundler.

type JobProblem = "stopped" | "failing" | "skipping" | "overdue";

interface JobAlertsProblem {
  id: string;
  name: string;
  problem: JobProblem;
  count: number;
  since: number;
  error: string | null;
}

interface JobAlertsStatus {
  enabled: boolean;
  off: "env" | "pref" | null;
  runtime: string | null;
  reachable: boolean;
  checkedAt: number;
  watched: number;
  problems: JobAlertsProblem[];
}

const PROBLEMS: ReadonlySet<string> = new Set(["stopped", "failing", "skipping", "overdue"]);

// Shape-checked down to the element: a body this card cannot draw (an older
// server, a proxy's error page, a mock answering `{}`) hides the card instead
// of throwing inside Settings, which takes the whole window down.
function isStatus(body: unknown): body is JobAlertsStatus {
  if (!body || typeof body !== "object") return false;
  const s = body as Record<string, unknown>;
  return typeof s.enabled === "boolean"
    && (s.off === null || s.off === "env" || s.off === "pref")
    && typeof s.reachable === "boolean"
    && typeof s.checkedAt === "number"
    && typeof s.watched === "number"
    && Array.isArray(s.problems)
    && s.problems.every(isProblem);
}

function isProblem(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.name === "string"
    && typeof p.problem === "string" && PROBLEMS.has(p.problem)
    && typeof p.count === "number" && typeof p.since === "number"
    && (p.error === null || typeof p.error === "string");
}

function problemLabel(p: JobAlertsProblem, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (p.problem) {
    case "failing":
      return p.count > 1 ? t("jobAlerts.problem.failing", { count: p.count }) : t("jobAlerts.problem.failedOnce");
    case "skipping":
      return t("jobAlerts.problem.skipping", { count: p.count });
    case "overdue":
      return t("jobAlerts.problem.overdue");
    case "stopped":
      return t("jobAlerts.problem.stopped");
  }
}

export default function JobAlertsPanel() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<JobAlertsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/job-alerts", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to draw: the card stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      const r = await fetch("/setup-api/job-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && (body as { ok?: unknown } | null)?.ok === true && isStatus(body)) setStatus(body);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  // The environment's off is the operator's: the switch is drawn off and inert,
  // because flipping a preference it overrides would change nothing.
  const lockedOff = status.off === "env";

  return (
    <div className="max-w-xl" data-testid="settings-job-alerts">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          notification_important
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("jobAlerts.title")}
        </h3>
      </div>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-[var(--text-primary)] font-medium">{t("jobAlerts.switch")}</span>
            <span className="block text-[11px] text-[var(--text-secondary)] leading-relaxed">{t("jobAlerts.helper")}</span>
            {failed && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="job-alerts-failed">
                {t("jobAlerts.saveFailed")}
              </span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            aria-label={t("jobAlerts.switch")}
            aria-busy={busy}
            disabled={busy || lockedOff}
            data-testid="job-alerts-switch"
            onClick={() => void toggle(!status.enabled)}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.enabled ? "left-[22px]" : "left-0.5"}`}
              aria-hidden="true"
            />
          </button>
        </div>

        <div className="px-3 py-2.5 text-[11px] text-[var(--text-secondary)] leading-relaxed" data-testid="job-alerts-status">
          {!status.enabled ? (
            <span>{t(lockedOff ? "jobAlerts.offByEnv" : "jobAlerts.off")}</span>
          ) : status.checkedAt === 0 ? (
            <span>{t("jobAlerts.notChecked")}</span>
          ) : (
            <>
              {!status.reachable && (
                <span className="block text-[var(--amber-ink)] mb-1" data-testid="job-alerts-unreachable">
                  {t("jobAlerts.unreachable")}
                </span>
              )}
              {status.problems.length === 0 && (
                <span className="block">
                  {status.watched === 0 ? t("jobAlerts.none") : t("jobAlerts.allGood", { count: status.watched })}
                </span>
              )}
              <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">
                {t("jobAlerts.checked", { time: time(status.checkedAt) })}
              </span>
            </>
          )}
        </div>

        {status.enabled && status.problems.map((p) => (
          <div key={p.id} className="px-3 py-2.5" data-testid={`job-alerts-problem-${p.id}`}>
            <span className="flex items-baseline gap-2">
              <span className="material-symbols-rounded text-[var(--amber-ink)] self-center" style={{ fontSize: 16 }} aria-hidden="true">
                warning
              </span>
              <span className="flex-1 min-w-0 text-sm text-[var(--text-primary)] font-medium break-words">{p.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--amber-ink)]">{problemLabel(p, t)}</span>
            </span>
            <span className="block text-[10px] text-[var(--text-muted)] mt-0.5 pl-6">
              {t("jobAlerts.since", { time: time(p.since) })}
            </span>
            {p.error && (
              <span className="block text-[10px] text-[var(--text-muted)] font-mono mt-0.5 pl-6 break-all">{p.error}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
