"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import StatusMessage from "./StatusMessage";
import SignalBars from "./SignalBars";
import AIProviderIcon from "./AIProviderIcon";
import HarnessPicker from "./HarnessPicker";
import type { WifiNetwork } from "@/lib/wifi-utils";
import { signalToLevel, dbmToLevel } from "@/lib/wifi-utils";
import { dispatchOpenApp } from "@/lib/ui-events";
import AIModelsStep from "./AIModelsStep";
import TelegramConfiguringOverlay from "./TelegramConfiguringOverlay";
import RemoteControlPanel from "./RemoteControlPanel";
import FreeTierUpgradeCard from "./FreeTierUpgradeCard";
import { copyToClipboard } from "@/lib/clipboard";
import ClawBoxLoginModal, { type ClawBoxLoginFeature } from "./ClawBoxLoginModal";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import { I18nProvider, useT, LANGUAGES, type Locale } from "@/lib/i18n";
import { cachedActiveHarness, fetchHarness } from "@/lib/client-harness";
import { isPairingToken, normalizePairingToken, samePairingToken } from "@/lib/telegram-pairing-token";
import { lastModelSegment } from "@/lib/chat-header-pills";
import { QRCodeSVG } from "qrcode.react";
import type { UpdateState } from "@/lib/updater";
import { RESTART_STEP_ID } from "@/lib/update-constants";
import { cleanVersion } from "@/lib/version-utils";
import { CLAWBOX_AI_TIER_LABEL, normalizeClawboxAiTier } from "@/lib/clawbox-ai-models";
import { useReconnect } from "@/hooks/useReconnect";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { DISCORD_INVITE_URL } from "@/lib/community";
import {
  SettingsGroup,
  SettingsGroupHeader,
  SettingsNav,
  SettingsRow,
  SettingsSegmented,
  SettingsSlider,
  SettingsSwitch,
  SettingsTextField,
} from "./settings";

/* ── Types ── */

export interface UISettings {
  wallpaperId: string;
  wpFit: "fill" | "fit" | "center";
  wpBgColor: string;
  wpOpacity: number;
  mascotHidden: boolean;
  wallpapers: { id: string; name: string; image?: string }[];
  customWallpapers: string[];
  onWallpaperChange: (id: string) => void;
  onWpFitChange: (fit: "fill" | "fit" | "center") => void;
  onWpBgColorChange: (color: string) => void;
  onWpOpacityChange: (opacity: number) => void;
  onMascotToggle: (hidden: boolean) => void;
  onWallpaperUpload: () => void;
  onCustomWallpaperDelete: (idx: number) => void;
}

interface SettingsAppProps {
  ui: UISettings;
}

interface SwapStats { used: number; total: number; percent: number }
interface DiskMount { filesystem: string; size: string; used: string; avail: string; usePercent: number; mountpoint: string }
interface NetworkIface { name: string; ip: string; rx: number; tx: number }
interface ProcessEntry { pid: string; user: string; cpu: number; mem: number; command: string }
interface SystemStats {
  overview: { hostname: string; os: string; kernel: string; uptime: string; arch: string; platform: string };
  cpu: { usage: number; model: string; cores: number; loadAvg: string[]; speed: number };
  memory: { total: number; used: number; free: number; usedPercent: number; swap: SwapStats };
  temperature?: { value: number | null; display: string };
  gpu?: { usage: number };
  storage: DiskMount[];
  network: NetworkIface[];
  processes: ProcessEntry[];
  timestamp: number;
}


const SECTIONS = ["appearance", "wifi", "ai", "localAi", "telegram", "remote", "system", "about"] as const;

const REBOOT_PROBE_GRACE_MS = 8_000;
const REBOOT_PROBE_INTERVAL_MS = 3_000;
const REBOOT_PROBE_TIMEOUT_MS = 2_500;
const REBOOT_HARD_REDIRECT_MS = 45_000;
type Section = typeof SECTIONS[number];

/* ── Sidebar nav items ── */
const NAV_ITEMS: { id: Section; icon: string; labelKey?: string; label?: string }[] = [
  { id: "appearance", icon: "palette", labelKey: "settings.appearance" },
  { id: "wifi", icon: "wifi", labelKey: "settings.network" },
  { id: "ai", icon: "smart_toy", labelKey: "settings.aiProvider" },
  { id: "localAi", icon: "memory", label: "Local AI" },
  { id: "telegram", icon: "send", labelKey: "settings.telegram" },
  { id: "remote", icon: "cloud_sync", labelKey: "settings.remote" },
  { id: "system", icon: "monitor_heart", labelKey: "settings.system" },
  { id: "about", icon: "info", labelKey: "settings.about" },
];

/* ── Helpers ── */
// Hermes registers the on-device model under this single provider id whichever
// local runtime backs it (see HERMES_LOCAL_PROVIDER in lib/hermes-local-ai.ts).
// OpenClaw instead names the runtime directly ("llamacpp" / "ollama"), so
// "is the local model the active provider" has to accept either spelling.
const HERMES_LOCAL_PROVIDER_ID = "clawlocal";

// Copy for the four Local AI states, kept as data so the status line and the
// card below cannot drift apart. "Selected" vs "available" is the distinction
// that matters: installing the on-device model does not make it the one that
// answers, and saying "sleeping until needed" when it was never selected read
// as though it were.
const LOCAL_AI_STATUS_SUFFIX = {
  offline: "endpoint not responding",
  available: "available, not currently selected",
  standby: "selected · sleeping until needed",
  running: "selected · running",
} as const;

function formatBytes(b: number): string {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + u[i];
}

/* The System resource ladder. Used ONLY by the System pane's bars (CPU,
   memory, GPU, storage).

   The thresholds are untouched — 90 / 70 / 50 is a semantic ladder, not
   decoration — and so is the reading of each rung. What changes is that the
   four literals become four `--set-*` roles, which is the only way a bar can
   follow the palette: a hex cannot re-tint itself for Hermes, and these bars
   sit on a surface that does.

   The mapping is deliberately the closest role to what ships, so nothing moves
   on screen: `#f97316` IS `--set-primary` exactly, `#06b6d4 → --set-success`
   (cyan, and 0–49% is the healthy reading), `#eab308 → --set-warning` (amber,
   the pane's one caution accent), `#ef4444 → --set-error`. Neither
   `--set-primary` nor `--set-success` is re-pointed under Hermes, so the
   ladder reads identically on every box. */
function barColor(pct: number): string {
  return pct >= 90
    ? "var(--set-error)"
    : pct >= 70
      ? "var(--set-primary)"
      : pct >= 50
        ? "var(--set-warning)"
        : "var(--set-success)";
}

/* Temperature runs on a DIFFERENT scale from `barColor` — 80 / 60 °C, three
   rungs, and the number, the word and the bar all switch together. Extracted
   so the two call sites cannot drift; the thresholds are the ones that ship
   (`#22d3ee → --set-success`, `#f97316 → --set-primary`, `#ef4444 →
   --set-error`). */
function tempColor(celsius: number): string {
  return celsius > 80
    ? "var(--set-error)"
    : celsius > 60
      ? "var(--set-primary)"
      : "var(--set-success)";
}

/* The old 40×20 `Toggle` lived here. Its single call site — Show Mascot, in
   Appearance — now uses `SettingsSwitch`, which is a real `role="switch"`, is
   44px on its longest side, and paints from `--set-*` instead of
   `bg-orange-500` / `bg-white/15`. */

type SectionStatus = { subtitle: string | null };

