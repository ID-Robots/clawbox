"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import StatusMessage from "./StatusMessage";
import OllamaModelPanel from "./OllamaModelPanel";
import LlamaCppModelPanel from "./LlamaCppModelPanel";
import AIProviderIcon from "./AIProviderIcon";
import { notifyProvidersChanged } from "@/lib/ui-events";
import HermesProviderConfig from "./HermesProviderConfig";
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
import {
  extractProviderModelId,
  isCatalogProvider,
  isValidModelId,
} from "@/lib/provider-models";
import { useProviderCatalog } from "@/hooks/useProviderCatalog";
import { ButtonSpinner } from "./ButtonSpinner";
import ClawboxAiProviderRow from "./ClawboxAiProviderRow";
import ClawboxAiPlanPicker from "./ClawboxAiPlanPicker";
import ClawboxAiDeviceLogin from "./ClawboxAiDeviceLogin";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";
import { cachedEdition, fetchHarness } from "@/lib/client-harness";
// Tier data + the ClawBox AI card/row/device-login now live in shared modules so
// the Hermes provider panel renders the SAME experience instead of a lookalike.
import {
  CLAWAI_TIER_STORAGE_KEY,
  readStoredUiTier,
  resolveUiTier,
  type ClawaiTier,
} from "@/lib/clawbox-ai-tiers";
import {
  readImageAllowance,
  type ClawboxAiImageAllowance,
} from "@/lib/clawbox-ai-models";
import ClawboxAiImageAllowanceLine from "./ClawboxAiImageAllowanceLine";

interface AIModelsStepProps {
  onNext?: () => void;
  embedded?: boolean;
  onConfigured?: () => void;
  providerIds?: string[];
  defaultProviderId?: string;
  currentProviderId?: string | null;
  currentModel?: string | null;
  /**
   * Whether the local model is the harness's ACTIVE selection, as opposed to
   * merely installed. `currentProviderId` only ever reported the latter, so the
   * llama.cpp panel showed an "already configured" pill — and hid its own
   * switch button — on devices that were not actually using the model.
   * Undefined keeps the old provider-id-derived behaviour for callers that
   * don't know the difference (the setup wizard).
   */
  localAiIsActive?: boolean;
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
  // `codex` is the ChatGPT-subscription provider id (was `openai-codex` on
  // OpenClaw <=2026.5.x); maps to the OpenAI radio like the openai* ids.
  if (normalized.startsWith("openai") || normalized === "codex") return "openai";
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

/**
 * When each row of the generic "configuring" overlay lights up, in ms.
 *
 * The LAST entry is deliberately not used by the timer — see the effect that
 * schedules these. Driving the final row off a stopwatch is what made this
 * screen lie: it reached "Almost ready" at 22 s and then sat there, unchanged,
 * for the remaining two minutes the config writes actually took, which reads as
 * a hang on a screen that is also asking the customer not to close the page
 * (TASK-483).
 */
const CONFIGURING_STEP_DELAYS = [0, 2000, 5000, 12000, 22000];

/**
 * How often the plan/allowance card re-asks the portal while mounted
 * (TASK-516). Slow on purpose: the number it protects moves at most twenty
 * times a day, and every tick is a portal round-trip. What it must beat is
 * "forever", which is what a mount-only read gave a Settings window the
 * desktop never unmounts.
 */
const ALLOWANCE_REFRESH_MS = 30_000;

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
    <div ref={overlayRef} tabIndex={-1} className="flex flex-col items-center gap-6 px-2 pt-2 pb-6 outline-none">
      <style>{`
        @keyframes aimodels-check-draw { to { stroke-dashoffset: 0 } }
        @keyframes aimodels-fade-in { from { opacity: 0; transform: translateY(var(--lift)) } to { opacity: 1; transform: translateY(0) } }
        .aimodels-fade-in { animation: aimodels-fade-in var(--d-3) var(--ease-entrance) both }
      `}</style>

