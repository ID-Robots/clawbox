"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { browserErrorText, saveBrowserSetup, type BrowserAction } from "@/lib/browser-actions";
import StatusMessage from "./StatusMessage";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";

/**
 * The Browser app's embedded settings page — everything the owner DECIDES
 * about the desktop browser, on the far side of the app's Settings button.
 *
 * The app itself is the browser now: a screen and a status strip. The three
 * numbered cards it used to be (install Chromium, link it to the agent, open
 * the window) are here, where a setting belongs, joined by the two the wizard
 * introduced — whether opening the app opens Chromium, and the page it starts
 * on.
 *
 * Nothing here is invented: every control writes a route that already existed
 * or one this flow added, and the panel renders the status the APP polled
 * rather than starting a second poll of its own, so the strip and this page
 * can never disagree about whether the browser is running.
 */

/** The wire shape of GET /setup-api/browser/manage — the one definition the
 *  app, this page and the wizard all read, so the three cannot drift. */
export interface BrowserStatus {
  chromium: {
    installed: boolean;
    path?: string;
    version?: string;
    /**
     * False when the only Chromium on the box is the snap build, which
     * clawbox-browser.service cannot start. "Installed" alone was never
     * enough to promise the owner a window.
     */
    serviceSafe?: boolean;
  };
  browser: {
    running: boolean;
    pid?: number;
    cdpReady?: boolean;
    /**
     * The agent's own headless browser owns the CDP port and no desktop
     * browser window exists. A distinct state with its own words — the panel
     * used to render this as "Chromium is running on the desktop" (TASK-515).
     */
    agentBrowsing?: boolean;
  };
  enabled: boolean;
  /**
   * True when this edition has no integration switch because the link is
   * permanent — Hermes drives the desktop browser through the ClawBox
   * browser_* tools, which it is given at every boot. The route decides this
   * (see integrationIsAlwaysOn there); the client only renders it, so a device
   * and its UI can never disagree about whether a button should exist.
   */
  alwaysOn?: boolean;
  cdpPort?: number;
  /** False only while the owner still has the setup wizard in front of them. */
  setupComplete?: boolean;
  /** Whether opening this app opens Chromium. */
  autoOpen?: boolean;
  /** Where a freshly started Chromium lands. */
  startUrl?: string;
}

function Switch({
  checked, busy, disabled, label, onChange, testId,
}: {
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        // motion-safe: a spinner that keeps turning for an owner who asked the
        // OS for reduced motion is the one thing a spinner must not do.
        <span
          className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-muted)]"
          style={{ fontSize: 18 }}
          aria-hidden="true"
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

