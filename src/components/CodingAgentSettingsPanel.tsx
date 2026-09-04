"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";
import DeviceCodeCard from "./DeviceCodeCard";
import HelpTip from "./HelpTip";
import { BTN_SECONDARY, CARD, FIELD, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";

/**
 * Settings → Coding Agent: everything the owner DECIDES about delegated
 * Claude Code runs (src/lib/coding-agent.ts), in one place.
 *
 * The switch, the default project folder, how hard a run thinks, the two
 * ceilings a run stops at, the automatic review pass, and the GitHub account
 * its work is backed up to.
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

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

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
  /** False until the owner finishes the setup wizard; the app shows the
   *  wizard instead of its home page while it is. */
  setupComplete: boolean;
  /** The owner's switch for branch -> pull request -> wait for checks ->
   *  merge. Optional: an older server does not answer with it. */
  autoPr?: boolean;
  /** The folder the device proposes when none is chosen: ~/Projects. The
   *  wizard pre-fills it, and saving it creates it. */
  suggestedDirectory?: string;
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
  /** The owner's switch for the automatic review pass: one more run, in the
   *  same session, after every completed run that changed files. */
  reviewPass: boolean;
  /** May a run draw pictures, and may the box draw the project's icon and
   *  favicon? Optional: an older server does not answer with it. ON by
   *  default, so the fallback below is `?? true`, not `?? false`. */
  generateImages?: boolean;
  /** May a run have this box speak a clip into its project? */
  generateAudio?: boolean;
}

/** How often to ask again while the GitHub answer is one we do not trust. */
const GITHUB_REPROBE_MS = 15_000;

/** How long a two-tap confirmation stays armed before the offer is taken back. */
const CONFIRM_MS = 5_000;

/**
 * Where a refusal is shown. The three typed fields carry theirs right under
 * the input that was refused; every other setting's lands at the foot of the
 * settings card, and GitHub's under the GitHub card. Before this the one
 * message sat below the GitHub card, a screen away from a Steps field that
 * still held the refused number.
 */
type ErrorSlot = "dir" | "turns" | "tokens" | "settings" | "github";
const FIELD_SLOTS: ReadonlySet<string> = new Set(["dir", "turns", "tokens"]);

/** The slowest cadence GitHub's device flow ever asks for, in seconds. */
const DEVICE_POLL_FLOOR_S = 5;

/**
 * The poll cadence the route answered, as seconds this card may use.
 *
 * Clamped to GitHub's own floor, and NOT `interval ?? 5`: a route that
 * answered `0` (or a string, or nothing) would otherwise turn into
 * `setInterval(fn, 0)` — a hot loop against the box and, through it, against
 * github.com. Exported for its test; the card is the only caller.
 */
export function devicePollSeconds(raw: unknown): number {
  const n = Number(raw);
  return Math.max(DEVICE_POLL_FLOOR_S, Number.isFinite(n) && n > 0 ? n : DEVICE_POLL_FLOOR_S);
}

// The app, this page and the wizard share one button system — see
// ./coding-agent-ui. SMALL_BUTTON is kept as the local name for the secondary
// role so the many call sites below read unchanged.
const SMALL_BUTTON = BTN_SECONDARY;