      {/* The provider mark, and nothing orbiting it. Two counter-rotating
          dot rings and a pulsing halo ran at the same speed at 0% and at
          99% of a gateway restart — perpetual motion bound to no state,
          while the checklist and the percentage below it were doing the
          actual reporting. The mark sits in the product's own tile
          instead, and turns cyan (DONE) when the work lands. */}
      <div
        className={`flex h-[72px] w-[72px] items-center justify-center rounded-[var(--r-3)] ${
          completed ? "bg-[var(--cyan-wash)]" : "bg-[var(--fill-2)]"
        }`}
        style={{ transition: "background-color var(--d-3) var(--ease-standard)" }}
      >
        {completed ? (
          <svg width="44" height="44" viewBox="0 0 56 56" fill="none" className="aimodels-fade-in">
            <circle cx="28" cy="28" r="25" stroke="var(--cyan-bright)" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "aimodels-check-draw var(--d-5) var(--ease-emphasis) 100ms forwards" }} />
            <path d="M17 28l7 7 15-15" stroke="var(--cyan-bright)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "aimodels-check-draw var(--d-3) var(--ease-entrance) var(--d-5) forwards" }} />
          </svg>
        ) : (
          <AIProviderIcon provider={provider} size={44} className="aimodels-fade-in" />
        )}
      </div>

      {/* Provider name */}
      <div className="text-center aimodels-fade-in" style={{ animationDelay: "var(--stagger)" }}>
        <h2 className="text-[length:var(--t-6)] leading-[1.15] font-bold text-[var(--text-primary)] mb-2">
          {completed ? t("connected") : t("ai.settingUp", { provider: providerName })}
        </h2>
        <p className="text-[length:var(--t-4)] leading-[1.6] text-[var(--text-secondary)]">
          {completed
            ? detail || t("ai.configured")
            : detail || `${t("ai.configuringAssistant")}${dots}`}
        </p>
      </div>

      {/* Progress steps */}
      <ul className="w-full max-w-[280px] space-y-2 list-none">
        {steps.map((step, i) => {
          const stepDone = completed || i < phase;
          const stepNow = !completed && i === phase;
          const reached = completed || i <= phase;
          return (
            <li
              key={i}
              // Which row a customer is actually looking at, stated rather than
              // inferred from a Tailwind class. Every label is in the DOM at all
              // times — an unreached row is rendered at opacity 0 — so "is the
              // last row showing yet" is a question only this attribute can
              // answer (TASK-483).
              data-step-state={stepDone ? "done" : stepNow ? "active" : "pending"}
              className={`flex items-center gap-2 text-[length:var(--t-2)] ${
                reached ? "opacity-100" : "opacity-0 translate-y-1"
              }`}
              style={{
                transition: "opacity var(--d-2) var(--ease-standard), transform var(--d-2) var(--ease-standard)",
                transitionDelay: `calc(${Math.min(i, 3)} * var(--stagger))`,
              }}
            >
              {stepDone ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--cyan-wash)] text-[var(--cyan-bright)] shrink-0">
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>check</span>
                </span>
              ) : stepNow ? (
                <span className="flex items-center justify-center w-5 h-5 shrink-0">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
                </span>
              ) : (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--fill-1)] shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--fill-4)]" />
                </span>
              )}
              <span className={stepDone ? "text-[var(--cyan-bright)]" : stepNow ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                {step}
              </span>
            </li>
          );
        })}
      </ul>

      {progressPercent !== null && !completed && (
        <div className="w-full max-w-[280px]">
          <div className="flex items-center justify-between gap-2 text-[length:var(--t-1)] text-[var(--text-muted)] mb-2">
            <span className="truncate">{providerName}</span>
            <span className="tabular-nums shrink-0">{progressPercent}%</span>
          </div>
          {/* Linear, because --ease-truth is the only honest curve for a
              bar that reports someone else's progress: an easing curve
              would invent a velocity the box never reported. */}
          <div className="w-full h-1 bg-[var(--fill-2)] rounded-[var(--r-full)] overflow-hidden">
            <div
              className="h-full bg-[var(--coral-bright)] rounded-[var(--r-full)]"
              style={{ width: `${progressPercent}%`, transition: "width var(--d-3) var(--ease-truth)" }}
            />
          </div>
        </div>
      )}

      {/* Local providers (llama.cpp / Ollama) compile and download multi-GB
         models — can take 10-15 min on Jetson. Cloud providers finish in
         seconds, so they get the shorter generic copy. */}
      {!completed && phase >= 1 && (
        <p className="text-[length:var(--t-2)] leading-[1.5] text-[var(--text-muted)] text-center aimodels-fade-in">
          {provider === "llamacpp" || provider === "ollama"
            ? t("ai.pleaseDontCloseLocal")
            : t("ai.pleaseDontClose")}
        </p>
      )}
    </div>
  );
}

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
        // Redirect-based OAuth (auth-code). Gated by availableOAuth, which
        // already includes "anthropic" (OAUTH_PROVIDERS.anthropic), so this
        // surfaces the Claude Pro/Max subscription sign-in in the wizard.
        mode: "subscription",
        label: "Subscription",
        placeholder: "",
        hint: "Connect your Claude Pro/Max subscription via OAuth.",
      },
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

// One recipe for the filled action, written once. The press is a 2% scale on
// :active — the pointer is already on the control, so the feedback belongs
// under the finger rather than on hover, where a 5% grow moved the label out
// from under a thumb that had not lifted yet. Disabled reads as "not yet"
// (a quiet fill) rather than as a faded version of the live button.
const PRIMARY_ACTION_CLASS =
  "w-full min-h-[48px] px-6 btn-gradient text-white rounded-[var(--r-1)] font-semibold text-[length:var(--t-5)] cursor-pointer flex items-center justify-center gap-2 " +
  "transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] active:scale-[0.98] " +
  "disabled:bg-none disabled:bg-[var(--fill-2)] disabled:text-[var(--text-muted)] disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100";

// The quiet inline link/toggle used for "get a new code", "restart sign-in"
// and the model-picker escape hatch.
const QUIET_LINK_CLASS =
  "bg-transparent border-none p-0 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] hover:text-orange-300 cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]";


