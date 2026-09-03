"use client";

import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import * as kv from "@/lib/client-kv";
import { useModalDialog } from "@/hooks/useModalDialog";
import { WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";
import { attachWebappKvBridge } from "@/lib/webapp-kv-bridge";
import { deriveProtection, isBackupRunning,
  type ProtectionReason, type ProtectionState } from "@/lib/clawkeep-protection";
import TierUpgradeCelebration from "@/components/TierUpgradeCelebration";
import { OPEN_APP_EVENT, FIX_ERROR_EVENT, CHAT_MESSAGE_EVENT,
  NEW_APP_EVENT, notifyCodingRunStarted } from "@/lib/ui-events";
import { purgeLegacyChatCaches } from "@/lib/chat-history-cache";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SettingsApp from "@/components/SettingsApp";
import AppStore from "@/components/AppStore";
import HermesSkillsStore from "@/components/HermesSkillsStore";
import FilesApp from "@/components/FilesApp";
import ClawKeepApp from "@/components/ClawKeepApp";
import MemoryShardApp from "@/components/MemoryShardApp";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import SystemUpdateApp from "@/components/SystemUpdateApp";
import type { StoreApp } from "@/components/AppStore";
import TerminalApp from "@/components/TerminalApp";
import CodingAgentApp from "@/components/CodingAgentApp";
import InstalledAppSettings from "@/components/InstalledAppSettings";
import BrowserApp from "@/components/BrowserApp";
import VNCApp from "@/components/VNCApp";
import ChatPopup, { CHAT_PANEL_GAP } from "@/components/ChatPopup";
import ToastHost from "@/components/ToastHost";
import InstalledAppIcon from "@/components/InstalledAppIcon";
import SetupWizard from "@/components/SetupWizard";
import { I18nProvider, useT } from "@/lib/i18n";
import { cleanVersion } from "@/lib/version-utils";
import { fetchHarness } from "@/lib/client-harness";
import { samePairingToken } from "@/lib/telegram-pairing-token";
import type { InstalledMeta } from "@/lib/store-categories";
import { apps, type AppDef } from "@/lib/desktop-apps";
import {
  layoutIcons,
  layoutsEqual,
  moveIcon,
  storageGeometry,
  type IconLayout,
  type LayoutGeometry,
} from "@/lib/desktop-icon-layout";


const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// Every built-in id. This is the VALIDITY filter for a saved desktop list —
// an id naming no built-in reserves an empty grid slot — and it is deliberately
// wider than the default set below, so an icon the owner added from the
// launcher survives a reload.
const BUILT_IN_APP_IDS = apps.map(a => a.id);

// Built-ins that ship OFF the desktop. They stay in the launcher, and "Add to
// desktop" puts them back permanently; a fresh box just doesn't spend a grid
// slot on them out of the box.
//
// Remote Desktop (`vnc`) is the one: it shows the box's own X session, which is
// a diagnostic tool on a headless appliance, and it was the least-opened icon
// on the default grid.
const OFF_DESKTOP_BY_DEFAULT = new Set(["vnc"]);

const DEFAULT_DESKTOP_APPS = BUILT_IN_APP_IDS.filter(id => !OFF_DESKTOP_BY_DEFAULT.has(id));

// Desktop icon grid metrics. Module-level so the resize listener can derive
// `rowsPerColumn` without reaching into the component.
const CELL_H = 110; // px — one icon cell, label included
const TASKBAR_RESERVE = 72; // px kept clear at the bottom for the taskbar

/**
 * Declared order for icons that have no saved slot yet.
 *
 * Built-ins follow the order they are declared in `apps` above; store-installed
 * apps follow the persisted install order and lead, which is where a freshly
 * installed app has always appeared. The point is that this is DECLARED — the
 * previous code fell back to whatever order the arrays happened to be in when
 * the layout ran, and since the harness resolves asynchronously that order
 * differed from load to load.
 */
function canonicalIconOrder(installedAppIds: readonly string[]): string[] {
  return [...installedAppIds, ...BUILT_IN_APP_IDS.map((id) => `desktop-${id}`)];
}

// Apps that only make sense on ONE harness. The other harness's backend isn't
// installed, so its app would open onto errors:
//   - "openclaw" is the OpenClaw gateway Control UI.
//   - "store" is the OpenClaw App Store — it installs OpenClaw desktop apps via
//     the openclaw binary and reloads the OpenClaw gateway. On Hermes the Skills
//     app ("hermes-skills") is the equivalent surface.
//   - "memory-shard" is OpenClaw's memory index (`openclaw memory status`);
//     Hermes has no equivalent, and ClawKeep hid the same panel on that box.
//   - "hermes" / "hermes-skills" are the Hermes dashboard and skills store.
// BOTH the icon-layout filter (harnessHiddenAppIds) and getAllApps read THESE
// lists — keep them the single source of the policy so a hidden app can never be
// visible in one surface and hidden in another.
const OPENCLAW_ONLY_APP_IDS = ["openclaw", "store", "memory-shard"] as const;
const HERMES_ONLY_APP_IDS = ["hermes", "hermes-skills"] as const;

/**
 * Should an app the user installed from the OpenClaw store still be shown?
 *
 * An `installed` app IS an OpenClaw skill: its window (InstalledAppSettings)
 * calls /setup-api/apps/settings + /apps/skill-info, both of which shell out to
 * the openclaw binary, and its uninstall reloads the OpenClaw gateway. None of
 * that exists on a Hermes device, so the window would open onto errors — hide
 * it. A WEBAPP (meta.webappUrl) is different: those are ClawBox code-assistant
 * builds served by /setup-api/webapps, harness-independent, and frequently the
 * Hermes agent's OWN output — hiding them would be the regression, not the fix.
 *
 * This filters what is RENDERED only. The persisted installedApps list is never
 * mutated, so a dual box that switches back finds its layout intact.
 *
 * While the harness is still unresolved (null) these stay VISIBLE, unlike the
 * built-in harness apps: they are the majority case on an OpenClaw box, they
 * are not the surface goal B forbids, and hiding then re-showing them would
 * flash the whole desktop on every load.
 */
function isInstalledAppVisible(meta: InstalledMeta | undefined, harness: string | null): boolean {
  return harness !== "hermes" || !!meta?.webappUrl;
}

// LAN port of the auth-gated Hermes dashboard proxy (scripts/hermes-dashboard-proxy.js).
const HERMES_DASH_PROXY_PORT = 8090;

/**
 * One debounced POST per preference key, sent only when THAT key's state
 * changes.
 *
 * The desktop used to persist a snapshot of every key it holds 500 ms after
 * any of them changed. A desktop loaded before the agent (or the CLI, or a
 * second tab) installed or uninstalled an app still held the old
 * `installed_apps`, and wrote it back over the route's server-side write the
 * next time a window opened — the skill's files were gone but its icon came
 * back on every desktop, or a fresh install vanished from the desktop while
 * its files stayed. The same last-writer-wins race existed for every other
 * key between two open desktops, or a desktop and the agent's preferences_set.
 * So `installed_apps` and `installed_meta` are not written from here at all
 * any more — apps/install, apps/uninstall and webapp-registry.ts own them —
 * and each remaining key is its own write, keyed on its own state.
 */
function usePreferenceWriter(loadedRef: { current: boolean }) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // A write still pending when the desktop unmounts must not fire from the
  // torn-down tree.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);
  return useCallback((body: Record<string, unknown>) => {
    // Nothing is written before the saved preferences have been read: until
    // then the state is the defaults, and writing them would erase the device's.
    if (!loadedRef.current) return;
    const slot = Object.keys(body).join(",");
    const pending = timers.current.get(slot);
    if (pending) clearTimeout(pending);
    timers.current.set(slot, setTimeout(() => {
      timers.current.delete(slot);
      fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 500));
  }, [loadedRef]);
}

// Inline SVG icons for each app
function MIcon({ name, className = "", size = 24 }: { name: string; className?: string; size?: number }) {
  return <span className={`material-symbols-rounded ${className}`} style={{ fontSize: size }}>{name}</span>;
}

function AppIcon({ id, size = "w-6 h-6" }: { id: string; size?: string }) {
  const px = size.includes("w-6") ? 24 : size.includes("w-5") ? 20 : size.includes("w-4") ? 16 : 24;

  if (id === "hermes") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/hermes-agent.png" alt="Hermes" width={px} height={px} style={{ objectFit: "contain", borderRadius: 6 }} />;
  }

  if (id === "browser") {
    return (
      <svg className={`${size}`} viewBox="0 0 135.47 135.47">
        <path d="m67.733 67.733 29.33 16.933-29.33 50.8c37.408 0 67.733-30.325 67.733-67.733 0-12.341-3.3168-23.901-9.0837-33.867h-58.65z" fill="#afccf9"/>
        <path d="m67.733-1e-6c-25.07 0-46.942 13.63-58.654 33.875l29.324 50.792 29.33-16.933v-33.867h58.65c-11.714-20.24-33.583-33.867-58.65-33.867z" fill="#1767d1"/>
        <path d="m0 67.733c0 37.408 30.324 67.733 67.733 67.733l29.33-50.8-29.33-16.933-29.33 16.933-29.324-50.792c-5.7637 9.9632-9.0794 21.519-9.0794 33.858" fill="#679ef5"/>
        <path d="m101.6 67.733c0 18.704-15.163 33.867-33.867 33.867-18.704 0-33.867-15.163-33.867-33.867s15.163-33.867 33.867-33.867c18.704 0 33.867 15.163 33.867 33.867" fill="#fff"/>
        <path d="m95.25 67.733c0 15.197-12.32 27.517-27.517 27.517-15.197 0-27.517-12.32-27.517-27.517 0-15.197 12.32-27.517 27.517-27.517 15.197 0 27.517 12.32 27.517 27.517" fill="#1a74e7"/>
      </svg>
    );
  }

  if (id === "clawbox") {
    // The crab fills its square except for a little headroom above the
    // claws, so a 1.3× render is exactly tile-high and overhangs the sides a
    // touch; the flex parent centres the overflow.
    const scaled = Math.round(px * 1.3);
    return (
      <img
        src="/clawbox-crab.png"
        alt=""
        style={{ width: scaled, height: scaled, objectFit: "contain", maxWidth: "none", maxHeight: "none" }}
      />
    );
  }

  if (id === "openclaw") {
    return (
      <svg className={`${size} text-white`} viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="oc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ff4d4d"/>
            <stop offset="100%" stopColor="#991b1b"/>
          </linearGradient>
        </defs>
        <path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#oc-grad)"/>
        <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#oc-grad)"/>
        <path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#oc-grad)"/>
        <path d="M45 15Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
        <path d="M75 15Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
        <circle cx="45" cy="35" r="6" fill="#050810"/>
        <circle cx="75" cy="35" r="6" fill="#050810"/>
        <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
        <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
      </svg>
    );
  }

  if (id === "hermes-skills") {
    return <MIcon name="extension" className="text-white" size={px} />;
  }

  if (id === "coding") {
    return (
      <svg className={size} viewBox="0 0 120 120" fill="none">
        <path d="M48 36 L26 60 L48 84" stroke="#f97316" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M72 36 L94 60 L72 84" stroke="#f97316" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M70 32 L50 88" stroke="#f97316" strokeWidth="11" strokeLinecap="round" />
        <path d="M94 14 C95.5 22 100 26.5 108 28 C100 29.5 95.5 34 94 42 C92.5 34 88 29.5 80 28 C88 26.5 92.5 22 94 14 Z" fill="#ffffff" />
      </svg>
    );
  }

  const iconMap: Record<string, string> = {
    settings: "settings",
    setup: "construction",
    terminal: "terminal",
    files: "folder",
    clawkeep: "shield_lock",
    "memory-shard": "memory",
    system_update: "system_update",
    vnc: "desktop_windows",
    camera: "photo_camera",
    store: "storefront",
    chat: "chat_bubble",
  };

  const iconName = iconMap[id];
  if (!iconName) return null;
  return <MIcon name={iconName} className="text-white" size={px} />;
}

interface OpenWindow {
  id: string;
  appId: string;
  zIndex: number;
  minimized: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  meta?: Record<string, string>;
}

