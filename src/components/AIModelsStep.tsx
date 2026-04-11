"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import StatusMessage from "./StatusMessage";
import OllamaModelPanel from "./OllamaModelPanel";
import LlamaCppModelPanel from "./LlamaCppModelPanel";
import AIProviderIcon from "./AIProviderIcon";
import { parseAuthInput, tryCloseOAuthWindow } from "@/lib/oauth-utils";
import {
  getLlamaCppOverlayProgress,
  getOllamaOverlayProgress,
} from "@/lib/ai-provider-progress";
import { useOllamaModels } from "@/hooks/useOllamaModels";
import type { OllamaCallbacks } from "@/hooks/useOllamaModels";
import { useLlamaCppModels } from "@/hooks/useLlamaCppModels";
import type { LlamaCppCallbacks } from "@/hooks/useLlamaCppModels";
import { useT } from "@/lib/i18n";
import {
  PORTAL_REGISTER_URL,
} from "@/lib/max-subscription";

interface AIModelsStepProps {
  onNext?: () => void;
  embedded?: boolean;
  onConfigured?: () => void;
  providerIds?: string[];
  defaultProviderId?: string;
  currentProviderId?: string | null;
  currentModel?: string | null;
  title?: string;
  description?: string;
  configureScope?: "primary" | "local";
  testId?: string;
}

type AuthMode = "token" | "subscription" | "local";

interface AuthOption {
  mode: AuthMode;
  label: string;
  placeholder: string;
  hint: string;
  tokenUrl?: string;
  tokenUrlLabel?: string;
}

interface Provider {
  id: string;
  name: string;
  description: string;
  authOptions: AuthOption[];
}

function normalizeSelectableProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized === "deepseek" || normalized === "clawai") return "clawai";
  if (normalized.startsWith("openai")) return "openai";
  if (normalized.startsWith("google")) return "google";
  if (normalized.startsWith("anthropic")) return "anthropic";
  if (normalized.startsWith("openrouter")) return "openrouter";
  if (normalized.startsWith("ollama")) return "ollama";
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  return normalized;
}

function getConnectButtonLabel(providerName?: string | null) {
  return providerName ? `Connect to ${providerName}` : "Connect";
}

const ButtonSpinner = (
  <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

const CONFIGURING_STEP_DELAYS = [0, 2000, 5000, 12000, 22000];

type ConfiguringKind = "generic" | "ollama" | "llamacpp";

interface ConfiguringState {
  provider: string;
  kind: ConfiguringKind;
  phase: number;
  detail: string | null;
  progressPercent: number | null;
  completed: boolean;
}

function ConfiguringOverlay({
  provider,
  steps,
  phase,
  detail,
  progressPercent,
  completed,
  t,
}: {
  provider: string;
  steps: string[];
  phase: number;
  detail: string | null;
  progressPercent: number | null;
  completed: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [dots, setDots] = useState("");
  const providerName = PROVIDERS.find((p) => p.id === provider)?.name ?? "AI";

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Trap focus inside overlay
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={overlayRef} tabIndex={-1} className="flex flex-col items-center gap-6 px-8 pt-4 pb-8 outline-none">
      <style>{`
        @keyframes aimodels-check-draw { to { stroke-dashoffset: 0 } }
        @keyframes aimodels-check-circle { to { stroke-dashoffset: 0 } }
        @keyframes aimodels-fade-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes aimodels-pulse-ring { 0% { transform: scale(0.8); opacity: 0.6 } 50% { transform: scale(1.2); opacity: 0 } 100% { transform: scale(0.8); opacity: 0.6 } }
        @keyframes aimodels-orbit { from { transform: rotate(0deg) translateX(40px) rotate(0deg) } to { transform: rotate(360deg) translateX(40px) rotate(-360deg) } }
        .aimodels-fade-in { animation: aimodels-fade-in 0.4s ease-out both }
        .aimodels-step-enter { animation: aimodels-fade-in 0.3s ease-out both }
      `}</style>

      {/* Central icon with orbiting particles */}
      <div className="relative w-24 h-24 flex items-center justify-center">
        {/* Pulse rings */}
        <div className="absolute inset-0 rounded-full border-2 border-emerald-500/20" style={{ animation: "aimodels-pulse-ring 2s ease-in-out infinite" }} />
        <div className="absolute inset-2 rounded-full border border-emerald-500/10" style={{ animation: "aimodels-pulse-ring 2s ease-in-out infinite 0.5s" }} />

        {/* Orbiting dots */}
        {!completed && phase >= 1 && [0, 1, 2].map((i) => (
          <div key={i} className="absolute inset-0 flex items-center justify-center" style={{ animation: `aimodels-orbit ${3 + i * 0.5}s linear infinite`, animationDelay: `${i * 0.4}s` }}>
            <div className="w-2 h-2 rounded-full bg-[var(--coral-bright)]" style={{ opacity: 0.4 + i * 0.2 }} />
          </div>
        ))}

        {completed ? (
          <svg width="48" height="48" viewBox="0 0 56 56" fill="none" className="aimodels-fade-in">
            <circle cx="28" cy="28" r="25" stroke="#22c55e" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "aimodels-check-circle 0.6s ease-out 0.1s forwards" }} />
            <path d="M17 28l7 7 15-15" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "aimodels-check-draw 0.4s ease-out 0.5s forwards" }} />
          </svg>
        ) : (
          <AIProviderIcon provider={provider} size={56} className="aimodels-fade-in" />
        )}
      </div>

      {/* Provider name */}
      <div className="text-center aimodels-fade-in" style={{ animationDelay: "0.3s" }}>
        <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">
          {completed ? t("connected") : t("ai.settingUp", { provider: providerName })}
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          {completed
            ? detail || t("ai.configured")
            : detail || `${t("ai.configuringAssistant")}${dots}`}
        </p>
      </div>

      {/* Progress steps */}
      <div className="w-full max-w-[280px] space-y-2.5 mt-2">
        {steps.map((step, i) => (
          <div
            key={i}
            className={`flex items-center gap-2.5 text-xs transition-all duration-300 ${
              completed || i <= phase ? "opacity-100" : "opacity-0 translate-y-1"
            }`}
            style={completed || i <= phase ? { animation: "aimodels-fade-in 0.3s ease-out both", animationDelay: `${i * 0.1}s` } : undefined}
          >
            {completed || i < phase ? (
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>
              </span>
            ) : i === phase ? (
              <span className="flex items-center justify-center w-5 h-5 shrink-0">
                <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
              </span>
            ) : (
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-700/50 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
              </span>
            )}
            <span className={completed || i <= phase ? (completed || i < phase ? "text-emerald-400" : "text-[var(--text-primary)]") : "text-[var(--text-muted)]"}>
              {step}
            </span>
          </div>
        ))}
      </div>

      {progressPercent !== null && !completed && (
        <div className="w-full max-w-[280px] mt-1">
          <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] mb-1.5">
            <span>{providerName}</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full h-2 bg-[var(--bg-deep)] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Reassuring footer */}
      {!completed && phase >= 1 && (
        <p className="text-xs text-[var(--text-muted)] text-center mt-2 aimodels-step-enter">
          {t("ai.pleaseDontClose")}
        </p>
      )}
    </div>
  );
}

