"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";

import { parseAuthInput, tryCloseOAuthWindow } from "@/lib/oauth-utils";
import OllamaModelPanel from "./OllamaModelPanel";
import LlamaCppModelPanel from "./LlamaCppModelPanel";
import { useOllamaModels } from "@/hooks/useOllamaModels";
import type { OllamaCallbacks } from "@/hooks/useOllamaModels";
import { useLlamaCppModels } from "@/hooks/useLlamaCppModels";
import type { LlamaCppCallbacks } from "@/hooks/useLlamaCppModels";
import { useDeviceAddress } from "@/hooks/useDeviceAddress";

/* ── Types ── */

interface DoneStepProps {
  setupComplete?: boolean;
  onComplete?: () => void;
}

interface SectionStatusMessage {
  type: "success" | "error";
  message: string;
}

/* ── Constants ── */

/* The stages a factory reset moves through, in the order the device
   performs them. The wizard cannot observe which one is running — there is
   a single POST and no progress channel behind it — so this list is
   narration of the operation, never a claim that a stage has finished. */
const RESET_STEPS = [
  "Clear configuration",
  "Remove credentials",
  "Wipe AI model data",
  "Reset the gateway",
  "Erase personal files",
  "Restart the device",
];

/* ── Class recipes ──
   Sizes come from the type ramp (--t-1..6). The ramp's three weights
   (400 / 600 / 700) are Tailwind's font-normal / font-semibold / font-bold,
   so they are written that way rather than as var(--w-*), which Tailwind's
   `font-` prefix cannot disambiguate from a family. Every white alpha is a
   rung of the fill ladder; every corner is a rung of the radius ladder,
   with 8px (--r-1) dominant and 12px (--r-2) reserved for text fields. */

const INPUT_CLASS =
  "w-full min-h-[48px] px-4 py-3 bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[length:var(--t-5)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] transition-[border-color,background-color] duration-[var(--d-2)] ease-[var(--ease-standard)] focus:border-[var(--coral-bright)] focus:bg-[var(--fill-3)] disabled:text-[var(--text-muted)] disabled:cursor-not-allowed";

const INPUT_WITH_TOGGLE_CLASS = `${INPUT_CLASS} pr-12`;

/* The section primary. Coral is ACTION and it is filled — the secondaries
   on this page stay neutral so there is never a second thing competing to
   be pressed. Scale is touch feedback only: the press, and nothing else. */
const SAVE_BUTTON_CLASS =
  "flex w-full items-center justify-center gap-2 min-h-[48px] px-6 btn-gradient text-white rounded-[var(--r-1)] text-[length:var(--t-5)] font-semibold cursor-pointer transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed";

const TOGGLE_BUTTON_CLASS =
  "absolute right-1 top-1/2 -translate-y-1/2 grid place-items-center w-10 h-10 rounded-[var(--r-1)] text-[var(--text-muted)] bg-transparent border-none cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)]";

const SECTION_HEADER_CLASS =
  "flex items-center gap-3 w-full min-h-[52px] py-3 px-5 text-[length:var(--t-4)] font-semibold text-[var(--text-primary)] bg-transparent border-none cursor-pointer text-left transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:bg-[var(--fill-2)]";

const SECTION_BODY_CLASS =
  "px-5 pb-5 border-t border-[var(--hair)] pt-4 space-y-4";

const LABEL_CLASS =
  "block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-2";

const HELP_CLASS =
  "text-[length:var(--t-2)] leading-relaxed text-[var(--text-muted)]";

/* One wash and one edge for the destructive hue, spent only on the factory
   reset. Nothing routine on this page is allowed to borrow them. */
const DANGER_CONTROL_CLASS =
  "inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-[var(--r-1)] bg-red-500/10 border border-red-500/25 text-red-400 text-[length:var(--t-2)] font-semibold cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:bg-red-500/20 hover:text-red-300";

/* Amber is "this will disconnect you" — a promise about what happens next,
   which is not done, so it is never cyan. One recipe, used three times. */
const CAUTION_CLASS =
  "border-l-2 border-amber-400/60 pl-4 py-1 text-[length:var(--t-3)] leading-relaxed text-amber-300";

const AI_PROVIDERS = [
  { id: "anthropic", name: "Anthropic Claude", hasSubscription: false, placeholder: "sk-ant-api03-...", hint: "Get your API key from console.anthropic.com", tokenUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI GPT", hasSubscription: true, placeholder: "sk-...", hint: "Get your API key from platform.openai.com", tokenUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", hasSubscription: true, placeholder: "AIza...", hint: "Get your API key from Google AI Studio.", tokenUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", hasSubscription: false, placeholder: "sk-or-v1-...", hint: "Get your API key from OpenRouter.", tokenUrl: "https://openrouter.ai/keys" },
  { id: "ollama", name: "Ollama Local", hasSubscription: false, isLocal: true, placeholder: "", hint: "Run AI models locally on this device.", tokenUrl: "" },
  { id: "llamacpp", name: "llama.cpp Local", hasSubscription: false, isLocal: true, placeholder: "", hint: "Recommended for Gemma 4 E2B Q4/INT4-class GGUF runtimes on 8GB devices.", tokenUrl: "" },
] as const;

/* ── Helper functions ── */

/* ── Shared SVG icons ── */

const EyeOpen = (
  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">visibility</span>
);
const EyeClosed = (
  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">visibility_off</span>
);

/* The one permitted spinner: a save whose duration is genuinely unknown and
   expected to be short. It is deliberately absent from the two moments that
   are not short — finishing setup (the gateway restarts) and joining a
   WiFi network (the hotspot drops) — where a spinner would keep turning at
   60fps across a connection that is already gone. */
const ButtonSpinner = (
  <span
    aria-hidden="true"
    className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-[var(--r-full)] animate-spin shrink-0"
  />
);

/* ── Reusable components ── */

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className={`material-symbols-rounded transition-transform duration-[var(--d-2)] ease-[var(--ease-standard)] text-[var(--text-muted)] ${open ? "rotate-90" : ""}`}
      style={{ fontSize: 18 }}
      aria-hidden="true"
    >
      chevron_right
    </span>
  );
}