function ChromeDesktopInner() {
  const { t } = useT();
  const resolveAppName = (app: AppDef) => t(app.name) || app.name;
  const [setupChecked, setSetupChecked] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [showClawAiOfferNotification, setShowClawAiOfferNotification] = useState(false);
  // Account-level "is ClawBox AI configured on this device?" — drives
  // the shelf shield (colour + click target) and the offer-notification
  // visibility. Sourced from useClawboxLogin (which now polls
  // /setup-api/ai-models/status and exposes `clawaiConfigured` via its
  // `loggedIn` field), not from /setup-api/setup/status's
  // `ai_model_provider` — that's the *active chat provider* and would
  // falsely flip to false the moment a Max subscriber switches the
  // chat header dropdown to OpenAI, leaving them with a red shield
  // that opens AI Settings instead of ClawKeep.
  const clawboxLogin = useClawboxLogin();
  const clawAiAuthenticated = clawboxLogin.loggedIn;

  const syncSetupStatus = useCallback(async () => {
    const data = await fetch("/setup-api/setup/status").then((r) => r.json());
    setSetupRequired(!data.setup_complete);
    return data;
  }, []);

  // The "Free backup with ClawBox AI" offer-notification asks the user
  // to add ClawBox AI as a *desktop backup provider* — that's an
  // account-level question, not "is clawai the active chat provider
  // right now?". Source it from useClawboxLogin so a Max subscriber
  // chatting via OpenAI doesn't get nagged to add an account they
  // already have. Only show after setup is complete, the hook has
  // settled (avoid a transient pop on refresh), and no clawai
  // profile is configured.
  useEffect(() => {
    if (setupRequired) { setShowClawAiOfferNotification(false); return; }
    if (clawboxLogin.loading) return;
    setShowClawAiOfferNotification(!clawboxLogin.loggedIn);
  }, [setupRequired, clawboxLogin.loading, clawboxLogin.loggedIn]);

  // One-shot cleanup of stale chat localStorage from older builds.
  useEffect(() => { purgeLegacyChatCaches() }, []);

  // Check if setup is complete. The desktop boots either way; incomplete
  // setups get the wizard opened as a window after the UI loads.
  useEffect(() => {
    Promise.all([
      syncSetupStatus(),
      kv.init(),
    ])
      .then(() => setSetupChecked(true))
      .catch(() => setSetupChecked(true)); // If API fails, show desktop anyway
  }, [syncSetupStatus]);

  // ─── Haptic feedback helper ───
  const vibrate = useCallback((ms: number = 10) => {
    try { navigator.vibrate?.(ms); } catch {}
  }, []);

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [nextZIndex, setNextZIndex] = useState(100);
  const nextZIndexRef = useRef(100);
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [recentlyInstalled, setRecentlyInstalled] = useState<string | null>(null);
  const [installedMeta, setInstalledMeta] = useState<Record<string, InstalledMeta>>({});

  // ─── Active agent harness (openclaw | hermes) ───
  // On a Hermes device the OpenClaw gateway isn't installed, so hide the
  // OpenClaw-only Control UI app rather than surface a broken window.
  // Starts UNRESOLVED, never "openclaw": defaulting to a harness painted the
  // OpenClaw App Store on a Hermes device for one round-trip (and forever if
  // the fetch failed), which is exactly the surface that must not be reachable.
  // A few retries first — this is a same-origin call to our own server, so if
  // it keeps failing the desktop has bigger problems than two missing icons.
  // True once a wallpaper has been settled — either restored from the
  // device's saved preference or defaulted from the harness. Whichever of
  // those two requests answers first wins, and the other must not
  // overwrite it.
  const wallpaperChosen = useRef(false);
  const [activeHarness, setActiveHarness] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (attempt: number): Promise<void> => {
      try {
        const d = await fetchHarness({ force: attempt > 0 });
        if (!alive) return;
        if (d?.active) {
          setActiveHarness(d.active);
          // A Hermes device that has never picked a wallpaper opens on the
          // Hermes art. Guarded on wallpaperChosen because the preferences
          // request and this one race, and a saved choice must survive
          // whichever order they land in.
          if (d.active === "hermes" && !wallpaperChosen.current) {
            wallpaperChosen.current = true;
            setWallpaperId("hermes");
          }
          return;
        }
        throw new Error("no harness");
      } catch {
        if (!alive || attempt >= 2) return; // stay unresolved = stay closed
        setTimeout(() => { if (alive) load(attempt + 1); }, 500 * (attempt + 1));
      }
    };
    load(0);
    return () => { alive = false; };
  }, []);

  // The harness-specific apps hidden on this edition (OpenClaw Control-UI +
  // App Store on Hermes; the Hermes dashboard + Hermes Skills Store on
  // OpenClaw). See OPENCLAW_ONLY_APP_IDS / HERMES_ONLY_APP_IDS. Until the
  // harness is known BOTH sets are hidden — fail closed.
  const harnessHiddenAppIds = useMemo<string[]>(
    () =>
      activeHarness === "hermes"
        ? [...OPENCLAW_ONLY_APP_IDS]
        : activeHarness === "openclaw"
          ? [...HERMES_ONLY_APP_IDS]
          : [...OPENCLAW_ONLY_APP_IDS, ...HERMES_ONLY_APP_IDS],
    [activeHarness],
  );

  // ─── Desktop shortcuts for built-in apps ───
  const [desktopApps, setDesktopApps] = useState<string[]>(DEFAULT_DESKTOP_APPS);
  // Desktop shortcuts minus the hidden harness app — the icon-layout logic must
  // use THIS (not the raw list), otherwise the hidden app reserves an empty
  // grid slot and leaves a gap.
  const visibleDesktopApps = useMemo(
    () => desktopApps.filter((id) => !harnessHiddenAppIds.includes(id)),
    [desktopApps, harnessHiddenAppIds],
  );
  const [hiddenInstalledApps, setHiddenInstalledApps] = useState<string[]>([]);
  // Store-installed apps that should actually be drawn. Computed ONCE here
  // because four different layout paths need the same answer — when they
  // diverge, a hidden app keeps its grid slot and leaves a gap.
  const visibleInstalledAppIds = useMemo(
    () =>
      installedApps.filter(
        (id) => !hiddenInstalledApps.includes(id) && isInstalledAppVisible(installedMeta[id], activeHarness),
      ),
    [installedApps, hiddenInstalledApps, installedMeta, activeHarness],
  );
  const handleAddToDesktop = useCallback((appId: string) => {
    // The launcher hands over its own ids, which for an installed app carry
    // the `installed-` prefix; "Remove from desktop" stores the RAW id in
    // hidden_installed, and installed apps are drawn from installed_apps minus
    // that list — never from desktop_apps, which holds built-in ids only. The
    // two lists must not cross: this used to filter for `installed-x` (and
    // `installed-installed-x`), un-hiding nothing, while pushing the prefixed
    // id into desktop_apps, where it drew an empty grid slot forever.
    if (appId.startsWith("installed-")) {
      const rawId = appId.slice("installed-".length);
      setHiddenInstalledApps(prev => prev.filter(id => id !== rawId));
      return;
    }
    setDesktopApps(prev => prev.includes(appId) ? prev : [...prev, appId]);
  }, []);

  // ─── Dynamic pin state ───
  const [pinnedOverrides, setPinnedOverrides] = useState<Record<string, boolean>>({});
  const isAppPinned = useCallback((appId: string) => {
    if (appId in pinnedOverrides) return pinnedOverrides[appId];
    const app = apps.find(a => a.id === appId);
    return app?.pinned ?? false;
  }, [pinnedOverrides]);
  const handlePinApp = useCallback((appId: string) => {
    setPinnedOverrides(prev => ({ ...prev, [appId]: true }));

  }, []);
  const handleUnpinApp = useCallback((appId: string) => {
    setPinnedOverrides(prev => ({ ...prev, [appId]: false }));

  }, []);

  // ─── Wallpapers ───
  const wallpapers = [
    { id: "clawbox", name: "ClawBox", gradient: "", stars: false, nebula: false, image: "/clawbox-wallpaper.jpeg" },
    { id: "hermes", name: "Hermes", gradient: "", stars: false, nebula: false, image: "/hermes-wallpaper.jpeg" },
    { id: "deep-space", name: "Deep Space", gradient: "bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e]", stars: true, nebula: false, image: "" },
  ] as const;
  // Both wallpapers stay available on every device — this only decides which
  // one a device that has never chosen starts on. A Hermes box opens on the
  // Hermes art; OpenClaw is untouched.
  const [wallpaperId, setWallpaperId] = useState("clawbox");
  const currentWallpaper = wallpapers.find(w => w.id === wallpaperId) || wallpapers[0];
  type WpFit = "fill" | "fit" | "center";
  const [wpFit, setWpFit] = useState<WpFit>("fill");
  const [wpBgColor, setWpBgColor] = useState("#000000");
  const [wpOpacity, setWpOpacity] = useState(50);
  // ─── Unified SQLite load on mount ───
  const prefsLoaded = useRef(false);
  useEffect(() => {
    nextZIndexRef.current = nextZIndex;
  }, [nextZIndex]);

  useEffect(() => {
    fetch("/setup-api/preferences?all=1")
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        prefsLoaded.current = true;
        // Wallpaper. A saved choice always wins; wallpaperChosen records that
        // one exists, so the harness default below can't overwrite it later —
        // the two answers arrive from different requests and either can land
        // first.
        if (data.wp_id) {
          setWallpaperId(String(data.wp_id));
          wallpaperChosen.current = true;
        }
        if (data.wp_fit) setWpFit(data.wp_fit as WpFit);
        if (data.wp_bg_color) setWpBgColor(String(data.wp_bg_color));
        if (data.wp_opacity !== undefined && data.wp_opacity !== null) setWpOpacity(parseInt(String(data.wp_opacity), 10));
        // Installed apps
        if (Array.isArray(data.installed_apps)) setInstalledApps(data.installed_apps as string[]);
        if (data.installed_meta && typeof data.installed_meta === "object") setInstalledMeta(data.installed_meta as Record<string, InstalledMeta>);
        // Merge new built-ins into the saved list so they appear without a factory reset.
        if (Array.isArray(data.desktop_apps)) {
          // Built-in ids only. An older launcher pushed `installed-*` ids here
          // (see handleAddToDesktop); an id that names no built-in reserves an
          // empty grid slot, so a box that already saved one sheds it on load.
          // Validated against every built-in, not just the default set: an
          // owner who added Remote Desktop from the launcher keeps it.
          const saved = (data.desktop_apps as string[]).filter(id => BUILT_IN_APP_IDS.includes(id));
          // ...but only default-set built-ins are auto-added, so an app that
          // ships off the desktop never appears on a box that never had it.
          const missingNewBuiltins = DEFAULT_DESKTOP_APPS.filter(id => !saved.includes(id));
          setDesktopApps(missingNewBuiltins.length > 0 ? [...saved, ...missingNewBuiltins] : saved);
        }
        if (Array.isArray(data.hidden_installed)) setHiddenInstalledApps(data.hidden_installed as string[]);
        if (data.pinned_apps && typeof data.pinned_apps === "object") setPinnedOverrides(data.pinned_apps as Record<string, boolean>);
        if (data.icon_grid && typeof data.icon_grid === "object") setIconPositions(data.icon_grid as Record<string, { row: number; col: number }>);
        // Open windows
        if (Array.isArray(data.desktop_open_windows)) {
          // Restore the workspace but minimized — windows return to the taskbar
          // instead of popping open over a fresh desktop on every reload/reboot.
          const restored = (data.desktop_open_windows as Array<{ appId: string; minimized: boolean; x?: number; y?: number; width?: number; height?: number }>)
            .filter((w) => w.appId !== "setup")
            .map((w, i) => ({ id: `${w.appId}-${Date.now()}-${i}`, appId: w.appId, zIndex: 100 + i, minimized: true, x: w.x, y: w.y, width: w.width, height: w.height }));
          if (restored.length > 0) {
            setOpenWindows(restored);
            setNextZIndex(100 + restored.length);
          }
        }
        // Mascot
        if (data.ui_mascot_hidden) setMascotHidden(true);
        // Chat panel dock state — a docked side panel is a deliberate layout so
        // we still restore it. The FLOATING chat popup, however, must never
        // auto-open on load: it should appear only when the user taps the crab.
        // (We intentionally ignore a persisted `ui_chat_open` here.)
        if (data.ui_chat_panel_width && Number(data.ui_chat_panel_width) > 0) {
          setChatPanelWidth(Number(data.ui_chat_panel_width));
          setChatOpen(true);
        }
        // Auto-open chat once after fresh install (no saved preferences yet)
        if (!data.desktop_apps && !data.wp_id && !kv.get('clawbox-chat-greeted')) {
          kv.set('clawbox-chat-greeted', '1');
          setChatOpen(true);
        }
      })
      .catch(() => { prefsLoaded.current = true; });
  }, []);

  // The shared protection verdict, kept as two primitives rather than one
  // object so an unchanged verdict does not re-render the whole desktop on
  // every 5 s poll. Null until the first answer arrives.
  const [clawkeepState, setClawkeepState] = useState<ProtectionState | null>(null);
  const [clawkeepReason, setClawkeepReason] = useState<ProtectionReason | null>(null);
  const [clawkeepUnconfigured, setClawkeepUnconfigured] = useState(false);
  const [clawkeepBusy, setClawkeepBusy] = useState(false);
  const [clawkeepRestoring, setClawkeepRestoring] = useState(false);
  useEffect(() => {
    let aborted = false;
    let inFlight = false;
    const check = async () => {
      // Skip ticks while a previous fetch is still outstanding so a slow
      // device doesn't pile up overlapping requests.
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/setup-api/clawkeep", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as {
          paired?: boolean;
          lastBackupAtMs?: number;
          lastHeartbeatAtMs?: number;
          lastHeartbeatStatus?: string;
          schedule?: { enabled: boolean; frequency: "daily" | "weekly" };
          scheduleArmedAtMs?: number;
          encryptionConfigured?: boolean;
          restoring?: boolean;
        };
        if (aborted) return;
        // A box that was never paired has no backup that could be "overdue";
        // it gets the calm not-set-up-yet shield, not the red alert. Only an
        // explicit `paired: false` counts — a response missing the field keeps
        // the old alert fallback rather than silencing a real overdue backup.
        const unconfigured = data.paired === false;
        // One judgement for both shields. ClawKeep's own shield and this one
        // must never disagree about whether the box is protected, so the age
        // term, the schedule window and every explicit failure come from the
        // shared deriveProtection() rather than a second rule written here.
        const now = Date.now();
        const protection = deriveProtection({
          lastBackupAtMs: data.lastBackupAtMs ?? 0,
          lastHeartbeatAtMs: data.lastHeartbeatAtMs,
          lastHeartbeatStatus: data.lastHeartbeatStatus,
          schedule: data.schedule,
          scheduleArmedAtMs: data.scheduleArmedAtMs,
          encryptionConfigured: data.encryptionConfigured,
        }, now);
        setClawkeepUnconfigured(unconfigured);
        // The whole verdict travels, not a pair of booleans: the shelf paints
        // a drifted box amber and a never-protected one red, and it has to say
        // WHICH out loud — colour alone is not an announcement. A box that is
        // not paired publishes no verdict at all: `paired: false` is the opt-in
        // that has not happened, and it earns the calm setup shield rather than
        // an alarm about a backup nobody asked for (TASK-510).
        setClawkeepState(unconfigured ? null : protection.state);
        setClawkeepReason(unconfigured ? null : protection.reason);
        // A "running" heartbeat older than the cap `runBackup()` enforces is
        // a run that has been SIGKILLed, not progress — the same rule the card
        // uses. Without it the shelf pulses green for ever and the protection
        // verdict can never reach it.
        setClawkeepBusy(isBackupRunning(data, now));
        setClawkeepRestoring(!!data.restoring);
      } catch {
        // Leave last-known state alone on transient failures so the shield
        // doesn't flicker on a brief network blip.
      } finally {
        inFlight = false;
      }
    };
    void check();
    // Poll often enough for the shelf shield to start/stop pulsing within
    // a few seconds of a backup beginning or finishing.
    const id = window.setInterval(() => { void check(); }, 5_000);
    return () => {
      aborted = true;
      window.clearInterval(id);
    };
  }, []);

  const wpFitStyle: React.CSSProperties = wpFit === "fill"
    ? { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : wpFit === "fit"
    ? { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : { backgroundSize: "auto", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
  const CUSTOM_WPS_KEY = "clawbox-custom-wallpapers";
  const [customWallpapers, setCustomWallpapers] = useState<string[]>([]);
  // Wallpapers are large base64 blobs — keep in localStorage to avoid
  // bloating the KV JSON file that gets read/written on every state save.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_WPS_KEY);
      if (saved) setCustomWallpapers(JSON.parse(saved));
    } catch {}
  }, []);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const handleWallpaperUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setCustomWallpapers(prev => {
        const next = [...prev, dataUrl];
        try { localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(next)); } catch {}
        setWallpaperId(`custom-${next.length - 1}`);
        setWpOpacity(100);
        return next;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, []);

  // ─── Chat (mascot click toggles chat popup) ───
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPanelWidth, setChatPanelWidth] = useState(0);
  const [mascotX, setMascotX] = useState(85);
  const handleChatPanelModeChange = useCallback((panelWidth: number) => setChatPanelWidth(panelWidth), []);

  // What the docked chat actually occupies: its width PLUS the gap it floats
  // in, so a maximized window stops at the gap instead of sliding under the
  // panel and showing through it. Derived rather than folded into
  // `chatPanelWidth`, because that value is persisted and handed straight back
  // to the chat as `initialPanelWidth` — adding the gap there would widen the
  // panel by 12px on every reload.
  const chatPanelInset = chatPanelWidth > 0 ? chatPanelWidth + CHAT_PANEL_GAP : 0;

  // Open chat on skill-install, fix-error or handed-over-message events so
  // the user can watch the agent's response.
  useEffect(() => {
    const handler = () => setChatOpen(true);
    window.addEventListener('clawbox-skill-installed', handler);
    window.addEventListener(FIX_ERROR_EVENT, handler);
    window.addEventListener(CHAT_MESSAGE_EVENT, handler);
    // The Coding Agent's "Create app" button: the chat has to be open before
    // the card inside it can be seen.
    window.addEventListener(NEW_APP_EVENT, handler);
    return () => {
      window.removeEventListener('clawbox-skill-installed', handler);
      window.removeEventListener(FIX_ERROR_EVENT, handler);
      window.removeEventListener(CHAT_MESSAGE_EVENT, handler);
      window.removeEventListener(NEW_APP_EVENT, handler);
    };
  }, []);

  // ─── Mascot visibility ───
  const [mascotHidden, setMascotHidden] = useState(false);
  useEffect(() => {
    const onShow = () => setMascotHidden(false);
    const onHide = () => setMascotHidden(true);
    window.addEventListener("clawbox-show-mascot", onShow);
    window.addEventListener("clawbox-hide-mascot", onHide);
    return () => { window.removeEventListener("clawbox-show-mascot", onShow); window.removeEventListener("clawbox-hide-mascot", onHide); };
  }, []);

  // ─── Desktop icon grid + mobile detection (single resize listener) ───
  // `rowsPerColumn` lives in this state — not read ad hoc inside the layout
  // function — so that a change in viewport HEIGHT reflows the icons too. It
  // used to be sampled from window.innerHeight at arrange time while only the
  // column count (a width derivative) could trigger an arrange, so shrinking a
  // window vertically left the icons laid out for the old height.
  const [gridDims, setGridDims] = useState({ cols: 10, cellW: 100, mobile: false, rowsPerColumn: 6 });
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const cellW = w < 500 ? 85 : 100;
      const cols = Math.max(3, Math.floor(w / cellW));
      const rowsPerColumn = Math.max(1, Math.floor((window.innerHeight - TASKBAR_RESERVE) / CELL_H));
      setGridDims((prev) =>
        prev.cols === cols && prev.cellW === cellW && prev.mobile === w < 768 && prev.rowsPerColumn === rowsPerColumn
          ? prev
          : { cols, cellW, mobile: w < 768, rowsPerColumn },
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const GRID_COLS = gridDims.cols;
  const isMobile = gridDims.mobile;
  const GRID_ROWS = 6;
  const CELL_W = gridDims.cellW;
  const [iconPositions, setIconPositions] = useState<IconLayout>({});
  const [draggingIcon, setDraggingIcon] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // ─── Preference writes (per key, debounced, after all state is declared) ───
  // See usePreferenceWriter for why these are separate and why installed_apps
  // and installed_meta are not among them.
  const savePreferences = usePreferenceWriter(prefsLoaded);
  useEffect(() => {
    savePreferences({ wp_id: wallpaperId, wp_fit: wpFit, wp_bg_color: wpBgColor, wp_opacity: wpOpacity });
  }, [wallpaperId, wpFit, wpBgColor, wpOpacity, savePreferences]);
  useEffect(() => { savePreferences({ desktop_apps: desktopApps }); }, [desktopApps, savePreferences]);
  useEffect(() => { savePreferences({ hidden_installed: hiddenInstalledApps }); }, [hiddenInstalledApps, savePreferences]);
  useEffect(() => { savePreferences({ pinned_apps: pinnedOverrides }); }, [pinnedOverrides, savePreferences]);
  useEffect(() => { savePreferences({ icon_grid: iconPositions }); }, [iconPositions, savePreferences]);
  useEffect(() => {
    savePreferences({
      desktop_open_windows: openWindows
        .filter((w) => w.appId !== "setup")
        .map(w => ({ appId: w.appId, minimized: w.minimized, x: w.x, y: w.y, width: w.width, height: w.height })),
    });
  }, [openWindows, savePreferences]);
  useEffect(() => { savePreferences({ ui_mascot_hidden: mascotHidden ? 1 : 0 }); }, [mascotHidden, savePreferences]);
  useEffect(() => {
    savePreferences({ ui_chat_panel_width: chatPanelWidth || 0, ui_chat_open: chatOpen ? 1 : 0 });
  }, [chatPanelWidth, chatOpen, savePreferences]);

  // ─── Marquee selection ───
  const [selectedIcons, setSelectedIcons] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const marqueeRef = useRef<{ active: boolean; startX: number; startY: number }>({ active: false, startX: 0, startY: 0 });

  const getMarqueeRect = useCallback((m: { startX: number; startY: number; endX: number; endY: number }) => ({
    left: Math.min(m.startX, m.endX),
    top: Math.min(m.startY, m.endY),
    right: Math.max(m.startX, m.endX),
    bottom: Math.max(m.startY, m.endY),
  }), []);

  const getIconRect = useCallback((iconId: string, index: number) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const pos = iconPositions[iconId] || (() => {
      const col = index % GRID_COLS;
      const row = Math.floor(index / GRID_COLS) % GRID_ROWS;
      return { row, col };
    })();
    return {
      left: rect.left + pos.col * CELL_W,
      top: rect.top + pos.row * CELL_H,
      right: rect.left + pos.col * CELL_W + CELL_W,
      bottom: rect.top + pos.row * CELL_H + CELL_H,
    };
  }, [iconPositions]);

  const handleGridPointerDown = useCallback((e: React.PointerEvent) => {
    if (isMobile) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    setSelectedIcons(new Set());
    // Long-press on touch → open desktop context menu
    if (isTouchDevice) {
      longPressFired.current = false;
      const x = e.clientX, y = e.clientY;
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        ctxMenuOpenedAt.current = Date.now();
        setCtxMenu({ x, y });
      }, 500);
    }
    marqueeRef.current = { active: true, startX: e.clientX, startY: e.clientY };
    setMarquee(null);

    const onMove = (ev: PointerEvent) => {
      if (!marqueeRef.current.active) return;
      const dx = ev.clientX - marqueeRef.current.startX;
      const dy = ev.clientY - marqueeRef.current.startY;
      // Cancel long-press on movement
      if (Math.abs(dx) + Math.abs(dy) >= 5 && longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = undefined;
      }
      // Only start drawing after small threshold
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      const m = {
        startX: marqueeRef.current.startX,
        startY: marqueeRef.current.startY,
        endX: ev.clientX,
        endY: ev.clientY,
      };
      setMarquee(m);
      // Real-time selection during drag
      const mRect = {
        left: Math.min(m.startX, m.endX),
        top: Math.min(m.startY, m.endY),
        right: Math.max(m.startX, m.endX),
        bottom: Math.max(m.startY, m.endY),
      };
      const selected = new Set<string>();
      document.querySelectorAll("[data-desktop-icon-id]").forEach((el) => {
        const iconId = el.getAttribute("data-desktop-icon-id");
        if (!iconId) return;
        const r = el.getBoundingClientRect();
        if (r.left < mRect.right && r.right > mRect.left && r.top < mRect.bottom && r.bottom > mRect.top) {
          selected.add(iconId);
        }
      });
      setSelectedIcons(selected);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
      marqueeRef.current.active = false;
      setMarquee(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // ─── Context menu ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; appId?: string; isGroup?: boolean } | null>(null);

  const ctxMenuOpenedAt = useRef(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressFired = useRef(false);
  const isTouchDevice = typeof window !== "undefined" && "ontouchstart" in window;



  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: Event) => {
      // Ignore events that happen within 100ms of opening (same interaction)
      if (Date.now() - ctxMenuOpenedAt.current < 100) return;
      e.preventDefault();
      setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  const handleDesktopContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenuOpenedAt.current = Date.now();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleIconContextMenu = useCallback((e: React.MouseEvent, appId: string) => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenuOpenedAt.current = Date.now();
    // If right-clicking a selected icon in a multi-selection, show group menu
    if (selectedIcons.size > 1 && selectedIcons.has(appId)) {
      setCtxMenu({ x: e.clientX, y: e.clientY, appId, isGroup: true });
    } else {
      setSelectedIcons(new Set());
      setCtxMenu({ x: e.clientX, y: e.clientY, appId });
    }
  }, [selectedIcons]);



  // ─── Desktop icon layout ───
  // Every icon drawn on the desktop, in one place. Four code paths used to
  // rebuild this list independently; when they disagreed a hidden app kept its
  // grid slot and left a gap.
  const allIconIds = useMemo(
    () => [...visibleInstalledAppIds, ...visibleDesktopApps.map((id) => `desktop-${id}`)],
    [visibleInstalledAppIds, visibleDesktopApps],
  );

  const iconCanonicalOrder = useMemo(() => canonicalIconOrder(installedApps), [installedApps]);

  // Narrow viewports fill row-by-row like a phone home screen; wide ones fill
  // column-by-column like a desktop. Both flows are DENSE and idempotent — see
  // src/lib/desktop-icon-layout.ts.
  const iconGeometry = useMemo<LayoutGeometry>(
    () => ({
      flow: isMobile ? "row" : "column",
      cols: Math.max(1, GRID_COLS),
      rowsPerColumn: gridDims.rowsPerColumn,
    }),
    [isMobile, GRID_COLS, gridDims.rowsPerColumn],
  );

  // The layout actually drawn. Derived — never stale — so a hole, a slot left
  // behind by a hidden app, a newly installed icon, or a viewport change is
  // repaired in the same render it appears, before anything is painted.
  const iconLayout = useMemo(
    () => layoutIcons(allIconIds, iconPositions, iconGeometry, iconCanonicalOrder),
    [allIconIds, iconPositions, iconGeometry, iconCanonicalOrder],
  );

  // What gets SAVED. Always the column encoding, even while a phone draws the
  // same icons row-by-row, so one encoding round-trips at every viewport and a
  // rotation reflows the desktop without reordering it.
  const storedIconLayout = useMemo(
    () => layoutIcons(allIconIds, iconPositions, storageGeometry(iconGeometry), iconCanonicalOrder),
    [allIconIds, iconPositions, iconGeometry, iconCanonicalOrder],
  );

  // Persist the repaired layout. `layoutIcons` is idempotent, so this settles
  // after one pass instead of looping — and the saved `icon_grid` converges on
  // exactly the order the user sees.
  useEffect(() => {
    if (allIconIds.length === 0) return;
    setIconPositions((prev) => (layoutsEqual(prev, storedIconLayout) ? prev : storedIconLayout));
  }, [storedIconLayout, allIconIds.length]);

  const getIconPosition = useCallback(
    (appId: string) => iconLayout[appId] ?? iconPositions[appId] ?? { row: 0, col: 0 },
    [iconLayout, iconPositions],
  );

  // "Arrange icons" means: forget the hand-made order and go back to the
  // declared one. Compacting is no longer something the user has to ask for —
  // the layout above is always dense — so this is now the undo for dragging.
  const arrangeIcons = useCallback(() => {
    setIconPositions(layoutIcons(allIconIds, {}, storageGeometry(iconGeometry), iconCanonicalOrder));
  }, [allIconIds, iconGeometry, iconCanonicalOrder]);

  const snapToGrid = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / CELL_W);
    const row = Math.floor((clientY - rect.top) / CELL_H);
    const maxCols = Math.floor(rect.width / CELL_W);
    const maxRows = Math.floor(rect.height / CELL_H);
    if (row < 0 || row >= maxRows || col < 0 || col >= maxCols) return null;
    return { row, col };
  }, []);

  const handleIconDragStart = useCallback((appId: string, e: React.PointerEvent) => {
    if (!isMobile) {
      e.preventDefault();
      e.stopPropagation();
    }
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    const DRAG_THRESHOLD = isMobile ? 20 : 8;
    // Check if this icon is part of a multi-selection
    const isGroupDrag = selectedIcons.size > 1 && selectedIcons.has(appId);
    const groupIds = isGroupDrag ? Array.from(selectedIcons) : [appId];

    // Long-press on touch → open icon context menu
    longPressFired.current = false;
    if (isTouchDevice) {
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        ctxMenuOpenedAt.current = Date.now();
        if (selectedIcons.size > 1 && selectedIcons.has(appId)) {
          setCtxMenu({ x: startX, y: startY, appId, isGroup: true });
        } else {
          setCtxMenu({ x: startX, y: startY, appId });
        }
        // Clean up listeners since we're opening menu, not dragging
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }, 500);
    }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!isDragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!isDragging) {
        isDragging = true;
        // No mobile position sync needed any more: iconPositions is kept in the
        // storage encoding on every viewport, so a drop can be resolved against
        // it directly.
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
        setDraggingIcon(appId);
      }
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const s = snapToGrid(ev.clientX, ev.clientY);
      if (s) setDragGhost(s);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
      if (!isDragging) {
        // It was a tap/click — open the app via the onClick handler (unless long-press fired)
        setDraggingIcon(null);
        return;
      } else {
        const target = snapToGrid(ev.clientX, ev.clientY);
        if (target) {
          if (isGroupDrag) {
            // Group drag: compute delta from the dragged icon's original position and apply to all
            setIconPositions(prev => {
              const next = { ...prev };
              const originPos = prev[appId] || { row: 0, col: 0 };
              const dRow = target.row - originPos.row;
              const dCol = target.col - originPos.col;
              // Calculate new positions for all group icons
              const newPositions: Record<string, { row: number; col: number }> = {};
              let valid = true;
              for (const id of groupIds) {
                const pos = prev[id] || { row: 0, col: 0 };
                const newPos = { row: pos.row + dRow, col: pos.col + dCol };
                // Bounds check
                if (newPos.row < 0 || newPos.col < 0) { valid = false; break; }
                // Check occupied by non-group icon
                const occupied = Object.entries(prev).some(
                  ([oid, opos]) => !groupIds.includes(oid) && opos.row === newPos.row && opos.col === newPos.col
                );
                if (occupied) { valid = false; break; }
                newPositions[id] = newPos;
              }
              if (valid) {
                return { ...next, ...newPositions };
              }
              return prev;
            });
          } else {
            // Single icon drop: the icon takes the dropped slot and everything
            // else closes ranks around it. A drag therefore reorders the
            // desktop rather than pinning one icon to an absolute cell — the
            // grid has to stay dense and has to reflow when the window changes
            // shape, and an absolute cell survives neither.
            setIconPositions((prev) =>
              moveIcon(appId, target, allIconIds, prev, iconGeometry, iconCanonicalOrder),
            );
          }
        }
      }
      setDraggingIcon(null);
      setDragPos(null);
      setDragGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [snapToGrid, selectedIcons, isMobile, allIconIds, iconGeometry, iconCanonicalOrder]);


  // Update clock
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setDate(now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  // Install app handler — called after AppStore's server-side install completes
  const handleInstallApp = useCallback((app: StoreApp) => {
    setInstalledApps((prev) => prev.includes(app.id) ? prev : [...prev, app.id]);
    setInstalledMeta((prev) => ({ ...prev, [app.id]: { name: app.name, color: app.color, iconUrl: app.iconUrl, developer: app.developer } }));
    setHiddenInstalledApps((prev) => prev.filter((id) => id !== app.id));
    setRecentlyInstalled(app.id);
    setTimeout(() => setRecentlyInstalled(null), 1000);
  }, []);

  // Uninstall confirmation
  const [uninstallConfirm, setUninstallConfirm] = useState<string | null>(null);
  const dismissUninstall = useCallback(() => setUninstallConfirm(null), []);
  // The same trap the Store's install confirmation uses — dialog role, Escape,
  // focus moved in and restored — so a keyboard user is not left Tabbing
  // through the scrim into the desktop behind it. Cancel is first in DOM
  // order, so that is where focus lands rather than on the destructive button.
  const uninstallTitleId = useId();
  const uninstallPanelRef = useModalDialog<HTMLDivElement>({ open: uninstallConfirm !== null, onClose: dismissUninstall });

  const requestUninstallApp = useCallback((appId: string) => {
    setUninstallConfirm(appId);
  }, []);

  // Read through a ref inside the callback: capturing `uninstallConfirm`
  // directly made react-hooks/preserve-manual-memoization skip compiling the
  // whole component. The dialog's confirm button only renders (and is only
  // clickable) after the render that set the state, so the ref is current.
  const uninstallConfirmRef = useRef<string | null>(null);
  useEffect(() => {
    uninstallConfirmRef.current = uninstallConfirm;
  }, [uninstallConfirm]);

  const confirmUninstallApp = useCallback(async () => {
    const appId = uninstallConfirmRef.current;
    if (!appId) return;
    // Remove skill files and reload gateway
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      await fetch("/setup-api/apps/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      console.warn("[uninstall] Failed to uninstall skill:", err);
    }
    setInstalledApps((prev) => prev.filter((id) => id !== appId));
    // Meta and the shelf-pin override go with the app: both used to outlive
    // it, and the meta the desktop kept undid the route's own delete.
    setInstalledMeta((prev) => {
      const next = { ...prev };
      delete next[appId];
      return next;
    });
    setPinnedOverrides((prev) => {
      if (!(`installed-${appId}` in prev)) return prev;
      const next = { ...prev };
      delete next[`installed-${appId}`];
      return next;
    });
    setOpenWindows((prev) => prev.filter((w) => w.appId !== `installed-${appId}`));
    setIconPositions((prev) => {
      const next = { ...prev };
      delete next[appId];
      return next;
    });
    setUninstallConfirm(null);
    // Refresh agent session with updated skills
    window.dispatchEvent(new CustomEvent('clawbox-skill-installed', { detail: { action: 'uninstall', id: appId } }));
  }, []);

  // Get all apps including installed ones
  const getAllApps = useCallback((): AppDef[] => {
    const installedAppDefs: AppDef[] = [];
    for (const appId of installedApps) {
      const meta = installedMeta[appId];
      // Store-installed OpenClaw skills are unusable on Hermes (see
      // isInstalledAppVisible) — they must not reach the launcher, the shelf,
      // or any openApp(id) path either, not just the desktop grid.
      if (meta && isInstalledAppVisible(meta, activeHarness)) {
        const isWebapp = !!meta.webappUrl;
        const storeApp: StoreApp = { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl, developer: meta.developer };
        installedAppDefs.push({
          id: `installed-${appId}`,
          name: meta.name,
          color: meta.color,
          type: isWebapp ? "webapp" : "installed",
          url: isWebapp ? meta.webappUrl : undefined,
          launch: isWebapp ? meta.launch : undefined,
          pinned: false,
          defaultWidth: isWebapp ? 800 : 600,
          defaultHeight: isWebapp ? 600 : 400,
          storeApp,
        });
      }
    }
    // Per-harness apps come from the SAME computed list the icon layout uses,
    // so the two can never disagree — including while the harness is still
    // unresolved, when both harnesses' apps are hidden.
    const harnessApps = apps.filter((a) => !harnessHiddenAppIds.includes(a.id));
    return [
      ...harnessApps,
      ...installedAppDefs,
      {
        id: "setup",
        name: "app.setup",
        color: "#f97316",
        type: "setup",
        pinned: false,
        defaultWidth: 980,
        defaultHeight: 760,
      },
    ];
  }, [installedApps, installedMeta, activeHarness, harnessHiddenAppIds]);

  const getActiveWindowId = useCallback(() => {
    const visibleWindows = openWindows.filter((w) => !w.minimized);
    if (visibleWindows.length === 0) return null;
    return visibleWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b)).id;
  }, [openWindows]);

  const openApp = useCallback((appId: string, forceNew = false) => {
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
    if (!app) return;

    if (app.type === "external" && app.url) {
      // The Hermes dashboard opens through its auth-gated proxy on the same
      // host (port 8090), computed at click time so it works over LAN/mDNS/cable.
      const url = app.url === "hermes-dashboard"
        ? `${window.location.protocol}//${window.location.hostname}:${HERMES_DASH_PROXY_PORT}/`
        : app.url;
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    if (app.type === "webapp" && app.url && app.launch === "window") {
      // The app's meta asks for a real top-level browser document (e.g.
      // pointer lock for an FPS), which the sandboxed desktop iframe blocks —
      // open in a new browser window instead. Same rule as the iframe branch
      // below: http(s) or a same-origin path only, so a `javascript:` URL in
      // an installed app's meta cannot run in the desktop's top-level window.
      // Anything else falls through to the sandboxed iframe.
      try {
        const u = new URL(app.url, window.location.origin);
        if (["http:", "https:"].includes(u.protocol)) {
          window.open(u.href, "_blank", "noopener,noreferrer");
          return;
        }
      } catch {}
    }

    if (app.type === "chat") {
      setChatOpen(true);
      return;
    }

    if (!forceNew) {
      // Check if app is already open
      const existingWindow = openWindows.find((w) => w.appId === appId);
      if (existingWindow) {
        // If minimized, restore it; otherwise bring to front
        if (existingWindow.minimized) {
          setOpenWindows((prev) =>
            prev.map((w) =>
              w.id === existingWindow.id
                ? { ...w, minimized: false, zIndex: nextZIndex }
                : w
            )
          );
          setNextZIndex((z) => z + 1);
        } else {
          // Bring to front
          setOpenWindows((prev) =>
            prev.map((w) =>
              w.id === existingWindow.id ? { ...w, zIndex: nextZIndex } : w
            )
          );
          setNextZIndex((z) => z + 1);
        }
        return;
      }
    }

    // Open new window
    const windowId = `${appId}-${Date.now()}`;
    setOpenWindows((prev) => [
      ...prev,
      { id: windowId, appId, zIndex: nextZIndex, minimized: false },
    ]);
    setNextZIndex((z) => z + 1);
  }, [openWindows, nextZIndex, getAllApps]);

  const closeWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) => prev.filter((w) => w.id !== windowId));
  }, []);

  useEffect(() => {
    if (!setupChecked || !setupRequired) return;
    window.location.replace("/setup");
  }, [setupChecked, setupRequired]);

  const handleSetupComplete = useCallback(() => {
    setSetupRequired(false);
    void syncSetupStatus().catch(() => {});
    setOpenWindows((prev) => prev.filter((w) => w.appId !== "setup"));
  }, [syncSetupStatus]);

  useEffect(() => {
    const handlePrimaryAiConfigured = () => {
      void syncSetupStatus().catch(() => {});
    };
    window.addEventListener("clawbox:primary-ai-configured", handlePrimaryAiConfigured);
    return () => window.removeEventListener("clawbox:primary-ai-configured", handlePrimaryAiConfigured);
  }, [syncSetupStatus]);

  // ─── Android back button / browser back handling ───
  useEffect(() => {
    // Push a dummy history state so back button triggers popstate instead of leaving
    const pushState = () => {
      if (window.history.state !== "clawbox") {
        window.history.pushState("clawbox", "");
      }
    };
    pushState();

    const handleBack = (e: PopStateEvent) => {
      // Re-push state to stay on the page
      pushState();

      // Close things in priority order
      if (launcherOpen) { setLauncherOpen(false); return; }
      if (trayOpen) { setTrayOpen(false); return; }

      // Close topmost non-minimized window
      const visible = openWindows.filter(w => !w.minimized);
      if (visible.length > 0) {
        const top = visible.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
        closeWindow(top.id);
        return;
      }
    };

    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, [launcherOpen, trayOpen, openWindows, closeWindow]);

  // ─── Poll for MCP-triggered UI actions (open app, notify, etc.) ───
  const openAppRef = useRef(openApp);
  openAppRef.current = openApp;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ appId?: string }>).detail;
      if (detail?.appId) openAppRef.current(detail.appId);
    };
    window.addEventListener(OPEN_APP_EVENT, handler);
    return () => window.removeEventListener(OPEN_APP_EVENT, handler);
  }, []);

  // Typed into the next terminal window that opens — see clawbox:open-terminal.
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null);

  // The Coding Agent app asks for a terminal on a specific run: a live tail
  // while it works, or `claude-ds --resume` once it has finished. Through
  // openAppRef like the OPEN_APP_EVENT handler above: this listener used to
  // sit in a run-once effect holding the first render's openApp, whose
  // nextZIndex was still 100, so every terminal it opened landed BEHIND the
  // Coding Agent window the owner had just clicked in — and that effect never
  // removed the listener either.
  useEffect(() => {
    const handleOpenTerminal = (e: Event) => {
      const command = (e as CustomEvent<{ command?: string }>).detail?.command;
      if (typeof command !== "string" || !command) return;
      setTerminalCommand(command);
      // forceNew: a second run must get its own terminal rather than typing
      // into one already busy following the first.
      openAppRef.current("terminal", true);
    };
    window.addEventListener("clawbox:open-terminal", handleOpenTerminal);
    return () => window.removeEventListener("clawbox:open-terminal", handleOpenTerminal);
  }, []);

  /** Finished coding runs waiting to be seen, newest first. */
  const [codingNotices, setCodingNotices] = useState<{ runId: string; status: string; projectId: string | null; message: string }[]>([]);

  // The owner-notice ring: `ui:pending-actions` holds an array of
  // { id, ts, ...action }, newest last, written through pushPendingAction()
  // in src/lib/pending-actions.ts by every server-side notice (ui_notify,
  // `clawbox notify`, the coding agent's finish card, the webapp icon nudge).
  // Readers never delete or rewrite it — the writer prunes it. The previous
  // single-value slot was deleted by whichever desktop polled first, so with
  // a phone, a second tab or the remote-control tunnel open, every other
  // desktop missed the notice. Each desktop instead remembers what it has
  // seen: a watermark with a few seconds of replay grace, plus the ids at or
  // past it. The coding card is deduped by run id and register_webapp is
  // idempotent, so a replay is harmless. Entries are stamped by the BOX's
  // clock, which can be minutes off before NTP syncs (no RTC), so the
  // watermark is baselined against the ring's own newest stamp on first
  // sight rather than the browser's clock — comparing across the two dropped
  // every notice while the box ran behind.
  useEffect(() => {
    let active = true;
    let polling = false;
    let lastSeenTs = Date.now() - 5_000;
    let baselined = false;
    let seen = new Set<string>();
    const handle = (action: Record<string, unknown>) => {
      if (action.type === "open_app" && typeof action.appId === "string") {
        openAppRef.current(action.appId);
      } else if (action.type === "register_webapp" && typeof action.appId === "string" && action.name && action.url) {
        const appId = action.appId;
        setInstalledApps(prev => prev.includes(appId) ? prev : [...prev, appId]);
        setInstalledMeta(prev => ({
          ...prev,
          [appId]: {
            name: String(action.name),
            color: typeof action.color === "string" && action.color ? action.color : "#f97316",
            iconUrl: typeof action.iconUrl === "string" ? action.iconUrl : "",
            webappUrl: String(action.url),
          },
        }));
        setHiddenInstalledApps(prev => prev.includes(appId) ? prev.filter(id => id !== appId) : prev);
      } else if (action.type === "coding_agent" && typeof action.runId === "string") {
        // A finished coding run is something the owner may want to act on,
        // so it becomes a top-right CARD with a button rather than a toast
        // that slides away. Newest first, deduped by run id.
        const runId = action.runId;
        setCodingNotices(prev => (
          prev.some(n => n.runId === runId)
            ? prev
            : [{ runId, status: String(action.status ?? ""), projectId: typeof action.projectId === "string" ? action.projectId : null, message: String(action.message ?? "") }, ...prev].slice(0, 3)
        ));
        // A notice here can be the first this browser hears of a run — one
        // started from another device, or the server-side review pass that
        // follows a finish. Nudge the activity hook (idempotent: it only
        // re-asks the runs route) so an open chat shows the run card too.
        notifyCodingRunStarted();
      } else if (action.type === "notify" && action.message) {
        window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: action.message } }));
      }
    };
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const res = await fetch("/setup-api/kv?key=ui:pending-actions");
        if (res.ok) {
          const data = await res.json();
          const ring = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
          if (Array.isArray(ring)) {
            if (!baselined && ring.length > 0) {
              const newestRing = ring.reduce((max: number, e: unknown) => {
                const ts = e && typeof e === "object" && typeof (e as { ts?: unknown }).ts === "number" ? (e as { ts: number }).ts : 0;
                return ts > max ? ts : max;
              }, 0);
              if (newestRing > 0) {
                lastSeenTs = newestRing - 5_000;
                baselined = true;
              }
            }
            const present = new Set<string>();
            let newest = lastSeenTs;
            for (const entry of ring) {
              if (!entry || typeof entry !== "object") continue;
              const action = entry as Record<string, unknown>;
              const id = typeof action.id === "string" ? action.id : "";
              const ts = typeof action.ts === "number" ? action.ts : 0;
              if (!id || ts < lastSeenTs) continue;
              present.add(id);
              if (seen.has(id)) continue;
              seen.add(id);
              if (ts > newest) newest = ts;
              handle(action);
            }
            // Ids the writer has pruned can be forgotten; what is left is
            // bounded by the ring's own cap.
            seen = new Set([...seen].filter(id => present.has(id)));
            lastSeenTs = newest;
          }
        }
      } catch {}
      polling = false;
    };
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Answers the KV requests framed webapps post — see src/lib/webapp-kv-bridge.ts.
  useEffect(() => attachWebappKvBridge(), []);

  // Surfaces a corner card when ClawBox or OpenClaw has a newer release.
  // Dismissals persist per exact target-version pair via SQLite so the user
  // isn't pestered across browsers or after a cache wipe.
  const [updateAvailable, setUpdateAvailable] = useState<{
    clawbox: { current: string | null; target: string | null; updateAvailable?: boolean };
    openclaw: { current: string | null; target: string | null; updateAvailable?: boolean };
  } | null>(null);
  const lastVersionFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const checkVersions = async () => {
      try {
        const versionsRes = await fetch("/setup-api/update/versions");
        if (!active || !versionsRes.ok) return;
        const data = await versionsRes.json();
        const clawboxNeedsUpdate = data.clawbox?.updateAvailable ?? (!!data.clawbox?.target && data.clawbox.target !== data.clawbox.current);
        const openclawNeedsUpdate = data.openclaw?.updateAvailable ?? (!!data.openclaw?.target && data.openclaw.target !== data.openclaw.current);
        // Fingerprint covers both targets *and* currents — bumping the device
        // version after an update should retire a stale "available" card even
        // if the next-target hasn't shifted yet.
        const fingerprint = `${data.clawbox?.current ?? ""}|${data.clawbox?.target ?? ""}|${data.openclaw?.current ?? ""}|${data.openclaw?.target ?? ""}`;
        if (fingerprint === lastVersionFingerprintRef.current) return;
        lastVersionFingerprintRef.current = fingerprint;

        if (!clawboxNeedsUpdate && !openclawNeedsUpdate) {
          setUpdateAvailable(null);
          return;
        }
        // Only hit the dismissal store when we actually have something to suppress.
        const dismissalRes = await fetch("/setup-api/update/dismissal");
        let dismissed: string | null = null;
        if (dismissalRes.ok) {
          try { dismissed = (await dismissalRes.json()).fingerprint ?? null; } catch {}
        }
        const dismissalFingerprint = `${data.clawbox?.target ?? ""}|${data.openclaw?.target ?? ""}`;
        setUpdateAvailable(dismissed === dismissalFingerprint ? null : data);
      } catch { /* network blip — try again next interval */ }
    };
    checkVersions();
    const id = setInterval(checkVersions, 30 * 60 * 1000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const dismissUpdateNotification = useCallback(() => {
    setUpdateAvailable((current) => {
      if (current) {
        const fingerprint = `${current.clawbox?.target ?? ""}|${current.openclaw?.target ?? ""}`;
        fetch("/setup-api/update/dismissal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprint }),
        }).catch(() => { /* will retry next dismiss */ });
      }
      return null;
    });
  }, []);

  const openUpdateSettings = useCallback(() => {
    openAppRef.current("system_update");
    dismissUpdateNotification();
  }, [dismissUpdateNotification]);

  const openSettingsSection = useCallback((section: "ai" | "localAi" | "system") => {
    (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = section;
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section } }));
    openApp("settings");
  }, [openApp]);

  const openClawAiProviderSettings = useCallback(() => {
    const w = window as Window & {
      __clawboxPendingSettingsSection?: string;
      __clawboxPendingAiProvider?: string;
    };
    w.__clawboxPendingSettingsSection = "ai";
    w.__clawboxPendingAiProvider = "clawai";
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "ai" } }));
    window.dispatchEvent(new CustomEvent("clawbox:select-ai-provider", { detail: { providerId: "clawai" } }));
    openAppRef.current("settings");
    setShowClawAiOfferNotification(false);
  }, []);

  const openClawKeepOrAiProvider = useCallback(() => {
    if (clawAiAuthenticated) {
      openApp("clawkeep");
      return;
    }
    openClawAiProviderSettings();
  }, [clawAiAuthenticated, openApp, openClawAiProviderSettings]);

  // ─── Telegram pairing: desktop popup when a new access request lands ───
  // Polls the pairing store (a fast file read) so a new request surfaces even
  // when Settings is closed. De-duped by code via localStorage so a dismissed
  // request doesn't pop again.
  const [pairingRequests, setPairingRequests] = useState<
    Array<{ code?: string; id?: string; name?: string }>
  >([]);
  const [approvingPairCode, setApprovingPairCode] = useState<string | null>(null);

  const loadDismissedPairCodes = useCallback((): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem("clawbox:telegram-pairing-dismissed") || "[]")); }
    catch { return new Set(); }
  }, []);

  useEffect(() => {
    let active = true;
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const res = await fetch("/setup-api/telegram/pairing?poll=1", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data.configured && Array.isArray(data.pending)) {
            const dismissed = loadDismissedPairCodes();
            setPairingRequests(
              data.pending.filter((r: { code?: string }) => r.code && !dismissed.has(r.code)),
            );
          } else {
            setPairingRequests([]);
          }
        }
      } catch {}
      polling = false;
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => { active = false; clearInterval(id); };
  }, [loadDismissedPairCodes]);

  const approvePairingRequest = useCallback(async (code: string) => {
    if (!code) return;
    setApprovingPairCode(code);
    try {
      const res = await fetch("/setup-api/telegram/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setPairingRequests((prev) => prev.filter((r) => !samePairingToken(r.code, code)));
        window.dispatchEvent(new CustomEvent("clawbox:telegram-approved", { detail: { code } }));
        window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: "Approved — the bot let them know." } }));
      } else {
        window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: data.error || "Couldn't approve — the code may have expired." } }));
      }
    } catch {
      window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: "Couldn't approve — please try again." } }));
    } finally {
      setApprovingPairCode(null);
    }
  }, []);

  const dismissPairingRequest = useCallback((code: string) => {
    const dismissed = loadDismissedPairCodes();
    if (code) dismissed.add(code);
    try { localStorage.setItem("clawbox:telegram-pairing-dismissed", JSON.stringify([...dismissed])); } catch {}
    setPairingRequests((prev) => prev.filter((r) => r.code !== code));
  }, [loadDismissedPairCodes]);

  const openTelegramPairingSettings = useCallback(() => {
    (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = "telegram";
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "telegram" } }));
    openApp("settings");
  }, [openApp]);

  // If an approval happens elsewhere (the Settings list), drop that request from
  // the popup so it doesn't linger.
  useEffect(() => {
    const onApproved = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      if (code) setPairingRequests((prev) => prev.filter((r) => !samePairingToken(r.code, code)));
    };
    window.addEventListener("clawbox:telegram-approved", onApproved);
    return () => window.removeEventListener("clawbox:telegram-approved", onApproved);
  }, []);

  const updateWindowGeometry = useCallback((windowId: string, geo: { x: number; y: number; width: number; height: number }) => {
    setOpenWindows((prev) =>
      prev.map((w) => w.id === windowId ? { ...w, x: geo.x, y: geo.y, width: geo.width, height: geo.height } : w)
    );
  }, []);

  const focusWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, zIndex: nextZIndex } : w))
    );
    setNextZIndex((z) => z + 1);
  }, [nextZIndex]);

  const minimizeWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, minimized: true } : w))
    );
  }, []);

  const handleShelfAppClick = useCallback((appId: string) => {
    vibrate(10);
    const appWindows = openWindows.filter((w) => w.appId === appId);
    if (appWindows.length === 0) {
      openApp(appId);
      return;
    }

    // Check if any are minimized — restore them all
    const anyMinimized = appWindows.some(w => w.minimized);
    if (anyMinimized) {
      setOpenWindows((prev) =>
        prev.map((w) =>
          w.appId === appId && w.minimized
            ? { ...w, minimized: false, zIndex: nextZIndex }
            : w
        )
      );
      setNextZIndex((z) => z + 1);
      return;
    }

    // If the top window of this app is active, minimize all
    const topWindow = appWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b));
    if (getActiveWindowId() === topWindow.id) {
      appWindows.forEach(w => minimizeWindow(w.id));
    } else {
      // Bring all to front, top window on top
      let z = nextZIndex;
      setOpenWindows((prev) =>
        prev.map((w) => {
          if (w.appId !== appId) return w;
          return { ...w, zIndex: w.id === topWindow.id ? z + appWindows.length : z++ };
        })
      );
      setNextZIndex((z) => z + appWindows.length + 1);
    }
  }, [openWindows, openApp, minimizeWindow, getActiveWindowId, nextZIndex]);

  const pinnedApps = getAllApps().filter((a) => isAppPinned(a.id));

  const renderWindowContent = (appId: string, _meta?: Record<string, string>) => {
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
    if (!app) return null;

    switch (app.type) {
      case "settings":
        return (
          <div className="h-full overflow-y-auto">
            <SettingsApp ui={{
              wallpaperId,
              wpFit,
              wpBgColor,
              wpOpacity,
              mascotHidden,
              wallpapers: wallpapers.map(w => ({ id: w.id, name: w.name, image: w.image || undefined })),
              customWallpapers,
              onWallpaperChange: setWallpaperId,
              onWpFitChange: setWpFit,
              onWpBgColorChange: setWpBgColor,
              onWpOpacityChange: setWpOpacity,
              onMascotToggle: setMascotHidden,
              onWallpaperUpload: () => wallpaperInputRef.current?.click(),
              onCustomWallpaperDelete: (idx: number) => {
                setCustomWallpapers(prev => {
                  const next = prev.filter((_, i) => i !== idx);
                  try { localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(next)); } catch {}
                  if (wallpaperId === `custom-${idx}`) setWallpaperId("clawbox");
                  return next;
                });
              },
            }} />
          </div>
        );
      case "terminal":
        return <TerminalApp initialCommand={terminalCommand ?? undefined} />;
      case "coding":
        return <CodingAgentApp />;
      case "store":
        return (
          <AppStore
            installedAppIds={installedApps}
            onInstall={(app: StoreApp) => handleInstallApp(app)}
            onUninstall={requestUninstallApp}
          />
        );
      case "hermes_skills":
        return <HermesSkillsStore />;
      case "installed":
        return app.storeApp ? (
          <InstalledAppSettings
            appId={app.storeApp.id}
            storeApp={app.storeApp}
            icon={<InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-12 h-12" />}
            onUninstall={requestUninstallApp}
          />
        ) : null;
      case "files":
        return <FilesApp />;
      case "clawkeep":
        return <ClawKeepApp />;
      case "memory_shard":
        return <MemoryShardApp />;
      case "system_update":
        return <SystemUpdateApp />;
      case "browser":
        return <BrowserApp onOpenApp={openApp} />;
      case "vnc":
        return <VNCApp />;
      case "webapp": {
        let webappSrc = "about:blank";
        try { const u = new URL(app.url || "", window.location.origin); if (["http:", "https:"].includes(u.protocol)) webappSrc = u.href; } catch {}
        // Sandboxed to an opaque origin, the same as /app/[id]: the app is HTML
        // the agent wrote, and with allow-same-origin it ran in the desktop's
        // origin with the owner's session. Its persistence goes through the KV
        // bridge (data-webapp-id is how the bridge knows whose keys to serve).
        return (
          <iframe
            src={webappSrc}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            sandbox={WEBAPP_IFRAME_SANDBOX}
            data-webapp-id={app.storeApp?.id}
            title={resolveAppName(app)}
          />
        );
      }
      case "setup":
        return (
          <div className="h-full overflow-y-auto bg-[var(--bg-deep)]">
            <SetupWizard onComplete={handleSetupComplete} />
          </div>
        );
      case "placeholder":
        return (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-white/60">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ backgroundColor: app.color }}
            >
              <AppIcon id={app.id} size="w-10 h-10" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-medium text-white/80 mb-1">
                {resolveAppName(app)}
              </h2>
              <p className="text-sm">Coming Soon</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const activeWindowId = getActiveWindowId();

  // Installed store apps drawn on the desktop. Uses the SAME visibility memo as
  // the layout maths above — if the two disagree, a hidden app keeps its slot.
  const installedAppDefs = visibleInstalledAppIds
    .map((appId) => {
      const meta = installedMeta[appId];
      if (!meta) return null;
      return { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl } as StoreApp;
    })
    .filter((a): a is StoreApp => a !== null);

  // Built-in apps with desktop shortcuts (hide the other harness's apps).
  const desktopBuiltinApps = visibleDesktopApps
    .map((appId) => apps.find((a) => a.id === appId))
    .filter((a): a is AppDef => !!a);

  // Get all apps for launcher (including installed)
  const allApps = getAllApps();
  const allAppsForLauncher = allApps.filter((app) => app.id !== "setup");

  // ─── Global drag-and-drop file upload ───
  const [desktopDragOver, setDesktopDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const dragCountRef = useRef(0);

  const handleDesktopDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCountRef.current++;
      setDesktopDragOver(true);
    }
  }, []);
  const handleDesktopDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDesktopDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) { dragCountRef.current = 0; setDesktopDragOver(false); }
  }, []);
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const uploadFileWithProgress = useCallback((file: File, dir: string, onProgress: (pct: number) => void): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true });
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve({ ok: false, error: data.error });
          } catch {
            resolve({ ok: false, error: `Upload failed (${xhr.status})` });
          }
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: "Network error" });
      xhr.send(file);
    });
  }, []);

  const handleDesktopDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDesktopDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const dir = "/home/clawbox/Downloads";
    const total = files.length;
    const totalSize = Array.from(files).reduce((sum, f) => sum + f.size, 0);

    // Check available disk space before uploading
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      if (res.ok) {
        const data = await res.json();
        if (typeof data.availableSpace === 'number' && totalSize > data.availableSpace) {
          setUploadStatus(`Not enough disk space. Need ${formatBytes(totalSize)}, only ${formatBytes(data.availableSpace)} available.`);
          setTimeout(() => setUploadStatus(null), 5000);
          return;
        }
      }
    } catch { /* proceed anyway */ }

    let ok = 0;
    setUploadProgress(0);
    for (let i = 0; i < total; i++) {
      const file = files[i];
      setUploadStatus(`Uploading ${file.name} (${i + 1}/${total})...`);
      const result = await uploadFileWithProgress(file, dir, (pct) => {
        const overallPct = Math.round(((i + pct / 100) / total) * 100);
        setUploadProgress(overallPct);
      });
      if (result.ok) {
        ok++;
      } else if (result.error) {
        setUploadStatus(result.error);
        setUploadProgress(0);
        setTimeout(() => { setUploadStatus(null); }, 5000);
        return;
      }
    }
    setUploadStatus(`Uploaded ${ok}/${total} file(s)`);
    setUploadProgress(100);
    setTimeout(() => { setUploadStatus(null); setUploadProgress(0); }, 3000);
  }, [uploadFileWithProgress]);

  if (!setupChecked || setupRequired) {
    return <div className="bg-[var(--bg-deep)]" style={{ height: '100dvh' }} />;
  }

  return (
    <div
      data-testid="desktop-root"
      className="relative overflow-hidden select-none"
      style={{ height: '100dvh' }}
      onContextMenu={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
        e.preventDefault();
      }}
      onDragEnter={handleDesktopDragEnter}
      onDragOver={handleDesktopDragOver}
      onDragLeave={handleDesktopDragLeave}
      onDrop={handleDesktopDrop}
    >
      <TierUpgradeCelebration />
      {/* Drop overlay */}
      {desktopDragOver && (
        <div className="fixed inset-0 z-[99998] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed border-orange-500/60 bg-[#0d1117]/90">
            <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 48 }}>upload_file</span>
            <span className="text-lg font-semibold text-white">Drop files to upload</span>
            <span className="text-sm text-white/50">Files will be saved to Downloads</span>
          </div>
        </div>
      )}
      {/* Upload status toast */}
      {uploadStatus && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[99998] min-w-[220px] rounded-lg bg-[var(--bg-elevated)] border border-white/10 text-sm text-white shadow-lg overflow-hidden">
          <div className="px-4 py-2">{uploadStatus}</div>
          {uploadProgress < 100 && (
            <div className="h-1 bg-white/5">
              <div className="h-full bg-[var(--coral-bright)] transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
            </div>
          )}
        </div>
      )}
      {/* Renders the `clawbox:toast` events the pending-action poll above and
          the pairing flow dispatch. Without it ui_notify, `clawbox notify`
          and every server-side owner notice were fired and never shown. */}
      <ToastHost />
      {(updateAvailable || showClawAiOfferNotification || pairingRequests.length > 0 || codingNotices.length > 0) && (
        <div className="pointer-events-none fixed top-4 right-4 z-[99998] flex w-[320px] flex-col gap-3">
          {/* New version available notification */}
          {updateAvailable && (() => {
            const cb = updateAvailable.clawbox;
            const oc = updateAvailable.openclaw;
            const cbNeeds = cb?.updateAvailable ?? (!!cb?.target && cb.target !== cb.current);
            const ocNeeds = oc?.updateAvailable ?? (!!oc?.target && oc.target !== oc.current);
            return (
              <div
                className="rounded-xl bg-[var(--bg-elevated)] border border-white/10 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 20 }}>system_update</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white">{t("updateNotification.title")}</div>
                    <div className="text-xs text-white/60 mt-0.5">{t("updateNotification.description")}</div>
                    <div className="mt-2 space-y-0.5">
                      {cbNeeds && (
                        <div className="text-[11px] text-white/70 font-mono truncate">
                          ClawBox {cleanVersion(cb.current) ?? "?"} → <span className="text-orange-300">{cleanVersion(cb.target) ?? "?"}</span>
                        </div>
                      )}
                      {ocNeeds && (
                        <div className="text-[11px] text-white/70 font-mono truncate">
                          OpenClaw {cleanVersion(oc.current) ?? "?"} → <span className="text-orange-300">{cleanVersion(oc.target) ?? "?"}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={dismissUpdateNotification}
                    className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
                    aria-label={t("updateNotification.dismiss")}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
                  </button>
                </div>
                <div className="pointer-events-auto flex items-center gap-2 px-4 pb-3">
                  <button
                    onClick={openUpdateSettings}
                    className="flex-1 px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold transition-colors cursor-pointer border-none"
                  >
                    {t("updateNotification.viewUpdate")}
                  </button>
                  <button
                    onClick={dismissUpdateNotification}
                    className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors cursor-pointer border-none"
                  >
                    {t("updateNotification.later")}
                  </button>
                </div>
              </div>
            );
          })()}

          {showClawAiOfferNotification && (
            <div
              className="rounded-xl bg-[var(--bg-elevated)] border border-green-400/20 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-3 px-4 py-3">
                <div
                  className="clawbox-notification-shield-blink w-9 h-9 rounded-full bg-green-500/15 border border-green-400/30 flex items-center justify-center shrink-0"
                >
                  <span
                    className="material-symbols-rounded clawbox-notification-shield-float text-green-300"
                    style={{ fontSize: 20 }}
                  >
                    shield
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-white">Free backup with ClawBox AI</div>
                  <div className="text-xs leading-relaxed text-white/60 mt-0.5">
                    Add ClawBox AI as your free desktop backup and keep a ready-to-use provider one click away.
                  </div>
                </div>
                <button
                  onClick={() => setShowClawAiOfferNotification(false)}
                  className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
                  aria-label="Dismiss ClawBox AI offer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
              <div className="px-4 pb-2">
                <div className="rounded-lg border border-green-400/15 bg-green-500/10 px-3 py-2 text-[11px] leading-relaxed text-green-50/90">
                  We’ll open AI Provider settings with ClawBox AI already selected so you can log in right away.
                </div>
              </div>
              <div className="pointer-events-auto flex items-center gap-2 px-4 pb-3">
                <button
                  onClick={openClawAiProviderSettings}
                  className="flex-1 px-3 py-1.5 rounded-md bg-green-500 hover:bg-green-600 text-white text-xs font-semibold transition-colors cursor-pointer border-none"
                >
                  Login with ClawBox AI
                </button>
                <button
                  onClick={() => setShowClawAiOfferNotification(false)}
                  className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors cursor-pointer border-none"
                >
                  Later
                </button>
              </div>
            </div>
          )}

          {/* New Telegram access request popup(s) */}
          {/* A finished coding run. Same shape as the pairing card above,
              because it is the same kind of thing: a notice the owner may want
              to act on. The button opens the Coding Agent app, where the run's
              summary and what it changed are — the card itself carries only
              ClawBox-authored text, never the model's. */}
          {codingNotices.map((notice) => {
            const failed = notice.status === "failed";
            const stopped = notice.status === "stopped";
            const accent = failed ? "#f87171" : stopped ? "#cbd5e1" : "#4ade80";
            const glyph = failed ? "error" : stopped ? "stop_circle" : "task_alt";
            const title = failed
              ? t("codingAgent.chatFailed")
              : stopped ? t("codingAgent.chatStopped") : t("codingAgent.chatFinished");
            return (
              <div
                key={notice.runId}
                className="rounded-xl bg-[var(--bg-elevated)] border border-white/10 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
                role="status"
                aria-live="polite"
                data-testid="coding-agent-notice"
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: `${accent}26`, border: `1px solid ${accent}4d` }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 20, color: accent }}>{glyph}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white">{title}</div>
                    {notice.projectId && <div className="text-xs text-white/60 mt-0.5 truncate">{notice.projectId}</div>}
                    <div className="text-[11px] text-white/40 font-mono mt-0.5 truncate">{notice.runId}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCodingNotices(prev => prev.filter(n => n.runId !== notice.runId))}
                    className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
                    aria-label={t("codingAgent.noticeDismiss")}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
                  </button>
                </div>
                <div className="pointer-events-auto flex items-center gap-2 px-4 pb-3">
                  <button
                    type="button"
                    onClick={() => { openApp("coding"); setCodingNotices(prev => prev.filter(n => n.runId !== notice.runId)); }}
                    className="flex-1 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors cursor-pointer border-none inline-flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>smart_toy</span>
                    {t("codingAgent.noticeOpen")}
                  </button>
                </div>
              </div>
            );
          })}

          {pairingRequests.map((req) => {
            const label = req.name || req.id || "A Telegram user";
            const code = req.code || "";
            return (
              <div
                key={code || req.id}
                className="rounded-xl bg-[var(--bg-elevated)] border border-[#229ED9]/30 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-[#229ED9]/15 border border-[#229ED9]/30 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[#5eb8e6]" style={{ fontSize: 20 }}>person_add</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white">New Telegram access request</div>
                    <div className="text-xs text-white/60 mt-0.5 truncate">{label} wants to chat with your bot.</div>
                    {req.id && <div className="text-[11px] text-white/40 font-mono mt-0.5 truncate">id {req.id}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissPairingRequest(code)}
                    className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
                    aria-label="Dismiss"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
                  </button>
                </div>
                <div className="pointer-events-auto flex items-center gap-2 px-4 pb-3">
                  <button
                    type="button"
                    onClick={() => approvePairingRequest(code)}
                    disabled={!code || approvingPairCode === code}
                    className="flex-1 px-3 py-1.5 rounded-md bg-[#229ED9] hover:bg-[#1b87ba] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors cursor-pointer border-none inline-flex items-center justify-center gap-1.5"
                  >
                    {approvingPairCode === code && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>}
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={openTelegramPairingSettings}
                    className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors cursor-pointer border-none"
                  >
                    Open
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Desktop wallpaper background */}
      {(() => {
        const customIdx = wallpaperId.startsWith("custom-") ? parseInt(wallpaperId.split("-")[1]) : -1;
        const customWp = customIdx >= 0 ? customWallpapers[customIdx] : undefined;
        return customWp ? (
          <>
            <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundColor: wpBgColor }} />
            <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundImage: `url(${customWp})`, ...wpFitStyle, opacity: wpOpacity / 100 }} />
          </>
      ) : currentWallpaper.image ? (
        <>
          <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundColor: wpBgColor }} />
          <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundImage: `url(${currentWallpaper.image})`, ...wpFitStyle, opacity: wpOpacity / 100 }} />
        </>
      ) : (
        <>
          <div className={`absolute inset-0 ${currentWallpaper.gradient} z-0 pointer-events-none`} />
          {currentWallpaper.stars && <div className="absolute inset-0 bg-stars z-0 pointer-events-none" />}
          {currentWallpaper.nebula && <div className="absolute inset-0 bg-nebula z-0 pointer-events-none" />}
        </>
      );
      })()}
      {/* Hidden file input for wallpaper upload */}
      <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleWallpaperUpload} />
      {/* Desktop icon grid — draggable + right-click surface */}
      <div data-testid="desktop-surface" className="absolute inset-0 z-[1] flex justify-center" style={{ paddingBottom: 56, paddingTop: 24, overflowY: isMobile ? "auto" : "visible" }} onContextMenu={handleDesktopContextMenu} onPointerDown={handleGridPointerDown}>
      <div ref={gridRef} className="relative" style={{ width: GRID_COLS * CELL_W, maxWidth: "100%", height: isMobile && allIconIds.length > 0 ? `${(Math.floor((allIconIds.length - 1) / GRID_COLS) + 1) * CELL_H}px` : undefined }}>
        {installedAppDefs.map((app) => {
          const pos = getIconPosition(app.id);
          const isBeingDragged = draggingIcon === app.id;
          const isGroupMemberDragged = draggingIcon !== null && draggingIcon !== app.id && selectedIcons.size > 1 && selectedIcons.has(app.id) && selectedIcons.has(draggingIcon);
          const isRecent = recentlyInstalled === app.id;
          const isSelected = selectedIcons.has(app.id);
          return (
            <div
              key={app.id}
              data-desktop-icon-id={app.id}

              style={isBeingDragged && dragPos ? {
                position: "fixed",
                left: dragPos.x - 40,
                top: dragPos.y - 40,
                zIndex: 9999,
                opacity: 0.85,
                pointerEvents: "none",
                transition: "none",
              } : isGroupMemberDragged ? {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                opacity: 0.4,
                pointerEvents: "none",
                transition: "opacity 0.15s",
              } : {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                transition: "left 0.2s, top 0.2s",
              }}
              className="flex items-center justify-center pointer-events-auto"
            >
              <button
                onPointerDown={(e) => handleIconDragStart(app.id, e)}
                onClick={() => { if (!draggingIcon && !longPressFired.current) openApp(`installed-${app.id}`); }}
                onContextMenu={(e) => handleIconContextMenu(e, app.id)}
                className={`group flex flex-col items-center justify-start gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${
                  isRecent ? "animate-install-bounce" : ""
                } ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <InstalledAppIcon appId={app.id} iconUrl={app.iconUrl} name={app.name} size="w-7 h-7" />
                </div>
                <span className="text-[13px] leading-tight text-white font-semibold text-center line-clamp-2 max-w-[80px] min-h-[calc(2*13px*1.25)]" style={{ textShadow: "0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.4)" }}>
                  {app.name}
                </span>
              </button>
            </div>
          );
        })}

        {/* Built-in app desktop shortcuts */}
        {desktopBuiltinApps.map((app) => {
          const iconId = `desktop-${app.id}`;
          const pos = getIconPosition(iconId);
          const isBeingDragged = draggingIcon === iconId;
          const isGroupMemberDragged = draggingIcon !== null && draggingIcon !== iconId && selectedIcons.size > 1 && selectedIcons.has(iconId) && selectedIcons.has(draggingIcon);
          const isSelected = selectedIcons.has(iconId);
          return (
            <div
              key={iconId}
              data-desktop-icon-id={iconId}
              style={isBeingDragged && dragPos ? {
                position: "fixed",
                left: dragPos.x - 40,
                top: dragPos.y - 40,
                zIndex: 9999,
                opacity: 0.85,
                pointerEvents: "none",
                transition: "none",
              } : isGroupMemberDragged ? {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                opacity: 0.4,
                pointerEvents: "none",
                transition: "opacity 0.15s",
              } : {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                transition: "left 0.2s, top 0.2s",
              }}
              className="flex items-center justify-center pointer-events-auto"
            >
              <button
                onPointerDown={(e) => handleIconDragStart(`desktop-${app.id}`, e)}
                onClick={() => { if (!draggingIcon && !longPressFired.current) openApp(app.id); }}
                onContextMenu={(e) => handleIconContextMenu(e, `desktop-${app.id}`)}
                className={`group flex flex-col items-center justify-start gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <AppIcon id={app.id} size="w-7 h-7" />
                </div>
                <span className="text-[13px] leading-tight text-white font-semibold text-center line-clamp-2 max-w-[80px] min-h-[calc(2*13px*1.25)]" style={{ textShadow: "0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.4)" }}>
                  {resolveAppName(app)}
                </span>
              </button>
            </div>
          );
        })}

        {/* Ghost indicator for drop target */}
        {draggingIcon && dragGhost && (() => {
          const isOccupied = Object.entries(iconLayout).some(
            ([id, pos]) => id !== draggingIcon && pos.row === dragGhost.row && pos.col === dragGhost.col
          );
          if (isOccupied) {
            // Show insertion line on the left edge of the occupied cell
            return (
              <div
                style={{
                  position: "absolute",
                  left: dragGhost.col * CELL_W - 2,
                  top: dragGhost.row * CELL_H + 8,
                  width: 4,
                  height: CELL_H - 16,
                }}
                className="rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)] pointer-events-none"
              />
            );
          }
          return (
            <div
              style={{
                position: "absolute",
                left: dragGhost.col * CELL_W,
                top: dragGhost.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
              }}
              className="flex items-center justify-center pointer-events-none"
            >
              <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/30 bg-white/5" />
            </div>
          );
        })()}

        </div>{/* end centering wrapper */}

        {/* Marquee selection rectangle */}
        {marquee && (
          <div
            className="fixed pointer-events-none border border-blue-400/60 bg-blue-400/15 z-[2]"
            style={{
              left: Math.min(marquee.startX, marquee.endX),
              top: Math.min(marquee.startY, marquee.endY),
              width: Math.abs(marquee.endX - marquee.startX),
              height: Math.abs(marquee.endY - marquee.startY),
            }}
          />
        )}
      </div>

      {/* Mascot - tapping toggles chat popup. It stays on the desktop even when
          the chat is docked as a vertical panel; the Mascot slides itself clear
          of the panel (rightInset) so it isn't hidden behind it.
          mascotX is captured once from onTap; we intentionally do NOT stream the
          frozen mascot's position while the chat is open — that used to nudge
          mascotX for a frame right after opening, flashing the popup to the wrong
          corner before it settled. */}
      {!isMobile && (
        <Mascot frozen={chatOpen} rightInset={chatPanelInset} onTap={(x?: number) => { if (x !== undefined) setMascotX(x); setChatOpen(prev => !prev); }} />
      )}
      <ChatPopup isOpen={chatOpen} onClose={() => setChatOpen(false)} onOpenSettingsSection={openSettingsSection} onPanelModeChange={handleChatPanelModeChange} initialPanelWidth={chatPanelWidth} mascotX={mascotHidden ? 85 : mascotX} trayMode={mascotHidden} mobile={isMobile} />

      {/* Windows — mobile: fullscreen, desktop: ChromeWindow */}
      {isMobile ? (
        // Mobile: render only the topmost non-minimized window as fullscreen
        (() => {
          const visible = openWindows.filter(w => !w.minimized);
          if (visible.length === 0) return null;
          const top = visible.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
          const allApps = getAllApps();
          const app = allApps.find(a => a.id === top.appId);
          if (!app) return null;
          return (
            <div
              key={top.id}
              className="fixed inset-0 z-[200] flex flex-col bg-[#0d1117] animate-slide-up"
              style={{ paddingBottom: 'calc(56px + env(safe-area-inset-bottom))', paddingTop: 'env(safe-area-inset-top)' }}
            >
              {/* Mobile window header */}
              <div className="flex items-center gap-3 px-3 py-2 bg-[#161b22] border-b border-white/[0.06] shrink-0">
                <button
                  onClick={() => { vibrate(10); closeWindow(top.id); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/60 cursor-pointer"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <div className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: app.color }}>
                  {app.type === "installed" && app.storeApp
                    ? <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-3 h-3" />
                    : <AppIcon id={app.id} size="w-3 h-3" />}
                </div>
                <span className="text-sm font-medium text-white/80 truncate flex-1">{resolveAppName(app)}</span>
                {visible.length > 1 && (
                  <button
                    onClick={() => minimizeWindow(top.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/60 cursor-pointer"
                    title="Switch app"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" /></svg>
                  </button>
                )}
              </div>
              {/* Mobile window content */}
              <div className="flex-1 overflow-hidden">
                {renderWindowContent(top.appId, top.meta)}
              </div>
            </div>
          );
        })()
      ) : (
        // Desktop: normal ChromeWindow rendering
        openWindows.map((window) => {
          const app = allApps.find((a) => a.id === window.appId);
          if (!app) return null;

          const renderWindowIcon = () => {
            if (app.type === "installed" && app.storeApp) {
              return (
                <div
                  className="w-5 h-5 rounded flex items-center justify-center"
                  style={{ backgroundColor: app.color }}
                >
                  <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-3 h-3" />
                </div>
              );
            }
            return (
              <div
                className="w-5 h-5 rounded flex items-center justify-center"
                style={{ backgroundColor: app.color }}
              >
                <AppIcon id={app.id} size="w-3 h-3" />
              </div>
            );
          };

          return (
            <ChromeWindow
              key={window.id}
              title={resolveAppName(app)}
              icon={renderWindowIcon()}
              appId={window.appId}
              defaultWidth={app.defaultWidth}
              defaultHeight={app.defaultHeight}
              initialPosition={window.x !== undefined && window.y !== undefined ? { x: window.x, y: window.y } : undefined}
              initialSize={window.width !== undefined && window.height !== undefined ? { width: window.width, height: window.height } : undefined}
              isActive={window.id === activeWindowId}
              zIndex={window.zIndex}
              onClose={() => closeWindow(window.id)}
              onFocus={() => focusWindow(window.id)}
              onMinimize={() => minimizeWindow(window.id)}
              onGeometryChange={(geo) => updateWindowGeometry(window.id, geo)}
              minimized={window.minimized}
              rightInset={chatPanelInset}
            >
              {renderWindowContent(window.appId, window.meta)}
            </ChromeWindow>
          );
        })
      )}

      {/* App Launcher */}
      <ChromeLauncher
        apps={allAppsForLauncher.map((app) => {
          if (app.type === "installed" && app.storeApp) {
            return {
              id: app.id,
              name: resolveAppName(app),
              color: app.color,
              icon: <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} />,
              isPinned: isAppPinned(app.id),
            };
          }
          return {
            id: app.id,
            name: resolveAppName(app),
            color: app.color,
            icon: <AppIcon id={app.id} />,
            isPinned: isAppPinned(app.id),
          };
        })}
        isOpen={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onAppClick={openApp}
        onPinApp={handlePinApp}
        onUnpinApp={handleUnpinApp}
        onAddToDesktop={handleAddToDesktop}
      />

      {/* System Tray */}
      <SystemTray
        isOpen={trayOpen}
        onClose={() => setTrayOpen(false)}
        date={date}
        time={time}
      />

      {/* Shelf (taskbar) */}
      <ChromeShelf
        apps={(() => {
          const allApps = getAllApps();
          const pinnedIds = new Set(pinnedApps.map(a => a.id));
          // Open apps that aren't pinned
          const unpinnedOpenApps = openWindows
            .filter(w => !pinnedIds.has(w.appId))
            .map(w => allApps.find(a => a.id === w.appId))
            .filter((a): a is AppDef => !!a)
            // Deduplicate
            .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i);

          const mapApp = (app: AppDef) => {
            const appWindows = openWindows.filter((w) => w.appId === app.id);
            const topWin = appWindows.length > 0
              ? appWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b))
              : null;
            const renderIcon = () => {
              if (app.type === "installed" && app.storeApp) {
                return (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: app.color }}>
                    <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} />
                  </div>
                );
              }
              return (
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: app.color }}>
                  <AppIcon id={app.id} />
                </div>
              );
            };
            return {
              id: app.id,
              name: resolveAppName(app),
              icon: renderIcon(),
              isOpen: appWindows.length > 0,
              isActive: topWin?.id === activeWindowId && !topWin?.minimized,
              isPinned: pinnedIds.has(app.id),
              windowCount: appWindows.length,
              url: app.url,
            };
          };

          return [
            ...pinnedApps.map(mapApp),
            ...unpinnedOpenApps.map(mapApp),
          ];
        })()}
        onAppClick={handleShelfAppClick}
        onNewWindow={(appId) => openApp(appId, true)}
        onLauncherClick={() => {
          setTrayOpen(false);
          setLauncherOpen((prev) => !prev);
        }}
        onTrayClick={() => {
          setLauncherOpen(false);
          setTrayOpen(false);
          openSettingsSection("system");
        }}
        onClawKeepShieldClick={openClawKeepOrAiProvider}
        clawkeepStatus={{ state: clawkeepState, reason: clawkeepReason, unconfigured: clawkeepUnconfigured, busy: clawkeepBusy, restoring: clawkeepRestoring }}
        onPowerClick={() => {
          setLauncherOpen(false);
          setTrayOpen((prev) => !prev);
        }}
        onPinApp={handlePinApp}
        onUnpinApp={handleUnpinApp}
        onCloseApp={(appId) => {
          setOpenWindows(prev => prev.filter(w => w.appId !== appId));
        }}
        onShelfSettings={() => openApp("settings")}
        onChatClick={() => setChatOpen(prev => !prev)}
        showChatButton={mascotHidden || isMobile}
        time={time}
        clawAiAuthenticated={clawAiAuthenticated}
      />


      {/* Context menu */}
      {ctxMenu && (
        <div
          data-testid="desktop-context-menu"
          className="fixed z-[99999] min-w-[200px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90 overflow-y-auto"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 220),
            top: Math.min(ctxMenu.y, window.innerHeight - 400),
            maxHeight: "calc(100vh - 80px)",
          }}
          onClick={() => setCtxMenu(null)}
        >
          {ctxMenu.isGroup && ctxMenu.appId ? (
            <>
              <div className="px-4 py-1.5 text-xs text-white/40 font-medium">
                {t("desktop.ctx.itemsSelected", { count: selectedIcons.size })}
              </div>
              <div className="border-t border-white/10 my-0.5" />
              <button onClick={() => {
                selectedIcons.forEach(id => {
                  if (id.startsWith("desktop-")) {
                    openApp(id.replace("desktop-", ""));
                  } else {
                    openApp(`installed-${id}`);
                  }
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("desktop.ctx.openAll")}
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                setIconPositions(prev => {
                  const next = { ...prev };
                  selectedIcons.forEach(id => { delete next[id]; });
                  return next;
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> {t("desktop.ctx.resetPositions")}
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                selectedIcons.forEach(id => {
                  if (id.startsWith("desktop-")) {
                    const appId = id.replace("desktop-", "");
                    setDesktopApps(prev => prev.filter(a => a !== appId));
                  } else {
                    setHiddenInstalledApps(prev => prev.includes(id) ? prev : [...prev, id]);
                  }
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>visibility_off</span> {t("desktop.ctx.removeAllFromDesktop")}
              </button>
            </>
          ) : ctxMenu.appId ? (() => {
            // Resolve the actual appId for opening
            const resolvedAppId = ctxMenu.appId!.startsWith("desktop-")
              ? ctxMenu.appId!.replace("desktop-", "")
              : `installed-${ctxMenu.appId}`;
            // A store skill's window is its settings page; a new tab of that
            // is not something anyone asks for, and it used to open a broken
            // page. Webapps and built-ins keep the entry.
            const isSkill = allApps.find((a) => a.id === resolvedAppId)?.type === "installed";
            return (
            <>
              <button onClick={() => openApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("shelf.open")}
              </button>
              {openWindows.some(w => w.appId === resolvedAppId) && (
                <button onClick={() => openApp(resolvedAppId, true)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>tab</span> {t("shelf.newWindow")}
                </button>
              )}
              {!isSkill && (
                <button onClick={() => {
                  window.open(`/app/${encodeURIComponent(resolvedAppId)}`, "_blank");
                }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("shelf.openNewTab")}
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {isAppPinned(resolvedAppId) ? (
                <button onClick={() => handleUnpinApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>keep_off</span> {t("shelf.unpinFromShelf")}
                </button>
              ) : (
                <button onClick={() => handlePinApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>keep</span> {t("shelf.pinToShelf")}
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              {!ctxMenu.appId!.startsWith("desktop-") && (
                <>
                  <button onClick={() => {
                    if (ctxMenu.appId) requestUninstallApp(ctxMenu.appId);
                  }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span> {t("store.uninstall")}
                  </button>
                  <div className="border-t border-white/10 my-1" />
                </>
              )}
              <button onClick={() => {
                if (ctxMenu.appId) setIconPositions(prev => {
                  const next = { ...prev };
                  delete next[ctxMenu.appId!];
                  return next;
                });
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> {t("desktop.ctx.resetPosition")}
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                if (!ctxMenu.appId) return;
                const id = ctxMenu.appId;
                if (id.startsWith("desktop-")) {
                  // Remove built-in app desktop shortcut
                  const appId = id.replace("desktop-", "");
                  setDesktopApps(prev => prev.filter(a => a !== appId));
                } else {
                  // Hide installed app from desktop (not uninstall)
                  setHiddenInstalledApps(prev => prev.includes(id) ? prev : [...prev, id]);
                }
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>visibility_off</span> {t("desktop.ctx.removeFromDesktop")}
              </button>
            </>
            ); })() : (
            <>
              {/* The store entry follows the harness: on Hermes there is no App
                  Store and Hermes Skills is its equivalent. Both entries were
                  hard-coded and opened ids that no longer resolve on Hermes. */}
              {/* Driven by the same hidden-app list as every other surface, so
                  an unresolved harness offers NEITHER store rather than the
                  wrong one. */}
              {!harnessHiddenAppIds.includes("hermes-skills") && (
                <button onClick={() => openApp("hermes-skills")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>extension</span> {t("app.skills")}
                </button>
              )}
              {!harnessHiddenAppIds.includes("store") && (
                <button onClick={() => openApp("store")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>storefront</span> {t("store.appStore")}
                </button>
              )}
              <button onClick={() => openApp("terminal")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>terminal</span> {t("app.terminal")}
              </button>
              <button onClick={() => openApp("coding")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>code</span> {t("app.codingAgent")}
              </button>
              <div className="border-t border-white/10 my-1" />
              {!harnessHiddenAppIds.includes("hermes") && (
                <button onClick={() => openApp("hermes")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="w-4 h-4 inline-block"><AppIcon id="hermes" size="w-4 h-4" /></span> Hermes
                </button>
              )}
              {!harnessHiddenAppIds.includes("openclaw") && (
                <button onClick={() => openApp("openclaw")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="w-4 h-4 inline-block"><AppIcon id="openclaw" size="w-4 h-4" /></span> OpenClaw
                </button>
              )}
              <button onClick={() => arrangeIcons()} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> {t("desktop.ctx.arrangeIcons")}
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => openApp("settings")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>settings</span> {t("app.settings")}
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => window.location.reload()} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span> {t("desktop.ctx.refresh")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Uninstall confirmation modal */}
      {uninstallConfirm && (() => {
        const meta = installedMeta[uninstallConfirm];
        const appName = meta?.name || uninstallConfirm;
        return (
          <div className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={dismissUninstall}>
            {/* The role sits on the panel, not the scrim — see useModalDialog. */}
            <div
              ref={uninstallPanelRef}
              role="dialog" aria-modal="true" aria-labelledby={uninstallTitleId}
              data-testid="uninstall-dialog"
              className="bg-[var(--bg-elevated)] border border-white/10 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-col items-center text-center">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4" style={{ backgroundColor: meta?.color || "#6b7280" }}>
                  <InstalledAppIcon appId={uninstallConfirm} iconUrl={meta?.iconUrl} name={appName} size="w-7 h-7" />
                </div>
                <h3 id={uninstallTitleId} className="text-lg font-semibold text-white mb-1">{t("uninstall.title", { name: appName })}</h3>
                <p className="text-sm text-white/50 mb-6">{t("uninstall.message")}</p>
                <div className="flex gap-3 w-full">
                  <button
                    type="button"
                    onClick={dismissUninstall}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/15 text-white transition-colors cursor-pointer"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={confirmUninstallApp}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors cursor-pointer"
                  >
                    {t("store.uninstall")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default function ChromeDesktop() {
  return (
    <I18nProvider>
      <ChromeDesktopInner />
    </I18nProvider>
  );
}
