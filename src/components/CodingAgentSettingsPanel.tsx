"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";

/**
 * Settings → Coding Agent: everything the owner DECIDES about delegated
 * Claude Code runs (src/lib/coding-agent.ts), in one place.
 *
 * The switch, the default project folder, how hard a run thinks, the two
 * ceilings a run stops at, and the GitHub account its work is backed up to.
 * These used to sit at the top of the Coding Agent desktop app, above the
 * run history; the owner wanted the app to be about the runs and the
 * settings to live with the other settings. The app keeps the readiness
 * header and the runs, and links here.
 *
 * The switch is the CONSENT for a feature that edits files unattended, which
 * is why the route behind it refuses the agent's own credential — see
 * src/app/setup-api/coding-agent/enable/route.ts. Like SystemProfilePanel the
 * switch is not optimistic: it renders the state the route answers with.
 *
 * The types below are the wire shapes of `/setup-api/coding-agent/status`
 * and `/setup-api/coding-agent/git`. They are exported because the app reads
 * the same two answers for its header and its Backup buttons, and one
 * definition is the only way the two surfaces cannot drift.
 */

export interface Readiness {
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

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface GitHubState {
  installed: boolean;
  connected: boolean;
  login: string | null;
  loginCommand: string;
  /** "unreachable" means gh is here but could not reach github.com — a
   *  network fault. "not_runnable" means it is here and would not execute, so
   *  the remedy is permissions, not `gh auth login`. Neither reads like a
   *  missing install, and neither reads like "not connected": every reason the
   *  library can answer has an arm below, or the card says something false. */
  reason?: "not_installed" | "unreachable" | "not_runnable";
}

export interface AgentStatus {
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

/** How often to ask again while the GitHub answer is one we do not trust. */
const GITHUB_REPROBE_MS = 15_000;

const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";
const FIELD = "rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-1.5 font-mono text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]/50";
const SMALL_BUTTON = "text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50";

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

export default function CodingAgentSettingsPanel({
  onStatus,
}: {
  /** Every status the route answers with, as it arrives — the sidebar's
   *  "On · Max effort" subtitle is read off the same payload this panel
   *  renders, so the two can never disagree. */
  onStatus?: (status: AgentStatus) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [github, setGithub] = useState<GitHubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** A device-flow login in flight: the code the card shows and how often to
   *  ask github.com whether it was entered. */
  const [deviceLogin, setDeviceLogin] = useState<{ userCode: string; verificationUri: string; interval: number } | null>(null);
  // The typed fields are DRAFTS until saved, so typing does not fight the
  // status the route keeps returning.
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const [turnsDraft, setTurnsDraft] = useState<string | null>(null);
  const [tokensDraft, setTokensDraft] = useState<string | null>(null);

  // `load` must not re-run because a translation function or a parent's
  // callback was re-created: a refetch on every render would overwrite a
  // freshly toggled switch with the stale status it read a moment earlier.
  // Read both through refs instead, synchronised after commit so a discarded
  // render never leaks into them.
  const tRef = useRef(t);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    tRef.current = t;
    onStatusRef.current = onStatus;
  }, [t, onStatus]);