function Switch({
  checked, busy, disabled, label, onChange, testId = "coding-agent-switch",
}: {
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
  /** The main switch keeps the id it always had; the review pass has its own. */
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        // motion-safe: a spinner that keeps turning for an owner who asked
        // the OS for reduced motion is the one thing a spinner must not do.
        <span
          className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-muted)]"
          style={{ fontSize: 18 }}
          aria-hidden="true"
          data-testid={`${testId}-busy`}
        >
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
        data-testid={testId}
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
  onReset,
  onStatus,
}: {
  /** Called after a successful reset, so the host can leave this page: the
   *  settings it describes no longer exist and the window's front door is the
   *  setup wizard again. */
  onReset?: () => void;
  /** Every status the route answers with, as it arrives — the sidebar's
   *  "On · Max effort" subtitle is read off the same payload this panel
   *  renders, so the two can never disagree. */
  onStatus?: (status: AgentStatus) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [github, setGithub] = useState<GitHubState | null>(null);
  /** True after a GitHub read that did not answer — the fetch threw, or the
   *  route answered non-2xx. Kept apart from `github === null`, which is also
   *  what the card holds before the first read has come back. */
  const [githubUnread, setGithubUnread] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Which control's write is in flight — for that control's spinner. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Setting writes queued or in flight. Every setting control is disabled
   *  while this is above zero, so no second write can be started by hand. */
  const [pendingWrites, setPendingWrites] = useState(0);
  const [error, setError] = useState<{ slot: ErrorSlot; message: string } | null>(null);
  // Sign-out is two taps, like clearing history. The offer is taken back on
  // its own after CONFIRM_MS: an armed red button found minutes later is a
  // mis-tap waiting to happen. A timer rather than blur alone, because iOS
  // Safari does not focus a button on tap, so on a phone a blur never comes.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const confirmSignOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmSignOut = () => {
    if (confirmSignOutTimer.current) clearTimeout(confirmSignOutTimer.current);
    confirmSignOutTimer.current = null;
    setConfirmSignOut(false);
  };
  const armSignOut = () => {
    if (confirmSignOutTimer.current) clearTimeout(confirmSignOutTimer.current);
    confirmSignOutTimer.current = setTimeout(() => {
      confirmSignOutTimer.current = null;
      setConfirmSignOut(false);
    }, CONFIRM_MS);
    setConfirmSignOut(true);
  };
  useEffect(() => () => { if (confirmSignOutTimer.current) clearTimeout(confirmSignOutTimer.current); }, []);

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

  /** The switch and the settings — the half of the panel that must render
   *  whatever GitHub is doing. */
  const loadStatus = useCallback(async () => {
    try {
      const s = await fetch("/setup-api/coding-agent/status", { cache: "no-store" });
      if (!s.ok) throw new Error("status");
      const next = await s.json() as AgentStatus;
      publish(next);
      setDirDraft(prev => (prev === null ? (next.defaultDirectory ?? "") : prev));
      setTurnsDraft(prev => (prev === null ? String(next.maxTurns ?? "") : prev));
      setTokensDraft(prev => (prev === null ? (next.tokenLimit == null ? "" : String(next.tokenLimit)) : prev));
    } catch {
      setError({ slot: "settings", message: tRef.current("codingAgent.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [publish]);

  /** The GitHub card's answer, on its own: the re-probe below wants this one
   *  refreshed and nothing else — re-running the status load on a timer would
   *  fight the folder draft for no reason. */
  const loadGithub = useCallback(async () => {
    try {
      const g = await fetch("/setup-api/coding-agent/git", { cache: "no-store" });
      if (!g.ok) throw new Error(`HTTP ${g.status}`);
      setGithub(await g.json() as GitHubState);
      setGithubUnread(false);
    } catch {
      // Not new information about the account — the card keeps what it last
      // knew. It IS a reason to ask again: before anything is known, this flag
      // is what makes the re-probe below run at all.
      setGithubUnread(true);
    }
  }, []);

  // Two reads, each on its own. They used to share one `Promise.all`, so a
  // GitHub read that threw took the switch down with it — the panel sat
  // disabled over a perfectly good status because gh could not be asked.
  useEffect(() => {
    void loadStatus();
    void loadGithub();
  }, [loadStatus, loadGithub]);

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
  //
  // A read that never answered is inconclusive too: `github` stays null after
  // a 500 or a dropped connection, and null used to be excluded here — so the
  // card asked once, got nothing, and never asked again.
  const githubInconclusive = (github === null && githubUnread)
    || github?.reason === "unreachable"
    || (github !== null && github.installed && !github.connected && !github.reason);
  useEffect(() => {
    if (!githubInconclusive) return;
    const id = setInterval(() => { void loadGithub(); }, GITHUB_REPROBE_MS);
    return () => clearInterval(id);
  }, [githubInconclusive, loadGithub]);

  // While a device login is showing its code, ask github.com (through the
  // box) whether it was entered. A transient fetch failure keeps polling —
  // the code is still valid; only a verdict ends the wait.
  //
  // The cadence is the ROUTE's: every pending answer carries the interval
  // github.com currently allows, which grows when it says slow_down. The box
  // refuses to ask github.com early whatever this timer does, but a timer that
  // kept the old cadence would spend most of its ticks being told "not yet"
  // from memory — so the interval is re-read from each answer, and a change
  // reschedules the timer through the state it hangs off.
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
        const out = await res.json() as { status?: string; detail?: string; interval?: unknown };
        if (!alive) return;
        if (out.status === "pending" && out.interval !== undefined) {
          const interval = devicePollSeconds(out.interval);
          setDeviceLogin(prev => (prev && prev.interval !== interval ? { ...prev, interval } : prev));
        } else if (out.status === "connected") {
          setDeviceLogin(null);
          void loadGithub();
          // A run's Backup button exists only for a connected account; the
          // app that shows it has to hear that one now exists.
          notifyCodingAgentChanged();
        } else if (out.status === "failed") {
          setDeviceLogin(null);
          setError({ slot: "github", message: out.detail || tRef.current("codingAgent.githubStartFailed") });
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

  /** The setting write in flight, if any; the next one waits behind it. */
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * One writer for every setting — the route takes any one field and answers
   * the whole re-read status — and ONE AT A TIME. The route answers the
   * status as of its own write, so two writes in flight at once could land in
   * either order, and the older answer would then overwrite the newer state
   * on screen (and, through `publish`, in the sidebar). The controls are
   * disabled while a write is pending, and a write that slips in anyway (a
   * blur and a click in the same tick) is queued, not raced.
   *
   * `key` names the control, for its spinner — and, for the three typed
   * fields, the slot its refusal is shown in.
   */
  const saveSetting = (patch: Record<string, unknown>, key: string, failMsg: string): Promise<AgentStatus | null> => {
    setPendingWrites((n) => n + 1);
    const write = async (): Promise<AgentStatus | null> => {
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
        const slot = FIELD_SLOTS.has(key) ? key as ErrorSlot : "settings";
        setError({ slot, message: err instanceof Error ? err.message : failMsg });
        return null;
      } finally {
        setBusy(null);
        setPendingWrites((n) => n - 1);
      }
    };
    // `write` settles on its own (it catches), so the chain never poisons.
    const next = writeChain.current.then(write);
    writeChain.current = next;
    return next;
  };

  const toggle = (next: boolean) => saveSetting({ enabled: next }, "switch", t("codingAgent.toggleFailed"));

  const saveDirectory = async () => {
    const value = (dirDraft ?? "").trim();
    // "" clears it. The route answers the re-read status, so a symlink
    // comes back as the folder it actually leads to.
    const next = await saveSetting({ defaultDirectory: value === "" ? null : value }, "dir", t("codingAgent.folderFailed"));
    if (next) setDirDraft(next.defaultDirectory ?? "");
  };

  // The two blur-saved fields go back to the stored value whenever what was
  // typed is not saved — blank, or refused by the route. A draft left holding
  // a refused number would re-post that refusal on every blur, and the
  // message beside the field already says what was wrong with it. The folder
  // field is different: it saves only on an explicit Save or Enter, so a
  // mistyped path stays put to be corrected rather than retyped.
  const saveTurns = async () => {
    const stored = String(status?.maxTurns ?? "");
    // A blank Steps field means nothing — unlike a blank token field, which
    // is "no ceiling" — so it is never posted: Number("") is 0, which the
    // route refuses.
    if ((turnsDraft ?? "").trim() === "") {
      setTurnsDraft(stored);
      return;
    }
    const n = Number(turnsDraft);
    if (!Number.isFinite(n) || n === status?.maxTurns) return;
    const next = await saveSetting({ maxTurns: n }, "turns", t("codingAgent.turnsFailed"));
    setTurnsDraft(next ? String(next.maxTurns) : stored);
  };

  const saveTokens = async () => {
    const raw = (tokensDraft ?? "").trim();
    const limit = raw === "" ? null : Number(raw);
    if (limit !== null && !Number.isFinite(limit)) return;
    if (limit === (status?.tokenLimit ?? null)) return;
    const stored = status?.tokenLimit == null ? "" : String(status.tokenLimit);
    const next = await saveSetting({ tokenLimit: limit }, "tokens", t("codingAgent.tokensFailed"));
    setTokensDraft(next ? (next.tokenLimit == null ? "" : String(next.tokenLimit)) : stored);
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
      const data = await res.json() as { userCode: string; verificationUri: string; interval?: unknown };
      setDeviceLogin({ userCode: data.userCode, verificationUri: data.verificationUri, interval: devicePollSeconds(data.interval) });
    } catch (err) {
      setError({ slot: "github", message: err instanceof Error ? err.message : t("codingAgent.githubStartFailed") });
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
    const cmd = github?.loginCommand ?? "gh auth login --hostname github.com";
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command: cmd } }));
  };

  /** Disconnect GitHub. Two taps, like clearing history (see `armSignOut`):
   *  it is not destructive — pushed repositories stay — but it is not what
   *  anyone means to do by brushing a button. */
  const disconnectGithub = async () => {
    setBusy("gh-out");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/git", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.githubOutFailed")));
      setGithub(await res.json() as GitHubState);
      notifyCodingAgentChanged();
    } catch (err) {
      setError({ slot: "github", message: err instanceof Error ? err.message : t("codingAgent.githubOutFailed") });
      // A logout that failed leaves the row showing whatever it showed
      // before, which may no longer be true.
      void loadGithub();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="w-full" data-testid="coding-agent-settings-panel">
        <div className={`${CARD} h-24 motion-safe:animate-pulse`} data-testid="coding-agent-settings-loading" />
      </div>
    );
  }

  const readiness = status?.readiness;
  const saving = pendingWrites > 0;
  /** The refusal shown in one slot, if that is where it belongs. */
  const errorIn = (slot: ErrorSlot) => (
    error?.slot === slot ? <StatusMessage type="error" message={error.message} /> : null
  );

  return (
    <div className="w-full space-y-5" data-testid="coding-agent-settings-panel">
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
            disabled={!status || saving}
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
              disabled={saving || (dirDraft ?? "") === (status?.defaultDirectory ?? "")}
              className={BTN_SECONDARY}
            >
              {t("codingAgent.folderSave")}
            </button>
          </div>
          {errorIn("dir")}
        </div>

        {/* How hard a run thinks — Claude Code's own --effort. */}
        <div className="mt-4">
          <label className="text-xs font-medium text-[var(--text-secondary)]">
            {t("codingAgent.effortLabel")}
          </label>
          <div className={`${SEGMENTED_TRACK} mt-1.5`} data-testid="coding-agent-effort">
            {(status?.effortLevels ?? []).map((level) => {
              const active = status?.effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => void saveSetting({ effort: level }, "effort", t("codingAgent.effortFailed"))}
                  disabled={saving}
                  aria-pressed={active}
                  data-testid={`coding-agent-effort-${level}`}
                  className={active ? SEGMENT_ON : SEGMENT_OFF}
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
              disabled={saving}
              data-testid="coding-agent-turns"
              className={`w-full mt-1.5 text-base sm:text-xs ${FIELD}`}
            />
            {errorIn("turns")}
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
              disabled={saving}
              data-testid="coding-agent-tokens"
              className={`w-full mt-1.5 text-base sm:text-xs ${FIELD}`}
            />
            {errorIn("tokens")}
          </div>
        </div>

        {/* The automatic review pass: one more run, in the same session, after
            every completed run that changed files. It used to be reachable
            only by POSTing the field — an owner could neither find it nor
            see that it was on. Not optimistic, like the main switch. */}
        <div className="flex items-start justify-between gap-4 mt-4">
          <div className="min-w-0 flex items-center gap-1.5">
            {/* A span, not a label: the switch is a button, which no label can
                name, and it carries its own aria-label. */}
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.reviewPassLabel")}
            </span>
            <HelpTip
              text={t("codingAgent.reviewPassHint")}
              label={t("codingAgent.reviewPassLabel")}
              testId="coding-agent-review-pass-help"
            />
          </div>
          <Switch
            checked={status?.reviewPass ?? false}
            busy={busy === "review"}
            disabled={!status || saving}
            label={t("codingAgent.reviewPassLabel")}
            testId="coding-agent-review-pass"
            onChange={(next) => void saveSetting({ reviewPass: next }, "review", t("codingAgent.reviewPassFailed"))}
          />
        </div>

        {/* The two media switches. Under the review pass because they are
            about what a run may SPEND rather than how it works, and both are
            on unless the owner says otherwise — the pictures one also draws
            the project's own icon and favicon. */}
        <div className="flex items-start justify-between gap-4 mt-4">
          <div className="min-w-0 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.genImagesLabel")}
            </span>
            <HelpTip
              text={t("codingAgent.genImagesHint")}
              label={t("codingAgent.genImagesLabel")}
              testId="coding-agent-gen-images-help"
            />
          </div>
          <Switch
            checked={status?.generateImages ?? true}
            busy={busy === "genImages"}
            disabled={!status || saving}
            label={t("codingAgent.genImagesLabel")}
            testId="coding-agent-gen-images"
            onChange={(next) => void saveSetting({ generateImages: next }, "genImages", t("codingAgent.genImagesFailed"))}
          />
        </div>

        <div className="flex items-start justify-between gap-4 mt-4">
          <div className="min-w-0 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.genAudioLabel")}
            </span>
            <HelpTip
              text={t("codingAgent.genAudioHint")}
              label={t("codingAgent.genAudioLabel")}
              testId="coding-agent-gen-audio-help"
            />
          </div>
          <Switch
            checked={status?.generateAudio ?? true}
            busy={busy === "genAudio"}
            disabled={!status || saving}
            label={t("codingAgent.genAudioLabel")}
            testId="coding-agent-gen-audio"
            onChange={(next) => void saveSetting({ generateAudio: next }, "genAudio", t("codingAgent.genAudioFailed"))}
          />
        </div>

        {/* Branch -> pull request -> wait for Actions -> merge. Under the
            review pass because it runs after it, and the review's verdict is
            one of the things that gates the merge. */}
        <div className="flex items-start justify-between gap-4 mt-4">
          <div className="min-w-0 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {t("codingAgent.autoPrLabel")}
            </span>
            <HelpTip
              text={t("codingAgent.autoPrHint")}
              label={t("codingAgent.autoPrLabel")}
              testId="coding-agent-auto-pr-help"
            />
          </div>
          <Switch
            checked={status?.autoPr ?? false}
            busy={busy === "autoPr"}
            disabled={!status || saving}
            label={t("codingAgent.autoPrLabel")}
            testId="coding-agent-auto-pr"
            onChange={(next) => void saveSetting({ autoPr: next }, "autoPr", t("codingAgent.autoPrFailed"))}
          />
        </div>

        {errorIn("settings")}
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
                  onClick={() => { if (confirmSignOut) { disarmSignOut(); void disconnectGithub(); } else armSignOut(); }}
                  onBlur={disarmSignOut}
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
            <div className="mt-3" data-testid="coding-agent-github-device">
              <p className="text-[11px] text-[var(--text-secondary)] mb-2">{t("codingAgent.githubDeviceIntro")}</p>
              {/* The same card the ClawBox AI subscription shows. It used to be
                  its own smaller look with no Copy button at all, so the owner
                  hand-selected eight characters on a touch screen. */}
              <DeviceCodeCard
                code={deviceLogin.userCode}
                verificationUrl={deviceLogin.verificationUri}
                polling
                onNewCode={() => void connectGithub()}
                testId="coding-agent-github-device-code"
                actions={
                  <>
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
                  </>
                }
              />
            </div>
          )}
          {errorIn("github")}
        </div>
      )}
    </div>
  );
}
