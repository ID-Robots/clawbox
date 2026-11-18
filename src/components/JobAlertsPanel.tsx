"use client";

import { useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";

// The scheduled-job alerts' card in Settings → Harness (src/lib/job-alerts.ts,
// docs/design/scheduled-job-alerts.md): the owner's switch — ON by default —,
// who of the bot's approved users gets the alerts on Telegram (the first five
// until the owner ticks someone), and what the last check found. The desktop notice and the Telegram message
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

/** Who is told on Telegram (the route's `recipients`): the bot's approved users and the owner's pick. */
interface RecipientUser {
  id: string;
  name?: string;
}

interface JobAlertRecipients {
  picked: string[] | null;
  known: boolean;
  approved: RecipientUser[];
  effective: string[];
  defaultCount: number;
  maxPicked: number;
}

const PROBLEMS: ReadonlySet<string> = new Set(["stopped", "failing", "skipping", "overdue"]);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

// Checked on its own: a `recipients` this card cannot draw (an older server
// has none at all) leaves that part out and keeps the rest of the card.
function isRecipients(value: unknown): value is JobAlertRecipients {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (r.picked === null || isStringArray(r.picked))
    && typeof r.known === "boolean"
    && Array.isArray(r.approved)
    && r.approved.every((u) => {
      if (!u || typeof u !== "object") return false;
      const user = u as Record<string, unknown>;
      return typeof user.id === "string" && (user.name === undefined || typeof user.name === "string");
    })
    && isStringArray(r.effective)
    && typeof r.defaultCount === "number"
    && typeof r.maxPicked === "number";
}

function recipientsOf(body: unknown): JobAlertRecipients | null {
  const value = body && typeof body === "object" ? (body as { recipients?: unknown }).recipients : undefined;
  return isRecipients(value) ? value : null;
}

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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/** How long after the first scroll the card is brought into view once more (see below). */
const SETTLE_SCROLL_MS = 600;

interface JobAlertsPanelProps {
  /**
   * Settings asks for the card: the job alert's notice was clicked
   * (`OPEN_JOB_ALERTS_SETTINGS`, focus `jobAlerts`). The card scrolls itself
   * into view once it has something to draw, then hands the ask back through
   * `onShown`, so coming back to Harness later lands at the top again.
   */
  show?: boolean;
  onShown?: () => void;
}

export default function JobAlertsPanel({ show = false, onShown }: JobAlertsPanelProps = {}) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<JobAlertsStatus | null>(null);
  const [recipients, setRecipients] = useState<JobAlertRecipients | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drawn = status !== null;

  // After the commit that drew the card, so there is a card to scroll to. Once
  // more a moment later: the panels above it read their own routes and can
  // still grow after this one has answered, pushing it back below the fold.
  // The second pass outlives the ask (handing it back re-renders with
  // `show` false), so its timer is cleared on unmount only.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);
  useEffect(() => {
    if (!show || !drawn) return;
    // Guarded: jsdom ships an Element without it.
    const reveal = () => cardRef.current?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    reveal();
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(reveal, SETTLE_SCROLL_MS);
    onShown?.();
  }, [show, drawn, onShown]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/job-alerts", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) {
          setStatus(body);
          setRecipients(recipientsOf(body));
        }
      } catch {
        // Nothing to draw: the card stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  /** The switch and the pick save the same way: the route answers the whole card. */
  async function save(change: { enabled: boolean } | { recipients: string[] | null }) {
    setBusy(true);
    setFailed(false);
    try {
      const r = await fetch("/setup-api/job-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && (body as { ok?: unknown } | null)?.ok === true && isStatus(body)) {
        setStatus(body);
        setRecipients(recipientsOf(body));
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // Ticked = who the next alert goes to on Telegram, so a box that never chose
  // shows the default's people ticked. A tick or an untick saves the ticked
  // approved users as the pick; a picked id that is no longer approved is not
  // drawn, and leaves the pick with the next save.
  function pick(id: string, on: boolean) {
    if (!recipients) return;
    const ticked = new Set(recipients.known ? recipients.effective : []);
    if (on) ticked.add(id);
    else ticked.delete(id);
    void save({ recipients: recipients.approved.map((u) => u.id).filter((x) => ticked.has(x)) });
  }

  if (!status) return null;

  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  // The environment's off is the operator's: the switch is drawn off and inert,
  // because flipping a preference it overrides would change nothing.
  const lockedOff = status.off === "env";

  // The Telegram part is drawn while the alerts are on and there is anyone to
  // pick — or a pick to undo: a saved one whose people are all gone, or one
  // that cannot be read.
  const approvedIds = new Set(recipients?.approved.map((u) => u.id) ?? []);
  const ticked = new Set(recipients?.known ? recipients.effective : []);
  const stale = recipients?.picked?.filter((id) => !approvedIds.has(id)).length ?? 0;
  const atLimit = recipients !== null && ticked.size >= recipients.maxPicked;
  const showRecipients = status.enabled && recipients !== null
    && (recipients.approved.length > 0 || !recipients.known || (recipients.picked?.length ?? 0) > 0);

  return (
    <div ref={cardRef} className="max-w-xl scroll-mt-4" data-testid="settings-job-alerts">
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
            onClick={() => void save({ enabled: !status.enabled })}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.enabled ? "left-[22px]" : "left-0.5"}`}
              aria-hidden="true"
            />
          </button>
        </div>

        {showRecipients && recipients && (
          <div className="px-3 py-3" data-testid="job-alerts-recipients">
            <span className="block text-sm text-[var(--text-primary)] font-medium">{t("jobAlerts.recipients.title")}</span>
            <span className="block text-[11px] text-[var(--text-secondary)] leading-relaxed">{t("jobAlerts.recipients.helper")}</span>
            {recipients.approved.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {recipients.approved.map((u) => {
                  const on = ticked.has(u.id);
                  return (
                    <li key={u.id}>
                      <label className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 cursor-pointer hover:bg-white/[0.04]">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy || (!on && atLimit)}
                          onChange={(e) => pick(u.id, e.target.checked)}
                          data-testid={`job-alerts-recipient-${u.id}`}
                          className="shrink-0 w-4 h-4 accent-[var(--coral-bright)] disabled:opacity-50"
                        />
                        <span className="flex-1 min-w-0 truncate text-sm text-[var(--text-primary)]">{u.name ?? u.id}</span>
                        {u.name && (
                          <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{u.id}</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {(!recipients.known || recipients.picked === null || recipients.effective.length === 0 || stale > 0 || atLimit) && (
            <span className="block text-[11px] text-[var(--text-secondary)] leading-relaxed mt-1.5" data-testid="job-alerts-recipients-note">
              {!recipients.known ? (
                <span className="block text-[var(--amber-ink)]">{t("jobAlerts.recipients.unreadable")}</span>
              ) : recipients.picked === null ? (
                <span className="block">{t("jobAlerts.recipients.default", { count: recipients.defaultCount })}</span>
              ) : recipients.effective.length === 0 ? (
                <span className="block text-[var(--amber-ink)]">{t("jobAlerts.recipients.none")}</span>
              ) : null}
              {recipients.known && stale > 0 && (
                <span className="block">{t("jobAlerts.recipients.stale", { count: stale })}</span>
              )}
              {recipients.known && atLimit && (
                <span className="block">{t("jobAlerts.recipients.limit", { count: recipients.maxPicked })}</span>
              )}
            </span>
            )}
            {(recipients.picked !== null || !recipients.known) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void save({ recipients: null })}
                data-testid="job-alerts-recipients-reset"
                className="mt-1.5 text-[11px] font-medium text-[var(--coral-bright)] hover:underline disabled:opacity-50"
              >
                {t("jobAlerts.recipients.reset")}
              </button>
            )}
          </div>
        )}

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
                  {status.watched === 0
                    ? t("jobAlerts.none")
                    : status.watched === 1 ? t("jobAlerts.allGoodOne") : t("jobAlerts.allGood", { count: status.watched })}
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
