"use client";

/**
 * BrowserApp — the desktop browser, and the agent's access to it.
 *
 * Three faces, chosen the way the Coding Agent app chooses its own: the setup
 * WIZARD until the owner has been through it, the SETTINGS page while its
 * button is pressed, and otherwise HOME — which is the browser itself, drawn
 * on the device's own screen through VNCApp.
 *
 * Home is the point of the app. Opening it used to leave the owner in front of
 * three numbered cards with the window they came for two buttons away ("Open
 * Browser", then "Open in VNC", in that order, or the screen showed an empty
 * desktop). Now the app starts Chromium if it is not running, waits for it and
 * shows the screen — with an honest pill while that happens and a stated
 * reason when it cannot. The owner can switch that off (`autoOpen`), and it
 * never fires while the AGENT is browsing: `open-browser` terminates the
 * headless browser holding the CDP port, which is fair when a person asks for
 * it and not fair as a side effect of `ui_open_app("browser")`.
 *
 * One header, on every face: the state (home), Open or Close, Paste to VNC,
 * Open in VNC, and Settings (or Back). The title bar it used to carry above
 * that repeated the window's own title, and the paste button used to float
 * over the screen apart from every other control.
 *
 * The app never decides an edition's shape itself — the route says whether the
 * agent link is a switch via `alwaysOn`; see integrationIsAlwaysOn() in
 * src/app/setup-api/browser/manage/route.ts.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n";
import { cachedActiveHarness, fetchHarness } from "@/lib/client-harness";
import { browserErrorText, runBrowserAction, type BrowserAction } from "@/lib/browser-actions";
import { autoLaunchSpent, spendAutoLaunch } from "@/lib/browser-auto-launch";
import ErrorWithFix from "./ErrorWithFix";
import VNCApp, { type VNCHandle } from "./VNCApp";
import BrowserSetupWizard from "./BrowserSetupWizard";
import BrowserSettingsPanel, { type BrowserStatus } from "./BrowserSettingsPanel";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY } from "./coding-agent-ui";

const BRAND_ORANGE = "#fe6e00";

/** How often the status is re-read while nothing is happening, and while
 *  something is: a launch takes up to ~15 s to answer and the strip has to
 *  follow it, but a browser that is simply up does not need that attention. */
const POLL_IDLE_MS = 5000;
const POLL_BUSY_MS = 1500;
/** For how long a launch earns the fast poll. Comfortably past the route's own
 *  ten readiness probes, and short enough that a Chromium which came up but
 *  never bound its port drops back to the idle rate instead of holding it. */
const POLL_BUSY_WINDOW_MS = 45_000;

interface BrowserAppProps {
  onOpenApp?: (appId: string) => void;
}

