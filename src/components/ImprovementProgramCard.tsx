"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";

/**
 * Settings → System → ClawBox Improvement Program.
 *
 * THE CARD IS THE CONSENT. Everything on it above the three buttons exists so
 * that an owner who reads it knows exactly what a report contains before they
 * choose — what is sent, what never is, and that the removal happens on the
 * device rather than somewhere downstream. A card that offered the switch and
 * a reassuring sentence would be asking for a signature on a blank page, which
 * is why the two lists are rendered in full rather than folded behind a hint.
 *
 * The mode is not optimistic: every write posts and renders the state the
 * route reads back, because "is this box reporting" is answered by the config
 * on disk, not by the button that was just pressed.
 *
 * The recent-errors list carries a Report button per row only in `ask` mode
 * and only for an unreported incident: in `auto` the box has already filed it
 * (or will), and in `off` the route refuses — a button whose only outcome is a
 * refusal is not an offer.
 */

type Mode = "off" | "ask" | "auto";

interface IncidentRow {
  id: string;
  source: string;
  message: string;
  count: number;
  lastSeen: number;
  issueNumber: number | null;
}

interface ProgramState {
  mode: Mode;
  repo: string;
  pending: number;
  reported: number;
  total: number;
  maxIssuesPerDay: number;
  remainingToday: number;
  github: { installed: boolean; connected: boolean; login: string | null };
  incidents: IncidentRow[];
}

const MODES: Mode[] = ["off", "ask", "auto"];

const FALLBACK: ProgramState = {
  mode: "off",
  repo: "ID-Robots/clawbox",
  pending: 0,
  reported: 0,
  total: 0,
  maxIssuesPerDay: 5,
  remainingToday: 0,
  github: { installed: false, connected: false, login: null },
  incidents: [],
};

/**
 * The route's answer, made whole.
 *
 * A settings card must not be able to take the Settings window down with it,
 * and this one could: `state?.github.connected` optional-chained the STATE and
 * then dereferenced `github` unconditionally, so any answer without that field
 * — an older server, a partial fixture, a 200 from something that is not this
 * route — threw during render and unmounted the whole page. One normaliser is
 * the fix rather than an optional chain at each of the six use sites, because
 * the next field added would need the seventh.
 */
function normalize(payload: unknown): ProgramState {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Partial<ProgramState>;
  const gh = (typeof raw.github === "object" && raw.github !== null ? raw.github : {}) as Partial<ProgramState["github"]>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    mode: MODES.includes(raw.mode as Mode) ? raw.mode as Mode : FALLBACK.mode,
    repo: typeof raw.repo === "string" && raw.repo ? raw.repo : FALLBACK.repo,
    pending: num(raw.pending, 0),
    reported: num(raw.reported, 0),
    total: num(raw.total, 0),
    maxIssuesPerDay: num(raw.maxIssuesPerDay, FALLBACK.maxIssuesPerDay),
    remainingToday: num(raw.remainingToday, 0),
    github: {
      installed: gh.installed === true,
      connected: gh.connected === true,
      login: typeof gh.login === "string" ? gh.login : null,
    },
    // Rows the card can actually draw, and nothing else: a malformed entry
    // must not be the thing that blanks the page.
    incidents: (Array.isArray(raw.incidents) ? raw.incidents : []).filter(
      (i): i is IncidentRow => typeof i === "object" && i !== null && typeof (i as IncidentRow).id === "string",
    ),
  };
}

const MODE_KEYS: Record<Mode, { label: string; hint: string }> = {
  off: { label: "improvement.modeOff", hint: "improvement.modeOffHint" },
  ask: { label: "improvement.modeAsk", hint: "improvement.modeAskHint" },
  auto: { label: "improvement.modeAuto", hint: "improvement.modeAutoHint" },
};

/** How many of the recent errors the card lists. The whole log is a support
 *  question, not a settings one. */
const SHOWN = 5;