/* Cyan means DONE and nothing else. "Pending" is a fact, not an event, so
   its dot is static — a pulsing dot asserts "in progress" about something
   nobody has started. */
function SectionBadge({ done }: { done: boolean }) {
  if (done) {
    return (
      <span className="ml-auto flex items-center gap-1.5 text-[length:var(--t-1)] font-semibold text-[var(--cyan-bright)] uppercase tracking-wide">
        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">check</span>
        Done
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[length:var(--t-1)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-[var(--r-full)] bg-[var(--text-muted)]" />
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
    <div className="card-surface rounded-[var(--r-1)] overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-controls={`section-${id}`}
        className={SECTION_HEADER_CLASS}
      >
        <Chevron open={open} />
        {title}
        <SectionBadge done={done} />
      </button>
      {open && <div id={`section-${id}`} className={SECTION_BODY_CLASS}>{children}</div>}
    </div>
  );
}

/* ── Main component ── */

export default function DoneStep({ setupComplete = false, onComplete }: DoneStepProps) {
  const { localUrl } = useDeviceAddress();

  /* ── Finish ── */
  const [finishing, setFinishing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const oauthWindowRef = useRef<Window | null>(null);
  const aiSaveControllerRef = useRef<AbortController | null>(null);
  const aiExchangeControllerRef = useRef<AbortController | null>(null);
  const aiOauthStartControllerRef = useRef<AbortController | null>(null);
  const aiPollControllerRef = useRef<AbortController | null>(null);

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
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const devicePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Ollama Local ── */
  const [selectedOllamaModel, setSelectedOllamaModel] = useState("llama3.2:3b");
  const [selectedLlamaCppModel, setSelectedLlamaCppModel] = useState("");

  /* ── Security (system password + hotspot) ── */
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [hotspotEnabled, setHotspotEnabled] = useState(true);
  const [secSaving, setSecSaving] = useState(false);
  const [secStatus, setSecStatus] = useState<SectionStatusMessage | null>(null);

  /* ── Confirmations ── */
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  /* resetStep advances on an 800ms timer, not on anything the device
     reported, so it is deliberately no longer painted: a fabricated stage
     claim is worse than no claim at all. resetProgress is only rendered at
     100, which is the one value the device does cause — it is set after the
     reset call is accepted. The timer itself is left running; removing it
     would be a behaviour change rather than a visual one. */
  const [resetStep, setResetStep] = useState(0);
  const [resetProgress, setResetProgress] = useState(0);

  /* ── Telegram ── */
  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgStatus, setTgStatus] = useState<SectionStatusMessage | null>(null);

  /* ── WiFi ── */
  const [wifiDone, setWifiDone] = useState(false);
  const [wifiConnectedSSID, setWifiConnectedSSID] = useState<string | null>(null);
  const [wifiSSID, setWifiSSID] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<SectionStatusMessage | null>(null);
  const wifiControllerRef = useRef<AbortController | null>(null);

  /* ── Section completion status ── */
  const [securityDone, setSecurityDone] = useState(false);
  const [telegramDone, setTelegramDone] = useState(false);

  const selectedAiProvider = AI_PROVIDERS.find((p) => p.id === aiProvider);
  const isAiSubscription = aiAuthMode === "subscription" && (selectedAiProvider?.hasSubscription ?? false);
  const useDeviceAuth = isAiSubscription && aiProvider === "openai";

  const aiOauthLabels: Record<string, { button: string; description: string; success: string; steps: string[]; inputLabel: string; inputPlaceholder: string }> = {
    anthropic: {
      button: "Connect with Claude",
      description: "Connect your Claude Pro or Max subscription via OAuth.",
      success: "Claude subscription connected!",
      steps: ["Authorize in the browser tab.", "Copy the authorization code.", "Paste it below."],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
    openai: {
      button: "Connect to GPT",
      description: "Connect your ChatGPT Plus or Pro subscription via OAuth.",
      success: "GPT subscription connected!",
      steps: [
        "Sign in and authorize in the browser tab.",
        "After approval, the page will redirect to a URL that won\u2019t load \u2014 this is expected.",
        "Copy the full URL from the address bar and paste it below.",
      ],
      inputLabel: "Callback URL",
      inputPlaceholder: "Paste the full URL here...",
    },
    google: {
      button: "Connect to Gemini",
      description: "Connect your Google Gemini subscription via OAuth.",
      success: "Gemini subscription connected!",
      steps: ["Sign in with your Google account in the browser tab.", "Copy the authorization code shown after approval.", "Paste it below."],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
  };
  const currentAiOAuth = aiOauthLabels[aiProvider] ?? aiOauthLabels.anthropic;
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
          if (data.wifi_configured) setWifiDone(true);
          if (data.ai_model_provider) setProviderName(data.ai_model_provider);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);


  /* ── Fetch hotspot defaults on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          if (data.ssid) setHotspotName(data.ssid);
          if (typeof data.enabled === "boolean") setHotspotEnabled(data.enabled);
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
        if (data && !controller.signal.aborted && data["GENERAL.CONNECTION"] && data["GENERAL.CONNECTION"] !== "ClawBox-Setup") {
          setWifiConnectedSSID(data["GENERAL.CONNECTION"]);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Actions ── */

  const completeSetup = async () => {
    setFinishing(true);
    setCompleteError(null);
    try {
      const res = await fetch("/setup-api/setup/complete", { method: "POST" });
      if (res.ok) {
        if (onComplete) {
          onComplete();
        } else {
          window.location.href = "/";
        }
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
    if (hotspotEnabled && !hotspotName.trim()) {
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
          enabled: hotspotEnabled,
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

  const stopDevicePolling = useCallback(() => {
    setDevicePolling(false);
    if (devicePollRef.current) {
      clearTimeout(devicePollRef.current);
      devicePollRef.current = null;
    }
    aiPollControllerRef.current?.abort();
  }, []);
  useEffect(() => {
    return () => {
      stopDevicePolling();
      aiSaveControllerRef.current?.abort();
      aiExchangeControllerRef.current?.abort();
      aiOauthStartControllerRef.current?.abort();
      wifiControllerRef.current?.abort();
    };
  }, [stopDevicePolling]);

  const resetAiFields = () => {
    stopDevicePolling();
    setAiApiKey("");
    setShowAiKey(false);
    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
    setDeviceCode(null);
    setDeviceUrl(null);
    setDeviceSaving(false);
  };

  const saveDeviceToken = async () => {
    aiSaveControllerRef.current?.abort();
    const controller = new AbortController();
    aiSaveControllerRef.current = controller;

    setDeviceSaving(true);
    try {
      // Server-side OAuth handoff: device-poll persisted the provider tokens
      // to a server-only file, so no token fields leave the browser — the
      // configure route reads them there via `oauthHandoff`.
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, authMode: "subscription", oauthHandoff: true }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to save token" });
        return;
      }
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        const { closeHint } = tryCloseOAuthWindow(oauthWindowRef);
        setAiStatus({ type: "success", message: "GPT subscription connected!" + closeHint });
        setProviderDone(true);
        setProviderName(aiProvider);
        setDeviceCode(null);
        setDeviceUrl(null);
        setTimeout(() => { setOpenSection(null); setAiStatus(null); }, 1500);
      } else {
        setAiStatus({ type: "error", message: saveData.error || "Failed to save token" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setDeviceSaving(false);
    }
  };

  const pollDeviceAuth = useCallback(async (interval: number) => {
    aiPollControllerRef.current?.abort();
    const controller = new AbortController();
    aiPollControllerRef.current = controller;

    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-poll", {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        stopDevicePolling();
        setAiStatus({ type: "error", message: data.error || "Polling failed" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.status === "complete") {
        stopDevicePolling();
        await saveDeviceToken();
        return;
      }
      if (data.status === "pending") {
        devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
        return;
      }
      if (data.error) {
        stopDevicePolling();
        setAiStatus({ type: "error", message: data.error });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network error — retry
      devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
    }
  }, [stopDevicePolling, aiProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDeviceAuth = async () => {
    stopDevicePolling();
    aiOauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    aiOauthStartControllerRef.current = controller;

    setAiStatus(null);
    setDeviceCode(null);
    setDeviceUrl(null);
    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to start device auth" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.user_code && data.verification_url) {
        setDeviceCode(data.user_code);
        setDeviceUrl(data.verification_url);
        setDevicePolling(true);
        const interval = data.interval || 5;
        devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
      } else {
        setAiStatus({ type: "error", message: "Unexpected response from device auth" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    }
  };

  const saveAiProvider = async () => {
    if (!aiApiKey.trim()) {
      setAiStatus({ type: "error", message: "Please enter your API key" });
      return;
    }

    aiSaveControllerRef.current?.abort();
    const controller = new AbortController();
    aiSaveControllerRef.current = controller;

    setAiSaving(true);
    setAiStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey.trim(), authMode: aiAuthMode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setAiStatus({ type: "success", message: "AI provider configured!" });
        setProviderDone(true);
        setProviderName(aiProvider);
        setAiApiKey("");
        setTimeout(() => { setOpenSection(null); setAiStatus(null); }, 1500);
      } else {
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setAiSaving(false);
    }
  };

  // Ollama hook
  const ollamaCallbacks = useMemo<OllamaCallbacks>(() => ({
    onSaveSuccess: (model: string) => {
      setAiStatus({ type: "success", message: `Ollama configured with ${model}!` });
      setProviderDone(true);
      setProviderName("ollama");
      setTimeout(() => { setOpenSection(null); setAiStatus(null); }, 1500);
    },
    onSaveError: (message: string) => setAiStatus({ type: "error", message }),
    onPullError: (message: string) => setAiStatus({ type: "error", message }),
    onDeleteError: (message: string) => setAiStatus({ type: "error", message }),
    onClearStatus: () => setAiStatus(null),
  }), []);

  const {
    ollamaRunning,
    ollamaModels,
    ollamaSearch,
    ollamaSearchResults,
    ollamaSearching,
    ollamaPulling,
    ollamaPullProgress,
    ollamaSaving,
    checkOllamaStatus,
    handleOllamaSearchChange,
    pullOllamaModel,
    saveOllamaConfig,
    deleteOllamaModel,
    formatOllamaBytes,
    clearSearch,
  } = useOllamaModels(ollamaCallbacks);

  const llamaCppCallbacks = useMemo<LlamaCppCallbacks>(() => ({
    onSaveSuccess: (model: string) => {
      setAiStatus({ type: "success", message: `llama.cpp configured with ${model}!` });
      setProviderDone(true);
      setProviderName("llamacpp");
      setTimeout(() => { setOpenSection(null); setAiStatus(null); }, 1500);
    },
    onSaveError: (message: string) => setAiStatus({ type: "error", message }),
    onClearStatus: () => setAiStatus(null),
  }), []);

  const {
    llamaCppRunning,
    llamaCppInstalled,
    llamaCppSaving,
    llamaCppProgress,
    checkLlamaCppStatus,
    saveLlamaCppConfig,
  } = useLlamaCppModels(llamaCppCallbacks);

  const startAiOAuth = async () => {
    aiOauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    aiOauthStartControllerRef.current = controller;

    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to start OAuth" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.url) {
        oauthWindowRef.current = window.open(data.url, "_blank");
        setAiOauthStarted(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    }
  };

  const exchangeAiCode = async () => {
    if (!aiAuthCode.trim()) {
      setAiStatus({ type: "error", message: `Please paste the ${currentAiOAuth.inputLabel.toLowerCase()}` });
      return;
    }
    const parsedCode = parseAuthInput(aiAuthCode);
    if (!parsedCode) {
      setAiStatus({ type: "error", message: "Could not extract authorization code from input" });
      return;
    }

    aiExchangeControllerRef.current?.abort();
    const controller = new AbortController();
    aiExchangeControllerRef.current = controller;

    setAiExchanging(true);
    setAiStatus(null);
    try {
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: parsedCode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!exchangeRes.ok) {
        const data = await exchangeRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Token exchange failed" });
        return;
      }
      const tokenData = await exchangeRes.json();
      if (controller.signal.aborted) return;
      if (!tokenData.access_token) {
        setAiStatus({ type: "error", message: "No access token received" });
        return;
      }
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: tokenData.access_token, authMode: "subscription", refreshToken: tokenData.refresh_token, expiresIn: tokenData.expires_in, ...(tokenData.projectId ? { projectId: tokenData.projectId } : {}) }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to save token" });
        return;
      }
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        const { tabClosed, closeHint } = tryCloseOAuthWindow(oauthWindowRef);
        setAiStatus({ type: "success", message: currentAiOAuth.success + closeHint });
        setProviderDone(true);
        setProviderName(aiProvider);
        setAiOauthStarted(false);
        setAiAuthCode("");
        setTimeout(() => { setOpenSection(null); setAiStatus(null); }, tabClosed ? 1500 : 3000);
      } else {
        setAiStatus({ type: "error", message: saveData.error || "Failed to save token" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setAiExchanging(false);
    }
  };

  const connectWifi = async () => {
    if (!wifiSSID.trim()) return;

    wifiControllerRef.current?.abort();
    const controller = new AbortController();
    wifiControllerRef.current = controller;

    setWifiConnecting(true);
    setWifiStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: wifiSSID.trim(), password: wifiPassword }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setWifiStatus({ type: "error", message: data.error || "Connection failed" });
        return;
      }
      setWifiStatus({ type: "success", message: "Connected!" });
      setWifiConnectedSSID(wifiSSID.trim());
      setWifiSSID("");
      setWifiPassword("");
      setTimeout(() => { setOpenSection(null); setWifiStatus(null); }, 1500);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setWifiStatus({ type: "error", message: `Lost connection. Reconnect to your WiFi and visit ${localUrl}` });
        return;
      }
      setWifiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setWifiConnecting(false);
    }
  };

  const resetSetup = async () => {
    setResetting(true);
    setResetStep(0);
    setResetProgress(0);

    // Single timer: advance step + derive progress from step index
    const stepDuration = 800;
    let currentStep = 0;
    const stepInterval = setInterval(() => {
      currentStep++;
      if (currentStep < RESET_STEPS.length) {
        setResetStep(currentStep);
        setResetProgress(Math.round((currentStep / RESET_STEPS.length) * 100));
      }
    }, stepDuration);

    try {
      const res = await fetch("/setup-api/setup/reset", { method: "POST" });
      clearInterval(stepInterval);

      if (res.ok) {
        // Show final "Restarting device..." step
        setResetStep(RESET_STEPS.length - 1);
        setResetProgress(100);
        // Device is rebooting — wait then try to reload (page will come back after reboot)
        await new Promise((r) => setTimeout(r, 3000));
        window.location.replace("/setup");
        return;
      }
      setCompleteError("Factory reset failed");
    } catch {
      setCompleteError("Factory reset failed");
    } finally {
      clearInterval(stepInterval);
      setResetting(false);
      setResetConfirm(false);
      setResetStep(0);
      setResetProgress(0);
    }
  };

  /* ── Render ── */

  return (
    <div className="w-full max-w-2xl mx-auto">
      {completeError && (
        <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-[var(--r-1)] text-[length:var(--t-2)] leading-relaxed text-red-400">{completeError}</div>
      )}

      {/* Primary actions. Two routine controls, side by side and equal —
          the factory reset is not one of them and lives at the foot of the
          page instead. */}
      <div className="grid gap-3 sm:grid-cols-2 mb-6">
          <button
            type="button"
            onClick={setupComplete ? () => (window.location.href = "/") : completeSetup}
            disabled={finishing}
            className="flex items-center justify-center gap-2 min-h-[48px] px-5 btn-gradient text-white rounded-[var(--r-1)] text-[length:var(--t-5)] font-semibold cursor-pointer transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {/* Finishing hands the device to the gateway, which restarts.
                That wait gets no spinner: a compositor animation does not
                know the socket is gone, so it would keep reassuring the
                customer at the one moment it knows least. The button's own
                label becomes the verb instead, and nothing moves. */}
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">arrow_forward</span>
            {finishing ? "Finishing setup..." : setupComplete ? "OpenClaw" : "Finish Setup"}
          </button>
          <a
            href="https://t.me/ClawBoxSupportBot"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 min-h-[48px] px-5 bg-[#0088cc] text-white rounded-[var(--r-1)] text-[length:var(--t-5)] font-semibold cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:bg-[#006daa]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
            ClawBox Agent
          </a>
      </div>

      {/* Factory reset — the confirmation, then the erase itself.
          Once the erase is running nothing on this dialog moves. The device
          reports exactly one thing, once (the reset call was accepted), so
          that single fact is the only state change the dialog draws; a
          percentage counted off a local timer would be describing the
          wizard's stopwatch, not the box. */}
      {resetConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            aria-busy={resetting}
            className="card-surface rounded-[var(--r-3)] p-6 max-w-sm w-full"
          >
            {!resetting ? (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <span aria-hidden="true" className="grid place-items-center w-9 h-9 shrink-0 rounded-[var(--r-1)] bg-red-500/10 border border-red-500/25 text-red-400">
                    <span className="material-symbols-rounded" style={{ fontSize: 20 }}>warning</span>
                  </span>
                  <h3 id="reset-dialog-title" className="text-[length:var(--t-5)] font-bold text-[var(--text-primary)]">Factory Reset?</h3>
                </div>
                <p className="text-[length:var(--t-3)] text-[var(--text-secondary)] mb-5 leading-relaxed">
                  This will erase all settings, credentials, tokens, and all personal files on the device, then restart the setup wizard from scratch. It cannot be undone.
                </p>
                <div className="flex items-center gap-3 justify-end">
                  <button
                    type="button"
                    onClick={() => setResetConfirm(false)}
                    className="inline-flex items-center justify-center min-h-[44px] px-5 bg-[var(--fill-1)] text-[var(--text-primary)] border border-[var(--hair-2)] rounded-[var(--r-1)] text-[length:var(--t-2)] font-semibold cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:bg-[var(--fill-3)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={resetSetup}
                    className="inline-flex items-center justify-center min-h-[44px] px-5 bg-red-500 text-white rounded-[var(--r-1)] text-[length:var(--t-2)] font-semibold cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:bg-red-600"
                  >
                    Factory Reset
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <span
                    aria-hidden="true"
                    className={`grid place-items-center w-9 h-9 shrink-0 rounded-[var(--r-1)] border transition-colors duration-[var(--d-2)] ease-[var(--ease-truth)] ${
                      resetProgress === 100
                        ? "bg-[var(--cyan-wash)] border-[var(--cyan-edge)] text-[var(--cyan-bright)]"
                        : "bg-red-500/10 border-red-500/25 text-red-400"
                    }`}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                      {resetProgress === 100 ? "restart_alt" : "warning"}
                    </span>
                  </span>
                  <h3 id="reset-dialog-title" className="text-[length:var(--t-5)] font-bold text-[var(--text-primary)]">
                    {resetProgress === 100 ? "Restarting device" : "Erasing device"}
                  </h3>
                </div>
                <p aria-live="polite" className="text-[length:var(--t-3)] text-[var(--text-secondary)] leading-relaxed">
                  {resetProgress === 100
                    ? "Everything is erased. The device is restarting — this page reloads on its own once it answers again."
                    : "The device is erasing itself and will restart when it is done. This cannot be stopped or undone, and it does not report how far along it is."}
                </p>
                <ul className="mt-5 space-y-2">
                  {RESET_STEPS.map((step, i) => (
                    <li key={i} className="flex items-center gap-3 text-[length:var(--t-2)] text-[var(--text-muted)]">
                      <span aria-hidden="true" className="w-1 h-1 shrink-0 rounded-[var(--r-full)] bg-[var(--text-muted)]" />
                      {step}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* Settings sections */}
      <div className="space-y-3 mb-6">
        {/* WiFi */}
        <CollapsibleSection id="wifi" title="WiFi" done={wifiDone || !!wifiConnectedSSID} open={openSection === "wifi"} onToggle={toggle}>
          {wifiConnectedSSID && (
            <p className={HELP_CLASS}>
              Connected to: <span className="text-[var(--text-primary)] font-semibold">{wifiConnectedSSID}</span>
            </p>
          )}
          <div>
            <label htmlFor="wifi-ssid-dash" className={LABEL_CLASS}>Network Name (SSID)</label>
            <input
              id="wifi-ssid-dash"
              type="text"
              value={wifiSSID}
              onChange={(e) => setWifiSSID(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") connectWifi(); }}
              placeholder="Enter WiFi network name"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="wifi-pw-dash" className={LABEL_CLASS}>Password</label>
            <PasswordInput
              id="wifi-pw-dash"
              value={wifiPassword}
              onChange={setWifiPassword}
              visible={showWifiPassword}
              onToggle={() => setShowWifiPassword((v) => !v)}
              placeholder="Enter password (leave empty for open network)"
              autoComplete="off"
            />
          </div>
          {/* The consequence, stated before the button that causes it, and
              never animated — it has to be legible in the frame where the
              hotspot goes away. */}
          <p className={CAUTION_CLASS}>
            <span className="font-semibold">Note:</span> Connecting to WiFi will stop the hotspot.
            {"You'll"} need to reach the device via your WiFi network at <span className="font-semibold">{localUrl}</span>.
          </p>
          {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
          {/* No spinner here either: joining a network takes the hotspot
              down under the browser that is watching. The label carries the
              state; the stillness is the honest part. */}
          <button
            type="button"
            onClick={connectWifi}
            disabled={wifiConnecting || !wifiSSID.trim()}
            className={SAVE_BUTTON_CLASS}
          >
            {wifiConnecting ? "Connecting..." : "Connect"}
          </button>
        </CollapsibleSection>

        {/* AI Provider */}
        <CollapsibleSection id="provider" title="AI Provider" done={providerDone} open={openSection === "provider"} onToggle={toggle}>
          {providerDone && providerName && (
            <p className={HELP_CLASS}>
              Currently configured: <span className="text-[var(--text-primary)] font-semibold capitalize">{AI_PROVIDERS.find((p) => p.id === providerName)?.name || providerName}</span>
            </p>
          )}
          <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-[var(--r-1)] overflow-hidden">
            {AI_PROVIDERS.map((provider) => {
              const isSelected = aiProvider === provider.id;
              return (
                <label
                  key={provider.id}
                  className={`flex items-center gap-3 px-4 min-h-[52px] py-3 w-full text-left border-b border-[var(--hair)] last:border-b-0 cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${isSelected ? "bg-[var(--coral-wash)]" : "hover:bg-[var(--fill-3)]"}`}
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
                      if (provider.id === "ollama") checkOllamaStatus();
                      if (provider.id === "llamacpp") checkLlamaCppStatus();
                    }}
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex items-center justify-center w-5 h-5 rounded-[var(--r-full)] border-2 shrink-0 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${isSelected ? "border-[var(--coral-bright)]" : "border-[var(--hair-2)]"}`}>
                    <span className={`w-2.5 h-2.5 rounded-[var(--r-full)] bg-[var(--coral-bright)] transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] ${isSelected ? "scale-100" : "scale-0"}`} />
                  </span>
                  <span className="text-[length:var(--t-4)] font-semibold text-[var(--text-primary)]">{provider.name}</span>
                </label>
              );
            })}
          </div>

          {aiProvider === "ollama" ? (
            <div className="space-y-3">
              <OllamaModelPanel
                ollamaRunning={ollamaRunning}
                ollamaModels={ollamaModels}
                ollamaSaving={ollamaSaving}
                ollamaSearch={ollamaSearch}
                ollamaSearching={ollamaSearching}
                ollamaSearchResults={ollamaSearchResults}
                ollamaPulling={ollamaPulling}
                ollamaPullProgress={ollamaPullProgress}
                selectedOllamaModel={selectedOllamaModel}
                setSelectedOllamaModel={setSelectedOllamaModel}
                saveOllamaConfig={saveOllamaConfig}
                deleteOllamaModel={deleteOllamaModel}
                handleOllamaSearchChange={handleOllamaSearchChange}
                clearSearch={clearSearch}
                pullOllamaModel={pullOllamaModel}
                formatOllamaBytes={formatOllamaBytes}
                radioGroupName="ollama-model-dash"
                inputClassName={INPUT_CLASS}
                buttonClassName={`mt-4 ${SAVE_BUTTON_CLASS}`}
                buttonSpinner={ButtonSpinner}
              />
            </div>
          ) : aiProvider === "llamacpp" ? (
            <div className="space-y-3">
              <LlamaCppModelPanel
                llamaCppRunning={llamaCppRunning}
                llamaCppInstalled={llamaCppInstalled}
                llamaCppSaving={llamaCppSaving}
                llamaCppProgress={llamaCppProgress}
                selectedLlamaCppModel={selectedLlamaCppModel}
                setSelectedLlamaCppModel={setSelectedLlamaCppModel}
                saveLlamaCppConfig={saveLlamaCppConfig}
                buttonClassName={`mt-4 ${SAVE_BUTTON_CLASS}`}
                buttonSpinner={ButtonSpinner}
              />
            </div>
          ) : (
            <>

          {selectedAiProvider?.hasSubscription && (
            <div className="flex gap-1 p-1 bg-[var(--bg-deep)] rounded-[var(--r-1)]">
              {(["subscription", "token"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setAiAuthMode(mode);
                    resetAiFields();
                  }}
                  className={`flex-1 min-h-[40px] rounded-[var(--r-1)] text-[length:var(--t-4)] font-semibold cursor-pointer border-none transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${
                    aiAuthMode === mode
                      ? "bg-[var(--fill-3)] text-[var(--text-primary)]"
                      : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {mode === "subscription" ? "Subscription" : "API Key"}
                </button>
              ))}
            </div>
          )}

          {isAiSubscription ? (
            useDeviceAuth ? (
              /* Device code flow (OpenAI) */
              <div>
                <p className="text-[length:var(--t-3)] text-[var(--text-secondary)] mb-3 leading-relaxed">
                  Connect your ChatGPT Plus or Pro subscription. You&apos;ll get a code to enter on OpenAI&apos;s website.
                </p>
                {!deviceCode ? (
                  <button type="button" onClick={startDeviceAuth} className={SAVE_BUTTON_CLASS}>Connect to GPT</button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] text-center">
                      <button
                        type="button"
                        onClick={() => { const win = window.open(deviceUrl!, "_blank"); if (win) { oauthWindowRef.current = win; } }}
                        className="w-full min-h-[48px] px-4 bg-[var(--coral-bright)] hover:bg-[var(--coral-mid)] text-white font-semibold rounded-[var(--r-1)] text-[length:var(--t-5)] cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
                      >
                        Open authorization page
                      </button>
                      <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mt-4 mb-2">Then enter this code:</p>
                      {/* A machine literal: mono, at the display rung, and
                          selectable — it is the one thing on this panel the
                          customer has to carry to another screen. */}
                      <div className="px-4 py-3 bg-[var(--fill-2)] rounded-[var(--r-1)] inline-flex items-center gap-2">
                        <span className="text-[length:var(--t-6)] font-mono font-bold text-[var(--text-primary)] tracking-widest select-all">{deviceCode}</span>
                        <button
                          type="button"
                          onClick={() => {
                            try {
                              const ta = document.createElement("textarea");
                              ta.value = deviceCode!;
                              ta.style.position = "fixed";
                              ta.style.opacity = "0";
                              document.body.appendChild(ta);
                              ta.select();
                              document.execCommand("copy");
                              document.body.removeChild(ta);
                              const btn = document.getElementById("copy-code-btn-dash");
                              if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
                            } catch { /* ignore */ }
                          }}
                          id="copy-code-btn-dash"
                          className="ml-1 px-2 py-1 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] hover:bg-[var(--fill-3)] cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
                        >
                          Copy
                        </button>
                      </div>
                      <p className={`mt-2 ${HELP_CLASS}`}>Code expires in 15 minutes</p>
                    </div>
                    {(devicePolling || deviceSaving) && (
                      <div className="flex items-center gap-2 text-[length:var(--t-2)] text-[var(--text-secondary)]">
                        <span aria-hidden="true" className="inline-block w-3.5 h-3.5 shrink-0 border-2 border-[var(--hair-2)] border-t-[var(--coral-bright)] rounded-[var(--r-full)] animate-spin" />
                        {deviceSaving ? "Authorized! Connecting..." : "Waiting for authorization..."}
                      </div>
                    )}
                    <button type="button" onClick={startDeviceAuth} className="bg-transparent border-none text-[var(--coral-bright)] text-[length:var(--t-2)] font-semibold underline underline-offset-2 cursor-pointer p-0">Get a new code</button>
                  </div>
                )}
              </div>
            ) : (
              /* Redirect OAuth flow (Anthropic, Google) */
              <div>
                <p className="text-[length:var(--t-3)] text-[var(--text-secondary)] mb-3 leading-relaxed">{currentAiOAuth.description}</p>
                {!aiOauthStarted ? (
                  <button type="button" onClick={startAiOAuth} className={SAVE_BUTTON_CLASS}>{currentAiOAuth.button}</button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-4 bg-[var(--fill-1)] border border-[var(--border-subtle)] rounded-[var(--r-1)]">
                      <p className="text-[length:var(--t-3)] text-[var(--text-primary)] leading-relaxed">
                        {currentAiOAuth.steps.map((step, i) => (
                          <span key={i}>
                            {i > 0 && <br />}
                            <strong className="text-[var(--coral-bright)]">{i + 1}.</strong> {step}
                          </span>
                        ))}
                      </p>
                    </div>
                    <div>
                      <label htmlFor="ai-oauth-code" className={LABEL_CLASS}>{currentAiOAuth.inputLabel}</label>
                      <input
                        id="ai-oauth-code"
                        type="text"
                        value={aiAuthCode}
                        onChange={(e) => setAiAuthCode(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") exchangeAiCode(); }}
                        placeholder={currentAiOAuth.inputPlaceholder}
                        spellCheck={false}
                        autoComplete="off"
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <button type="button" onClick={exchangeAiCode} disabled={aiExchanging || !aiAuthCode.trim()} className={SAVE_BUTTON_CLASS}>{aiExchanging && ButtonSpinner}{aiExchanging ? "Connecting..." : "Connect"}</button>
                      <button type="button" onClick={startAiOAuth} className="shrink-0 bg-transparent border-none text-[var(--coral-bright)] text-[length:var(--t-2)] font-semibold underline underline-offset-2 cursor-pointer p-0">Restart authorization</button>
                    </div>
                  </div>
                )}
              </div>
            )
          ) : (
            <div>
              {selectedAiProvider?.tokenUrl && (
                <a href={selectedAiProvider.tokenUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 mb-3 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:text-[var(--text-primary)]">
                  Get API Key
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
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
              <p className={`mt-2 ${HELP_CLASS}`}>{selectedAiProvider?.hint}</p>
              <button type="button" onClick={saveAiProvider} disabled={aiSaving} className={`mt-4 ${SAVE_BUTTON_CLASS}`}>{aiSaving && ButtonSpinner}{aiSaving ? "Connecting..." : "Connect"}</button>
            </div>
          )}

            </>
          )}

          {aiStatus && <StatusMessage type={aiStatus.type} message={aiStatus.message} />}
        </CollapsibleSection>

        {/* Security */}
        <CollapsibleSection id="security" title="Security" done={securityDone} open={openSection === "security"} onToggle={toggle}>
          <p className={HELP_CLASS}>Set system password and configure hotspot for next setup.</p>
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
          <div className="border-t border-[var(--hair)] pt-4">
            <div className="flex items-center justify-between mb-3">
              <label htmlFor="hs-toggle" className="text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)]">Hotspot</label>
              <button
                id="hs-toggle"
                type="button"
                role="switch"
                aria-checked={hotspotEnabled}
                onClick={() => setHotspotEnabled((v) => !v)}
                className={`relative w-[46px] h-[26px] shrink-0 rounded-[var(--r-full)] cursor-pointer border-none transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${hotspotEnabled ? "bg-[var(--coral-bright)]" : "bg-[var(--fill-3)]"}`}
              >
                <span className={`absolute top-[3px] left-[3px] w-5 h-5 rounded-[var(--r-full)] bg-white transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] ${hotspotEnabled ? "translate-x-5" : ""}`} />
              </button>
            </div>
            {!hotspotEnabled ? (
              <p className={`${CAUTION_CLASS} mb-4`}>
                Hotspot will be disabled on next boot. The device will only be reachable via WiFi or Ethernet.
              </p>
            ) : (
              <p className={`${CAUTION_CLASS} mb-4`}>
                Enabling the hotspot will disconnect WiFi. The device will be reachable via the hotspot or Ethernet at <span className="font-semibold">{localUrl}</span>.
              </p>
            )}
            <label htmlFor="hs-name" className={LABEL_CLASS}>Hotspot Name</label>
            <input id="hs-name" type="text" value={hotspotName} onChange={(e) => setHotspotName(e.target.value)} maxLength={32} className={INPUT_CLASS} disabled={!hotspotEnabled} />
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
          <button type="button" onClick={saveSecurity} disabled={secSaving} className={SAVE_BUTTON_CLASS}>{secSaving && ButtonSpinner}{secSaving ? "Connecting..." : "Connect"}</button>
        </CollapsibleSection>

        {/* Telegram */}
        <CollapsibleSection id="telegram" title="Telegram Bot" done={telegramDone} open={openSection === "telegram"} onToggle={toggle}>
          <div className="flex gap-5 items-start">
            <div className="shrink-0 p-1.5 bg-white rounded-[var(--r-1)]">
              <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
            <ol className="ml-0 pl-4 leading-relaxed text-[length:var(--t-3)] text-[var(--text-secondary)] list-decimal space-y-1">
              <li>Scan QR or search <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[var(--coral-bright)] font-semibold transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] hover:text-[var(--text-primary)]">@BotFather</a></li>
              <li>Send <code className="bg-[var(--fill-2)] px-1.5 py-0.5 rounded-[var(--r-1)] text-[length:var(--t-2)] text-[var(--coral-bright)]">/newbot</code></li>
              <li>Paste the <strong className="text-[var(--text-primary)] font-semibold">Bot Token</strong> below</li>
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
          <button type="button" onClick={saveTelegram} disabled={tgSaving} className={SAVE_BUTTON_CLASS}>{tgSaving && ButtonSpinner}{tgSaving ? "Connecting..." : "Connect"}</button>
        </CollapsibleSection>
      </div>

      {/* The destructive action is not a tile. It sits below everything
          routine, on its own quiet surface, and states its consequence
          before it can be reached — the danger wash and edge are spent
          here, on the control, and nowhere else on the page. */}
      <div className="rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--fill-1)] p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[length:var(--t-4)] font-semibold text-red-400">
            <span className="material-symbols-rounded shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
            Factory Reset
          </h3>
          <p className={`mt-2 ${HELP_CLASS}`}>
            Erases every setting, credential and personal file on the device, then restarts setup from scratch. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setResetConfirm(true)}
          className={`${DANGER_CONTROL_CLASS} shrink-0`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">delete</span>
          Factory Reset
        </button>
      </div>

    </div>
  );
}
