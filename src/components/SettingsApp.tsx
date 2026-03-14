"use client";

import { useState, useEffect } from "react";
import StatusMessage from "./StatusMessage";

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

interface AIProvider {
  id: string;
  name: string;
  placeholder: string;
  hint: string;
  isLocal?: boolean;
}

const AI_PROVIDERS: AIProvider[] = [
  { id: "anthropic", name: "Anthropic Claude", placeholder: "sk-ant-api03-...", hint: "console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI GPT", placeholder: "sk-...", hint: "platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", placeholder: "AIza...", hint: "aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-v1-...", hint: "openrouter.ai/keys" },
  { id: "ollama", name: "Ollama (Local)", placeholder: "", hint: "Run AI models locally", isLocal: true },
];

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


export default function SettingsApp({ ui }: SettingsAppProps) {
  const [section, setSection] = useState<Section>("appearance");

  /* ── System stats (only poll when visible) ── */
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [procSort, setProcSort] = useState<"cpu" | "mem" | "pid">("cpu");
  const [procsExpanded, setProcsExpanded] = useState(false);
  useEffect(() => {
    if (section !== "system") return;
    const poll = () => fetch("/setup-api/system/stats", { cache: "no-store" }).then(r => r.json()).then(setStats).catch(() => {});
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [section]);

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
  const [aiProvider, setAiProvider] = useState("anthropic");
  const [aiKey, setAiKey] = useState("");
  const [aiShowKey, setAiShowKey] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [configuredProvider, setConfiguredProvider] = useState<string | null>(null);

  useEffect(() => {
    fetch("/setup-api/setup/status").then(r => r.json()).then(d => {
      if (d.ai_model_provider) setConfiguredProvider(d.ai_model_provider);
    }).catch(() => {});
  }, []);

  const saveAiProvider = async () => {
    const prov = AI_PROVIDERS.find(p => p.id === aiProvider);
    if (!prov) return;
    if (!prov.isLocal && !aiKey.trim()) {
      setAiStatus({ type: "error", message: "API key required" });
      return;
    }
    setAiSaving(true);
    setAiStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          ...(prov.isLocal ? {} : { token: aiKey.trim() }),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setAiStatus({ type: "success", message: `${prov.name} configured` });
      setConfiguredProvider(aiProvider);
      setAiKey("");
    } catch (err) {
      setAiStatus({ type: "error", message: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setAiSaving(false);
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

  const selectedProv = AI_PROVIDERS.find(p => p.id === aiProvider);

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
          <div className="max-w-2xl space-y-6">
            <h2 className="text-lg font-semibold text-white/90 mb-4">Appearance</h2>

            {/* Wallpaper grid */}
            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Wallpaper</label>
              <div className="grid grid-cols-4 gap-3">
                {ui.wallpapers.map(wp => (
                  <button
                    key={wp.id}
                    onClick={() => ui.onWallpaperChange(wp.id)}
                    className={`relative rounded-xl overflow-hidden aspect-video border-2 transition-all cursor-pointer ${
                      ui.wallpaperId === wp.id ? "border-orange-400 ring-2 ring-orange-400/30" : "border-white/5 hover:border-white/20"
                    }`}
                  >
                    {wp.image ? (
                      <img src={wp.image} alt={wp.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-950" />
                    )}
                    <span className="absolute bottom-0 inset-x-0 text-[9px] text-white/80 bg-black/50 backdrop-blur-sm py-1 text-center">{wp.name}</span>
                  </button>
                ))}
                {ui.customWallpapers.map((dataUrl, i) => (
                  <button
                    key={`custom-${i}`}
                    onClick={() => ui.onWallpaperChange(`custom-${i}`)}
                    className={`relative rounded-xl overflow-hidden aspect-video border-2 transition-all cursor-pointer group ${
                      ui.wallpaperId === `custom-${i}` ? "border-orange-400 ring-2 ring-orange-400/30" : "border-white/5 hover:border-white/20"
                    }`}
                  >
                    <img src={dataUrl} alt={`Custom ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={e => { e.stopPropagation(); ui.onCustomWallpaperDelete(i); }}
                      className="absolute top-1 right-1 w-5 h-5 bg-red-500/80 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer border-none"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
                    </button>
                  </button>
                ))}
                <button
                  onClick={() => ui.onWallpaperUpload()}
                  className="rounded-xl aspect-video border-2 border-dashed border-white/10 hover:border-white/30 flex flex-col items-center justify-center gap-1.5 text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 24 }}>add_photo_alternate</span>
                  <span className="text-[10px]">Upload</span>
                </button>
              </div>
            </div>

            {/* Fit mode */}
            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Fit Mode</label>
              <div className="flex gap-1 bg-white/5 rounded-xl p-1">
                {(["fill", "fit", "center"] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => ui.onWpFitChange(mode)}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer border-none capitalize ${
                      ui.wpFit === mode ? "bg-orange-500/20 text-orange-400" : "text-white/40 hover:text-white/70"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity */}
            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
                Opacity — {ui.wpOpacity}%
              </label>
              <input
                type="range" min={0} max={100} value={ui.wpOpacity}
                onChange={e => ui.onWpOpacityChange(parseInt(e.target.value, 10))}
                className="w-full h-2 accent-orange-400 cursor-pointer"
              />
            </div>

            {/* Background color */}
            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Background Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color" value={ui.wpBgColor}
                  onChange={e => ui.onWpBgColorChange(e.target.value)}
                  className="w-10 h-10 rounded-lg cursor-pointer border border-white/10"
                />
                <span className="text-sm text-white/40 font-mono">{ui.wpBgColor}</span>
              </div>
            </div>

            <div className="border-t border-white/5 pt-5">
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
          <div className="max-w-md space-y-6">
            <h2 className="text-lg font-semibold text-white/90 mb-4">Network</h2>

            {connectedSSID && (
              <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
                <span className="material-symbols-rounded text-green-400" style={{ fontSize: 20 }}>wifi</span>
                <div>
                  <div className="text-sm text-white/90 font-medium">{connectedSSID}</div>
                  <div className="text-xs text-green-400">Connected</div>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Network Name (SSID)</label>
                <input
                  type="text" value={ssid} onChange={e => setSsid(e.target.value)}
                  placeholder="Enter WiFi network name"
                  className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white/90 outline-none focus:border-orange-400 transition-colors placeholder-white/20"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Password</label>
                <input
                  type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)}
                  placeholder="Enter WiFi password"
                  className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white/90 outline-none focus:border-orange-400 transition-colors placeholder-white/20"
                  onKeyDown={e => e.key === "Enter" && connectWifi()}
                />
              </div>
              <button
                onClick={connectWifi}
                disabled={wifiConnecting || !ssid.trim()}
                className="w-full py-2.5 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-colors"
              >
                {wifiConnecting ? "Connecting..." : "Connect"}
              </button>
              {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
            </div>

            {stats && stats.network.length > 0 && (
              <div className="border-t border-white/5 pt-5 space-y-2">
                {stats.network.map(iface => (
                  <div key={iface.name} className="flex justify-between text-sm">
                    <span className="text-white/40 font-mono">{iface.name}</span>
                    <span className="text-white/80 font-mono">{iface.ip || "no IP"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── AI Provider ─── */}
        {section === "ai" && (
          <div className="max-w-md space-y-6">
            <h2 className="text-lg font-semibold text-white/90 mb-4">AI Provider</h2>

            {configuredProvider && (
              <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
                <span className="material-symbols-rounded text-green-400" style={{ fontSize: 20 }}>check_circle</span>
                <div>
                  <div className="text-sm text-white/90 font-medium">{AI_PROVIDERS.find(p => p.id === configuredProvider)?.name || configuredProvider}</div>
                  <div className="text-xs text-green-400">Configured</div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Provider</label>
              <div className="grid grid-cols-1 gap-2">
                {AI_PROVIDERS.map(prov => (
                  <button
                    key={prov.id}
                    onClick={() => { setAiProvider(prov.id); setAiKey(""); setAiStatus(null); }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors cursor-pointer text-left ${
                      aiProvider === prov.id
                        ? "bg-orange-500/10 border-orange-400/40 text-white/90"
                        : "bg-white/[0.02] border-white/5 text-white/50 hover:text-white/70 hover:border-white/10"
                    }`}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                      {prov.isLocal ? "computer" : "key"}
                    </span>
                    <div>
                      <div className="text-sm font-medium">{prov.name}</div>
                      <div className="text-[10px] text-white/30">{prov.hint}</div>
                    </div>
                    {configuredProvider === prov.id && (
                      <span className="ml-auto material-symbols-rounded text-green-400" style={{ fontSize: 16 }}>check</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {selectedProv && !selectedProv.isLocal && (
              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">API Key</label>
                <input
                  type={aiShowKey ? "text" : "password"}
                  value={aiKey}
                  onChange={e => setAiKey(e.target.value)}
                  placeholder={selectedProv.placeholder}
                  className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white/90 outline-none focus:border-orange-400 transition-colors placeholder-white/20 font-mono"
                  onKeyDown={e => e.key === "Enter" && saveAiProvider()}
                />
                <button
                  onClick={() => setAiShowKey(!aiShowKey)}
                  className="mt-1 text-[10px] text-white/30 hover:text-white/50 bg-transparent border-none cursor-pointer"
                >
                  {aiShowKey ? "Hide" : "Show"} key
                </button>
              </div>
            )}

            <button
              onClick={saveAiProvider}
              disabled={aiSaving || (!selectedProv?.isLocal && !aiKey.trim())}
              className="w-full py-2.5 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-colors"
            >
              {aiSaving ? "Saving..." : "Save Provider"}
            </button>
            {aiStatus && <StatusMessage type={aiStatus.type} message={aiStatus.message} />}
          </div>
        )}

        {/* ─── System ─── */}
        {section === "system" && (
          <div className="max-w-3xl space-y-6">
            <h2 className="text-lg font-semibold text-white/90 mb-4">System Monitor</h2>

            {stats ? (() => {
              const sortedProcs = [...stats.processes].sort((a, b) => (b[procSort] as number) - (a[procSort] as number));
              const visibleProcs = procsExpanded ? sortedProcs : sortedProcs.slice(0, 5);
              return (
                <>
                  {/* Overview */}
                  <div className="bg-white/5 rounded-xl p-4 grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
                    <div><span className="text-white/40">Hostname</span><div className="text-white/90 font-mono">{stats.overview.hostname}</div></div>
                    <div><span className="text-white/40">OS</span><div className="text-white/90 font-mono text-xs">{stats.overview.os}</div></div>
                    <div><span className="text-white/40">Uptime</span><div className="text-cyan-400 font-semibold">{stats.overview.uptime}</div></div>
                    <div><span className="text-white/40">Kernel</span><div className="text-white/90 font-mono text-xs">{stats.overview.kernel}</div></div>
                    <div><span className="text-white/40">Arch</span><div className="text-white/90">{stats.overview.arch}</div></div>
                    <div><span className="text-white/40">Platform</span><div className="text-white/90">{stats.overview.platform}</div></div>
                  </div>

                  {/* CPU + Memory row */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">CPU</span>
                        <span className="text-2xl font-bold font-mono" style={{ color: barColor(stats.cpu.usage) }}>{stats.cpu.usage}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-white/5 mb-3 overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.cpu.usage}%`, backgroundColor: barColor(stats.cpu.usage), boxShadow: `0 0 6px ${barColor(stats.cpu.usage)}80` }} />
                      </div>
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between"><span className="text-white/40">Model</span><span className="text-white/70 font-mono text-[10px] text-right max-w-[200px] truncate">{stats.cpu.model}</span></div>
                        <div className="flex justify-between"><span className="text-white/40">Cores</span><span className="text-white/80">{stats.cpu.cores}</span></div>
                        <div className="flex justify-between"><span className="text-white/40">Speed</span><span className="text-white/80">{stats.cpu.speed} MHz</span></div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-white/5 flex gap-3">
                        {["1m","5m","15m"].map((label, i) => (
                          <div key={label} className="flex-1 text-center">
                            <div className="text-xs font-mono font-semibold text-white/80">{stats.cpu.loadAvg[i]}</div>
                            <div className="text-[10px] text-white/30">{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-white/5 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Memory</span>
                        <span className="text-xs font-mono text-white/60">{formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-white/5 mb-1 overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.usedPercent}%`, backgroundColor: barColor(stats.memory.usedPercent), boxShadow: `0 0 6px ${barColor(stats.memory.usedPercent)}80` }} />
                      </div>
                      <div className="text-right text-[10px] text-white/30 mb-3">{stats.memory.usedPercent}% used &middot; {formatBytes(stats.memory.free)} free</div>
                      {stats.memory.swap.total > 0 && (
                        <>
                          <div className="flex justify-between text-xs mb-1"><span className="text-white/40">Swap</span><span className="text-white/60 font-mono">{formatBytes(stats.memory.swap.used)} / {formatBytes(stats.memory.swap.total)}</span></div>
                          <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.swap.percent}%`, backgroundColor: "#a855f7" }} />
                          </div>
                          <div className="text-right text-[10px] text-white/30 mt-1">{stats.memory.swap.percent}% used</div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Storage + Network row */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white/5 rounded-xl p-4">
                      <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider block mb-3">Storage</span>
                      <div className="space-y-3">
                        {stats.storage.map(m => (
                          <div key={m.mountpoint}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-white/80 font-mono">{m.mountpoint}</span>
                              <span className="text-white/40 font-mono text-[10px]">{m.used} / {m.size}</span>
                            </div>
                            <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${m.usePercent}%`, backgroundColor: barColor(m.usePercent) }} />
                            </div>
                            <div className="flex justify-between text-[10px] text-white/30 mt-0.5">
                              <span>{m.filesystem}</span>
                              <span>{m.usePercent}% &middot; {m.avail} free</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-white/5 rounded-xl p-4">
                      <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider block mb-3">Network</span>
                      <div className="space-y-2">
                        {stats.network.map(iface => (
                          <div key={iface.name} className="bg-white/5 rounded-lg px-3 py-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-semibold font-mono text-cyan-400">{iface.name}</span>
                              <span className="text-[10px] font-mono text-white/60">{iface.ip || "no IP"}</span>
                            </div>
                            <div className="flex gap-4 text-[10px] text-white/40">
                              <span>&darr; <span className="font-mono text-green-400">{formatBytes(iface.rx)}</span></span>
                              <span>&uarr; <span className="font-mono text-orange-400">{formatBytes(iface.tx)}</span></span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Processes */}
                  <div className="bg-white/5 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Processes</span>
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1">
                          {(["cpu","mem","pid"] as const).map(key => (
                            <button key={key} onClick={() => setProcSort(key)}
                              className="text-[10px] px-2 py-0.5 rounded transition-colors border-none cursor-pointer"
                              style={{ backgroundColor: procSort === key ? "#06b6d4" : "rgba(255,255,255,0.05)", color: procSort === key ? "#000" : "#a0a0b0", fontWeight: procSort === key ? 700 : 400 }}
                            >{key.toUpperCase()}</button>
                          ))}
                        </div>
                        <button onClick={() => setProcsExpanded(!procsExpanded)}
                          className="text-[10px] px-2 py-0.5 rounded transition-colors border-none cursor-pointer hover:bg-white/10"
                          style={{ color: "#06b6d4" }}
                        >{procsExpanded ? "Show less" : `All (${stats.processes.length})`}</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto" style={{ maxHeight: procsExpanded ? 240 : undefined, overflowY: procsExpanded ? "auto" : undefined }}>
                      <table className="w-full text-[10px]">
                        <thead><tr className="text-white/30">
                          <th className="text-left pb-1 pr-2 font-medium">PID</th>
                          <th className="text-left pb-1 pr-2 font-medium">USER</th>
                          <th className="text-right pb-1 pr-2 font-medium">CPU%</th>
                          <th className="text-right pb-1 pr-2 font-medium">MEM%</th>
                          <th className="text-left pb-1 font-medium">COMMAND</th>
                        </tr></thead>
                        <tbody>
                          {visibleProcs.map((proc, i) => (
                            <tr key={`${proc.pid}-${i}`} className="border-t border-white/5">
                              <td className="py-0.5 pr-2 font-mono text-white/60">{proc.pid}</td>
                              <td className="py-0.5 pr-2 font-mono text-white/60 truncate max-w-[60px]">{proc.user}</td>
                              <td className="py-0.5 pr-2 text-right font-mono font-semibold" style={{ color: proc.cpu > 50 ? "#ef4444" : proc.cpu > 20 ? "#f97316" : "#06b6d4" }}>{proc.cpu.toFixed(1)}</td>
                              <td className="py-0.5 pr-2 text-right font-mono" style={{ color: "#a855f7" }}>{proc.mem.toFixed(1)}</td>
                              <td className="py-0.5 font-mono text-white/60 truncate max-w-[200px]" title={proc.command}>{proc.command}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              );
            })() : (
              <div className="flex items-center justify-center py-12 text-white/30">
                <span className="material-symbols-rounded animate-spin mr-2" style={{ fontSize: 20 }}>progress_activity</span>
                Loading system stats...
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