function ClawAIOfferModal({
  open,
  onClose,
  token,
  onTokenChange,
  onConnectToken,
  showToken,
  onToggleToken,
  saving,
  errorMessage,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  onTokenChange: (value: string) => void;
  onConnectToken: () => void;
  showToken: boolean;
  onToggleToken: () => void;
  saving: boolean;
  errorMessage: string | null;
}) {
  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[999999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-[rgba(3,7,18,0.78)] backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="ClawBox AI token setup"
        className="relative z-10 w-full max-w-[680px] overflow-hidden rounded-[28px] border border-[var(--border-accent)] bg-[linear-gradient(160deg,rgba(17,24,39,0.985),rgba(23,32,48,0.97)_58%,rgba(13,17,23,0.985))] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.45)] sm:p-7"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close offer"
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/75 transition hover:border-orange-400/30 hover:bg-orange-500/10 hover:text-orange-100"
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>close</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/90">
            ClawBox AI
          </span>
          <span className="inline-flex items-center rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-orange-100">
            Portal token
          </span>
        </div>

        <h2 className="mt-4 max-w-xl text-3xl font-bold leading-tight text-white sm:text-4xl">
          Create your account and paste your ClawBox AI token
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/75 sm:text-base">
          Open the portal registration page, finish signup, generate a token there, and paste it here to connect ClawBox AI on this device.
        </p>

        <div className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-[rgba(13,17,23,0.45)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="text-sm font-semibold text-white">How it works</div>
          <ol className="mt-4 space-y-3">
            {[
              "Open the ClawBox AI registration page in a new tab.",
              "Create your account and generate a portal token.",
              "Paste that token below to finish setup.",
            ].map((item, index) => (
              <li key={item} className="flex items-start gap-3 text-sm text-white/90">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-orange-400/25 bg-orange-500/15 text-orange-100">
                  {index + 1}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 rounded-xl border border-orange-400/20 bg-orange-500/10 px-4 py-3 text-xs leading-relaxed text-orange-50/95">
            ClawBox owners also get an extended warranty benefit when using ClawBox services.
          </div>
        </div>

        <div className="mt-6">
          <a
            href={PORTAL_REGISTER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-orange-400/30 bg-orange-500/10 px-5 py-3 text-sm font-semibold text-orange-50 transition hover:bg-orange-500/18 hover:text-white shadow-[0_8px_30px_rgba(249,115,22,0.12)]"
          >
            Open registration
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>open_in_new</span>
          </a>
        </div>

        <div className="mt-6">
          <label
            htmlFor="clawai-portal-token"
            className="block text-xs font-semibold text-white/80"
          >
            ClawBox AI token
          </label>
          <div className="relative mt-2">
            <input
              id="clawai-portal-token"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onConnectToken();
              }}
              placeholder="Paste your portal token here"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-12 text-sm text-white outline-none transition focus:border-[var(--coral-bright)] placeholder:text-white/35"
            />
            <button
              type="button"
              onClick={onToggleToken}
              aria-label={showToken ? "Hide token" : "Show token"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/55 transition hover:text-white"
            >
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>
                {showToken ? "visibility_off" : "visibility"}
              </span>
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-white/60">
            After you register, generate a token in the portal and paste it here. We&apos;ll use it to configure ClawBox AI for this device.
          </p>
        </div>

        {errorMessage && (
          <div className="mt-4">
            <StatusMessage type="error" message={errorMessage} />
          </div>
        )}

        <div className="mt-6">
          <button
            type="button"
            onClick={onConnectToken}
            disabled={saving}
            className="inline-flex w-full items-center justify-center rounded-xl btn-gradient px-5 py-3 text-sm font-semibold text-white transition disabled:opacity-50"
          >
            {saving ? "Connecting..." : getConnectButtonLabel("ClawBox AI")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const PRIMARY_PROVIDER_IDS = new Set(["anthropic", "openai", "google", "clawai"]);

const PROVIDERS: Provider[] = [
  {
    id: "llamacpp",
    name: "Gemma 4",
    description: "Fast local AI for this device",
    authOptions: [
      {
        mode: "local" as AuthMode,
        label: "Local",
        placeholder: "",
        hint: "No API key needed. ClawBox manages the local Gemma 4 model for you.",
      },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Use Ollama models locally",
    authOptions: [
      {
        mode: "local" as AuthMode,
        label: "Local",
        placeholder: "",
        hint: "No API key needed. Models run on this device.",
      },
    ],
  },
  {
    id: "clawai",
    name: "ClawBox AI",
    description: "Register once, then paste your token",
    authOptions: [
      {
        mode: "local" as AuthMode,
        label: "Free",
        placeholder: "",
        hint: "Create a portal account, generate a token, and use it here.",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI GPT",
    description: "Best for business",
    authOptions: [
      {
        mode: "subscription",
        label: "Subscription",
        placeholder: "",
        hint: "Connect your ChatGPT Plus/Pro subscription via OAuth.",
      },
      {
        mode: "token",
        label: "API Key",
        placeholder: "sk-...",
        hint: "Get your API key from platform.openai.com",
        tokenUrl: "https://platform.openai.com/api-keys",
        tokenUrlLabel: "Get API Key",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    description: "Claude models by Anthropic",
    authOptions: [
      {
        mode: "token",
        label: "API Key",
        placeholder: "sk-ant-api03-...",
        hint: "Get your API key from console.anthropic.com",
        tokenUrl: "https://console.anthropic.com/settings/keys",
        tokenUrlLabel: "Get API Key",
      },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini models by Google",
    authOptions: [
      {
        mode: "token",
        label: "API Key",
        placeholder: "AIza...",
        hint: "Get your API key from Google AI Studio.",
        tokenUrl: "https://aistudio.google.com/apikey",
        tokenUrlLabel: "Get API Key",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Multi-provider AI gateway",
    authOptions: [
      {
        mode: "token",
        label: "API Key",
        placeholder: "sk-or-v1-...",
        hint: "Get your API key from OpenRouter.",
        tokenUrl: "https://openrouter.ai/keys",
        tokenUrlLabel: "Get API Key",
      },
    ],
  },
];

// Providers that use device code flow instead of redirect-based OAuth
const DEVICE_AUTH_PROVIDERS = new Set(["openai"]);


export default function AIModelsStep({
  onNext,
  embedded = false,
  onConfigured,
  providerIds,
  defaultProviderId,
  currentProviderId = null,
  currentModel = null,
  title,
  description,
  configureScope = "primary",
  testId = "setup-step-ai-models",
}: AIModelsStepProps) {
  const { t } = useT();
  const normalizedCurrentProvider = useMemo(
    () => normalizeSelectableProvider(currentProviderId),
    [currentProviderId],
  );
  const providerIdSet = useMemo(() => providerIds ? new Set(providerIds) : null, [providerIds]);
  const allowedProviders = useMemo(
    () => providerIdSet ? PROVIDERS.filter((provider) => providerIdSet.has(provider.id)) : PROVIDERS,
    [providerIdSet],
  );
  const resolvedDefaultProvider = useMemo(
    () => {
      if (defaultProviderId && allowedProviders.some((provider) => provider.id === defaultProviderId)) {
        return defaultProviderId;
      }
      return allowedProviders[0]?.id ?? "clawai";
    },
    [allowedProviders, defaultProviderId],
  );
  const genericSteps = useMemo(
    () => [
      t("ai.credentialsVerified"),
      t("ai.updatingConfig"),
      t("ai.restartingGateway"),
      t("ai.warmingUp"),
      t("ai.almostReady"),
    ],
    [t],
  );
  const ollamaInstallSteps = useMemo(
    () => [
      "Preparing Ollama",
      "Downloading model files",
      "Applying ClawBox configuration",
      "Warming up local model",
    ],
    [],
  );
  const llamaCppInstallSteps = useMemo(
    () => [
      "Preparing llama.cpp runtime",
      "Downloading Gemma model",
      "Starting llama.cpp runtime",
      "Applying ClawBox configuration",
      "Warming up local model",
    ],
    [],
  );
  const getStepsForKind = useCallback(
    (kind: ConfiguringKind) => {
      switch (kind) {
        case "ollama":
          return ollamaInstallSteps;
        case "llamacpp":
          return llamaCppInstallSteps;
        default:
          return genericSteps;
      }
    },
    [genericSteps, llamaCppInstallSteps, ollamaInstallSteps],
  );
  const [selectedProvider, setSelectedProvider] = useState<string | null>(resolvedDefaultProvider);
  const [authMode, setAuthMode] = useState<AuthMode>("local");
  const [showMoreProviders, setShowMoreProviders] = useState(false);
  const [availableOAuth, setAvailableOAuth] = useState<string[] | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const [selectedOllamaModel, setSelectedOllamaModel] = useState("llama3.2:3b");
  const [selectedLlamaCppModel, setSelectedLlamaCppModel] = useState("");
  const [configuringState, setConfiguringState] = useState<ConfiguringState | null>(null);
  const [showClawAIOffer, setShowClawAIOffer] = useState(false);

  // OAuth redirect flow state (Anthropic)
  const [oauthStarted, setOauthStarted] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [exchanging, setExchanging] = useState(false);

  // Device auth flow state (OpenAI)
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const exchangeControllerRef = useRef<AbortController | null>(null);
  const oauthStartControllerRef = useRef<AbortController | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const oauthWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    if (!allowedProviders.some((provider) => provider.id === selectedProvider)) {
      setSelectedProvider(resolvedDefaultProvider);
    }
  }, [allowedProviders, resolvedDefaultProvider, selectedProvider]);

  useEffect(() => {
    if (selectedProvider !== "clawai") {
      setShowClawAIOffer(false);
    }
  }, [selectedProvider]);

  useEffect(() => {
    if (!normalizedCurrentProvider) return;
    if (!allowedProviders.some((provider) => provider.id === normalizedCurrentProvider)) return;

    setSelectedProvider(normalizedCurrentProvider);

    if (typeof currentModel === "string") {
      if (currentModel.startsWith("ollama/")) {
        setSelectedOllamaModel(currentModel.replace(/^ollama\//, ""));
      } else if (currentModel.startsWith("llamacpp/")) {
        setSelectedLlamaCppModel(currentModel.replace(/^llamacpp\//, ""));
      }
    }
  }, [allowedProviders, currentModel, normalizedCurrentProvider]);

  const stopPolling = useCallback(() => {
    setDevicePolling(false);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    pollControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    fetch("/setup-api/ai-models/oauth/providers")
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data.providers)) setAvailableOAuth(data.providers); })
      .catch((err) => {
        console.error("[AIModelsStep] Failed to fetch OAuth providers:", err);
        setAvailableOAuth([]);
      });
    return () => {
      saveControllerRef.current?.abort();
      exchangeControllerRef.current?.abort();
      oauthStartControllerRef.current?.abort();
      pollControllerRef.current?.abort();
    };
  }, []);

  const showError = useCallback((message: string) => {
    setConfiguringState(null);
    setStatus({ type: "error", message });
  }, []);

  const showConfiguring = useCallback((kind: ConfiguringKind = "generic") => {
    tryCloseOAuthWindow(oauthWindowRef);
    setSaving(false);
    setExchanging(false);
    setDeviceSaving(false);
    setConfiguringState({
      provider: selectedProvider ?? "anthropic",
      kind,
      phase: 0,
      detail: null,
      progressPercent: null,
      completed: false,
    });
  }, [selectedProvider]);

  const completeConfiguring = useCallback((providerOverride?: string) => {
    const fallbackProvider = providerOverride ?? selectedProvider ?? "anthropic";
    setConfiguringState((current) => {
      const nextProvider = current?.provider ?? fallbackProvider;
      const nextKind = current?.kind
        ?? (nextProvider === "ollama" ? "ollama" : nextProvider === "llamacpp" ? "llamacpp" : "generic");
      const steps = getStepsForKind(nextKind);
      return {
        provider: nextProvider,
        kind: nextKind,
        phase: Math.max(0, steps.length - 1),
        detail: current?.detail ?? null,
        progressPercent: current?.progressPercent ?? null,
        completed: true,
      };
    });
  }, [getStepsForKind, selectedProvider]);

  const showSuccessAndContinue = useCallback(() => {
    tryCloseOAuthWindow(oauthWindowRef);
    completeConfiguring();
  }, [completeConfiguring]);

  const extractError = useCallback(async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    return typeof data.error === "string" ? data.error : fallback;
  }, []);

  // Ollama hook
  const ollamaCallbacks = useMemo<OllamaCallbacks>(() => ({
    onSaveSuccess: () => showSuccessAndContinue(),
    onSaveError: (message: string) => showError(message),
    onPullError: (message: string) => showError(message),
    onClearStatus: () => setStatus(null),
  }), [showError, showSuccessAndContinue]);

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
  } = useOllamaModels(ollamaCallbacks, configureScope);

  const llamaCppCallbacks = useMemo<LlamaCppCallbacks>(() => ({
    onSaveSuccess: () => showSuccessAndContinue(),
    onSaveError: (message: string) => showError(message),
    onClearStatus: () => setStatus(null),
  }), [showError, showSuccessAndContinue]);

  const {
    llamaCppRunning,
    llamaCppSaving,
    llamaCppProgress,
    checkLlamaCppStatus,
    saveLlamaCppConfig,
  } = useLlamaCppModels(llamaCppCallbacks, configureScope);

  const configuringKind = configuringState?.kind;
  const configuringCompleted = configuringState?.completed ?? false;

  useEffect(() => {
    if (configuringKind !== "generic" || configuringCompleted) return;

    const timers = CONFIGURING_STEP_DELAYS.map((delay, index) =>
      index === 0
        ? null
        : setTimeout(() => {
            setConfiguringState((current) => {
              if (!current || current.kind !== "generic" || current.completed) return current;
              return { ...current, phase: Math.max(current.phase, index) };
            });
          }, delay),
    );

    return () => {
      timers.forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, [configuringCompleted, configuringKind]);

  useEffect(() => {
    if (selectedProvider !== "ollama") return;
    if (!ollamaPulling && !ollamaSaving) return;

    const next = getOllamaOverlayProgress(
      {
        pulling: ollamaPulling,
        saving: !!ollamaSaving,
        pullProgress: ollamaPullProgress,
      },
      ollamaInstallSteps.length,
    );

    setConfiguringState({
      provider: "ollama",
      kind: "ollama",
      phase: next.phase,
      detail: next.detail,
      progressPercent: next.progressPercent,
      completed: false,
    });
  }, [
    ollamaInstallSteps.length,
    ollamaPullProgress,
    ollamaPulling,
    ollamaSaving,
    selectedProvider,
  ]);

  useEffect(() => {
    if (selectedProvider !== "llamacpp" || !llamaCppSaving) return;

    const next = getLlamaCppOverlayProgress(llamaCppProgress, llamaCppInstallSteps.length);
    setConfiguringState({
      provider: "llamacpp",
      kind: "llamacpp",
      phase: next.phase,
      detail: next.detail,
      progressPercent: next.progressPercent,
      completed: false,
    });
  }, [llamaCppInstallSteps.length, llamaCppProgress, llamaCppSaving, selectedProvider]);

  const selectProvider = useCallback((id: string) => {
    stopPolling();
    const provider = allowedProviders.find((p) => p.id === id);
    setSelectedProvider(id);
    // Pick the first auth mode that's actually available
    const options = provider?.authOptions.filter((opt) => {
      if (opt.mode === "subscription" && availableOAuth !== null) {
        return availableOAuth.includes(id);
      }
      return true;
    }) ?? [];
    setAuthMode(options[0]?.mode ?? "token");
    setApiKey("");
    setShowKey(false);
    setStatus(null);
    setOauthStarted(false);
    setAuthCode("");
    setDeviceCode(null);
    setDeviceUrl(null);
    setDeviceSaving(false);
    setConfiguringState(null);
    if (id === "ollama") checkOllamaStatus();
    if (id === "llamacpp") checkLlamaCppStatus();
  }, [allowedProviders, availableOAuth, checkLlamaCppStatus, checkOllamaStatus, stopPolling]);

  const saveProviderConfig = useCallback(async (payload: Record<string, unknown>) => {
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    showConfiguring();
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: configureScope, ...payload }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) return showError(await extractError(res, "Failed to configure"));
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        showSuccessAndContinue();
      } else {
        showError(data.error || "Failed to configure");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }, [configureScope, extractError, showConfiguring, showError, showSuccessAndContinue]);

  const saveModel = async () => {
    if (!selectedProvider) return showError(t("ai.selectProvider"));
    if (!apiKey.trim()) return showError(t("ai.enterKey"));
    await saveProviderConfig(
      { provider: selectedProvider, apiKey: apiKey.trim(), authMode },
    );
  };

  const saveClawAI = useCallback(async () => {
    setSelectedProvider("clawai");
    await saveProviderConfig({ provider: "clawai", apiKey: apiKey.trim() });
  }, [apiKey, saveProviderConfig]);

  const handleClawAIPrimaryAction = useCallback(() => {
    setStatus(null);
    setShowClawAIOffer(true);
  }, []);

  const handleClawAIConnectToken = useCallback(async () => {
    if (!apiKey.trim()) return showError(t("ai.enterKey"));
    await saveClawAI();
  }, [apiKey, saveClawAI, showError, t]);

  const handleSkipAction = useCallback(() => {
    setStatus(null);
    if (configureScope === "local") {
      stopPolling();
      setShowClawAIOffer(false);
      onNext?.();
      return;
    }
    selectProvider("clawai");
    setShowClawAIOffer(true);
  }, [configureScope, onNext, selectProvider, stopPolling]);

  // Save token received from any OAuth flow (device or redirect)
  const saveOAuthToken = useCallback(async (
    tokenData: { access_token: string; refresh_token?: string; expires_in?: number; projectId?: string }
  ) => {
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    showConfiguring();

    try {
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: configureScope,
          provider: selectedProvider,
          apiKey: tokenData.access_token,
          authMode: "subscription",
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
          ...(tokenData.projectId ? { projectId: tokenData.projectId } : {}),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) return showError(await extractError(saveRes, "Failed to save token"));
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        showSuccessAndContinue();
      } else {
        showError(saveData.error || "Failed to save token");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [configureScope, extractError, selectedProvider, showConfiguring, showError, showSuccessAndContinue]);

  // --- Device auth flow (OpenAI, Google) ---

  const deviceAuthLabels = useMemo<Record<string, {
    description: string;
    button: string;
    success: string;
  }>>(() => ({
    openai: {
      description: t("ai.openaiConnectDesc"),
      button: t("ai.openaiConnect"),
      success: t("ai.openaiSuccess"),
    },
  }), [t]);
  const currentDevice = deviceAuthLabels[selectedProvider ?? "openai"] ?? deviceAuthLabels.openai;

  const pollDeviceAuth = useCallback(async (interval: number) => {
    pollControllerRef.current?.abort();
    const controller = new AbortController();
    pollControllerRef.current = controller;

    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-poll", {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (!res.ok) {
        const errMsg = await extractError(res, "Polling failed");
        // Session expired or invalid — stop polling
        stopPolling();
        showError(errMsg);
        return;
      }

      const data = await res.json();
      if (controller.signal.aborted) return;

      if (data.status === "complete" && data.access_token) {
        stopPolling();
        setDeviceSaving(true);
        await saveOAuthToken(data);
        return;
      }

      if (data.status === "pending") {
        // Schedule next poll
        pollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
        return;
      }

      // Unexpected response
      if (data.error) {
        stopPolling();
        showError(data.error);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network error — retry
      pollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
    }
  }, [extractError, showError, stopPolling, saveOAuthToken]);

  const startDeviceAuth = async () => {
    stopPolling();
    oauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    oauthStartControllerRef.current = controller;

    setStatus(null);
    setDeviceCode(null);
    setDeviceUrl(null);

    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) return showError(await extractError(res, "Failed to start device auth"));
      const data = await res.json();
      if (controller.signal.aborted) return;

      if (data.user_code && data.verification_url) {
        setDeviceCode(data.user_code);
        setDeviceUrl(data.verification_url);
        setDevicePolling(true);
        // Start polling
        const interval = data.interval || 5;
        pollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
      } else {
        showError("Unexpected response from device auth");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  // --- Redirect OAuth flow (Anthropic) ---

  const startOAuth = async () => {
    oauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    oauthStartControllerRef.current = controller;

    setStatus(null);
    setOauthStarted(false);
    setAuthCode("");
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) return showError(await extractError(res, "Failed to start OAuth"));
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.url) {
        oauthWindowRef.current = window.open(data.url, "_blank");
        setOauthStarted(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const exchangeCode = async () => {
    if (!authCode.trim()) return showError(t("ai.enterKey"));

    const parsedCode = parseAuthInput(authCode);
    if (!parsedCode) return showError("Could not extract authorization code from input");

    exchangeControllerRef.current?.abort();
    const controller = new AbortController();
    exchangeControllerRef.current = controller;

    setExchanging(true);
    setStatus(null);
    showConfiguring();
    try {
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: parsedCode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!exchangeRes.ok) return showError(await extractError(exchangeRes, "Token exchange failed"));
      const tokenData = await exchangeRes.json();
      if (controller.signal.aborted) return;
      if (!tokenData.access_token) return showError("No access token received");

      await saveOAuthToken(tokenData);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setExchanging(false);
    }
  };

  const providerDesc: Record<string, string> = {
    clawai: "Portal token from your ClawBox AI account, plus extended warranty for ClawBox owners",
    anthropic: t("ai.claudeModels"),
    openai: t("ai.gptModels"),
    google: t("ai.geminiModels"),
    openrouter: t("ai.multiProvider"),
    ollama: t("ai.runLocally"),
    llamacpp: "GGUF + llama.cpp for 8GB devices",
  };

  const selected = allowedProviders.find((p) => p.id === selectedProvider);
  // Filter out subscription option for providers whose OAuth isn't configured on the backend
  const effectiveAuthOptions = selected?.authOptions.filter((opt) => {
    if (opt.mode === "subscription" && availableOAuth !== null) {
      return availableOAuth.includes(selected.id);
    }
    return true;
  }) ?? [];
  const activeAuth =
    effectiveAuthOptions.find((a) => a.mode === authMode) ??
    effectiveAuthOptions[0];
  const isSubscription = authMode === "subscription";
  const useDeviceAuth = isSubscription && DEVICE_AUTH_PROVIDERS.has(selectedProvider ?? "");

  const oauthLabels: Record<string, {
    button: string;
    description: string;
    success: string;
    steps: string[];
    inputLabel: string;
    inputPlaceholder: string;
  }> = {
    anthropic: {
      button: t("ai.anthropicConnect"),
      description: t("ai.anthropicConnectDesc"),
      success: t("ai.anthropicSuccess"),
      steps: [t("ai.anthropicStep1"), t("ai.anthropicStep2"), t("ai.anthropicStep3")],
      inputLabel: t("ai.anthropicInputLabel"),
      inputPlaceholder: t("ai.anthropicInputPlaceholder"),
    },
    openai: {
      button: t("ai.openaiConnect"),
      description: t("ai.openaiConnectDesc"),
      success: t("ai.openaiSuccess"),
      steps: [t("ai.openaiStep1"), t("ai.openaiStep2"), t("ai.openaiStep3")],
      inputLabel: t("ai.openaiInputLabel"),
      inputPlaceholder: t("ai.openaiInputPlaceholder"),
    },
    google: {
      button: t("ai.googleConnect"),
      description: t("ai.googleConnectDesc"),
      success: t("ai.googleSuccess"),
      steps: [t("ai.googleStep1"), t("ai.googleStep2"), t("ai.googleStep3")],
      inputLabel: t("ai.googleInputLabel"),
      inputPlaceholder: t("ai.googleInputPlaceholder"),
    },
  };
  const DEFAULT_OAUTH_PROVIDER = "anthropic";
  const currentOAuth = oauthLabels[selectedProvider ?? DEFAULT_OAUTH_PROVIDER] ?? oauthLabels[DEFAULT_OAUTH_PROVIDER];
  const selectedConnectLabel = getConnectButtonLabel(selected?.name);

  // --- Render helpers ---

  const renderDeviceAuth = () => (
    <div>
      <p className="text-xs text-[var(--text-secondary)] mb-4 leading-relaxed">
        {currentDevice.description}
      </p>

      {!deviceCode ? (
        <button
          type="button"
          onClick={startDeviceAuth}
          className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
        >
          {embedded ? currentDevice.button : selectedConnectLabel}
        </button>
      ) : (
        <div>
          <div className="mb-4 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
            <button
              type="button"
              onClick={() => {
                const win = window.open(deviceUrl!, "_blank");
                if (win) {
                  oauthWindowRef.current = win;
                }
              }}
              className="w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-medium rounded-lg transition-colors text-sm"
            >
              {t("ai.openAuthPage")}
            </button>
            <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">{t("ai.thenEnterCode")}</p>
            <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-lg inline-flex items-center gap-2">
              <span className="text-2xl font-mono font-bold text-gray-100 tracking-widest select-all">
                {deviceCode}
              </span>
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
                    const btn = document.getElementById("copy-code-btn");
                    if (btn) { btn.textContent = t("copied"); setTimeout(() => { btn.textContent = t("copy"); }, 1500); }
                  } catch { /* ignore */ }
                }}
                id="copy-code-btn"
                className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
              >
                {t("copy")}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              {t("ai.codeExpires")}
            </p>
          </div>

          {(devicePolling || deviceSaving) && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
              {deviceSaving ? t("ai.authorizedConnecting") : t("ai.waitingAuth")}
            </div>
          )}

          <button
            type="button"
            onClick={startDeviceAuth}
            className="mt-2 bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
          >
            {t("ai.getNewCode")}
          </button>
        </div>
      )}
    </div>
  );

  const renderRedirectOAuth = () => (
    <div>
      <p className="text-xs text-[var(--text-secondary)] mb-4 leading-relaxed">
        {currentOAuth.description}
      </p>

      {!oauthStarted ? (
        <button
          type="button"
          onClick={startOAuth}
          className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
        >
          {embedded ? currentOAuth.button : selectedConnectLabel}
        </button>
      ) : (
        <div>
          <div className="mb-4 p-3 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg">
            <p className="text-xs text-[var(--text-primary)] leading-relaxed">
              {currentOAuth.steps.map((step, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  <strong className="text-[var(--coral-bright)]">{i + 1}.</strong> {step}
                </span>
              ))}
            </p>
          </div>

          <label
            htmlFor="oauth-auth-code"
            className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
          >
            {currentOAuth.inputLabel}
          </label>
          <input
            id="oauth-auth-code"
            type="text"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") exchangeCode();
            }}
            placeholder={currentOAuth.inputPlaceholder}
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
          />

          <button
            type="button"
            onClick={startOAuth}
            className="mt-2 bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
          >
            {t("ai.restartAuth")}
          </button>
        </div>
      )}
    </div>
  );

  const handleConfiguringDone = useCallback(() => {
    if (embedded) {
      setConfiguringState(null);
      setStatus({ type: "success", message: t("ai.configured") });
      onConfigured?.();
    } else if (onNext) {
      onNext();
    } else {
      setConfiguringState(null);
      setStatus({ type: "success", message: t("ai.configured") });
    }
  }, [embedded, onNext, onConfigured, t]);

  useEffect(() => {
    if (!configuringState?.completed) return;
    const timer = setTimeout(handleConfiguringDone, 900);
    return () => clearTimeout(timer);
  }, [configuringState?.completed, handleConfiguringDone]);

  const displayedProviders = providerIdSet
    ? allowedProviders
    : PROVIDERS.filter((provider) => PRIMARY_PROVIDER_IDS.has(provider.id) || showMoreProviders || selectedProvider === provider.id);
  const shouldShowMoreProviders = !providerIdSet && !showMoreProviders && PROVIDERS.some((provider) => !PRIMARY_PROVIDER_IDS.has(provider.id));
  const resolvedTitle = title ?? t("ai.title");
  const resolvedDescription = description ?? t("ai.description");

  return (
    <div className="w-full max-w-[520px]" data-testid={testId}>
      <div className="card-surface rounded-2xl p-8 relative overflow-hidden">
        <ClawAIOfferModal
          open={showClawAIOffer && !configuringState}
          onClose={() => setShowClawAIOffer(false)}
          token={apiKey}
          onTokenChange={(value) => {
            setApiKey(value);
            if (status?.type === "error") setStatus(null);
          }}
          onConnectToken={handleClawAIConnectToken}
          showToken={showKey}
          onToggleToken={() => setShowKey((value) => !value)}
          saving={saving}
          errorMessage={status?.type === "error" ? status.message : null}
        />
        {configuringState && (
          <ConfiguringOverlay
            provider={configuringState.provider}
            steps={getStepsForKind(configuringState.kind)}
            phase={configuringState.phase}
            detail={configuringState.detail}
            progressPercent={configuringState.progressPercent}
            completed={configuringState.completed}
            t={t}
          />
        )}
        {/* Hide form content when configuring overlay is shown */}
        <div className={configuringState ? "invisible h-0 overflow-hidden" : ""}>
        <h1 className="text-2xl font-bold font-display mb-2">
          {resolvedTitle}
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          {resolvedDescription}
        </p>

        <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden">
          {displayedProviders.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <label
                key={provider.id}
                className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-orange-500/5"
                    : "hover:bg-[var(--surface-card)]"
                }`}
              >
                <input
                  type="radio"
                  name="ai-provider"
                  value={provider.id}
                  checked={isSelected}
                  onChange={() => selectProvider(provider.id)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
                    isSelected
                      ? "border-[var(--coral-bright)]"
                      : "border-gray-600"
                  }`}
                >
                  {isSelected && (
                    <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
                  )}
                </span>
                <div className="flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-200">
                    {provider.name}
                    {(provider.id === "clawai" || provider.id === "llamacpp") && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-orange-500/15 text-orange-400 leading-none">
                        {t("recommended")}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {providerDesc[provider.id] ?? provider.description}
                  </span>
                </div>
              </label>
            );
          })}
          {shouldShowMoreProviders && (
            <button
              type="button"
              onClick={() => setShowMoreProviders(true)}
              className="w-full px-4 py-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors text-left"
            >
              {t("ai.showMore")}
            </button>
          )}
        </div>

        {selected?.id === "ollama" && (
          <div className="mt-5 space-y-4">
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
              radioGroupName="ollama-model"
              buttonSpinner={ButtonSpinner}
            />
          </div>
        )}

        {selected?.id === "llamacpp" && (
          <div className="mt-5 space-y-4">
            <LlamaCppModelPanel
              llamaCppRunning={llamaCppRunning}
              llamaCppSaving={llamaCppSaving}
              llamaCppProgress={llamaCppProgress}
              selectedLlamaCppModel={selectedLlamaCppModel}
              setSelectedLlamaCppModel={setSelectedLlamaCppModel}
              saveLlamaCppConfig={saveLlamaCppConfig}
              buttonSpinner={ButtonSpinner}
            />
          </div>
        )}

        {selected && selected.id !== "ollama" && selected.id !== "llamacpp" && selected.id !== "clawai" && activeAuth && (
          <div className="mt-5">
            {effectiveAuthOptions.length > 1 && (
              <div className="flex gap-1 mb-4 p-1 bg-[var(--bg-deep)] rounded-lg">
                {effectiveAuthOptions.map((opt) => (
                  <button
                    type="button"
                    key={opt.mode}
                    onClick={() => {
                      stopPolling();
                      setAuthMode(opt.mode);
                      setApiKey("");
                      setShowKey(false);
                      setStatus(null);
                      setOauthStarted(false);
                      setAuthCode("");
                      setDeviceCode(null);
                      setDeviceUrl(null);
                    }}
                    className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer border-none ${
                      authMode === opt.mode
                        ? "bg-[var(--bg-surface)] text-gray-200"
                        : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {opt.mode === "token" ? t("ai.apiKey") : opt.mode === "subscription" ? t("ai.subscription") : opt.mode === "local" && selected?.id === "clawai" ? t("ai.free") : opt.mode === "local" ? t("ai.local") : opt.label}
                  </button>
                ))}
              </div>
            )}

            {isSubscription ? (
              useDeviceAuth ? renderDeviceAuth() : renderRedirectOAuth()
            ) : (
              /* Standard API Key Flow */
              <div>
                {activeAuth.tokenUrl && (
                  <a
                    href={activeAuth.tokenUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mb-3 text-xs font-medium text-[var(--coral-bright)] hover:text-orange-300 transition-colors"
                  >
                    {activeAuth.tokenUrlLabel === "Get API Key" ? t("ai.getApiKey") : t("ai.getToken")}
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
                  </a>
                )}

                <label
                  htmlFor="ai-api-key"
                  className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
                >
                  {selected.name} API Key
                </label>
                <div className="relative">
                  <input
                    id="ai-api-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveModel();
                    }}
                    placeholder={activeAuth.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>{showKey ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">{activeAuth.hint}</p>
              </div>
            )}
          </div>
        )}

        {selected?.id === "clawai" && (
          <div className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-4">
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Register for ClawBox AI, generate a portal token, and paste it into the popup to connect this device.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
              Use the button below to open the registration flow, then come back here and paste the token you generated.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-orange-200/90">
              ClawBox owners also get an extended warranty benefit with ClawBox.
            </p>
          </div>
        )}

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        <div className="flex items-center gap-3 mt-5">
          {selected?.id === "clawai" ? (
            <button
              type="button"
              onClick={handleClawAIPrimaryAction}
              disabled={saving}
              className="w-full py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
            >
              {saving && ButtonSpinner}
              {saving ? t("ai.configuring") : embedded ? t("save") : selectedConnectLabel}
            </button>
          ) : selected?.id === "ollama" ? (
            null /* Ollama has its own buttons above */
          ) : selected?.id === "llamacpp" ? (
            null /* llama.cpp has its own button above */
          ) : isSubscription ? (
            useDeviceAuth ? (
              /* Device auth has no manual submit button — it auto-completes via polling */
              null
            ) : (
              oauthStarted && (
                <button
                  type="button"
                  onClick={exchangeCode}
                  disabled={exchanging || !authCode.trim()}
                  className="w-full py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
                >
                  {exchanging && ButtonSpinner}
                  {exchanging ? t("connecting") : embedded ? t("save") : selectedConnectLabel}
                </button>
              )
            )
          ) : (
            <button
              type="button"
              onClick={saveModel}
              disabled={saving || !selectedProvider}
              className="w-full py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
            >
              {saving ? t("saving") : embedded ? t("save") : selectedConnectLabel}
            </button>
          )}
        </div>
        {!embedded && selectedProvider !== "clawai" && (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={handleSkipAction}
              disabled={saving}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer underline transition-colors"
            >
              {t("ai.skipClawai")}
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
