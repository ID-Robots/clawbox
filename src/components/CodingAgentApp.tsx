"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";

/**
 * The Coding Agent app — opened from the desktop icon of the same name.
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
 * This icon used to open a terminal already running `claude-ds`. It opens this
 * instead, so the app and the thing it configures are finally the same thing —
 * and the header says where the interactive session went, because an owner who
 * relied on it should not have to go looking.
 */

interface Readiness {
  ready: boolean;
  wrapperInstalled: boolean;
  claudeInstalled: boolean;
  clawaiConnected: boolean;
  /** setpriv, which strips the web server's network capabilities off a run.
   *  Not given a row of its own: it is present on every ClawBox, and when it
   *  is not, `problems` says so in the owner's words. */
  capabilityDropAvailable: boolean;
  problems: string[];
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface GitHubState {
  installed: boolean;
  connected: boolean;
  login: string | null;
  loginCommand: string;
  /** "unreachable" means gh is here but could not reach github.com — a
   *  network fault. The card must not read like a missing install. */
  reason?: "not_installed" | "unreachable" | "not_runnable";
}

interface AgentStatus {
  enabled: boolean;
  ready: boolean;
  readiness: Readiness;
  running: number;
  /** The folder a run uses when the assistant names neither project nor path. */
  defaultDirectory: string | null;
  effort: Effort;
  effortLevels: Effort[];
  subagents: boolean;
  maxTurns: number;
  minMaxTurns: number;
  maxMaxTurns: number;
  tokenLimit: number | null;
  minTokenLimit: number;
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
  /** What was refused, in the owner's words. */
  deniedActions?: string[];
  progress: string[];
  effort?: Effort;
  /** Sub-agents working right now; 0 once the run has settled. */
  subagentsActive?: number;
  subagentsTotal?: number;
  subagentsByType?: Record<string, number>;
  modelsUsed?: string[];
  lastActivityAt?: number;
  activeSubagents?: { type: string; description: string; startedAt: number }[];
  /** The commit this run's work was recorded as — what a backup would push. */
  commit?: string | null;
  thinkingTokens?: number;
  tokensUsed?: number;
  sessionId?: string | null;
  /** Where Claude Code keeps this run's transcript, for the live preview. */
  transcriptPath?: string | null;
}

/** One page of runs. The list is open by default now, so it has to be paged
 *  rather than unbounded — a long history should not push the settings off
 *  the top of the window. */
const RUNS_PAGE = 10;
/** Where the preview script lives on the device. */
const CLAWBOX_ROOT = "/home/clawbox/clawbox";
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

/** Elapsed time, readable at every scale a run can reach — seconds to days. */
function duration(run: Run): string {
  const total = Math.max(0, Math.round(((run.completedAt ?? Date.now()) - run.startedAt) / 1000));
  if (total < 60) return `${total}s`;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

/** Compact token counts: 1.3M reads better than 1,317,787 in a list row. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** "just now" / "4m ago" / "2h ago" — how fresh the record is. */
function since(ms: number | undefined): string | null {
  if (!ms) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
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

export default function CodingAgentApp() {
  const { t } = useT();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Runs are behind a button: the answer to "is this on and does it work" is
  // the whole point of opening this window, and a list of past runs pushed it
  // below the fold.
  // Open by default: the history is the reason the window gets opened once
  // the switch is already on.
  const [showRuns, setShowRuns] = useState(true);
  const [runsShown, setRunsShown] = useState(RUNS_PAGE);
  const [github, setGithub] = useState<GitHubState | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Clearing is two clicks, not a browser confirm(): the second click is the
  // confirmation, and collapsing the list takes the offer back.
  const [confirmClear, setConfirmClear] = useState(false);
  // The folder field is a DRAFT until saved, so typing does not fight the
  // status the route keeps returning.
  const [dirDraft, setDirDraft] = useState<string | null>(null);

  // `load` must not re-run because a translation function was re-created: a
  // refetch on every render would overwrite a freshly toggled switch with the
  // stale status it read a moment earlier. Read `t` through a ref instead,
  // synchronised after commit so a discarded render never leaks into it.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const load = useCallback(async () => {
    try {
      const [s, r, g] = await Promise.all([
        fetch("/setup-api/coding-agent/status", { cache: "no-store" }),
        fetch(`/setup-api/coding-agent/runs?limit=30`, { cache: "no-store" }),
        fetch("/setup-api/coding-agent/git", { cache: "no-store" }),
      ]);
      if (!s.ok) throw new Error("status");
      const next = await s.json() as AgentStatus;
      setStatus(next);
      setDirDraft(prev => (prev === null ? (next.defaultDirectory ?? "") : prev));
      if (r.ok) {
        const data = await r.json() as { runs?: Run[] };
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      }
      if (g.ok) setGithub(await g.json() as GitHubState);
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

  const saveDirectory = async () => {
    setBusy("dir");
    setError(null);
    try {
      const value = (dirDraft ?? "").trim();
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // "" clears it. The route answers the re-read status, so a symlink
        // comes back as the folder it actually leads to.
        body: JSON.stringify({ defaultDirectory: value === "" ? null : value }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.folderFailed")));
      const next = await res.json() as AgentStatus;
      setStatus(next);
      setDirDraft(next.defaultDirectory ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.folderFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** One writer for both settings — the route takes either field. */
  const saveSetting = async (patch: Record<string, unknown>, key: string, failMsg: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res, failMsg));
      setStatus(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : failMsg);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Open the run in the Terminal app.
   *
   * A run that is still working gets a live, readable tail of its transcript —
   * the file grows while it works. A finished one gets `claude-ds --resume`,
   * which drops the owner into that exact session to carry on by hand.
   */
  const openInTerminal = (run: Run) => {
    const quoted = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    let command: string;
    if (run.status === "running" && run.transcriptPath) {
      command = `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
    } else if (run.sessionId) {
      command = `cd ${quoted(run.directory)} && claude-ds --resume ${run.sessionId}`;
    } else {
      command = `cd ${quoted(run.directory)}`;
    }
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command } }));
  };

  /** Open a terminal on `gh auth login`. gh prints the device code; the owner
   *  enters it on github.com from any device. No token is typed on the box. */
  const connectGithub = () => {
    const cmd = github?.loginCommand ?? "gh auth login --hostname github.com --git-protocol https";
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command: cmd } }));
  };

  /** Push a run's folder to GitHub, private, creating the repo if needed. */
  const backup = async (run: Run) => {
    setBusy(`backup-${run.id}`);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run.projectId ? { projectId: run.projectId } : { directory: run.directory }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.backupFailed")));
      const out = await res.json() as { repo?: string; created?: boolean };
      setError(null);
      window.dispatchEvent(new CustomEvent("clawbox:toast", {
        detail: { message: t("codingAgent.backupDone", { repo: out.repo ?? "GitHub" }) },
      }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.backupFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** Disconnect GitHub. Two clicks, like clearing history: it is not
   *  destructive — pushed repositories stay — but it is not what anyone means
   *  to do by brushing a button. */
  const disconnectGithub = async () => {
    setBusy("gh-out");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/git", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.githubOutFailed")));
      setGithub(await res.json() as GitHubState);
      setConfirmSignOut(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.githubOutFailed"));
    } finally {
      setBusy(null);
    }
  };

  const clearRuns = async () => {
    setBusy("clear");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/runs", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.clearFailed")));
      setConfirmClear(false);
      setExpanded(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.clearFailed"));
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
        body: JSON.stringify({ runId: id }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.stopFailed")));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.stopFailed"));
    } finally {
      setBusy(null);
    }
  };

  // A window, not a card: keep the app's own background on screen while the
  // first fetch lands, rather than flashing whatever is behind it.
  if (loading) return <div className="h-full bg-[#0f1219]" data-testid="coding-agent-panel" />;

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
    // @container so the panel sizes to its WINDOW, not the viewport — this is
    // a desktop window the owner can resize independently of the screen.
    <div className="h-full flex flex-col bg-[#0f1219] text-white overflow-y-auto @container" data-testid="coding-agent-panel">
      <div className="mx-auto w-full max-w-2xl px-5 py-4">

        {/* One row: what this is, and whether it is on. The switch is the
            reason the window gets opened, so it is the first thing in it. */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
              <h1 className="text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.switchLabel")}</h1>
            </div>
          </div>
          <Switch
            checked={status?.enabled ?? false}
            busy={busy === "switch"}
            disabled={!status}
            label={t("codingAgent.switchLabel")}
            onChange={toggle}
          />
        </div>

        {/* Nothing at all when the harness is fine. A row that always says
            "Ready" is a row that never tells the owner anything; the checklist
            appears only when something is actually missing. */}
        {readiness && !readiness.ready && (
          <div className="mt-3 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2">
            {readiness.ready ? null : (
              <>
                <ul className="space-y-1">
                  {checks.filter((c) => !c.ok).map((c) => (
                    <li key={c.label} className="flex items-center gap-2 text-xs">
                      <span className="material-symbols-rounded text-red-400" style={{ fontSize: 16 }} aria-hidden="true">cancel</span>
                      <span className="text-[var(--text-primary)]">{c.label}</span>
                      <span className="text-[var(--text-muted)]">· {c.badText}</span>
                    </li>
                  ))}
                </ul>
                {readiness.problems.length > 0 && (
                  <p className="text-[11px] text-amber-400 mt-1.5 leading-relaxed" role="alert">
                    {readiness.problems.join(" ")}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Where work goes when the assistant does not name a project. */}
        <div className="mt-3">
          <label htmlFor="coding-agent-dir" className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
            {t("codingAgent.folderLabel")}
          </label>
          <div className="flex items-center gap-2 mt-1.5">
            <input
              id="coding-agent-dir"
              type="text"
              value={dirDraft ?? ""}
              onChange={(e) => setDirDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveDirectory(); }}
              placeholder={t("codingAgent.folderPlaceholder")}
              spellCheck={false}
              data-testid="coding-agent-folder"
              // text-base on a phone: an input under 16px makes iOS Safari
              // zoom the page on focus, which on this panel scrolls the rest
              // of the settings out of view.
              className="flex-1 min-w-0 rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 text-base @sm:text-xs font-mono text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]/50"
            />
            <button
              type="button"
              onClick={() => void saveDirectory()}
              disabled={busy === "dir" || (dirDraft ?? "") === (status?.defaultDirectory ?? "")}
              className="px-3 py-1.5 rounded-lg border border-white/10 text-xs text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {t("codingAgent.folderSave")}
            </button>
          </div>
        </div>

        {/* How a run thinks. Both are real Claude Code settings: --effort, and
            whether the Task (sub-agent) tool is in --tools at all. */}
        <div className="mt-4">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("codingAgent.effortLabel")}
          </label>
          <div className="flex gap-1 mt-1.5" data-testid="coding-agent-effort">
            {(status?.effortLevels ?? []).map((level) => {
              const active = status?.effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => void saveSetting({ effort: level }, "effort", t("codingAgent.effortFailed"))}
                  disabled={busy === "effort"}
                  aria-pressed={active}
                  data-testid={`coding-agent-effort-${level}`}
                  className={`flex-1 px-2 py-1.5 rounded-lg border text-[11px] capitalize transition-colors disabled:opacity-50 ${
                    active
                      ? "border-[var(--coral-bright)]/60 bg-[var(--coral-bright)]/10 text-[var(--text-primary)]"
                      : "border-white/[0.08] text-[var(--text-muted)] hover:bg-white/5"
                  }`}
                >
                  {t(`codingAgent.effort.${level}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* The ceilings a run stops at — both the owner's to set. There is no
            time limit and no price limit: a run ends when it finishes, runs
            out of steps, hits a token ceiling if one is set, or goes quiet. */}

        {/* GitHub. Read-only here: connecting happens in a terminal running
            gh, which prints a device code for github.com. ClawBox never
            handles the token — gh keeps it and lends it to git. */}
        {github?.installed && (
          <div className="flex items-center justify-between gap-3 mt-4 rounded-xl border border-white/[0.08] px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">cloud_upload</span>
              <span className="text-xs text-[var(--text-secondary)]">GitHub</span>
              {github.connected ? (
                <span className="text-[11px] text-emerald-400 truncate" data-testid="coding-agent-github-login">
                  {github.login}
                </span>
              ) : github.reason === "unreachable" ? (
                // Not "not connected": we do not know whether an account is
                // connected, only that github.com could not be asked.
                <span className="text-[11px] text-amber-400" data-testid="coding-agent-github-unreachable">
                  {t("codingAgent.githubUnreachable")}
                </span>
              ) : (
                <span className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.githubOff")}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={connectGithub}
                data-testid="coding-agent-github-connect"
                className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
              >
                {github.connected ? t("codingAgent.githubReconnect") : t("codingAgent.githubConnect")}
              </button>
              {github.connected && (
                <button
                  type="button"
                  onClick={() => (confirmSignOut ? void disconnectGithub() : setConfirmSignOut(true))}
                  disabled={busy === "gh-out"}
                  data-testid="coding-agent-github-signout"
                  className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                    confirmSignOut
                      ? "border-red-400/40 text-red-300 hover:bg-red-400/10"
                      : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
                  }`}
                >
                  {confirmSignOut ? t("codingAgent.githubOutConfirm") : t("codingAgent.githubOut")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Runs behind a button. Opening the window is usually about the
            switch; the history is one click away when it is wanted. */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => { setShowRuns((v) => !v); setConfirmClear(false); setRunsShown(RUNS_PAGE); }}
            aria-expanded={showRuns}
            data-testid="coding-agent-runs-toggle"
            className="w-full flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">history</span>
              {t("codingAgent.recentRuns")}
              {runs.length > 0 && <span className="text-[var(--text-muted)]">({runs.length})</span>}
              {anyRunning && (
                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 border border-amber-400/40 rounded-full px-2 py-0.5">
                  {t("codingAgent.statusRunning")}
                </span>
              )}
            </span>
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
              {showRuns ? "expand_less" : "expand_more"}
            </span>
          </button>

          {showRuns && runs.length > 0 && (
            <div className="flex justify-end mt-2">
              <button
                type="button"
                onClick={() => (confirmClear ? void clearRuns() : setConfirmClear(true))}
                disabled={busy === "clear"}
                data-testid="coding-agent-clear"
                className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                  confirmClear
                    ? "border-red-400/40 text-red-300 hover:bg-red-400/10"
                    : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
                }`}
              >
                {confirmClear ? t("codingAgent.clearConfirm") : t("codingAgent.clearRuns")}
              </button>
            </div>
          )}

          {showRuns && (
            runs.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)] mt-2 px-1">{t("codingAgent.noRuns")}</p>
            ) : (
              <ul className="space-y-1.5 mt-2" data-testid="coding-agent-runs">
                {runs.slice(0, runsShown).map((run) => {
                  const details = [run.error, run.summary].filter(Boolean).join("\n\n");
                  const open = expanded === run.id;
                  return (
                    <li key={run.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${STATUS_CLASS[run.status]}`}>
                              {statusLabel(run.status)}
                            </span>
                            {/* Only while they are actually out: a count that
                                lingers at 0 is noise on every finished run. */}
                            {/* A run at high effort can be silent for minutes
                                on its first turn. Show that it is thinking, so
                                quiet never reads as stuck. */}
                            {run.status === "running" && (run.thinkingTokens ?? 0) > 0 && (
                              <span
                                data-testid="coding-agent-thinking"
                                className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40"
                              >
                                {t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 })}
                              </span>
                            )}
                            {/* One green dot per sub-agent, so the fan-out is
                                visible at a glance rather than read as a
                                number. Filled while working, hollow once done. */}
                            {(run.subagentsTotal ?? 0) > 0 && (
                              <span
                                className="flex items-center gap-1"
                                data-testid="coding-agent-subagent-dots"
                                title={Object.entries(run.subagentsByType ?? {}).map(([k, n]) => `${n}× ${k}`).join(", ")}
                              >
                                {Array.from({ length: Math.min(run.subagentsTotal ?? 0, 12) }).map((_, i) => (
                                  <span
                                    key={i}
                                    className={`inline-block h-2 w-2 rounded-full ${
                                      i < (run.subagentsActive ?? 0)
                                        ? "bg-emerald-400 animate-pulse"
                                        : "bg-emerald-400/35"
                                    }`}
                                  />
                                ))}
                                <span className="text-[10px] font-semibold text-emerald-400 ml-0.5">
                                  {run.subagentsTotal}
                                </span>
                              </span>
                            )}
                            {run.projectId && <span className="text-[11px] text-[var(--text-muted)]">{run.projectId}</span>}
                            <span className="text-[11px] font-mono text-[var(--text-muted)] opacity-60">{run.id}</span>
                          </div>
                          <p className="text-xs text-[var(--text-primary)] mt-1 break-words">{firstLine(run.task, 80)}</p>
                          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                            {t("codingAgent.runMeta", { turns: run.numTurns, files: run.filesTouched.length, duration: duration(run) })}
                            {" · "}
                            {run.source === "owner" ? t("codingAgent.startedByOwner") : t("codingAgent.startedByAgent")}
                            {run.effort && ` · ${t(`codingAgent.effort.${run.effort}`)}`}
                            {(run.tokensUsed ?? 0) > 0 && ` · ${tokens(run.tokensUsed ?? 0)} ${t("codingAgent.tokensWord")}`}
                            {(run.subagentsTotal ?? 0) > 0
                              && ` · ${Object.entries(run.subagentsByType ?? {}).map(([k, n]) => `${n}× ${k}`).join(", ")}`}
                            {run.permissionDenials > 0 && (
                              <span className="text-amber-400"> · {t("codingAgent.denials", { n: run.permissionDenials })}</span>
                            )}
                          </p>
                          {/* Which models did the work, and how fresh this is. */}
                          {((run.modelsUsed?.length ?? 0) > 0 || run.lastActivityAt) && (
                            <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-0.5" data-testid="coding-agent-run-stats">
                              {(run.modelsUsed?.length ?? 0) > 0 && run.modelsUsed?.join(" + ")}
                              {(run.modelsUsed?.length ?? 0) > 0 && run.lastActivityAt ? " · " : ""}
                              {run.lastActivityAt && `${t("codingAgent.updated")} ${since(run.lastActivityAt)}`}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {run.status === "running" && (
                            <button
                              type="button"
                              onClick={() => stop(run.id)}
                              disabled={busy === run.id}
                              className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-50"
                            >
                              {t("codingAgent.stop")}
                            </button>
                          )}
                          {/* Straight into the session: a live tail while it
                              works, or --resume once it has finished. */}
                          {github?.connected && run.commit && (
                            <button
                              type="button"
                              onClick={() => void backup(run)}
                              disabled={busy === `backup-${run.id}`}
                              data-testid={`coding-agent-backup-${run.id}`}
                              className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
                            >
                              {busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openInTerminal(run)}
                            data-testid={`coding-agent-terminal-${run.id}`}
                            title={run.status === "running" ? t("codingAgent.openLive") : t("codingAgent.openResume")}
                            className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                          >
                            {run.status === "running" ? t("codingAgent.openLive") : t("codingAgent.openResume")}
                          </button>
                          {details && (
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : run.id)}
                              aria-expanded={open}
                              className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                            >
                              {open ? t("codingAgent.hideDetails") : t("codingAgent.showDetails")}
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Which helpers are out and what each is doing — a
                          count alone does not say whether the run is stuck on
                          one search or fanned across three files. */}
                      {(run.activeSubagents?.length ?? 0) > 0 && (
                        <ul className="mt-2 space-y-1" data-testid="coding-agent-active-subagents">
                          {run.activeSubagents?.map((a, i) => (
                            <li key={i} className="flex items-start gap-2 text-[11px]">
                              <span className="material-symbols-rounded text-sky-400 animate-pulse shrink-0" style={{ fontSize: 13 }} aria-hidden="true">
                                sync
                              </span>
                              <span className="text-sky-300 font-medium shrink-0">{a.type}</span>
                              <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* What was refused, spelled out. The count alone said
                          "1 action was not allowed" and left the owner to
                          guess which — and the answer is usually a command
                          shape worth knowing about. */}
                      {open && (run.deniedActions?.length ?? 0) > 0 && (
                        <div className="mt-2" data-testid="coding-agent-denied">
                          <p className="text-[11px] font-medium text-amber-400">
                            {t("codingAgent.deniedTitle")}
                          </p>
                          <ul className="mt-1 space-y-0.5">
                            {run.deniedActions?.map((d, i) => (
                              <li key={i} className="text-[11px] font-mono text-[var(--text-muted)] break-all">{d}</li>
                            ))}
                          </ul>
                          <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
                            {t("codingAgent.deniedHelp")}
                          </p>
                        </div>
                      )}

                      {open && details && (
                        <pre className="mt-2 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-sans leading-relaxed">
                          {details}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          )}
          {showRuns && runs.length > runsShown && (
            <button
              type="button"
              onClick={() => setRunsShown((n) => n + RUNS_PAGE)}
              data-testid="coding-agent-runs-more"
              className="w-full mt-2 px-3 py-1.5 rounded-lg border border-white/[0.08] text-[11px] text-[var(--text-muted)] hover:bg-white/5"
            >
              {t("codingAgent.more")} ({runs.length - runsShown})
            </button>
          )}
        </div>

        {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
      </div>
    </div>
  );
}
