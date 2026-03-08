"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import StatusMessage from "./StatusMessage";
import { parseAuthInput, tryCloseOAuthWindow } from "@/lib/oauth-utils";

interface AIModelsStepProps {
  onNext: () => void;
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

const ButtonSpinner = (
  <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic Claude",
    description: "Claude models by Anthropic",
    authOptions: [
      {
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
    id: "openai",
    name: "OpenAI GPT",
    description: "GPT models by OpenAI",
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
    id: "google",
    name: "Google Gemini",
    description: "Gemini models by Google",
    authOptions: [
      {
        mode: "subscription",
        label: "Subscription",
        placeholder: "",
        hint: "Connect your Google One AI Premium subscription via OAuth.",
      },
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
  {
    id: "ollama",
    name: "Ollama Local",
    description: "Run AI models locally on device",
    authOptions: [
      {
        mode: "local" as AuthMode,
        label: "Local",
        placeholder: "",
        hint: "No API key needed. Models run on this device.",
      },
    ],
  },
];

// Providers that use device code flow instead of redirect-based OAuth
const DEVICE_AUTH_PROVIDERS = new Set(["openai"]);

const DEVICE_AUTH_LABELS: Record<string, {
  description: string;
  button: string;
  success: string;
}> = {
  openai: {
    description: "Connect your ChatGPT Plus or Pro subscription. You\u2019ll get a code to enter on OpenAI\u2019s website.",
    button: "Connect to GPT",
    success: "GPT subscription connected! Continuing...",
  },
};

export default function AIModelsStep({ onNext }: AIModelsStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>("anthropic");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [availableOAuth, setAvailableOAuth] = useState<string[] | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Ollama state
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size: number }[]>([]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState("llama3.2:3b");
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaPullProgress, setOllamaPullProgress] = useState<{ status: string; completed?: number; total?: number } | null>(null);
  const [ollamaSaving, setOllamaSaving] = useState(false);

  // OAuth redirect flow state (Anthropic)
  const [oauthStarted, setOauthStarted] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [exchanging, setExchanging] = useState(false);

  // Device auth flow state (OpenAI)
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    fetch("/setup-api/ai-models/oauth/providers")
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data.providers)) setAvailableOAuth(data.providers); })
      .catch((err) => {
        console.error("[AIModelsStep] Failed to fetch OAuth providers:", err);
        setAvailableOAuth([]);
      });
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (pollRef.current) clearTimeout(pollRef.current);
      saveControllerRef.current?.abort();
      exchangeControllerRef.current?.abort();
      oauthStartControllerRef.current?.abort();
      pollControllerRef.current?.abort();
    };
  }, []);

  const showError = (message: string) => setStatus({ type: "error", message });

  const showSuccessAndContinue = (message: string) => {
    const { tabClosed, closeHint } = tryCloseOAuthWindow(oauthWindowRef);
    setStatus({ type: "success", message: message + closeHint });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => onNext(), tabClosed ? 1500 : 3000);
  };

  const extractError = async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    return typeof data.error === "string" ? data.error : fallback;
  };

  const selectProvider = (id: string) => {
    stopPolling();
    const provider = PROVIDERS.find((p) => p.id === id);
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
    if (id === "ollama") checkOllamaStatus();
  };

  const checkOllamaStatus = async () => {
    try {
      const res = await fetch("/setup-api/ollama/status");
      const data = await res.json();
      setOllamaRunning(data.running);
      setOllamaModels(data.models || []);
    } catch {
      setOllamaRunning(false);
      setOllamaModels([]);
    }
  };

  const formatOllamaBytes = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${bytes} B`;
  };

  const pullOllamaModel = async (model: string) => {
    setOllamaPulling(true);
    setOllamaPullProgress(null);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) {
        showError("Failed to start model download");
        setOllamaPulling(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const prog = JSON.parse(line);
            setOllamaPullProgress(prog);
          } catch { /* skip */ }
        }
      }
      await checkOllamaStatus();
      setOllamaPulling(false);
      await saveOllamaConfig(model);
    } catch (err) {
      showError(`Download failed: ${err instanceof Error ? err.message : err}`);
      setOllamaPulling(false);
    }
  };

  const saveOllamaConfig = async (model: string) => {
    setOllamaSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", apiKey: model, authMode: "local" }),
      });
      const data = await res.json();
      if (data.success) {
        showSuccessAndContinue(`Ollama configured with ${model}!`);
      } else {
        showError(data.error || "Failed to configure");
      }
    } catch (err) {
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setOllamaSaving(false);
    }
  };

  const selectExistingOllamaModel = async (model: string) => {
    await saveOllamaConfig(model);
  };

  const saveModel = async () => {
    if (!selectedProvider) return showError("Please select a provider");
    if (!apiKey.trim()) return showError("Please enter your key or token");

    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, apiKey: apiKey.trim(), authMode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) return showError(await extractError(res, "Failed to configure"));
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        showSuccessAndContinue("AI model configured! Continuing...");
      } else {
        showError(data.error || "Failed to configure");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  // Save token received from any OAuth flow (device or redirect)
  const saveOAuthToken = useCallback(async (
    tokenData: { access_token: string; refresh_token?: string; expires_in?: number; projectId?: string },
    successMessage: string
  ) => {
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    try {
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        showSuccessAndContinue(successMessage);
      } else {
        showError(saveData.error || "Failed to save token");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [selectedProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Device auth flow (OpenAI, Google) ---

  const currentDevice = DEVICE_AUTH_LABELS[selectedProvider ?? "openai"] ?? DEVICE_AUTH_LABELS.openai;

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
        const successMsg = DEVICE_AUTH_LABELS[selectedProvider ?? "openai"]?.success
          ?? "Subscription connected! Continuing...";
        await saveOAuthToken(data, successMsg);
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
  }, [stopPolling, saveOAuthToken, selectedProvider]);

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
    if (!authCode.trim()) return showError(`Please paste the ${currentOAuth.inputLabel.toLowerCase()}`);

    const parsedCode = parseAuthInput(authCode);
    if (!parsedCode) return showError("Could not extract authorization code from input");

    exchangeControllerRef.current?.abort();
    const controller = new AbortController();
    exchangeControllerRef.current = controller;

    setExchanging(true);
    setStatus(null);
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

      await saveOAuthToken(tokenData, currentOAuth.success);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setExchanging(false);
    }
  };

  const selected = PROVIDERS.find((p) => p.id === selectedProvider);
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
      button: "Connect with Claude",
      description:
        "Connect your Claude Pro or Max subscription. This will open claude.ai where you can authorize ClawBox to use your account.",
      success: "Claude subscription connected! Continuing...",
      steps: [
        "Authorize in the browser tab that just opened.",
        "Copy the authorization code shown after approval.",
        "Paste it below.",
      ],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
    openai: {
      button: "Connect to GPT",
      description:
        "Connect your ChatGPT Plus or Pro subscription. This will open OpenAI where you can authorize ClawBox to use your account.",
      success: "GPT subscription connected! Continuing...",
      steps: [
        "Sign in and authorize in the browser tab that just opened.",
        "After approval, the page will redirect to a URL that won\u2019t load \u2014 this is expected.",
        "Copy the full URL from your browser\u2019s address bar and paste it below.",
      ],
      inputLabel: "Callback URL",
      inputPlaceholder: "Paste the full URL here...",
    },
    google: {
      button: "Connect to Gemini",
      description:
        "Connect your Google Gemini subscription. This will open Google where you can authorize ClawBox to use your account.",
      success: "Gemini subscription connected! Continuing...",
      steps: [
        "Sign in with your Google account in the tab that just opened.",
        "Copy the authorization code shown after approval.",
        "Paste it below.",
      ],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
  };
  const DEFAULT_OAUTH_PROVIDER = "anthropic";
  const currentOAuth = oauthLabels[selectedProvider ?? DEFAULT_OAUTH_PROVIDER] ?? oauthLabels[DEFAULT_OAUTH_PROVIDER];

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
          {currentDevice.button}
        </button>
      ) : (
        <div>
          <div className="mb-4 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
            <p className="text-xs text-[var(--text-secondary)] mb-2">
              Open this URL:
            </p>
            <a
              href={deviceUrl!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                const win = window.open(deviceUrl!, "_blank");
                if (win) {
                  e.preventDefault();
                  oauthWindowRef.current = win;
                }
              }}
              className="text-sm font-medium text-[var(--coral-bright)] hover:text-orange-300 underline break-all"
            >
              {deviceUrl}
            </a>
            <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">Then enter this code:</p>
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
                    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
                  } catch { /* ignore */ }
                }}
                id="copy-code-btn"
                className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
              >
                Copy
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Code expires in 15 minutes
            </p>
          </div>

          {(devicePolling || deviceSaving) && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
              {deviceSaving ? "Authorized! Connecting..." : "Waiting for authorization..."}
            </div>
          )}

          <button
            type="button"
            onClick={startDeviceAuth}
            className="mt-2 bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
          >
            Get a new code
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
          {currentOAuth.button}
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
            Restart authorization
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          Connect AI Model
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          Select your AI provider and enter your API key or subscription token.
        </p>

        <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden">
          {PROVIDERS.map((provider) => {
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
                <div>
                  <span className="block text-sm font-medium text-gray-200">
                    {provider.name}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {provider.description}
                  </span>
                </div>
              </label>
            );
          })}
        </div>

        {selected?.id === "ollama" && (
          <div className="mt-5 space-y-4">
            {!ollamaRunning ? (
              <p className="text-xs text-yellow-400">Ollama is not running. Make sure it is installed and started on this device.</p>
            ) : (
              <>
                {ollamaModels.length > 0 && (
                  <div>
                    <p className="text-xs text-[var(--text-secondary)] mb-2">Installed models:</p>
                    {ollamaModels.map((m) => (
                      <div key={m.name} className="flex items-center justify-between py-1.5 px-3 bg-[var(--bg-deep)] rounded-lg mb-1">
                        <span className="text-sm text-gray-200">{m.name} <span className="text-xs text-[var(--text-muted)]">({formatOllamaBytes(m.size)})</span></span>
                        <button type="button" onClick={() => selectExistingOllamaModel(m.name)} disabled={ollamaSaving} className="px-3 py-1 text-xs font-semibold text-white btn-gradient rounded cursor-pointer disabled:opacity-50">Use</button>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1.5">Download a model</p>
                  <div className="space-y-1">
                    {[{ id: "llama3.2:3b", label: "Llama 3.2 3B" }, { id: "qwen2.5:3b-instruct-q4_K_M", label: "Qwen2.5 3B Instruct (Q4_K_M)" }].map((m) => (
                      <label key={m.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedOllamaModel === m.id ? "bg-orange-500/10" : "hover:bg-[var(--bg-surface)]/30"}`}>
                        <input type="radio" name="ollama-model" value={m.id} checked={selectedOllamaModel === m.id} onChange={() => setSelectedOllamaModel(m.id)} className="sr-only" />
                        <span className={`flex items-center justify-center w-4 h-4 rounded-full border-2 shrink-0 ${selectedOllamaModel === m.id ? "border-[var(--coral-bright)]" : "border-gray-600"}`}>
                          {selectedOllamaModel === m.id && <span className="w-2 h-2 rounded-full bg-orange-500" />}
                        </span>
                        <span className="text-sm text-gray-200">{m.label}</span>
                      </label>
                    ))}
                  </div>
                  {ollamaPulling && ollamaPullProgress && (
                    <div className="mt-2">
                      <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
                        <span>{ollamaPullProgress.status}</span>
                        {ollamaPullProgress.total ? <span>{Math.round(((ollamaPullProgress.completed || 0) / ollamaPullProgress.total) * 100)}%</span> : null}
                      </div>
                      {ollamaPullProgress.total && (
                        <div className="w-full h-2 bg-[var(--bg-deep)] rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all" style={{ width: `${Math.round(((ollamaPullProgress.completed || 0) / ollamaPullProgress.total) * 100)}%` }} />
                        </div>
                      )}
                    </div>
                  )}
                  <button type="button" onClick={() => pullOllamaModel(selectedOllamaModel)} disabled={ollamaPulling} className="mt-3 px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2">
                    {ollamaPulling && ButtonSpinner}
                    {ollamaPulling ? "Downloading..." : "Download & Configure"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {selected && selected.id !== "ollama" && activeAuth && (
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
                    {opt.label}
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
                    {activeAuth.tokenUrlLabel || "Get Token"}
                    <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
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
                    {showKey ? (
                      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    ) : (
                      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">{activeAuth.hint}</p>
              </div>
            )}
          </div>
        )}

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        <div className="flex items-center gap-3 mt-5">
          {selected?.id === "ollama" ? (
            null /* Ollama has its own buttons above */
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
                  className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2"
                >
                  {exchanging && ButtonSpinner}
                  {exchanging ? "Connecting..." : "Save & Continue"}
                </button>
              )
            )
          ) : (
            <button
              type="button"
              onClick={saveModel}
              disabled={saving || !selectedProvider}
              className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
            >
              {saving ? "Saving..." : "Save & Continue"}
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