export default function AIModelsStep({
  onNext,
  embedded = false,
  onConfigured,
  providerIds,
  defaultProviderId,
  currentProviderId = null,
  currentModel = null,
  localAiIsActive,
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
  // Device edition — on a Hermes edition this step doesn't apply (Hermes manages
  // its own providers/models), so we show a short Hermes panel instead.
  // Seeded from the process-wide cache so re-opening Settings (or moving
  // between its sections) skips the skeleton entirely — the edition cannot
  // change under a live page. The lazy initialiser reads null on the very first
  // mount, which is what the server rendered, so hydration still matches.
  const [edition, setEdition] = useState<string | null>(() => cachedEdition());
  useEffect(() => {
    if (edition !== null) return;
    // /harness/active, not /harness/status: both carry `edition`, but status
    // also runs per-harness liveness probes (~500 ms of retry sleep here).
    // Whatever happens, `edition` always leaves null — so the loader below can
    // never become a permanent state.
    let alive = true;
    void fetchHarness().then((d) => {
      if (alive) setEdition(d?.edition || "openclaw");
    });
    return () => { alive = false; };
    // Runs once: `edition` is only read to skip a redundant fetch, and it never
    // returns to null.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // OpenAI routes through the `codex` namespace (ChatGPT backend),
  // whose catalog is completely different from the token-mode `openai`
  // API catalog — `gpt-5.4` only exists via codex, `gpt-5` only via the
  // public API. Matching the catalog to the actual namespace prevents
  // the picker from offering IDs that the upstream will reject.
  // Resolve which catalog namespace the picker should pull from. Differs
  // from `selectedProvider` for OpenAI in subscription/OAuth mode, where
  // the routeable namespace is `codex` (ChatGPT backend) rather
  // than `openai` (api.openai.com). Same swap the configure route applies.
  const catalogProvider = useMemo<string | null>(() => {
    if (selectedProvider === "openai" && authMode === "subscription") {
      return "codex";
    }
    return isCatalogProvider(selectedProvider) ? selectedProvider : null;
  }, [selectedProvider, authMode]);

  const activeCatalog = useProviderCatalog(catalogProvider);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [customModelId, setCustomModelId] = useState<string>("");
  const [useCustomModel, setUseCustomModel] = useState<boolean>(false);
  const [modelTouched, setModelTouched] = useState(false);
  // Presentation only: the catalog default is right for almost everyone and
  // the helper below already says the model can be changed from the chat
  // window later, so the picker opens as a one-line summary instead of a
  // label + 48px select + toggle + two lines of help. It is forced open
  // whenever a custom model id is in play, so a model the customer typed is
  // never hidden behind a chevron. No state the save path reads is gated on
  // this — `selectedModelId` / `customModelId` live above it either way.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

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
    // (codex vs openai).
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
  // Seeded from local storage because that is all this panel can know before it
  // has asked the box anything; the effect below reconciles it against the
  // portal-confirmed account as soon as an answer arrives. Local storage alone
  // is NOT the answer for a paired box — see TASK-468.
  const [clawaiTier, setClawaiTier] = useState<ClawaiTier>(() => readStoredUiTier());
  // The day's image allowance, as the portal reported it. Null until an answer
  // arrives, and null again if the answer was not usable — never a placeholder.
  // Whatever this is, it is what the panel renders; there is no fallback and
  // there must not be one, because a default here is a guess at somebody's
  // paid subscription. (TASK-469.)
  const [imageAllowance, setImageAllowance] =
    useState<ClawboxAiImageAllowance | null>(null);
  // Set the moment the user touches the plan picker. The reconcile below must
  // never yank the card out from under a pick that already happened — on the
  // wizard this picker is someone CHOOSING a plan they do not have yet.
  const userPickedTierRef = useRef(false);
  const persistClawaiTier = useCallback((tier: ClawaiTier) => {
    userPickedTierRef.current = true;
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

  const stopPolling = useCallback(() => {
    setDevicePolling(false);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    pollControllerRef.current?.abort();
  }, []);

  // The ClawBox AI device-auth state machine (start → poll → configuring →
  // complete) lives in a shared hook so the Hermes provider panel runs the SAME
  // flow. Its terminal callbacks are declared further down, so they're reached
  // through a ref rather than a forward reference; the hook's own start/stop/
  // reset identities are stable.
  const clawaiFinishRef = useRef<{
    complete: () => void;
    error: (message: string) => void;
    configuring: () => void;
  }>({ complete: () => {}, error: () => {}, configuring: () => {} });

  const clawaiLogin = useClawaiDeviceLogin({
    scope: configureScope,
    getTier: () => clawaiTier,
    onStart: () => setStatus(null),
    onBusyChange: setSaving,
    onConfiguring: () => clawaiFinishRef.current.configuring(),
    onComplete: () => clawaiFinishRef.current.complete(),
    onError: (message) => clawaiFinishRef.current.error(message),
  });
  // Stable identities (see the hook) — pulled out so effects/callbacks can
  // depend on them directly instead of on the whole result object.
  const { start: startClawaiLogin, stop: stopClawaiLogin, reset: resetClawaiLogin } = clawaiLogin;

  useEffect(() => {
    if (normalizedCurrentProvider !== "clawai") return;
    stopClawaiLogin();
    resetClawaiLogin();
    setSaving(false);
    setStatus((current) => (current?.type === "error" ? null : current));
  }, [normalizedCurrentProvider, stopClawaiLogin, resetClawaiLogin]);

  // ── Make the plan card agree with the account ─────────────────────────────
  //
  // This panel used to seed the plan purely from local storage and never ask
  // the box anything, so on a browser that had never stored a tier — every
  // customer's first visit, and every visit after clearing site data — it fell
  // back to the hardcoded "flash" and rendered "Pro plan · €9/month". On a Max
  // box that sat directly under a MAX badge in the same panel, contradicting
  // it, and the same state is what `payload.clawaiTier` writes on save, so a
  // save from that screen downgraded a €49 account off the frontier weights
  // without saying so. (TASK-468.)
  //
  // `resolveUiTier` is the rule the Hermes panel has always used; it now lives
  // in the shared tier module so these two panels cannot drift again. It reads
  // the account only when the box is actually paired, so the wizard's
  // choose-a-plan flow on an unpaired box is untouched.
  //
  // Not once per mount but on a slow poll (TASK-516): the desktop keeps the
  // Settings window mounted while it is "closed", so a mount-only read froze
  // the allowance at whatever the page load saw. The one moment the line is
  // needed — right after the chat refused a picture at the cap — it showed the
  // morning's number and contradicted the assistant on the same screen. The
  // interval matches how the Voice and Local Models panels stay honest, and it
  // pauses while the tab is hidden so a background desktop does not poll the
  // portal all day; coming back to the tab refreshes immediately.
  useEffect(() => {
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      fetch("/setup-api/ai-models/status", { cache: "no-store", signal: own.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data || typeof data !== "object") return;
          // Only a live portal answer may move the card. `tierSource: "picker"`
          // means the status route never reached the portal this cycle, and the
          // stored device tier cannot tell Free from "we never asked" — guessing
          // from it is how a Free user got shown a paid plan in the first place.
          if (data.clawaiConfigured !== true || data.tierSource !== "portal") return;
          // The allowance rides on the same live-portal gate as the tier badge,
          // and for the same reason: `tierSource: "picker"` means nobody asked
          // the portal this cycle, so any number attached to it is a leftover.
          // Set unconditionally, including to null — an allowance that stays on
          // screen after the portal stopped confirming it is a stale cap, and a
          // stale cap is indistinguishable from a wrong one.
          setImageAllowance(readImageAllowance(data.clawaiImages));
          // The tier guard sits at resolution time, not at fetch time: a pick
          // made while this request was in flight must win over its answer —
          // and the allowance above is real either way.
          if (userPickedTierRef.current) return;
          setClawaiTier(resolveUiTier(true, data.clawaiAccountTier ?? null));
        })
        .catch(() => {
          // Offline or mid-restart: keep the stored intent rather than blanking
          // or guessing at someone's subscription.
        });
    };
    // The mount read gets the same visibility gate as the ticks: a panel
    // mounting in a background tab waits for `visibilitychange` like any
    // other hidden refresh would.
    if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
    }, ALLOWANCE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
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
    resetClawaiLogin();
    // Dispatch the gateway-restart signal as soon as we know the configure
    // round-trip succeeded — well before the success overlay's 900 ms exit
    // timer expires. The chat popup listens for this event to extend its
    // reconnect budget, so emitting it early keeps the chat from giving up
    // with "Could not connect to gateway" while the restart is still in
    // flight after a fresh ClawBox AI handoff.
    if (configureScope === "primary" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("clawbox:primary-ai-configured"));
    }
    // "The providers changed." Emitted HERE rather than from each host, because
    // this is the one point every OpenClaw configure success passes through —
    // pasted key, provider OAuth, and the ClawBox AI device login alike — and
    // both the wizard and the embedded Settings panel reach it. A host-side
    // emit would have to be repeated per host and would miss whichever one was
    // added next.
    notifyProvidersChanged();
    completeConfiguring();
  }, [completeConfiguring, configureScope, resetClawaiLogin]);

  // Wire the device-login hook's terminal callbacks now that the overlay
  // helpers exist. Going through the ref (rather than passing them to the hook
  // directly) keeps the hook above them in source order without a forward
  // reference, and keeps its start/stop/reset identities stable. The device
  // flow is only ever entered from a click, i.e. long after the first commit,
  // so updating the ref in an effect is soon enough.
  useEffect(() => {
    clawaiFinishRef.current = {
      complete: showSuccessAndContinue,
      error: showError,
      configuring: () => showConfiguring("generic"),
    };
  }, [showConfiguring, showError, showSuccessAndContinue]);

  // Route errors are English sentences written for whoever is reading them —
  // fine for the ones nobody can act on, wrong for the ones we know how to say
  // in the customer's language. A route that returns a `code` gets translated;
  // everything else falls through to the text it sent, as before.
  const TRANSLATED_ERROR_CODES: Record<string, string> = useMemo(
    () => ({ local_ai_runtime_unavailable: "ai.localRuntimeUnavailable" }),
    [],
  );

  const extractError = useCallback(async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    const key = typeof data.code === "string" ? TRANSLATED_ERROR_CODES[data.code] : undefined;
    if (key) return t(key);
    return typeof data.error === "string" ? data.error : fallback;
  }, [TRANSLATED_ERROR_CODES, t]);

  // Ollama hook
  const ollamaCallbacks = useMemo<OllamaCallbacks>(() => ({
    onSaveSuccess: () => showSuccessAndContinue(),
    onSaveError: (message: string) => showError(message),
    onPullError: (message: string) => showError(message),
    onDeleteError: (message: string) => showError(message),
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

    // Every row except the last one is timed. The last row belongs to
    // `completeConfiguring`, so "Almost ready" appears when the request has
    // actually come back and never before it.
    const lastTimedIndex = CONFIGURING_STEP_DELAYS.length - 2;
    const timers = CONFIGURING_STEP_DELAYS.map((delay, index) =>
      index === 0 || index > lastTimedIndex
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
    // The list was expanded to make this choice; the choice is made, so it
    // closes on the chosen row rather than leaving the catalogue open above
    // the controls the customer now has to reach.
    setShowMoreProviders(false);
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

  const lastHandledOfferRef = useRef(0);
  useEffect(() => {
    if (!openClawAIOfferRequest || openClawAIOfferRequest === lastHandledOfferRef.current) return;
    if (!allowedProviders.some((provider) => provider.id === "clawai")) return;
    lastHandledOfferRef.current = openClawAIOfferRequest;
    selectProvider("clawai");
    void startClawaiLogin();
  }, [allowedProviders, startClawaiLogin, openClawAIOfferRequest, selectProvider]);

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
    tokenData: { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number; projectId?: string; oauthHandoff?: boolean }
  ) => {
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    showConfiguring();

    try {
      // For subscription flows (ChatGPT/Codex OAuth), include the
      // user's model pick so the backend writes codex/<chosen>
      // instead of the PROVIDERS subscriptionOverride default. Without
      // this, picking a model in the wizard would silently be ignored
      // for OAuth providers.
      const subscriptionModel = getRequestedCatalogModelId(true);
      // Device-auth (server-side handoff): the provider tokens were persisted
      // to a server-only file by device-poll, so we send no token fields —
      // just the handoff flag telling configure to read them there. The
      // redirect/exchange path (Anthropic) still posts the real tokens.
      const configureBody = tokenData.oauthHandoff
        ? {
            scope: configureScope,
            provider: selectedProvider,
            authMode: "subscription",
            oauthHandoff: true,
            // projectId is not a secret (a GCP identifier) — relay it in the
            // body for the Google handoff since the server-only token file
            // doesn't carry it.
            ...(tokenData.projectId ? { projectId: tokenData.projectId } : {}),
            ...(subscriptionModel ? { model: subscriptionModel } : {}),
          }
        : {
            scope: configureScope,
            provider: selectedProvider,
            apiKey: tokenData.access_token,
            authMode: "subscription",
            idToken: tokenData.id_token,
            refreshToken: tokenData.refresh_token,
            expiresIn: tokenData.expires_in,
            ...(tokenData.projectId ? { projectId: tokenData.projectId } : {}),
            ...(subscriptionModel ? { model: subscriptionModel } : {}),
          };
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configureBody),
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

      if (data.status === "complete") {
        stopPolling();
        setDeviceSaving(true);
        // Tokens never touch the browser: device-poll persisted them to a
        // server-only file. Signal the configure route to read them there.
        await saveOAuthToken({ oauthHandoff: true });
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
      // Exchange now persists the tokens server-side and returns only a status
      // (keeping access/refresh/id tokens off the plain-HTTP setup-AP hop), so
      // complete the config through the same server-side handoff the
      // device-code flow uses. projectId (non-secret) is relayed for Google.
      if (tokenData.status !== "complete") {
        return showError(tokenData.error || "Sign-in did not complete");
      }
      await saveOAuthToken({ oauthHandoff: true, projectId: tokenData.projectId });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setExchanging(false);
    }
  };

  // ClawBox AI's description lives in the shared row (CLAWBOX_AI_DESCRIPTION).
  const providerDesc: Record<string, string> = {
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
    const modelPickerExpanded = modelPickerOpen || useCustomModel;
    const currentModelLabel =
      activeCatalog.models.find((option) => option.id === selectedModelId)?.label
      || selectedModelId
      || activeCatalog.defaultModelId;
    if (!modelPickerExpanded) {
      return (
        <button
          type="button"
          onClick={() => setModelPickerOpen(true)}
          aria-expanded={false}
          className="mt-4 flex w-full min-h-[44px] items-center justify-between gap-3 px-4 py-2 bg-[var(--fill-1)] border border-[var(--hair-2)] rounded-[var(--r-1)] text-left cursor-pointer hover:bg-[var(--fill-2)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
        >
          <span className="flex min-w-0 flex-col">
            <span className="text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)]">
              Model
            </span>
            <span className="truncate text-[length:var(--t-4)] text-[var(--text-primary)]">
              {currentModelLabel}
            </span>
          </span>
          <span className="shrink-0 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)]">
            Change
          </span>
        </button>
      );
    }
    return (
      <div className="mt-4">
        <label
          htmlFor="ai-provider-model"
          className="block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-2"
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
            className="w-full min-h-[48px] px-4 py-3 bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[length:var(--t-4)] text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
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
            className="w-full min-h-[48px] px-4 py-3 bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[length:var(--t-4)] text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] placeholder:text-[var(--text-muted)]"
          />
        )}
        {activeCatalog.allowCustom && (
          <button
            type="button"
            onClick={() => {
              setModelTouched(true);
              setUseCustomModel((value) => !value);
            }}
            className="mt-2 bg-transparent p-0 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] hover:text-orange-300 cursor-pointer border-none"
          >
            {useCustomModel
              ? "Pick from curated list"
              : "Enter a custom model ID…"}
          </button>
        )}
        <p className="mt-2 text-[length:var(--t-2)] leading-[1.5] text-[var(--text-muted)]">
          {selected.id === "openrouter"
            ? "OpenRouter exposes 340+ models. You can switch models later from the chat window."
            : "You can switch between the curated models from the chat window anytime."}
        </p>
      </div>
    );
  };

  const renderDeviceAuth = () => (
    <div>
      <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mb-4 leading-[1.6]">
        {currentDevice.description}
      </p>

      {!deviceCode ? (
        <button
          type="button"
          onClick={startDeviceAuth}
          className={PRIMARY_ACTION_CLASS}
        >
          {embedded ? currentDevice.button : selectedConnectLabel}
        </button>
      ) : (
        <div>
          <div className="mb-4 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] text-center">
            <button
              type="button"
              onClick={() => {
                const win = window.open(deviceUrl!, "_blank");
                if (win) {
                  oauthWindowRef.current = win;
                }
              }}
              className="w-full min-h-[48px] px-4 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-semibold rounded-[var(--r-1)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] text-[length:var(--t-4)] cursor-pointer"
            >
              {t("ai.openAuthPage")}
            </button>
            <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mt-4 mb-2">{t("ai.thenEnterCode")}</p>
            <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-[var(--r-1)] inline-flex items-center gap-2">
              <span className="text-[length:var(--t-6)] font-mono font-bold text-[var(--text-primary)] tracking-[0.16em] select-all">
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
                className="ml-1 px-2 py-1 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] hover:bg-[var(--bg-surface)] cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
              >
                {t("copy")}
              </button>
            </div>
            <p className="mt-2 text-[length:var(--t-2)] text-[var(--text-muted)]">
              {t("ai.codeExpires")}
            </p>
          </div>

          {(devicePolling || deviceSaving) && (
            <div className="flex items-center gap-2 text-[length:var(--t-2)] text-[var(--text-secondary)]">
              <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
              {deviceSaving ? t("ai.authorizedConnecting") : t("ai.waitingAuth")}
            </div>
          )}

          <button
            type="button"
            onClick={startDeviceAuth}
            className={`mt-2 ${QUIET_LINK_CLASS}`}
          >
            {t("ai.getNewCode")}
          </button>
        </div>
      )}
    </div>
  );

  const renderRedirectOAuth = () => (
    <div>
      <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mb-4 leading-[1.6]">
        {currentOAuth.description}
      </p>

      {!oauthStarted ? (
        <button
          type="button"
          onClick={startOAuth}
          className={PRIMARY_ACTION_CLASS}
        >
          {embedded ? currentOAuth.button : selectedConnectLabel}
        </button>
      ) : (
        <div>
          {/* A numbered list, not three lines separated by <br>: the steps
              are an ordered list, so a screen reader should be told how
              many there are and which one it is on. */}
          <ol className="mb-4 p-3 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] list-none space-y-1">
            {currentOAuth.steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-[length:var(--t-2)] leading-[1.5] text-[var(--text-primary)]">
                <span aria-hidden="true" className="shrink-0 font-semibold text-[var(--coral-bright)] tabular-nums">
                  {i + 1}.
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>

          <label
            htmlFor="oauth-auth-code"
            className="block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-2"
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
            className="w-full min-h-[48px] px-4 py-3 bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[length:var(--t-4)] text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] placeholder:text-[var(--text-muted)]"
          />

          <button
            type="button"
            onClick={startOAuth}
            className={`mt-2 ${QUIET_LINK_CLASS}`}
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
  // The list opens on the provider that is actually in play and keeps the rest
  // one tap behind the same toggle that used to reveal only the secondary
  // ones. Four rows plus that toggle is ~350px of catalogue standing on top of
  // a card whose whole job is one button, and the customer taking the default
  // — ClawBox AI, already selected — was being asked to scroll past the
  // alternatives to reach it. Nothing is removed: the toggle is always there
  // while anything is hidden, and choosing from the expanded list closes it
  // again (see selectProvider) so browsing the options never leaves the action
  // stranded below the fold.
  //
  // The `selectedInList` guard matters for the frame between a provider set
  // changing and the effect that re-points `selectedProvider` at it: filtering
  // on a selection that isn't there yet would render an empty list.
  const selectedInList = baseProviders.some((provider) => provider.id === selectedProvider);
  const providerListCollapsed = !showMoreProviders && selectedInList && baseProviders.length > 1;
  const displayedProviders = providerListCollapsed
    ? baseProviders.filter((provider) => provider.id === selectedProvider)
    : baseProviders;
  const shouldShowMoreProviders = providerListCollapsed;
  const resolvedTitle = title ?? t("ai.title");
  const resolvedDescription = description ?? t("ai.description");
  const embeddedConnectLabel = t("settings.connect");

  // Edition resolves asynchronously (see the /harness/active effect above).
  // Until it lands, render a NEUTRAL skeleton rather than the OpenClaw
  // radiogroup: on a Hermes device the OpenClaw provider list would otherwise
  // paint for the length of the round-trip and then be swapped for the Hermes
  // panel — a visible flash of the wrong product. The skeleton reuses the exact
  // wrapper + card shell BOTH branches render (same width, padding, radius and
  // position), so only the card's inner content changes when the edition
  // arrives — no layout jump. `data-testid` is kept so anything waiting on the
  // step doesn't race the fetch.
  //
  // The row count is taken from `displayedProviders`, which is known
  // SYNCHRONOUSLY here: a hardcoded five rows was one too many for the wizard
  // (4 primary providers) and four too many for Settings → Local AI (a single
  // llamacpp row), so the card visibly collapsed the moment the edition landed.
  // The contextual area below the list reserves the same min-height both
  // branches use for their selected-provider controls.
  if (edition === null) {
    return (
      <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
        <div className="card-surface rounded-[var(--r-3)] p-5 sm:p-8" role="status" aria-busy="true">
          <span className="sr-only">{t("ai.loadingPanel")}</span>
          <div aria-hidden="true" className="animate-pulse">
            <div className="h-8 w-2/3 rounded-[var(--r-1)] bg-[var(--fill-3)] mb-2" />
            <div className="h-4 w-full rounded-[var(--r-1)] bg-[var(--fill-2)] mb-2" />
            <div className="h-4 w-4/5 rounded-[var(--r-1)] bg-[var(--fill-2)] mb-6" />
            <div className="border border-[var(--border-subtle)] rounded-[var(--r-1)] bg-[var(--bg-deep)]/50 overflow-hidden">
              {Array.from({ length: Math.max(1, displayedProviders.length) }, (_, row) => (
                <div key={row} className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--hair)] last:border-b-0">
                  <span className="w-5 h-5 rounded-full bg-[var(--fill-3)] shrink-0" />
                  <span className="w-8 h-8 rounded-[var(--r-1)] bg-[var(--fill-3)] shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block h-3.5 w-1/3 rounded-[var(--r-1)] bg-[var(--fill-3)] mb-2" />
                    <span className="block h-3 w-2/3 rounded-[var(--r-1)] bg-[var(--fill-2)]" />
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-5 min-h-[240px]">
              <div className="h-12 w-full rounded-[var(--r-1)] bg-[var(--fill-2)]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Hermes edition: providers/models are managed by Hermes, not the OpenClaw
  // provider config this step drives — render Hermes' own model/provider/key
  // config instead.
  //
  // EXCEPT when this step is scoped to the local model (Settings → Local AI).
  // llama.cpp and Ollama run on the device and are configured through the
  // local-ai routes, which are the same on both harnesses — so the Hermes panel
  // has nothing to do with them. Handing it the local section replaced a single
  // "Gemma 4" row with the whole cloud provider list (Anthropic, OpenAI,
  // DeepSeek, ClawBox AI…), which is not what "Local AI" means.
  if (edition === "hermes" && configureScope !== "local") {
    return <HermesProviderConfig
      embedded={embedded}
      onNext={onNext}
      testId={testId}
      requestedProviderId={requestedProviderId}
      providerSelectionRequest={providerSelectionRequest}
    />;
  }

  return (
    <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
      <div className="card-surface rounded-[var(--r-3)] p-5 sm:p-8 relative overflow-hidden">
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
        <h1 className="text-[length:var(--t-6)] leading-[1.15] font-bold font-display mb-2">
          {resolvedTitle}
        </h1>
        <p className="text-[length:var(--t-4)] leading-[1.6] text-[var(--text-secondary)] mb-6">
          {resolvedDescription}
        </p>

        <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-[var(--r-1)] bg-[var(--bg-deep)]/50 overflow-hidden">
          {displayedProviders.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            // ClawBox AI's row is shared verbatim with the Hermes provider panel
            // (same component, not a lookalike) so the two can never drift.
            if (provider.id === "clawai") {
              return (
                <ClawboxAiProviderRow
                  key={provider.id}
                  radioName="ai-provider"
                  selected={isSelected}
                  onSelect={() => selectProvider(provider.id)}
                />
              );
            }
            return (
              <label
                key={provider.id}
                className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-[var(--hair)] last:border-b-0 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] has-[:focus-visible]:ring-inset ${
                  isSelected
                    ? "bg-[var(--coral-wash)]"
                    : "hover:bg-[var(--fill-3)]"
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
                  className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${
                    isSelected
                      ? "border-[var(--coral-bright)]"
                      : "border-[var(--border-subtle)]"
                  }`}
                >
                  {isSelected && (
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--coral-bright)]" />
                  )}
                </span>
                <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-[var(--r-1)] bg-[var(--fill-2)] shrink-0">
                  <AIProviderIcon provider={provider.id} size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-[length:var(--t-4)] font-semibold text-[var(--text-primary)]">
                    {provider.name}
                    {provider.id === "llamacpp" && (
                      /* Cyan is DONE-and-verified everywhere else in the box;
                         "runs entirely on this device" is the one other fact
                         it is allowed to carry, and it is the fact this row
                         exists to state. */
                      <span className="px-1.5 py-0.5 text-[length:var(--t-1)] font-bold uppercase tracking-[0.06em] rounded-[var(--r-1)] bg-[var(--cyan-wash)] text-[var(--cyan-bright)] leading-none">
                        {t("ai.fullyLocal")}
                      </span>
                    )}
                  </span>
                  <span className="block text-[length:var(--t-2)] leading-[1.45] text-[var(--text-muted)]">
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
              aria-expanded={false}
              // No border-top of its own: the row above it is no longer the
              // list's last child, so that row's bottom hairline is already
              // the divider. Two would draw a 2px seam.
              className="flex w-full min-h-[48px] items-center gap-2 px-4 py-3 text-[length:var(--t-4)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer hover:bg-[var(--fill-3)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] text-left"
            >
              <span className="material-symbols-rounded shrink-0" aria-hidden="true" style={{ fontSize: 18 }}>expand_more</span>
              {t("ai.showMore")}
            </button>
          )}
        </div>

        {selected?.id === "ollama" && (
          <div className="mt-3 space-y-4">
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
          <div className="mt-3 space-y-4">
            <LlamaCppModelPanel
              llamaCppRunning={llamaCppRunning}
              llamaCppInstalled={llamaCppInstalled}
              llamaCppIsActive={localAiIsActive ?? normalizedCurrentProvider === "llamacpp"}
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
          <div className="mt-3">
            {effectiveAuthOptions.length > 1 && (
              <div className="flex gap-1 mb-4 p-1 bg-[var(--bg-deep)] rounded-[var(--r-1)]">
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
                    className={`flex-1 min-h-[40px] px-2 rounded-[var(--r-1)] text-[length:var(--t-4)] font-semibold transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] cursor-pointer border-none ${
                      authMode === opt.mode
                        ? "bg-[var(--fill-3)] text-[var(--text-primary)]"
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
                    className="inline-flex items-center gap-1.5 mb-3 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] hover:text-orange-300 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
                  >
                    {activeAuth.tokenUrlLabel === "Get API Key" ? t("ai.getApiKey") : t("ai.getToken")}
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>open_in_new</span>
                  </a>
                )}

                <label
                  htmlFor="ai-api-key"
                  className="block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-2"
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
                    className="w-full min-h-[48px] px-4 py-3 pr-12 bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[length:var(--t-4)] text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 rounded-[var(--r-1)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)] bg-transparent border-none cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>{showKey ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
                <p className="mt-2 text-[length:var(--t-2)] leading-[1.5] text-[var(--text-muted)]">{activeAuth.hint}</p>
              </div>
            )}
            {renderProviderModelPicker()}
          </div>
        )}

        {/* Stays an inset well rather than the coral accent panel the rest of
            this system gives a first-party surface: the plan card inside it
            is shared with the Hermes panel and already paints itself in
            coral-wash on a coral edge, so a coral ground here would erase
            it. Radius joins the ladder (12 → 8); the surface does not move
            until the shared card can move with it. */}
        {selected?.id === "clawai" && (
          <div className="mt-3 rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-4">
            <ClawboxAiPlanPicker tier={clawaiTier} onTierChange={persistClawaiTier} />
            {/* Directly under the plan, because that is where somebody already
                goes to find out what their plan is (TASK-469's decided
                placement). Not on the chat surface: a counter beside every
                message makes an assistant feel metered in a way that devalues
                it — the number should be met when you go looking, or when it
                starts to matter. */}
            <ClawboxAiImageAllowanceLine allowance={imageAllowance} />

            {/* Subscription / API Key tabs — same shape as the OpenAI
                provider, so users get one mental model for "device-flow
                vs paste a key". */}
            {effectiveAuthOptions.length > 1 && (
              <div className="mt-4 flex gap-1 p-1 bg-[var(--bg-deep)] rounded-[var(--r-1)]">
                {effectiveAuthOptions.map((opt) => (
                  <button
                    type="button"
                    key={opt.mode}
                    onClick={() => {
                      stopClawaiLogin();
                      resetClawaiLogin();
                      setAuthMode(opt.mode);
                      setApiKey("");
                      setShowKey(false);
                      setStatus(null);
                    }}
                    className={`flex-1 min-h-[40px] px-2 rounded-[var(--r-1)] text-[length:var(--t-4)] font-semibold transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] cursor-pointer border-none ${
                      authMode === opt.mode
                        ? "bg-[var(--fill-3)] text-[var(--text-primary)]"
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
              <ClawboxAiDeviceLogin
                deviceCode={clawaiLogin.deviceCode}
                verificationUrl={clawaiLogin.verificationUrl}
                polling={clawaiLogin.polling}
                busy={saving}
                onStart={() => { void startClawaiLogin(); }}
              />
            )}

            {/* API Key tab — direct token paste, same UX as other providers.
                Power-user fallback: under auto-tier the device-code flow
                works for everyone, but pasting a manually-generated token
                stays available for users who already have one. */}
            {currentAuthMode === "token" && (
              <div className="mt-4">
                <label htmlFor="clawai-portal-token" className="block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-2">
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
                    className="w-full min-h-[48px] px-4 py-3 pr-12 text-[length:var(--t-4)] bg-[var(--fill-2)] border border-[var(--hair-2)] rounded-[var(--r-2)] text-[var(--text-primary)] outline-none transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] focus:border-[var(--coral-bright)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide token" : "Show token"}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 rounded-[var(--r-1)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)] bg-transparent border-none cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>
                      {showKey ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                <p className="mt-2 text-[length:var(--t-2)] leading-[1.5] text-[var(--text-muted)]">
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
                className={PRIMARY_ACTION_CLASS}
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
                  className={PRIMARY_ACTION_CLASS}
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
              className={PRIMARY_ACTION_CLASS}
            >
              {saving && ButtonSpinner}
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
              className="min-h-[40px] px-3 rounded-[var(--r-1)] text-[length:var(--t-2)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-2)] bg-transparent border-none cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] disabled:cursor-not-allowed"
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