  /** The one place a status lands: the panel and the sidebar see the same one. */
  const publish = useCallback((next: AgentStatus) => {
    setStatus(next);
    onStatusRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([
        fetch("/setup-api/coding-agent/status", { cache: "no-store" }),
        fetch("/setup-api/coding-agent/git", { cache: "no-store" }),
      ]);
      if (!s.ok) throw new Error("status");
      const next = await s.json() as AgentStatus;
      publish(next);
      setDirDraft(prev => (prev === null ? (next.defaultDirectory ?? "") : prev));
      setTurnsDraft(prev => (prev === null ? String(next.maxTurns ?? "") : prev));
      setTokensDraft(prev => (prev === null ? (next.tokenLimit == null ? "" : String(next.tokenLimit)) : prev));
      if (g.ok) setGithub(await g.json() as GitHubState);
    } catch {
      setError(tRef.current("codingAgent.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [publish]);

  useEffect(() => { void load(); }, [load]);

  /** Just the GitHub half of `load()`. The re-probe below wants this one answer
   *  refreshed and nothing else: re-running the whole load on a timer would also
   *  fight the folder draft for no reason. */
  const loadGithub = useCallback(async () => {
    try {
      const g = await fetch("/setup-api/coding-agent/git", { cache: "no-store" });
      if (g.ok) setGithub(await g.json() as GitHubState);
    } catch {
      // A failed re-probe is not new information — the card already says the
      // uplink is down. Leave the badge alone and ask again next tick.
    }
  }, []);

  // `githubStatus()` refuses to cache an `unreachable` answer, and says why:
  // "caching one would outlive the outage that produced it and go on refusing
  // backups after the uplink came back". Holding it in React state and never
  // asking again is that same cache one layer out — the card went on saying
  // "GitHub unreachable" for as long as the panel stayed mounted, with no
  // refresh affordance, long after the uplink was back.
  //
  // Two states re-probe. "unreachable" is inconclusive by nature. "Not
  // connected" with no settled reason is the other one that changes behind
  // the card's back: the owner logs in from a terminal (`gh auth login`) or
  // from a phone, and the card kept saying "not connected" until a reload —
  // which reads as the login having failed. "not_installed" and
  // "not_runnable" are properties of the box, not of this moment, and
  // polling them would be a timer with nothing to learn.
  const githubInconclusive = github?.reason === "unreachable"
    || (github !== null && github.installed && !github.connected && !github.reason);
  useEffect(() => {
    if (!githubInconclusive) return;
    const id = setInterval(() => { void loadGithub(); }, GITHUB_REPROBE_MS);
    return () => clearInterval(id);
  }, [githubInconclusive, loadGithub]);

  // While a device login is showing its code, ask github.com (through the
  // box) whether it was entered. A transient fetch failure keeps polling —
  // the code is still valid; only a verdict ends the wait.
  useEffect(() => {
    if (!deviceLogin) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/coding-agent/github-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "poll" }),
        });
        if (!res.ok || !alive) return;
        const out = await res.json() as { status?: string; detail?: string };
        if (!alive) return;
        if (out.status === "connected") {
          setDeviceLogin(null);
          void loadGithub();
          // A run's Backup button exists only for a connected account; the
          // app that shows it has to hear that one now exists.
          notifyCodingAgentChanged();
        } else if (out.status === "failed") {
          setDeviceLogin(null);
          setError(out.detail || tRef.current("codingAgent.githubStartFailed"));
        }
      } catch {
        // Transient; keep polling.
      }
    }, deviceLogin.interval * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [deviceLogin, loadGithub]);

