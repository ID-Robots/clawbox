"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import StatusMessage from "./StatusMessage";
import SignalBars from "./SignalBars";
import AIProviderIcon from "./AIProviderIcon";
import type { WifiNetwork } from "@/lib/wifi-utils";
import { signalToLevel, dbmToLevel } from "@/lib/wifi-utils";
import AIModelsStep from "./AIModelsStep";
import { I18nProvider, useT, LANGUAGES, type Locale } from "@/lib/i18n";
import { QRCodeSVG } from "qrcode.react";
import type { UpdateState } from "@/lib/updater";
import { cleanVersion } from "@/lib/version-utils";

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


const SECTIONS = ["appearance", "wifi", "ai", "localAi", "telegram", "system", "about"] as const;

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
  { id: "system", icon: "monitor_heart", labelKey: "settings.system" },
  { id: "about", icon: "info", labelKey: "settings.about" },
];

/* ── Helpers ── */
function formatBytes(b: number): string {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + u[i];
}

function barColor(pct: number): string {
  return pct >= 90 ? "#ef4444" : pct >= 70 ? "#f97316" : pct >= 50 ? "#eab308" : "#06b6d4";
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-[var(--text-primary)]">{label}</span>
      <button
        onClick={() => onToggle(!on)}
        className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${on ? "bg-orange-500" : "bg-white/15"}`}
      >
        <span
          className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
          style={{ left: 2, transform: on ? "translateX(18px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}

type SectionStatus = { subtitle: string | null; dot: "ok" | "warn" | null };

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
  // Mobile: null means show nav list, a section means show content with back button
  const [mobileSection, setMobileSection] = useState<Section | null>(null);

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
    const w = window as Window & {
      __clawboxPendingSettingsSection?: unknown;
      __clawboxPendingClawAiOffer?: unknown;
    };
    if (w.__clawboxPendingSettingsSection !== undefined) {
      apply(w.__clawboxPendingSettingsSection);
      delete w.__clawboxPendingSettingsSection;
    }
    if (w.__clawboxPendingClawAiOffer) {
      requestClawAiOffer();
      delete w.__clawboxPendingClawAiOffer;
    }
    const handler = (event: Event) =>
      apply((event as CustomEvent<{ section?: string }>).detail?.section);
    const offerHandler = () => requestClawAiOffer();
    window.addEventListener("clawbox:open-settings-section", handler);
    window.addEventListener("clawbox:open-clawai-offer", offerHandler);
    return () => {
      window.removeEventListener("clawbox:open-settings-section", handler);
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
  const [versionInfo, setVersionInfo] = useState<{ clawbox: { current: string; target: string | null }; openclaw: { current: string | null; target: string | null } } | null>(null);
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

  // Auto-dismiss the update overlay for OpenClaw-only updates (no device restart).
  useEffect(() => {
    if (updateState?.phase !== "completed") return;
    const isFullUpdate = updateState.steps.some(s => s.id === "restart");
    if (isFullUpdate) return;
    const timer = setTimeout(() => {
      setUpdateStarted(false);
      setUpdateError(null);
      setUpdateState(null);
      stopUpdatePolling();
    }, 3000);
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

  /* ── Local URL (mDNS hostname) ── */
  const [hostname, setHostname] = useState<string>("");
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
  useEffect(() => {
    if (!hostnameRebootTo) return;
    let cancelled = false;
    const redirect = () => { if (!cancelled) window.location.replace(hostnameRebootTo); };
    const probe = async () => {
      if (cancelled) return;
      try {
        // no-cors: response is opaque so we can't inspect status. Any
        // fulfilled fetch means TCP+HTTP completed, which is enough signal
        // that the device is back — redirect deliberately on any success.
        await fetch(`${hostnameRebootTo}setup-api/setup/status`, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: AbortSignal.timeout(REBOOT_PROBE_TIMEOUT_MS),
        });
        redirect();
        return;
      } catch { /* not back yet */ }
      if (!cancelled) setTimeout(probe, REBOOT_PROBE_INTERVAL_MS);
    };
    const probeStart = setTimeout(probe, REBOOT_PROBE_GRACE_MS);
    const hardRedirect = setTimeout(redirect, REBOOT_HARD_REDIRECT_MS);
    return () => { cancelled = true; clearTimeout(probeStart); clearTimeout(hardRedirect); };
  }, [hostnameRebootTo]);
  const [currentHost, setCurrentHost] = useState<string>("");
  useEffect(() => { if (typeof window !== "undefined") setCurrentHost(window.location.hostname); }, []);
  const accessedByIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(currentHost) || currentHost === "localhost";
  const localUrl = hostname ? `${hostname}.local` : "";
  const fullLocalUrl = localUrl ? `${typeof window !== "undefined" ? window.location.protocol : "http:"}//${localUrl}${typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : ""}` : "";
  const [copiedLocalUrl, setCopiedLocalUrl] = useState(false);
  const copyLocalUrl = async () => {
    if (!fullLocalUrl) return;
    try { await navigator.clipboard.writeText(fullLocalUrl); setCopiedLocalUrl(true); setTimeout(() => setCopiedLocalUrl(false), 1500); } catch { /* clipboard blocked */ }
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
  const [aiProvider, setAiProvider] = useState<{ connected: boolean; provider: string | null; providerLabel: string | null; mode: string | null; model: string | null } | null>(null);
  useEffect(() => {
    if (section !== "ai" && !isMobile) return;
    fetch("/setup-api/ai-models/status", { cache: "no-store" }).then(r => r.json()).then(setAiProvider).catch(() => {});
  }, [section, isMobile]);
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

  /* ── Telegram ── */
  const [tgToken, setTgToken] = useState("");
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgStatus, setTgStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [tgBotInfo, setTgBotInfo] = useState<{ username?: string; firstName?: string; link?: string } | null>(null);
  const [tgReconfigure, setTgReconfigure] = useState(false);
  const tgSaveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (section !== "telegram" && !isMobile) return;
    fetch("/setup-api/telegram/status").then(r => r.json()).then(d => {
      setTgConfigured(d.configured ?? false);
      if (d.configured && d.username) {
        setTgBotInfo({ username: d.username, firstName: d.firstName, link: d.link });
      } else {
        setTgBotInfo(null);
      }
    }).catch(() => setTgConfigured(false));
  }, [section, isMobile]);

  const saveTelegram = async () => {
    if (!tgToken.trim()) {
      setTgStatus({ type: "error", message: t("settings.enterToken") });
      return;
    }
    tgSaveControllerRef.current?.abort();
    const controller = new AbortController();
    tgSaveControllerRef.current = controller;
    setTgSaving(true);
    setTgStatus(null);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: tgToken.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setTgStatus({ type: "success", message: t("settings.telegramConfigured") });
        setTgConfigured(true);
        setTgReconfigure(false);
        setTgToken("");
      } else {
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
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
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 2147483647, background: "rgba(13, 17, 23, 1)" }}
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

            {/* Wallpaper card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>wallpaper</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.wallpaper")}</label>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {ui.wallpapers.map(wp => {
                  const selected = ui.wallpaperId === wp.id;
                  return (
                    <button
                      key={wp.id}
                      onClick={() => ui.onWallpaperChange(wp.id)}
                      className={`relative rounded-xl overflow-hidden aspect-video transition-all cursor-pointer border-none p-0 group ${
                        selected ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117] scale-[1.02]" : "hover:scale-[1.02] hover:ring-1 hover:ring-white/20 hover:ring-offset-1 hover:ring-offset-[#0d1117]"
                      }`}
                    >
                      {wp.image ? (
                        <img src={wp.image} alt={wp.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-950" />
                      )}
                      <div className={`absolute inset-0 transition-colors ${selected ? "bg-orange-400/10" : "bg-black/0 group-hover:bg-white/5"}`} />
                      <span className={`absolute bottom-0 inset-x-0 text-[10px] py-1.5 text-center font-medium backdrop-blur-md ${
                        selected ? "bg-orange-500/70 text-white" : "bg-black/50 text-white/70"
                      }`}>{wp.name}</span>
                      {selected && (
                        <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
                          <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }}>check</span>
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
                      className={`relative rounded-xl overflow-hidden aspect-video transition-all cursor-pointer border-none p-0 group ${
                        selected ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117] scale-[1.02]" : "hover:scale-[1.02]"
                      }`}
                    >
                      <img src={dataUrl} alt={`Custom ${i + 1}`} className="w-full h-full object-cover" />
                      {selected && (
                        <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
                          <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }}>check</span>
                        </span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); ui.onCustomWallpaperDelete(i); }}
                        className="absolute top-1.5 left-1.5 w-5 h-5 bg-red-500/90 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer border-none shadow-lg"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
                      </button>
                      <span className={`absolute bottom-0 inset-x-0 text-[10px] py-1.5 text-center font-medium backdrop-blur-md ${
                        selected ? "bg-orange-500/70 text-white" : "bg-black/50 text-white/70"
                      }`}>Custom {i + 1}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => ui.onWallpaperUpload()}
                  className="rounded-xl aspect-video border-2 border-dashed border-[var(--border-subtle)] hover:border-orange-400/40 hover:bg-orange-500/5 flex flex-col items-center justify-center gap-1.5 text-[var(--text-muted)] opacity-60 hover:text-[var(--coral-bright)]/70 transition-all cursor-pointer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 24 }}>add_photo_alternate</span>
                  <span className="text-[10px] font-medium">{t("settings.upload")}</span>
                </button>
              </div>
            </div>

            {/* Display Settings card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 space-y-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>tune</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.display")}</label>
              </div>

              {/* Fit mode */}
              <div>
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.fitMode")}</label>
                <div className="flex gap-1 bg-white/[0.04] rounded-xl p-1">
                  {(["fill", "fit", "center"] as const).map(mode => {
                    const icons = { fill: "zoom_out_map", fit: "fit_screen", center: "center_focus_strong" };
                    return (
                      <button
                        key={mode}
                        onClick={() => ui.onWpFitChange(mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer border-none capitalize ${
                          ui.wpFit === mode ? "bg-orange-500/15 text-[var(--coral-bright)] shadow-sm" : "text-white/35 hover:text-[var(--text-secondary)] hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icons[mode]}</span>
                        {t(`settings.${mode}`)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Opacity */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-medium text-white/35 uppercase tracking-wider">{t("settings.opacity")}</label>
                  <span className="text-xs font-mono text-[var(--coral-bright)]/80 bg-orange-500/10 px-2 py-0.5 rounded-md">{ui.wpOpacity}%</span>
                </div>
                <div className="relative h-6 flex items-center">
                  <input
                    type="range" min={0} max={100} value={ui.wpOpacity}
                    onChange={e => ui.onWpOpacityChange(parseInt(e.target.value, 10))}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#fe6e00] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#0d1117] [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(254,110,0,0.3),0_2px_6px_rgba(0,0,0,0.3)] [&::-webkit-slider-thumb]:cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #fe6e00 0%, #fe6e00 ${ui.wpOpacity}%, rgba(255,255,255,0.08) ${ui.wpOpacity}%, rgba(255,255,255,0.08) 100%)`,
                    }}
                  />
                </div>
              </div>

              {/* Background color */}
              <div>
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.bgColor")}</label>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      type="color" value={ui.wpBgColor}
                      onChange={e => ui.onWpBgColorChange(e.target.value)}
                      className="w-10 h-10 rounded-xl cursor-pointer border-2 border-[var(--border-subtle)] hover:border-white/20 transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-3 py-2">
                    <span className="text-xs text-[var(--text-muted)] font-mono tracking-wide">{ui.wpBgColor}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Extras card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>auto_awesome</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.extras")}</label>
              </div>
              <Toggle on={!ui.mascotHidden} onToggle={v => {
                const hidden = !v;
                ui.onMascotToggle(hidden);
                window.dispatchEvent(new Event(hidden ? "clawbox-hide-mascot" : "clawbox-show-mascot"));
              }} label={t("settings.showMascot")} />
            </div>

            {/* Language card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>translate</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.language")}</label>
              </div>
              <div className="relative" ref={langRef}>
                <button
                  type="button"
                  onClick={() => setLangOpen(v => !v)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg text-sm text-[var(--text-primary)] hover:border-white/20 transition-colors cursor-pointer"
                >
                  <span className="text-base leading-none">{currentLang.flag}</span>
                  <span className="flex-1 text-left">{currentLang.label}</span>
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }}>
                    {langOpen ? "expand_less" : "expand_more"}
                  </span>
                </button>
                {langOpen && (
                  <div className="absolute z-50 mt-1 w-full bg-[#1a1f2e] border border-white/10 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                    {LANGUAGES.map(lang => (
                      <button
                        key={lang.code}
                        type="button"
                        onClick={() => { setLocale(lang.code as Locale); setLangOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm transition-colors cursor-pointer border-none ${
                          lang.code === locale
                            ? "bg-orange-500/15 text-[var(--coral-bright)]"
                            : "text-white/70 hover:bg-white/[0.06]"
                        }`}
                      >
                        <span className="text-base leading-none">{lang.flag}</span>
                        <span className="flex-1 text-left">{lang.label}</span>
                        {lang.code === locale && (
                          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }}>check</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── Network ─── */}
        {activeSection === "wifi" && (
          <div className="max-w-xl space-y-5">

            {/* Connection status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>wifi</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {connectedSSID ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>wifi</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium truncate">{connectedSSID}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">WiFi · {t("settings.connected")}</span>
                      {wifiQuality.signalDbm !== null && (
                        <span className="text-[10px] text-white/45">· {dbmToLevel(wifiQuality.signalDbm)} bars · {wifiQuality.signalDbm} dBm</span>
                      )}
                      {wifiQuality.bitrateMbps !== null && (
                        <span className="text-[10px] text-white/45">· {Math.round(wifiQuality.bitrateMbps)} Mbps</span>
                      )}
                      {wifiQuality.pingMs !== null && (
                        <span className="text-[10px] text-white/45">· {wifiQuality.pingMs}ms gw</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : ethernet.connected ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>settings_ethernet</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium truncate">Ethernet{ethernet.iface ? ` (${ethernet.iface})` : ""}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">Wired · {t("settings.connected")}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>wifi_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.noWifiConnection")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.connectToNetwork")}</div>
                  </div>
                </div>
              )}

              {localUrl && (
                <div className={`mt-4 rounded-xl border px-4 py-3 ${accessedByIp ? "border-amber-400/30 bg-amber-400/[0.08]" : "border-white/[0.06] bg-white/[0.03]"}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`material-symbols-rounded ${accessedByIp ? "text-amber-300" : "text-[var(--coral-bright)]"}`} style={{ fontSize: 16 }}>{accessedByIp ? "warning" : "link"}</span>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Access this device at</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <a href={fullLocalUrl} className="flex-1 min-w-0 text-sm font-mono text-[var(--text-primary)] hover:text-[var(--coral-bright)] truncate underline-offset-2 hover:underline">{localUrl}</a>
                    <button
                      onClick={copyLocalUrl}
                      className="px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors flex items-center gap-1"
                      title="Copy URL"
                      aria-label={copiedLocalUrl ? "URL copied" : "Copy URL"}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{copiedLocalUrl ? "check" : "content_copy"}</span>
                      {copiedLocalUrl ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <span className="sr-only" aria-live="polite">{copiedLocalUrl ? "URL copied to clipboard" : ""}</span>
                  {accessedByIp && (
                    <p className="text-[11px] text-amber-100/85 mt-2 leading-relaxed">
                      You&apos;re currently visiting this device by IP address ({currentHost}). The IP changes when WiFi and Ethernet swap, which can drop your session. Use <span className="font-mono">{localUrl}</span> instead so the URL stays the same on either connection.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Hotspot toggle card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${hotspotEnabled && hotspotActive === false ? "bg-amber-400/15" : hotspotEnabled ? "bg-orange-500/15" : "bg-white/5"}`}>
                    <span className={`material-symbols-rounded ${hotspotEnabled && hotspotActive === false ? "text-amber-300" : hotspotEnabled ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)] opacity-50"}`} style={{ fontSize: 22 }}>wifi_tethering</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.hotspot")}</div>
                    <div className="text-xs text-white/35 mt-0.5">
                      {hotspotSSID}
                      {hotspotEnabled && hotspotActive === false && <span className="ml-2 text-amber-300/90">• not broadcasting</span>}
                      {hotspotEnabled && hotspotActive === true && <span className="ml-2 text-emerald-300/80">• broadcasting</span>}
                    </div>
                  </div>
                </div>
                <button
                  onClick={toggleHotspot}
                  disabled={hotspotEnabled === null || hotspotToggling}
                  className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer border-none ${hotspotEnabled ? "bg-[#fe6e00]" : "bg-white/10"} ${hotspotToggling ? "opacity-50" : ""}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${hotspotEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
              {hotspotEnabled && hotspotActive !== false && (
                <p className="text-[11px] text-[var(--text-muted)] opacity-50 mt-3 leading-relaxed">
                  {t("settings.hotspotDesc", { ssid: hotspotSSID })}
                </p>
              )}
              {hotspotEnabled && hotspotActive === false && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
                  <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 18 }}>warning</span>
                  <div className="text-[11px] text-amber-100/90 leading-relaxed">
                    Hotspot is not broadcasting{hotspotBlockedBy ? ` because this device is connected to "${hotspotBlockedBy}" over WiFi` : ""}.
                    The Jetson has a single WiFi radio, so the hotspot can only run when WiFi is disconnected or the device is on Ethernet.
                    Saved settings will apply automatically the next time the AP starts.
                  </div>
                </div>
              )}
              {hotspotEnabled && (
                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest block mb-2">
                    {t("settings.hotspot")} name
                  </label>
                  <div className="flex items-stretch gap-2 mb-4">
                    <input
                      type="text"
                      value={hotspotSSIDInput}
                      onChange={e => { setHotspotSSIDInput(e.target.value); setHotspotSSIDStatus(null); }}
                      maxLength={32}
                      placeholder="ClawBox-Setup"
                      className="flex-1 min-w-0 px-3.5 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none placeholder-white/15 focus:border-orange-400/60 focus:bg-white/[0.06] transition-all"
                    />
                    <button
                      onClick={saveHotspotSSID}
                      disabled={hotspotSSIDSaving || !hotspotSSIDInput.trim() || hotspotSSIDInput.trim() === hotspotSSID}
                      className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                  {hotspotSSIDStatus && <div className="mb-4"><StatusMessage type={hotspotSSIDStatus.type} message={hotspotSSIDStatus.message} /></div>}
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest block mb-2">
                    {t("credentials.hotspotPassword")}
                  </label>
                  <div className="flex items-stretch gap-2">
                    <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-xl overflow-hidden focus-within:border-orange-400/60 focus-within:bg-white/[0.06] transition-all">
                      <input
                        type={hotspotPasswordShow ? "text" : "password"}
                        value={hotspotPassword}
                        onChange={e => { setHotspotPassword(e.target.value); setHotspotPasswordStatus(null); }}
                        placeholder={hotspotHasPassword ? "••••••••" : "At least 8 characters"}
                        maxLength={63}
                        className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/15"
                      />
                      <button
                        type="button"
                        onClick={() => setHotspotPasswordShow(v => !v)}
                        className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
                        aria-label={hotspotPasswordShow ? "Hide password" : "Show password"}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{hotspotPasswordShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    <button
                      onClick={saveHotspotPassword}
                      disabled={hotspotPasswordSaving || hotspotPassword.length < 8}
                      className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                  {hotspotPasswordStatus && <div className="mt-3"><StatusMessage type={hotspotPasswordStatus.type} message={hotspotPasswordStatus.message} /></div>}
                </div>
              )}
            </div>

            {/* Local URL (mDNS hostname) card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>link</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.localUrl")}</label>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-3 leading-relaxed">{t("settings.localUrlDesc")}</p>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-xl overflow-hidden focus-within:border-orange-400/60 focus-within:bg-white/[0.06] transition-all">
                  <input
                    type="text"
                    value={hostnameInput}
                    onChange={e => { setHostnameInput(e.target.value); setHostnameStatus(null); }}
                    maxLength={63}
                    placeholder="clawbox"
                    className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/15"
                  />
                  <span className="px-3 text-sm text-[var(--text-muted)] opacity-60 select-none">.local</span>
                </div>
                <button
                  onClick={() => setHostnameConfirm(true)}
                  disabled={hostnameSaving || !hostnameInput.trim() || hostnameInput.trim().toLowerCase().replace(/\.local$/, "") === hostname}
                  className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                >
                  {t("settings.save")}
                </button>
              </div>
              {hostnameStatus && <div className="mt-3"><StatusMessage type={hostnameStatus.type} message={hostnameStatus.message} /></div>}
            </div>

            {/* Saved networks card */}
            {savedNetworks.length > 0 && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>bookmark</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">Saved Networks</label>
                </div>
                <div className="space-y-2">
                  {savedNetworks.map(net => {
                    const isActive = !!net.device;
                    const isEditing = savedEditing === net.name;
                    return (
                      <div key={net.name} className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
                        <div className="flex items-center gap-3 px-4 py-3">
                          <span className={`material-symbols-rounded ${isActive ? "text-green-400" : "text-[var(--text-muted)] opacity-60"}`} style={{ fontSize: 20 }}>{isActive ? "wifi" : "wifi_password"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-[var(--text-primary)] font-medium truncate">{net.name}</div>
                            {isActive && <div className="text-[10px] text-green-400/80 mt-0.5">Connected</div>}
                          </div>
                          <button onClick={() => { setSavedEditing(isEditing ? null : net.name); setSavedNewPassword(""); setSavedStatus(null); }} disabled={savedBusy === net.name} className="px-2 py-1 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors disabled:opacity-50" title="Edit password" aria-label={`Edit password for ${net.name}`}>
                            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{isEditing ? "close" : "edit"}</span>
                          </button>
                          <button onClick={() => forgetSavedNetwork(net.name)} disabled={savedBusy === net.name} className="px-2 py-1 bg-white/[0.06] hover:bg-red-500/30 text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors disabled:opacity-50" title="Forget" aria-label={`Forget ${net.name}`}>
                            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span>
                          </button>
                        </div>
                        {isEditing && (
                          <div className="px-4 pb-3 pt-1 border-t border-white/[0.04]">
                            <div className="flex items-stretch gap-2 mt-2">
                              <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                                <input type={savedShowPassword ? "text" : "password"} value={savedNewPassword} onChange={e => { setSavedNewPassword(e.target.value); setSavedStatus(null); }} placeholder="New password" maxLength={63} className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20" />
                                <button type="button" onClick={() => setSavedShowPassword(v => !v)} className="px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer">
                                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{savedShowPassword ? "visibility_off" : "visibility"}</span>
                                </button>
                              </div>
                              <button onClick={() => updateSavedPassword(net.name)} disabled={savedBusy === net.name || savedNewPassword.length < 8} className="px-3 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-xs font-semibold cursor-pointer border-none">Save</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {savedStatus && <div className="mt-3"><StatusMessage type={savedStatus.type} message={savedStatus.message} /></div>}
              </div>
            )}

            {/* Connect to network card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>add_circle</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.connectToNetworkBtn")}</label>
              </div>

              {/* Network list */}
              {wifiNetworks === null && !ssid && (
                <button
                  onClick={scanWifiNetworks}
                  disabled={wifiScanning}
                  className="w-full py-2.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[var(--text-primary)] rounded-xl text-sm font-medium cursor-pointer transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {wifiScanning ? (
                    <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span> {t("settings.scanning")}</>
                  ) : (
                    <><span className="material-symbols-rounded" style={{ fontSize: 16 }}>wifi_find</span> {t("settings.availableNetworks")}</>
                  )}
                </button>
              )}

              {wifiNetworks !== null && !ssid && (
                <>
                  <div className="border border-white/[0.08] rounded-xl overflow-hidden mb-3">
                    <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.availableNetworks")}</span>
                      <button
                        onClick={scanWifiNetworks}
                        disabled={wifiScanning}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5 disabled:opacity-50 transition-colors"
                      >
                        <span className={`material-symbols-rounded ${wifiScanning ? "animate-spin" : ""}`} style={{ fontSize: 14 }}>refresh</span>
                        {wifiScanning ? t("settings.scanning") : t("wifi.refresh")}
                      </button>
                    </div>
                    {wifiNetworks.length > 0 ? (
                      <div className="max-h-[200px] overflow-y-auto">
                        {wifiNetworks.map((net) => (
                          <button
                            key={net.ssid}
                            onClick={() => selectNetwork(net)}
                            className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left bg-transparent border-none cursor-pointer hover:bg-white/[0.04] transition-colors"
                          >
                            <SignalBars level={signalToLevel(net.signal)} />
                            <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{net.ssid}</span>
                            {net.security && net.security !== "--" && (
                              <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40" style={{ fontSize: 14 }}>lock</span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--text-muted)] px-3.5 py-3">{t("settings.noNetworks")}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setShowManualWifi(true)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left bg-transparent border border-white/[0.08] rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40" style={{ fontSize: 16 }}>edit</span>
                    <span className="text-sm text-[var(--text-secondary)]">{t("settings.otherNetwork")}</span>
                  </button>
                </>
              )}

              {/* Connect form (shown after selecting a network or manual entry) */}
              {(ssid !== "" || showManualWifi) && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.networkName")}</label>
                    <div className="relative">
                      <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>router</span>
                      <input
                        type="text" value={ssid} onChange={e => setSsid(e.target.value)}
                        placeholder={t("settings.enterNetworkName")}
                        readOnly={!showManualWifi && wifiNetworks !== null}
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.password")}</label>
                    <div className="relative">
                      <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>lock</span>
                      <input
                        type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)}
                        placeholder={t("settings.enterPassword")}
                        autoFocus
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                        onKeyDown={e => e.key === "Enter" && connectWifi()}
                      />
                    </div>
                  </div>
                  {/* Hotspot warning */}
                  <div className="flex items-start gap-2.5 bg-amber-500/[0.07] border border-amber-500/15 rounded-xl px-3.5 py-3">
                    <span className="material-symbols-rounded text-amber-400 shrink-0 mt-0.5" style={{ fontSize: 16 }}>warning</span>
                    <p className="text-xs text-amber-300/70 leading-relaxed">
                      {t("settings.wifiWarning")}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={connectWifi}
                      disabled={wifiConnecting || !ssid.trim()}
                      className="flex-1 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                    >
                      {wifiConnecting ? (
                        <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span> {t("connecting")}</>
                      ) : (
                        <><span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span> {t("settings.connect")}</>
                      )}
                    </button>
                    <button
                      onClick={() => { setSsid(""); setWifiPass(""); setWifiStatus(null); setShowManualWifi(false); }}
                      className="py-2.5 px-4 bg-transparent border border-white/[0.08] text-[var(--text-secondary)] rounded-xl text-sm cursor-pointer hover:bg-white/[0.04] transition-all"
                    >
                      {t("settings.back")}
                    </button>
                  </div>
                  {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
                </div>
              )}
            </div>

          </div>
        )}

        {/* ─── AI Provider ─── */}
        {activeSection === "ai" && (
          <div className="max-w-xl space-y-5">

            {/* Provider status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {aiProvider === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-32 rounded bg-white/[0.08]" />
                    <div className="h-2 w-20 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : aiProvider.connected ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="relative w-10 h-10 rounded-full bg-green-500/15 border border-green-400/10 flex items-center justify-center shrink-0">
                    <AIProviderIcon provider={aiProvider.provider} size={24} />
                    <span className="absolute -right-1 -bottom-1 w-5 h-5 rounded-full bg-[#10261d] border border-green-500/25 flex items-center justify-center">
                      <span className="material-symbols-rounded text-green-400" style={{ fontSize: 14 }}>check</span>
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium">{aiProvider.providerLabel}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">
                        {aiProvider.model ? aiProvider.model.split("/").pop() : t("settings.connected")}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.noProviderConnected")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.selectProvider")}</div>
                  </div>
                </div>
              )}
            </div>

            <I18nProvider><AIModelsStep
              embedded
              providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
              defaultProviderId="clawai"
              currentProviderId={aiProvider?.provider ?? null}
              currentModel={aiProvider?.model ?? null}
              openClawAIOfferRequest={openClawAIOfferRequest}
              title="Connect AI Provider"
              description="Choose the primary AI service your assistant should use day to day. Your Local AI setup stays available as a private on-device fallback."
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

            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>memory</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {localAiStatus === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-32 rounded bg-white/[0.08]" />
                    <div className="h-2 w-20 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : localAiStatus.configured ? (
                <div className={`flex items-center gap-4 rounded-xl px-4 py-3.5 border ${
                  localAiStatus.running === false && !localAiStatus.standbyEnabled
                    ? "bg-amber-500/[0.06] border-amber-500/15"
                    : "bg-cyan-500/[0.06] border-cyan-500/15"
                }`}>
                  <div className={`relative w-10 h-10 rounded-full border flex items-center justify-center shrink-0 ${
                    localAiStatus.running === false && !localAiStatus.standbyEnabled
                      ? "bg-amber-500/10 border-amber-400/10"
                      : "bg-cyan-500/10 border-cyan-400/10"
                  }`}>
                    <AIProviderIcon provider={localAiStatus.provider} size={24} />
                    <span className={`absolute -right-1 -bottom-1 w-5 h-5 rounded-full border flex items-center justify-center ${
                      localAiStatus.running === false && !localAiStatus.standbyEnabled
                        ? "bg-[#2a1d10] border-amber-500/25"
                        : "bg-[#10212a] border-cyan-500/25"
                    }`}>
                      <span className={`material-symbols-rounded ${
                        localAiStatus.running === false && !localAiStatus.standbyEnabled ? "text-amber-300" : "text-cyan-300"
                      }`} style={{ fontSize: 14 }}>
                        {localAiStatus.running === false && !localAiStatus.standbyEnabled ? "warning" : "check"}
                      </span>
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium">
                      {localAiStatus.provider === "llamacpp" ? "Gemma 4 Local" : localAiStatus.provider === "ollama" ? "Ollama Local" : "Local AI"}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                        localAiStatus.running === false && !localAiStatus.standbyEnabled ? "bg-amber-300" : "bg-cyan-300"
                      }`} />
                      <span className={`text-xs ${
                        localAiStatus.running === false && !localAiStatus.standbyEnabled ? "text-amber-300/80" : "text-cyan-300/80"
                      }`}>
                        {localAiStatus.running === false && !localAiStatus.standbyEnabled
                          ? `${localAiStatus.model ? localAiStatus.model.split("/").pop() : "Configured"} · endpoint not responding`
                          : localAiStatus.running === false
                            ? `${localAiStatus.model ? localAiStatus.model.split("/").pop() : "Configured"} · sleeping until needed`
                            : (localAiStatus.model ? localAiStatus.model.split("/").pop() : "Ready as fallback")}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 22 }}>memory</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">No local model configured</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">Turn on Gemma 4 or Ollama to add a private on-device backup.</div>
                  </div>
                </div>
              )}
            </div>

            {localAiError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
                {localAiError}
              </div>
            )}

            {localAiStatus?.configured && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-lg font-semibold text-[var(--text-primary)]">
                      {localAiStatus.provider === "llamacpp" ? "Gemma 4" : "Ollama"}
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] mt-1">
                      {localAiStatus.running === false && !localAiStatus.standbyEnabled
                        ? "Configured, but currently offline."
                        : localAiStatus.running === false
                          ? "Enabled with on-demand standby to free RAM until OpenClaw needs it."
                        : "Enabled and ready as your local backup model."}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={disableLocalAi}
                    disabled={localAiDisabling}
                    className="px-4 py-2.5 bg-red-500/10 text-red-300 border border-red-500/20 rounded-xl text-sm font-semibold cursor-pointer hover:bg-red-500/20 transition-colors disabled:opacity-50"
                  >
                    {localAiDisabling ? "Disabling..." : "Disable"}
                  </button>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-3">
                  Disabling Local AI stops the local model and frees the memory it is using.
                </p>
              </div>
            )}

            <I18nProvider><AIModelsStep
              embedded
              providerIds={["llamacpp", "ollama"]}
              defaultProviderId="llamacpp"
              currentProviderId={localAiStatus?.provider ?? null}
              currentModel={localAiStatus?.model ?? null}
              title="Set Up Local AI"
              description={localAiStatus?.configured
                ? "Choose a different local engine if you want to switch your on-device fallback."
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

            {/* Status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#f97316"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.504-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.012-1.252-.242-1.865-.44-.751-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {tgConfigured === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-32 rounded bg-white/[0.08]" />
                    <div className="h-2 w-20 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : tgConfigured && !tgReconfigure ? (
                <div>
                  <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5 mb-4">
                    <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                      <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>check_circle</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--text-primary)] font-medium">
                        {tgBotInfo?.firstName || t("settings.botConnected")}
                      </div>
                      {tgBotInfo?.username && (
                        <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">@{tgBotInfo.username}</div>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        <span className="text-xs text-green-400/80">{t("settings.telegramActive")}</span>
                      </div>
                    </div>
                  </div>
                  {tgBotInfo?.link && (
                    <a
                      href={tgBotInfo.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full px-4 py-3 mb-4 bg-[#229ED9]/15 hover:bg-[#229ED9]/25 border border-[#229ED9]/40 hover:border-[#229ED9]/60 rounded-lg text-sm font-semibold text-[#5eb8e6] transition-colors no-underline"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
                      {t("settings.openInTelegram", { name: `@${tgBotInfo.username}` })}
                    </a>
                  )}
                  <button
                    onClick={() => { setTgReconfigure(true); setTgStatus(null); }}
                    className="text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
                  >
                    {t("settings.reconfigureBot")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.notConfigured")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.setupBotBelow")}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Setup card — shown when not configured or reconfiguring */}
            {(tgConfigured === false || tgReconfigure) && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>add_circle</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                    {tgReconfigure ? t("settings.reconfigureBot") : t("settings.setupBot")}
                  </label>
                </div>

                {/* Instructions with QR */}
                <div className="flex gap-4 items-start mb-5">
                  <div className="shrink-0 p-2 bg-white rounded-lg">
                    <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
                  </div>
                  <ol className="ml-0 pl-5 leading-[1.9] text-sm text-white/70 list-decimal">
                    <li>
                      Scan the QR or open{" "}
                      <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold no-underline">
                        @BotFather
                      </a>{" "}
                      in Telegram
                    </li>
                    <li>
                      Send{" "}
                      <code className="bg-white/[0.06] px-1.5 py-0.5 rounded text-xs text-[var(--coral-bright)]">
                        /newbot
                      </code>{" "}
                      and follow the prompts
                    </li>
                    <li>
                      Copy the <strong className="text-[var(--text-primary)]">Bot Token</strong> and paste below
                    </li>
                  </ol>
                </div>

                {/* Token input */}
                <div>
                  <label htmlFor="settings-tg-token" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.botToken")}</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>key</span>
                    <input
                      id="settings-tg-token"
                      type={tgShowToken ? "text" : "password"}
                      value={tgToken}
                      onChange={(e) => { setTgToken(e.target.value); setTgStatus(null); }}
                      placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full pl-10 pr-10 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      onKeyDown={e => e.key === "Enter" && saveTelegram()}
                    />
                    <button
                      type="button"
                      onClick={() => setTgShowToken(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-50 hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0.5"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{tgShowToken ? "visibility_off" : "visibility"}</span>
                    </button>
                  </div>
                </div>

                {tgStatus && <div className="mt-3"><StatusMessage type={tgStatus.type} message={tgStatus.message} /></div>}

                <div className="flex items-center gap-3 mt-5">
                  <button
                    onClick={saveTelegram}
                    disabled={tgSaving || !tgToken.trim()}
                    className="px-6 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
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
                    <button
                      onClick={() => { setTgReconfigure(false); setTgStatus(null); setTgToken(""); }}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Info card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>info</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.howItWorks")}</label>
              </div>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                {t("settings.telegramDescription")}
              </p>
            </div>
          </div>
        )}

        {/* ─── System ─── */}
        {activeSection === "system" && (
          <div className="max-w-xl space-y-5">

            {stats ? (
              <>
                {/* Device info card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>computer</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.device")}</label>
                    <span className="ml-auto text-xs font-mono text-[var(--coral-bright)]/70 bg-orange-500/10 px-2 py-0.5 rounded-md">{stats.overview.uptime}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.hostname")}</span><span className="text-[var(--text-primary)] font-mono text-xs">{stats.overview.hostname}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.os")}</span><span className="text-[var(--text-primary)] font-mono text-xs truncate ml-2">{stats.overview.os}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.kernel")}</span><span className="text-[var(--text-primary)] font-mono text-xs truncate ml-2">{stats.overview.kernel}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.arch")}</span><span className="text-[var(--text-primary)]">{stats.overview.arch}</span></div>
                  </div>
                </div>

                {/* CPU + Memory card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>speed</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.resources")}</label>
                  </div>

                  {/* CPU bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--text-muted)]">{t("settings.cpu")}</span>
                      <span className="text-xs font-mono font-semibold" style={{ color: barColor(stats.cpu.usage) }}>{stats.cpu.usage}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.cpu.usage}%`, backgroundColor: barColor(stats.cpu.usage) }} />
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-[var(--text-muted)] opacity-50 font-mono truncate max-w-[60%]">{stats.cpu.model}</span>
                      <span className="text-[10px] text-[var(--text-muted)] opacity-50">{stats.cpu.cores} {t("settings.cores")} &middot; Load {stats.cpu.loadAvg[0]}</span>
                    </div>
                  </div>

                  {/* Memory bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--text-muted)]">{t("settings.memory")}</span>
                      <span className="text-xs font-mono text-[var(--text-muted)]">{formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.usedPercent}%`, backgroundColor: barColor(stats.memory.usedPercent) }} />
                    </div>
                    <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{stats.memory.usedPercent}% &middot; {formatBytes(stats.memory.free)} free</div>
                  </div>

                  {/* Swap bar (if any) */}
                  {stats.memory.swap.total > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-[var(--text-muted)]">{t("settings.swap")}</span>
                        <span className="text-xs font-mono text-[var(--text-muted)]">{formatBytes(stats.memory.swap.used)} / {formatBytes(stats.memory.swap.total)}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.swap.percent}%`, backgroundColor: "#a855f7" }} />
                      </div>
                      <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{stats.memory.swap.percent}% used</div>
                    </div>
                  )}

                  {/* GPU bar */}
                  {stats.gpu != null && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-[var(--text-muted)]">{t("settings.gpu")}</span>
                        <span className="text-xs font-mono font-semibold" style={{ color: barColor(stats.gpu.usage) }}>{stats.gpu.usage}%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.gpu.usage}%`, backgroundColor: barColor(stats.gpu.usage) }} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Temperature card */}
                {stats.temperature?.value != null && (
                  <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>thermostat</span>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.temperature")}</label>
                    </div>
                    <div className="flex items-end gap-3">
                      <span className="text-3xl font-mono font-bold" style={{ color: stats.temperature.value > 80 ? "#ef4444" : stats.temperature.value > 60 ? "#f97316" : "#22d3ee" }}>
                        {stats.temperature.display}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] opacity-50 mb-1.5">
                        {stats.temperature.value > 80 ? t("settings.critical") : stats.temperature.value > 60 ? t("settings.warm") : t("settings.normal")}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden mt-3">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.min(100, (stats.temperature.value / 100) * 100)}%`,
                          backgroundColor: stats.temperature.value > 80 ? "#ef4444" : stats.temperature.value > 60 ? "#f97316" : "#22d3ee",
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] opacity-40 mt-1.5 font-mono">
                      <span>0°C</span><span>50°C</span><span>100°C</span>
                    </div>
                  </div>
                )}

                {/* Storage card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>hard_drive</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.storage")}</label>
                  </div>
                  <div className="space-y-3">
                    {stats.storage.filter(m => m.mountpoint !== "/boot/efi").map(m => (
                      <div key={m.mountpoint}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-[var(--text-secondary)] font-mono">{m.mountpoint}</span>
                          <span className="text-xs text-white/35 font-mono">{m.used} / {m.size}</span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${m.usePercent}%`, backgroundColor: barColor(m.usePercent) }} />
                        </div>
                        <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{m.usePercent}% &middot; {m.avail} free</div>
                      </div>
                    ))}
                  </div>
                </div>

              </>
            ) : (
              <div className="flex items-center justify-center py-12 text-[var(--text-muted)] opacity-60">
                <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin mr-3" style={{ borderTopColor: "#fe6e00" }} />
                <span className="text-sm">{t("settings.loadingStats")}</span>
              </div>
            )}

            {/* Password card — used for both web sign-in and SSH/sudo (PAM-backed) */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>key</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">Password</label>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-3 leading-relaxed">
                Used for web sign-in, SSH, and <span className="font-mono">sudo</span>. Updating it here changes all three.
              </p>
              <div className="space-y-2">
                <div className="flex items-stretch gap-2">
                  <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                    <label htmlFor="sys-current-password" className="sr-only">Current password</label>
                    <input
                      id="sys-current-password"
                      type={sysPasswordShow ? "text" : "password"}
                      value={sysCurrentPassword}
                      onChange={e => { setSysCurrentPassword(e.target.value); if (sysCurrentVerified) setSysCurrentVerified(false); setSysPasswordStatus(null); }}
                      onKeyDown={e => { if (e.key === "Enter" && !sysCurrentVerified) { e.preventDefault(); void verifyCurrentPassword(); } }}
                      placeholder="Current password"
                      maxLength={128}
                      autoComplete="current-password"
                      disabled={sysCurrentVerified}
                      className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20 disabled:opacity-60"
                    />
                    <button type="button" onClick={() => setSysPasswordShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysPasswordShow ? "Hide current password" : "Show current password"}>
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysPasswordShow ? "visibility_off" : "visibility"}</span>
                    </button>
                  </div>
                  {sysCurrentVerified ? (
                    <button
                      type="button"
                      onClick={resetSysPasswordForm}
                      className="px-3 py-2 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors flex items-center gap-1"
                      title="Clear and re-enter current password"
                      aria-label="Clear and re-enter current password"
                    >
                      <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 16 }}>check_circle</span>
                      Re-enter
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={verifyCurrentPassword}
                      disabled={sysVerifying || !sysCurrentPassword}
                      className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {sysVerifying ? "Checking…" : "Verify"}
                    </button>
                  )}
                </div>

                {sysCurrentVerified && (
                  <>
                    <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                      <label htmlFor="sys-new-password" className="sr-only">New password</label>
                      <input
                        id="sys-new-password"
                        type={sysNewShow ? "text" : "password"}
                        value={sysPassword}
                        onChange={e => { setSysPassword(e.target.value); setSysPasswordStatus(null); }}
                        placeholder="New password (8+ characters)"
                        maxLength={128}
                        autoComplete="new-password"
                        autoFocus
                        className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20"
                      />
                      <button type="button" onClick={() => setSysNewShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysNewShow ? "Hide new password" : "Show new password"}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysNewShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                      <label htmlFor="sys-confirm-password" className="sr-only">Confirm new password</label>
                      <input
                        id="sys-confirm-password"
                        type={sysConfirmShow ? "text" : "password"}
                        value={sysPasswordConfirm}
                        onChange={e => { setSysPasswordConfirm(e.target.value); setSysPasswordStatus(null); }}
                        placeholder="Confirm new password"
                        maxLength={128}
                        autoComplete="new-password"
                        className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20"
                      />
                      <button type="button" onClick={() => setSysConfirmShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysConfirmShow ? "Hide confirm password" : "Show confirm password"}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysConfirmShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    {sysPassword.length > 0 && sysPasswordConfirm.length > 0 && sysPassword !== sysPasswordConfirm && (
                      <div role="alert" aria-live="polite" className="text-[11px] text-amber-300/90">Passwords don&apos;t match yet</div>
                    )}
                    <div className="flex justify-end">
                      <button
                        onClick={requestSystemPasswordChange}
                        disabled={sysPasswordSaving || sysPassword.length < 8 || sysPassword !== sysPasswordConfirm}
                        className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
                      >
                        {sysPasswordSaving ? "Saving…" : "Update password"}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {sysPasswordStatus && <div className="mt-3"><StatusMessage type={sysPasswordStatus.type} message={sysPasswordStatus.message} /></div>}
            </div>

          </div>
        )}

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
              href="https://discord.gg/FbKmnxYnpq"
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

            <div className="flex gap-2">
              <button
                onClick={() => triggerUpdate()}
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
              <button
                onClick={() => triggerOpenclawUpdate()}
                className="flex items-center gap-3 flex-1 bg-blue-500/10 rounded-xl px-4 py-3 text-sm text-blue-400/80 hover:text-blue-400 border border-blue-500/20 hover:bg-blue-500/15 transition-colors cursor-pointer text-left"
              >
                <span className="material-symbols-rounded shrink-0" style={{ fontSize: 20 }}>cloud_download</span>
                <div className="flex flex-col min-w-0">
                  <span>{t("settings.openclawUpdate")}</span>
                  {cleanVersion(versionInfo?.openclaw.current) && (
                    <span className="text-[11px] text-blue-400/60 font-mono truncate">
                      {cleanVersion(versionInfo?.openclaw.current)}
                      {versionInfo?.openclaw.target && <> → <span className="text-blue-300">{cleanVersion(versionInfo.openclaw.target)}</span></>}
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

  // ─── Section status (subtitle + indicator dot) shared by mobile list + desktop sidebar ───
  // SectionStatus type is declared at module scope (above component)
  const sectionStatus = (id: Section): SectionStatus => {
    switch (id) {
      case "appearance": {
        const sub = ui.wallpaperId.startsWith("custom-")
          ? `Custom ${parseInt(ui.wallpaperId.split("-")[1] || "0") + 1}`
          : ui.wallpaperId;
        return { subtitle: sub, dot: null };
      }
      case "wifi":
        if (connectedSSID) return { subtitle: connectedSSID, dot: "ok" };
        if (ethernet.connected) return { subtitle: ethernet.iface ? `Ethernet (${ethernet.iface})` : "Ethernet", dot: "ok" };
        return { subtitle: t("settings.notConnected") || "Not connected", dot: "warn" };
      case "ai": {
        if (aiProvider === null) return { subtitle: null, dot: null };
        if (!aiProvider.connected) return { subtitle: t("settings.notConfigured") || "Not configured", dot: "warn" };
        return { subtitle: aiProvider.providerLabel || (aiProvider.model ? aiProvider.model.split("/").pop() ?? null : null), dot: "ok" };
      }
      case "localAi": {
        if (localAiStatus === null) return { subtitle: null, dot: null };
        if (!localAiStatus.configured) return { subtitle: t("settings.notConfigured") || "Not configured", dot: null };
        return { subtitle: localAiStatus.model || localAiStatus.provider, dot: localAiStatus.running ? "ok" : "warn" };
      }
      case "telegram": {
        if (tgConfigured === null) return { subtitle: null, dot: null };
        if (!tgConfigured) return { subtitle: t("settings.notConfigured") || "Not configured", dot: null };
        return { subtitle: tgBotInfo?.username ? `@${tgBotInfo.username}` : (t("settings.botConnected") || "Connected"), dot: "ok" };
      }
      case "system":
        return { subtitle: hostname ? `${hostname}.local` : null, dot: null };
      case "about":
        return { subtitle: versionInfo?.clawbox?.current ? cleanVersion(versionInfo.clawbox.current) : null, dot: null };
      default:
        return { subtitle: null, dot: null };
    }
  };

  // ─── Mobile layout: full-screen nav or full-screen content ───
  if (isMobile) {
    return (
      <div className="flex flex-col h-full bg-[var(--bg-deep)]">
        {mobileSection === null ? (
          /* Nav list — iOS-style grouped rows with status subtitles */
          <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6">
            <h2 className="text-2xl font-bold text-[var(--text-primary)] px-1 mb-4">{t("settings.title")}</h2>
            <nav className="bg-white/[0.04] border border-white/[0.06] rounded-2xl overflow-hidden divide-y divide-white/[0.06]">
              {NAV_ITEMS.map(item => {
                const { subtitle } = sectionStatus(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => { setSection(item.id); setMobileSection(item.id); }}
                    className="flex items-center gap-4 w-full px-4 py-3.5 text-left border-none cursor-pointer transition-colors bg-transparent hover:bg-white/[0.04] active:bg-white/[0.08]"
                  >
                    <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--coral-bright)]/15 shrink-0">
                      <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 22 }}>{item.icon}</span>
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-[15px] font-medium text-[var(--text-primary)] leading-tight">{navLabel(item)}</span>
                      {subtitle && (
                        <span className="text-xs text-[var(--text-muted)] truncate">{subtitle}</span>
                      )}
                    </span>
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40 shrink-0" style={{ fontSize: 20 }}>chevron_right</span>
                  </button>
                );
              })}
            </nav>
          </div>
        ) : (
          /* Content — chrome back closes window in one tap. A small "All settings"
              link at the top lets the user switch sections without leaving. */
          <>
            <div className="px-4 pt-3 pb-1 shrink-0">
              <button
                onClick={() => setMobileSection(null)}
                className="flex items-center gap-1 text-xs text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer p-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                <span>{t("settings.title")}</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
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
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">Enable hotspot?</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--text-primary)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* Hostname confirmation modal */}
      {hostnameConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5 text-[12px] leading-relaxed text-amber-100/90">
              <div className="flex items-start gap-2">
                <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div>
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-1 font-mono text-amber-50 break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
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
    <div className="flex h-full bg-[var(--bg-deep)]">
      {/* Sidebar */}
      <nav className="w-60 shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] py-4 px-2 flex flex-col gap-0.5">
        {NAV_ITEMS.map(item => {
          const active = activeSection === item.id;
          const status = sectionStatus(item.id);
          return (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-3 px-2.5 py-2 rounded-xl text-[15px] border-none cursor-pointer transition-colors text-left ${
                active
                  ? "bg-[var(--coral-bright)]/15 text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)]"
              }`}
            >
              <span className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${active ? "bg-[var(--coral-bright)]/25" : "bg-white/[0.06]"}`}>
                <span className="material-symbols-rounded" style={{ fontSize: 20, color: active ? "var(--coral-bright)" : "var(--text-muted)" }}>{item.icon}</span>
              </span>
              <span className="flex-1 min-w-0 truncate font-medium">{navLabel(item)}</span>
              {status.subtitle && <span className="sr-only">{status.subtitle}</span>}
              {status.dot && (
                <span
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    status.dot === "ok" ? "bg-emerald-400" : status.dot === "warn" ? "bg-amber-400" : "bg-white/20"
                  }`}
                  title={status.subtitle ?? undefined}
                />
              )}
            </button>
          );
        })}
        <div className="flex-1" />
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center">
        <div className="w-full max-w-3xl flex flex-col items-stretch [&>div]:mx-auto [&>div]:w-full">
          {renderContent()}
        </div>
      </div>

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
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5 text-[12px] leading-relaxed text-amber-100/90">
              <div className="flex items-start gap-2">
                <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div>
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-1 font-mono text-amber-50 break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
                {hostnameSaving ? t("settings.restartingDevice") : t("settings.saveAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hotspot enable confirmation — single-radio collision warning (desktop layout) */}
      {hotspotConfirmEnable && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">Enable hotspot?</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--text-primary)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* System password change confirmation */}
      {sysPasswordConfirmOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="sys-pw-confirm-title" className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 22 }}>warning</span>
              <h3 id="sys-pw-confirm-title" className="text-lg font-bold text-[var(--text-primary)]">Write this password down</h3>
            </div>
            <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
              This will change your password for <span className="text-[var(--text-primary)] font-medium">web sign-in, SSH, and sudo</span>. If you forget it, you may be locked out of the device entirely and need a factory reset to recover.
            </p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[10px] font-semibold text-amber-200/80 uppercase tracking-widest">New password</span>
                <button type="button" onClick={() => setSysPasswordConfirmReveal(v => !v)} className="text-[10px] text-amber-200 hover:text-amber-100 bg-transparent border-none cursor-pointer flex items-center gap-1" aria-label={sysPasswordConfirmReveal ? "Hide password" : "Reveal password"}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{sysPasswordConfirmReveal ? "visibility_off" : "visibility"}</span>
                  {sysPasswordConfirmReveal ? "Hide" : "Reveal"}
                </button>
              </div>
              <div className="font-mono text-sm text-amber-50 break-all min-h-[1.25rem]">
                {sysPasswordConfirmReveal ? sysPassword : "••••••••"}
              </div>
            </div>
            <div className="flex gap-3">
              <button ref={sysPasswordConfirmCancelRef} disabled={sysPasswordSaving} onClick={() => setSysPasswordConfirmOpen(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">{t("cancel")}</button>
              <button disabled={sysPasswordSaving} onClick={() => { setSysPasswordConfirmOpen(false); void saveSystemPassword(); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
                {sysPasswordSaving ? "Saving…" : "I’ve written it down — change"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* System Update full-screen overlay (portal to escape window stacking context) */}
      {hostnameRebootTo && typeof document !== "undefined" && createPortal(
        <div role="alertdialog" aria-modal="true" aria-live="assertive" aria-labelledby="hostname-reboot-title" className="fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "rgba(10, 15, 26, 1)" }}>
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
        <div className="fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "rgba(10, 15, 26, 1)" }}>
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
                  ? (updateState.steps.some(s => s.id === "restart") ? t("settings.restartingDevice") : t("settings.updateDone"))
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
