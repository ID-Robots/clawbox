"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import StatusMessage from "./StatusMessage";
import AIModelsStep from "./AIModelsStep";
import { QRCodeSVG } from "qrcode.react";
import type { StepStatus, UpdateState } from "@/lib/updater";

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


const RESET_STEPS = [
  "Clearing configuration...",
  "Removing credentials...",
  "Wiping AI model data...",
  "Resetting gateway...",
  "Finalizing...",
];

type Section = "appearance" | "wifi" | "ai" | "telegram" | "system" | "about";

/* ── Sidebar nav items ── */
const NAV_ITEMS: { id: Section; icon: string; label: string }[] = [
  { id: "appearance", icon: "palette", label: "Appearance" },
  { id: "wifi", icon: "wifi", label: "Network" },
  { id: "ai", icon: "smart_toy", label: "AI Provider" },
  { id: "telegram", icon: "send", label: "Telegram" },
  { id: "system", icon: "monitor_heart", label: "System" },
  { id: "about", icon: "info", label: "About" },
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
      <span className="text-sm text-white/80">{label}</span>
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


/* ── Update step helpers ── */

function updateStepTextClass(status: StepStatus): string {
  switch (status) {
    case "running": return "text-orange-400 font-medium";
    case "completed": return "text-white/40";
    case "failed": return "text-red-400";
    default: return "text-white/25";
  }
}

function UpdateStepIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin shrink-0" />;
  if (status === "completed") return <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">&#10003;</div>;
  if (status === "failed") return <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">&#10005;</div>;
  return <div className="w-4 h-4 rounded-full bg-white/10 shrink-0" />;
}

