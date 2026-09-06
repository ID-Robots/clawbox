"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged, notifyCodingRunStarted } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";
import DeviceCodeCard from "./DeviceCodeCard";
import CodingAgentDelegationArt from "./CodingAgentDelegationArt";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";
import { browserErrorText, runBrowserAction } from "@/lib/browser-actions";
import { startHarnessTest } from "@/lib/coding-agent-harness-test";
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
 * wizard asks for them in the order a run needs them, once.
 *
 * Settings keeps every one of these controls: this is an onboarding path over
 * the same routes, never the only way to change any of them.
 */

// One button system with the app and the settings page — see ./coding-agent-ui.
const SMALL_BUTTON = BTN_SECONDARY;
const PRIMARY = BTN_PRIMARY;

type Step = "intro" | "github" | "project" | "browser" | "harness";

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
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // ─── Which browser a run verifies its work in (step 3) ───

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

  const stepNumber = step === "github" ? 1 : step === "project" ? 2 : step === "browser" ? 3 : 4;
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
          <button
            type="button"
            onClick={() => setStep("github")}
            data-testid="coding-agent-wizard-enable"
            className={`${PRIMARY} mt-7`}
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

      {/* ── Step 4: prove the whole thing actually works, or don't. ── */}
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