export default function BrowserSettingsPanel({
  status,
  harnessLabel,
  actionLoading,
  onAction,
  onChanged,
  onOpenVnc,
  onShowWizard,
}: {
  status: BrowserStatus | null;
  harnessLabel: string;
  /** The manage action in flight, if any — the app owns that spinner. */
  actionLoading: BrowserAction | null;
  onAction: (action: BrowserAction) => void;
  /** Re-read the manage status after a write to the settings route. */
  onChanged: () => void;
  onOpenVnc: () => void;
  /** Put the wizard back in front of the owner, from the app's home face. */
  onShowWizard: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A draft, so typing does not fight the status the app keeps re-reading:
  // null means "nothing typed yet", and the field falls through to the
  // device's value until the owner touches it.
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const urlValue = urlDraft ?? status?.startUrl ?? "";

  const save = async (patch: { setupComplete?: boolean; autoOpen?: boolean; startUrl?: string | null }, key: string) => {
    setBusy(key);
    setError(null);
    const result = await saveBrowserSetup(patch);
    setBusy(null);
    if (!result.ok) {
      setError(browserErrorText(t, result, "browser.settings.saveFailed"));
      return false;
    }
    onChanged();
    return true;
  };

  const chromium = status?.chromium;
  const serviceSafe = chromium?.serviceSafe !== false;
  const alwaysOn = status?.alwaysOn ?? false;
  const isEnabled = status?.enabled ?? false;
  const running = status?.browser?.running ?? false;
  const busyAnywhere = busy !== null || actionLoading !== null;

  return (
    <div className="w-full space-y-5" data-testid="browser-settings-panel">
      {/* ── Chromium: the binary a system service has to be able to start. ── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("browser.chromiumBrowser")}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {chromium?.installed
                ? (chromium.version || t("browser.settings.chromiumInstalled"))
                : t("browser.chromiumRequired")}
            </p>
            {chromium?.path && (
              <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] truncate" title={chromium.path}>{chromium.path}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onAction("install-chromium")}
            disabled={busyAnywhere}
            data-testid="browser-settings-install"
            className={chromium?.installed ? BTN_SECONDARY : BTN_PRIMARY}
          >
            {actionLoading === "install-chromium"
              ? t("browser.installing")
              : chromium?.installed ? t("browser.settings.reinstall") : t("browser.installChromium")}
          </button>
        </div>
        {chromium?.installed && !serviceSafe && (
          <p className="mt-3 text-[11px] leading-relaxed text-amber-400" role="alert" data-testid="browser-settings-snap-warning">
            {t("browser.errorNotServiceSafe")}
          </p>
        )}
      </div>

      {/* ── The link to the agent: a switch on OpenClaw, permanent on Hermes. ── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("browser.openclawIntegration", { harness: harnessLabel })}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {alwaysOn
                ? t("browser.builtInMessage", { harness: harnessLabel })
                : isEnabled
                  ? t("browser.enabledMessage", { harness: harnessLabel })
                  : t("browser.disabledMessage", { harness: harnessLabel })}
            </p>
            {isEnabled && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                {/* Name the actual mechanism. "tools profile: full" is the
                    OpenClaw config key the switch writes; on an always-on
                    edition there is no such key, and the honest detail is
                    which tools the agent holds. */}
                <span className={`text-[11px] text-[var(--text-muted)]${alwaysOn ? " font-mono" : ""}`}>
                  {alwaysOn ? "browser_open · browser_navigate · browser_screenshot" : "tools profile: full"}
                </span>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">CDP :{status?.cdpPort ?? 18800}</span>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">~/.config/clawbox-browser/</span>
              </div>
            )}
          </div>
          {/* No switch where there is no choice: the link is part of the
              edition, so anything offered here would be a control that does
              nothing — or, as it did before, one that only ever errored. */}
          {!alwaysOn && (
            <Switch
              checked={isEnabled}
              busy={actionLoading === "enable" || actionLoading === "disable"}
              disabled={busyAnywhere || !chromium?.installed}
              label={t("browser.openclawIntegration", { harness: harnessLabel })}
              onChange={(next) => onAction(next ? "enable" : "disable")}
              testId="browser-settings-link"
            />
          )}
        </div>
      </div>

      {/* ── The window itself, and whether it opens by itself. ── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("browser.desktopBrowser")}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {running
                ? t("browser.settings.runningPid", { pid: status?.browser?.pid ?? "?" })
                : t("browser.settings.notRunning")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onAction(running ? "close-browser" : "open-browser")}
            disabled={busyAnywhere || !isEnabled || !chromium?.installed}
            data-testid="browser-settings-power"
            className={running ? BTN_DANGER : BTN_PRIMARY}
          >
            {actionLoading === "open-browser"
              ? t("browser.opening")
              : actionLoading === "close-browser"
                ? t("browser.closing")
                : running ? t("browser.closeBrowser") : t("browser.openBrowser")}
          </button>
        </div>

        <div className="mt-4 flex items-start justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-secondary)]">{t("browser.settings.autoOpenLabel")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("browser.settings.autoOpenHint")}</p>
          </div>
          <Switch
            checked={status?.autoOpen !== false}
            busy={busy === "autoOpen"}
            disabled={busyAnywhere || !status}
            label={t("browser.settings.autoOpenLabel")}
            onChange={(next) => void save({ autoOpen: next }, "autoOpen")}
            testId="browser-settings-auto-open"
          />
        </div>

        {/* ── Where a freshly started Chromium lands. ── */}
        <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
          <label htmlFor="browser-start-url" className="text-xs font-medium text-[var(--text-secondary)]">
            {t("browser.settings.startUrlLabel")}
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id="browser-start-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              value={urlValue}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save({ startUrl: urlValue }, "startUrl"); }}
              placeholder="https://www.google.com"
              data-testid="browser-settings-start-url"
              // text-base on a phone: an input under 16px makes iOS Safari zoom
              // the page on focus, which scrolls the rest of the page away.
              className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
            />
            <button
              type="button"
              onClick={() => void save({ startUrl: urlValue }, "startUrl")}
              disabled={busyAnywhere || urlValue === (status?.startUrl ?? "")}
              data-testid="browser-settings-start-url-save"
              className={BTN_SECONDARY}
            >
              {busy === "startUrl" ? t("browser.settings.saving") : t("browser.settings.save")}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("browser.settings.startUrlHint")}</p>
        </div>
      </div>

      {/* ── The screen the window is drawn on. ── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("browser.settings.remoteTitle")}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("browser.settings.remoteHint")}</p>
          </div>
          <button type="button" onClick={onOpenVnc} className={BTN_SECONDARY} data-testid="browser-settings-open-vnc">
            {t("browser.openInVNC")}
          </button>
        </div>
      </div>

      {/* ── The front door, if the owner wants to see it again. ── */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("browser.settings.setupTitle")}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("browser.settings.setupHint")}</p>
          </div>
          <button
            type="button"
            // Only the flag: clearing the link or the install alongside it
            // would show a wizard whose first two steps are already done and
            // whose "Connect" would restart a gateway nobody asked about.
            onClick={() => void save({ setupComplete: false }, "wizard").then((ok) => { if (ok) onShowWizard(); })}
            disabled={busyAnywhere}
            data-testid="browser-settings-show-wizard"
            className={BTN_SECONDARY}
          >
            {t("browser.settings.showWizard")}
          </button>
        </div>
      </div>

      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