  const readError = async (res: Response, fallback: string) => {
    try {
      const data = await res.json() as { error?: string };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  /** One writer for every setting — the route takes any one field and
   *  answers the whole re-read status. */
  const saveSetting = async (patch: Record<string, unknown>, key: string, failMsg: string): Promise<AgentStatus | null> => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res, failMsg));
      const next = await res.json() as AgentStatus;
      publish(next);
      // The Coding Agent app is another window; its On/Off chip and its
      // readiness checklist follow what was just saved.
      notifyCodingAgentChanged();
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : failMsg);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const toggle = (next: boolean) => saveSetting({ enabled: next }, "switch", t("codingAgent.toggleFailed"));

  const saveDirectory = async () => {
    const value = (dirDraft ?? "").trim();
    // "" clears it. The route answers the re-read status, so a symlink
    // comes back as the folder it actually leads to.
    const next = await saveSetting({ defaultDirectory: value === "" ? null : value }, "dir", t("codingAgent.folderFailed"));
    if (next) setDirDraft(next.defaultDirectory ?? "");
  };

  const saveTurns = async () => {
    // A blank Steps field means nothing — unlike a blank token field, which
    // is "no ceiling" — so it goes back to the stored value rather than
    // being posted: Number("") is 0, which the route refuses, and a draft
    // left blank would re-post that refusal on every blur.
    if ((turnsDraft ?? "").trim() === "") {
      setTurnsDraft(String(status?.maxTurns ?? ""));
      return;
    }
    const n = Number(turnsDraft);
    if (!Number.isFinite(n) || n === status?.maxTurns) return;
    const next = await saveSetting({ maxTurns: n }, "turns", t("codingAgent.turnsFailed"));
    if (next) setTurnsDraft(String(next.maxTurns));
  };

  const saveTokens = async () => {
    const raw = (tokensDraft ?? "").trim();
    const limit = raw === "" ? null : Number(raw);
    if (limit !== null && !Number.isFinite(limit)) return;
    if (limit === (status?.tokenLimit ?? null)) return;
    const next = await saveSetting({ tokenLimit: limit }, "tokens", t("codingAgent.tokensFailed"));
    if (next) setTokensDraft(next.tokenLimit == null ? "" : String(next.tokenLimit));
  };

  /** The GitHub device flow, driven by this card so it works from a phone:
   *  show the one-time code with a tappable github.com link and poll until
   *  the owner approves. The token never reaches the browser — the route
   *  hands it straight to gh's stdin. */
  const connectGithub = async () => {
    setBusy("gh-connect");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/github-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.githubStartFailed")));
      const data = await res.json() as { userCode: string; verificationUri: string; interval?: number };
      setDeviceLogin({ userCode: data.userCode, verificationUri: data.verificationUri, interval: data.interval ?? 5 });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.githubStartFailed"));
    } finally {
      setBusy(null);
    }
  };

  const cancelGithubLogin = () => {
    setDeviceLogin(null);
    void fetch("/setup-api/coding-agent/github-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    }).catch(() => { /* the pending code simply expires */ });
  };

  /** The terminal fallback — the flow this card ran before it grew its own. */
  const connectGithubTerminal = () => {
    cancelGithubLogin();
    const cmd = github?.loginCommand ?? "gh auth login --hostname github.com --git-protocol https";
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command: cmd } }));
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
      notifyCodingAgentChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.githubOutFailed"));
      // A logout that failed leaves the row showing whatever it showed
      // before, which may no longer be true.
      void loadGithub();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="max-w-xl" data-testid="coding-agent-settings-panel">
        <div className={`${CARD} h-24 animate-pulse`} />
      </div>
    );
  }

  const readiness = status?.readiness;

  return (
    <div className="max-w-xl space-y-5" data-testid="coding-agent-settings-panel">
      <div className={CARD}>
        {/* One row: what this is, and whether it is on. */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">smart_toy</span>
              <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                {t("settings.codingAgent")}
              </label>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("settings.codingAgentHint")}</p>
          </div>
          <Switch
            checked={status?.enabled ?? false}
            busy={busy === "switch"}
            disabled={!status}
            label={t("codingAgent.switchLabel")}
            onChange={(next) => void toggle(next)}
          />
        </div>

        {/* A switch that is on over a harness that cannot run is the one
            state worth a sentence here; the app's header carries the full
            checklist. */}
        {status?.enabled && readiness && !readiness.ready && readiness.problems.length > 0 && (
          <p className="text-[11px] text-amber-400 mt-3 leading-relaxed" role="alert">
            {readiness.problems.join(" ")}
          </p>
        )}

        {/* Where work goes when the assistant does not name a project. */}
        <div className="mt-4">
          <label htmlFor="coding-agent-dir" className="text-xs font-medium text-[var(--text-secondary)]">
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
              // zoom the page on focus, which scrolls the rest of the
              // settings out of view.
              className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
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

        {/* How hard a run thinks — Claude Code's own --effort. */}
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
            out of steps, hits a token ceiling if one is set, or goes quiet.
            Saved on blur and on Enter, so a half-typed number is never sent. */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <div>
            <label htmlFor="coding-agent-turns" className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.turnsLabel")}
            </label>
            <input
              id="coding-agent-turns"
              type="number"
              inputMode="numeric"
              min={status?.minMaxTurns ?? 10}
              max={status?.maxMaxTurns ?? 2000}
              value={turnsDraft ?? ""}
              onChange={(e) => setTurnsDraft(e.target.value)}
              onBlur={() => void saveTurns()}
              onKeyDown={(e) => { if (e.key === "Enter") void saveTurns(); }}
              disabled={busy === "turns"}
              data-testid="coding-agent-turns"
              className={`w-full mt-1.5 text-base sm:text-xs ${FIELD}`}
            />
          </div>
          <div>
            <label htmlFor="coding-agent-tokens" className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.tokensLabel")}
            </label>
            <input
              id="coding-agent-tokens"
              type="number"
              inputMode="numeric"
              min={status?.minTokenLimit ?? 10000}
              placeholder={t("codingAgent.tokensPlaceholder")}
              value={tokensDraft ?? ""}
              onChange={(e) => setTokensDraft(e.target.value)}
              onBlur={() => void saveTokens()}
              onKeyDown={(e) => { if (e.key === "Enter") void saveTokens(); }}
              disabled={busy === "tokens"}
              data-testid="coding-agent-tokens"
              className={`w-full mt-1.5 text-base sm:text-xs ${FIELD}`}
            />
          </div>
        </div>
      </div>

      {/* GitHub. gh keeps the token and lends it to git; ClawBox never
          handles it. Shown only when gh is on the box at all. */}
      {github?.installed && (
        <div className={CARD} data-testid="coding-agent-github-card">
          <div className="flex items-center justify-between gap-3">
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
              ) : github.reason === "not_runnable" ? (
                // gh is on the box and would not start. "Not connected" is not
                // what was found, and Connect — which ends by handing a token
                // to that very binary — is the one remedy that cannot work.
                <span className="text-[11px] text-amber-400" data-testid="coding-agent-github-not-runnable">
                  {t("codingAgent.githubNotRunnable")}
                </span>
              ) : (
                <span className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.githubOff")}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Not offered to a gh that would not start: the flow ends by
                  handing the token to that very binary. The badge beside it
                  says what to fix. */}
              {github.reason !== "not_runnable" && (
                <button
                  type="button"
                  onClick={() => void connectGithub()}
                  disabled={busy === "gh-connect" || deviceLogin !== null}
                  data-testid="coding-agent-github-connect"
                  className={SMALL_BUTTON}
                >
                  {github.connected ? t("codingAgent.githubReconnect") : t("codingAgent.githubConnect")}
                </button>
              )}
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

          {/* A device login in flight: the code, big and selectable, and a
              TAPPABLE link — this flow exists because `gh auth login` in a
              terminal on a phone tries xdg-open on the box and buries the URL.
              The card polls; nothing else to type on this device. */}
          {deviceLogin && (
            <div className="mt-3 rounded-xl border border-sky-400/30 bg-sky-400/[0.06] px-3 py-3" data-testid="coding-agent-github-device">
              <p className="text-[11px] text-[var(--text-secondary)]">{t("codingAgent.githubDeviceIntro")}</p>
              <p className="mt-2 text-center font-mono text-xl tracking-[0.3em] text-white select-all" data-testid="coding-agent-github-code">
                {deviceLogin.userCode}
              </p>
              <a
                href={deviceLogin.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block w-full text-center text-xs font-semibold px-3 py-2 rounded-lg bg-[var(--coral-bright)] text-white hover:opacity-90"
              >
                {t("codingAgent.githubDeviceOpen")}
              </a>
              <p className="mt-2 text-center text-[11px] text-[var(--text-muted)] animate-pulse">{t("codingAgent.githubDeviceWaiting")}</p>
              <div className="mt-1.5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={cancelGithubLogin}
                  data-testid="coding-agent-github-device-cancel"
                  className="text-[11px] text-[var(--text-muted)] underline decoration-white/20 hover:text-white"
                >
                  {t("codingAgent.githubDeviceCancel")}
                </button>
                <button
                  type="button"
                  onClick={connectGithubTerminal}
                  className="text-[11px] text-[var(--text-muted)] underline decoration-white/20 hover:text-white"
                >
                  {t("codingAgent.githubDeviceTerminal")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
