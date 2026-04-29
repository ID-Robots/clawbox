"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import { copyToClipboard } from "@/lib/clipboard";
import {
  extractProviderModelId,
  getProviderCatalog,
  isValidModelId,
} from "@/lib/provider-models";

type ClawaiTier = "free" | "flash" | "pro";
const CLAWAI_TIER_STORAGE_KEY = "clawbox:ai-models:clawai-tier";

interface ClawaiTierInfo {
  /** Plan label rendered to the user (Free/Pro/Max). Internal "flash" is
   *  marketed as "Pro" and internal "pro" is "Max" — preserved for
   *  backwards-compat with stored localStorage values + portal handshake. */
  planName: string;
  /** Selector pill label — same as planName today, kept separate so the
   *  pill can shorten if needed without touching the card. */
  pillLabel: string;
  priceEuro: number;
  /** Subtitle on the price line — "free forever", "/month", etc. */
  pricePeriod: string;
  /** True for tiers that should advertise a 30-day free trial CTA. */
  hasTrial: boolean;
  /** Bullet copy shown in the highlight card. */
  features: string[];
  /** Tailwind palette classes for the highlight card + selector pill. */
  cardClass: string;
  cardHeadlineClass: string;
  cardCheckClass: string;
  pillActiveClass: string;
}

const CLAWAI_TIER_INFO: Record<ClawaiTier, ClawaiTierInfo> = {
  free: {
    planName: "Free plan",
    pillLabel: "Free",
    priceEuro: 0,
    pricePeriod: "free forever",
    hasTrial: false,
    features: [
      "Standard daily usage",
      "DeepSeek V4 Flash",
      "1 GB ClawKeep cloud backups",
      "Portal access",
    ],
    cardClass: "border-white/10 bg-white/[0.03]",
    cardHeadlineClass: "text-gray-100",
    cardCheckClass: "text-emerald-300",
    pillActiveClass: "bg-[var(--bg-surface)] text-gray-100",
  },
  flash: {
    planName: "Pro plan",
    pillLabel: "Pro",
    priceEuro: 9,
    pricePeriod: "/month",
    hasTrial: true,
    features: [
      "5× more usage than Free",
      "DeepSeek V4 Flash",
      "5 GB ClawKeep cloud backups",
      "Remote Desktop access",
      "Priority processing",
      "Email support",
    ],
    cardClass: "border-orange-400/20 bg-orange-500/5",
    cardHeadlineClass: "text-orange-100",
    cardCheckClass: "text-orange-300",
    pillActiveClass: "bg-gradient-to-r from-orange-500/30 to-amber-500/20 text-orange-100",
  },
  pro: {
    planName: "Max plan",
    pillLabel: "Max",
    priceEuro: 49,
    pricePeriod: "/month",
    hasTrial: true,
    features: [
      "Maximum usage",
      "DeepSeek V4 Pro (frontier)",
      "50 GB ClawKeep cloud backups",
      "Remote Desktop access",
      "Highest priority",
      "Full Support — real humans via Call/Meeting",
    ],
    cardClass:
      "border-fuchsia-400/25 bg-gradient-to-br from-fuchsia-500/10 via-pink-500/5 to-transparent",
    cardHeadlineClass: "text-fuchsia-100",
    cardCheckClass: "text-fuchsia-300",
    pillActiveClass: "bg-gradient-to-r from-fuchsia-500/20 to-pink-500/20 text-pink-100",
  },
};

const CLAWAI_TIER_ORDER: readonly ClawaiTier[] = ["free", "flash", "pro"] as const;

interface AIModelsStepProps {
  onNext?: () => void;
  embedded?: boolean;
  onConfigured?: () => void;
  providerIds?: string[];
  defaultProviderId?: string;
  currentProviderId?: string | null;
  currentModel?: string | null;
  openClawAIOfferRequest?: number;
  requestedProviderId?: string | null;
  providerSelectionRequest?: number;
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

      {/* Local providers (llama.cpp / Ollama) compile and download multi-GB
         models — can take 10-15 min on Jetson. Cloud providers finish in
         seconds, so they get the shorter generic copy. */}
      {!completed && phase >= 1 && (
        <p className="text-xs text-[var(--text-muted)] text-center mt-2 aimodels-step-enter">
          {provider === "llamacpp" || provider === "ollama"
            ? t("ai.pleaseDontCloseLocal")
            : t("ai.pleaseDontClose")}
        </p>
      )}
    </div>
  );
}

