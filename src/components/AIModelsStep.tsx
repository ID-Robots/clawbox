"use client";

import { useState, useEffect, useRef } from "react";
import StatusMessage from "./StatusMessage";

interface AIModelsStepProps {
  onNext: () => void;
}

type AuthMode = "token" | "subscription";

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

export default function AIModelsStep({ onNext }: AIModelsStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>("anthropic");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // OAuth subscription state
  const [oauthStarted, setOauthStarted] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [exchanging, setExchanging] = useState(false);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const exchangeControllerRef = useRef<AbortController | null>(null);
  const oauthStartControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      saveControllerRef.current?.abort();
      exchangeControllerRef.current?.abort();
      oauthStartControllerRef.current?.abort();
    };
  }, []);

  const showError = (message: string) => setStatus({ type: "error", message });

  const showSuccessAndContinue = (message: string) => {
    setStatus({ type: "success", message });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => onNext(), 1500);
  };

  const extractError = async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    return typeof data.error === "string" ? data.error : fallback;
  };

  const selectProvider = (id: string) => {
    const provider = PROVIDERS.find((p) => p.id === id);
    setSelectedProvider(id);
    setAuthMode(provider?.authOptions[0]?.mode ?? "token");
    setApiKey("");
    setShowKey(false);
    setStatus(null);
    setOauthStarted(false);
    setAuthCode("");
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
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) return showError(await extractError(res, "Failed to start OAuth"));
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.url) {
        window.open(data.url, "_blank");
        setOauthStarted(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const exchangeCode = async () => {
    if (!authCode.trim()) return showError("Please paste the authorization code");

    exchangeControllerRef.current?.abort();
    const controller = new AbortController();
    exchangeControllerRef.current = controller;

    setExchanging(true);
    setStatus(null);
    try {
      // Exchange code for token
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: authCode.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!exchangeRes.ok) return showError(await extractError(exchangeRes, "Token exchange failed"));
      const tokenData = await exchangeRes.json();
      if (controller.signal.aborted) return;
      if (!tokenData.access_token) return showError("No access token received");

      // Save token via configure endpoint
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          apiKey: tokenData.access_token,
          authMode: "subscription",
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) return showError(await extractError(saveRes, "Failed to save token"));
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        showSuccessAndContinue("Claude subscription connected! Continuing...");
      } else {
        showError(saveData.error || "Failed to save token");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showError(`Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!controller.signal.aborted) setExchanging(false);
    }
  };

  const selected = PROVIDERS.find((p) => p.id === selectedProvider);
  const activeAuth =
    selected?.authOptions.find((a) => a.mode === authMode) ??
    selected?.authOptions[0];
  const isSubscription =
    selectedProvider === "anthropic" && authMode === "subscription";

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

        {selected && activeAuth && (
          <div className="mt-5">
            {selected.authOptions.length > 1 && (
              <div className="flex gap-1 mb-4 p-1 bg-[var(--bg-deep)] rounded-lg">
                {selected.authOptions.map((opt) => (
                  <button
                    type="button"
                    key={opt.mode}
                    onClick={() => {
                      setAuthMode(opt.mode);
                      setApiKey("");
                      setShowKey(false);
                      setStatus(null);
                      setOauthStarted(false);
                      setAuthCode("");
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
              /* OAuth Subscription Flow */
              <div>
                <p className="text-xs text-[var(--text-secondary)] mb-4 leading-relaxed">
                  Connect your Claude Pro or Max subscription. This will open claude.ai
                  where you can authorize ClawBox to use your account.
                </p>

                {!oauthStarted ? (
                  <button
                    type="button"
                    onClick={startOAuth}
                    className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
                  >
                    Connect with Claude
                  </button>
                ) : (
                  <div>
                    <div className="mb-4 p-3 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg">
                      <p className="text-xs text-[var(--text-primary)] leading-relaxed">
                        <strong className="text-[var(--coral-bright)]">1.</strong> Authorize in the
                        browser tab that just opened.<br />
                        <strong className="text-[var(--coral-bright)]">2.</strong> Copy the
                        authorization code shown after approval.<br />
                        <strong className="text-[var(--coral-bright)]">3.</strong> Paste it below.
                      </p>
                    </div>

                    <label
                      htmlFor="oauth-auth-code"
                      className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
                    >
                      Authorization Code
                    </label>
                    <input
                      id="oauth-auth-code"
                      type="text"
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") exchangeCode();
                      }}
                      placeholder="Paste code here..."
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
          {isSubscription ? (
            oauthStarted && (
              <button
                type="button"
                onClick={exchangeCode}
                disabled={exchanging || !authCode.trim()}
                className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
              >
                {exchanging ? "Connecting..." : "Save & Continue"}
              </button>
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
