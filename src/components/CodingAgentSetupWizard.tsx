"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { buildHarnessTestPrompt, dispatchChatMessage, notifyCodingAgentChanged } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";
import DeviceCodeCard from "./DeviceCodeCard";
import CodingAgentDelegationArt from "./CodingAgentDelegationArt";
import CodingAgentFolderPicker from "./CodingAgentFolderPicker";
import Switch from "./CodingAgentSwitch";
import PaidFeatureGate, { PAID_GATE_POLL_MS, paidGateFace } from "./PaidFeatureGate";
import { BTN_PRIMARY, BTN_SECONDARY, CARD } from "./coding-agent-ui";
import { browserErrorText, runBrowserAction } from "@/lib/browser-actions";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import {
  devicePollSeconds,
  type AgentStatus,
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
 * wizard asks for them in the order a run needs them, once.
 *
 * Settings keeps every one of these controls: this is an onboarding path over
 * the same routes, never the only way to change any of them.
 */

// One button system with the app and the settings page — see ./coding-agent-ui.
const SMALL_BUTTON = BTN_SECONDARY;
const PRIMARY = BTN_PRIMARY;

type Step = "intro" | "github" | "project" | "browser" | "harness";

export default function CodingAgentSetupWizard({
  status,
  onDone,
}: {
  status: AgentStatus;
  /**
   * Setup is finished; the app re-reads its own status (the wizard does not
   * own that state) and the face flips to home. Since 2026-10-30 the last
   * step starts no run of its own — "Try it in the chat" hands the smoke test
   * to the chat and then calls this — so there is no run id to carry.
   */
  onDone: () => void;
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

  // ─── Project folder + how a run thinks (step 2) ───
  // Pre-filled with what the device proposes (~/Projects) so the common case
  // is one tap. The folder need not exist yet — saving creates it, as long as
  // it is inside the owner's home. It is shown as TEXT and changed through the
  // picker (CodingAgentFolderPicker, existing folders only): the typed path
  // and the "Create folder" name field went on 2026-10-30 — typing a path is
  // not a thing an owner does on a phone, and a folder that is not there yet
  // is made at the proposed name when this step saves.
  const [folder, setFolder] = useState(status.defaultDirectory ?? status.suggestedDirectory ?? "");
  const [picking, setPicking] = useState(false);
  // No effort choice here (SCA C3): a run starts at the box's own default
  // (DEFAULT_EFFORT), the note below says what the heavier levels cost, and
  // the Settings page is where an owner who wants one changes it.
  const [reviewPass, setReviewPass] = useState(status.reviewPass);

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
   * Mark setup finished. Called by both ways out of the last step — trying it
   * in the chat and skipping — because the test is an offer, not a gate: a
   * box whose harness is not ready yet is still a configured box. Answers
   * whether the flag was written, so the hand-off below happens only for a
   * wizard that really closed.
   */
  const finish = async (): Promise<boolean> => {
    // The plan is re-read at the moment of the act, not only at the render
    // that drew the button: `setupComplete: true` is one of the two bodies the
    // route refuses, and sending it after a subscription lapsed mid-wizard
    // would spend a 402 on a question the box can answer itself. The derived
    // step has already put the intro on screen, so there is nothing to set.
    if (gated) return false;
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
      onDone();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.wizardFinishFailed"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /**
   * The offered smoke test, as a hand-off: finish setup, then give the chat
   * the one message that asks the assistant to make the scratch folder and
   * start the canned run (`buildHarnessTestPrompt`). The run then appears
   * where every run does — as a card in the chat — rather than the wizard
   * posting to the run route itself (it did until 2026-10-30, and landed the
   * owner on the run's page). Finish FIRST: a hand-off from a wizard that
   * could not close would leave the owner with a run in the chat and the
   * wizard still up.
   */
  const tryInChat = async () => {
    if (await finish()) dispatchChatMessage(buildHarnessTestPrompt());
  };

  const stepNumber = step === "github" ? 1
    : step === "project" ? 2
    : step === "browser" ? 3
    : 4;
  const TOTAL_STEPS = 4;

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
            <button type="button" onClick={() => setStep("project")} className={PRIMARY} data-testid="coding-agent-wizard-next">
              {t("codingAgent.wizardNext")}
            </button>
            {/* GitHub is what a run PUSHES with; a run works without it, so the
                step is skippable rather than a gate. */}
            {!github?.connected && (
              <button type="button" onClick={() => setStep("project")} className={SMALL_BUTTON}>
                {t("codingAgent.wizardSkip")}
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Step 2: where a run works, and how hard it thinks. ── */}
      {step === "project" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardProjectTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardProjectHint")}
          </p>

          {/* The folder as text, and Browse: the picker is the only way to
              change it (no typed path, no new-folder field — the wizard's
              two inputs went on 2026-10-30). A proposed folder that is not
              there yet is created when Next saves. */}
          <div className="mt-3 flex items-center gap-3">
            <p
              className="min-w-0 flex-1 font-mono text-[12px] text-[var(--text-primary)] break-all"
              data-testid="coding-agent-wizard-folder"
              data-value={folder}
            >
              {folder || t("codingAgent.folderUnset")}
            </p>
            <button
              type="button"
              onClick={() => setPicking(true)}
              data-testid="coding-agent-wizard-browse"
              className={SMALL_BUTTON}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">folder_open</span>
              {t("codingAgent.browse")}
            </button>
          </div>
          {picking && (
            <CodingAgentFolderPicker
              // The pre-filled folder may not exist yet; the picker opens at
              // the browse root in that case rather than answering 404.
              initialDir={folder.trim() || null}
              onPick={(path) => { setFolder(path); setPicking(false); }}
              onClose={() => setPicking(false)}
              testId="coding-agent-wizard-picker"
            />
          )}

          {/* What a run costs to think: the default is what it starts at, the
              note says what the heavier levels spend. No picker here — one
              fewer first-run decision; the Settings page has the row. */}
          <p className="mt-5 text-[11px] leading-relaxed text-amber-400/90" data-testid="coding-agent-wizard-cost">
            {t("codingAgent.wizardEffortCost")}
          </p>

          {/* The review pass as a Switch row — the same control Settings
              draws for it, not a checkbox the rest of the app has nowhere. */}
          <div className="mt-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-[var(--text-primary)]">{t("codingAgent.reviewPassLabel")}</p>
              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t("codingAgent.reviewPassHint")}</p>
            </div>
            <Switch
              checked={reviewPass}
              busy={false}
              disabled={busy === "save"}
              label={t("codingAgent.reviewPassLabel")}
              onChange={setReviewPass}
              testId="coding-agent-wizard-review"
            />
          </div>

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("github")} className={SMALL_BUTTON}>
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

      {/* ── Step 3: which browser a run checks its work in. ── */}
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

      {/* ── Step 4: prove the whole thing actually works — in the chat — or don't. ── */}
      {step === "harness" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.wizardHarnessTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("codingAgent.wizardHarnessHint")}
          </p>

          <div className="mt-5 flex flex-col @md:flex-row items-stretch @md:items-center gap-2">
            <button
              type="button"
              onClick={() => void tryInChat()}
              disabled={busy === "finish"}
              data-testid="coding-agent-wizard-try-chat"
              className={PRIMARY}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">chat</span>
              {busy === "finish" ? t("codingAgent.wizardFinishing") : t("codingAgent.wizardTryInChat")}
            </button>
            {/* An offer, not a gate: a box whose harness is not ready yet is
                still a configured box, and Settings' "Test in the chat" hands
                the same test to the chat whenever they want it. */}
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy === "finish"}
              data-testid="coding-agent-wizard-harness-skip"
              className={SMALL_BUTTON}
            >
              {t("codingAgent.wizardHarnessSkip")}
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
