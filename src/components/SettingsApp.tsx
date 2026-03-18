"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import StatusMessage from "./StatusMessage";
import AIModelsStep from "./AIModelsStep";
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

type Section = "appearance" | "wifi" | "ai" | "system" | "about";

/* ── Sidebar nav items ── */
const NAV_ITEMS: { id: Section; icon: string; label: string }[] = [
  { id: "appearance", icon: "palette", label: "Appearance" },
  { id: "wifi", icon: "wifi", label: "Network" },
  { id: "ai", icon: "smart_toy", label: "AI Provider" },
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

  useEffect(() => {
    fetch("/setup-api/wifi/status").then(r => r.json()).then(d => {
      if (d.connected && d.ssid) setConnectedSSID(d.ssid);
    }).catch(() => {});
  }, []);

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

  return (
    <div className="flex h-full bg-[#0d1117]">
      {/* Sidebar */}
      <nav className="w-48 shrink-0 bg-white/[0.02] border-r border-white/5 py-3 flex flex-col">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            onClick={() => setSection(item.id)}
            className={`flex items-center gap-3 px-4 py-2.5 text-sm border-none cursor-pointer transition-colors ${
              section === item.id
                ? "bg-orange-500/10 text-orange-400 border-r-2 border-r-orange-400"
                : "text-white/50 hover:text-white/80 hover:bg-white/5"
            }`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setResetConfirm(true)}
          className="flex items-center gap-3 px-4 py-2.5 text-sm text-red-400/60 hover:text-red-400 hover:bg-red-500/5 border-none cursor-pointer transition-colors"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>restart_alt</span>
          Factory Reset
        </button>
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ─── Appearance ─── */}
        {section === "appearance" && (
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
        {section === "wifi" && (
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

            {/* Interfaces card */}
            {stats && stats.network.length > 0 && (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>lan</span>
                  <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Interfaces</label>
                </div>
                <div className="space-y-2">
                  {stats.network.map(iface => (
                    <div key={iface.name} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3.5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="material-symbols-rounded text-white/20" style={{ fontSize: 16 }}>
                          {iface.name.startsWith("wl") ? "wifi" : iface.name.startsWith("lo") ? "sync" : "settings_ethernet"}
                        </span>
                        <span className="text-xs font-mono text-white/60 font-medium">{iface.name}</span>
                      </div>
                      <span className={`text-xs font-mono ${iface.ip ? "text-white/70" : "text-white/20"}`}>{iface.ip || "no IP"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── AI Provider ─── */}
        {section === "ai" && (
          <div className="max-w-lg">
            <AIModelsStep embedded />
          </div>
        )}

        {/* ─── System ─── */}
        {section === "system" && (
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
                </div>

                {/* Storage card */}
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>hard_drive</span>
                    <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Storage</label>
                  </div>
                  <div className="space-y-3">
                    {stats.storage.map(m => (
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

                {/* Network interfaces card */}
                {stats.network.length > 0 && (
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>lan</span>
                      <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Network</label>
                    </div>
                    <div className="space-y-2">
                      {stats.network.filter(i => i.ip).map(iface => (
                        <div key={iface.name} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3.5 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="material-symbols-rounded text-white/20" style={{ fontSize: 16 }}>
                              {iface.name.startsWith("wl") ? "wifi" : "settings_ethernet"}
                            </span>
                            <span className="text-xs font-mono text-white/60 font-medium">{iface.name}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="flex gap-3 text-[10px] text-white/30">
                              <span>&#8595; <span className="font-mono text-green-400/70">{formatBytes(iface.rx)}</span></span>
                              <span>&#8593; <span className="font-mono text-orange-400/70">{formatBytes(iface.tx)}</span></span>
                            </div>
                            <span className="text-xs font-mono text-white/60">{iface.ip}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top processes — compact */}
                {stats.processes.length > 0 && (
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>memory</span>
                      <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">Top Processes</label>
                    </div>
                    <div className="space-y-1.5">
                      {[...stats.processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map((proc, i) => (
                        <div key={`${proc.pid}-${i}`} className="flex items-center gap-3 bg-white/[0.03] rounded-lg px-3 py-2">
                          <span className="text-[10px] font-mono text-white/25 w-5 text-right">{proc.pid}</span>
                          <span className="text-xs font-mono text-white/60 flex-1 truncate" title={proc.command}>{proc.command}</span>
                          <span className="text-[11px] font-mono font-semibold tabular-nums w-12 text-right" style={{ color: proc.cpu > 50 ? "#ef4444" : proc.cpu > 20 ? "#f97316" : "rgba(255,255,255,0.4)" }}>{proc.cpu.toFixed(1)}%</span>
                          <span className="text-[11px] font-mono tabular-nums w-12 text-right text-purple-400/60">{proc.mem.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center py-12 text-white/30">
                <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin mr-3" style={{ borderTopColor: "#fe6e00" }} />
                <span className="text-sm">Loading system stats...</span>
              </div>
            )}

            {/* System Update card */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 18 }}>system_update</span>
                <label className="text-xs font-semibold text-white/50 uppercase tracking-wider">System Update</label>
              </div>

              {/* Update progress (when running) */}
              {updateStarted && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-white/70 mb-2">
                    {updateState?.phase === "completed" ? <span className="text-emerald-400">Update Complete</span>
                      : updateState?.phase === "failed" ? <span className="text-red-400">Update Failed</span>
                      : "Updating..."}
                  </div>
                  {updateError && (
                    <div className="mb-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{updateError}</div>
                  )}
                  {updateState && (
                    <div className="space-y-0.5">
                      {updateState.steps.map((step) => (
                        <div key={step.id} className="flex items-center gap-2.5 py-1 px-2">
                          <UpdateStepIcon status={step.status} />
                          <span className={`flex-1 text-xs ${updateStepTextClass(step.status)}`}>{step.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {updateState?.phase === "failed" && (
                    <button type="button" onClick={triggerUpdate} className="mt-3 px-4 py-2 text-xs font-semibold text-white bg-orange-500 rounded-lg cursor-pointer hover:bg-orange-600 transition-colors">
                      Retry Update
                    </button>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={isUpdateRunning ? undefined : openUpdateConfirm}
                disabled={isUpdateRunning}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-500 hover:scale-[1.02] transition-all cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span>
                {isUpdateRunning ? "Updating..." : "Check for Updates"}
              </button>
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
                          {versionInfo.clawbox.target && versionInfo.clawbox.target !== versionInfo.clawbox.current && (
                            <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                        <span className="text-white/50 font-medium">OpenClaw</span>
                        <span className="text-white/80">
                          {versionInfo.openclaw.current ?? "not installed"}
                          {versionInfo.openclaw.target && versionInfo.openclaw.target !== versionInfo.openclaw.current && (
                            <span className="text-white/30">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                          )}
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
          </div>
        )}

        {/* ─── About ─── */}
        {section === "about" && (
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
                  <span className="text-white/80">v2.2.3</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Runtime</span>
                  <span className="text-white/80">Next.js + Bun</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Platform</span>
                  <span className="text-white/80">x64 Desktop</span>
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
          </div>
        )}
      </div>

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
