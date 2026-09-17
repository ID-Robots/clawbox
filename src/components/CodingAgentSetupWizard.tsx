"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged, notifyCodingRunStarted } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";
import DeviceCodeCard from "./DeviceCodeCard";
import CodingAgentDelegationArt from "./CodingAgentDelegationArt";
import PaidFeatureGate, { PAID_GATE_POLL_MS, paidGateFace } from "./PaidFeatureGate";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";
import { browserErrorText, runBrowserAction } from "@/lib/browser-actions";
import { IMPROVEMENT_MODES, IMPROVEMENT_MODE_KEYS, type ImprovementMode } from "./ImprovementProgramCard";
import { startHarnessTest } from "@/lib/coding-agent-harness-test";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import {
  devicePollSeconds,
  type AgentStatus,
  type Effort,
  type GitHubState,
} from "./CodingAgentSettingsPanel";

/**
 * First-run setup for the coding agent, shown inside the Coding Agent window
 * until the owner finishes it (`status.setupComplete`).
 *
 * Why a wizard and not just the settings page: switching this on is consent
 * for a delegated shell, and the two settings that decide what such a run can
 * reach — the GitHub account it pushes with and the folder it works in — used
 * to be four scrolls apart on a page the owner had no reason to open. The
 * wizard asks for them in the order a run needs them, once — with the ClawBox
 * Improvement Program between them, right after GitHub, because its reports
 * go out on that account.
 *
 * Settings keeps every one of these controls: this is an onboarding path over
 * the same routes, never the only way to change any of them.
 */

// One button system with the app and the settings page — see ./coding-agent-ui.
const SMALL_BUTTON = BTN_SECONDARY;
const PRIMARY = BTN_PRIMARY;

type Step = "intro" | "github" | "improvement" | "project" | "browser" | "harness";

type BrowseAnswer = {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated?: boolean;
};

