"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  browserErrorText,
  runBrowserAction,
  saveBrowserSetup,
  type BrowserAction,
} from "@/lib/browser-actions";
import StatusMessage from "./StatusMessage";
import BrowserDesktopArt from "./BrowserDesktopArt";
import { BTN_PRIMARY, BTN_SECONDARY, CARD } from "./coding-agent-ui";
import type { BrowserStatus } from "./BrowserSettingsPanel";

/**
 * First-run setup for the built-in browser, shown inside the Browser window
 * until the owner finishes it (`status.setupComplete`).
 *
 * Why a wizard and not just the app: the browser needs three things to exist
 * before there is anything to look at — a Chromium a system service can start,
 * the agent's link to it on the editions where that is a switch, and the
 * window itself — and the app used to present all three as numbered cards the
 * owner had to work out the order of. This asks for them in the order the
 * device needs them, once, and then never again.
 *
 * The settings page keeps every one of these controls: this is an onboarding
 * path over the same two routes, never the only way to change any of them.
 */

type Step = "intro" | "chromium" | "link" | "open";

export default function BrowserSetupWizard({
  status,
  harnessLabel,
  onChanged,
  onDone,
}: {
  status: BrowserStatus;
  harnessLabel: string;
  /** Re-read the device after a step changed something on it. */
  onChanged: () => void;
  /** The app re-reads its own status; the wizard does not own that state.
   *  `opened` says whether the browser was actually launched here, so a wizard
   *  the owner skipped out of does not land them on a home face that opens it
   *  for them a second later. */
  onDone: (opened: boolean) => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installed = status.chromium?.installed ?? false;
  const serviceSafe = status.chromium?.serviceSafe !== false;
  const alwaysOn = status.alwaysOn ?? false;
  const enabled = status.enabled ?? false;
  const running = status.browser?.running ?? false;

  const act = async (action: BrowserAction, key: string): Promise<boolean> => {
    setBusy(key);
    setError(null);
    const result = await runBrowserAction(action);
    setBusy(null);
    if (!result.ok) {
      setError(browserErrorText(t, result));
      return false;
    }
    onChanged();
    return true;
  };

  /**
   * Mark setup finished. Both ways out of the last step end here — opening the
   * browser and skipping it — because the window is an offer, not a gate: a
   * box whose Chromium will not start today is still a box the owner has
   * finished setting up, and the settings page carries the same buttons.
   */
  const finish = async (opened: boolean) => {
    setBusy("finish");
    setError(null);
    const result = await saveBrowserSetup({ setupComplete: true });
    setBusy(null);
    if (!result.ok) {
      setError(browserErrorText(t, result, "browser.settings.saveFailed"));
      return;
    }
    onDone(opened);
  };

  /** Opening it IS finishing: the home face behind this wizard is the screen
   *  the window appears on, so there is nothing left to press afterwards. */
  const openAndFinish = async () => {
    if (await act("open-browser", "open")) await finish(true);
  };

  // The link step does not exist on an edition where the link is permanent —
  // see integrationIsAlwaysOn() in the manage route.
  const totalSteps = alwaysOn ? 2 : 3;
  const stepNumber = step === "chromium" ? 1 : step === "link" ? 2 : totalSteps;

  return (
    <div
      className={step === "intro" ? "mt-4 flex-1 flex flex-col" : `${CARD} mt-4`}
      data-testid="browser-wizard"
    >
      {step !== "intro" && (
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t("browser.setup.stepOf", { n: stepNumber, total: totalSteps })}
        </p>
      )}

      {/* ── The front door: what this is, and one button that starts it. ── */}
      {step === "intro" && (
        // No card: it is the first thing in an otherwise empty window, and a
        // box drawn around a single paragraph reads as a notice rather than a
        // front door. The BLOCK is centred; the text inside hangs off one left
        // edge, so the diagram, the heading, the paragraph and the button all
        // start at the same x.
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-8">
          <div className="w-full max-w-[26rem] text-left">
            <BrowserDesktopArt className="mb-7" />
            <h2 className="text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("browser.setup.introTitle")}
            </h2>
            <p className="mt-2.5 text-xs leading-[1.7] text-[var(--text-secondary)]">
              {t("browser.setup.introBody", { harness: harnessLabel })}
            </p>
            <div className="mt-7 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep("chromium")}
                data-testid="browser-wizard-start"
                className={BTN_PRIMARY}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">rocket_launch</span>
                {t("browser.setup.start")}
              </button>
              {/* Nobody is trapped in a front door: "not now" finishes setup
                  without touching the device, and the settings page can put
                  this wizard back whenever it is wanted. */}
              <button
                type="button"
                onClick={() => void finish(false)}
                disabled={busy === "finish"}
                data-testid="browser-wizard-skip"
                className={BTN_SECONDARY}
              >
                {t("browser.setup.notNow")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 1: a Chromium a system service can actually start. ── */}
      {step === "chromium" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("browser.setup.chromiumTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("browser.setup.chromiumHint")}
          </p>

          {installed && serviceSafe ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-emerald-400" data-testid="browser-wizard-chromium-ready">
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">check_circle</span>
              {status.chromium?.version || t("browser.settings.chromiumInstalled")}
            </p>
          ) : (
            <>
              {installed && (
                <p className="mt-3 text-[11px] leading-relaxed text-amber-400" role="alert">
                  {t("browser.errorNotServiceSafe")}
                </p>
              )}
              <button
                type="button"
                onClick={() => void act("install-chromium", "install")}
                disabled={busy !== null}
                data-testid="browser-wizard-install"
                className={`${BTN_PRIMARY} mt-3`}
              >
                {busy === "install" ? t("browser.installing") : t("browser.installChromium")}
              </button>
              {busy === "install" && (
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("browser.setup.installSlow")}</p>
              )}
            </>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep(alwaysOn ? "open" : "link")}
              // Nothing downstream has meaning without a browser to link or
              // open, so this is the one step that is a gate.
              disabled={!installed || busy !== null}
              data-testid="browser-wizard-next"
              className={BTN_PRIMARY}
            >
              {t("browser.setup.next")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 2: let the agent drive it (switch editions only). ── */}
      {step === "link" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("browser.setup.linkTitle", { harness: harnessLabel })}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("browser.setup.linkHint", { harness: harnessLabel })}
          </p>

          {enabled ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-emerald-400" data-testid="browser-wizard-link-done">
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">check_circle</span>
              {t("browser.enabledMessage", { harness: harnessLabel })}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void act("enable", "enable")}
              disabled={busy !== null}
              data-testid="browser-wizard-link"
              className={`${BTN_PRIMARY} mt-3`}
            >
              {busy === "enable" ? t("browser.enabling") : t("browser.enable")}
            </button>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("chromium")} disabled={busy !== null} className={BTN_SECONDARY}>
              {t("browser.back")}
            </button>
            <button
              type="button"
              onClick={() => setStep("open")}
              disabled={busy !== null}
              data-testid="browser-wizard-next-open"
              className={BTN_PRIMARY}
            >
              {/* The window opens with or without the link — the link is what
                  the AGENT needs — so this step is skippable rather than a
                  gate, and says which of the two it is. */}
              {enabled ? t("browser.setup.next") : t("browser.setup.skip")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 3: open it, and land on the screen it opened on. ── */}
      {step === "open" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("browser.setup.openTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {running ? t("browser.setup.openAlready") : t("browser.setup.openHint")}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void (running ? finish(true) : openAndFinish())}
              disabled={busy !== null}
              data-testid="browser-wizard-open"
              className={BTN_PRIMARY}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">open_in_new</span>
              {busy === "open"
                ? t("browser.opening")
                : running ? t("browser.setup.finish") : t("browser.openBrowser")}
            </button>
            <button
              type="button"
              onClick={() => void finish(running)}
              disabled={busy !== null}
              data-testid="browser-wizard-finish"
              className={BTN_SECONDARY}
            >
              {busy === "finish" ? t("browser.setup.finishing") : t("browser.setup.skipAndFinish")}
            </button>
          </div>
        </>
      )}

      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