const PRIMARY_PROVIDER_IDS = new Set(["clawai", "openai", "anthropic"]);

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
    description: "Recommended cloud experience for ClawBox owners",
    authOptions: [
      {
        mode: "subscription",
        label: "Subscription",
        placeholder: "",
        hint: "Open the ClawBox portal and enter the device code shown below.",
      },
      {
        mode: "token",
        label: "API Key",
        placeholder: "Paste your portal token",
        hint: "Paste a portal token if you've already issued one in the ClawBox dashboard.",
        tokenUrl: PORTAL_LOGIN_URL,
        tokenUrlLabel: "Open portal",
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
  openClawAIOfferRequest = 0,
  requestedProviderId = null,
  providerSelectionRequest = 0,
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
      "Checking local Gemma runtime",
      "Provisioning offline Gemma 4",
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
  // Once the user picks a radio (via selectProvider), stop auto-syncing the
  // selection from the currently-active provider. Without this, polling on
  // the parent (Settings refreshes localAiStatus every few seconds, which
  // bumps currentProviderId) would flip the radio back to whatever is
  // currently active — so a user on Ollama who clicks "Gemma 4" sees the
  // radio flip straight back to Ollama within a second.
  const userSelectedProviderRef = useRef(false);
  const [authMode, setAuthMode] = useState<AuthMode>(
    () => allowedProviders.find((provider) => provider.id === resolvedDefaultProvider)?.authOptions[0]?.mode ?? "local",
  );
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
  // Per-provider model picker. The catalog (see src/lib/provider-models.ts)
  // gives us a default modelId + curated list for Anthropic, OpenAI, Google,
  // and OpenRouter. When the user re-enters the screen we try to pre-seed
  // from the currently-configured model so their existing pick survives;
  // if the current model isn't in the catalog (user typed a custom ID),
  // we flip into custom-input mode so it isn't silently overwritten.
  // Provider+authMode selects the effective catalog. Subscription mode for
  // OpenAI routes through the `openai-codex` namespace (ChatGPT backend),
  // whose catalog is completely different from the token-mode `openai`
  // API catalog — `gpt-5.4` only exists via codex, `gpt-5` only via the
  // public API. Matching the catalog to the actual namespace prevents
  // the picker from offering IDs that the upstream will reject.
  const activeCatalog = useMemo(() => {
    if (selectedProvider === "openai" && authMode === "subscription") {
      return getProviderCatalog("openai-codex");
    }
    return getProviderCatalog(selectedProvider);
  }, [selectedProvider, authMode]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [customModelId, setCustomModelId] = useState<string>("");
  const [useCustomModel, setUseCustomModel] = useState<boolean>(false);
  const [modelTouched, setModelTouched] = useState(false);

  useEffect(() => {
    if (!activeCatalog || !selectedProvider) {
      setSelectedModelId("");
      setCustomModelId("");
      setUseCustomModel(false);
      setModelTouched(false);
      return;
    }
    if (modelTouched) return;
    // Extract modelId under the catalog's namespace, NOT the selected
    // provider's name — for openai+subscription these differ
    // (openai-codex vs openai).
    const currentModelId = extractProviderModelId(currentModel, activeCatalog.provider);
    if (!currentModelId) {
      setSelectedModelId(activeCatalog.defaultModelId);
      setCustomModelId("");
      setUseCustomModel(false);
      return;
    }
    const inCatalog = activeCatalog.models.some((option) => option.id === currentModelId);
    if (inCatalog) {
      setSelectedModelId(currentModelId);
      setCustomModelId("");
      setUseCustomModel(false);
    } else {
      setSelectedModelId(activeCatalog.defaultModelId);
      setCustomModelId(currentModelId);
      setUseCustomModel(true);
    }
  }, [activeCatalog, currentModel, modelTouched, selectedProvider]);
  const [configuringState, setConfiguringState] = useState<ConfiguringState | null>(null);
  const [clawaiTier, setClawaiTier] = useState<ClawaiTier>(() => {
    if (typeof window === "undefined") return "flash";
    const stored = window.localStorage?.getItem(CLAWAI_TIER_STORAGE_KEY);
    if (stored === "free" || stored === "pro" || stored === "flash") return stored;
    return "flash";
  });
  const persistClawaiTier = useCallback((tier: ClawaiTier) => {
    setClawaiTier(tier);
    if (typeof window !== "undefined") {
      try {
        window.localStorage?.setItem(CLAWAI_TIER_STORAGE_KEY, tier);
      } catch {
        // Storage may be unavailable (private mode, quota); the in-memory
        // value still drives the active connect flow.
      }
    }
  }, []);
  // ClawBox AI device-auth state — modeled after RFC 8628 / the OpenAI
  // device flow above. The user_code is generated on the device (or
  // upstream), shown in the Subscription tab, and the user types it on
  // the ClawBox portal. We poll the local /clawai/poll endpoint, which
  // in turn polls the upstream service for token issuance.
  const [clawaiDeviceCode, setClawaiDeviceCode] = useState<string | null>(null);
  const [clawaiCodeCopied, setClawaiCodeCopied] = useState(false);
  const clawaiCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel any in-flight "Copied" flash on unmount so the timer doesn't
  // call setState on an unmounted component.
  useEffect(() => () => {
    if (clawaiCopyTimerRef.current) clearTimeout(clawaiCopyTimerRef.current);
  }, []);
  const [clawaiVerificationUrl, setClawaiVerificationUrl] = useState<string | null>(null);
  const [clawaiDevicePolling, setClawaiDevicePolling] = useState(false);

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
  const clawAiStartControllerRef = useRef<AbortController | null>(null);
  const clawAiPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clawAiPollControllerRef = useRef<AbortController | null>(null);
  // Tracks whether we've already surfaced the configuring overlay for
  // the current device-auth attempt. The poll route returns
  // `configuring` for every tick while the background gateway restart
  // is in flight, so without this latch the overlay would reset to
  // phase 0 every interval and look like the progress bar is looping
  // back to the start.
  const clawAiConfiguringShownRef = useRef(false);

  const stopPolling = useCallback(() => {
    setDevicePolling(false);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    pollControllerRef.current?.abort();
  }, []);

  const stopClawAiPolling = useCallback(() => {
    if (clawAiPollRef.current) {
      clearTimeout(clawAiPollRef.current);
      clawAiPollRef.current = null;
    }
    clawAiPollControllerRef.current?.abort();
    clawAiPollControllerRef.current = null;
    clawAiStartControllerRef.current?.abort();
    clawAiStartControllerRef.current = null;
    clawAiConfiguringShownRef.current = false;
    setClawaiDevicePolling(false);
  }, []);

  useEffect(() => {
    if (normalizedCurrentProvider !== "clawai") return;
    stopClawAiPolling();
    setSaving(false);
    setStatus((current) => (current?.type === "error" ? null : current));
    setClawaiDeviceCode(null);
    setClawaiVerificationUrl(null);
  }, [normalizedCurrentProvider, stopClawAiPolling]);

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
      clawAiStartControllerRef.current?.abort();
      if (clawAiPollRef.current) clearTimeout(clawAiPollRef.current);
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
    setClawaiDeviceCode(null);
    setClawaiVerificationUrl(null);
    setClawaiDevicePolling(false);
    // Dispatch the gateway-restart signal as soon as we know the configure
    // round-trip succeeded — well before the success overlay's 900 ms exit
    // timer expires. The chat popup listens for this event to extend its
    // reconnect budget, so emitting it early keeps the chat from giving up
    // with "Could not connect to gateway" while the restart is still in
    // flight after a fresh ClawBox AI handoff.
    if (configureScope === "primary" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("clawbox:primary-ai-configured"));
    }
    completeConfiguring();
  }, [completeConfiguring, configureScope]);

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
    llamaCppInstalled,
    llamaCppSaving,
    llamaCppProgress,
    checkLlamaCppStatus,
    saveLlamaCppConfig,
  } = useLlamaCppModels(llamaCppCallbacks, configureScope);

  const getAvailableAuthOptionsForProvider = useCallback((providerId: string | null) => {
    if (!providerId) return [];
    const provider = allowedProviders.find((p) => p.id === providerId);
    return provider?.authOptions.filter((opt) => {
      if (opt.mode === "subscription" && availableOAuth !== null && providerId !== "clawai") {
        // ClawBox AI's Subscription tab is served by our own routes
        // (/clawai/start + /clawai/poll) so the upstream OAuth provider
        // list doesn't gate it. Other providers stay gated since their
        // subscription flow needs a configured OAuth client.
        return availableOAuth.includes(providerId);
      }
      return true;
    }) ?? [];
  }, [allowedProviders, availableOAuth]);

  const syncProviderSelection = useCallback((providerId: string) => {
    stopPolling();
    setSelectedProvider(providerId);
    setAuthMode(getAvailableAuthOptionsForProvider(providerId)[0]?.mode ?? "token");
    setModelTouched(false);
    setApiKey("");
    setShowKey(false);
    setStatus(null);
    setOauthStarted(false);
    setAuthCode("");
    setDeviceCode(null);
    setDeviceUrl(null);
    setDeviceSaving(false);
    setConfiguringState(null);
    if (providerId === "ollama") checkOllamaStatus();
    if (providerId === "llamacpp") checkLlamaCppStatus();
  }, [
    checkLlamaCppStatus,
    checkOllamaStatus,
    getAvailableAuthOptionsForProvider,
    stopPolling,
  ]);

  const configuringKind = configuringState?.kind;
  const configuringCompleted = configuringState?.completed ?? false;

  useEffect(() => {
    if (selectedProvider && allowedProviders.some((provider) => provider.id === selectedProvider)) {
      return;
    }
    if (!resolvedDefaultProvider) return;
    syncProviderSelection(resolvedDefaultProvider);
  }, [allowedProviders, resolvedDefaultProvider, selectedProvider, syncProviderSelection]);

  useEffect(() => {
    const options = getAvailableAuthOptionsForProvider(selectedProvider);
    if (!options.length) return;
    if (!options.some((opt) => opt.mode === authMode)) {
      setModelTouched(false);
      setAuthMode(options[0].mode);
    }
  }, [authMode, getAvailableAuthOptionsForProvider, selectedProvider]);

  useEffect(() => {
    if (!normalizedCurrentProvider) return;
    if (!allowedProviders.some((provider) => provider.id === normalizedCurrentProvider)) return;

    // Respect a user's explicit radio click — once they've picked a
    // provider, don't yank the selection back to whatever the parent
    // reports as currently-active. Still update the selected model slug
    // inside the active provider's panel, because that affects which
    // item is highlighted inside the list and isn't the same as the
    // provider-switch.
    if (!userSelectedProviderRef.current && selectedProvider !== normalizedCurrentProvider) {
      syncProviderSelection(normalizedCurrentProvider);
    }

    if (typeof currentModel === "string") {
      if (currentModel.startsWith("ollama/")) {
        setSelectedOllamaModel(currentModel.replace(/^ollama\//, ""));
      } else if (currentModel.startsWith("llamacpp/")) {
        setSelectedLlamaCppModel(currentModel.replace(/^llamacpp\//, ""));
      }
    }
  }, [
    allowedProviders,
    currentModel,
    normalizedCurrentProvider,
    selectedProvider,
    syncProviderSelection,
  ]);

  useEffect(() => {
    if (selectedProvider === "llamacpp") checkLlamaCppStatus();
    if (selectedProvider === "ollama") checkOllamaStatus();
  }, [selectedProvider, checkLlamaCppStatus, checkOllamaStatus]);

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
    userSelectedProviderRef.current = true;
    syncProviderSelection(id);
  }, [syncProviderSelection]);

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

  const getRequestedCatalogModelId = useCallback((fallbackToDefault = false) => {
    if (!activeCatalog) return "";
    const requestedId = useCustomModel ? customModelId.trim() : selectedModelId.trim();
    return requestedId || (fallbackToDefault ? activeCatalog.defaultModelId : "");
  }, [activeCatalog, customModelId, selectedModelId, useCustomModel]);

  const saveModel = async () => {
    if (!selectedProvider) return showError(t("ai.selectProvider"));
    if (!apiKey.trim()) return showError(t("ai.enterKey"));
    const payload: Record<string, unknown> = {
      provider: selectedProvider,
      apiKey: apiKey.trim(),
      authMode,
    };
    if (selectedProvider === "clawai") {
      payload.clawaiTier = clawaiTier;
    } else if (activeCatalog) {
      const requestedId = getRequestedCatalogModelId();
      if (!requestedId) {
        return showError(`Please choose a model for ${selectedProvider}`);
      }
      if (!isValidModelId(activeCatalog.provider, requestedId)) {
        return showError(`Invalid model ID for ${activeCatalog.provider}: ${requestedId}`);
      }
      payload.model = requestedId;
    }
    await saveProviderConfig(payload);
  };

  // Single tick of the upstream-issuance poll. Schedules itself again
  // every `interval` seconds while the session stays in `pending` or
  // `configuring`. The server-side route returns `configuring` as soon
  // as the upstream issues a token and runs the gateway-restart in the
  // background; we keep polling at that point so the UI advances when
  // the configure pipeline writes `complete`.
  const pollClawAiDeviceAuth = useCallback(async (interval: number) => {
    clawAiPollControllerRef.current?.abort();
    const controller = new AbortController();
    clawAiPollControllerRef.current = controller;
    try {
      const response = await fetch("/setup-api/ai-models/clawai/poll", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const data = await response.json().catch(() => ({})) as { status?: string; error?: string };
      if (data.status === "complete") {
        stopClawAiPolling();
        setSaving(false);
        showSuccessAndContinue();
        return;
      }
      if (data.status === "configuring") {
        // Token landed; the device is now restarting the gateway.
        // Surface the configuring overlay (drops the device-code page)
        // and keep polling on the `pending` cadence so we pick up
        // `complete` as soon as the background configure finishes.
        // Latch via clawAiConfiguringShownRef so subsequent ticks (the
        // server returns `configuring` for every tick while the gateway
        // restart is in flight) don't reset the overlay back to phase
        // 0 and make the progress bar look like it's looping.
        if (!clawAiConfiguringShownRef.current) {
          clawAiConfiguringShownRef.current = true;
          setClawaiDeviceCode(null);
          setClawaiVerificationUrl(null);
          setClawaiDevicePolling(false);
          setSaving(false);
          showConfiguring("generic");
        }
        clawAiPollRef.current = setTimeout(() => {
          void pollClawAiDeviceAuth(interval);
        }, Math.max(interval, 1) * 1000);
        return;
      }
      if (data.status === "error" || (!response.ok && response.status === 410)) {
        stopClawAiPolling();
        setSaving(false);
        setClawaiDeviceCode(null);
        showError(data.error || "ClawBox AI authorisation failed");
        return;
      }
      // Pending (or transient upstream blip): schedule the next tick.
      clawAiPollRef.current = setTimeout(() => {
        void pollClawAiDeviceAuth(interval);
      }, Math.max(interval, 1) * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network glitch — back off and try again instead of dropping
      // the user out of the flow.
      clawAiPollRef.current = setTimeout(() => {
        void pollClawAiDeviceAuth(interval);
      }, Math.max(interval, 1) * 1000);
    }
  }, [showConfiguring, showError, showSuccessAndContinue, stopClawAiPolling]);

  // Kicks off the device-authorisation handshake: asks the server for a
  // user_code + verification_url, shows them in the Subscription tab,
  // and starts polling for token issuance. The user types the code on
  // the ClawBox portal — there's no popup to open here, so the embedded
  // Chromium's pop-up blocker is no longer in the critical path.
  const startClawaiDeviceAuth = useCallback(async () => {
    setStatus(null);
    setSaving(true);
    setClawaiDeviceCode(null);
    setClawaiVerificationUrl(null);
    stopClawAiPolling();

    const controller = new AbortController();
    clawAiStartControllerRef.current = controller;
    try {
      const response = await fetch("/setup-api/ai-models/clawai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: configureScope, tier: clawaiTier }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        throw new Error(await extractError(response, "Failed to start ClawBox AI authorisation"));
      }
      const data = await response.json() as { user_code?: string; verification_url?: string; interval?: number };
      if (!data.user_code || !data.verification_url) {
        throw new Error("ClawBox AI did not return a device code");
      }
      setClawaiDeviceCode(data.user_code);
      setClawaiVerificationUrl(data.verification_url);
      setClawaiDevicePolling(true);
      setSaving(false);
      const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
      clawAiPollRef.current = setTimeout(() => {
        void pollClawAiDeviceAuth(interval);
      }, interval * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSaving(false);
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [clawaiTier, configureScope, extractError, pollClawAiDeviceAuth, showError, stopClawAiPolling]);

  const lastHandledOfferRef = useRef(0);
  useEffect(() => {
    if (!openClawAIOfferRequest || openClawAIOfferRequest === lastHandledOfferRef.current) return;
    if (!allowedProviders.some((provider) => provider.id === "clawai")) return;
    lastHandledOfferRef.current = openClawAIOfferRequest;
    selectProvider("clawai");
    void startClawaiDeviceAuth();
  }, [allowedProviders, startClawaiDeviceAuth, openClawAIOfferRequest, selectProvider]);

  const lastHandledProviderSelectionRef = useRef(0);
  useEffect(() => {
    if (!providerSelectionRequest || providerSelectionRequest === lastHandledProviderSelectionRef.current) return;
    const normalizedRequestedProvider = normalizeSelectableProvider(requestedProviderId);
    if (!normalizedRequestedProvider) return;
    if (!allowedProviders.some((provider) => provider.id === normalizedRequestedProvider)) return;
    lastHandledProviderSelectionRef.current = providerSelectionRequest;
    selectProvider(normalizedRequestedProvider);
  }, [allowedProviders, providerSelectionRequest, requestedProviderId, selectProvider]);

  const handleSkipAction = useCallback(() => {
    setStatus(null);
    stopPolling();
    onNext?.();
  }, [onNext, stopPolling]);

  // Save token received from any OAuth flow (device or redirect)
  const saveOAuthToken = useCallback(async (
    tokenData: { access_token: string; refresh_token?: string; expires_in?: number; projectId?: string }
  ) => {
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    showConfiguring();

    try {
      // For subscription flows (ChatGPT/Codex OAuth), include the
      // user's model pick so the backend writes openai-codex/<chosen>
      // instead of the PROVIDERS subscriptionOverride default. Without
      // this, picking a model in the wizard would silently be ignored
      // for OAuth providers.
      const subscriptionModel = getRequestedCatalogModelId(true);
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
          ...(subscriptionModel ? { model: subscriptionModel } : {}),
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
  }, [configureScope, extractError, getRequestedCatalogModelId, selectedProvider, showConfiguring, showError, showSuccessAndContinue]);

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
    clawai: "All-in cloud AI for ClawBox — backups, remote desktop, full support",
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
    if (opt.mode === "subscription" && availableOAuth !== null && selected.id !== "clawai") {
      // ClawBox AI's Subscription tab routes through our own
      // /clawai/start + /clawai/poll endpoints — there's no third-party
      // OAuth client to gate on, so the upstream `availableOAuth` list
      // doesn't apply. Other providers stay gated by it because their
      // subscription flow needs configured OAuth client credentials.
      return availableOAuth.includes(selected.id);
    }
    return true;
  }) ?? [];
  const activeAuth =
    effectiveAuthOptions.find((a) => a.mode === authMode) ??
    effectiveAuthOptions[0];
  const currentAuthMode = activeAuth?.mode ?? authMode;
  const isSubscription = currentAuthMode === "subscription";
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

  const renderProviderModelPicker = () => {
    if (!activeCatalog || !selected) return null;
    return (
      <div className="mt-4">
        <label
          htmlFor="ai-provider-model"
          className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
        >
          Model
        </label>
        {!useCustomModel ? (
          <select
            id="ai-provider-model"
            value={selectedModelId}
            onChange={(e) => {
              setModelTouched(true);
              setSelectedModelId(e.target.value);
            }}
            className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors"
          >
            {activeCatalog.models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} — {option.hint}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="ai-provider-model"
            type="text"
            value={customModelId}
            onChange={(e) => {
              setModelTouched(true);
              setCustomModelId(e.target.value);
            }}
            placeholder={
              selected.id === "openrouter"
                ? "org/model-id (e.g. mistralai/mistral-large)"
                : `model-id (e.g. ${activeCatalog.defaultModelId})`
            }
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
          />
        )}
        {activeCatalog.allowCustom && (
          <button
            type="button"
            onClick={() => {
              setModelTouched(true);
              setUseCustomModel((value) => !value);
            }}
            className="mt-1.5 bg-transparent p-0 text-xs font-medium text-[var(--coral-bright)] hover:text-orange-300 cursor-pointer border-none"
          >
            {useCustomModel
              ? "Pick from curated list"
              : "Enter a custom model ID…"}
          </button>
        )}
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          {selected.id === "openrouter"
            ? "OpenRouter exposes 340+ models. You can switch models later from the chat window."
            : "You can switch between the curated models from the chat window anytime."}
        </p>
      </div>
    );
  };

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

  const baseProviders = providerIdSet ? allowedProviders : PROVIDERS;
  const collapseSecondary = baseProviders.some((provider) => PRIMARY_PROVIDER_IDS.has(provider.id));
  const displayedProviders = collapseSecondary
    ? baseProviders.filter((provider) => PRIMARY_PROVIDER_IDS.has(provider.id) || showMoreProviders || selectedProvider === provider.id)
    : baseProviders;
  const shouldShowMoreProviders = collapseSecondary && !showMoreProviders && baseProviders.some((provider) => !PRIMARY_PROVIDER_IDS.has(provider.id));
  const resolvedTitle = title ?? t("ai.title");
  const resolvedDescription = description ?? t("ai.description");
  const embeddedConnectLabel = t("settings.connect");

  return (
    <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
      <div className="card-surface rounded-2xl p-5 sm:p-8 relative overflow-hidden">
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
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-2">
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
                <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] shrink-0">
                  <AIProviderIcon provider={provider.id} size={22} />
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
              llamaCppInstalled={llamaCppInstalled}
              llamaCppIsActive={normalizedCurrentProvider === "llamacpp"}
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
                      setModelTouched(false);
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
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>{showKey ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">{activeAuth.hint}</p>
              </div>
            )}
            {renderProviderModelPicker()}
          </div>
        )}

        {selected?.id === "clawai" && (
          <div className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-4">
            <p className="text-xs leading-relaxed text-orange-200/90">
              Max plan unlocks ClawKeep cloud backups, Remote Desktop, and extended warranty for ClawBox owners.
            </p>
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Tier
              </span>
              <div role="radiogroup" aria-label="ClawBox AI tier" className="relative inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-0.5">
                {CLAWAI_TIER_ORDER.map((tier) => {
                  const info = CLAWAI_TIER_INFO[tier];
                  const isActive = clawaiTier === tier;
                  const ariaLabel = info.hasTrial ? `${info.pillLabel} tier, Trial` : `${info.pillLabel} tier`;
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      aria-label={ariaLabel}
                      key={tier}
                      onClick={() => persistClawaiTier(tier)}
                      className={`relative px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer border-none ${
                        isActive
                          ? info.pillActiveClass
                          : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      }`}
                    >
                      {info.pillLabel}
                      {info.hasTrial && (
                        <span
                          aria-hidden="true"
                          className="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_2px_8px_rgba(217,70,239,0.45)] whitespace-nowrap leading-none"
                        >
                          Trial
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Plan-tier card mirrors the portal's Subscription Plans block:
                same name/price/feature data so the in-Settings preview and
                the portal billing page never disagree. */}
            {(() => {
              const info = CLAWAI_TIER_INFO[clawaiTier];
              return (
                <div className={`mt-3 rounded-lg border px-3.5 py-3 ${info.cardClass}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-sm font-bold ${info.cardHeadlineClass}`}>
                        {info.planName}
                      </span>
                      <span className="text-xs font-semibold text-[var(--text-secondary)]">
                        €{info.priceEuro}
                      </span>
                      <span className="text-[11px] text-[var(--text-muted)]">{info.pricePeriod}</span>
                    </div>
                    {info.hasTrial && clawaiTier === "pro" && (
                      <a
                        href={`${PORTAL_LOGIN_URL}/billing`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)] hover:from-fuchsia-400 hover:to-pink-400 transition-colors whitespace-nowrap"
                      >
                        Start 30-day free trial
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
                      </a>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]">
                    {info.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-1.5">
                        <span
                          aria-hidden="true"
                          className={`material-symbols-rounded shrink-0 ${info.cardCheckClass}`}
                          style={{ fontSize: 12, marginTop: 2 }}
                        >
                          check_circle
                        </span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* Subscription / API Key tabs — same shape as the OpenAI
                provider, so users get one mental model for "device-flow
                vs paste a key". */}
            {effectiveAuthOptions.length > 1 && (
              <div className="mt-4 flex gap-1 p-1 bg-[var(--bg-deep)] rounded-lg">
                {effectiveAuthOptions.map((opt) => (
                  <button
                    type="button"
                    key={opt.mode}
                    onClick={() => {
                      stopClawAiPolling();
                      setAuthMode(opt.mode);
                      setApiKey("");
                      setShowKey(false);
                      setStatus(null);
                      setClawaiDeviceCode(null);
                      setClawaiVerificationUrl(null);
                    }}
                    className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer border-none ${
                      authMode === opt.mode
                        ? "bg-[var(--bg-surface)] text-gray-200"
                        : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {opt.mode === "subscription" ? t("ai.subscription") : t("ai.apiKey")}
                  </button>
                ))}
              </div>
            )}

            {/* Subscription tab — RFC 8628-style device-authorisation flow.
                Render either the kick-off button (no code yet) or the
                code + Open authorization page + polling indicator. */}
            {currentAuthMode === "subscription" && (
              <div className="mt-4">
                <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-3">
                  Open the ClawBox portal and enter the device code shown below. Your device finishes the handoff once you confirm on the portal.
                </p>
                {!clawaiDeviceCode ? (
                  <button
                    type="button"
                    onClick={() => { void startClawaiDeviceAuth(); }}
                    disabled={saving}
                    className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
                  >
                    {saving && ButtonSpinner}
                    {saving ? t("connecting") : "Get device code"}
                  </button>
                ) : (
                  <div>
                    <div className="mb-3 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
                      <a
                        href={clawaiVerificationUrl ?? PORTAL_LOGIN_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-2 w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-medium rounded-lg transition-colors text-sm no-underline"
                      >
                        Open authorization page
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>open_in_new</span>
                      </a>
                      <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">Then enter this code:</p>
                      <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-lg inline-flex items-center gap-2">
                        <span className="text-2xl font-mono font-bold text-gray-100 tracking-widest select-all">
                          {clawaiDeviceCode}
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            const code = clawaiDeviceCode;
                            if (!code) return;
                            const ok = await copyToClipboard(code);
                            if (!ok) return;
                            setClawaiCodeCopied(true);
                            if (clawaiCopyTimerRef.current) clearTimeout(clawaiCopyTimerRef.current);
                            clawaiCopyTimerRef.current = setTimeout(() => setClawaiCodeCopied(false), 1500);
                          }}
                          className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
                        >
                          {clawaiCodeCopied ? t("copied") : t("copy")}
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        Code expires in 15 minutes
                      </p>
                    </div>

                    {clawaiDevicePolling && (
                      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
                        Waiting for authorization…
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => { void startClawaiDeviceAuth(); }}
                      className="mt-2 bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
                    >
                      Get a new code
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* API Key tab — direct token paste, same UX as other providers. */}
            {currentAuthMode === "token" && (
              <div className="mt-4">
                <label htmlFor="clawai-portal-token" className="block text-xs font-semibold text-[var(--text-secondary)] mb-2">
                  Portal token
                </label>
                <div className="relative">
                  <input
                    id="clawai-portal-token"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      if (status?.type === "error") setStatus(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveModel();
                      }
                    }}
                    placeholder="Paste your portal token"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 pr-11 text-sm bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-gray-100 outline-none transition focus:border-[var(--coral-bright)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide token" : "Show token"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-1"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>
                      {showKey ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  Issue a token in the <a href={PORTAL_LOGIN_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--coral-bright)] underline">ClawBox portal</a> and paste it here.
                </p>
              </div>
            )}
          </div>
        )}

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        <div className="flex items-center gap-3 mt-5">
          {selected?.id === "clawai" ? (
            currentAuthMode === "token" ? (
              <button
                type="button"
                onClick={saveModel}
                disabled={saving || !apiKey.trim()}
                className="w-full py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
              >
                {saving && ButtonSpinner}
                {saving ? (embedded ? t("connecting") : t("ai.configuring")) : embedded ? embeddedConnectLabel : selectedConnectLabel}
              </button>
            ) : (
              /* Subscription tab drives its own button via the device-auth
                 panel above; no extra Connect button here. */
              null
            )
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
                  {exchanging ? t("connecting") : embedded ? embeddedConnectLabel : selectedConnectLabel}
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
              {saving ? t("connecting") : embedded ? embeddedConnectLabel : selectedConnectLabel}
            </button>
          )}
        </div>
        {!embedded && (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={handleSkipAction}
              disabled={saving}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer underline transition-colors"
            >
              {configureScope === "local" ? t("skip") : t("ai.skipUseLocalOnly")}
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