export default function SettingsApp({ ui }: SettingsAppProps) {
  const [section, setSection] = useState<Section>("appearance");
  // Mobile: null means show nav list, a section means show content with back button
  const [mobileSection, setMobileSection] = useState<Section | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /* ── System stats (only poll when visible) ── */
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    if (section !== "system") return;
    const poll = () => fetch("/setup-api/system/stats", { cache: "no-store" }).then(r => r.json()).then(setStats).catch(() => {});
    poll();
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

  // Load version info on mount
  useEffect(() => {
    fetch("/setup-api/update/status")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.versions) setVersionInfo(data.versions); })
      .catch(() => {});
  }, []);

  const isUpdateRunning = updateStarted && updateState?.phase === "running";

  const openUpdateConfirm = async () => {
    setVersionLoading(true);
    setUpdateConfirm(true);
    try {
      const [statusRes, branchRes] = await Promise.all([
        fetch("/setup-api/update/status"),
        fetch("/setup-api/system/update-branch"),
      ]);
      if (statusRes.ok) { const data = await statusRes.json(); if (data.versions) setVersionInfo(data.versions); }
      if (branchRes.ok) { const data = await branchRes.json(); setUpdateBranch(data.branch ?? null); setBranchInput(data.branch ?? ""); }
    } catch {} finally { setVersionLoading(false); }
  };

  const saveUpdateBranch = async (branch: string) => {
    setBranchSaving(true);
    setBranchError(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branch: branch || null }) });
      const data = await res.json();
      if (res.ok) { setUpdateBranch(data.branch ?? null); } else { setBranchError(data.error || "Failed to set branch"); }
    } catch (err) { setBranchError(err instanceof Error ? err.message : "Failed to set branch"); } finally { setBranchSaving(false); }
  };

  const triggerUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setUpdateError(typeof data.error === "string" ? data.error : "Failed to start update"); return; }
      startUpdatePolling();
    } catch (err) { setUpdateError(err instanceof Error ? err.message : "Failed to start update"); }
  };

  /* ── WiFi ── */
  const [ssid, setSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [connectedSSID, setConnectedSSID] = useState<string | null>(null);

  /* ── Hotspot ── */
  const [hotspotEnabled, setHotspotEnabled] = useState<boolean | null>(null);
  const [hotspotSSID, setHotspotSSID] = useState("ClawBox-Setup");
  const [hotspotToggling, setHotspotToggling] = useState(false);

  useEffect(() => {
    fetch("/setup-api/wifi/status").then(r => r.json()).then(d => {
      if (d.connected && d.ssid) setConnectedSSID(d.ssid);
    }).catch(() => {});
    fetch("/setup-api/system/hotspot").then(r => r.json()).then(d => {
      setHotspotEnabled(d.enabled ?? true);
      if (d.ssid) setHotspotSSID(d.ssid);
    }).catch(() => {});
  }, []);

  const toggleHotspot = async () => {
    const newEnabled = !hotspotEnabled;
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
      setWifiStatus({ type: "success", message: `Connected to ${ssid}` });
      setConnectedSSID(ssid.trim());
      setSsid("");
      setWifiPass("");
    } catch (err) {
      setWifiStatus({ type: "error", message: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setWifiConnecting(false);
    }
  };

  /* ── AI Provider ── */

  /* ── Telegram ── */
  const [tgToken, setTgToken] = useState("");
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgStatus, setTgStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [tgReconfigure, setTgReconfigure] = useState(false);
  const tgSaveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (section !== "telegram") return;
    fetch("/setup-api/telegram/status").then(r => r.json()).then(d => {
      setTgConfigured(d.configured ?? false);
    }).catch(() => setTgConfigured(false));
  }, [section]);

  const saveTelegram = async () => {
    if (!tgToken.trim()) {
      setTgStatus({ type: "error", message: "Please enter a bot token" });
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
        setTgStatus({ type: "error", message: data.error || "Failed to save" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setTgStatus({ type: "success", message: "Telegram bot configured successfully!" });
        setTgConfigured(true);
        setTgReconfigure(false);
        setTgToken("");
      } else {
        setTgStatus({ type: "error", message: data.error || "Failed to save" });
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
  const [resetStep, setResetStep] = useState(0);
  const [resetProgress, setResetProgress] = useState(0);

  const resetSetup = async () => {
    setResetting(true);
    setResetStep(0);
    setResetProgress(0);
    let step = 0;
    const iv = setInterval(() => {
      step++;
      if (step < RESET_STEPS.length) {
        setResetStep(step);
        setResetProgress(Math.round((step / RESET_STEPS.length) * 100));
      }
    }, 800);
    try {
      const res = await fetch("/setup-api/setup/reset", { method: "POST" });
      clearInterval(iv);
      if (res.ok) {
        setResetStep(RESET_STEPS.length - 1);
        setResetProgress(100);
        await new Promise(r => setTimeout(r, 2000));
        window.location.href = "/setup";
        return;
      }
    } catch { /* ignore */ }
    clearInterval(iv);
    setResetting(false);
  };

  const activeSection = isMobile ? (mobileSection ?? section) : section;

  const renderContent = () => (
    <>
        {/* ─── Appearance ─── */}
        {activeSection === "appearance" && (
          <div className="max-w-2xl space-y-5">
            <h2 className="text-lg font-semibold text-white/90">Appearance</h2>

            {/* Wallpaper card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>wallpaper</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Wallpaper</label>
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
                  className="rounded-xl aspect-video border-2 border-dashed border-white/10 hover:border-orange-400/40 hover:bg-orange-500/5 flex flex-col items-center justify-center gap-1.5 text-white/30 hover:text-orange-400/70 transition-all cursor-pointer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 24 }}>add_photo_alternate</span>
                  <span className="text-[10px] font-medium">Upload</span>
                </button>
              </div>
            </div>

            {/* Display Settings card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>tune</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Display</label>
              </div>

              {/* Fit mode */}
              <div>
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">Fit Mode</label>
                <div className="flex gap-1 bg-white/[0.04] rounded-xl p-1">
                  {(["fill", "fit", "center"] as const).map(mode => {
                    const icons = { fill: "zoom_out_map", fit: "fit_screen", center: "center_focus_strong" };
                    return (
                      <button
                        key={mode}
                        onClick={() => ui.onWpFitChange(mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer border-none capitalize ${
                          ui.wpFit === mode ? "bg-orange-500/15 text-orange-400 shadow-sm" : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icons[mode]}</span>
                        {mode}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Opacity */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-medium text-white/35 uppercase tracking-wider">Opacity</label>
                  <span className="text-xs font-mono text-orange-400/80 bg-orange-500/10 px-2 py-0.5 rounded-md">{ui.wpOpacity}%</span>
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
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">Background Color</label>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      type="color" value={ui.wpBgColor}
                      onChange={e => ui.onWpBgColorChange(e.target.value)}
                      className="w-10 h-10 rounded-xl cursor-pointer border-2 border-white/10 hover:border-white/20 transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-3 py-2">
                    <span className="text-xs text-white/40 font-mono tracking-wide">{ui.wpBgColor}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Extras card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>auto_awesome</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Extras</label>
              </div>
              <Toggle on={!ui.mascotHidden} onToggle={v => {
                const hidden = !v;
                ui.onMascotToggle(hidden);
                window.dispatchEvent(new Event(hidden ? "clawbox-hide-mascot" : "clawbox-show-mascot"));
              }} label="Show Mascot" />
            </div>
          </div>
        )}

        {/* ─── Network ─── */}
        {activeSection === "wifi" && (
          <div className="max-w-lg space-y-5">
            <h2 className="text-lg font-semibold text-white/90">Network</h2>

            {/* Connection status card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>wifi</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Status</label>
              </div>
              {connectedSSID ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>wifi</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white/90 font-medium truncate">{connectedSSID}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">Connected</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-white/25" style={{ fontSize: 22 }}>wifi_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-white/50">No WiFi connection</div>
                    <div className="text-xs text-white/25 mt-0.5">Connect to a network below</div>
                  </div>
                </div>
              )}
            </div>

            {/* Hotspot toggle card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${hotspotEnabled ? "bg-orange-500/15" : "bg-white/5"}`}>
                    <span className={`material-symbols-rounded ${hotspotEnabled ? "text-orange-400" : "text-white/25"}`} style={{ fontSize: 22 }}>wifi_tethering</span>
                  </div>
                  <div>
                    <div className="text-sm text-white/90 font-medium">Hotspot</div>
                    <div className="text-xs text-white/35 mt-0.5">{hotspotSSID}</div>
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
              {hotspotEnabled && (
                <p className="text-[11px] text-white/25 mt-3 leading-relaxed">
                  The hotspot broadcasts <span className="text-white/40 font-medium">{hotspotSSID}</span> so you can connect to this device directly.
                </p>
              )}
            </div>

            {/* Connect to network card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>add_circle</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Connect to Network</label>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">Network Name (SSID)</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/20" style={{ fontSize: 18 }}>router</span>
                    <input
                      type="text" value={ssid} onChange={e => setSsid(e.target.value)}
                      placeholder="Enter WiFi network name"
                      className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white/90 outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">Password</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/20" style={{ fontSize: 18 }}>lock</span>
                    <input
                      type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)}
                      placeholder="Enter WiFi password"
                      className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white/90 outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      onKeyDown={e => e.key === "Enter" && connectWifi()}
                    />
                  </div>
                </div>
                {/* Hotspot warning */}
                <div className="flex items-start gap-2.5 bg-amber-500/[0.07] border border-amber-500/15 rounded-xl px-3.5 py-3">
                  <span className="material-symbols-rounded text-amber-400 shrink-0 mt-0.5" style={{ fontSize: 16 }}>warning</span>
                  <p className="text-xs text-amber-300/70 leading-relaxed">
                    Connecting to a WiFi network will <span className="text-amber-300 font-medium">stop the ClawBox-Setup hotspot</span>. Make sure you can reach the device on the new network before connecting.
                  </p>
                </div>

                <button
                  onClick={connectWifi}
                  disabled={wifiConnecting || !ssid.trim()}
                  className="w-full py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                >
                  {wifiConnecting ? (
                    <>
                      <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                      Connecting...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span>
                      Connect
                    </>
                  )}
                </button>
                {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
              </div>
            </div>

          </div>
        )}

        {/* ─── AI Provider ─── */}
        {activeSection === "ai" && (
          <div className="max-w-lg">
            <AIModelsStep embedded />
          </div>
        )}

        {/* ─── Telegram ─── */}
        {activeSection === "telegram" && (
          <div className="max-w-lg space-y-5">
            <h2 className="text-lg font-semibold text-white/90">Telegram</h2>

            {/* Status card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#f97316"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.504-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.012-1.252-.242-1.865-.44-.751-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Status</label>
              </div>
              {tgConfigured === null ? (
                <div className="flex items-center gap-3 text-white/30 text-sm">
                  <div className="w-5 h-5 border-2 border-white/15 border-t-orange-400 rounded-full animate-spin" />
                  Checking...
                </div>
              ) : tgConfigured && !tgReconfigure ? (
                <div>
                  <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5 mb-4">
                    <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                      <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>check_circle</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white/90 font-medium">Bot Connected</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        <span className="text-xs text-green-400/80">Telegram channel active</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => { setTgReconfigure(true); setTgStatus(null); }}
                    className="text-sm text-orange-400 hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
                  >
                    Reconfigure bot token
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-white/25" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-white/50">Not configured</div>
                    <div className="text-xs text-white/25 mt-0.5">Set up a Telegram bot below</div>
                  </div>
                </div>
              )}
            </div>

            {/* Setup card — shown when not configured or reconfiguring */}
            {(tgConfigured === false || tgReconfigure) && (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>add_circle</span>
                  <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">
                    {tgReconfigure ? "Reconfigure Bot" : "Setup Bot"}
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
                      <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:text-orange-300 font-semibold no-underline">
                        @BotFather
                      </a>{" "}
                      in Telegram
                    </li>
                    <li>
                      Send{" "}
                      <code className="bg-white/[0.06] px-1.5 py-0.5 rounded text-xs text-orange-400">
                        /newbot
                      </code>{" "}
                      and follow the prompts
                    </li>
                    <li>
                      Copy the <strong className="text-white/90">Bot Token</strong> and paste below
                    </li>
                  </ol>
                </div>

                {/* Token input */}
                <div>
                  <label htmlFor="settings-tg-token" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">Bot Token</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/20" style={{ fontSize: 18 }}>key</span>
                    <input
                      id="settings-tg-token"
                      type={tgShowToken ? "text" : "password"}
                      value={tgToken}
                      onChange={(e) => { setTgToken(e.target.value); setTgStatus(null); }}
                      placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full pl-10 pr-10 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white/90 outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      onKeyDown={e => e.key === "Enter" && saveTelegram()}
                    />
                    <button
                      type="button"
                      onClick={() => setTgShowToken(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 bg-transparent border-none cursor-pointer p-0.5"
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
                        Saving...
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>save</span>
                        Save
                      </>
                    )}
                  </button>
                  {tgReconfigure && (
                    <button
                      onClick={() => { setTgReconfigure(false); setTgStatus(null); setTgToken(""); }}
                      className="text-sm text-white/40 hover:text-white/60 bg-transparent border-none cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Info card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>info</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">How it works</label>
              </div>
              <p className="text-xs text-white/40 leading-relaxed">
                Once configured, you can chat with your ClawBox AI assistant directly from Telegram. 
                Send messages to your bot and it will respond using the AI provider configured in the AI Provider settings.
                Your conversations are private and processed on your device.
              </p>
            </div>
          </div>
        )}

        {/* ─── System ─── */}
        {activeSection === "system" && (
          <div className="max-w-2xl space-y-5">
            <h2 className="text-lg font-semibold text-white/90">System</h2>

            {stats ? (
              <>
                {/* Device info card */}
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>computer</span>
                    <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Device</label>
                    <span className="ml-auto text-xs font-mono text-orange-400/70 bg-orange-500/10 px-2 py-0.5 rounded-md">{stats.overview.uptime}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-white/35">Hostname</span><span className="text-white/80 font-mono text-xs">{stats.overview.hostname}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">OS</span><span className="text-white/80 font-mono text-xs truncate ml-2">{stats.overview.os}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">Kernel</span><span className="text-white/80 font-mono text-xs truncate ml-2">{stats.overview.kernel}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">Arch</span><span className="text-white/80">{stats.overview.arch}</span></div>
                  </div>
                </div>

                {/* CPU + Memory card */}
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>speed</span>
                    <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Resources</label>
                  </div>

                  {/* CPU bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-white/50">CPU</span>
                      <span className="text-xs font-mono font-semibold" style={{ color: barColor(stats.cpu.usage) }}>{stats.cpu.usage}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.cpu.usage}%`, backgroundColor: barColor(stats.cpu.usage) }} />
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-white/25 font-mono truncate max-w-[60%]">{stats.cpu.model}</span>
                      <span className="text-[10px] text-white/25">{stats.cpu.cores} cores &middot; Load {stats.cpu.loadAvg[0]}</span>
                    </div>
                  </div>

                  {/* Memory bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-white/50">Memory</span>
                      <span className="text-xs font-mono text-white/50">{formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.usedPercent}%`, backgroundColor: barColor(stats.memory.usedPercent) }} />
                    </div>
                    <div className="text-right text-[10px] text-white/25 mt-1">{stats.memory.usedPercent}% &middot; {formatBytes(stats.memory.free)} free</div>
                  </div>

                  {/* Swap bar (if any) */}
                  {stats.memory.swap.total > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-white/50">Swap</span>
                        <span className="text-xs font-mono text-white/50">{formatBytes(stats.memory.swap.used)} / {formatBytes(stats.memory.swap.total)}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.swap.percent}%`, backgroundColor: "#a855f7" }} />
                      </div>
                      <div className="text-right text-[10px] text-white/25 mt-1">{stats.memory.swap.percent}% used</div>
                    </div>
                  )}

                  {/* GPU bar */}
                  {stats.gpu != null && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-white/50">GPU</span>
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
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>thermostat</span>
                      <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Temperature</label>
                    </div>
                    <div className="flex items-end gap-3">
                      <span className="text-3xl font-mono font-bold" style={{ color: stats.temperature.value > 80 ? "#ef4444" : stats.temperature.value > 60 ? "#f97316" : "#22d3ee" }}>
                        {stats.temperature.display}
                      </span>
                      <span className="text-xs text-white/25 mb-1.5">
                        {stats.temperature.value > 80 ? "Critical" : stats.temperature.value > 60 ? "Warm" : "Normal"}
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
                    <div className="flex justify-between text-[10px] text-white/20 mt-1.5 font-mono">
                      <span>0°C</span><span>50°C</span><span>100°C</span>
                    </div>
                  </div>
                )}

                {/* Storage card */}
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>hard_drive</span>
                    <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Storage</label>
                  </div>
                  <div className="space-y-3">
                    {stats.storage.filter(m => m.mountpoint !== "/boot/efi").map(m => (
                      <div key={m.mountpoint}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-white/60 font-mono">{m.mountpoint}</span>
                          <span className="text-xs text-white/35 font-mono">{m.used} / {m.size}</span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${m.usePercent}%`, backgroundColor: barColor(m.usePercent) }} />
                        </div>
                        <div className="text-right text-[10px] text-white/25 mt-1">{m.usePercent}% &middot; {m.avail} free</div>
                      </div>
                    ))}
                  </div>
                </div>

              </>
            ) : (
              <div className="flex items-center justify-center py-12 text-white/30">
                <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin mr-3" style={{ borderTopColor: "#fe6e00" }} />
                <span className="text-sm">Loading system stats...</span>
              </div>
            )}

          </div>
        )}

        {/* ─── About ─── */}
        {activeSection === "about" && (
          <div className="max-w-md space-y-6">
            <h2 className="text-lg font-semibold text-white/90 mb-4">About ClawBox</h2>

            <div className="bg-white/5 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-4">
                <img src="/icon-512.png" alt="ClawBox" className="w-14 h-14 rounded-2xl" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div>
                  <div className="text-lg font-bold text-white/90">ClawBox</div>
                  <div className="text-xs text-white/40">Personal AI Assistant Device</div>
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-white/5">
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Version</span>
                  <span className="text-white/80">{versionInfo?.clawbox.current ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Runtime</span>
                  <span className="text-white/80">Next.js + Bun</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Platform</span>
                  <span className="text-white/80">{stats ? `${stats.overview.arch} ${stats.overview.platform}` : "..."}</span>
                </div>
              </div>
            </div>

            <a
              href="https://openclawhardware.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-white/60 hover:text-white/80 transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>help</span>
              Documentation
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href="https://t.me/ClawBoxSupportBot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-white/60 hover:text-white/80 transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>support_agent</span>
              Support
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href="https://discord.gg/FbKmnxYnpq"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-white/60 hover:text-white/80 transition-colors no-underline"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              Discord Community
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <div className="space-y-2 pt-2">
              <button
                onClick={() => openUpdateConfirm()}
                className="flex items-center gap-3 w-full bg-green-500/10 rounded-xl px-4 py-3 text-sm text-green-400/80 hover:text-green-400 border border-green-500/20 hover:bg-green-500/15 transition-colors cursor-pointer"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>system_update</span>
                System Update
              </button>
              <button
                onClick={() => setResetConfirm(true)}
                className="flex items-center gap-3 w-full bg-red-500/5 rounded-xl px-4 py-3 text-sm text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>restart_alt</span>
                Factory Reset
              </button>
            </div>
          </div>
        )}
    </>
  );

  // ─── Mobile layout: full-screen nav or full-screen content ───
  if (isMobile) {
    return (
      <div className="flex flex-col h-full bg-[#0d1117]">
        {mobileSection === null ? (
          /* Nav list */
          <div className="flex-1 overflow-y-auto">
            <h2 className="text-lg font-semibold text-white/90 px-5 pt-4 pb-2">Settings</h2>
            <nav className="flex flex-col">
              {NAV_ITEMS.map(item => (
                <button
                  key={item.id}
                  onClick={() => { setSection(item.id); setMobileSection(item.id); }}
                  className="flex items-center gap-3 px-5 py-3.5 text-sm border-none cursor-pointer transition-colors text-white/70 hover:bg-white/5 active:bg-white/10"
                >
                  <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 20 }}>{item.icon}</span>
                  <span className="flex-1 text-left">{item.label}</span>
                  <span className="material-symbols-rounded text-white/20" style={{ fontSize: 18 }}>chevron_right</span>
                </button>
              ))}
            </nav>
          </div>
        ) : (
          /* Content with back button */
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
              <button
                onClick={() => setMobileSection(null)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/60 cursor-pointer"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span className="text-sm font-medium text-white/80">
                {NAV_ITEMS.find(i => i.id === mobileSection)?.label ?? "Settings"}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {renderContent()}
            </div>
          </>
        )}

        {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[#1e2030] border border-white/10 rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-white/90 mb-2">System Update</h3>
            <p className="text-sm text-white/50 mb-4 leading-relaxed">
              This will pull the latest updates and restart the device. The process may take a few minutes.
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-white/30">Checking versions...</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-white/50 font-medium">ClawBox</span>
                  <span className="text-white/80">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">Latest</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-white/50 font-medium">OpenClaw</span>
                  <span className="text-white/80">
                    {versionInfo.openclaw.current ?? "not installed"}
                    {versionInfo.openclaw.target ? (
                      <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">Latest</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {/* Branch selector */}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch" className="text-xs text-white/30 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder="main"
                    className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-orange-500"
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
                    <span className="text-xs text-emerald-400">Pinned: {updateBranch}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">Clear</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-white/20">Leave empty to follow current branch or main</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-white/80 border border-white/10 rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                Cancel
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset modal */}
      {resetConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1f2e] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-white/10">
            {!resetting ? (
              <>
                <h3 className="text-lg font-bold text-white/90 mb-2">Factory Reset?</h3>
                <p className="text-sm text-white/50 mb-5">This will erase all settings, credentials, and AI configuration. The setup wizard will restart.</p>
                <div className="flex gap-3">
                  <button onClick={() => setResetConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-white/60 rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">
                    Cancel
                  </button>
                  <button onClick={resetSetup} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-red-600 transition-colors">
                    Reset
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold text-white/90 mb-4">Resetting...</h3>
                <div className="space-y-2 mb-4">
                  {RESET_STEPS.map((step, i) => (
                    <div key={i} className="flex items-center gap-2.5 text-sm">
                      {i < resetStep ? (
                        <span className="material-symbols-rounded text-green-400" style={{ fontSize: 16 }}>check</span>
                      ) : i === resetStep ? (
                        <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="w-4 h-4 rounded-full border-2 border-white/10" />
                      )}
                      <span className={i <= resetStep ? "text-white/80" : "text-white/20"}>{step}</span>
                    </div>
                  ))}
                </div>
                <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full transition-all duration-300" style={{ width: `${resetProgress}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
  }

  // ─── Desktop layout: sidebar + content ───
  return (
    <div className="flex h-full bg-[#0d1117]">
      {/* Sidebar */}
      <nav className="w-48 shrink-0 bg-white/[0.02] border-r border-white/5 py-3 flex flex-col">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            onClick={() => setSection(item.id)}
            className={`flex items-center gap-3 px-4 py-2.5 text-sm border-none cursor-pointer transition-colors ${
              activeSection === item.id
                ? "bg-orange-500/10 text-orange-400 border-r-2 border-r-orange-400"
                : "text-white/50 hover:text-white/80 hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
        <div className="flex-1" />
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {renderContent()}
      </div>

      {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[#1e2030] border border-white/10 rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-white/90 mb-2">System Update</h3>
            <p className="text-sm text-white/50 mb-4 leading-relaxed">
              This will pull the latest updates and restart the device. The process may take a few minutes.
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-white/30">Checking versions...</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-white/50 font-medium">ClawBox</span>
                  <span className="text-white/80">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">Latest</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-white/50 font-medium">OpenClaw</span>
                  <span className="text-white/80">
                    {versionInfo.openclaw.current ?? "not installed"}
                    {versionInfo.openclaw.target ? (
                      <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">Latest</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch-d" className="text-xs text-white/30 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch-d"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder="main"
                    className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-orange-500"
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
                    <span className="text-xs text-emerald-400">Pinned: {updateBranch}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">Clear</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-white/20">Leave empty to follow current branch or main</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-white/80 border border-white/10 rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                Cancel
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset modal */}
      {resetConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1f2e] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-white/10">
            {!resetting ? (
              <>
                <h3 className="text-lg font-bold text-white/90 mb-2">Factory Reset?</h3>
                <p className="text-sm text-white/50 mb-5">This will erase all settings, credentials, and AI configuration. The setup wizard will restart.</p>
                <div className="flex gap-3">
                  <button onClick={() => setResetConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-white/60 rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">
                    Cancel
                  </button>
                  <button onClick={resetSetup} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-red-600 transition-colors">
                    Reset
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold text-white/90 mb-4">Resetting...</h3>
                <div className="space-y-2 mb-4">
                  {RESET_STEPS.map((step, i) => (
                    <div key={i} className="flex items-center gap-2.5 text-sm">
                      {i < resetStep ? (
                        <span className="material-symbols-rounded text-green-400" style={{ fontSize: 16 }}>check</span>
                      ) : i === resetStep ? (
                        <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="w-4 h-4 rounded-full border-2 border-white/10" />
                      )}
                      <span className={i <= resetStep ? "text-white/80" : "text-white/20"}>{step}</span>
                    </div>
                  ))}
                </div>
                <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full transition-all duration-300" style={{ width: `${resetProgress}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