export default function CodingAgentSetupWizard({
  status,
  onDone,
}: {
  status: AgentStatus;
  /** The app re-reads its own status; the wizard does not own that state. */
  /** Setup is finished; `runId` names the harness run when one was started. */
  onDone: (runId?: string | null) => void;
}) {
  const { t } = useT();
  // The paid-plan gate (owner's decision, 2026-09-14). Polled rather than read
  // off `status`, so an owner who subscribes in another tab is let through
  // without reopening the window; the server refuses the same three states in
  // /setup-api/coding-agent/enable.
  const clawboxLogin = useClawboxLogin(PAID_GATE_POLL_MS);
  const gated = paidGateFace(clawboxLogin) !== "satisfied";
  const [chosenStep, setStep] = useState<Step>("intro");
  const [startedBusy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The gate governs the WHOLE wizard, not just its front door.
   *
   * The plan poll runs behind every step, so a subscription that lapses — or a
   * credential withdrawn — while the owner is three steps in must not leave
   * the finishing button live: the enable route would answer 402 at the end of
   * a flow that had already installed Chromium and started a test run. While
   * the gate is shut the only step there is, is the intro — which is where the
   * gate is drawn and says why.
   *
   * DERIVED, not corrected in an effect. There is nothing to store: "which
   * step is on screen" is a function of the step the owner chose and whether
   * the plan still covers this, and an effect that wrote the answer back would
   * be a cascading render (`react-hooks/set-state-in-effect`) for a value that
   * was never state. It cannot fire on the poll's own first tick either way:
   * the wizard opens on the intro, and `useClawboxLogin` preserves its last
   * answer across a failed poll rather than reporting a downgrade.
   *
   * The owner's chosen step is KEPT, so a plan restored in another tab puts
   * them back where they were rather than at the start.
   */
  const step: Step = gated ? "intro" : chosenStep;
  /** Nothing is in flight from the owner's point of view while the gate is shut. */
  const busy = gated ? null : startedBusy;

  // ─── GitHub (step 1) ───
  const [github, setGithub] = useState<GitHubState | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<
    { userCode: string; verificationUri: string; interval: number } | null
  >(null);

  const loadGithub = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/coding-agent/git");
      if (res.ok) setGithub((await res.json()) as GitHubState);
    } catch {
      // The step can be skipped; a failed read must not strand the wizard.
    }
  }, []);
  useEffect(() => { void loadGithub(); }, [loadGithub]);

  // Same cadence rule as the settings card: the interval is the ROUTE's, and a
  // changed one reschedules the timer through the state it hangs off.
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
        const out = (await res.json()) as { status?: string; detail?: string; interval?: unknown };
        if (!alive) return;
        if (out.status === "pending" && out.interval !== undefined) {
          const interval = devicePollSeconds(out.interval);
          setDeviceLogin((prev) => (prev && prev.interval !== interval ? { ...prev, interval } : prev));
        } else if (out.status === "connected") {
          setDeviceLogin(null);
          void loadGithub();
          notifyCodingAgentChanged();
        } else if (out.status === "failed") {
          setDeviceLogin(null);
          setError(out.detail || t("codingAgent.githubStartFailed"));
        }
      } catch {
        // Transient; keep polling.
      }
    }, deviceLogin.interval * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [deviceLogin, loadGithub, t]);

  const connectGithub = async () => {
    setBusy("gh");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/github-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (!res.ok) throw new Error(t("codingAgent.githubStartFailed"));
      const data = (await res.json()) as { userCode: string; verificationUri: string; interval?: unknown };
      setDeviceLogin({
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        interval: devicePollSeconds(data.interval),
      });
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

  // ─── The ClawBox Improvement Program (step 2) ───
  // Asked here, right after GitHub, because a report is `gh issue create` on
  // that credential. AUTOMATIC IS PRESELECTED — the STORED default stays
  // `off` (src/lib/incident-report.ts: it is a consent, and an unreadable
  // value must read as "send nothing"), and it is this preselection plus the
  // owner's Continue that opts a new box in. There is no Skip: Continue with
  // Off chosen is how the owner declines, and it is written explicitly all
  // the same, so the box records an answer rather than an absence.
  const [improvementMode, setImprovementMode] = useState<ImprovementMode>("auto");
  const [maxIssuesPerDay, setMaxIssuesPerDay] = useState(5);
  const improvementRefs = useRef<Partial<Record<ImprovementMode, HTMLButtonElement | null>>>({});
  /** The owner has picked on the step: a read that lands later must not undo it. */
  const improvementTouched = useRef(false);

  const loadImprovement = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/improvement-program", { cache: "no-store" });
      if (!res.ok) return;
      const out = (await res.json()) as { mode?: unknown; answered?: unknown; maxIssuesPerDay?: unknown };
      // The daily cap the box actually enforces is the number the Automatic
      // hint names; a read that fails keeps the card's own fallback.
      if (typeof out.maxIssuesPerDay === "number" && Number.isFinite(out.maxIssuesPerDay)) {
        setMaxIssuesPerDay(out.maxIssuesPerDay);
      }
      // The owner's own pick on this step wins over a read that lands late:
      // the GET waits on `gh auth status`, which is seconds on a slow link.
      if (improvementTouched.current) return;
      // Otherwise a box that already ANSWERED keeps its answer on screen —
      // Off included. This wizard runs again after Start over, and proposing
      // Automatic over an explicit "ask me", or over an explicit decline,
      // would quietly widen it on Continue. Automatic is proposed only over
      // "never asked". A server that predates `answered` sends none, and
      // there `off` cannot be told from never asked.
      const known = out.mode === "off" || out.mode === "ask" || out.mode === "auto";
      if (out.answered === true && known) setImprovementMode(out.mode as ImprovementMode);
      else if (out.mode === "ask" || out.mode === "auto") setImprovementMode(out.mode);
    } catch {
      // Best effort: the step still asks, and Continue still writes.
    }
  }, []);
  useEffect(() => { void loadImprovement(); }, [loadImprovement]);

  const saveImprovement = async () => {
    setBusy("improvement");
    setError(null);
    try {
      const res = await fetch("/setup-api/improvement-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: improvementMode }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("improvement.saveFailed"));
      }
      setStep("project");
    } catch (err) {
      // Stay on the step: an answer the box did not record is not an answer.
      setError(err instanceof Error ? err.message : t("improvement.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** The radiogroup contract, as on the settings card: arrows move AND choose. */
  const moveImprovementWithArrows = (event: React.KeyboardEvent, current: ImprovementMode) => {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1
      : 0;
    if (delta === 0) return;
    event.preventDefault();
    const n = IMPROVEMENT_MODES.length;
    const next = IMPROVEMENT_MODES[(IMPROVEMENT_MODES.indexOf(current) + delta + n) % n];
    improvementRefs.current[next]?.focus();
    improvementTouched.current = true;
    setImprovementMode(next);
  };

  // ─── Project folder + how a run thinks (step 3) ───
  // Pre-filled with what the device proposes (~/Projects) so the common case
  // is one tap. The folder need not exist yet — saving creates it, as long as
  // it is inside the owner's home.
  const [folder, setFolder] = useState(status.defaultDirectory ?? status.suggestedDirectory ?? "");
  // Ultracode is the default the wizard proposes: it is what the harness ships
  // with, and the step says plainly what that costs.
  const [effort, setEffort] = useState<Effort>(status.effort ?? "ultracode");
  const [reviewPass, setReviewPass] = useState(status.reviewPass);

  const [browse, setBrowse] = useState<BrowseAnswer | null>(null);
  /** The "Create folder" field, open only while the owner is naming one. */
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const browseAbort = useRef<AbortController | null>(null);

  const openBrowse = useCallback(async (dir?: string) => {
    browseAbort.current?.abort();
    const ctl = new AbortController();
    browseAbort.current = ctl;
    setBrowsing(true);
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      let res = await fetch(`/setup-api/coding-agent/browse${qs}`, { signal: ctl.signal });
      // The pre-filled ~/Projects need not exist yet — saving is what creates
      // it. Opening the picker there would 404, so fall back to the root
      // rather than showing the owner an error for a folder we proposed.
      if (res.status === 404 && dir) {
        res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      }
      if (!res.ok) throw new Error(t("codingAgent.wizardBrowseFailed"));
      setBrowse((await res.json()) as BrowseAnswer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : t("codingAgent.wizardBrowseFailed"));
    } finally {
      setBrowsing(false);
    }
  }, [t]);
  useEffect(() => () => browseAbort.current?.abort(), []);

  /**
   * Create a folder in the directory on screen and step into it.
   *
   * Stepping in is the point: the owner opened this to choose a working
   * folder, and one they just made is almost always the one they meant — the
   * alternative is making it, then hunting for it in the list they were
   * already looking at.
   */
  const createFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name || !browse) return;
    setBusy("mkdir");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: browse.path, name }),
      });
      const out = await res.json().catch(() => null) as (BrowseAnswer & { created?: string; error?: string }) | null;
      if (!res.ok) throw new Error(out?.error || t("codingAgent.wizardCreateFolderFailed"));
      setNewFolder(null);
      if (out?.created) await openBrowse(out.created);
      else if (out) setBrowse(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.wizardCreateFolderFailed"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Save what the wizard collected and switch the agent ON — but do NOT mark
   * setup finished yet. The last step offers a real test run, and a run needs
   * an enabled, configured agent to exist at all; marking setup complete here
   * would also drop the owner on the home page before they got to it.
   */
  const saveAndTest = async () => {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultDirectory: folder.trim() === "" ? null : folder.trim(),
          effort,
          reviewPass,
          enabled: true,
          // Explicitly NOT finished: there is one step left. Without this the
          // box has no flag, `enabled` stands in for one, and the app decides
          // setup is complete the moment the switch goes on.
          setupComplete: false,
        }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("codingAgent.wizardFinishFailed"));
      }
      notifyCodingAgentChanged();
      setStep("browser");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.wizardFinishFailed"));
    } finally {
      setBusy(null);
    }
  };

  // ─── Which browser a run verifies its work in (step 4) ───

  /**
   * Write the owner's answer, and nothing else.
   *
   * Separate from making the browser ready, and always first, because it IS
   * the answer to the question this step asks: a box whose apt mirror is
   * unreachable this afternoon must not have "yes" recorded as "no". A run on
   * a box where the screen's Chromium cannot be started falls back to the
   * invisible one by itself, so an enabled setting over a browser that would
   * not open is degraded, never broken.
   */
  const saveRealBrowser = async (realBrowser: boolean): Promise<boolean> => {
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realBrowser }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("codingAgent.wizardBrowserFailed"));
      }
      notifyCodingAgentChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.wizardBrowserFailed"));
      return false;
    }
  };

  /**
   * Say yes, then make it true: the window a run will drive has to exist
   * before a run can drive it, and this step is the only moment in the flow
   * where the owner is being asked about it.
   *
   * "Chromium is not installed" is discovered as a REFUSAL rather than probed
   * for first. The manage route names that case with a stable code, and a
   * status read beforehand would cost every box a round trip to learn what all
   * but a fresh one already answer — while the install itself is minutes of
   * apt, which is why it gets a label of its own.
   */
  const enableBrowser = async () => {
    setBusy("browser");
    setError(null);
    if (!(await saveRealBrowser(true))) {
      setBusy(null);
      return;
    }
    let result = await runBrowserAction("open-browser");
    if (!result.ok && result.code === "chromium_not_installed") {
      setBusy("browser-install");
      const install = await runBrowserAction("install-chromium");
      result = install.ok ? await runBrowserAction("open-browser") : install;
    }
    setBusy(null);
    if (!result.ok) {
      // The setting is saved; only the window is missing. Say which of the two
      // failed in the device's own terms and leave the way forward open — the
      // Browser app opens it later, and a run uses the invisible browser
      // meanwhile.
      setError(browserErrorText(t, result));
      return;
    }
    setStep("harness");
  };

  const skipBrowser = async () => {
    setBusy("browser-skip");
    setError(null);
    const saved = await saveRealBrowser(false);
    setBusy(null);
    if (saved) setStep("harness");
  };

  /**
   * Mark setup finished. Called by both ways out of the last step — running
   * the test and skipping it — because the test is an offer, not a gate: a
   * box whose harness is not ready yet is still a configured box.
   */
  const finish = async (runId: string | null = null) => {
    // The plan is re-read at the moment of the act, not only at the render
    // that drew the button: `setupComplete: true` is one of the two bodies the
    // route refuses, and sending it after a subscription lapsed mid-wizard
    // would spend a 402 on a question the box can answer itself. The derived
    // step has already put the intro on screen, so there is nothing to set.
    if (gated) return;
    setBusy("finish");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupComplete: true }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("codingAgent.wizardFinishFailed"));
      }
      notifyCodingAgentChanged();
      onDone(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.wizardFinishFailed"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * The offered smoke test: scaffold the scratch project, start the canned run,
   * then finish setup with the run's id, so the owner lands on the RUN's page
   * with it already in flight. Home used to be the landing — from before the
   * runs moved off it: the owner who had just pressed "Try it once" was shown
   * the project list, with the run they were promised a dot in the rail.
   */
  const runHarnessTest = async () => {
    setBusy("harness");
    setError(null);
    try {
      // The folder the owner just chose, not a ClawBox-internal one. It is
      // saved by now: this step runs after saveAndTest().
      const started = await startHarnessTest(folder.trim() || null, t);
      if (!started.ok) throw new Error(started.error);
      notifyCodingRunStarted();
      await finish(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.harnessTestFailed"));
      setBusy(null);
    }
  };

  const stepNumber = step === "github" ? 1
    : step === "improvement" ? 2
    : step === "project" ? 3
    : step === "browser" ? 4
    : 5;
  const TOTAL_STEPS = 5;

  return (
    <div
      className={step === "intro" ? "mt-4 flex-1 flex flex-col" : `${CARD} mt-4`}
      data-testid="coding-agent-wizard"
    >
      {step !== "intro" && (
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t("codingAgent.wizardStepOf", { n: stepNumber, total: TOTAL_STEPS })}
        </p>
      )}

      {/* ── The front door: what this is, and one button that starts it. ── */}
      {step === "intro" && (
        // No card around this one: it is the first thing in an otherwise empty
        // window, and a box drawn around a single paragraph made it look like a
        // notice rather than a front door. Centred, with the diagram carrying
        // the top of the screen.
        // The BLOCK is centred in the window; the TEXT inside it is not.
        //
        // Centred body copy makes the eye hunt for the start of every line,
        // because no two lines begin in the same place — fine for one line, bad
        // for three. So the column is centred and everything inside it hangs
        // off one left edge: the diagram, the heading, the paragraph and the
        // button all start at the same x.
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-8">
          <div className="w-full max-w-[26rem] text-left">
            <CodingAgentDelegationArt className="mb-7" />
            <h2 className="text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("codingAgent.wizardTitle")}
            </h2>
            {/* ~46 characters a line: long enough not to fragment the sentence,
                short enough to keep the return sweep easy. */}
            <p className="mt-2.5 text-xs leading-[1.7] text-[var(--text-secondary)]">
              {t("codingAgent.wizardIntro")}
            </p>
          {/* Nothing on the intro changes for a paid box. For every other
              state the gate takes the place the first step would have led to:
              a box with no ClawBox AI account gets the device-code handoff, a
              Free one the upgrade card. The button stays on screen and
              disabled rather than vanishing, because "why can I not start
              this" is the question the card underneath answers. */}
          {gated && (
            <div className="mt-6">
              <PaidFeatureGate feature="coding_agent" login={clawboxLogin} />
            </div>
          )}
          <button
            type="button"
            onClick={() => setStep("github")}
            data-testid="coding-agent-wizard-enable"
            disabled={gated}
            aria-disabled={gated}
            title={gated ? t("paidGate.buttonBlocked") : undefined}
            className={`${PRIMARY} mt-7 disabled:opacity-50 disabled:cursor-default`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">rocket_launch</span>
            {t("codingAgent.wizardEnable")}
          </button>
          </div>
        </div>
      )}

      {/* ── Step 1: the GitHub account a run pushes with. ── */}
      {step === "github" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardGithubTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardGithubHint")}
          </p>

          {github?.connected ? (
            <p
              className="mt-3 flex items-center gap-2 text-xs text-emerald-400"
              data-testid="coding-agent-wizard-github-connected"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">check_circle</span>
              {github.login
                ? `${t("codingAgent.wizardGithubConnected")} · ${github.login}`
                : t("codingAgent.wizardGithubConnected")}
            </p>
          ) : deviceLogin ? (
            // The same card the ClawBox AI subscription uses — one look, one
            // implementation, and the code lands on the clipboard by itself.
            <div className="mt-3">
              <DeviceCodeCard
                code={deviceLogin.userCode}
                verificationUrl={deviceLogin.verificationUri}
                polling
                onNewCode={() => void connectGithub()}
                testId="coding-agent-wizard-device"
                actions={
                  <button
                    type="button"
                    onClick={cancelGithubLogin}
                    className="bg-transparent border-none text-[var(--text-muted)] hover:text-white text-xs underline cursor-pointer p-0"
                  >
                    {t("codingAgent.githubDeviceCancel")}
                  </button>
                }
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void connectGithub()}
              disabled={busy === "gh"}
              data-testid="coding-agent-wizard-github"
              className={`${PRIMARY} mt-3 inline-flex items-center gap-2`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">link</span>
              {t("codingAgent.wizardGithubConnect")}
            </button>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("improvement")} className={PRIMARY} data-testid="coding-agent-wizard-next">
              {t("codingAgent.wizardNext")}
            </button>
            {/* GitHub is what a run PUSHES with; a run works without it, so the
                step is skippable rather than a gate. */}
            {!github?.connected && (
              <button type="button" onClick={() => setStep("improvement")} className={SMALL_BUTTON}>
                {t("codingAgent.wizardSkip")}
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Step 2: the ClawBox Improvement Program. ── */}
      {step === "improvement" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardImprovementTitle")}</h2>
          {/* The step before this one is skippable, so the hint cannot promise
              "the account you just connected" — to an owner who skipped GitHub
              that names a connection they do not have. Unread state (github is
              still null) reads as not connected on purpose: the wording that
              points at Settings is true either way, the other one is not. */}
          <p
            className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]"
            data-testid="coding-agent-wizard-improvement-hint"
          >
            {t(github?.connected ? "codingAgent.wizardImprovementHint" : "codingAgent.wizardImprovementHintNoGithub")}
          </p>

          {/* The two lists ARE the consent, in the settings card's own words:
              what travels and what never does, in full rather than behind a
              hint — three buttons and a reassuring sentence would be asking
              for a signature on a blank page. */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
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

          {/* The choice is LOCAL until Next: unlike the settings card, which
              writes on every click, the wizard records one answer on its way
              to the next step. A real radiogroup — one tab stop, arrows move
              the choice — as the card's is. */}
          <div
            role="radiogroup"
            aria-label={t("improvement.modeTitle")}
            className="mt-4 space-y-2"
            data-testid="coding-agent-wizard-improvement"
          >
            {IMPROVEMENT_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                ref={(el) => { improvementRefs.current[m] = el; }}
                aria-checked={improvementMode === m}
                tabIndex={improvementMode === m ? 0 : -1}
                disabled={busy === "improvement"}
                data-testid={`coding-agent-wizard-improvement-${m}`}
                onKeyDown={(e) => moveImprovementWithArrows(e, m)}
                onClick={() => { improvementTouched.current = true; setImprovementMode(m); }}
                className={`w-full text-left rounded-xl border p-3 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                  improvementMode === m
                    ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/10"
                    : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"
                }`}
              >
                <span className="text-sm text-[var(--text-primary)]">{t(IMPROVEMENT_MODE_KEYS[m].label)}</span>
                <span className="block text-[11px] text-[var(--text-muted)] leading-relaxed mt-0.5">
                  {t(IMPROVEMENT_MODE_KEYS[m].hint, { n: maxIssuesPerDay })}
                </span>
              </button>
            ))}
          </div>

          {/* Said where the choice is made: an enabled programme with no
              GitHub sends nothing, and the step before this one is skippable. */}
          {improvementMode !== "off" && !github?.connected && (
            <p className="mt-3 text-[11px] leading-relaxed text-amber-400" data-testid="coding-agent-wizard-improvement-github">
              {t("improvement.githubMissing")}
            </p>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep("github")}
              disabled={busy === "improvement"}
              data-testid="coding-agent-wizard-improvement-back"
              className={SMALL_BUTTON}
            >
              {t("codingAgent.wizardBack")}
            </button>
            {/* No Skip: Next with Off chosen is how the owner declines, and
                it is written explicitly all the same. */}
            <button
              type="button"
              onClick={() => void saveImprovement()}
              disabled={busy === "improvement"}
              data-testid="coding-agent-wizard-improvement-next"
              className={PRIMARY}
            >
              {busy === "improvement" ? t("codingAgent.wizardFinishing") : t("codingAgent.wizardNext")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 3: where a run works, and how hard it thinks. ── */}
      {step === "project" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardProjectTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardProjectHint")}
          </p>

          <div className="mt-3 flex items-center gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={t("codingAgent.folderPlaceholder")}
              aria-label={t("codingAgent.folderLabel")}
              data-testid="coding-agent-wizard-folder"
              className={`${FIELD} flex-1 text-xs`}
            />
            <button
              type="button"
              // The pre-filled folder may not exist yet; the picker opens at
              // the browse root in that case rather than answering 404.
              onClick={() => void openBrowse(folder.trim() || undefined)}
              disabled={browsing}
              data-testid="coding-agent-wizard-browse"
              className={SMALL_BUTTON}
            >
              {t("codingAgent.wizardBrowse")}
            </button>
          </div>

          {browse && (
            <div className="mt-2 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] p-2" data-testid="coding-agent-wizard-picker">
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <span className="font-mono text-[11px] text-[var(--text-muted)] truncate" title={browse.path}>{browse.path}</span>
                <button type="button" onClick={() => setBrowse(null)} className={SMALL_BUTTON}>
                  {t("codingAgent.wizardPickerClose")}
                </button>
              </div>
              <ul className="max-h-48 overflow-y-auto">
                {browse.parent && (
                  <li>
                    <button
                      type="button"
                      onClick={() => void openBrowse(browse.parent as string)}
                      className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-white/5"
                    >
                      <span className="material-symbols-rounded align-middle mr-1" style={{ fontSize: 14 }} aria-hidden="true">arrow_upward</span>
                      {t("codingAgent.wizardPickerUp")}
                    </button>
                  </li>
                )}
                {browse.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => void openBrowse(entry.path)}
                      className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-primary)] hover:bg-white/5"
                    >
                      <span className="material-symbols-rounded align-middle mr-1 text-[var(--text-muted)]" style={{ fontSize: 14 }} aria-hidden="true">folder</span>
                      {entry.name}
                    </button>
                  </li>
                ))}
                {browse.entries.length === 0 && (
                  <li className="px-2 py-1 text-[11px] text-[var(--text-muted)]">{t("codingAgent.wizardPickerEmpty")}</li>
                )}
              </ul>
              {newFolder === null ? (
                <button
                  type="button"
                  onClick={() => setNewFolder("")}
                  data-testid="coding-agent-wizard-newfolder"
                  className={`${SMALL_BUTTON} mt-1 w-full`}
                >
                  <span className="material-symbols-rounded align-middle mr-1" style={{ fontSize: 14 }} aria-hidden="true">create_new_folder</span>
                  {t("codingAgent.wizardCreateFolder")}
                </button>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    autoFocus
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createFolder();
                      if (e.key === "Escape") setNewFolder(null);
                    }}
                    placeholder={t("codingAgent.wizardCreateFolderPlaceholder")}
                    aria-label={t("codingAgent.wizardCreateFolder")}
                    data-testid="coding-agent-wizard-newfolder-name"
                    className={`${FIELD} flex-1 text-xs`}
                  />
                  <button
                    type="button"
                    onClick={() => void createFolder()}
                    disabled={busy === "mkdir" || newFolder.trim() === ""}
                    data-testid="coding-agent-wizard-newfolder-create"
                    className={SMALL_BUTTON}
                  >
                    {t("codingAgent.wizardCreateFolderSave")}
                  </button>
                  <button type="button" onClick={() => setNewFolder(null)} className={SMALL_BUTTON}>
                    {t("codingAgent.wizardPickerClose")}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setFolder(browse.path); setBrowse(null); }}
                data-testid="coding-agent-wizard-pick"
                className={`${SMALL_BUTTON} mt-1 w-full`}
              >
                {t("codingAgent.wizardPickerUse")}
              </button>
            </div>
          )}

          {/* Effort, with the honest note about what the default costs. */}
          <div className="mt-5">
            <p className="text-xs font-semibold text-[var(--text-primary)]">{t("codingAgent.effortLabel")}</p>
            {/* Toggle buttons, not a radio group: each is its own tab stop and
                arrow keys do nothing here, so the radio contract would promise
                keyboard behaviour that is not there. The same pattern as the
                settings panel's effort row. */}
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("codingAgent.effortLabel")}>
              {status.effortLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={effort === level}
                  onClick={() => setEffort(level)}
                  data-testid={`coding-agent-wizard-effort-${level}`}
                  className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${
                    effort === level
                      ? "border-[var(--coral-bright)]/60 bg-[var(--coral-bright)]/15 text-[var(--text-primary)]"
                      : "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                  }`}
                >
                  {t(`codingAgent.effort.${level}`)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-amber-400/90" data-testid="coding-agent-wizard-cost">
              {t("codingAgent.wizardEffortCost")}
            </p>
          </div>

          <label className="mt-4 flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reviewPass}
              onChange={(e) => setReviewPass(e.target.checked)}
              data-testid="coding-agent-wizard-review"
              className="mt-0.5 accent-[var(--coral-bright)]"
            />
            <span>
              <span className="block text-xs text-[var(--text-primary)]">{t("codingAgent.reviewPassLabel")}</span>
              <span className="block text-[11px] leading-relaxed text-[var(--text-muted)]">{t("codingAgent.reviewPassHint")}</span>
            </span>
          </label>

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("improvement")} className={SMALL_BUTTON}>
              {t("codingAgent.wizardBack")}
            </button>
            <button
              type="button"
              onClick={() => void saveAndTest()}
              disabled={busy === "save"}
              data-testid="coding-agent-wizard-next-harness"
              className={PRIMARY}
            >
              {busy === "save" ? t("codingAgent.wizardFinishing") : t("codingAgent.wizardNext")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 4: which browser a run checks its work in. ── */}
      {step === "browser" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardBrowserTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardBrowserHint")}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void enableBrowser()}
              disabled={busy === "browser" || busy === "browser-install" || busy === "browser-skip"}
              data-testid="coding-agent-wizard-browser-enable"
              className={PRIMARY}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">desktop_windows</span>
              {busy === "browser-install"
                ? t("codingAgent.wizardBrowserInstalling")
                : busy === "browser"
                  ? t("codingAgent.wizardBrowserOpening")
                  : t("codingAgent.wizardBrowserEnable")}
            </button>
            {/* Skip is an ANSWER, not a deferral: it records "use the invisible
                browser", which the hint says in as many words. */}
            <button
              type="button"
              onClick={() => void skipBrowser()}
              disabled={busy === "browser" || busy === "browser-install" || busy === "browser-skip"}
              data-testid="coding-agent-wizard-browser-skip"
              className={SMALL_BUTTON}
            >
              {busy === "browser-skip" ? t("codingAgent.wizardFinishing") : t("codingAgent.wizardBrowserSkip")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 5: prove the whole thing actually works, or don't. ── */}
      {step === "harness" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardHarnessTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardHarnessHint")}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runHarnessTest()}
              disabled={busy === "harness" || busy === "finish"}
              data-testid="coding-agent-wizard-harness-run"
              className={PRIMARY}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">play_arrow</span>
              {busy === "harness" ? t("codingAgent.wizardHarnessStarting") : t("codingAgent.wizardHarnessRun")}
            </button>
            {/* An offer, not a gate: a box whose harness is not ready yet is
                still a configured box, and the card in Settings runs the same
                test whenever they want it. */}
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy === "harness" || busy === "finish"}
              data-testid="coding-agent-wizard-harness-skip"
              className={SMALL_BUTTON}
            >
              {busy === "finish" ? t("codingAgent.wizardFinishing") : t("codingAgent.wizardHarnessSkip")}
            </button>
          </div>
        </>
      )}

      {error && <StatusMessage type="error" message={error} />}

      {/* Whatever failed on the browser step — the setting write or the window
          itself — the wizard has one step left and no other way to reach it. A
          screen whose only two buttons have both just refused is a dead end,
          and the owner would have to close the window and start over. Under
          the message, because it is the answer to what the message says. */}
      {step === "browser" && error && (
        <button
          type="button"
          onClick={() => setStep("harness")}
          data-testid="coding-agent-wizard-browser-continue"
          className={`${SMALL_BUTTON} mt-3`}
        >
          {t("codingAgent.wizardBrowserContinue")}
        </button>
      )}
    </div>
  );
}