export default function BrowserApp({ onOpenApp }: BrowserAppProps) {
  const { t } = useT();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  // The latest request must explicitly prove Chromium is absent before the UI
  // offers installation. A null/unreadable response is an availability error,
  // not `installed: false` (and a prior stale payload does not change that).
  const [statusReadable, setStatusReadable] = useState(false);
  // Which agent actually drives this browser. The copy used to say "OpenClaw"
  // on every device — wrong, and confusing, on a Hermes box where the OpenClaw
  // gateway isn't even installed. Defaults to OpenClaw (the native SKU) and is
  // corrected as soon as the device answers.
  const [harnessLabel, setHarnessLabel] = useState(
    () => (cachedActiveHarness() === "hermes" ? "Hermes" : "OpenClaw"),
  );

  useEffect(() => {
    let alive = true;
    void fetchHarness().then((d) => {
      if (alive && d) setHarnessLabel(d.active === "hermes" ? "Hermes" : "OpenClaw");
    });
    return () => { alive = false; };
  }, []);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<BrowserAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<"home" | "settings">("home");

  const actionErrorRef = useRef(false);
  // The screen, for the header's Paste to VNC button.
  const vncRef = useRef<VNCHandle>(null);
  const lastStatusJson = useRef("");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/browser/manage");
      if (!res.ok) throw new Error("Failed to fetch status");
      const data = await res.json() as BrowserStatus | null;
      if (!data?.chromium || typeof data.chromium.installed !== "boolean") {
        throw new Error("Failed to fetch status");
      }
      // Only update state if data actually changed to avoid unnecessary re-renders
      const json = JSON.stringify(data);
      if (json !== lastStatusJson.current) {
        lastStatusJson.current = json;
        setStatus(data);
      }
      setStatusReadable(true);
      if (!actionErrorRef.current) setError(null);
    } catch (err) {
      setStatusReadable(false);
      if (!actionErrorRef.current) setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, []);

  const browserRunning = status?.browser?.running ?? false;
  const cdpReady = status?.browser?.cdpReady ?? false;
  // A launch is in flight, or a process exists that has not bound its port
  // yet. Both are "something is happening, wait", and both want the faster
  // poll and the pill over the screen.
  const starting = actionLoading === "open-browser" || (browserRunning && !cdpReady);

  // One read on mount. Its own effect so that a change of cadence below does
  // not fire a second one milliseconds after the first.
  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // The fast poll FOLLOWS a launch; it must never become the standing rate.
  // `starting` also covers "a process exists that has not bound its port", and
  // a Chromium that never binds one would otherwise keep this window reading
  // the manage route every 1.5 s for as long as it is open — a route that runs
  // `chromium --version` and walks the process table on every read.
  const [fastPoll, setFastPoll] = useState(false);
  useEffect(() => {
    if (!starting) {
      setFastPoll(false);
      return;
    }
    setFastPoll(true);
    const id = setTimeout(() => setFastPoll(false), POLL_BUSY_WINDOW_MS);
    return () => clearTimeout(id);
  }, [starting]);

  useEffect(() => {
    const id = setInterval(() => { void fetchStatus(); }, fastPoll ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearInterval(id);
  }, [fetchStatus, fastPoll]);

  // Clear actionLoading once polling sees the requested end-state. Some
  // actions (enable/disable restart the gateway) can outlast or hang the
  // POST request — without this, the button stays stuck on "Enabling..."
  // even though the backend already reflects the new state.
  useEffect(() => {
    if (!actionLoading || !status) return;
    if (
      (actionLoading === "enable" && status.enabled) ||
      (actionLoading === "disable" && !status.enabled) ||
      (actionLoading === "open-browser" && status.browser?.running) ||
      (actionLoading === "close-browser" && !status.browser?.running)
    ) {
      setActionLoading(null);
    }
  }, [status, actionLoading]);

  const doAction = useCallback(async (action: BrowserAction) => {
    // The owner's own hand on the browser, whichever way it went: the window
    // has nothing left to decide after it, and must not re-open on the next
    // remount what was just closed on purpose.
    if (action === "open-browser" || action === "close-browser") spendAutoLaunch();
    setActionLoading(action);
    setError(null);
    actionErrorRef.current = false;
    const result = await runBrowserAction(action);
    if (!result.ok) {
      actionErrorRef.current = true;
      setError(browserErrorText(t, result));
    }
    await fetchStatus();
    setActionLoading(null);
  }, [fetchStatus, t]);

  const openVncApp = useCallback(() => {
    if (onOpenApp) {
      onOpenApp("vnc");
      return;
    }
    window.open("/app/vnc", "_blank");
  }, [onOpenApp]);

  const chromiumInstalled = status?.chromium?.installed ?? false;
  const agentBrowsing = !browserRunning && (status?.browser?.agentBrowsing ?? false);
  const isEnabled = status?.enabled ?? false;
  // The window needs the link on the switch editions — that is what writes the
  // agent's tools profile — and a binary a system service can start. Chromium
  // being merely "installed" is not that: the snap build is refused by
  // scripts/launch-browser.sh, which is why the route answers `serviceSafe`.
  const canRunBrowser = isEnabled && chromiumInstalled && status?.chromium?.serviceSafe !== false;

  const face: "wizard" | "settings" | "home" =
    page === "settings" ? "settings"
      : status?.setupComplete === false ? "wizard"
        : "home";

  // Kept outside React on purpose (see browser-auto-launch.ts): the fact has
  // to outlive the mount, and "we have already tried" has to be true before
  // the request comes back — the poll would otherwise fire a second launch
  // while the first is still inside the route's ten-second wait for CDP.
  useEffect(() => {
    if (autoLaunchSpent() || face !== "home" || !status) return;
    // The switch is the owner's, and the setup route refuses the MCP bearer,
    // so `ui_open_app("browser")` cannot turn it back on to get itself a
    // window the owner said no to.
    if (status.autoOpen === false) return;
    if (status.browser?.running) { spendAutoLaunch(); return; }
    // Not while the agent is mid-task in its own headless browser: opening
    // ours terminates that one. The notice below offers the same action by
    // hand, which is a person asking rather than a window deciding.
    if (status.browser?.agentBrowsing) return;
    if (!canRunBrowser) return;
    spendAutoLaunch();
    void doAction("open-browser");
  }, [status, face, canRunBrowser, doAction]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[var(--bg-deep)] text-white/70 gap-4">
        <div className="w-8 h-8 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
        <p className="text-sm">{t("browser.checkingStatus")}</p>
      </div>
    );
  }

  const stateLabel = starting
    ? t("browser.startingChromium")
    : browserRunning
      ? t("browser.settings.runningPid", { pid: status?.browser?.pid ?? "?" })
      : agentBrowsing
        ? t("browser.agentBrowsingShort", { harness: harnessLabel })
        : t("browser.settings.notRunning");

  return (
    <div className="h-full flex flex-col bg-[var(--bg-deep)] text-white">
      {/* ONE header. It used to be two: a title bar (logo, name, subtitle,
          Settings) over a strip (state, Open/Close, Open in VNC), with the
          paste button floating over the screen itself. The title repeated
          what the window's own title bar says, so it went; the strip kept
          the state and gained the rest — Settings beside Close, and Paste to
          VNC beside the other actions — one row, on every face.

          It WRAPS, though. Held to one line, those five controls measure
          556 px and the app's frame on a phone is 390 px of `overflow-hidden`:
          Open in VNC was cut in half, Settings was off-screen entirely, the
          state label was squeezed to nothing and no ancestor scrolled — so the
          settings this app keeps precisely so a phone that landed on
          /app/browser can reach them were unreachable from one. */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-white/10" data-testid="browser-header">
        <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: BRAND_ORANGE }} aria-hidden="true">
          <svg className="w-3.5 h-3.5" viewBox="0 0 135.47 135.47" aria-hidden="true">
              <path d="m67.733 67.733 29.33 16.933-29.33 50.8c37.408 0 67.733-30.325 67.733-67.733 0-12.341-3.3168-23.901-9.0837-33.867h-58.65z" fill="#afccf9"/>
              <path d="m67.733-1e-6c-25.07 0-46.942 13.63-58.654 33.875l29.324 50.792 29.33-16.933v-33.867h58.65c-11.714-20.24-33.583-33.867-58.65-33.867z" fill="#1767d1"/>
              <path d="m0 67.733c0 37.408 30.324 67.733 67.733 67.733l29.33-50.8-29.33-16.933-29.33 16.933-29.324-50.792c-5.7637 9.9632-9.0794 21.519-9.0794 33.858" fill="#679ef5"/>
              <path d="m101.6 67.733c0 18.704-15.163 33.867-33.867 33.867-18.704 0-33.867-15.163-33.867-33.867s15.163-33.867 33.867-33.867c18.704 0 33.867 15.163 33.867 33.867" fill="#fff"/>
              <path d="m95.25 67.733c0 15.197-12.32 27.517-27.517 27.517-15.197 0-27.517-12.32-27.517-27.517 0-15.197 12.32-27.517 27.517-27.517 15.197 0 27.517 12.32 27.517 27.517" fill="#1a74e7"/>
            </svg>
        </div>
        {face === "home" ? (
          <>
            <span
              aria-hidden="true"
              className={`w-2 h-2 rounded-full shrink-0 ${
                starting ? "bg-yellow-400 motion-safe:animate-pulse"
                  : browserRunning ? "bg-green-400"
                    : agentBrowsing ? "bg-amber-400" : "bg-white/25"
              }`}
            />
            <span className="text-[11px] text-white/60 truncate" data-testid="browser-state">{stateLabel}</span>
          </>
        ) : (
          <span className="text-[12px] font-semibold truncate">{face === "settings" ? t("browser.openSettings") : t("browser.title")}</span>
        )}
        <div className="flex-1" />
        {face === "home" && (
          <>
            {browserRunning ? (
              <button
                type="button"
                onClick={() => void doAction("close-browser")}
                disabled={actionLoading !== null}
                data-testid="browser-close"
                className={BTN_QUIET}
              >
                {actionLoading === "close-browser" ? t("browser.closing") : t("browser.closeBrowser")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void doAction("open-browser")}
                disabled={actionLoading !== null || !canRunBrowser}
                data-testid="browser-open"
                className={BTN_PRIMARY}
              >
                {actionLoading === "open-browser" ? t("browser.opening") : t("browser.openBrowser")}
              </button>
            )}
            {/* The screen's own paste dialog, opened from here: the button
                used to float over the picture, apart from every other
                control. */}
            <button
              type="button"
              onClick={() => vncRef.current?.openPaste()}
              data-testid="browser-paste"
              title={t("vnc.pasteToRemote")}
              className={BTN_SECONDARY}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">content_paste</span>
              {t("vnc.pasteToRemote")}
            </button>
            <button type="button" onClick={openVncApp} data-testid="browser-open-vnc" className={BTN_SECONDARY}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">desktop_windows</span>
              {t("browser.openInVNC")}
            </button>
          </>
        )}
        {/* The settings live IN this app, on the desktop and on /app/browser
            alike, so a phone that landed here reaches them without a desktop
            listening for anything. */}
        <button
          type="button"
          onClick={() => setPage(face === "settings" ? "home" : "settings")}
          data-testid={face === "settings" ? "browser-settings-back" : "browser-open-settings"}
          aria-expanded={face === "settings"}
          className={BTN_SECONDARY}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
            {face === "settings" ? "arrow_back" : "settings"}
          </span>
          {face === "settings" ? t("browser.back") : t("browser.openSettings")}
        </button>
      </div>

      {face === "home" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {(error || agentBrowsing || (statusReadable && !canRunBrowser)) && (
            <div className="shrink-0 px-5 pt-3 space-y-2">
              {error && (
                <div className="flex items-start gap-2">
                  <ErrorWithFix source="browser" message={error} className="flex-1" />
                  <button type="button" onClick={() => setPage("settings")} className={BTN_SECONDARY}>
                    {t("browser.openSettings")}
                  </button>
                </div>
              )}
              {/* The two states a picture of the screen cannot explain: the
                  agent holding the browser, and a box with nothing to launch. */}
              {agentBrowsing && !error && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3">
                  <p className="flex-1 text-xs leading-relaxed text-amber-200/90">
                    {t("browser.agentHeadlessMessage", { harness: harnessLabel })}
                  </p>
                  <button
                    type="button"
                    onClick={() => void doAction("open-browser")}
                    disabled={actionLoading !== null}
                    data-testid="browser-move-browsing"
                    className={BTN_SECONDARY}
                  >
                    {t("browser.moveBrowsing")}
                  </button>
                </div>
              )}
              {statusReadable && !canRunBrowser && !error && !agentBrowsing && (
                <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <p className="flex-1 text-xs leading-relaxed text-white/60" data-testid="browser-cannot-run">
                    {!chromiumInstalled
                      ? t("browser.chromiumRequired")
                      : status?.chromium?.serviceSafe === false
                        ? t("browser.errorNotServiceSafe")
                        : t("browser.disabledMessage", { harness: harnessLabel })}
                  </p>
                  <button type="button" onClick={() => setPage("settings")} className={BTN_SECONDARY}>
                    {t("browser.openSettings")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* The screen itself, mounted whatever Chromium is doing: an idle
              virtual desktop is an honest picture of the device, and VNCApp
              carries its own repair path for a screen that is missing. */}
          <div className="relative flex-1 min-h-0 mt-3">
            <VNCApp ref={vncRef} pasteButton="hidden" />
            {starting && (
              <div
                className="absolute top-3 left-3 z-20 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/70 backdrop-blur-sm border border-white/10 text-xs text-white/90"
                data-testid="browser-starting-pill"
              >
                <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 14 }} aria-hidden="true">progress_activity</span>
                {t("browser.startingChromium")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <div className="mx-auto w-full max-w-2xl min-h-full flex flex-col">
            {error && <ErrorWithFix source="browser" message={error} />}
            {face === "settings" ? (
              <BrowserSettingsPanel
                status={status}
                harnessLabel={harnessLabel}
                actionLoading={actionLoading}
                onAction={(action) => void doAction(action)}
                onChanged={() => { void fetchStatus(); }}
                onOpenVnc={openVncApp}
                onShowWizard={() => setPage("home")}
              />
            ) : status ? (
              <BrowserSetupWizard
                status={status}
                harnessLabel={harnessLabel}
                onChanged={() => { void fetchStatus(); }}
                // Finishing is just "read yourself again": the flag comes back
                // true and the face flips to home. A wizard the owner left
                // WITHOUT opening the browser spends the automatic launch, so
                // home does not immediately do the thing they just skipped.
                onDone={(opened) => {
                  if (!opened) spendAutoLaunch();
                  void fetchStatus();
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