export default function SettingsApp({ ui }: SettingsAppProps) {
  const { t, locale, setLocale } = useT();
  const navLabel = useCallback((item: { label?: string; labelKey?: string }) => item.label ?? (item.labelKey ? t(item.labelKey) : ""), [t]);
  const notifyChatModelStateChanged = useCallback(() => {
    window.dispatchEvent(new Event("clawbox:chat-model-state-changed"));
  }, []);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const currentLang = LANGUAGES.find(l => l.code === locale) ?? LANGUAGES[0];
  const [section, setSection] = useState<Section>("appearance");
  const [openClawAIOfferRequest, setOpenClawAIOfferRequest] = useState(0);
  const [requestedAiProviderId, setRequestedAiProviderId] = useState<string | null>(null);
  const [providerSelectionRequest, setProviderSelectionRequest] = useState(0);
  // Mobile: null means show nav list, a section means show content with back button
  const [mobileSection, setMobileSection] = useState<Section | null>(null);

  // ClawBox account gate — Remote Control needs the user to be signed in to
  // the portal so the tunnel can be claimed. The hook polls /ai-models/status
  // (already the truth source for active provider + tier).
  const clawboxLogin = useClawboxLogin();
  const [loginModal, setLoginModal] = useState<{ open: boolean; feature: ClawBoxLoginFeature }>(
    { open: false, feature: "remote" },
  );
  const requireLoginFor = useCallback((feature: ClawBoxLoginFeature): boolean => {
    // Don't gate while we still don't know — assume logged in to avoid a
    // brief modal flash for users who actually are. The 30s poll will
    // self-correct in either direction.
    if (clawboxLogin.loading) return false;
    if (clawboxLogin.loggedIn) return false;
    setLoginModal({ open: true, feature });
    return true;
  }, [clawboxLogin.loading, clawboxLogin.loggedIn]);

  // Three-state pick for the Remote Control section: needs portal sign-in,
  // needs paid plan, or shows the panel. A bare loading spinner stands in
  // while `clawboxLogin.loading` so we don't flicker between states or
  // leave the pane visibly empty for the ~30 s first-poll window.
  const renderRemoteSection = () => {
    if (clawboxLogin.loading) {
      return (
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading Remote Control"
          className="max-w-xl flex items-center justify-center py-[48px] text-[var(--set-on-surface-variant)]"
        >
          <span
            className="material-symbols-rounded animate-spin"
            style={{ fontSize: 24 }}
            aria-hidden="true"
          >
            progress_activity
          </span>
        </div>
      );
    }
    if (!clawboxLogin.loggedIn) {
      return <RemoteLoginPlaceholder onSignIn={() => setLoginModal({ open: true, feature: "remote" })} />;
    }
    if (clawboxLogin.tier === null) {
      return (
        <FreeTierUpgradeCard
          featureName={t("remoteControl.upgrade.featureName")}
          description={t("remoteControl.upgrade.description")}
        />
      );
    }
    return <RemoteControlPanel />;
  };
  // Section setter that intercepts gated sections. Use this everywhere a
  // user action wants to navigate; bypass it for programmatic restorations
  // (URL deep-link, tier-based redirects) where blocking would be confusing.
  const setSectionGated = useCallback((next: Section) => {
    if (next === "remote" && requireLoginFor("remote")) return;
    setSection(next);
  }, [requireLoginFor]);

  // Allow other parts of the desktop (e.g. the "new version available" toast)
  // to deep-link into a specific Settings section. Read a pending value left
  // on `window` first, so a deep-link issued before this effect runs (cold
  // open of Settings) isn't lost to a listener-mount race.
  useEffect(() => {
    const isSection = (s: unknown): s is Section =>
      typeof s === "string" && (SECTIONS as readonly string[]).includes(s);
    const apply = (s: unknown) => {
      if (isSection(s)) {
        setSection(s);
        setMobileSection(s);
      }
    };
    const requestClawAiOffer = () => {
      setSection("ai");
      setMobileSection("ai");
      setOpenClawAIOfferRequest((current) => current + 1);
    };
    const requestProviderSelection = (providerId: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) return;
      setSection("ai");
      setMobileSection("ai");
      setRequestedAiProviderId(providerId);
      setProviderSelectionRequest((current) => current + 1);
    };
    const w = window as Window & {
      __clawboxPendingSettingsSection?: unknown;
      __clawboxPendingClawAiOffer?: unknown;
      __clawboxPendingAiProvider?: unknown;
    };
    if (w.__clawboxPendingSettingsSection !== undefined) {
      apply(w.__clawboxPendingSettingsSection);
      delete w.__clawboxPendingSettingsSection;
    }
    if (w.__clawboxPendingAiProvider !== undefined) {
      requestProviderSelection(w.__clawboxPendingAiProvider);
      delete w.__clawboxPendingAiProvider;
    }
    if (w.__clawboxPendingClawAiOffer) {
      requestClawAiOffer();
      delete w.__clawboxPendingClawAiOffer;
    }
    const handler = (event: Event) =>
      apply((event as CustomEvent<{ section?: string }>).detail?.section);
    const providerHandler = (event: Event) =>
      requestProviderSelection((event as CustomEvent<{ providerId?: string }>).detail?.providerId);
    const offerHandler = () => requestClawAiOffer();
    window.addEventListener("clawbox:open-settings-section", handler);
    window.addEventListener("clawbox:select-ai-provider", providerHandler);
    window.addEventListener("clawbox:open-clawai-offer", offerHandler);
    return () => {
      window.removeEventListener("clawbox:open-settings-section", handler);
      window.removeEventListener("clawbox:select-ai-provider", providerHandler);
      window.removeEventListener("clawbox:open-clawai-offer", offerHandler);
    };
  }, []);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close language dropdown on click outside
  useEffect(() => {
    if (!langOpen) return;
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [langOpen]);

  /* ── System stats ──
   * Poll only when System section is visible (live CPU/mem/temp/etc.),
   * but always fetch once when About is open so the static fields
   * (arch/platform) render instead of "...".
   */
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    if (section !== "system" && section !== "about") return;
    const poll = () => fetch("/setup-api/system/stats", { cache: "no-store" }).then(r => r.json()).then(setStats).catch(() => {});
    poll();
    if (section !== "system") return;
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [section]);

  /* ── System update ── */
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [versionInfo, setVersionInfo] = useState<{
    clawbox: { current: string; target: string | null; updateAvailable?: boolean };
    openclaw: { current: string | null; target: string | null; updateAvailable?: boolean };
  } | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [updateBranch, setUpdateBranch] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [branchSaving, setBranchSaving] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [betaEnabled, setBetaEnabled] = useState(false);
  const [betaConfirm, setBetaConfirm] = useState(false);
  const [betaSaving, setBetaSaving] = useState(false);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);

  const stopUpdatePolling = useCallback(() => {
    if (updatePollRef.current) { clearInterval(updatePollRef.current); updatePollRef.current = null; }
    updatePollControllerRef.current?.abort();
    updatePollControllerRef.current = null;
  }, []);

  const startUpdatePolling = useCallback(() => {
    if (updatePollRef.current) return;
    const controller = new AbortController();
    updatePollControllerRef.current = controller;
    let failureCount = 0;
    let serverWentDown = false;
    updatePollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) { failureCount++; if (failureCount >= 3) serverWentDown = true; return; }
        if (serverWentDown) { window.location.reload(); return; }
        failureCount = 0;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") stopUpdatePolling();
      } catch {
        if (controller.signal.aborted) return;
        failureCount++;
        if (failureCount >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopUpdatePolling]);

  useEffect(() => () => stopUpdatePolling(), [stopUpdatePolling]);

  // Auto-dismiss the update overlay once the update finishes. Full updates
  // (with a `restart` step) get a longer grace window and a hard navigation
  // to `/` so the browser picks up any freshly built client bundle; scoped
  // updates just clear the overlay in place.
  useEffect(() => {
    if (updateState?.phase !== "completed") return;
    const isFullUpdate = updateState.steps.some(s => s.id === RESTART_STEP_ID);
    const timer = setTimeout(() => {
      if (isFullUpdate) {
        stopUpdatePolling();
        // replace() instead of assigning href so Back doesn't land on the
        // stale Settings URL whose in-memory state is already gone.
        window.location.replace("/");
        return;
      }
      setUpdateStarted(false);
      setUpdateError(null);
      setUpdateState(null);
      stopUpdatePolling();
    }, isFullUpdate ? 5000 : 3000);
    return () => clearTimeout(timer);
  }, [updateState?.phase, updateState?.steps, stopUpdatePolling]);

  // Load version info and beta status on mount
  useEffect(() => {
    // /update/status only returns versions when phase=idle and not completed.
    // Use the dedicated /update/versions endpoint which always reports them.
    fetch("/setup-api/update/versions")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.clawbox || data?.openclaw) setVersionInfo(data); })
      .catch(() => {});
    fetch("/setup-api/system/update-branch")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.branch === "beta") setBetaEnabled(true); })
      .catch(() => {});
  }, []);



  const saveUpdateBranch = async (branch: string) => {
    setBranchSaving(true);
    setBranchError(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branch: branch || null }) });
      const data = await res.json();
      if (res.ok) { setUpdateBranch(data.branch ?? null); } else { setBranchError(data.error || t("settings.failedSetBranch")); }
    } catch (err) { setBranchError(err instanceof Error ? err.message : t("settings.failedSetBranch")); } finally { setBranchSaving(false); }
  };

  const toggleBeta = async (enable: boolean) => {
    if (enable) {
      setBetaConfirm(true);
      return;
    }
    setBetaSaving(true);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: null }),
      });
      if (res.ok) {
        setBetaEnabled(false);
        setUpdateBranch(null);
        setBranchInput("");
      }
    } catch {} finally { setBetaSaving(false); }
  };

  const confirmBeta = async () => {
    setBetaConfirm(false);
    setBetaSaving(true);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "beta" }),
      });
      if (res.ok) {
        setBetaEnabled(true);
        setUpdateBranch("beta");
        setBranchInput("beta");
      }
    } catch {} finally { setBetaSaving(false); }
  };

  const triggerUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setUpdateError(typeof data.error === "string" ? data.error : t("settings.failedStartUpdate")); return; }
      startUpdatePolling();
    } catch (err) { setUpdateError(err instanceof Error ? err.message : t("settings.failedStartUpdate")); }
  };

  const triggerOpenclawUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/openclaw", { method: "POST" });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setUpdateError(typeof data.error === "string" ? data.error : t("settings.failedStartUpdate")); return; }
      startUpdatePolling();
    } catch (err) { setUpdateError(err instanceof Error ? err.message : t("settings.failedStartUpdate")); }
  };

  /* ── WiFi ── */
  const [ssid, setSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [connectedSSID, setConnectedSSID] = useState<string | null>(null);
  const [wifiQuality, setWifiQuality] = useState<{ signalDbm: number | null; bitrateMbps: number | null; pingMs: number | null }>({ signalDbm: null, bitrateMbps: null, pingMs: null });
  const [ethernet, setEthernet] = useState<{ connected: boolean; iface: string | null }>({ connected: false, iface: null });

  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[] | null>(null);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [showManualWifi, setShowManualWifi] = useState(false);

  const scanWifiNetworks = async () => {
    setWifiScanning(true);
    try {
      // Try live scan first, fall back to cached scan (live fails in AP mode)
      const res = await fetch("/setup-api/wifi/scan?live=1", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.networks?.length > 0) {
          setWifiNetworks(data.networks);
          setWifiScanning(false);
          return;
        }
      }
      const cached = await fetch("/setup-api/wifi/scan");
      if (cached.ok) {
        const data = await cached.json();
        setWifiNetworks(data.networks?.length > 0 ? data.networks : []);
      }
    } catch { /* ignored */ }
    setWifiScanning(false);
  };

  const selectNetwork = (net: { ssid: string }) => {
    setSsid(net.ssid);
    setShowManualWifi(false);
    setWifiPass("");
    setWifiStatus(null);
  };

  /* ── Hotspot ── */
  const [hotspotEnabled, setHotspotEnabled] = useState<boolean | null>(null);
  const [hotspotSSID, setHotspotSSID] = useState("ClawBox-Setup");
  const [hotspotToggling, setHotspotToggling] = useState(false);
  const [hotspotSSIDInput, setHotspotSSIDInput] = useState("ClawBox-Setup");
  const [hotspotSSIDSaving, setHotspotSSIDSaving] = useState(false);
  const [hotspotSSIDStatus, setHotspotSSIDStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hotspotHasPassword, setHotspotHasPassword] = useState(false);
  const [hotspotActive, setHotspotActive] = useState<boolean | null>(null);
  const [hotspotBlockedBy, setHotspotBlockedBy] = useState<string | null>(null);
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [hotspotPasswordShow, setHotspotPasswordShow] = useState(false);
  const [hotspotPasswordSaving, setHotspotPasswordSaving] = useState(false);
  const [hotspotPasswordStatus, setHotspotPasswordStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hotspotConfirmEnable, setHotspotConfirmEnable] = useState(false);
  const [savedNetworks, setSavedNetworks] = useState<{ name: string; priority: number; device: string | null }[]>([]);
  const [savedEditing, setSavedEditing] = useState<string | null>(null);
  const [savedNewPassword, setSavedNewPassword] = useState("");
  const [savedShowPassword, setSavedShowPassword] = useState(false);
  const [savedBusy, setSavedBusy] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const refreshSavedNetworks = async () => {
    try {
      const r = await fetch("/setup-api/wifi/saved");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (Array.isArray(d.profiles)) setSavedNetworks(d.profiles);
    } catch (err) {
      console.warn("[SettingsApp] refreshSavedNetworks failed:", err);
    }
  };
  useEffect(() => { void refreshSavedNetworks(); }, []);
  const updateSavedPassword = async (name: string) => {
    if (savedNewPassword.length < 8 || savedNewPassword.length > 63) {
      setSavedStatus({ type: "error", message: "Password must be 8–63 characters" });
      return;
    }
    setSavedBusy(name); setSavedStatus(null);
    try {
      const r = await fetch("/setup-api/wifi/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: name, password: savedNewPassword, action: "update" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setSavedStatus({ type: "success", message: `Password updated for ${name}` });
      setSavedEditing(null); setSavedNewPassword("");
    } catch (err) {
      setSavedStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSavedBusy(null);
    }
  };
  const forgetSavedNetwork = async (name: string) => {
    if (!window.confirm(`Forget WiFi network "${name}"? You'll need its password to reconnect.`)) return;
    setSavedBusy(name); setSavedStatus(null);
    try {
      const r = await fetch("/setup-api/wifi/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: name, action: "forget" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setSavedStatus({ type: "success", message: `Forgot ${name}` });
      void refreshSavedNetworks();
    } catch (err) {
      setSavedStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSavedBusy(null);
    }
  };

  /* ── User name (used by mascot greetings) ── */
  const [userName, setUserName] = useState<string>("");
  const [userNameSaved, setUserNameSaved] = useState<string>("");
  const userNameSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the user has touched the field locally — without this,
  // a slow GET /preferences could resolve after the user already started
  // typing and overwrite their input mid-keystroke. Same flag also
  // guards the periodic refetch below so an agent write that lands
  // mid-edit doesn't clobber the user's in-flight typing.
  const userNameEditedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Refetch every 5 s so a name the agent just persisted via the
    // `preferences_set` MCP tool ("Hey, I'm Krasi" → agent writes
    // ui_user_name → field updates here without a manual reload).
    // The userNameEditedRef gate keeps the user's local typing
    // authoritative — once they touch the field, polling backs off
    // entirely until the next mount.
    const tick = () => {
      fetch("/setup-api/preferences?keys=ui_user_name", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data) return;
          if (userNameEditedRef.current) return;
          const next = typeof data.ui_user_name === "string" ? data.ui_user_name : "";
          // Avoid noisy state updates when the value didn't change —
          // React's strict-equality bail-out covers it but the input
          // still re-renders on parent state churn otherwise.
          setUserName(prev => prev === next ? prev : next);
          setUserNameSaved(prev => prev === next ? prev : next);
        })
        .catch(() => { /* transient — try again next tick */ })
        .finally(() => {
          // Stop scheduling once the user has started typing — otherwise
          // we'd keep firing fetches every 5s with results discarded by
          // the userNameEditedRef guard above. Effect cleanup re-mounts
          // (after page navigation, etc.) restart polling fresh.
          if (!cancelled && !userNameEditedRef.current) timer = setTimeout(tick, 5_000);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Cancel any debounce-pending POST so a tab-close or section-switch
      // mid-debounce doesn't fire after the component is gone.
      if (userNameSaveTimerRef.current) {
        clearTimeout(userNameSaveTimerRef.current);
        userNameSaveTimerRef.current = null;
      }
    };
  }, []);
  const persistUserName = useCallback((value: string) => {
    if (userNameSaveTimerRef.current) clearTimeout(userNameSaveTimerRef.current);
    // Debounce so every keystroke doesn't hit the API; the mascot only
    // needs the latest committed value.
    userNameSaveTimerRef.current = setTimeout(() => {
      fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ui_user_name: value.trim() }),
      })
        .then((res) => {
          // Only treat the write as committed if the server actually accepted
          // it. Previously every completed fetch flipped the "Saved." badge —
          // including 4xx/5xx — which lied to the user when the preference
          // never landed.
          if (!res.ok) {
            throw new Error(`preferences POST failed (${res.status})`);
          }
          setUserNameSaved(value.trim());
          window.dispatchEvent(new Event("clawbox-user-name-changed"));
        })
        .catch(() => { /* keep local edit; next save attempt will retry */ });
    }, 600);
  }, []);

  /* ── Local URL (mDNS hostname) ── */
  const [hostname, setHostname] = useState<string>("");
  const [ipv4, setIpv4] = useState<string>("");
  const [hostnameInput, setHostnameInput] = useState<string>("");
  const [hostnameStatus, setHostnameStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hostnameSaving, setHostnameSaving] = useState(false);
  const [hostnameConfirm, setHostnameConfirm] = useState(false);
  const [hostnameRebootTo, setHostnameRebootTo] = useState<string | null>(null);
  const [sysCurrentPassword, setSysCurrentPassword] = useState("");
  const [sysCurrentVerified, setSysCurrentVerified] = useState(false);
  const [sysVerifying, setSysVerifying] = useState(false);
  const [sysPassword, setSysPassword] = useState("");
  const [sysPasswordConfirm, setSysPasswordConfirm] = useState("");
  const [sysPasswordShow, setSysPasswordShow] = useState(false);
  const [sysNewShow, setSysNewShow] = useState(false);
  const [sysConfirmShow, setSysConfirmShow] = useState(false);
  const [sysPasswordSaving, setSysPasswordSaving] = useState(false);
  const [sysPasswordStatus, setSysPasswordStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [sysPasswordConfirmOpen, setSysPasswordConfirmOpen] = useState(false);
  const [sysPasswordConfirmReveal, setSysPasswordConfirmReveal] = useState(false);
  const sysPasswordConfirmCancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!sysPasswordConfirmOpen) return;
    const previouslyFocused = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    sysPasswordConfirmCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sysPasswordSaving) setSysPasswordConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [sysPasswordConfirmOpen, sysPasswordSaving]);
  const verifyCurrentPassword = async () => {
    if (!sysCurrentPassword) return;
    setSysVerifying(true);
    setSysPasswordStatus(null);
    try {
      const r = await fetch("/setup-api/system/credentials/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: sysCurrentPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Verification failed");
      setSysCurrentVerified(true);
    } catch (err) {
      setSysCurrentVerified(false);
      setSysPasswordStatus({ type: "error", message: err instanceof Error ? err.message : "Verification failed" });
    } finally {
      setSysVerifying(false);
    }
  };
  const resetSysPasswordForm = () => {
    setSysCurrentPassword(""); setSysCurrentVerified(false);
    setSysPassword(""); setSysPasswordConfirm("");
    setSysPasswordStatus(null);
    setSysPasswordConfirmOpen(false); setSysPasswordConfirmReveal(false);
  };
  const validateNewPassword = (): string | null => {
    if (sysPassword.length < 8) return "New password must be at least 8 characters";
    if (sysPassword !== sysPasswordConfirm) return "New passwords don't match";
    if (sysPassword === sysCurrentPassword) return "New password must differ from current";
    if (/[\r\n\x00-\x1f\x7f]/.test(sysPassword)) return "Password contains invalid characters";
    return null;
  };

  const requestSystemPasswordChange = () => {
    if (!sysCurrentVerified) return;
    const err = validateNewPassword();
    if (err) { setSysPasswordStatus({ type: "error", message: err }); return; }
    setSysPasswordStatus(null);
    setSysPasswordConfirmReveal(false);
    setSysPasswordConfirmOpen(true);
  };

  const saveSystemPassword = async () => {
    if (!sysCurrentVerified) return;
    const err = validateNewPassword();
    if (err) { setSysPasswordStatus({ type: "error", message: err }); return; }
    setSysPasswordSaving(true);
    setSysPasswordStatus(null);
    try {
      const r = await fetch("/setup-api/system/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: sysCurrentPassword, password: sysPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Failed");
      resetSysPasswordForm();
      setSysPasswordStatus({ type: "success", message: "Password updated. Use the new password next time you sign in or SSH." });
    } catch (err) {
      setSysPasswordStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSysPasswordSaving(false);
    }
  };
  // After a device rename the box reboots and reappears at a new .local origin;
  // poll it, then redirect there — with a hard fallback so we never hang if the
  // cross-origin probe is unreliable. Same grace/poll/settle engine as the
  // setup handoff overlays (see useReconnect).
  useReconnect({
    enabled: !!hostnameRebootTo,
    // no-cors: the response is opaque so we can't inspect status, but any
    // fulfilled fetch means TCP+HTTP completed — enough signal the box is back.
    probe: async () => {
      try {
        await fetch(`${hostnameRebootTo}setup-api/setup/status`, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: AbortSignal.timeout(REBOOT_PROBE_TIMEOUT_MS),
        });
        return true;
      } catch {
        return false;
      }
    },
    onReady: () => {
      if (hostnameRebootTo) window.location.replace(hostnameRebootTo);
    },
    graceMs: REBOOT_PROBE_GRACE_MS,
    intervalMs: REBOOT_PROBE_INTERVAL_MS,
    hardTimeoutMs: REBOOT_HARD_REDIRECT_MS,
  });
  const localUrl = hostname ? `${hostname}.local` : "";
  const proto = typeof window !== "undefined" ? window.location.protocol : "http:";
  const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
  const fullLocalUrl = localUrl ? `${proto}//${localUrl}${port}` : "";
  // Prefer the IP: on home networks the access point often drops wired→Wi-Fi
  // mDNS multicast, so `<hostname>.local` resolution is unreliable. The IP is
  // the dependable address; `.local` is shown as a best-effort fallback.
  const ipUrl = ipv4 ? `${proto}//${ipv4}${port}` : "";
  const primaryUrl = ipUrl || fullLocalUrl;
  const primaryLabel = ipv4 || localUrl;
  const [copiedLocalUrl, setCopiedLocalUrl] = useState(false);
  const copyLocalUrl = async () => {
    if (!primaryUrl) return;
    // Shared helper — falls back to the textarea + execCommand path on
    // plain http origins (clawbox.local etc.) where the modern Clipboard
    // API is blocked by the secure-context requirement.
    if (await copyToClipboard(primaryUrl)) {
      setCopiedLocalUrl(true);
      setTimeout(() => setCopiedLocalUrl(false), 1500);
    }
  };

  useEffect(() => {
    fetch("/setup-api/wifi/status").then(r => r.json()).then(d => {
      if (d.connected && d.ssid) setConnectedSSID(d.ssid);
      setWifiQuality({ signalDbm: d.signalDbm ?? null, bitrateMbps: d.bitrateMbps ?? null, pingMs: d.pingMs ?? null });
    }).catch(() => {});
    fetch("/setup-api/wifi/ethernet").then(r => r.json()).then(d => {
      setEthernet({ connected: !!d.connected, iface: d.iface ?? null });
    }).catch(() => {});
    fetch("/setup-api/system/hotspot").then(r => r.json()).then(d => {
      setHotspotEnabled(d.enabled ?? true);
      if (d.ssid) { setHotspotSSID(d.ssid); setHotspotSSIDInput(d.ssid); }
      setHotspotHasPassword(!!d.hasPassword);
      setHotspotActive(!!d.active);
      setHotspotBlockedBy(d.blockedBy ?? null);
    }).catch(() => {});
    fetch("/setup-api/system/hostname").then(r => r.json()).then(d => {
      if (d.hostname) {
        setHostname(d.hostname);
        setHostnameInput(d.hostname);
      }
      if (typeof d.ipv4 === "string") setIpv4(d.ipv4);
    }).catch(() => {});
  }, []);

  const saveHostname = async () => {
    const name = hostnameInput.trim().toLowerCase().replace(/\.local$/, "");
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      setHostnameStatus({ type: "error", message: t("settings.hostnameInvalid") });
      return;
    }
    if (name === hostname) {
      setHostnameConfirm(false);
      return;
    }
    setHostnameSaving(true);
    setHostnameStatus(null);
    try {
      const res = await fetch("/setup-api/system/hostname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHostnameStatus({ type: "error", message: data.error || t("settings.hostnameSaveFailed") });
        setHostnameSaving(false);
        setHostnameConfirm(false);
        return;
      }
      setHostnameStatus({ type: "success", message: t("settings.hostnameRestarting", { fqdn: `${name}.local` }) });
      setHostnameConfirm(false);
      const proto = typeof window !== "undefined" ? window.location.protocol : "http:";
      const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
      const newUrl = `${proto}//${name}.local${port}/`;
      setHostnameRebootTo(newUrl);
      try {
        await fetch("/setup-api/system/power", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
      } catch { /* device reboots, connection drops */ }
    } catch (err) {
      setHostnameStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.hostnameSaveFailed") });
      setHostnameSaving(false);
      setHostnameConfirm(false);
    }
  };

  const performHotspotToggle = async (newEnabled: boolean) => {
    setHotspotToggling(true);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: hotspotSSID, enabled: newEnabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setHotspotEnabled(newEnabled);
    } catch { /* leave state unchanged */ } finally {
      setHotspotToggling(false);
    }
  };

  const toggleHotspot = () => {
    const newEnabled = !hotspotEnabled;
    // Enabling the AP while WiFi is the uplink will drop the WiFi connection
    // (single radio). Confirm so the user isn't surprised.
    if (newEnabled && connectedSSID && !ethernet.connected) {
      setHotspotConfirmEnable(true);
      return;
    }
    void performHotspotToggle(newEnabled);
  };

  const saveHotspotSSID = async () => {
    const next = hotspotSSIDInput.trim();
    if (!next) {
      setHotspotSSIDStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (next.length > 32) {
      setHotspotSSIDStatus({ type: "error", message: "Hotspot name must be 32 characters or less" });
      return;
    }
    if (next === hotspotSSID) return;
    setHotspotSSIDSaving(true);
    setHotspotSSIDStatus(null);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: next, enabled: hotspotEnabled ?? true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      setHotspotSSID(next);
      setHotspotSSIDStatus({ type: "success", message: "Hotspot name updated" });
    } catch (err) {
      setHotspotSSIDStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setHotspotSSIDSaving(false);
    }
  };

  const saveHotspotPassword = async () => {
    if (hotspotPassword.length < 8) {
      setHotspotPasswordStatus({ type: "error", message: t("credentials.hotspotPasswordMinLength") });
      return;
    }
    if (hotspotPassword.length > 63) {
      setHotspotPasswordStatus({ type: "error", message: "Password must be 63 characters or less" });
      return;
    }
    setHotspotPasswordSaving(true);
    setHotspotPasswordStatus(null);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: hotspotSSID, password: hotspotPassword, enabled: hotspotEnabled ?? true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      setHotspotHasPassword(true);
      setHotspotPassword("");
      setHotspotPasswordStatus({ type: "success", message: "Hotspot password updated" });
    } catch (err) {
      setHotspotPasswordStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setHotspotPasswordSaving(false);
    }
  };

  const connectWifi = async () => {
    if (!ssid.trim()) return;
    setWifiConnecting(true);
    setWifiStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: ssid.trim(), password: wifiPass }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setWifiStatus({ type: "success", message: t("settings.connectedTo", { ssid }) });
      setConnectedSSID(ssid.trim());
      setSsid("");
      setWifiPass("");
    } catch (err) {
      setWifiStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.connectionFailed") });
    } finally {
      setWifiConnecting(false);
    }
  };

  /* ── AI Provider ── */
  const [aiProvider, setAiProvider] = useState<{ connected: boolean; provider: string | null; providerLabel: string | null; mode: string | null; model: string | null; clawaiTier: "flash" | "pro" | null } | null>(null);
  useEffect(() => {
    // The Local AI panel needs this too: it is the only source that knows which
    // provider the ACTIVE harness is really set to, which is what separates
    // "the on-device model is installed" from "it is what answers".
    if (section !== "ai" && section !== "localAi" && !isMobile) return;
    fetch("/setup-api/ai-models/status", { cache: "no-store" }).then(r => r.json()).then(setAiProvider).catch(() => {});
  }, [section, isMobile]);
  // Which agent consumes the local model. Named the harness outright, and said
  // "OpenClaw" on a Hermes box where OpenClaw isn't installed.
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

  const [localAiStatus, setLocalAiStatus] = useState<{ configured: boolean; provider: string | null; model: string | null; running: boolean | null; standbyEnabled: boolean } | null>(null);
  const [localAiDisabling, setLocalAiDisabling] = useState(false);
  const [localAiError, setLocalAiError] = useState<string | null>(null);
  const refreshLocalAiStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/setup/status", { cache: "no-store" });
      const data = await res.json();
      const configured = !!data.local_ai_configured;
      const provider = typeof data.local_ai_provider === "string" ? data.local_ai_provider : null;
      const model = typeof data.local_ai_model === "string" ? data.local_ai_model : null;

      let running: boolean | null = null;
      let standbyEnabled = false;
      if (configured && provider === "llamacpp") {
        const llamaRes = await fetch("/setup-api/llamacpp/status", { cache: "no-store" }).then(r => r.json()).catch(() => null);
        running = !!llamaRes?.running;
        standbyEnabled = !!llamaRes?.standbyEnabled;
      } else if (configured && provider === "ollama") {
        const ollamaRes = await fetch("/setup-api/ollama/status", { cache: "no-store" }).then(r => r.json()).catch(() => null);
        running = !!ollamaRes?.running;
        standbyEnabled = !!ollamaRes?.standbyEnabled;
      }

      setLocalAiStatus({ configured, provider, model, running, standbyEnabled });
      setLocalAiError(null);
    } catch {
      setLocalAiStatus({ configured: false, provider: null, model: null, running: null, standbyEnabled: false });
    }
  }, []);
  // Is the on-device model the provider the active harness will actually answer
  // with? `localAiStatus` alone can never say — it is built from the
  // config-store keys written when the model was installed, and installing one
  // deliberately does not take over from the provider the customer chose. The
  // harness's own selection (via /setup-api/ai-models/status) is the only proof.
  const localAiIsActive = !!localAiStatus?.configured
    && !!aiProvider?.provider
    && (aiProvider.provider === HERMES_LOCAL_PROVIDER_ID || aiProvider.provider === localAiStatus.provider);

  /**
   * The four states the Local AI cards render, resolved once so the status line
   * and the card copy cannot drift apart:
   *   offline   — configured, but the endpoint isn't answering and there is no standby
   *   available — installed and healthy, but something else is answering
   *   standby   — selected, asleep to free RAM until it is needed
   *   running   — selected and resident
   */
  const localAiState: "offline" | "available" | "standby" | "running" | null = !localAiStatus?.configured
    ? null
    : localAiStatus.running === false && !localAiStatus.standbyEnabled
      ? "offline"
      : !localAiIsActive
        ? "available"
        : localAiStatus.running === false
          ? "standby"
          : "running";
  const localAiOffline = localAiState === "offline";

  const disableLocalAi = useCallback(async () => {
    setLocalAiDisabling(true);
    setLocalAiError(null);
    try {
      const res = await fetch("/setup-api/local-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to disable Local AI");
      }
      await refreshLocalAiStatus();
      notifyChatModelStateChanged();
    } catch (err) {
      setLocalAiError(err instanceof Error ? err.message : "Failed to disable Local AI");
    } finally {
      setLocalAiDisabling(false);
    }
  }, [notifyChatModelStateChanged, refreshLocalAiStatus]);
  useEffect(() => {
    if (section !== "localAi" && !isMobile) return;
    refreshLocalAiStatus();
    if (section !== "localAi") return;
    const interval = setInterval(() => {
      refreshLocalAiStatus().catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshLocalAiStatus, section, isMobile]);

  const [localOnlyMode, setLocalOnlyMode] = useState<boolean | null>(null);
  const [localOnlyPending, setLocalOnlyPending] = useState(false);
  useEffect(() => {
    if (section !== "localAi") return;
    fetch("/setup-api/local-ai/exclusive", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setLocalOnlyMode(!!d.enabled))
      .catch(() => setLocalOnlyMode(false));
  }, [section]);
  const toggleLocalOnly = useCallback(async (next: boolean) => {
    setLocalOnlyPending(true);
    try {
      const res = await fetch("/setup-api/local-ai/exclusive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setLocalOnlyMode(next);
      notifyChatModelStateChanged();
      fetch("/setup-api/ai-models/status", { cache: "no-store" })
        .then((r) => r.json())
        .then(setAiProvider)
        .catch(() => {});
    } catch (err) {
      setLocalAiError(err instanceof Error ? err.message : "Failed to toggle local-only mode");
    } finally {
      setLocalOnlyPending(false);
    }
  }, [notifyChatModelStateChanged]);

  /* ── Telegram ── */
  const [tgToken, setTgToken] = useState("");
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgConfiguring, setTgConfiguring] = useState(false);
  const [tgStatus, setTgStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [tgBotInfo, setTgBotInfo] = useState<{ username?: string; firstName?: string; link?: string } | null>(null);
  const [tgReconfigure, setTgReconfigure] = useState(false);
  // Promise the overlay awaits before declaring "ready". Resolves when
  // POST /telegram/configure returns success; rejects on failure. This
  // prevents the overlay from completing based on gateway-health alone —
  // during the restart window the old gateway can still answer /health
  // until it actually goes down, which would falsely flash "ready" at
  // the user before the new bot is live.
  const [tgConfigurePromise, setTgConfigurePromise] = useState<Promise<void> | undefined>(undefined);
  const tgSaveControllerRef = useRef<AbortController | null>(null);
  // Telegram progress streaming (the live "Bubbling…" tool-progress drafts).
  // null = loading; default ON when unset on the device.
  const [tgStreaming, setTgStreaming] = useState<boolean | null>(null);
  const [tgStreamingPending, setTgStreamingPending] = useState(false);
  // Telegram pairing / user-access state.
  const [tgApproved, setTgApproved] = useState<Array<{ id: string; name?: string }>>([]);
  const [tgPending, setTgPending] = useState<Array<{ code?: string; id?: string; name?: string; createdAt?: string }> | null>(null);
  const [tgPendingLoading, setTgPendingLoading] = useState(false);
  const [tgPairingCode, setTgPairingCode] = useState("");
  const [tgApproving, setTgApproving] = useState(false);
  const [tgPairingStatus, setTgPairingStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refreshTelegramStatus = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/telegram/status", { cache: "no-store" });
      if (!r.ok) {
        // Don't clobber existing state on a transient error (gateway
        // restarting, 5xx, etc.) — keep the last known bot info visible.
        console.warn("[telegram] /setup-api/telegram/status returned", r.status);
        return;
      }
      const d = await r.json();
      setTgConfigured(d.configured ?? false);
      if (d.configured && d.username) {
        setTgBotInfo({ username: d.username, firstName: d.firstName, link: d.link });
      } else {
        setTgBotInfo(null);
      }
    } catch (err) {
      // Network error — likewise keep the last known state instead of
      // flashing "not configured" at the user mid-restart.
      console.warn("[telegram] refresh failed:", err);
    }
  }, []);

  const refreshPairing = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/telegram/pairing", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.approved)) setTgApproved(d.approved);
    } catch {
      // keep last known approved list on a transient error
    }
  }, []);

  useEffect(() => {
    if (section !== "telegram" && !isMobile) return;
    refreshTelegramStatus();
    refreshPairing();
    fetch("/setup-api/telegram/streaming", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTgStreaming(d ? d.enabled !== false : true))
      .catch(() => setTgStreaming(true));
  }, [section, isMobile, refreshTelegramStatus, refreshPairing]);

  // Refresh the approved/pending lists when an approval happens anywhere (e.g.
  // the desktop popup) so the Settings list updates without a manual reload.
  useEffect(() => {
    const onApproved = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      refreshPairing();
      if (code) setTgPending((prev) => (prev ? prev.filter((req) => !samePairingToken(req.code, code)) : prev));
    };
    window.addEventListener("clawbox:telegram-approved", onApproved);
    return () => window.removeEventListener("clawbox:telegram-approved", onApproved);
  }, [refreshPairing]);

  const toggleTelegramStreaming = useCallback(async (next: boolean) => {
    const prev = tgStreaming;
    setTgStreamingPending(true);
    setTgStreaming(next); // optimistic
    try {
      const res = await fetch("/setup-api/telegram/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      // 502 = saved but gateway restart failed; the setting still persisted,
      // so keep the optimistic value rather than reverting.
      if (!res.ok && res.status !== 502) {
        setTgStreaming(prev); // revert on a real failure
      }
    } catch {
      setTgStreaming(prev);
    } finally {
      setTgStreamingPending(false);
    }
  }, [tgStreaming]);

  const loadPending = useCallback(async () => {
    setTgPendingLoading(true);
    setTgPairingStatus(null);
    try {
      const r = await fetch("/setup-api/telegram/pairing?pending=1", { cache: "no-store" });
      const d = await r.json();
      if (r.ok) {
        setTgPending(Array.isArray(d.pending) ? d.pending : []);
        if (Array.isArray(d.approved)) setTgApproved(d.approved);
      } else {
        setTgPairingStatus({ type: "error", message: d.error || t("settings.pairingCheckFailed") });
      }
    } catch {
      setTgPairingStatus({ type: "error", message: t("settings.pairingCheckFailed") });
    } finally {
      setTgPendingLoading(false);
    }
  }, [t]);

  const approvePairingCode = useCallback(async (rawCode: string) => {
    // Either the 8-char code the bot DM'd, or a Hermes request id from the
    // pending list — see src/lib/telegram-pairing-token.ts.
    const code = normalizePairingToken(rawCode);
    if (!isPairingToken(code)) {
      setTgPairingStatus({ type: "error", message: t("settings.pairingInvalidCode") });
      return;
    }
    setTgApproving(true);
    setTgPairingStatus(null);
    try {
      const r = await fetch("/setup-api/telegram/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        if (Array.isArray(d.approved)) setTgApproved(d.approved);
        setTgPairingCode("");
        setTgPending((prev) => (prev ? prev.filter((req) => !samePairingToken(req.code, code)) : prev));
        window.dispatchEvent(new CustomEvent("clawbox:telegram-approved", { detail: { code } }));
        setTgPairingStatus({ type: "success", message: t("settings.pairingApproveSuccess") });
      } else {
        setTgPairingStatus({ type: "error", message: d.error || t("settings.pairingApproveFailed") });
      }
    } catch {
      setTgPairingStatus({ type: "error", message: t("settings.pairingApproveFailed") });
    } finally {
      setTgApproving(false);
    }
  }, [t]);

  const saveTelegram = async () => {
    if (!tgToken.trim()) {
      setTgStatus({ type: "error", message: t("settings.enterToken") });
      return;
    }
    tgSaveControllerRef.current?.abort();
    const controller = new AbortController();
    tgSaveControllerRef.current = controller;
    setTgSaving(true);
    setTgConfiguring(true);
    setTgStatus(null);

    // Resolver/rejecter exposed so the overlay can await the configure
    // outcome in parallel with its own gateway-health poll. Only when
    // BOTH succeed does the overlay transition to its final "ready"
    // phase — see TelegramConfiguringOverlay's `waitFor` prop.
    const {
      promise: configurePromise,
      resolve: configureResolve,
      reject: configureReject,
    } = Promise.withResolvers<void>();
    // Swallow the rejection at the promise level so unhandled-rejection
    // doesn't fire; the overlay handles the failed state via its own
    // error path (we also call setTgConfiguring(false) below).
    configurePromise.catch(() => {});
    setTgConfigurePromise(configurePromise);

    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: tgToken.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        configureReject(new Error(data.error || "configure failed"));
        setTgConfiguring(false);
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      if (data.success) {
        configureResolve();
        setTgStatus({ type: "success", message: t("settings.telegramConfigured") });
        setTgConfigured(true);
        setTgReconfigure(false);
        setTgToken("");
        // A token change resets the allowlist server-side; clear the lists
        // optimistically and re-fetch so the UI reflects the fresh bot without
        // a manual reload.
        if (data.reset) {
          setTgApproved([]);
          setTgPending(null);
          setTgPairingStatus(null);
        }
        refreshPairing();
      } else {
        configureReject(new Error(data.error || "configure returned success=false"));
        setTgConfiguring(false);
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        configureReject(err);
        return;
      }
      configureReject(err);
      setTgConfiguring(false);
      setTgStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setTgSaving(false);
    }
  };

  /* ── Factory Reset ── */
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);


  const [resetPhase, setResetPhase] = useState<"waiting" | "reconnecting" | "done" | null>(null);
  const [resetDots, setResetDots] = useState(0);
  const resetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetDotsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetSetup = async () => {
    setResetting(true);
    setResetConfirm(false);
    setResetPhase("waiting");
    setResetDots(0);

    // Animate dots
    resetDotsRef.current = setInterval(() => setResetDots(d => (d + 1) % 4), 500);

    try {
      await fetch("/setup-api/setup/reset", { method: "POST" });
    } catch { /* device reboots, connection drops */ }

    // Wait for device to go down, then poll for reconnect
    setTimeout(() => {
      setResetPhase("reconnecting");
      resetPollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/setup-api/setup/status", { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            if (resetPollRef.current) clearInterval(resetPollRef.current);
            if (resetDotsRef.current) clearInterval(resetDotsRef.current);
            setResetPhase("done");
            setTimeout(() => { window.location.replace("/setup"); }, 1500);
          }
        } catch { /* still offline */ }
      }, 3000);
    }, 5000);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (resetPollRef.current) clearInterval(resetPollRef.current);
      if (resetDotsRef.current) clearInterval(resetDotsRef.current);
    };
  }, []);

  const activeSection = isMobile ? (mobileSection ?? section) : section;
  const visibleNavItems = NAV_ITEMS;
  const resetProgressSteps = [
    {
      id: "erase",
      label: t("settings.erasingSettings"),
      status: resetPhase === "waiting" ? "running" : resetPhase ? "completed" : "pending",
    },
    {
      id: "reconnect",
      label: t("settings.waitingOnline"),
      status:
        resetPhase === "reconnecting"
          ? "running"
          : resetPhase === "done"
            ? "completed"
            : "pending",
    },
    {
      id: "setup",
      label: t("settings.startingSetup"),
      status: resetPhase === "done" ? "running" : "pending",
    },
  ] satisfies Array<{ id: string; label: string; status: "pending" | "running" | "completed" }>;

  const resetOverlayTitle =
    resetPhase === "waiting"
      ? `${t("settings.resetting")}${".".repeat(resetDots)}`
      : resetPhase === "reconnecting"
        ? `${t("settings.reconnecting")}${".".repeat(resetDots)}`
        : t("settings.backOnline");

  const resetOverlayDescription =
    resetPhase === "waiting"
      ? t("settings.erasingSettings")
      : resetPhase === "reconnecting"
        ? t("settings.waitingOnline")
        : t("settings.startingSetup");

  const resetOverlay = resetting && resetPhase && typeof document !== "undefined"
    ? createPortal(
        // `settings-pane` carries the `--set-*` role layer, nothing else — the
        // class declares custom properties and paints no pixel of its own. It
        // is here because this root is portalled to `document.body`, i.e.
        // OUTSIDE both the pane and `desktop-root` (where `data-agent` lives),
        // so without it no `--set-*` role resolves and no edition can ever
        // reach this overlay. globals.css pairs it with a `body:has(…)` arm.
        <div
          className="settings-pane fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 2147483647, background: "var(--set-surface)" }}
          role="status"
          aria-live="polite"
        >
          <style>{`
            @keyframes factory-reset-pulse {
              0%, 100% { opacity: 0.25; transform: scale(1); }
              50% { opacity: 0.1; transform: scale(1.18); }
            }
          `}</style>
          <div className="flex flex-col items-center gap-8 max-w-md w-full text-center px-6">
            {resetPhase === "done" ? (
              <div className="relative w-28 h-28 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/20" />
                <div className="w-16 h-16 rounded-full flex items-center justify-center bg-[#f97316] shadow-[0_0_40px_rgba(249,115,22,0.28)]">
                  <span className="material-symbols-rounded text-white" style={{ fontSize: 32 }} aria-hidden="true">check</span>
                </div>
              </div>
            ) : (
              <div className="relative w-32 h-32 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-[3px] border-white/10 animate-spin" style={{ borderTopColor: "#f97316" }} />
                <div className="absolute inset-3 rounded-full border border-[#f97316]/15" style={{ animation: "factory-reset-pulse 2.5s ease-in-out infinite" }} />
                <Image
                  src="/clawbox-crab.png"
                  alt="ClawBox"
                  width={96}
                  height={96}
                  className="w-24 h-24 object-contain animate-welcome-powerup relative z-10"
                />
              </div>
            )}

            <div>
              <h2 className="text-2xl font-bold text-white mb-2">{resetOverlayTitle}</h2>
              <p className="text-sm text-white/45">{resetOverlayDescription}</p>
            </div>

            <div className="w-full max-w-sm space-y-3 text-left bg-white/[0.03] rounded-2xl p-4 border border-white/[0.06]">
              {resetProgressSteps.map((step) => (
                <div key={step.id} className="flex items-start gap-3 text-sm">
                  {step.status === "completed" ? (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                        <path d="M5 12l5 5L19 7" />
                      </svg>
                    </span>
                  ) : step.status === "running" ? (
                    <span className="flex items-center justify-center w-5 h-5 shrink-0">
                      <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.04] shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-white/20" aria-hidden="true" />
                    </span>
                  )}
                  <span className={step.status === "running" ? "text-white font-medium" : step.status === "completed" ? "text-emerald-400/70" : "text-white/25"}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  const renderContent = () => (
    <>
        {/* ─── Appearance ─── */}
        {activeSection === "appearance" && (
          <div className="max-w-xl space-y-5">

            {/* Your name — used by the mascot for occasional name-greeting popups */}
            <div>
              {/* The group header carries the REAL `<label htmlFor>`. `ui-user-name`
                  is the input's ONLY accessible name today and the only handle the
                  suite has, so the association travels with the text instead of
                  being quietly swapped for an aria-label. */}
              <SettingsGroupHeader icon="person">
                <label htmlFor="ui-user-name">{t("settings.userName.label")}</label>
              </SettingsGroupHeader>
              <SettingsGroup divided={false}>
                <div className="px-[8px] py-[8px]">
                  <SettingsTextField
                    id="ui-user-name"
                    type="text"
                    value={userName}
                    maxLength={40}
                    onChange={e => {
                      userNameEditedRef.current = true;
                      setUserName(e.target.value);
                      persistUserName(e.target.value);
                    }}
                    helper={
                      <>
                        {t("settings.userName.helper")}
                        {userNameSaved && userNameSaved === userName.trim() && userNameSaved.length > 0 && (
                          <span className="ml-1 text-[var(--set-success)]">{t("settings.userName.saved")}</span>
                        )}
                      </>
                    }
                  />
                </div>
              </SettingsGroup>
            </div>

            {/* Wallpaper card */}
            <div>
              <SettingsGroupHeader icon="wallpaper">{t("settings.wallpaper")}</SettingsGroupHeader>
              <SettingsGroup divided={false}>
                {/* Container-driven, NOT `sm:`. The old `grid-cols-3 sm:grid-cols-4`
                    was the only breakpoint prefix in the file and `sm:` asks the
                    VIEWPORT, while this grid lives inside a resizable window on
                    desktop and a 16px-gutter pane on a phone — so a wide phone got
                    four cramped tiles and a narrow desktop window got three wide
                    ones. auto-fill asks the container: 2 tiles at 360px, 3 at
                    414px, 4 in the desktop pane, 5 when the window is opened wide. */}
                <div
                  className="grid gap-[12px] p-[12px]"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))" }}
                >
                {ui.wallpapers.map(wp => {
                  const selected = ui.wallpaperId === wp.id;
                  return (
                    <button
                      key={wp.id}
                      onClick={() => ui.onWallpaperChange(wp.id)}
                      className={`group relative aspect-video cursor-pointer overflow-hidden rounded-[12px] border-none p-0 transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)] ${
                        selected
                          ? "ring-2 ring-[var(--set-primary)] ring-offset-2 ring-offset-[var(--set-surface-container)]"
                          : "hover:ring-1 hover:ring-[var(--set-outline)] hover:ring-offset-1 hover:ring-offset-[var(--set-surface-container)]"
                      }`}
                    >
                      {wp.image ? (
                        <img src={wp.image} alt={wp.name} className="w-full h-full object-cover" />
                      ) : (
                        <div
                          className="w-full h-full"
                          style={{ background: "linear-gradient(135deg, var(--set-surface-container-highest), var(--set-surface))" }}
                        />
                      )}
                      {/* An M3 state layer, not a white overlay: it composites the
                          palette's own ink, so it re-tints itself under Hermes. */}
                      <span
                        aria-hidden="true"
                        className={`absolute inset-0 transition-colors ${selected ? "" : "group-hover:bg-[var(--set-state-hover)]"}`}
                        style={selected ? { backgroundColor: "color-mix(in srgb, var(--set-primary) 14%, transparent)" } : undefined}
                      />
                      <span
                        className="absolute bottom-0 inset-x-0 truncate px-[6px] py-[4px] text-center text-[10px] font-medium"
                        style={selected
                          ? { backgroundColor: "var(--set-primary)", color: "var(--set-on-primary)" }
                          : { backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)", color: "var(--set-on-surface)" }}
                      >{wp.name}</span>
                      {selected && (
                        <span className="absolute top-[6px] right-[6px] w-[20px] h-[20px] rounded-full bg-[var(--set-primary)] text-[var(--set-on-primary)] flex items-center justify-center">
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check</span>
                        </span>
                      )}
                    </button>
                  );
                })}
                {ui.customWallpapers.map((dataUrl, i) => {
                  const selected = ui.wallpaperId === `custom-${i}`;
                  return (
                    <button
                      key={`custom-${i}`}
                      onClick={() => ui.onWallpaperChange(`custom-${i}`)}
                      className={`group relative aspect-video cursor-pointer overflow-hidden rounded-[12px] border-none p-0 transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)] ${
                        selected
                          ? "ring-2 ring-[var(--set-primary)] ring-offset-2 ring-offset-[var(--set-surface-container)]"
                          : "hover:ring-1 hover:ring-[var(--set-outline)] hover:ring-offset-1 hover:ring-offset-[var(--set-surface-container)]"
                      }`}
                    >
                      <img src={dataUrl} alt={`Custom ${i + 1}`} className="w-full h-full object-cover" />
                      {selected && (
                        <span className="absolute top-[6px] right-[6px] w-[20px] h-[20px] rounded-full bg-[var(--set-primary)] text-[var(--set-on-primary)] flex items-center justify-center">
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check</span>
                        </span>
                      )}
                      {/* Deliberately still a 20px control NESTED in the tile, with
                          `e.stopPropagation()` and the group-hover reveal intact.
                          It is the one control here that is knowingly left under the
                          44px minimum: there is no confirmation behind it and it
                          sits inside the SELECT target, so a 44px hit box would
                          swallow roughly half a tile and turn a mis-aim into an
                          irreversible delete. Growing it needs the control moved out
                          of the tile — a structural change, not a restyle. */}
                      <button
                        onClick={e => { e.stopPropagation(); ui.onCustomWallpaperDelete(i); }}
                        className="absolute top-[6px] left-[6px] w-[20px] h-[20px] rounded-full bg-[var(--set-error)] text-[var(--set-surface)] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer border-none"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
                      </button>
                      <span
                        className="absolute bottom-0 inset-x-0 truncate px-[6px] py-[4px] text-center text-[10px] font-medium"
                        style={selected
                          ? { backgroundColor: "var(--set-primary)", color: "var(--set-on-primary)" }
                          : { backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)", color: "var(--set-on-surface)" }}
                      >Custom {i + 1}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => ui.onWallpaperUpload()}
                  className="aspect-video rounded-[12px] border-2 border-dashed border-[var(--set-outline-variant)] bg-transparent text-[var(--set-on-surface-variant)] flex flex-col items-center justify-center gap-[6px] transition-colors cursor-pointer hover:border-[var(--set-primary)] hover:bg-[var(--set-state-hover)] hover:text-[var(--set-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 24 }}>add_photo_alternate</span>
                  <span className="text-[10px] font-medium">{t("settings.upload")}</span>
                </button>
                </div>
              </SettingsGroup>
            </div>

            {/* Display Settings card */}
            <div>
              <SettingsGroupHeader icon="tune">{t("settings.display")}</SettingsGroupHeader>
              <SettingsGroup>
                {/* Fit mode */}
                <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                  <label className="text-[14px] font-normal leading-[1.3] text-[var(--set-on-surface)]">{t("settings.fitMode")}</label>
                  {/* One outlined container instead of three chips in a tray. The
                      segments are `TOUCH_TARGET` tall inside the primitive, so the
                      old 32px chips clear the declared 44px minimum here. */}
                  <SettingsSegmented
                    value={ui.wpFit}
                    onChange={next => ui.onWpFitChange(next as "fill" | "fit" | "center")}
                    options={(["fill", "fit", "center"] as const).map(mode => ({
                      value: mode,
                      // `settings.fill|fit|center` are also the closed server domain
                      // for `wp_fit`; the English strings are lowercase and depend
                      // on `capitalize`, exactly as they did before.
                      label: t(`settings.${mode}`),
                      labelClassName: "capitalize",
                    }))}
                  />
                </div>

                {/* Opacity */}
                <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                  <label className="text-[14px] font-normal leading-[1.3] text-[var(--set-on-surface)]">{t("settings.opacity")}</label>
                  {/* Still exactly one `input[type="range"]` in the whole pane, which
                      is how the suite locates it. The filled track is no longer an
                      inline gradient recomputed per render, and the thumb no longer
                      leans on the GLOBAL `input[type="range"].appearance-none` rule
                      — `SettingsSlider` paints both from `--set-*`. The range keeps
                      an accessible name it never had. */}
                  <SettingsSlider
                    label={t("settings.opacity")}
                    value={ui.wpOpacity}
                    min={0}
                    max={100}
                    onChange={e => ui.onWpOpacityChange(parseInt(e.target.value, 10))}
                    badge={`${ui.wpOpacity}%`}
                  />
                </div>

                {/* Background color */}
                <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                  <label htmlFor="ui-wp-bg-color" className="text-[14px] font-normal leading-[1.3] text-[var(--set-on-surface)]">{t("settings.bgColor")}</label>
                  <div className="flex flex-wrap items-center gap-[12px]">
                    {/* Native `<input type="color">`, unchanged — it still fires per
                        drag frame of the OS picker. Only the box grew to 44px and
                        the stray `<label>` above became a real association. */}
                    <input
                      id="ui-wp-bg-color"
                      type="color" value={ui.wpBgColor}
                      onChange={e => ui.onWpBgColorChange(e.target.value)}
                      className="w-[44px] h-[44px] shrink-0 rounded-[12px] cursor-pointer bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                      style={{ border: "1px solid var(--set-outline)" }}
                    />
                    <span className="rounded-[8px] bg-[var(--set-surface-container-highest)] px-[12px] py-[8px] font-mono text-[12px] tracking-wide text-[var(--set-on-surface-variant)]">{ui.wpBgColor}</span>
                  </div>
                </div>
              </SettingsGroup>
            </div>

            {/* Extras card */}
            <div>
              <SettingsGroupHeader icon="auto_awesome">{t("settings.extras")}</SettingsGroupHeader>
              <SettingsGroup>
                {/* POLARITY IS INVERTED AND MUST STAY SO: the switch shows whether the
                    mascot is VISIBLE, the prop stores whether it is HIDDEN. Both
                    window events still fire — page.tsx listens on both channels, so
                    dropping one hides the bug in testing. */}
                <SettingsRow
                  label={t("settings.showMascot")}
                  trailing={
                    <SettingsSwitch
                      label={t("settings.showMascot")}
                      checked={!ui.mascotHidden}
                      onChange={v => {
                        const hidden = !v;
                        ui.onMascotToggle(hidden);
                        window.dispatchEvent(new Event(hidden ? "clawbox-hide-mascot" : "clawbox-show-mascot"));
                      }}
                    />
                  }
                />
              </SettingsGroup>
            </div>

            {/* Language card */}
            <div>
              <SettingsGroupHeader icon="translate">{t("settings.language")}</SettingsGroupHeader>
              <SettingsGroup divided={false}>
                {/* `langRef` and the positioning context are load-bearing: the
                    outside-click close tests `langRef.current.contains(e.target)` on
                    a document `mousedown`, and the panel must stay a DOM DESCENDANT
                    — portalling it closes the menu before an option's onClick can
                    fire, which makes the language unselectable. */}
                <div className="relative px-[8px] py-[4px]" ref={langRef}>
                  <button
                    type="button"
                    onClick={() => setLangOpen(v => !v)}
                    className="w-full min-h-[44px] flex items-center gap-[10px] px-[8px] rounded-[12px] border-none bg-transparent text-left text-[14px] text-[var(--set-on-surface)] transition-colors cursor-pointer hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                  >
                    <span className="text-base leading-none">{currentLang.flag}</span>
                    <span className="min-w-0 flex-1 truncate text-left">{currentLang.label}</span>
                    <span className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]" style={{ fontSize: 18 }}>
                      {langOpen ? "expand_less" : "expand_more"}
                    </span>
                  </button>
                  {langOpen && (
                    <div
                      className="absolute z-50 mt-[4px] inset-x-[8px] rounded-[12px] bg-[var(--set-surface-container-high)] max-h-60 overflow-y-auto"
                      style={{ boxShadow: "inset 0 0 0 1px var(--set-outline-variant)" }}
                    >
                      {LANGUAGES.map(lang => (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => { setLocale(lang.code as Locale); setLangOpen(false); }}
                          className={`w-full min-h-[44px] flex items-center gap-[10px] px-[12px] py-[8px] text-[14px] transition-colors cursor-pointer border-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)] ${
                            lang.code === locale
                              ? "bg-[var(--set-secondary-container)] text-[var(--set-on-secondary-container)]"
                              : "bg-transparent text-[var(--set-on-surface)] hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)]"
                          }`}
                        >
                          <span className="text-base leading-none">{lang.flag}</span>
                          <span className="min-w-0 flex-1 truncate text-left">{lang.label}</span>
                          {lang.code === locale && (
                            <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }}>check</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </SettingsGroup>
            </div>
          </div>
        )}

        {/* ─── Network ─── */}
        {activeSection === "wifi" && (
          /* Network. Five borderless tonal groups where five bordered cards used
             to be. Nothing here fetches, gates or polls differently than it did:
             every handler, every `disabled` expression, every `readOnly`,
             `autoFocus`, `maxLength` and placeholder is the one that shipped.
             The gutters are the pane's (24px desktop / 16px mobile), so the
             groups reflow to 360px without a horizontal scrollbar. */
          <div className="max-w-xl space-y-[16px]">

            {/* Connection status card */}
            <div>
              <SettingsGroupHeader icon="wifi">{t("settings.status")}</SettingsGroupHeader>
              <SettingsGroup>
                {connectedSSID ? (
                  <div className="flex items-center gap-[16px] px-[16px] py-[12px]">
                    <span
                      className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: "color-mix(in srgb, var(--set-success) 16%, transparent)" }}
                    >
                      <span className="material-symbols-rounded text-[var(--set-success)]" style={{ fontSize: 22 }}>wifi</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-[var(--set-on-surface)]">{connectedSSID}</div>
                      {/* Three independently-nullable chips, wrapping instead of
                          overflowing — at 360px they take a second line rather
                          than pushing the card sideways. */}
                      <div className="mt-[2px] flex flex-wrap items-center gap-[6px]">
                        <span className="h-[6px] w-[6px] rounded-full bg-[var(--set-success)] animate-pulse" />
                        <span className="text-[12px] text-[var(--set-success)]">WiFi · {t("settings.connected")}</span>
                        {wifiQuality.signalDbm !== null && (
                          <span className="text-[12px] text-[var(--set-on-surface-variant)]">· {dbmToLevel(wifiQuality.signalDbm)} bars · {wifiQuality.signalDbm} dBm</span>
                        )}
                        {wifiQuality.bitrateMbps !== null && (
                          <span className="text-[12px] text-[var(--set-on-surface-variant)]">· {Math.round(wifiQuality.bitrateMbps)} Mbps</span>
                        )}
                        {wifiQuality.pingMs !== null && (
                          <span className="text-[12px] text-[var(--set-on-surface-variant)]">· {wifiQuality.pingMs}ms gw</span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : ethernet.connected ? (
                  <div className="flex items-center gap-[16px] px-[16px] py-[12px]">
                    <span
                      className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: "color-mix(in srgb, var(--set-success) 16%, transparent)" }}
                    >
                      <span className="material-symbols-rounded text-[var(--set-success)]" style={{ fontSize: 22 }}>settings_ethernet</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-[var(--set-on-surface)]">Ethernet{ethernet.iface ? ` (${ethernet.iface})` : ""}</div>
                      <div className="mt-[2px] flex flex-wrap items-center gap-[6px]">
                        <span className="h-[6px] w-[6px] rounded-full bg-[var(--set-success)] animate-pulse" />
                        <span className="text-[12px] text-[var(--set-success)]">Wired · {t("settings.connected")}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-[16px] px-[16px] py-[12px]">
                    <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-[var(--set-surface-container-highest)]">
                      <span className="material-symbols-rounded text-[var(--set-on-surface-variant)]" style={{ fontSize: 22 }}>wifi_off</span>
                    </span>
                    <div className="min-w-0">
                      <div className="text-[14px] text-[var(--set-on-surface)]">{t("settings.noWifiConnection")}</div>
                      <div className="mt-[2px] text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.connectToNetwork")}</div>
                    </div>
                  </div>
                )}

                {primaryLabel && (
                  <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                    <div className="flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--set-on-surface-variant)]">
                      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }}>link</span>
                      <span>Access this device at</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-[8px]">
                      <a href={primaryUrl} className="min-w-0 flex-1 truncate font-mono text-[14px] text-[var(--set-on-surface)] underline-offset-2 hover:text-[var(--set-primary)] hover:underline">{primaryLabel}</a>
                      {/* Same handler, same two `aria-label`s, same `title` — only
                          the box grew to the 44px minimum. */}
                      <button
                        onClick={copyLocalUrl}
                        className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-transparent px-[12px] text-[14px] font-medium text-[var(--set-on-surface)] transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                        title="Copy URL"
                        aria-label={copiedLocalUrl ? "URL copied" : "Copy URL"}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">{copiedLocalUrl ? "check" : "content_copy"}</span>
                        {copiedLocalUrl ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <span className="sr-only" aria-live="polite">{copiedLocalUrl ? "URL copied to clipboard" : ""}</span>
                    {ipv4 && localUrl && (
                      <p className="text-[12px] leading-relaxed text-[var(--set-on-surface-variant)]">
                        <span className="font-mono text-[var(--set-on-surface)]">{localUrl}</span> also works on networks that support mDNS. The IP can change when the device reconnects — reserve it in your router for a permanent address.
                      </p>
                    )}
                  </div>
                )}
              </SettingsGroup>
            </div>

            {/* Hotspot toggle card */}
            <div>
              <SettingsGroup>
                {/* THREE hotspot states stay three, and none of them is a hex any
                    more: off is the neutral control surface, broadcasting is
                    `--set-primary`, blocked is `--set-warning` — plus the "• not
                    broadcasting" chip and the single-radio box below. The disc
                    travels inside the row's label because the row primitive has
                    no leading slot and the disc is one of those three cues. */}
                <SettingsRow
                  label={
                    <span className="flex items-center gap-[12px]">
                      <span
                        className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
                        style={{
                          backgroundColor:
                            hotspotEnabled && hotspotActive === false
                              ? "color-mix(in srgb, var(--set-warning) 16%, transparent)"
                              : hotspotEnabled
                                ? "color-mix(in srgb, var(--set-primary) 16%, transparent)"
                                : "var(--set-surface-container-highest)",
                        }}
                      >
                        <span
                          className={`material-symbols-rounded ${
                            hotspotEnabled && hotspotActive === false
                              ? "text-[var(--set-warning)]"
                              : hotspotEnabled
                                ? "text-[var(--set-primary)]"
                                : "text-[var(--set-on-surface-variant)]"
                          }`}
                          style={{ fontSize: 22 }}
                        >wifi_tethering</span>
                      </span>
                      <span className="flex min-w-0 flex-col gap-[2px]">
                        <span className="text-[14px] font-medium text-[var(--set-on-surface)]">{t("settings.hotspot")}</span>
                        <span className="break-words text-[12px] text-[var(--set-on-surface-variant)]">
                          {hotspotSSID}
                          {hotspotEnabled && hotspotActive === false && <span className="ml-[8px] text-[var(--set-warning)]">• not broadcasting</span>}
                          {hotspotEnabled && hotspotActive === true && <span className="ml-[8px] text-[var(--set-success)]">• broadcasting</span>}
                        </span>
                      </span>
                    </span>
                  }
                  trailing={
                    /* NOT optimistic, exactly as before: `toggleHotspot` either
                       opens the confirm modal or POSTs, and `hotspotEnabled` is
                       only written when the POST resolves — the handle does not
                       move on click. The 44px M3 switch replaces the 24px
                       hand-rolled track; the callback argument is ignored because
                       the source of truth is the server round-trip. */
                    <SettingsSwitch
                      label={t("settings.hotspot")}
                      checked={hotspotEnabled === true}
                      onChange={() => toggleHotspot()}
                      disabled={hotspotEnabled === null || hotspotToggling}
                      busy={hotspotToggling}
                    />
                  }
                />

                {hotspotEnabled && hotspotActive !== false && (
                  <p className="px-[16px] py-[12px] text-[12px] leading-relaxed text-[var(--set-on-surface-variant)]">
                    {t("settings.hotspotDesc", { ssid: hotspotSSID })}
                  </p>
                )}

                {hotspotEnabled && hotspotActive === false && (
                  <div className="px-[16px] py-[12px]">
                    <div
                      className="flex items-start gap-[8px] rounded-[12px] px-[12px] py-[10px]"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--set-warning) 10%, transparent)",
                        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--set-warning) 30%, transparent)",
                      }}
                    >
                      <span className="material-symbols-rounded shrink-0 text-[var(--set-warning)]" style={{ fontSize: 18 }}>warning</span>
                      <div className="text-[12px] leading-relaxed text-[var(--set-on-surface)]">
                        Hotspot is not broadcasting{hotspotBlockedBy ? ` because this device is connected to "${hotspotBlockedBy}" over WiFi` : ""}.
                        The Jetson has a single WiFi radio, so the hotspot can only run when WiFi is disconnected or the device is on Ethernet.
                        Saved settings will apply automatically the next time the AP starts.
                      </div>
                    </div>
                  </div>
                )}

                {hotspotEnabled && (
                  <div className="flex flex-col gap-[16px] px-[16px] py-[16px]">
                    <div className="flex flex-col gap-[8px]">
                      {/* The label was decorative (no `htmlFor`, no wrapped
                          control) — the field had no accessible name at all.
                          Same text, now a real association. */}
                      <label htmlFor="settings-hotspot-ssid" className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">
                        {t("settings.hotspot")} name
                      </label>
                      <div className="flex flex-wrap items-end gap-[8px]">
                        <SettingsTextField
                          id="settings-hotspot-ssid"
                          className="min-w-[176px] flex-1"
                          type="text"
                          value={hotspotSSIDInput}
                          onChange={e => { setHotspotSSIDInput(e.target.value); setHotspotSSIDStatus(null); }}
                          maxLength={32}
                          placeholder="ClawBox-Setup"
                        />
                        <button
                          onClick={saveHotspotSSID}
                          disabled={hotspotSSIDSaving || !hotspotSSIDInput.trim() || hotspotSSIDInput.trim() === hotspotSSID}
                          className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        >
                          {t("settings.save")}
                        </button>
                      </div>
                      {hotspotSSIDStatus && <StatusMessage type={hotspotSSIDStatus.type} message={hotspotSSIDStatus.message} />}
                    </div>

                    <div className="flex flex-col gap-[8px]">
                      <label htmlFor="settings-hotspot-password" className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">
                        {t("credentials.hotspotPassword")}
                      </label>
                      <div className="flex flex-wrap items-end gap-[8px]">
                        <SettingsTextField
                          id="settings-hotspot-password"
                          className="min-w-[176px] flex-1"
                          type={hotspotPasswordShow ? "text" : "password"}
                          value={hotspotPassword}
                          onChange={e => { setHotspotPassword(e.target.value); setHotspotPasswordStatus(null); }}
                          placeholder={hotspotHasPassword ? "••••••••" : "At least 8 characters"}
                          maxLength={63}
                          trailing={
                            /* The reveal is a flex sibling of the input now
                               instead of a `px-3` slab parked on top of it, and
                               it carries the same two `aria-label`s. */
                            <button
                              type="button"
                              onClick={() => setHotspotPasswordShow(v => !v)}
                              className="flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                              aria-label={hotspotPasswordShow ? "Hide password" : "Show password"}
                            >
                              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{hotspotPasswordShow ? "visibility_off" : "visibility"}</span>
                            </button>
                          }
                        />
                        <button
                          onClick={saveHotspotPassword}
                          disabled={hotspotPasswordSaving || hotspotPassword.length < 8}
                          className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        >
                          {t("settings.save")}
                        </button>
                      </div>
                      {hotspotPasswordStatus && <StatusMessage type={hotspotPasswordStatus.type} message={hotspotPasswordStatus.message} />}
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </div>

            {/* Local URL (mDNS hostname) card */}
            <div>
              {/* The header carries the field's `<label htmlFor>` — the same
                  pattern the name field uses, and the only accessible name this
                  input has ever had. */}
              <SettingsGroupHeader icon="link">
                <label htmlFor="settings-hostname">{t("settings.localUrl")}</label>
              </SettingsGroupHeader>
              <SettingsGroup>
                <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                  <p className="text-[12px] leading-relaxed text-[var(--set-on-surface-variant)]">{t("settings.localUrlDesc")}</p>
                  <div className="flex flex-wrap items-end gap-[8px]">
                    <SettingsTextField
                      id="settings-hostname"
                      className="min-w-[176px] flex-1"
                      type="text"
                      value={hostnameInput}
                      onChange={e => { setHostnameInput(e.target.value); setHostnameStatus(null); }}
                      maxLength={63}
                      placeholder="clawbox"
                      trailing={
                        /* Decorative and still OUTSIDE the value: `.local` is
                           never part of what the input holds or what gets
                           POSTed. */
                        <span className="select-none text-[14px] text-[var(--set-on-surface-variant)]">.local</span>
                      }
                    />
                    {/* Still does NOT save — it opens the confirm modal, and the
                        disabled comparison still normalises trim/lowercase/suffix. */}
                    <button
                      onClick={() => setHostnameConfirm(true)}
                      disabled={hostnameSaving || !hostnameInput.trim() || hostnameInput.trim().toLowerCase().replace(/\.local$/, "") === hostname}
                      className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                  {hostnameStatus && <StatusMessage type={hostnameStatus.type} message={hostnameStatus.message} />}
                </div>
              </SettingsGroup>
            </div>

            {/* Saved networks card */}
            {savedNetworks.length > 0 && (
              <div>
                <SettingsGroupHeader icon="bookmark">Saved Networks</SettingsGroupHeader>
                <SettingsGroup>
                  {savedNetworks.map(net => {
                    const isActive = !!net.device;
                    const isEditing = savedEditing === net.name;
                    return (
                      /* One wrapper per network so the divider falls BETWEEN
                         networks and never between a row and its own expanded
                         editor. `key={net.name}` is unchanged. */
                      <div key={net.name}>
                        <SettingsRow
                          label={
                            <span className="flex items-center gap-[12px]">
                              <span
                                className={`material-symbols-rounded shrink-0 ${isActive ? "text-[var(--set-success)]" : "text-[var(--set-on-surface-variant)]"}`}
                                style={{ fontSize: 20 }}
                              >{isActive ? "wifi" : "wifi_password"}</span>
                              <span className="flex min-w-0 flex-col gap-[2px]">
                                <span className="truncate text-[14px] font-medium text-[var(--set-on-surface)]">{net.name}</span>
                                {isActive && <span className="text-[12px] text-[var(--set-success)]">Connected</span>}
                              </span>
                            </span>
                          }
                          trailing={
                            <span className="flex shrink-0 items-center gap-[4px]">
                              <button
                                onClick={() => { setSavedEditing(isEditing ? null : net.name); setSavedNewPassword(""); setSavedStatus(null); }}
                                disabled={savedBusy === net.name}
                                className="flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                                title="Edit password"
                                aria-label={`Edit password for ${net.name}`}
                              >
                                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{isEditing ? "close" : "edit"}</span>
                              </button>
                              {/* Still fires the native `window.confirm` first —
                                  `forgetSavedNetwork` early-returns synchronously,
                                  so the destructive POST keeps its gate. Hover
                                  turns the glyph to the error role. */}
                              <button
                                onClick={() => forgetSavedNetwork(net.name)}
                                disabled={savedBusy === net.name}
                                className="flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-error)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                                title="Forget"
                                aria-label={`Forget ${net.name}`}
                              >
                                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>delete</span>
                              </button>
                            </span>
                          }
                        />
                        {isEditing && (
                          <div className="flex flex-wrap items-end gap-[8px] px-[16px] pb-[12px]">
                            <SettingsTextField
                              className="min-w-[176px] flex-1"
                              type={savedShowPassword ? "text" : "password"}
                              value={savedNewPassword}
                              onChange={e => { setSavedNewPassword(e.target.value); setSavedStatus(null); }}
                              placeholder="New password"
                              maxLength={63}
                              aria-label={`New password for ${net.name}`}
                              trailing={
                                /* This reveal shipped with no accessible name at
                                   all — only the Material ligature. Adding one is
                                   an addition, never a rename. `savedShowPassword`
                                   stays the single shared state across rows. */
                                <button
                                  type="button"
                                  onClick={() => setSavedShowPassword(v => !v)}
                                  className="flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                                  aria-label={savedShowPassword ? "Hide password" : "Show password"}
                                >
                                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{savedShowPassword ? "visibility_off" : "visibility"}</span>
                                </button>
                              }
                            />
                            <button
                              onClick={() => updateSavedPassword(net.name)}
                              disabled={savedBusy === net.name || savedNewPassword.length < 8}
                              className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                            >Save</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {savedStatus && (
                    <div className="px-[16px] py-[12px]">
                      <StatusMessage type={savedStatus.type} message={savedStatus.message} />
                    </div>
                  )}
                </SettingsGroup>
              </div>
            )}

            {/* Connect to network card */}
            <div>
              <SettingsGroupHeader icon="add_circle">{t("settings.connectToNetworkBtn")}</SettingsGroupHeader>
              <SettingsGroup>

                {/* Network list */}
                {wifiNetworks === null && !ssid && (
                  <div className="px-[16px] py-[12px]">
                    <button
                      onClick={scanWifiNetworks}
                      disabled={wifiScanning}
                      className="flex w-full min-h-[44px] cursor-pointer items-center justify-center gap-[8px] rounded-[28px] border-none bg-[var(--set-surface-container-highest)] px-[16px] text-[14px] font-medium text-[var(--set-on-surface)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                    >
                      {wifiScanning ? (
                        <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 18 }}>progress_activity</span> {t("settings.scanning")}</>
                      ) : (
                        <><span className="material-symbols-rounded" style={{ fontSize: 18 }}>wifi_find</span> {t("settings.availableNetworks")}</>
                      )}
                    </button>
                  </div>
                )}

                {wifiNetworks !== null && !ssid && (
                  <div>
                    <div className="flex items-center justify-between gap-[8px] px-[16px] pt-[12px]">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--set-on-surface-variant)]">{t("settings.availableNetworks")}</span>
                      <button
                        onClick={scanWifiNetworks}
                        disabled={wifiScanning}
                        className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-transparent px-[12px] text-[12px] text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                      >
                        <span className={`material-symbols-rounded ${wifiScanning ? "animate-spin" : ""}`} style={{ fontSize: 16 }}>refresh</span>
                        {wifiScanning ? t("settings.scanning") : t("wifi.refresh")}
                      </button>
                    </div>
                    {wifiNetworks.length > 0 ? (
                      /* The list keeps its own scroll — the pane never scrolls
                         sideways for it, and each row is a 44px target now. */
                      <div className="max-h-[200px] overflow-y-auto">
                        {wifiNetworks.map((net) => (
                          <button
                            key={net.ssid}
                            onClick={() => selectNetwork(net)}
                            className="flex w-full min-h-[44px] cursor-pointer items-center gap-[12px] border-none bg-transparent px-[16px] py-[8px] text-left transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                          >
                            <SignalBars level={signalToLevel(net.signal)} />
                            <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--set-on-surface)]">{net.ssid}</span>
                            {net.security && net.security !== "--" && (
                              <span className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]" style={{ fontSize: 16 }}>lock</span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="px-[16px] py-[12px] text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.noNetworks")}</p>
                    )}
                    {/* Deliberately does NOT hide the list above it. */}
                    <button
                      onClick={() => setShowManualWifi(true)}
                      className="flex w-full min-h-[44px] cursor-pointer items-center gap-[12px] border-none bg-transparent px-[16px] py-[8px] text-left transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                    >
                      <span className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]" style={{ fontSize: 18 }}>edit</span>
                      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--set-on-surface)]">{t("settings.otherNetwork")}</span>
                    </button>
                  </div>
                )}

                {/* Connect form (shown after selecting a network or manual entry) */}
                {(ssid !== "" || showManualWifi) && (
                  <div className="flex flex-col gap-[16px] px-[16px] py-[16px]">
                    <div className="flex flex-col gap-[8px]">
                      <label htmlFor="settings-wifi-ssid" className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.networkName")}</label>
                      {/* `readOnly`, NOT `disabled` — a picked SSID must stay
                          focusable and submittable. */}
                      <SettingsTextField
                        id="settings-wifi-ssid"
                        type="text" value={ssid} onChange={e => setSsid(e.target.value)}
                        placeholder={t("settings.enterNetworkName")}
                        readOnly={!showManualWifi && wifiNetworks !== null}
                        leading={<span className="material-symbols-rounded" style={{ fontSize: 18 }}>router</span>}
                      />
                    </div>
                    <div className="flex flex-col gap-[8px]">
                      <label htmlFor="settings-wifi-password" className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.password")}</label>
                      {/* `autoFocus` and Enter-to-connect survive, and there is
                          still no real `<form>` around them. */}
                      <SettingsTextField
                        id="settings-wifi-password"
                        type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)}
                        placeholder={t("settings.enterPassword")}
                        autoFocus
                        leading={<span className="material-symbols-rounded" style={{ fontSize: 18 }}>lock</span>}
                        onKeyDown={e => e.key === "Enter" && connectWifi()}
                      />
                    </div>
                    {/* Hotspot warning */}
                    <div
                      className="flex items-start gap-[8px] rounded-[12px] px-[12px] py-[10px]"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--set-warning) 10%, transparent)",
                        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--set-warning) 30%, transparent)",
                      }}
                    >
                      <span className="material-symbols-rounded shrink-0 text-[var(--set-warning)]" style={{ fontSize: 18 }}>warning</span>
                      <p className="text-[12px] leading-relaxed text-[var(--set-on-surface)]">
                        {t("settings.wifiWarning")}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-[8px]">
                      <button
                        onClick={connectWifi}
                        disabled={wifiConnecting || !ssid.trim()}
                        className="inline-flex min-h-[44px] flex-1 basis-[160px] cursor-pointer items-center justify-center gap-[8px] rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                      >
                        {wifiConnecting ? (
                          <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 18 }}>progress_activity</span> {t("connecting")}</>
                        ) : (
                          <><span className="material-symbols-rounded" style={{ fontSize: 18 }}>link</span> {t("settings.connect")}</>
                        )}
                      </button>
                      <button
                        onClick={() => { setSsid(""); setWifiPass(""); setWifiStatus(null); setShowManualWifi(false); }}
                        className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] bg-transparent px-[20px] text-[14px] font-medium text-[var(--set-on-surface)] transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        style={{ border: "1px solid var(--set-outline)" }}
                      >
                        {t("settings.back")}
                      </button>
                    </div>
                    {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
                  </div>
                )}
              </SettingsGroup>
            </div>

          </div>
        )}

        {/* ─── AI Provider ─── */}
        {activeSection === "ai" && (
          /* AI Provider. The ONLY markup this pane owns is the status card —
             every interactive control (the provider radiogroup, the plan
             picker, the device-code flows, the API-key fields) lives inside
             `AIModelsStep`, which keeps its own nested `<I18nProvider>` exactly
             where it is. One bordered card became one borderless tonal group;
             the three status branches, their order and their strings are the
             ones that shipped, and nothing here fetches, gates or polls
             differently. Gutters are the pane's (24px desktop / 16px mobile),
             so the card reflows to 360px with no horizontal scrollbar. */
          <div className="max-w-xl space-y-[16px]">

            {/* Provider status card */}
            <div>
              <SettingsGroupHeader icon="smart_toy">{t("settings.status")}</SettingsGroupHeader>
              <SettingsGroup>
                {aiProvider === null ? (
                  /* Loading / unknown — and, deliberately, the permanent FAILED
                     state as well: `/ai-models/status` rejecting leaves
                     `aiProvider` null forever, so this skeleton is what a box
                     with a dead endpoint shows. Kept exactly that way. */
                  <div className="flex animate-pulse items-center gap-[16px] px-[16px] py-[12px]">
                    <div className="h-[40px] w-[40px] shrink-0 rounded-full bg-[var(--set-surface-container-highest)]" />
                    <div className="min-w-0 flex-1 space-y-[8px]">
                      <div className="h-[12px] w-[128px] max-w-full rounded-[4px] bg-[var(--set-surface-container-highest)]" />
                      <div className="h-[8px] w-[80px] max-w-full rounded-[4px] bg-[var(--set-surface-container-high)]" />
                    </div>
                  </div>
                ) : aiProvider.connected ? (
                  (() => {
                    const isClawai = aiProvider.provider === "clawai";
                    /* The state layer and `group` exist ONLY on the clawai arm,
                       because only that arm is a link. Every other provider
                       renders the identical fragment inside an inert `<div>`,
                       which is the distinction the contract turns on. The
                       green-tinted plate is gone: in M3 the group IS the
                       surface, and "connected" is carried by the success-tinted
                       disc and the live dot rather than by a second card. */
                    const cardClass = `flex items-center gap-[16px] px-[16px] py-[12px]${
                      isClawai ? " group cursor-pointer rounded-[12px] no-underline transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]" : ""
                    }`;
                    const inner = (
                      <>
                        {/* No `overflow-hidden` anywhere on this disc or its
                            ancestors: `AIProviderIcon` draws the crab mark at
                            2.5x with a negative translate, and the check badge
                            overflows the disc by design. */}
                        <div
                          className="relative flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
                          style={{ backgroundColor: "color-mix(in srgb, var(--set-success) 16%, transparent)" }}
                        >
                          <AIProviderIcon provider={aiProvider.provider} size={24} />
                          <span
                            className="absolute -right-1 -bottom-1 flex h-[20px] w-[20px] items-center justify-center rounded-full"
                            style={{ backgroundColor: "color-mix(in srgb, var(--set-success) 22%, var(--set-surface-container))" }}
                          >
                            <span className="material-symbols-rounded text-[var(--set-success)]" style={{ fontSize: 14 }}>check</span>
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* Wraps instead of overflowing: at 360px a long
                              provider label plus the tier pill take a second
                              line rather than pushing the card sideways. */}
                          <div className="flex flex-wrap items-center gap-[8px]">
                            <span className="min-w-0 max-w-full truncate text-[14px] font-medium text-[var(--set-on-surface)]">{aiProvider.providerLabel}</span>
                            {(() => {
                              const tier = isClawai ? normalizeClawboxAiTier(aiProvider.clawaiTier) : null;
                              if (!tier) return null;
                              /* Two tiers, two ROLES instead of the fuchsia /
                                 orange literal pair: the top tier takes the
                                 action accent, the lower one the neutral
                                 secondary container. Same labels, same
                                 `normalizeClawboxAiTier` mapping. */
                              return (
                                <span
                                  className="shrink-0 rounded-[8px] px-[6px] py-[2px] text-[10px] font-bold uppercase tracking-wider"
                                  style={
                                    tier === "pro"
                                      ? { backgroundColor: "color-mix(in srgb, var(--set-primary) 18%, transparent)", color: "var(--set-primary)" }
                                      : { backgroundColor: "var(--set-secondary-container)", color: "var(--set-on-secondary-container)" }
                                  }
                                >
                                  {CLAWBOX_AI_TIER_LABEL[tier]}
                                </span>
                              );
                            })()}
                          </div>
                          <div className="mt-[2px] flex items-center gap-[6px]">
                            <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--set-success)] animate-pulse" />
                            <span className="min-w-0 truncate text-[12px] text-[var(--set-success)]">
                              {aiProvider.model ? aiProvider.model.split("/").pop() : t("settings.connected")}
                            </span>
                          </div>
                        </div>
                        {isClawai && (
                          <span className="material-symbols-rounded shrink-0 opacity-60 transition-all group-hover:text-[var(--set-success)] group-hover:opacity-100 text-[var(--set-on-surface-variant)]" style={{ fontSize: 18 }} aria-hidden="true">open_in_new</span>
                        )}
                      </>
                    );
                    return isClawai ? (
                      <a
                        href={PORTAL_DASHBOARD_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cardClass}
                        aria-label="Open ClawBox AI portal dashboard"
                      >
                        {inner}
                      </a>
                    ) : (
                      <div className={cardClass}>{inner}</div>
                    );
                  })()
                ) : (
                  <div className="flex items-center gap-[16px] px-[16px] py-[12px]">
                    <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-[var(--set-surface-container-highest)]">
                      <span className="material-symbols-rounded text-[var(--set-on-surface-variant)]" style={{ fontSize: 22 }}>link_off</span>
                    </span>
                    <div className="min-w-0">
                      <div className="text-[14px] text-[var(--set-on-surface)]">{t("settings.noProviderConnected")}</div>
                      <div className="mt-[2px] text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.selectProvider")}</div>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </div>

            <I18nProvider><AIModelsStep
              embedded
              providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
              defaultProviderId="clawai"
              currentProviderId={aiProvider?.provider ?? null}
              currentModel={aiProvider?.model ?? null}
              openClawAIOfferRequest={openClawAIOfferRequest}
              requestedProviderId={requestedAiProviderId}
              providerSelectionRequest={providerSelectionRequest}
              title="Connect AI Provider"
              description="Choose the primary AI service your assistant should use day to day"
              onConfigured={() => {
                fetch("/setup-api/ai-models/status", { cache: "no-store" }).then(r => r.json()).then(setAiProvider).catch(() => {});
                notifyChatModelStateChanged();
                window.dispatchEvent(new Event("clawbox:primary-ai-configured"));
              }}
            /></I18nProvider>
          </div>
        )}

        {/* ─── Local AI ─── */}
        {activeSection === "localAi" && (
          <div className="max-w-xl space-y-5">

            {/* Status. The old bordered card carried its own uppercase label +
                `memory` glyph INSIDE the box; both move to the group header,
                same icon and same `settings.status` key, and the card becomes a
                borderless tonal surface. The only tint left in this group is
                the state plate below, which is the one thing whose colour
                actually carries meaning. */}
            <div>
              <SettingsGroupHeader icon="memory">{t("settings.status")}</SettingsGroupHeader>
              <SettingsGroup divided={false}>
                {localAiStatus === null ? (
                  <div className="mx-[8px] my-[4px] flex animate-pulse items-center gap-[16px] rounded-[12px] px-[16px] py-[12px]">
                    <div className="h-10 w-10 shrink-0 rounded-full bg-[var(--set-surface-container-highest)]" />
                    <div className="min-w-0 flex-1 space-y-[8px]">
                      <div className="h-3 w-32 max-w-full rounded-[4px] bg-[var(--set-surface-container-highest)]" />
                      <div className="h-2 w-20 max-w-full rounded-[4px] bg-[var(--set-outline-variant)]" />
                    </div>
                  </div>
                ) : localAiStatus.configured ? (
                  /* The single amber path in this section is `offline`; every
                     other configured state is the cyan DONE accent. Both are
                     `--set-*` roles composited into the surface with color-mix,
                     which is what replaced the two hardcoded badge-disc hexes
                     and the amber-500 / cyan-500 tint literals — a mix follows
                     the palette under it, a literal cannot. */
                  <div
                    className="mx-[8px] my-[4px] flex items-center gap-[16px] rounded-[12px] px-[16px] py-[12px]"
                    style={{
                      background: `color-mix(in srgb, ${localAiOffline ? "var(--set-warning)" : "var(--set-success)"} 8%, transparent)`,
                    }}
                  >
                    <div
                      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: `color-mix(in srgb, ${localAiOffline ? "var(--set-warning)" : "var(--set-success)"} 14%, transparent)`,
                      }}
                    >
                      <AIProviderIcon provider={localAiStatus.provider} size={24} />
                      <span
                        className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full"
                        style={{
                          background: `color-mix(in srgb, ${localAiOffline ? "var(--set-warning)" : "var(--set-success)"} 20%, var(--set-surface-container))`,
                          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${localAiOffline ? "var(--set-warning)" : "var(--set-success)"} 32%, transparent)`,
                        }}
                      >
                        <span
                          className="material-symbols-rounded"
                          style={{ fontSize: 14, color: localAiOffline ? "var(--set-warning)" : "var(--set-success)" }}
                        >
                          {localAiOffline ? "warning" : "check"}
                        </span>
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-[var(--set-on-surface)]">
                        {localAiStatus.provider === "llamacpp" ? "Gemma 4 Local" : localAiStatus.provider === "ollama" ? "Ollama Local" : "Local AI"}
                      </div>
                      <div className="mt-[2px] flex items-start gap-[6px]">
                        <span
                          className="mt-[6px] h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                          style={{ background: localAiOffline ? "var(--set-warning)" : "var(--set-success)" }}
                        />
                        {/* `break-words` so a long model segment wraps instead
                            of pushing the plate past a 360px pane. */}
                        <span
                          className="min-w-0 break-words text-[12px] leading-[1.4]"
                          style={{ color: localAiOffline ? "var(--set-warning)" : "var(--set-success)" }}
                        >
                          {`${localAiStatus.model ? lastModelSegment(localAiStatus.model) : "Configured"} · ${
                            localAiState ? LOCAL_AI_STATUS_SUFFIX[localAiState] : ""
                          }`}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mx-[8px] my-[4px] flex items-center gap-[16px] rounded-[12px] px-[16px] py-[12px]">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--set-surface-container-highest)]">
                      <span className="material-symbols-rounded text-[var(--set-on-surface-variant)]" style={{ fontSize: 22 }}>memory</span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[14px] text-[var(--set-on-surface-variant)]">No local model configured</div>
                      <div className="mt-[2px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)] opacity-70">Turn on Gemma 4 or Ollama to add a private on-device backup.</div>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </div>

            {/* Shared error sink for BOTH `disableLocalAi` and
                `toggleLocalOnly` — kept as one banner in one place, because the
                clearing rules (cleared by a successful poll or at the start of a
                Disable, never by the toggle) are keyed to it being one sink. */}
            {localAiError && (
              <div
                className="rounded-[12px] px-[16px] py-[12px] text-[14px] leading-[1.4] text-[var(--set-error)]"
                style={{ background: "color-mix(in srgb, var(--set-error) 10%, transparent)" }}
              >
                {localAiError}
              </div>
            )}

            {localAiStatus?.configured && (
              <SettingsGroup>
                {/* `role="switch"` + `aria-label="Local-only mode"` +
                    `aria-checked` + `aria-busy` all still ship — SettingsSwitch
                    emits exactly those, and e2e finds this by
                    `getByRole("switch", { name: "Local-only mode" })`. The
                    handle is now a 44px target instead of the old 24px pill,
                    and `busy` stays distinct from `disabled` so the control
                    keeps focus while the POST resolves. */}
                <SettingsRow
                  label="Local-only mode"
                  description="Route everything to the local model. Disables all cloud AI providers (including fallbacks)."
                  trailing={
                    <div className="flex shrink-0 items-center gap-[8px]">
                      {localOnlyPending && (
                        <span
                          className="material-symbols-rounded animate-spin text-[var(--set-on-surface-variant)]"
                          style={{ fontSize: 18 }}
                          aria-hidden="true"
                        >
                          progress_activity
                        </span>
                      )}
                      <SettingsSwitch
                        label="Local-only mode"
                        checked={!!localOnlyMode}
                        busy={localOnlyPending}
                        disabled={localOnlyPending || localOnlyMode === null}
                        onChange={next => toggleLocalOnly(next)}
                      />
                    </div>
                  }
                />
              </SettingsGroup>
            )}

            {localAiStatus?.configured && (
              <SettingsGroup divided={false}>
                <div className="px-[16px] py-[16px]">
                  {/* `flex-wrap` + a 180px basis on the copy is what makes this
                      row stack on a narrow pane: at 360px the destructive
                      button drops to its own line instead of crushing the
                      explanation to two words per line. No container query and
                      no `sm:` — the first would need `container-type`, which is
                      containment and would clip the fixed-position reset and
                      reboot portals, and the second asks the VIEWPORT while
                      this pane can be narrow inside a wide desktop window. */}
                  <div className="flex flex-wrap items-start justify-between gap-[16px]">
                    <div className="min-w-0 grow basis-[180px]">
                      <div className="text-[16px] font-medium text-[var(--set-on-surface)]">
                        {localAiStatus.provider === "llamacpp" ? "Gemma 4" : "Ollama"}
                      </div>
                      <p className="mt-[4px] text-[14px] leading-[1.4] text-[var(--set-on-surface-variant)]">
                        {localAiState === "offline"
                          ? "Configured, but currently offline."
                          : localAiState === "available"
                            // Installed and ready, but the harness is pointed
                            // elsewhere — name what IS answering so the state is
                            // unambiguous. The label comes from the same endpoint
                            // that reports the active provider, so it can't drift.
                            ? `Installed and ready, but ${harnessLabel} is currently set to ${aiProvider?.providerLabel || aiProvider?.provider || "another provider"}.`
                            : localAiState === "standby"
                              ? `Selected. Kept in on-demand standby to free RAM until ${harnessLabel} needs it.`
                              : "Selected and running as your on-device model."}
                      </p>
                    </div>
                    {/* Stays visibly destructive: this has NO confirmation and
                        stops the runtime / frees its RAM in one click. The red
                        is `--set-error` composited into the surface rather than
                        `red-500/10`, so it follows the palette; the 44px floor
                        is new. */}
                    <button
                      type="button"
                      onClick={disableLocalAi}
                      disabled={localAiDisabling}
                      className="flex shrink-0 cursor-pointer items-center justify-center rounded-[12px] border-none bg-[color-mix(in_srgb,var(--set-error)_12%,transparent)] px-[16px] text-[14px] font-semibold text-[var(--set-error)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--set-error)_24%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--set-error)_20%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-error)] disabled:cursor-default disabled:opacity-50"
                      style={{ minHeight: 44 }}
                    >
                      {localAiDisabling ? "Disabling..." : "Disable"}
                    </button>
                  </div>
                  <p className="mt-[12px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">
                    Disabling Local AI stops the local model and frees the memory it is using.
                  </p>
                </div>
              </SettingsGroup>
            )}

            <I18nProvider><AIModelsStep
              embedded
              providerIds={["llamacpp"]}
              defaultProviderId="llamacpp"
              currentProviderId={localAiStatus?.provider ?? null}
              currentModel={localAiStatus?.model ?? null}
              // Installed is not selected. Without this the panel rendered the
              // green "already configured" pill and hid its own switch button,
              // so a device that had Gemma installed but unselected offered no
              // way to actually start using it.
              localAiIsActive={localAiIsActive}
              title="Set Up Local AI"
              description={localAiStatus?.configured
                ? "Gemma 4 is installed as your private on-device model."
                : "Turn on a local model so ClawBox always has a private on-device backup."}
              configureScope="local"
              testId="settings-local-ai-step"
              onConfigured={() => {
                refreshLocalAiStatus().catch(() => {});
                notifyChatModelStateChanged();
              }}
            /></I18nProvider>
          </div>
        )}

        {/* ─── Telegram ─── */}
        {activeSection === "telegram" && (
          <div className="max-w-xl space-y-5">

            {/* Status group */}
            <div>
              {/* The Telegram mark is a BRAND GLYPH, not a Material ligature, so
                  it travels in `children` instead of the header's `icon` slot —
                  the path data is byte-for-byte what shipped. Its fill moves from
                  a hardcoded #f97316 to `currentColor`, which the header paints
                  `--set-on-surface-variant`: the same demotion every other group
                  header in this pane took when its coral icon became a header
                  glyph. Brand blue is a different question and survives below. */}
              <SettingsGroupHeader>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="mr-[8px] inline-block shrink-0 align-[-3px]"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.504-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.012-1.252-.242-1.865-.44-.751-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                {t("settings.status")}
              </SettingsGroupHeader>
              <SettingsGroup>
                {tgConfigured === null ? (
                  /* Unknown / skeleton. Still the ONLY thing this section paints
                     while `/telegram/status` has never answered — the error path
                     deliberately writes no state, so this is also the permanent
                     view of a box whose gateway keeps erroring. */
                  <div className="flex animate-pulse items-center gap-[16px] px-[16px] py-[12px]" style={{ minHeight: 56 }}>
                    <div className="h-[40px] w-[40px] shrink-0 rounded-full bg-[var(--set-surface-container-highest)]" />
                    <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
                      <div className="h-[12px] w-[128px] max-w-full rounded-[4px] bg-[var(--set-surface-container-highest)]" />
                      <div className="h-[8px] w-[80px] max-w-full rounded-[4px] bg-[var(--set-surface-container-highest)]" />
                    </div>
                  </div>
                ) : tgConfigured && !tgReconfigure ? (
                  /* A FRAGMENT, not a wrapper div: the group draws its dividers
                     with `> * + *`, so these four children have to be the group's
                     own DOM children for the 16px-inset hairlines to land between
                     them. The `link` row is conditional and produces no node when
                     absent, which is exactly when no divider should be drawn. */
                  <>
                    <div className="flex items-center gap-[16px] px-[16px] py-[12px]" style={{ minHeight: 56 }}>
                      <div
                        className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
                        style={{ backgroundColor: "color-mix(in srgb, var(--set-success) 15%, transparent)" }}
                      >
                        <span className="material-symbols-rounded text-[var(--set-success)]" style={{ fontSize: 22 }}>check_circle</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        {/* Still the same fallback: a configured bot whose
                            metadata never resolved reads "Bot Connected" and
                            says nothing about the failed verification. */}
                        <div className="truncate text-[14px] font-medium text-[var(--set-on-surface)]">
                          {tgBotInfo?.firstName || t("settings.botConnected")}
                        </div>
                        {tgBotInfo?.username && (
                          <div className="mt-[2px] truncate text-[12px] text-[var(--set-on-surface-variant)]">@{tgBotInfo.username}</div>
                        )}
                        <div className="mt-[2px] flex items-center gap-[6px]">
                          <span className="h-[6px] w-[6px] shrink-0 animate-pulse rounded-full bg-[var(--set-success)]" />
                          <span className="min-w-0 truncate text-[12px] text-[var(--set-success)]">{t("settings.telegramActive")}</span>
                        </div>
                      </div>
                    </div>
                    {tgBotInfo?.link && (
                      /* Telegram blue, unchanged. It is the ONE colour in this
                         section that is not a palette role and must not become
                         one: `--set-brand-telegram*` is declared in the base
                         `.settings-pane` block and deliberately NOT re-pointed
                         for Hermes, because a third-party mark reads the same on
                         every box — the same treatment `--set-error` gets. The
                         outline is gone (M3 tonal, not outlined); the fill,
                         the ink and the paper-plane path are the shipped ones. */
                      <div className="px-[16px] py-[8px]">
                        <a
                          href={tgBotInfo.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-[8px] rounded-[28px] bg-[var(--set-brand-telegram-wash)] px-[16px] py-[8px] text-[14px] font-medium text-[var(--set-brand-telegram-ink)] no-underline transition-colors hover:bg-[var(--set-brand-telegram-wash-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
                          <span className="min-w-0 truncate">{t("settings.openInTelegram", { name: `@${tgBotInfo.username}` })}</span>
                        </a>
                      </div>
                    )}
                    {/* Optimistic toggle, 502-is-success rule and all: the row is
                        presentation, `toggleTelegramStreaming` is untouched. */}
                    <SettingsRow
                      label={t("settings.telegramProgress")}
                      description={t("settings.telegramProgressHint")}
                      trailing={
                        <span className="flex shrink-0 items-center gap-[8px]">
                          {tgStreamingPending && (
                            <span className="material-symbols-rounded animate-spin text-[var(--set-on-surface-variant)]" style={{ fontSize: 18 }} aria-hidden="true">progress_activity</span>
                          )}
                          <SettingsSwitch
                            label={t("settings.telegramProgress")}
                            checked={!!tgStreaming}
                            busy={tgStreamingPending}
                            disabled={tgStreamingPending || tgStreaming === null}
                            onChange={() => toggleTelegramStreaming(!tgStreaming)}
                          />
                        </span>
                      }
                    />
                    {/* Swaps the whole pane — the user-access group unmounts and
                        the setup group mounts with its Cancel. A chevron row, not
                        an underlined link, and the glyph is `aria-hidden` so the
                        button still names itself "Reconfigure Bot" alone. */}
                    <SettingsRow
                      label={t("settings.reconfigureBot")}
                      onClick={() => { setTgReconfigure(true); setTgStatus(null); }}
                      trailing={
                        <span aria-hidden="true" className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]" style={{ fontSize: 20 }}>chevron_right</span>
                      }
                    />
                  </>
                ) : (
                  <div className="flex items-center gap-[16px] px-[16px] py-[12px]" style={{ minHeight: 56 }}>
                    <div className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-[var(--set-surface-container-highest)]">
                      <span className="material-symbols-rounded text-[var(--set-on-surface-variant)]" style={{ fontSize: 22 }}>link_off</span>
                    </div>
                    <div className="min-w-0">
                      {/* Was `text-muted` over `text-muted opacity-50` — two
                          weights of the same grey, the second of which measured
                          under 3:1. Now the role pair the rest of the pane uses. */}
                      <div className="text-[14px] text-[var(--set-on-surface)]">{t("settings.notConfigured")}</div>
                      <div className="mt-[2px] text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.setupBotBelow")}</div>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </div>

            {/* User access — pairing approval (only when a bot is configured) */}
            {tgConfigured && !tgReconfigure && !tgConfiguring && (
              <div>
                <SettingsGroupHeader icon="group">{t("settings.pairingTitle")}</SettingsGroupHeader>
                {/* `divided={false}`: this group is a form, not a list of rows —
                    the one hairline it wants (above the approved-user chips) is
                    placed by hand, inset to the same 16px. */}
                <SettingsGroup divided={false}>
                  <p className="m-0 px-[16px] pt-[8px] pb-[12px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("settings.pairingHint")}</p>

                  {/* Paste a code. `flex-wrap` + `basis-[160px]` is what makes
                      this usable at 360px: the field and Approve sit on one line
                      in the desktop pane and drop to two the moment the pane is
                      narrower than they are, instead of squeezing an 8-character
                      0.3em-tracked field down to nothing. */}
                  <div className="flex flex-wrap items-end gap-[8px] px-[16px] pb-[12px]">
                    <SettingsTextField
                      className="min-w-0 flex-1 basis-[160px]"
                      type="text"
                      value={tgPairingCode}
                      onChange={(e) => { setTgPairingCode(e.target.value.toUpperCase()); setTgPairingStatus(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && !tgApproving) approvePairingCode(tgPairingCode); }}
                      placeholder={t("settings.pairingCodePlaceholder")}
                      aria-label={t("settings.pairingCodePlaceholder")}
                      maxLength={8}
                      spellCheck={false}
                      autoCapitalize="characters"
                      inputClassName="font-mono uppercase tracking-[0.3em] placeholder:font-sans placeholder:tracking-normal"
                    />
                    {/* Still disabled unless the code is exactly 8 long, so a
                        16-hex Hermes request id still cannot be approved here —
                        only the per-row Approve below can do that. */}
                    <button
                      type="button"
                      disabled={tgApproving || tgPairingCode.trim().length !== 8}
                      onClick={() => approvePairingCode(tgPairingCode)}
                      className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center gap-[6px] rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                    >
                      {tgApproving && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>}
                      {t("settings.pairingApprove")}
                    </button>
                  </div>

                  {tgPairingStatus && <div className="px-[16px] pb-[12px]"><StatusMessage type={tgPairingStatus.type} message={tgPairingStatus.message} /></div>}

                  {/* Pending requests — opt-in load (the list CLI is slow on Jetson) */}
                  <div className="px-[16px] pb-[12px]">
                    {tgPending === null ? (
                      <button
                        type="button"
                        disabled={tgPendingLoading}
                        onClick={loadPending}
                        className="-ml-[12px] inline-flex min-h-[44px] cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-transparent px-[12px] text-[14px] font-medium text-[var(--set-primary)] transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                      >
                        <span className={`material-symbols-rounded shrink-0 ${tgPendingLoading ? "animate-spin" : ""}`} style={{ fontSize: 16 }} aria-hidden="true">{tgPendingLoading ? "progress_activity" : "refresh"}</span>
                        {tgPendingLoading ? t("settings.pairingChecking") : t("settings.pairingCheck")}
                      </button>
                    ) : (
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-[8px]">
                          <span className="min-w-0 text-[12px] font-semibold text-[var(--set-on-surface-variant)]">{t("settings.pairingPending")}</span>
                          <button
                            type="button"
                            disabled={tgPendingLoading}
                            onClick={loadPending}
                            className="-mr-[12px] inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-transparent px-[12px] text-[12px] font-medium text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                          >
                            <span className={`material-symbols-rounded shrink-0 ${tgPendingLoading ? "animate-spin" : ""}`} style={{ fontSize: 14 }} aria-hidden="true">{tgPendingLoading ? "progress_activity" : "refresh"}</span>
                            {t("settings.pairingCheck")}
                          </button>
                        </div>
                        {tgPending.length === 0 ? (
                          <p className="m-0 text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.pairingNoPending")}</p>
                        ) : (
                          <ul className="m-0 flex list-none flex-col gap-[8px] p-0">
                            {tgPending.map((req, i) => {
                              const label = req.name || req.id || req.code || `#${i + 1}`;
                              return (
                                /* `flex-wrap` again: the id is a 16-hex mono
                                   string, so on a 360px phone the Approve button
                                   drops under it instead of shoving it off. */
                                <li key={req.code || req.id || i} className="flex flex-wrap items-center justify-between gap-[8px] rounded-[12px] bg-[var(--set-surface-container-highest)] px-[12px] py-[8px]">
                                  <div className="min-w-0 flex-1 basis-[140px]">
                                    <div className="truncate text-[14px] text-[var(--set-on-surface)]">{label}</div>
                                    {req.id && label !== req.id && <div className="truncate font-mono text-[12px] text-[var(--set-on-surface-variant)]">{req.id}</div>}
                                  </div>
                                  {req.code && (
                                    /* The ONLY path that can approve a 16-hex
                                       Hermes id, and `disabled={tgApproving}`
                                       still disables every row at once. */
                                    <button
                                      type="button"
                                      disabled={tgApproving}
                                      onClick={() => approvePairingCode(req.code!)}
                                      className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-[var(--set-secondary-container)] px-[16px] text-[12px] font-medium text-[var(--set-on-secondary-container)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                                    >
                                      {t("settings.pairingApprove")}
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Approved users */}
                  <div className="mx-[16px] h-px bg-[var(--set-outline-variant)]" />
                  <div className="px-[16px] pt-[12px] pb-[12px]">
                    <span className="text-[12px] font-semibold text-[var(--set-on-surface-variant)]">{t("settings.pairingApprovedTitle")}</span>
                    {tgApproved.length === 0 ? (
                      <p className="m-0 mt-[4px] text-[12px] text-[var(--set-on-surface-variant)]">{t("settings.pairingNoApproved")}</p>
                    ) : (
                      <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-[8px] p-0">
                        {tgApproved.map((u) => (
                          /* Still non-interactive, and there is still no revoke
                             control anywhere in this pane. */
                          <li key={u.id} className="inline-flex max-w-full items-center gap-[6px] rounded-full bg-[var(--set-surface-container-highest)] px-[12px] py-[4px] text-[12px] text-[var(--set-on-surface-variant)]">
                            <span className="material-symbols-rounded shrink-0 text-[var(--set-success)]" style={{ fontSize: 14 }} aria-hidden="true">check</span>
                            {u.name ? (
                              <>
                                <span className="min-w-0 truncate">{u.name}</span>
                                <span className="min-w-0 truncate font-mono text-[11px] text-[var(--set-on-surface-variant)]">{u.id}</span>
                              </>
                            ) : (
                              <span className="min-w-0 truncate font-mono">{u.id}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </SettingsGroup>
              </div>
            )}

            {/* Setup card — shown when not configured or reconfiguring */}
            {(tgConfigured === false || tgReconfigure || tgConfiguring) && (
              <div>
                <SettingsGroupHeader icon="add_circle">
                  {tgReconfigure ? t("settings.reconfigureBot") : t("settings.setupBot")}
                </SettingsGroupHeader>
                {/* `relative overflow-hidden` moves onto the group, because the
                    configuring overlay mounts INSIDE it and the form beneath is
                    hidden with `invisible h-0 overflow-hidden` rather than
                    unmounted. `overflow-hidden` is not a transform/filter, so it
                    creates no containing block and cannot clip the factory-reset
                    or hostname-reboot portals. */}
                <SettingsGroup divided={false} className="relative overflow-hidden">
                {tgConfiguring && (
                  <TelegramConfiguringOverlay
                    waitFor={tgConfigurePromise}
                    onDone={() => {
                      setTgConfiguring(false);
                      setTgConfigurePromise(undefined);
                      refreshTelegramStatus();
                    }}
                  />
                )}
                <div className={tgConfiguring ? "invisible h-0 overflow-hidden" : ""}>

                {/* Instructions with QR. `flex-wrap` + `basis-[180px]` lets the
                    numbered list sit beside the code in the desktop pane and drop
                    beneath it on a narrow phone, rather than being crushed to a
                    two-words-per-line column. */}
                <div className="flex flex-wrap items-start gap-[16px] px-[16px] pt-[8px] pb-[16px]">
                  {/* The quiet zone stays a literal white plate with a black
                      module colour at size 80 / level "M": a tinted or dark QR
                      degrades phone scanning, so this one is a FUNCTIONAL colour
                      and not a palette role. It does not follow the edition. */}
                  <div className="shrink-0 rounded-[8px] bg-white p-[8px]">
                    <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
                  </div>
                  <ol className="m-0 min-w-0 flex-1 basis-[180px] list-decimal pl-[20px] text-[14px] leading-[1.9] text-[var(--set-on-surface-variant)]">
                    <li>
                      Scan the QR or open{" "}
                      <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--set-primary)] no-underline hover:underline">
                        @BotFather
                      </a>{" "}
                      in Telegram
                    </li>
                    <li>
                      Send{" "}
                      <code className="rounded-[4px] bg-[var(--set-surface-container-highest)] px-[6px] py-[2px] text-[12px] text-[var(--set-primary)]">
                        /newbot
                      </code>{" "}
                      and follow the prompts
                    </li>
                    <li>
                      Copy the <strong className="text-[var(--set-on-surface)]">Bot Token</strong> and paste below
                    </li>
                  </ol>
                </div>

                {/* Token input */}
                <div className="flex flex-col gap-[8px] px-[16px] pb-[12px]">
                  <label htmlFor="settings-tg-token" className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.botToken")}</label>
                  {/* The `key` glyph and the reveal are FLEX SIBLINGS of the
                      input now, so the old `left-3`/`pl-10` and
                      `right-2.5`/`pr-10` coupling is gone: neither decoration can
                      overlap the token any more, at any width. */}
                  <SettingsTextField
                    id="settings-tg-token"
                    type={tgShowToken ? "text" : "password"}
                    value={tgToken}
                    onChange={(e) => { setTgToken(e.target.value); setTgStatus(null); }}
                    placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                    spellCheck={false}
                    autoComplete="off"
                    onKeyDown={e => e.key === "Enter" && saveTelegram()}
                    leading={
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">key</span>
                    }
                    trailing={
                      /* Deliberately still unnamed. The contract records the
                         missing `aria-label` as known debt and says to ADD names
                         rather than remove them — adding one here would change
                         what this button announces, which is a product decision
                         and not part of a restyle. */
                      <button
                        type="button"
                        onClick={() => setTgShowToken(v => !v)}
                        className="flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{tgShowToken ? "visibility_off" : "visibility"}</span>
                      </button>
                    }
                  />
                </div>

                {tgStatus && <div className="px-[16px] pb-[12px]"><StatusMessage type={tgStatus.type} message={tgStatus.message} /></div>}

                <div className="flex flex-wrap items-center gap-[8px] px-[16px] pb-[12px]">
                  <button
                    onClick={saveTelegram}
                    disabled={tgSaving || !tgToken.trim()}
                    className="inline-flex min-h-[44px] flex-1 basis-[160px] cursor-pointer items-center justify-center gap-[8px] rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                  >
                    {tgSaving ? (
                      <>
                        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                        {t("connecting")}
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span>
                        {t("settings.connect")}
                      </>
                    )}
                  </button>
                  {tgReconfigure && (
                    /* Still not disabled while saving — the overlay is what hides
                       it, exactly as before. */
                    <button
                      onClick={() => { setTgReconfigure(false); setTgStatus(null); setTgToken(""); }}
                      className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-[28px] border-none bg-transparent px-[20px] text-[14px] font-medium text-[var(--set-on-surface)] transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
                </div>
                </SettingsGroup>
              </div>
            )}

          </div>
        )}

        {/* ─── System ─── */}
        {activeSection === "system" && (
          /* System. Six bordered cards became the harness picker plus five
             borderless tonal groups. Every uppercase label + coral glyph that
             used to sit INSIDE its box is now a `SettingsGroupHeader` above the
             surface, with the same `t()` key and the same Material ligature.

             Nothing here fetches, gates or polls differently than it did: the
             3s stats interval, the `stats === null` spinner with no error
             branch, the four conditionally-absent cards (swap `total > 0`, GPU
             `!= null`, the whole temperature card, storage with `/boot/efi`
             filtered out and legitimately empty), the three-stage password flow
             and its `Re-enter` escape hatch are all the ones that shipped. The
             password-confirmation alertdialog stays where it is — desktop-only,
             in the desktop return tree — because moving it is a behaviour
             change, not a restyle.

             `HarnessPicker` is deliberately untouched: `harness-picker.test.tsx`
             asserts its exact class strings (`bg-emerald-400`, `bg-white/25`)
             and its `data-testid="harness-locked-dot"`.

             The gutters are the pane's (24px desktop / 16px mobile), so every
             group reflows to 360px with no horizontal scrollbar: each key/value
             line is `flex-wrap` with a `min-w-0` mono value, so the value drops
             onto its own line instead of pushing the group sideways. */
          <div className="max-w-xl space-y-[16px]">

            <HarnessPicker />

            {stats ? (
              <>
                {/* Device */}
                <div>
                  {/* The uptime pill was `ml-auto` inside the old card header.
                      The header now lives above the surface, so the pill rides
                      alongside it rather than being given a row and a label it
                      never had — no new string enters the pane. */}
                  <div className="flex items-center justify-between gap-[8px] pr-[16px]">
                    <SettingsGroupHeader icon="computer" className="min-w-0 flex-1">{t("settings.device")}</SettingsGroupHeader>
                    <span className="shrink-0 rounded-[8px] bg-[var(--set-secondary-container)] px-[8px] py-[4px] font-mono text-[11px] text-[var(--set-on-secondary-container)]">{stats.overview.uptime}</span>
                  </div>
                  <SettingsGroup>
                    <SettingsRow
                      label={t("settings.hostname")}
                      trailing={<span className="min-w-0 break-all text-right font-mono text-[12px] text-[var(--set-on-surface)]">{stats.overview.hostname}</span>}
                    />
                    <SettingsRow
                      label={t("settings.os")}
                      trailing={<span className="min-w-0 break-all text-right font-mono text-[12px] text-[var(--set-on-surface)]">{stats.overview.os}</span>}
                    />
                    <SettingsRow
                      label={t("settings.kernel")}
                      trailing={<span className="min-w-0 break-all text-right font-mono text-[12px] text-[var(--set-on-surface)]">{stats.overview.kernel}</span>}
                    />
                    <SettingsRow
                      label={t("settings.arch")}
                      trailing={<span className="min-w-0 break-all text-right font-mono text-[12px] text-[var(--set-on-surface)]">{stats.overview.arch}</span>}
                    />
                  </SettingsGroup>
                </div>

                {/* Resources — CPU, memory, swap, GPU */}
                <div>
                  <SettingsGroupHeader icon="speed">{t("settings.resources")}</SettingsGroupHeader>
                  <SettingsGroup>
                    {/* CPU */}
                    <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px]">
                        <span className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.cpu")}</span>
                        <span className="shrink-0 font-mono text-[12px] font-semibold" style={{ color: barColor(stats.cpu.usage) }}>{stats.cpu.usage}%</span>
                      </div>
                      {/* `duration-700` and the linear default stay: this bar
                          reports real data, and `--ease-truth` is linear on
                          purpose — an eased fill fabricates velocity. */}
                      <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.cpu.usage}%`, backgroundColor: barColor(stats.cpu.usage) }} />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px] text-[11px] text-[var(--set-on-surface-variant)]">
                        <span className="min-w-0 truncate font-mono">{stats.cpu.model}</span>
                        <span className="shrink-0">{stats.cpu.cores} {t("settings.cores")} &middot; Load {stats.cpu.loadAvg[0]}</span>
                      </div>
                    </div>

                    {/* Memory */}
                    <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px]">
                        <span className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.memory")}</span>
                        <span className="shrink-0 font-mono text-[12px] text-[var(--set-on-surface-variant)]">{formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}</span>
                      </div>
                      <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.usedPercent}%`, backgroundColor: barColor(stats.memory.usedPercent) }} />
                      </div>
                      <div className="text-right text-[11px] text-[var(--set-on-surface-variant)]">{stats.memory.usedPercent}% &middot; {formatBytes(stats.memory.free)} free</div>
                    </div>

                    {/* Swap — still conditional on `total > 0` */}
                    {stats.memory.swap.total > 0 && (
                      <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                        <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px]">
                          <span className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.swap")}</span>
                          <span className="shrink-0 font-mono text-[12px] text-[var(--set-on-surface-variant)]">{formatBytes(stats.memory.swap.used)} / {formatBytes(stats.memory.swap.total)}</span>
                        </div>
                        {/* Swap's bar must NOT read on the same ladder as RAM —
                            that distinction is why it shipped violet. There is
                            no violet role and inventing one would be a new
                            colour, so swap takes the neutral ink instead: still
                            unmistakably a different statement from the
                            red/coral/amber/cyan load ladder, and it follows the
                            palette, which `#a855f7` could never do. */}
                        <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.swap.percent}%`, backgroundColor: "var(--set-on-surface-variant)" }} />
                        </div>
                        <div className="text-right text-[11px] text-[var(--set-on-surface-variant)]">{stats.memory.swap.percent}% used</div>
                      </div>
                    )}

                    {/* GPU — still conditional on `gpu != null`; `usage === 0`
                        renders, exactly as it does today. */}
                    {stats.gpu != null && (
                      <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                        <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px]">
                          <span className="text-[14px] leading-[1.3] text-[var(--set-on-surface)]">{t("settings.gpu")}</span>
                          <span className="shrink-0 font-mono text-[12px] font-semibold" style={{ color: barColor(stats.gpu.usage) }}>{stats.gpu.usage}%</span>
                        </div>
                        <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.gpu.usage}%`, backgroundColor: barColor(stats.gpu.usage) }} />
                        </div>
                      </div>
                    )}
                  </SettingsGroup>
                </div>

                {/* Temperature — the whole group disappears with the sensor */}
                {stats.temperature?.value != null && (
                  <div>
                    <SettingsGroupHeader icon="thermostat">{t("settings.temperature")}</SettingsGroupHeader>
                    <SettingsGroup divided={false}>
                      <div className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                        <div className="flex flex-wrap items-end gap-x-[12px] gap-y-[2px]">
                          {/* Number, word and bar switch together on the SAME
                              thresholds (>80 / >60) they always have. */}
                          <span className="font-mono text-[30px] font-bold leading-none" style={{ color: tempColor(stats.temperature.value) }}>
                            {stats.temperature.display}
                          </span>
                          <span className="text-[12px] text-[var(--set-on-surface-variant)]">
                            {stats.temperature.value > 80 ? t("settings.critical") : stats.temperature.value > 60 ? t("settings.warm") : t("settings.normal")}
                          </span>
                        </div>
                        <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${Math.min(100, (stats.temperature.value / 100) * 100)}%`,
                              backgroundColor: tempColor(stats.temperature.value),
                            }}
                          />
                        </div>
                        {/* Ticks stay fixed at 0 / 50 / 100 °C. */}
                        <div className="flex justify-between font-mono text-[11px] text-[var(--set-on-surface-variant)]">
                          <span>0°C</span><span>50°C</span><span>100°C</span>
                        </div>
                      </div>
                    </SettingsGroup>
                  </div>
                )}

                {/* Storage — `/boot/efi` filtered out, and legitimately empty */}
                <div>
                  <SettingsGroupHeader icon="hard_drive">{t("settings.storage")}</SettingsGroupHeader>
                  <SettingsGroup>
                    {stats.storage.filter(m => m.mountpoint !== "/boot/efi").map(m => (
                      <div key={m.mountpoint} className="flex flex-col gap-[8px] px-[16px] py-[12px]">
                        <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[2px]">
                          <span className="min-w-0 break-all font-mono text-[13px] text-[var(--set-on-surface)]">{m.mountpoint}</span>
                          <span className="shrink-0 font-mono text-[12px] text-[var(--set-on-surface-variant)]">{m.used} / {m.size}</span>
                        </div>
                        <div className="h-[8px] w-full overflow-hidden rounded-full bg-[var(--set-surface-container-highest)]">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${m.usePercent}%`, backgroundColor: barColor(m.usePercent) }} />
                        </div>
                        <div className="text-right text-[11px] text-[var(--set-on-surface-variant)]">{m.usePercent}% &middot; {m.avail} free</div>
                      </div>
                    ))}
                  </SettingsGroup>
                </div>

              </>
            ) : (
              /* `stats === null` is BOTH "loading" and "permanently failed" —
                 the catch is empty and there is no error branch. Unchanged. */
              <div className="flex items-center justify-center gap-[12px] py-[48px] text-[var(--set-on-surface-variant)]">
                <span className="h-[24px] w-[24px] animate-spin rounded-full border-2 border-[var(--set-outline-variant)]" style={{ borderTopColor: "var(--set-primary)" }} />
                <span className="text-[14px]">{t("settings.loadingStats")}</span>
              </div>
            )}

            {/* Password — used for both web sign-in and SSH/sudo (PAM-backed).
                `Password`, the description, `Verify`, `Checking…`, `Re-enter`,
                `Update password`, `Saving…` and the mismatch hint are hardcoded
                English today and stay hardcoded English: adding a key here
                would be a translation change, not a restyle. */}
            <div>
              <SettingsGroupHeader icon="key">Password</SettingsGroupHeader>
              <SettingsGroup divided={false}>
                <div className="flex flex-col gap-[12px] px-[16px] py-[12px]">
                  <p className="text-[12px] leading-relaxed text-[var(--set-on-surface-variant)]">
                    Used for web sign-in, SSH, and <span className="font-mono">sudo</span>. Updating it here changes all three.
                  </p>

                  {/* Stage 1 — current password + verify.
                      `flex-wrap` with a 180px floor on the field: at 360px the
                      Verify button drops onto its own line instead of squeezing
                      the input to nothing. */}
                  <div className="flex flex-wrap items-start gap-[8px]">
                    <div className="min-w-[180px] flex-1">
                      {/* The `sr-only` label is the field's ONLY accessible name
                          and the association travels with it. */}
                      <label htmlFor="sys-current-password" className="sr-only">Current password</label>
                      <SettingsTextField
                        id="sys-current-password"
                        type={sysPasswordShow ? "text" : "password"}
                        value={sysCurrentPassword}
                        onChange={e => { setSysCurrentPassword(e.target.value); if (sysCurrentVerified) setSysCurrentVerified(false); setSysPasswordStatus(null); }}
                        onKeyDown={e => { if (e.key === "Enter" && !sysCurrentVerified) { e.preventDefault(); void verifyCurrentPassword(); } }}
                        placeholder="Current password"
                        maxLength={128}
                        autoComplete="current-password"
                        disabled={sysCurrentVerified}
                        trailing={
                          /* Was `px-3` on a `py-2` input — roughly 24×36. Now a
                             real 44×44 target; same handler, same two labels. */
                          <button type="button" onClick={() => setSysPasswordShow(v => !v)} className="-mr-[8px] flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]" aria-label={sysPasswordShow ? "Hide current password" : "Show current password"}>
                            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{sysPasswordShow ? "visibility_off" : "visibility"}</span>
                          </button>
                        }
                      />
                    </div>
                    {sysCurrentVerified ? (
                      /* The ONLY way out of the verified state. Same handler,
                         same `title`, same `aria-label`. */
                      <button
                        type="button"
                        onClick={resetSysPasswordForm}
                        className="flex min-h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-[var(--set-secondary-container)] px-[16px] text-[14px] font-medium text-[var(--set-on-secondary-container)] transition-colors hover:bg-[var(--set-surface-container-high)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        title="Clear and re-enter current password"
                        aria-label="Clear and re-enter current password"
                      >
                        <span className="material-symbols-rounded text-[var(--set-success)]" style={{ fontSize: 18 }}>check_circle</span>
                        Re-enter
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={verifyCurrentPassword}
                        disabled={sysVerifying || !sysCurrentPassword}
                        className="min-h-[44px] shrink-0 cursor-pointer rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                      >
                        {sysVerifying ? "Checking…" : "Verify"}
                      </button>
                    )}
                  </div>

                  {sysCurrentVerified && (
                    <>
                      <div>
                        <label htmlFor="sys-new-password" className="sr-only">New password</label>
                        <SettingsTextField
                          id="sys-new-password"
                          type={sysNewShow ? "text" : "password"}
                          value={sysPassword}
                          onChange={e => { setSysPassword(e.target.value); setSysPasswordStatus(null); }}
                          placeholder="New password (8+ characters)"
                          maxLength={128}
                          autoComplete="new-password"
                          /* Focus still jumps here the moment Verify succeeds. */
                          autoFocus
                          trailing={
                            <button type="button" onClick={() => setSysNewShow(v => !v)} className="-mr-[8px] flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]" aria-label={sysNewShow ? "Hide new password" : "Show new password"}>
                              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{sysNewShow ? "visibility_off" : "visibility"}</span>
                            </button>
                          }
                        />
                      </div>
                      <div>
                        <label htmlFor="sys-confirm-password" className="sr-only">Confirm new password</label>
                        <SettingsTextField
                          id="sys-confirm-password"
                          type={sysConfirmShow ? "text" : "password"}
                          value={sysPasswordConfirm}
                          onChange={e => { setSysPasswordConfirm(e.target.value); setSysPasswordStatus(null); }}
                          placeholder="Confirm new password"
                          maxLength={128}
                          autoComplete="new-password"
                          trailing={
                            <button type="button" onClick={() => setSysConfirmShow(v => !v)} className="-mr-[8px] flex h-[44px] w-[44px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]" aria-label={sysConfirmShow ? "Hide confirm password" : "Show confirm password"}>
                              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{sysConfirmShow ? "visibility_off" : "visibility"}</span>
                            </button>
                          }
                        />
                      </div>
                      {/* Its own live region, NOT the text field's `invalid`
                          helper: this hint is CAUTION (amber), not an error,
                          and folding it into the field would repaint the
                          indicator red and set `aria-invalid` on a field the
                          user has not finished typing. Same role, same
                          `aria-live`, same 11px, same words. */}
                      {sysPassword.length > 0 && sysPasswordConfirm.length > 0 && sysPassword !== sysPasswordConfirm && (
                        <div role="alert" aria-live="polite" className="text-[11px] text-[var(--set-warning)]">Passwords don&apos;t match yet</div>
                      )}
                      <div className="flex justify-end">
                        {/* Still does not save — it re-validates and opens the
                            alertdialog. Same `disabled` expression, so "same as
                            current" still surfaces as an inline error instead. */}
                        <button
                          onClick={requestSystemPasswordChange}
                          disabled={sysPasswordSaving || sysPassword.length < 8 || sysPassword !== sysPasswordConfirm}
                          className="min-h-[44px] shrink-0 cursor-pointer rounded-[28px] border-none bg-[var(--set-primary)] px-[20px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
                        >
                          {sysPasswordSaving ? "Saving…" : "Update password"}
                        </button>
                      </div>
                    </>
                  )}
                  {sysPasswordStatus && <StatusMessage type={sysPasswordStatus.type} message={sysPasswordStatus.message} />}
                </div>
              </SettingsGroup>
            </div>

          </div>
        )}

        {/* ─── Remote Control ─── */}
        {activeSection === "remote" && renderRemoteSection()}

        {/* ─── About ─── */}
        {activeSection === "about" && (<>
          <div className="max-w-xl space-y-6">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">{t("settings.aboutClawBox")}</h2>

            <div className="bg-white/5 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-4">
                <img src="/icon-512.png" alt="ClawBox" className="w-14 h-14 rounded-2xl" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div>
                  <div className="text-lg font-bold text-[var(--text-primary)]">ClawBox</div>
                  <div className="text-xs text-[var(--text-muted)]">{t("settings.personalAI")}</div>
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.version")}</span>
                  <span className="text-[var(--text-primary)]">{versionInfo?.clawbox.current ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.runtime")}</span>
                  <span className="text-[var(--text-primary)]">Next.js + Bun</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.platform")}</span>
                  <span className="text-[var(--text-primary)]">{stats ? `${stats.overview.arch} ${stats.overview.platform}` : "..."}</span>
                </div>
              </div>
            </div>

            <a
              href="https://openclawhardware.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>help</span>
              {t("settings.documentation")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href="https://t.me/ClawBoxSupportBot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>support_agent</span>
              {t("settings.support")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              {t("settings.discordCommunity")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            {/* Beta toggle */}
            <div className="bg-white/5 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 20 }}>science</span>
                  <div>
                    <span className="text-sm text-[var(--text-primary)]">{t("settings.betaChannel")}</span>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{t("settings.betaDesc")}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleBeta(!betaEnabled)}
                  disabled={betaSaving}
                  className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${betaEnabled ? "bg-amber-500" : "bg-white/15"} ${betaSaving ? "opacity-50" : ""}`}
                >
                  <span
                    className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
                    style={{ left: 2, transform: betaEnabled ? "translateX(18px)" : "translateX(0)" }}
                  />
                </button>
              </div>
              {betaEnabled && (
                <p className="text-xs text-amber-400/60 mt-2">{t("settings.betaInstallNote")}</p>
              )}
            </div>

            {/* Only the ClawBox System Update tile is exposed. OpenClaw is
                pinned by ClawBox (config/openclaw-target.txt) and travels
                with the full release, so a standalone "OpenClaw Update"
                button would just confuse customers and let them bypass
                the pin. The current OpenClaw version is still displayed
                in the version-info section above. */}
            <div className="flex gap-2">
              <button
                onClick={() => dispatchOpenApp("system_update")}
                className="flex items-center gap-3 flex-1 bg-green-500/10 rounded-xl px-4 py-3 text-sm text-green-400/80 hover:text-green-400 border border-green-500/20 hover:bg-green-500/15 transition-colors cursor-pointer text-left"
              >
                <span className="material-symbols-rounded shrink-0" style={{ fontSize: 20 }}>system_update</span>
                <div className="flex flex-col min-w-0">
                  <span>{t("settings.systemUpdate")}</span>
                  {cleanVersion(versionInfo?.clawbox.current) && (
                    <span className="text-[11px] text-green-400/60 font-mono truncate">
                      {cleanVersion(versionInfo?.clawbox.current)}
                      {versionInfo?.clawbox.target && <> → <span className="text-green-300">{cleanVersion(versionInfo.clawbox.target)}</span></>}
                    </span>
                  )}
                </div>
              </button>
            </div>

            <button
              onClick={() => setResetConfirm(true)}
              className="flex items-center gap-3 w-full bg-red-500/5 rounded-xl px-4 py-3 text-sm text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>restart_alt</span>
              {t("settings.factoryReset")}
            </button>
          </div>

          {/* Beta confirmation dialog */}
          {betaConfirm && (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-2xl p-6 max-w-sm mx-4 shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                  <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 28 }}>warning</span>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("settings.enableBeta")}</h3>
                </div>
                <div className="space-y-3 mb-6">
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                    {t("settings.betaWarning")}
                  </p>
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <p className="text-xs text-red-400 leading-relaxed">
                      {t("settings.betaDisclaimer")}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setBetaConfirm(false)}
                    className="flex-1 px-4 py-2.5 bg-white/10 hover:bg-white/15 text-[var(--text-secondary)] rounded-lg text-sm font-medium cursor-pointer transition-colors"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    onClick={confirmBeta}
                    className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
                  >
                    {t("settings.enableBetaBtn")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>)}
    </>
  );

  // ─── Section status (subtitle) shared by mobile list + desktop sidebar ───
  // SectionStatus type is declared at module scope (above component)
  const sectionStatus = (id: Section): SectionStatus => {
    switch (id) {
      case "appearance": {
        const sub = ui.wallpaperId.startsWith("custom-")
          ? `Custom ${parseInt(ui.wallpaperId.split("-")[1] || "0") + 1}`
          : ui.wallpaperId;
        return { subtitle: sub };
      }
      case "wifi":
        if (connectedSSID) return { subtitle: connectedSSID };
        if (ethernet.connected) return { subtitle: ethernet.iface ? `Ethernet (${ethernet.iface})` : "Ethernet" };
        return { subtitle: t("settings.notConnected") || "Not connected" };
      case "ai": {
        if (aiProvider === null) return { subtitle: null };
        if (!aiProvider.connected) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: aiProvider.providerLabel || (aiProvider.model ? aiProvider.model.split("/").pop() ?? null : null) };
      }
      case "localAi": {
        if (localAiStatus === null) return { subtitle: null };
        if (!localAiStatus.configured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: localAiStatus.model || localAiStatus.provider };
      }
      case "telegram": {
        if (tgConfigured === null) return { subtitle: null };
        if (!tgConfigured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: tgBotInfo?.username ? `@${tgBotInfo.username}` : (t("settings.botConnected") || "Connected") };
      }
      case "remote":
        return { subtitle: null };
      case "system":
        return { subtitle: hostname ? `${hostname}.local` : null };
      case "about":
        return { subtitle: versionInfo?.clawbox?.current ? cleanVersion(versionInfo.clawbox.current) : null };
      default:
        return { subtitle: null };
    }
  };

  // ─── Mobile layout: full-screen nav or full-screen content ───
  if (isMobile) {
    return (
      <div className="settings-pane flex flex-col h-full bg-[var(--set-surface)]">
        {mobileSection === null ? (
          /* Nav list — the same eight items, in the same order, now on one
             borderless tonal group instead of an outlined card. */
          <div className="flex-1 overflow-y-auto px-[16px] pt-[16px] pb-[24px]">
            <h2 className="text-[22px] font-medium text-[var(--set-on-surface)] px-[4px] mb-[16px]">{t("settings.title")}</h2>
            <SettingsNav
              variant="list"
              items={visibleNavItems.map(item => ({
                id: item.id,
                icon: item.icon,
                label: navLabel(item),
                subtitle: sectionStatus(item.id).subtitle,
              }))}
              // No `activeId`: the mobile list is a drill-down menu, not a
              // selected-state nav, and it never showed one. Passing it would
              // read as if the current section were marked here — and the fix
              // for that misreading (an `aria-current`) would change what the
              // mobile rows announce, which the e2e suite matches on.
              onSelect={(id) => {
                const next = id as Section;
                if (next === "remote" && requireLoginFor("remote")) return;
                setSection(next);
                setMobileSection(next);
              }}
            />
          </div>
        ) : (
          /* Content — chrome back closes window in one tap. A small "All settings"
              link at the top lets the user switch sections without leaving. */
          <>
            {/* `min-h-[44px]` is the declared minimum, and this control is the
                ONLY way back to the section list on a phone — the one branch
                driven exclusively by touch. It was ~29px (14px label × 1.5 line
                box + 4px padding). The horizontal padding grows to 8px with a
                compensating -8px margin, so the label stays optically flush
                with the 16px gutter and nothing else on the row moves; the
                wrapper's existing pt/pb absorb the height. Label, element type
                and role are untouched. */}
            <div className="px-[16px] pt-[12px] pb-[4px] shrink-0">
              <button
                onClick={() => setMobileSection(null)}
                className="flex items-center gap-1 min-h-[44px] px-[8px] -ml-[8px] py-0 text-[14px] font-medium text-[var(--set-primary)] bg-transparent border-none cursor-pointer rounded-[8px] hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                <span>{t("settings.title")}</span>
              </button>
            </div>
            {/* 16px gutter, not the desktop pane's 24px — a phone cannot
                afford it, and both are on the spacing ramp. */}
            <div className="flex-1 overflow-y-auto px-[16px] py-[20px]">
              {renderContent()}
            </div>
          </>
        )}

        {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.systemUpdate")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-4 leading-relaxed">
              {t("settings.updateDesc")}
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-[var(--text-muted)] opacity-60">{t("settings.checkingVersions")}</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">ClawBox</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">OpenClaw</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.openclaw.current ?? t("settings.notInstalled")}
                    {versionInfo.openclaw.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {/* Branch selector */}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch" className="text-xs text-[var(--text-muted)] opacity-60 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder={t("settings.main")}
                    className="flex-1 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] opacity-40 outline-none focus:border-[var(--coral-bright)]"
                  />
                  <button
                    type="button"
                    disabled={branchSaving || branchInput === (updateBranch ?? "")}
                    onClick={() => saveUpdateBranch(branchInput)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-orange-500 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {branchSaving ? "..." : "Set"}
                  </button>
                </div>
                {branchError && <p className="mt-1 text-xs text-red-400">{branchError}</p>}
                {updateBranch && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-400">{t("settings.pinnedBranch", { branch: updateBranch ?? "" })}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">{t("settings.clearBranch")}</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-[var(--text-muted)] opacity-40">{t("settings.branchHint")}</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                {t("cancel")}
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                {t("settings.update")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset confirmation modal */}
      {resetConfirm && !resetting && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.factoryResetTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5">{t("settings.factoryResetDesc")}</p>
            <div className="flex gap-3">
              <button onClick={() => setResetConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">
                {t("cancel")}
              </button>
              <button onClick={resetSetup} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-red-600 transition-colors">
                {t("settings.reset")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hotspot enable confirmation — single-radio collision warning */}
      {hotspotConfirmEnable && (
        /* z-[200] is unchanged — the ladder is deliberately unequal. The scrim
           is the palette's own ground at 72% instead of `black/60`, so it
           darkens the Hermes edition in Hermes' colour. */
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-sm px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)" }}
        >
          <div className="bg-[var(--set-surface-container-high)] rounded-[28px] p-[24px] max-w-sm w-full shadow-2xl">
            <h3 className="text-[16px] font-medium text-[var(--set-on-surface)] mb-[8px]">Enable hotspot?</h3>
            <p className="text-[14px] text-[var(--set-on-surface-variant)] mb-[20px] leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--set-on-surface)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex flex-wrap gap-[12px]">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 basis-[120px] min-h-[44px] bg-transparent text-[var(--set-on-surface)] rounded-[28px] text-[14px] font-medium cursor-pointer transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]" style={{ border: "1px solid var(--set-outline)" }}>{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 basis-[120px] min-h-[44px] bg-[var(--set-primary)] text-[var(--set-on-primary)] rounded-[28px] text-[14px] font-medium cursor-pointer border-none transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* Hostname confirmation modal */}
      {hostnameConfirm && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-sm px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)" }}
        >
          <div className="bg-[var(--set-surface-container-high)] rounded-[28px] p-[24px] max-w-sm w-full shadow-2xl">
            <h3 className="text-[16px] font-medium text-[var(--set-on-surface)] mb-[8px]">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-[14px] text-[var(--set-on-surface-variant)] mb-[12px] leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            {/* Caution, not error: the reboot is the point of the dialog. */}
            <div
              className="rounded-[12px] px-[12px] py-[10px] mb-[20px] text-[12px] leading-relaxed text-[var(--set-on-surface)]"
              style={{
                backgroundColor: "color-mix(in srgb, var(--set-warning) 10%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--set-warning) 30%, transparent)",
              }}
            >
              <div className="flex items-start gap-[8px]">
                <span className="material-symbols-rounded text-[var(--set-warning)] shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div className="min-w-0">
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-[4px] font-mono text-[var(--set-on-surface)] break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-[12px]">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 basis-[120px] min-h-[44px] bg-transparent text-[var(--set-on-surface)] rounded-[28px] text-[14px] font-medium cursor-pointer transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]" style={{ border: "1px solid var(--set-outline)" }}>
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 basis-[120px] min-h-[44px] bg-[var(--set-primary)] text-[var(--set-on-primary)] rounded-[28px] text-[14px] font-medium cursor-pointer border-none transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">
                {hostnameSaving ? t("settings.restartingDevice") : t("settings.saveAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}

        {resetOverlay}
      </div>
    );
  }

  // ─── Desktop layout: sidebar + content ───
  return (
    <div className="settings-pane h-full bg-[var(--set-surface)]">
      {/* The pane we own: everything INSIDE the ChromeWindow's title bar, which
          is not ours to touch. Two-pane grid, 216px rail + content. The grid
          lives in its own wrapper so that the fixed-position modals below stay
          siblings rather than becoming grid items. No transform / filter /
          backdrop-filter / contain / will-change anywhere on this subtree — any
          of them would create a containing block and clip the factory-reset and
          hostname-reboot overlays, which are `position: fixed` portals. */}
      <div className="grid h-full min-h-0" style={{ gridTemplateColumns: "216px 1fr" }}>
        {/* Sidebar — no panel fill of its own; the divider carries the split. */}
        <div
          className="min-h-0 overflow-hidden p-[8px]"
          style={{ borderRight: "1px solid var(--set-outline-variant)" }}
        >
          <SettingsNav
            items={visibleNavItems.map(item => ({
              id: item.id,
              icon: item.icon,
              label: navLabel(item),
              // Kept verbatim: the desktop nav's accessible name includes this
              // hidden status line, and the e2e suite matches these buttons by
              // name with no data-testid to fall back on.
              srOnly: sectionStatus(item.id).subtitle,
            }))}
            activeId={activeSection}
            onSelect={(id) => setSectionGated(id as Section)}
          />
        </div>

        {/* Content */}
        <div className="min-h-0 min-w-0 overflow-y-auto px-[24px] py-[20px]">
          <div className="mx-auto w-full max-w-3xl flex flex-col items-stretch [&>div]:mx-auto [&>div]:w-full">
            {renderContent()}
          </div>
        </div>
      </div>

      <ClawBoxLoginModal
        open={loginModal.open}
        feature={loginModal.feature}
        onClose={() => setLoginModal((m) => ({ ...m, open: false }))}
      />

      {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.systemUpdate")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-4 leading-relaxed">
              {t("settings.updateDesc")}
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-[var(--text-muted)] opacity-60">{t("settings.checkingVersions")}</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">ClawBox</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">OpenClaw</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.openclaw.current ?? t("settings.notInstalled")}
                    {versionInfo.openclaw.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch-d" className="text-xs text-[var(--text-muted)] opacity-60 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch-d"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder={t("settings.main")}
                    className="flex-1 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] opacity-40 outline-none focus:border-[var(--coral-bright)]"
                  />
                  <button
                    type="button"
                    disabled={branchSaving || branchInput === (updateBranch ?? "")}
                    onClick={() => saveUpdateBranch(branchInput)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-orange-500 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {branchSaving ? "..." : "Set"}
                  </button>
                </div>
                {branchError && <p className="mt-1 text-xs text-red-400">{branchError}</p>}
                {updateBranch && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-400">{t("settings.pinnedBranch", { branch: updateBranch ?? "" })}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">{t("settings.clearBranch")}</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-[var(--text-muted)] opacity-40">{t("settings.branchHint")}</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                {t("cancel")}
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                {t("settings.update")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset confirmation modal */}
      {resetConfirm && !resetting && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.factoryResetTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5">{t("settings.factoryResetDesc")}</p>
            <div className="flex gap-3">
              <button onClick={() => setResetConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">
                {t("cancel")}
              </button>
              <button onClick={resetSetup} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-red-600 transition-colors">
                {t("settings.reset")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hostname confirmation modal */}
      {hostnameConfirm && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-sm px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)" }}
        >
          <div className="bg-[var(--set-surface-container-high)] rounded-[28px] p-[24px] max-w-sm w-full shadow-2xl">
            <h3 className="text-[16px] font-medium text-[var(--set-on-surface)] mb-[8px]">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-[14px] text-[var(--set-on-surface-variant)] mb-[12px] leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            {/* Caution, not error: the reboot is the point of the dialog. */}
            <div
              className="rounded-[12px] px-[12px] py-[10px] mb-[20px] text-[12px] leading-relaxed text-[var(--set-on-surface)]"
              style={{
                backgroundColor: "color-mix(in srgb, var(--set-warning) 10%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--set-warning) 30%, transparent)",
              }}
            >
              <div className="flex items-start gap-[8px]">
                <span className="material-symbols-rounded text-[var(--set-warning)] shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div className="min-w-0">
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-[4px] font-mono text-[var(--set-on-surface)] break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-[12px]">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 basis-[120px] min-h-[44px] bg-transparent text-[var(--set-on-surface)] rounded-[28px] text-[14px] font-medium cursor-pointer transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]" style={{ border: "1px solid var(--set-outline)" }}>
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 basis-[120px] min-h-[44px] bg-[var(--set-primary)] text-[var(--set-on-primary)] rounded-[28px] text-[14px] font-medium cursor-pointer border-none transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">
                {hostnameSaving ? t("settings.restartingDevice") : t("settings.saveAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hotspot enable confirmation — single-radio collision warning (desktop layout) */}
      {hotspotConfirmEnable && (
        /* z-[200] is unchanged — the ladder is deliberately unequal. The scrim
           is the palette's own ground at 72% instead of `black/60`, so it
           darkens the Hermes edition in Hermes' colour. */
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-sm px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)" }}
        >
          <div className="bg-[var(--set-surface-container-high)] rounded-[28px] p-[24px] max-w-sm w-full shadow-2xl">
            <h3 className="text-[16px] font-medium text-[var(--set-on-surface)] mb-[8px]">Enable hotspot?</h3>
            <p className="text-[14px] text-[var(--set-on-surface-variant)] mb-[20px] leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--set-on-surface)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex flex-wrap gap-[12px]">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 basis-[120px] min-h-[44px] bg-transparent text-[var(--set-on-surface)] rounded-[28px] text-[14px] font-medium cursor-pointer transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]" style={{ border: "1px solid var(--set-outline)" }}>{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 basis-[120px] min-h-[44px] bg-[var(--set-primary)] text-[var(--set-on-primary)] rounded-[28px] text-[14px] font-medium cursor-pointer border-none transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* System password change confirmation */}
      {/* Still `z-[300]`, still desktop-only, still `role="alertdialog"` with
          the same `aria-labelledby`, the same cancel ref and the same focus /
          Escape / focus-restore effect. Only the colours move onto `--set-*`
          roles and the two buttons grow to the 44px minimum. The scrim keeps
          its `backdrop-blur-sm`: it is a fixed SIBLING, never an ancestor of
          the portalled factory-reset / hostname-reboot overlays. */}
      {sysPasswordConfirmOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="sys-pw-confirm-title" className="w-full max-w-sm rounded-[28px] bg-[var(--set-surface-container-high)] p-[24px] shadow-2xl">
            <div className="mb-[12px] flex items-center gap-[8px]">
              <span className="material-symbols-rounded text-[var(--set-warning)]" style={{ fontSize: 22 }}>warning</span>
              <h3 id="sys-pw-confirm-title" className="text-[18px] font-bold text-[var(--set-on-surface)]">Write this password down</h3>
            </div>
            <p className="mb-[12px] text-[14px] leading-relaxed text-[var(--set-on-surface-variant)]">
              This will change your password for <span className="font-medium text-[var(--set-on-surface)]">web sign-in, SSH, and sudo</span>. If you forget it, you may be locked out of the device entirely and need a factory reset to recover.
            </p>
            <div
              className="mb-[20px] rounded-[12px] px-[12px] py-[12px]"
              style={{
                backgroundColor: "color-mix(in srgb, var(--set-warning) 8%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--set-warning) 30%, transparent)",
              }}
            >
              <div className="mb-[4px] flex flex-wrap items-center justify-between gap-[8px]">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--set-warning)]">New password</span>
                {/* Same handler, same two `aria-label`s — the box is now 44px. */}
                <button type="button" onClick={() => setSysPasswordConfirmReveal(v => !v)} className="-mr-[8px] flex min-h-[44px] cursor-pointer items-center gap-[6px] rounded-[28px] border-none bg-transparent px-[8px] text-[12px] font-medium text-[var(--set-warning)] transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]" aria-label={sysPasswordConfirmReveal ? "Hide password" : "Reveal password"}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysPasswordConfirmReveal ? "visibility_off" : "visibility"}</span>
                  {sysPasswordConfirmReveal ? "Hide" : "Reveal"}
                </button>
              </div>
              <div className="min-h-[1.25rem] break-all font-mono text-[14px] text-[var(--set-on-surface)]">
                {sysPasswordConfirmReveal ? sysPassword : "••••••••"}
              </div>
            </div>
            <div className="flex flex-wrap gap-[12px]">
              <button ref={sysPasswordConfirmCancelRef} disabled={sysPasswordSaving} onClick={() => setSysPasswordConfirmOpen(false)} className="min-h-[44px] flex-1 cursor-pointer rounded-[28px] border-none bg-[var(--set-secondary-container)] px-[16px] text-[14px] font-medium text-[var(--set-on-secondary-container)] transition-colors hover:bg-[var(--set-surface-container-highest)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">{t("cancel")}</button>
              <button disabled={sysPasswordSaving} onClick={() => { setSysPasswordConfirmOpen(false); void saveSystemPassword(); }} className="min-h-[44px] flex-1 cursor-pointer rounded-[28px] border-none bg-[var(--set-primary)] px-[16px] text-[14px] font-medium text-[var(--set-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]">
                {sysPasswordSaving ? "Saving…" : "I’ve written it down — change"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* System Update full-screen overlay (portal to escape window stacking context) */}
      {hostnameRebootTo && typeof document !== "undefined" && createPortal(
        // `settings-pane` = the `--set-*` role layer and nothing else; this root
        // is portalled to `document.body`, outside `desktop-root`, so it is the
        // only way an edition reaches this overlay. See globals.css.
        <div role="alertdialog" aria-modal="true" aria-live="assertive" aria-labelledby="hostname-reboot-title" className="settings-pane fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "var(--set-surface)" }}>
          <div className="flex flex-col items-center gap-6 max-w-md text-center px-6">
            <div className="relative w-20 h-20" aria-hidden="true">
              <div className="absolute inset-0 rounded-full border-2 border-[#fe6e00]/20 animate-pulse" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#fe6e00] animate-spin" />
            </div>
            <div className="space-y-2">
              <h2 id="hostname-reboot-title" className="text-xl font-semibold text-white">Restarting device…</h2>
              <p className="text-sm text-white/60 leading-relaxed">
                The Jetson is rebooting with its new name.<br/>You&apos;ll be redirected automatically when it&apos;s back online.
              </p>
            </div>
            <a href={hostnameRebootTo} className="text-xs text-[#fe6e00] hover:text-[#ff8b1a] font-mono underline-offset-2 hover:underline break-all">
              {hostnameRebootTo}
            </a>
            <p className="text-[11px] text-white/30">
              This usually takes 30–60 seconds. If your browser doesn&apos;t redirect, click the link above.
            </p>
          </div>
        </div>,
        document.body,
      )}

      {updateStarted && typeof document !== "undefined" && createPortal(
        // `settings-pane` = the `--set-*` role layer and nothing else; this root
        // is portalled to `document.body`, outside `desktop-root`, so it is the
        // only way an edition reaches this overlay. See globals.css.
        <div className="settings-pane fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "var(--set-surface)" }}>
          <style>{`
            @keyframes update-pulse { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 0.15; transform: scale(1.3); } }
            @keyframes update-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
          `}</style>
          <div className="flex flex-col items-center gap-8 max-w-md w-full text-center px-6">
            {/* Mascot with animated ring */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* Pulse rings */}
              {!(updateError || updateState?.phase === "failed") && updateState?.phase !== "completed" && (
                <>
                  <div className="absolute inset-0 rounded-full border-2 border-[#f97316]/20" style={{ animation: "update-pulse 2.5s ease-in-out infinite" }} />
                  <div className="absolute inset-3 rounded-full border border-[#f97316]/10" style={{ animation: "update-pulse 2.5s ease-in-out infinite 0.5s" }} />
                </>
              )}
              {/* Completed ring */}
              {updateState?.phase === "completed" && (
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30" />
              )}
              {/* Error ring */}
              {(updateError || updateState?.phase === "failed") && (
                <div className="absolute inset-0 rounded-full border-2 border-red-500/30" />
              )}
              {/* Logo — matches the welcome screen in the setup wizard */}
              <img
                src="/clawbox-crab.png"
                alt="ClawBox"
                className="w-24 h-24 object-contain relative z-10"
                style={updateState?.phase === "completed" || updateError || updateState?.phase === "failed" ? {} : { animation: "update-float 3s ease-in-out infinite" }}
              />
            </div>

            <div>
              <h2 className="text-2xl font-bold text-white mb-2">
                {updateState?.phase === "completed" ? t("settings.updateComplete") : updateError || updateState?.phase === "failed" ? t("settings.updateFailed") : t("settings.updating")}
              </h2>
              <p className="text-sm text-white/40">
                {updateState?.phase === "completed"
                  ? (updateState.steps.some(s => s.id === RESTART_STEP_ID) ? t("settings.restartingDevice") : t("settings.updateDone"))
                  : updateError || updateState?.phase === "failed" ? "" : "Please don\u2019t turn off your device"}
              </p>
            </div>

            {updateState && updateState.steps.length > 0 && (
              <div className="w-full max-w-xs space-y-3 text-left bg-white/[0.03] rounded-2xl p-4 border border-white/[0.06]">
                {updateState.steps.map((step) => (
                  <div key={step.id} className="flex items-center gap-3 text-sm">
                    {step.status === "completed" ? (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12l5 5L19 7" /></svg>
                      </span>
                    ) : step.status === "running" ? (
                      <span className="flex items-center justify-center w-5 h-5 shrink-0">
                        <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" />
                      </span>
                    ) : step.status === "failed" ? (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20 text-red-400 shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.04] shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
                      </span>
                    )}
                    <span className={step.status === "running" ? "text-white font-medium" : step.status === "completed" ? "text-emerald-400/70" : step.status === "failed" ? "text-red-400" : "text-white/25"}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!updateState && !updateError && (
              <div className="flex items-center gap-2 text-sm text-white/40">
                <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" />
                Connecting...
              </div>
            )}
            {(updateError || updateState?.phase === "failed") && (
              <div className="space-y-4">
                <p className="text-sm text-red-400/80">{updateError || updateState?.error || "An error occurred during update"}</p>
                {updateState?.steps.some((step) => step.status === "failed") && (
                  <div className="w-full max-w-xs space-y-2 text-left">
                    {updateState.steps
                      .filter((step) => step.status === "failed")
                      .map((step) => (
                        <div
                          key={`${step.id}-error`}
                          className="rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-300/90"
                        >
                          <span className="font-semibold text-red-300">{step.label}:</span>{" "}
                          {step.error || t("unknownError")}
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={() => { setUpdateStarted(false); setUpdateError(null); setUpdateState(null); stopUpdatePolling(); }}
                  className="px-6 py-2.5 bg-white/10 text-white rounded-xl text-sm font-medium cursor-pointer hover:bg-white/15 transition-colors border-none"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {resetOverlay}
    </div>
  );
}

/**
 * Remote Control's signed-out gate. One of the four roots `renderRemoteSection`
 * can drop straight into the pane, so it keeps its own `max-w-xl` wrapper and
 * stays a single direct child — the desktop shell centres direct children only.
 *
 * The bordered `--surface-card` box is now a borderless tonal `SettingsGroup`,
 * and the last colour literal in here (`rgba(249,115,22,.5)`, which was coral by
 * value) is spelled as `--set-primary` so the glow follows the palette.
 */
function RemoteLoginPlaceholder({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="max-w-xl">
      <SettingsGroup divided={false}>
        <div className="flex flex-col items-center gap-[16px] px-[16px] py-[24px] text-center">
          <img
            src="/clawbox-crab.png"
            alt=""
            width={64}
            height={64}
            className="select-none pointer-events-none"
            style={{ filter: "drop-shadow(0 0 12px color-mix(in srgb, var(--set-primary) 50%, transparent))" }}
          />
          <div>
            <h3 className="mb-[4px] text-[16px] font-medium leading-[1.3] text-[var(--set-on-surface)]">Sign in to use Remote Control</h3>
            <p className="text-[14px] leading-[1.5] text-[var(--set-on-surface-variant)]">
              Remote Control needs your ClawBox account so the portal can publish a secure tunnel back to this device.
            </p>
          </div>
          <button
            type="button"
            onClick={onSignIn}
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-[8px] rounded-[22px] border-none bg-[var(--set-primary)] px-[24px] text-[14px] font-medium leading-[1.2] text-[var(--set-on-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--set-on-primary)_8%,var(--set-primary))] active:bg-[color-mix(in_srgb,var(--set-on-primary)_12%,var(--set-primary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
            Open ClawBox Portal
          </button>
        </div>
      </SettingsGroup>
    </div>
  );
}
