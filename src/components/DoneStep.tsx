"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { StepStatus, UpdateState } from "@/lib/updater";
import StatusMessage from "./StatusMessage";
import SignalBars from "./SignalBars";

/* ── Types ── */

interface SystemInfo {
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  temperature: string;
  temperatureValue: number | null;
  uptime: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
  diskUsedPercent: number;
  gpuLoadPercent: number;
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
}

interface StatsSnapshot {
  cpu: number;
  gpu: number;
  memory: number;
  temp: number | null;
  rxBytes: number;
  txBytes: number;
  time: number;
}

interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
}

interface DoneStepProps {
  setupComplete?: boolean;
}

interface SectionStatusMessage {
  type: "success" | "error";
  message: string;
}

/* ── Constants ── */

const MAX_HISTORY = 30;

const INPUT_CLASS =
  "w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";

const INPUT_WITH_TOGGLE_CLASS = `${INPUT_CLASS} pr-10`;

const SAVE_BUTTON_CLASS =
  "px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50";

const TOGGLE_BUTTON_CLASS =
  "absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5";

const SECTION_HEADER_CLASS =
  "flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-[var(--text-primary)] hover:text-gray-100 hover:bg-[var(--bg-surface)]/30 bg-transparent border-none cursor-pointer text-left transition-colors";

const SECTION_BODY_CLASS =
  "px-5 pb-5 border-t border-[var(--border-subtle)]/30 pt-4 space-y-4";

const LABEL_CLASS =
  "block text-xs font-semibold text-[var(--text-secondary)] mb-1.5";

const WIDGET_LABEL_CLASS =
  "text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider";

const AI_PROVIDERS = [
  { id: "anthropic", name: "Anthropic Claude", hasSubscription: true, placeholder: "sk-ant-api03-...", hint: "Get your API key from console.anthropic.com", tokenUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI GPT", hasSubscription: false, placeholder: "sk-...", hint: "Get your API key from platform.openai.com", tokenUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", hasSubscription: false, placeholder: "AIza...", hint: "Get your API key from Google AI Studio.", tokenUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", hasSubscription: false, placeholder: "sk-or-v1-...", hint: "Get your API key from OpenRouter.", tokenUrl: "https://openrouter.ai/keys" },
];

/* ── Helper functions ── */

function thresholdColor(value: number, low: number, high: number): string {
  if (value > high) return "#ef4444";
  if (value > low) return "#f59e0b";
  return "#00e5cc";
}

/* ── Shared SVG icons ── */

const EyeOpen = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
);
const EyeClosed = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
);

/* ── Reusable components ── */

