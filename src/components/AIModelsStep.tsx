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
        mode: "token",
        label: "API Key",
        placeholder: "sk-ant-api03-...",
        hint: "Get your API key from console.anthropic.com",
        tokenUrl: "https://console.anthropic.com/settings/keys",
        tokenUrlLabel: "Get API Key",
      },
      {
        mode: "subscription",
        label: "Subscription",
        placeholder: "",
        hint: "Connect your Claude Pro/Max subscription via OAuth.",
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
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("token");
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

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      saveControllerRef.current?.abort();
    };
  }, []);

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
    if (!selectedProvider) {
      setStatus({ type: "error", message: "Please select a provider" });
      return;
    }
    if (!apiKey.trim()) {
      setStatus({ type: "error", message: "Please enter your key or token" });
      return;
    }

    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: apiKey.trim(),
          authMode,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: typeof data.error === "string" ? data.error : "Failed to configure",
        });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setStatus({
          type: "success",
          message: "AI model configured! Continuing...",
        });
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => onNext(), 1500);
      } else {
        setStatus({
          type: "error",
          message: data.error || "Failed to configure",
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const startOAuth = async () => {
    setStatus(null);
    setOauthStarted(false);
    setAuthCode("");
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: typeof data.error === "string" ? data.error : "Failed to start OAuth",
        });
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
        setOauthStarted(true);
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  };

  const exchangeCode = async () => {
    if (!authCode.trim()) {
      setStatus({ type: "error", message: "Please paste the authorization code" });
      return;
    }
    setExchanging(true);
    setStatus(null);
    try {
      // Step 1: Exchange code for token
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: authCode.trim() }),
      });
      if (!exchangeRes.ok) {
        const data = await exchangeRes.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: typeof data.error === "string"
            ? data.error
            : data.error?.message || "Token exchange failed",
        });
        return;
      }
      const tokenData = await exchangeRes.json();
      if (!tokenData.access_token) {
        setStatus({ type: "error", message: "No access token received" });
        return;
      }

      // Step 2: Save the token via configure endpoint
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          apiKey: tokenData.access_token,
          authMode: "subscription",
        }),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: typeof data.error === "string" ? data.error : "Failed to save token",
        });
        return;
      }
      const saveData = await saveRes.json();
      if (saveData.success) {
        setStatus({
          type: "success",
          message: "Claude subscription connected! Continuing...",
        });
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => onNext(), 1500);
      } else {
        setStatus({
          type: "error",
          message: saveData.error || "Failed to save token",
        });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setExchanging(false);
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
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          Connect AI Model
        </h1>
        <p className="text-gray-400 mb-5 leading-relaxed">
          Select your AI provider and enter your API key or subscription token.
        </p>

        <div className="border border-gray-700 rounded-lg bg-gray-900/50 overflow-hidden">
          {PROVIDERS.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <button
                type="button"
                key={provider.id}
                onClick={() => selectProvider(provider.id)}
                className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer bg-transparent border-x-0 border-t-0 ${
                  isSelected
                    ? "bg-orange-500/5"
                    : "hover:bg-gray-700/50"
                }`}
              >
                <span
                  className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
                    isSelected
                      ? "border-orange-500"
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
                  <span className="block text-xs text-gray-500">
                    {provider.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {selected && activeAuth && (
          <div className="mt-5">
            {selected.authOptions.length > 1 && (
              <div className="flex gap-1 mb-4 p-1 bg-gray-900 rounded-lg">
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
                        ? "bg-gray-700 text-gray-200"
                        : "bg-transparent text-gray-500 hover:text-gray-400"
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
                <p className="text-xs text-gray-400 mb-4 leading-relaxed">
                  Connect your Claude Pro or Max subscription. This will open claude.ai
                  where you can authorize ClawBox to use your account.
                </p>

                {!oauthStarted ? (
                  <button
                    type="button"
                    onClick={startOAuth}
                    className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
                  >
                    Connect with Claude
                  </button>
                ) : (
                  <div>
                    <div className="mb-4 p-3 bg-gray-900 border border-gray-700 rounded-lg">
                      <p className="text-xs text-gray-300 leading-relaxed">
                        <strong className="text-orange-400">1.</strong> Authorize in the
                        browser tab that just opened.<br />
                        <strong className="text-orange-400">2.</strong> Copy the
                        authorization code shown after approval.<br />
                        <strong className="text-orange-400">3.</strong> Paste it below.
                      </p>
                    </div>

                    <label
                      htmlFor="oauth-auth-code"
                      className="block text-xs font-semibold text-gray-400 mb-1.5"
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
                      className="w-full px-3.5 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500"
                    />

                    <button
                      type="button"
                      onClick={startOAuth}
                      className="mt-2 bg-transparent border-none text-orange-400 text-xs underline cursor-pointer p-0"
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
                    className="inline-flex items-center gap-1.5 mb-3 text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors"
                  >
                    {activeAuth.tokenUrlLabel || "Get Token"}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}

                <label
                  htmlFor="ai-api-key"
                  className="block text-xs font-semibold text-gray-400 mb-1.5"
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
                    className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5"
                  >
                    {showKey ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-gray-500">{activeAuth.hint}</p>
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
                className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
              >
                {exchanging ? "Connecting..." : "Save & Continue"}
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={saveModel}
              disabled={saving || !selectedProvider}
              className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
            >
              {saving ? "Saving..." : "Save & Continue"}
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-orange-400 text-sm underline cursor-pointer p-1"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