export default function ImprovementProgramCard() {
  const { t, locale } = useT();
  const [state, setState] = useState<ProgramState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/improvement-program", { cache: "no-store" });
      if (!res.ok) throw new Error("load");
      setState(normalize(await res.json()));
      setError(null);
    } catch {
      setError(t("improvement.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  /** The route's own sentence when it has one, the catalogue's when it does
   *  not: a refusal already worded by the box beats a generic English fallback. */
  const readError = async (res: Response, fallback: string): Promise<string> => {
    try {
      const data = await res.json() as { error?: string };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  const choose = async (mode: Mode) => {
    if (state?.mode === mode || busy) return;
    setBusy(mode);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/setup-api/improvement-program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(await readError(res, t("improvement.saveFailed")));
      setState(normalize(await res.json()));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("improvement.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const report = async (id: string) => {
    setReporting(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/setup-api/improvement-program/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(await readError(res, t("improvement.reportFailed")));
      const out = await res.json() as { action?: string; issueNumber?: number };
      const n = String(out.issueNumber ?? "");
      setNotice(out.action === "created" ? t("improvement.reportedNow", { n }) : t("improvement.commentedNow", { n }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("improvement.reportFailed"));
    } finally {
      setReporting(null);
    }
  };

  if (loading) return null;

  const mode = state?.mode ?? FALLBACK.mode;
  const connected = state?.github.connected === true;
  const shown = (state?.incidents ?? []).slice(0, SHOWN);

  return (
    <div
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
      data-testid="improvement-program-card"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          volunteer_activism
        </span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("improvement.title")}
        </label>
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed mb-4">{t("improvement.intro")}</p>

      {/* What travels, and what never does. Side by side on a wide card so
          neither list reads as the fine print under the other. */}
      <div className="grid gap-4 sm:grid-cols-2 mb-4">
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-widest mb-1.5">
            {t("improvement.sendsTitle")}
          </p>
          <ul className="text-[11px] text-[var(--text-muted)] leading-relaxed list-disc pl-4 space-y-1">
            <li>{t("improvement.sends1")}</li>
            <li>{t("improvement.sends2")}</li>
            <li>{t("improvement.sends3")}</li>
          </ul>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-widest mb-1.5">
            {t("improvement.neverTitle")}
          </p>
          <ul className="text-[11px] text-[var(--text-muted)] leading-relaxed list-disc pl-4 space-y-1">
            <li>{t("improvement.never1")}</li>
            <li>{t("improvement.never2")}</li>
            <li>{t("improvement.never3")}</li>
          </ul>
        </div>
      </div>

      <div className="h-px bg-white/[0.06] my-4" />

      <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
        {t("improvement.modeTitle")}
      </p>
      <div role="radiogroup" aria-label={t("improvement.modeTitle")} className="space-y-2">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            aria-busy={busy === m}
            disabled={busy !== null}
            data-testid={`improvement-mode-${m}`}
            onClick={() => void choose(m)}
            className={`w-full text-left rounded-xl border p-3 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
              mode === m
                ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/10"
                : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"
            }`}
          >
            <span className="text-sm text-[var(--text-primary)]">{t(MODE_KEYS[m].label)}</span>
            <span className="block text-[11px] text-[var(--text-muted)] leading-relaxed mt-0.5">
              {/* Only the automatic hint names the daily limit, so the number
                  the box actually enforces is the number the owner reads. */}
              {t(MODE_KEYS[m].hint, { n: state?.maxIssuesPerDay ?? 5 })}
            </span>
          </button>
        ))}
      </div>

      <div className="h-px bg-white/[0.06] my-4" />

      <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
        {t("improvement.statusTitle")}
      </p>
      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="improvement-counts">
        {state && state.total > 0
          ? `${t("improvement.pending", { n: state.pending })} · ${t("improvement.reported", { n: state.reported })}`
          : t("improvement.none")}
      </p>
      <p className="text-[11px] text-[var(--text-muted)] opacity-70 leading-relaxed mt-1">
        {t("improvement.repo", { repo: state?.repo ?? "ID-Robots/clawbox" })}
        {mode !== "off" && connected ? ` ${t("improvement.remaining", { n: state?.remainingToday ?? 0 })}` : ""}
      </p>

      {/* The GitHub line is the one thing that can make an enabled programme
          send nothing, so it is stated where the owner just made the choice
          rather than left to be inferred from a queue that never empties. */}
      {mode !== "off" && (
        <p
          className={`text-[11px] leading-relaxed mt-2 ${connected ? "text-[var(--text-muted)] opacity-70" : "text-amber-400"}`}
          data-testid="improvement-github"
        >
          {connected
            ? t("improvement.githubConnected", { login: state?.github.login ?? "" })
            : t("improvement.githubMissing")}
        </p>
      )}

      {shown.length > 0 && (
        <>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mt-4 mb-2">
            {t("improvement.recentTitle")}
          </p>
          <ul className="space-y-2" data-testid="improvement-recent">
            {shown.map((incident) => (
              <li
                key={incident.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/[0.06] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[11px] text-[var(--text-secondary)] font-mono truncate">{incident.source}</p>
                  {/* Already sanitized on the device; rendered as text, never
                      as markup, like every other agent- or subsystem-written
                      string on this desktop. */}
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed break-words">{incident.message}</p>
                  <p className="text-[10px] text-[var(--text-muted)] opacity-60 mt-0.5">
                    {t("improvement.seen", { n: incident.count })}
                    {" · "}
                    {new Date(incident.lastSeen).toLocaleDateString(locale)}
                    {incident.issueNumber !== null ? ` · ${t("improvement.issue", { n: incident.issueNumber })}` : ""}
                  </p>
                </div>
                {mode === "ask" && connected && incident.issueNumber === null && (
                  <button
                    type="button"
                    disabled={reporting !== null}
                    data-testid={`improvement-report-${incident.id}`}
                    onClick={() => void report(incident.id)}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-white/[0.12] text-[var(--text-secondary)] hover:border-white/25 bg-transparent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {reporting === incident.id ? t("improvement.reporting") : t("improvement.report")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {notice && <StatusMessage type="success" message={notice} />}
      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