function UsageBar({ percent, color = "var(--coral-bright)" }: { percent: number; color?: string }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-[var(--bg-deep)] mt-2 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function Sparkline({ data, color = "var(--coral-bright)", height = 32 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 120;
  const h = height;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - (v / max) * (h - 4) - 2}`).join(" ");
  const fillPoints = `0,${h} ${points} ${(data.length - 1) * step},${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      <polygon points={fillPoints} fill={color} opacity="0.1" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SectionBadge({ done }: { done: boolean }) {
  if (done) {
    return (
      <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-[#00e5cc] uppercase tracking-wide">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        Done
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-amber-400 uppercase tracking-wide">
      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      Pending
    </span>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  visible,
  onToggle,
  placeholder,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className={INPUT_WITH_TOGGLE_CLASS}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? "Hide" : "Show"}
        className={TOGGLE_BUTTON_CLASS}
      >
        {visible ? EyeClosed : EyeOpen}
      </button>
    </div>
  );
}

function CollapsibleSection({
  id,
  title,
  done,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  done: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card-surface rounded-xl overflow-hidden">
      <button type="button" onClick={() => onToggle(id)} className={SECTION_HEADER_CLASS}>
        <Chevron open={open} />
        {title}
        <SectionBadge done={done} />
      </button>
      {open && <div className={SECTION_BODY_CLASS}>{children}</div>}
    </div>
  );
}

function SystemInfoWidget({
  label,
  detail,
  value,
  unit,
  bar,
  className,
}: {
  label: string;
  detail?: string;
  value: string;
  unit?: string;
  bar?: { percent: number; color: string };
  className?: string;
}) {
  return (
    <div className={`card-surface rounded-xl p-3.5 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-1">
        <p className={WIDGET_LABEL_CLASS}>{label}</p>
        {detail && <p className="text-[10px] font-semibold text-[var(--text-muted)]">{detail}</p>}
      </div>
      <p className="text-lg font-bold text-gray-100">
        {value}
        {unit && <span className="text-xs font-normal text-[var(--text-muted)]">{unit}</span>}
      </p>
      {bar && <UsageBar percent={bar.percent} color={bar.color} />}
    </div>
  );
}

function SparklineWidget({
  label,
  currentValue,
  data,
  color,
}: {
  label: string;
  currentValue: string;
  data: number[];
  color: string;
}) {
  return (
    <div className="card-surface rounded-xl p-3.5">
      <div className="flex items-center justify-between mb-2">
        <p className={WIDGET_LABEL_CLASS}>{label}</p>
        <p className="text-[10px] font-bold text-gray-300">{currentValue}</p>
      </div>
      <Sparkline data={data} color={color} height={36} />
    </div>
  );
}

/* ── Update step helpers ── */

function updateStepTextClass(status: StepStatus): string {
  switch (status) {
    case "running": return "text-[var(--coral-bright)] font-medium";
    case "completed": return "text-[var(--text-secondary)]";
    case "failed": return "text-red-400";
    default: return "text-[var(--text-muted)]";
  }
}

function UpdateStepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <div className="spinner !w-4 !h-4 !border-2" />;
  }
  if (status === "completed") {
    return (
      <div className="w-4 h-4 rounded-full bg-[#00e5cc] flex items-center justify-center text-white text-[10px] font-bold">
        &#10003;
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-[10px] font-bold">
        &#10005;
      </div>
    );
  }
  return <div className="w-4 h-4 rounded-full bg-gray-600" />;
}

function UpdateProgressHeading({ phase }: { phase: UpdateState["phase"] | undefined }) {
  if (phase === "completed") return <span className="text-[#00e5cc]">Update Complete</span>;
  if (phase === "failed") return <span className="text-red-400">Update Failed</span>;
  return <>System Update</>;
}

/* ── Main component ── */

export default function DoneStep({ setupComplete = false }: DoneStepProps) {
  /* ── System info ── */
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statsHistory, setStatsHistory] = useState<StatsSnapshot[]>([]);
  const statsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Finish ── */
  const [finishing, setFinishing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  /* ── System update ── */
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);

  /* ── Collapsible sections ── */
  const [openSection, setOpenSection] = useState<string | null>(null);
  const toggle = (id: string) => setOpenSection((prev) => (prev === id ? null : id));

  /* ── AI Provider ── */
  const [aiProvider, setAiProvider] = useState<string>("anthropic");
  const [aiAuthMode, setAiAuthMode] = useState<"token" | "subscription">("subscription");
  const [aiApiKey, setAiApiKey] = useState("");
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<SectionStatusMessage | null>(null);
  const [aiOauthStarted, setAiOauthStarted] = useState(false);
  const [aiAuthCode, setAiAuthCode] = useState("");
  const [aiExchanging, setAiExchanging] = useState(false);
  const [providerDone, setProviderDone] = useState(false);
  const [providerName, setProviderName] = useState<string | null>(null);

  /* ── Security (system password + hotspot) ── */
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [secSaving, setSecSaving] = useState(false);
  const [secStatus, setSecStatus] = useState<SectionStatusMessage | null>(null);

  /* ── Confirmations ── */
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  /* ── Telegram ── */
  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgStatus, setTgStatus] = useState<SectionStatusMessage | null>(null);

  /* ── WiFi ── */
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[] | null>(null);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [wifiConnectedSSID, setWifiConnectedSSID] = useState<string | null>(null);
  const [wifiSelectedSSID, setWifiSelectedSSID] = useState<string | null>(null);
  const [wifiSelectedSecurity, setWifiSelectedSecurity] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<SectionStatusMessage | null>(null);

  /* ── Section completion status ── */
  const [securityDone, setSecurityDone] = useState(false);
  const [telegramDone, setTelegramDone] = useState(false);

  const selectedAiProvider = AI_PROVIDERS.find((p) => p.id === aiProvider);
  const isAiSubscription = aiProvider === "anthropic" && aiAuthMode === "subscription";
  const isUpdateRunning = updateStarted && updateState?.phase === "running";

  /* ── Fetch section status on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/setup/status", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          setSecurityDone(!!data.password_configured);
          setTelegramDone(!!data.telegram_configured);
          setProviderDone(!!data.ai_model_configured);
          if (data.ai_model_provider) setProviderName(data.ai_model_provider);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Fetch system info on mount + poll every 5s ── */
  useEffect(() => {
    let alive = true;
    const fetchInfo = async () => {
      try {
        const r = await fetch("/setup-api/system/info");
        if (!r.ok) throw new Error("Failed to load");
        const data: SystemInfo = await r.json();
        if (!alive) return;
        setInfo(data);
        setStatsHistory((prev) => {
          const next = [...prev, { cpu: data.cpuLoadPercent, gpu: data.gpuLoadPercent, memory: data.memoryUsedPercent, temp: data.temperatureValue, rxBytes: data.networkRxBytes, txBytes: data.networkTxBytes, time: Date.now() }];
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      } catch {
        if (!alive) return;
        setLoadError(true);
      }
    };
    fetchInfo();
    statsPollRef.current = setInterval(fetchInfo, 5000);
    return () => {
      alive = false;
      if (statsPollRef.current) clearInterval(statsPollRef.current);
    };
  }, []);

  /* ── Fetch hotspot defaults on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted && data.ssid) {
          setHotspotName(data.ssid);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Fetch current WiFi connection on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/wifi/status", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted && data["GENERAL.CONNECTION"]) {
          setWifiConnectedSSID(data["GENERAL.CONNECTION"]);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Update polling ── */
  const stopUpdatePolling = useCallback(() => {
    if (updatePollRef.current) {
      clearInterval(updatePollRef.current);
      updatePollRef.current = null;
    }
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
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          failureCount++;
          if (failureCount >= 3) serverWentDown = true;
          return;
        }
        if (serverWentDown) {
          window.location.reload();
          return;
        }
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

  /* ── Actions ── */

  const triggerUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(typeof data.error === "string" ? data.error : "Failed to start update");
        return;
      }
      startUpdatePolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Failed to start update");
    }
  };

  const completeSetup = async () => {
    setFinishing(true);
    setCompleteError(null);
    try {
      const res = await fetch("/setup-api/setup/complete", { method: "POST" });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setCompleteError(data.error || "Failed to complete setup");
    } catch (err) {
      setCompleteError(err instanceof Error ? err.message : "Failed to complete setup");
    } finally {
      setFinishing(false);
    }
  };

  const saveSecurity = async () => {
    if (password || confirmPassword) {
      if (password.length < 8) {
        setSecStatus({ type: "error", message: "Password must be at least 8 characters" });
        return;
      }
      if (password !== confirmPassword) {
        setSecStatus({ type: "error", message: "Passwords do not match" });
        return;
      }
    }
    if (!hotspotName.trim()) {
      setSecStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (hotspotPassword && hotspotPassword.length < 8) {
      setSecStatus({ type: "error", message: "Hotspot password must be at least 8 characters" });
      return;
    }

    setSecSaving(true);
    setSecStatus(null);
    try {
      if (password) {
        const res = await fetch("/setup-api/system/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setSecStatus({ type: "error", message: data.error || "Failed to set password" });
          return;
        }
      }
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotName.trim(),
          password: hotspotPassword || undefined,
        }),
      });
      if (!hotspotRes.ok) {
        const data = await hotspotRes.json().catch(() => ({}));
        setSecStatus({ type: "error", message: data.error || "Failed to save hotspot settings" });
        return;
      }
      setSecStatus({ type: "success", message: "Settings saved!" });
      if (password) setSecurityDone(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setSecStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setSecSaving(false);
    }
  };

  const saveTelegram = async () => {
    if (!botToken.trim()) {
      setTgStatus({ type: "error", message: "Please enter a bot token" });
      return;
    }
    setTgSaving(true);
    setTgStatus(null);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTgStatus({ type: "error", message: data.error || "Failed to save" });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setTgStatus({ type: "success", message: "Telegram bot configured!" });
        setTelegramDone(true);
      } else {
        setTgStatus({ type: "error", message: data.error || "Failed to save" });
      }
    } catch (err) {
      setTgStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setTgSaving(false);
    }
  };

  const resetAiFields = () => {
    setAiApiKey("");
    setShowAiKey(false);
    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
  };

  const saveAiProvider = async () => {
    if (!aiApiKey.trim()) {
      setAiStatus({ type: "error", message: "Please enter your API key" });
      return;
    }
    setAiSaving(true);
    setAiStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey.trim(), authMode: aiAuthMode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setAiStatus({ type: "success", message: "AI provider configured!" });
        setProviderDone(true);
        setProviderName(aiProvider);
        setAiApiKey("");
      } else {
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
      }
    } catch (err) {
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      setAiSaving(false);
    }
  };

  const startAiOAuth = async () => {
    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to start OAuth" });
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
        setAiOauthStarted(true);
      }
    } catch (err) {
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    }
  };

  const exchangeAiCode = async () => {
    if (!aiAuthCode.trim()) {
      setAiStatus({ type: "error", message: "Please paste the authorization code" });
      return;
    }
    setAiExchanging(true);
    setAiStatus(null);
    try {
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: aiAuthCode.trim() }),
      });
      if (!exchangeRes.ok) {
        const data = await exchangeRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Token exchange failed" });
        return;
      }
      const tokenData = await exchangeRes.json();
      if (!tokenData.access_token) {
        setAiStatus({ type: "error", message: "No access token received" });
        return;
      }
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", apiKey: tokenData.access_token, authMode: "subscription", refreshToken: tokenData.refresh_token, expiresIn: tokenData.expires_in }),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to save token" });
        return;
      }
      const saveData = await saveRes.json();
      if (saveData.success) {
        setAiStatus({ type: "success", message: "Claude subscription connected!" });
        setProviderDone(true);
        setProviderName("anthropic");
        setAiOauthStarted(false);
        setAiAuthCode("");
      } else {
        setAiStatus({ type: "error", message: saveData.error || "Failed to save token" });
      }
    } catch (err) {
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      setAiExchanging(false);
    }
  };

  const scanWifi = async () => {
    setWifiScanning(true);
    setWifiNetworks(null);
    try {
      const res = await fetch("/setup-api/wifi/scan");
      if (!res.ok) throw new Error("Scan failed");
      const data = await res.json();
      setWifiNetworks(data.networks || []);
    } catch {
      setWifiNetworks([]);
    } finally {
      setWifiScanning(false);
    }
  };

  const connectWifi = async () => {
    setWifiConnecting(true);
    setWifiStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: wifiSelectedSSID, password: wifiPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setWifiStatus({ type: "error", message: data.error || "Connection failed" });
        return;
      }
      setWifiStatus({ type: "success", message: "Connected!" });
      setWifiConnectedSSID(wifiSelectedSSID);
      setWifiSelectedSSID(null);
      setWifiPassword("");
    } catch (err) {
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setWifiStatus({ type: "error", message: "Lost connection. Reconnect to your WiFi and visit http://clawbox.local" });
        return;
      }
      setWifiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      setWifiConnecting(false);
    }
  };

  const resetSetup = async () => {
    setResetting(true);
    try {
      const res = await fetch("/setup-api/setup/reset", { method: "POST" });
      if (res.ok) {
        window.location.href = "/setup";
        return;
      }
      setCompleteError("Failed to reset setup");
    } catch {
      setCompleteError("Failed to reset setup");
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  };

  /* ── Render ── */

  return (
    <div className="w-full max-w-2xl mx-auto">
      {completeError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{completeError}</div>
      )}

      {/* Primary actions */}
      <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            type="button"
            onClick={setupComplete ? () => (window.location.href = "/") : completeSetup}
            disabled={finishing}
            className="py-3 btn-gradient text-white rounded-xl text-sm font-semibold transition transform cursor-pointer hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2"/><path d="M8 12c0-2.2 1.8-4 4-4"/><path d="M16 12c0 2.2-1.8 4-4 4"/><circle cx="12" cy="12" r="1.5"/></svg>
            {finishing ? "Finishing..." : setupComplete ? "OpenClaw" : "Finish Setup"}
          </button>
          <a
            href="https://t.me/ClawBoxSupportBot"
            target="_blank"
            rel="noopener noreferrer"
            className="py-3 bg-[#0088cc] text-white rounded-xl text-sm font-semibold hover:bg-[#006daa] transition-all cursor-pointer flex items-center justify-center gap-2 hover:scale-105 shadow-lg shadow-[rgba(0,136,204,0.25)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
            ClawBox Agent
          </a>
          <button
            type="button"
            onClick={isUpdateRunning ? undefined : () => setUpdateConfirm(true)}
            disabled={isUpdateRunning}
            className="py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-500 hover:scale-105 transition-all cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            {isUpdateRunning ? "Updating..." : "System Update"}
          </button>
          <button
            type="button"
            onClick={() => setResetConfirm(true)}
            className="py-3 bg-red-500/10 text-red-400 rounded-xl text-sm font-semibold hover:bg-red-500/20 hover:scale-105 transition-all cursor-pointer flex items-center justify-center gap-2 border border-red-500/20"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Reset Setup
          </button>
      </div>

      {/* Update confirmation popup */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-100 mb-2">System Update</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-5 leading-relaxed">
              This will pull the latest updates and restart the device. The process may take a few minutes.
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                type="button"
                onClick={() => setUpdateConfirm(false)}
                className="px-5 py-2.5 bg-[var(--bg-surface)] text-[var(--text-primary)] border border-gray-600 rounded-lg text-sm font-semibold cursor-pointer hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setUpdateConfirm(false); triggerUpdate(); }}
                className="px-5 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer hover:scale-105 transition-transform"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation popup */}
      {resetConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-100 mb-2">Reset Setup?</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-5 leading-relaxed">
              This will clear all setup progress and restart the wizard from the beginning. Your credentials and tokens will be kept.
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                type="button"
                onClick={() => setResetConfirm(false)}
                disabled={resetting}
                className="px-5 py-2.5 bg-[var(--bg-surface)] text-[var(--text-primary)] border border-gray-600 rounded-lg text-sm font-semibold cursor-pointer hover:bg-gray-600 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={resetSetup}
                disabled={resetting}
                className="px-5 py-2.5 bg-red-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {resetting ? "Resetting..." : "Reset"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* System Update Progress */}
      {updateStarted && (
        <div className="mb-4 card-surface rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            <UpdateProgressHeading phase={updateState?.phase} />
          </h3>
          {updateError && (
            <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{updateError}</div>
          )}
          {updateState && (
            <div className="space-y-0.5">
              {updateState.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2.5 py-1.5 px-2">
                  <UpdateStepIcon status={step.status} />
                  <span className={`flex-1 text-xs ${updateStepTextClass(step.status)}`}>{step.label}</span>
                </div>
              ))}
            </div>
          )}
          {updateState?.phase === "failed" && (
            <button type="button" onClick={triggerUpdate} className={`mt-3 ${SAVE_BUTTON_CLASS} text-xs`}>Retry Update</button>
          )}
        </div>
      )}

      {/* Settings sections */}
      <div className="space-y-3 mb-6">
        {/* WiFi */}
        <CollapsibleSection id="wifi" title="WiFi" done={!!wifiConnectedSSID} open={openSection === "wifi"} onToggle={(id) => { toggle(id); if (openSection !== "wifi") scanWifi(); }}>
          {wifiConnectedSSID && (
            <p className="text-xs text-[var(--text-muted)]">
              Connected to: <span className="text-[var(--text-secondary)] font-semibold">{wifiConnectedSSID}</span>
            </p>
          )}
          <div className="border border-[var(--border-subtle)] rounded-lg max-h-[240px] overflow-y-auto bg-[var(--bg-deep)]/50">
            {wifiScanning && (
              <div className="flex items-center justify-center gap-2.5 p-5 text-[var(--text-secondary)] text-sm">
                <div className="spinner" /> Scanning...
              </div>
            )}
            {!wifiScanning && wifiNetworks?.length === 0 && (
              <div className="p-5 text-center text-[var(--text-secondary)] text-sm">
                No networks found.{" "}
                <button type="button" onClick={scanWifi} className="text-[var(--coral-bright)] underline bg-transparent border-none cursor-pointer">Retry</button>
              </div>
            )}
            {!wifiScanning && wifiNetworks?.map((n) => {
              const bars = Math.min(4, Math.max(1, Math.ceil(n.signal / 25)));
              const isConnected = n.ssid === wifiConnectedSSID;
              return (
                <button
                  type="button"
                  key={n.ssid}
                  onClick={() => { setWifiSelectedSSID(n.ssid); setWifiSelectedSecurity(n.security || ""); setWifiPassword(""); setShowWifiPassword(false); setWifiStatus(null); }}
                  className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer border-b border-gray-800 last:border-b-0 hover:bg-[var(--surface-card)] transition-colors w-full text-left bg-transparent border-x-0 border-t-0 ${isConnected ? "bg-[var(--surface-card)]" : ""}`}
                >
                  <SignalBars level={bars} />
                  <span className="flex-1 text-sm font-medium text-gray-200">{n.ssid}</span>
                  {isConnected && <span className="text-[10px] font-semibold text-[#00e5cc] uppercase">Connected</span>}
                  {n.security && n.security !== "--" && <span className="text-sm shrink-0 text-[var(--text-muted)]">&#128274;</span>}
                </button>
              );
            })}
          </div>
          {!wifiScanning && wifiNetworks && (
            <button type="button" onClick={scanWifi} className="text-xs text-[var(--coral-bright)] underline bg-transparent border-none cursor-pointer p-0">Rescan</button>
          )}
          {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
        </CollapsibleSection>

        {/* WiFi password modal */}
        {wifiSelectedSSID && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
              <h3 className="text-lg font-bold text-gray-100 mb-2">Connect to {wifiSelectedSSID}</h3>
              {wifiSelectedSecurity && wifiSelectedSecurity !== "--" && (
                <div className="mt-3">
                  <label htmlFor="wifi-pw-dash" className={LABEL_CLASS}>Password</label>
                  <PasswordInput
                    id="wifi-pw-dash"
                    value={wifiPassword}
                    onChange={setWifiPassword}
                    visible={showWifiPassword}
                    onToggle={() => setShowWifiPassword((v) => !v)}
                    placeholder="Enter WiFi password"
                    autoComplete="off"
                  />
                </div>
              )}
              {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
              <div className="flex items-center gap-3 mt-5 justify-end">
                <button
                  type="button"
                  onClick={() => { setWifiSelectedSSID(null); setWifiStatus(null); }}
                  disabled={wifiConnecting}
                  className="px-5 py-2.5 bg-[var(--bg-surface)] text-[var(--text-primary)] border border-gray-600 rounded-lg text-sm font-semibold cursor-pointer hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={connectWifi}
                  disabled={wifiConnecting}
                  className={`${SAVE_BUTTON_CLASS} hover:scale-105 transition-transform`}
                >
                  {wifiConnecting ? "Connecting..." : "Connect"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* AI Provider */}
        <CollapsibleSection id="provider" title="AI Provider" done={providerDone} open={openSection === "provider"} onToggle={toggle}>
          {providerDone && providerName && (
            <p className="text-xs text-[var(--text-muted)]">
              Currently configured: <span className="text-[var(--text-secondary)] font-semibold capitalize">{AI_PROVIDERS.find((p) => p.id === providerName)?.name || providerName}</span>
            </p>
          )}
          <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden">
            {AI_PROVIDERS.map((provider) => {
              const isSelected = aiProvider === provider.id;
              return (
                <label
                  key={provider.id}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer ${isSelected ? "bg-orange-500/5" : "hover:bg-[var(--surface-card)]"}`}
                >
                  <input
                    type="radio"
                    name="ai-provider-dash"
                    value={provider.id}
                    checked={isSelected}
                    onChange={() => {
                      setAiProvider(provider.id);
                      setAiAuthMode(provider.hasSubscription ? "subscription" : "token");
                      resetAiFields();
                    }}
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${isSelected ? "border-[var(--coral-bright)]" : "border-gray-600"}`}>
                    {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-[var(--coral-bright)]" />}
                  </span>
                  <span className="text-sm font-medium text-gray-200">{provider.name}</span>
                </label>
              );
            })}
          </div>

          {selectedAiProvider?.hasSubscription && (
            <div className="flex gap-1 p-1 bg-[var(--bg-deep)] rounded-lg">
              {(["subscription", "token"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setAiAuthMode(mode);
                    resetAiFields();
                  }}
                  className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer border-none ${
                    aiAuthMode === mode
                      ? "bg-[var(--bg-surface)] text-gray-200"
                      : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {mode === "subscription" ? "Subscription" : "API Key"}
                </button>
              ))}
            </div>
          )}

          {isAiSubscription ? (
            <div>
              <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">Connect your Claude Pro or Max subscription via OAuth.</p>
              {!aiOauthStarted ? (
                <button type="button" onClick={startAiOAuth} className={SAVE_BUTTON_CLASS}>Connect with Claude</button>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg">
                    <p className="text-xs text-[var(--text-primary)] leading-relaxed">
                      <strong className="text-[var(--coral-bright)]">1.</strong> Authorize in the browser tab.<br />
                      <strong className="text-[var(--coral-bright)]">2.</strong> Copy the authorization code.<br />
                      <strong className="text-[var(--coral-bright)]">3.</strong> Paste it below.
                    </p>
                  </div>
                  <div>
                    <label htmlFor="ai-oauth-code" className={LABEL_CLASS}>Authorization Code</label>
                    <input
                      id="ai-oauth-code"
                      type="text"
                      value={aiAuthCode}
                      onChange={(e) => setAiAuthCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") exchangeAiCode(); }}
                      placeholder="Paste code here..."
                      spellCheck={false}
                      autoComplete="off"
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={exchangeAiCode} disabled={aiExchanging || !aiAuthCode.trim()} className={SAVE_BUTTON_CLASS}>{aiExchanging ? "Connecting..." : "Save"}</button>
                    <button type="button" onClick={startAiOAuth} className="bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0">Restart authorization</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              {selectedAiProvider?.tokenUrl && (
                <a href={selectedAiProvider.tokenUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 mb-3 text-xs font-medium text-[var(--coral-bright)] hover:text-orange-300 transition-colors">
                  Get API Key
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              )}
              <label htmlFor="ai-key-dash" className={LABEL_CLASS}>{selectedAiProvider?.name} API Key</label>
              <PasswordInput
                id="ai-key-dash"
                value={aiApiKey}
                onChange={setAiApiKey}
                visible={showAiKey}
                onToggle={() => setShowAiKey((v) => !v)}
                placeholder={selectedAiProvider?.placeholder}
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">{selectedAiProvider?.hint}</p>
              <button type="button" onClick={saveAiProvider} disabled={aiSaving} className={`mt-3 ${SAVE_BUTTON_CLASS}`}>{aiSaving ? "Saving..." : "Save"}</button>
            </div>
          )}

          {aiStatus && <StatusMessage type={aiStatus.type} message={aiStatus.message} />}
        </CollapsibleSection>

        {/* Security */}
        <CollapsibleSection id="security" title="Security" done={securityDone} open={openSection === "security"} onToggle={toggle}>
          <p className="text-xs text-[var(--text-muted)]">Set system password and configure hotspot for next setup.</p>
          <div>
            <label htmlFor="sec-pw" className={LABEL_CLASS}>New Password</label>
            <PasswordInput
              id="sec-pw"
              value={password}
              onChange={setPassword}
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              placeholder="Minimum 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label htmlFor="sec-pw2" className={LABEL_CLASS}>Confirm Password</label>
            <PasswordInput
              id="sec-pw2"
              value={confirmPassword}
              onChange={setConfirmPassword}
              visible={showConfirm}
              onToggle={() => setShowConfirm((v) => !v)}
              placeholder="Re-enter password"
              autoComplete="new-password"
            />
          </div>
          <div className="border-t border-[var(--border-subtle)] pt-3">
            <label htmlFor="hs-name" className={LABEL_CLASS}>Hotspot Name</label>
            <input id="hs-name" type="text" value={hotspotName} onChange={(e) => setHotspotName(e.target.value)} maxLength={32} className={INPUT_CLASS} />
          </div>
          <div>
            <label htmlFor="hs-pw" className={LABEL_CLASS}>Hotspot Password <span className="text-[var(--text-muted)] font-normal">(optional)</span></label>
            <PasswordInput
              id="hs-pw"
              value={hotspotPassword}
              onChange={setHotspotPassword}
              visible={showHotspotPassword}
              onToggle={() => setShowHotspotPassword((v) => !v)}
              placeholder="Leave empty for open network"
            />
          </div>
          {secStatus && <StatusMessage type={secStatus.type} message={secStatus.message} />}
          <button type="button" onClick={saveSecurity} disabled={secSaving} className={SAVE_BUTTON_CLASS}>{secSaving ? "Saving..." : "Save"}</button>
        </CollapsibleSection>

        {/* Telegram */}
        <CollapsibleSection id="telegram" title="Telegram Bot" done={telegramDone} open={openSection === "telegram"} onToggle={toggle}>
          <div className="flex gap-4 items-start">
            <div className="shrink-0 p-1.5 bg-white rounded-lg">
              <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
            <ol className="ml-0 pl-4 leading-[1.7] text-xs text-[var(--text-primary)] list-decimal">
              <li>Scan QR or search <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold">@BotFather</a></li>
              <li>Send <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded text-[11px] text-[var(--coral-bright)]">/newbot</code></li>
              <li>Paste the <strong>Bot Token</strong> below</li>
            </ol>
          </div>
          <div>
            <label htmlFor="tg-token" className={LABEL_CLASS}>Bot Token</label>
            <PasswordInput
              id="tg-token"
              value={botToken}
              onChange={setBotToken}
              visible={showBotToken}
              onToggle={() => setShowBotToken((v) => !v)}
              placeholder="123456789:ABCdefGHI..."
              autoComplete="off"
            />
          </div>
          {tgStatus && <StatusMessage type={tgStatus.type} message={tgStatus.message} />}
          <button type="button" onClick={saveTelegram} disabled={tgSaving} className={SAVE_BUTTON_CLASS}>{tgSaving ? "Saving..." : "Save"}</button>
        </CollapsibleSection>
      </div>

      {/* System Info Widgets — 2 rows × 3 items */}
      {info && (
        <div className="grid grid-cols-3 gap-3">
          {/* Row 1 */}
          <SystemInfoWidget
            label="CPU"
            detail={`${info.cpus} cores`}
            value={String(info.cpuLoadPercent)}
            unit="%"
            bar={{ percent: info.cpuLoadPercent, color: thresholdColor(info.cpuLoadPercent, 50, 80) }}
          />
          <SystemInfoWidget
            label="GPU"
            value={String(info.gpuLoadPercent)}
            unit="%"
            bar={{ percent: info.gpuLoadPercent, color: thresholdColor(info.gpuLoadPercent, 50, 80) }}
          />
          <SystemInfoWidget
            label="Memory"
            detail={`${info.memoryFree} free`}
            value={String(info.memoryUsedPercent)}
            unit="%"
            bar={{ percent: info.memoryUsedPercent, color: thresholdColor(info.memoryUsedPercent, 60, 85) }}
          />
          {/* Row 2 */}
          <SystemInfoWidget
            label="Storage"
            detail={`${info.diskFree} free`}
            value={String(info.diskUsedPercent)}
            unit="%"
            bar={{ percent: info.diskUsedPercent, color: thresholdColor(info.diskUsedPercent, 70, 90) }}
          />
          <SystemInfoWidget
            label="Temperature"
            value={info.temperature}
            bar={info.temperatureValue != null ? {
              percent: Math.min(100, (info.temperatureValue / 85) * 100),
              color: thresholdColor(info.temperatureValue, 55, 75),
            } : undefined}
          />
          <SparklineWidget
            label="CPU Timeline"
            currentValue={statsHistory.length >= 1 ? `${statsHistory[statsHistory.length - 1].cpu}%` : "—"}
            data={statsHistory.map((s) => s.cpu)}
            color="#f97316"
          />
        </div>
      )}
      {!info && !loadError && (
        <div className="flex items-center justify-center gap-2.5 py-4 text-[var(--text-secondary)] text-sm">
          <div className="spinner" /> Loading system info...
        </div>
      )}
    </div>
  );
}
