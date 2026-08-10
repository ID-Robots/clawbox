"use client";

import { useEffect, useMemo, useState } from "react";
import AIProviderIcon from "./AIProviderIcon";
import { CLAWBOX_AI_TIER_LABEL } from "@/lib/clawbox-ai-models";

// Hermes-edition AI-provider panel. Mirrors the OpenClaw AI-models UI (provider
// radio-cards with logos) but drives Hermes' OWN native switching:
//   • model + provider  → POST /setup-api/hermes/models  (hermes config set)
//   • provider API key  → POST /setup-api/hermes/provider-key (hermes auth add)
//   • ClawBox AI        → POST /setup-api/hermes/clawai (custom provider through Hermes)
// Only ClawBox AI's device-login is ClawBox-specific; everything else is Hermes-native.

interface HermesModel {
  id: string;
  description?: string;
}

interface ProviderDef {
  id: string;
  name: string;
  description: string;
  keyProvider?: boolean;
}

// ClawBox AI is inserted first (when a token exists). The rest map 1:1 to the
// providers `hermes config set model.provider` accepts.
const PROVIDERS: ProviderDef[] = [
  { id: "openrouter", name: "OpenRouter", description: "300+ models behind one API key", keyProvider: true },
  { id: "anthropic", name: "Anthropic", description: "Claude models, direct", keyProvider: true },
  { id: "gemini", name: "Google Gemini", description: "Gemini models, direct", keyProvider: true },
  { id: "nous-api", name: "Nous Portal", description: "Hermes / Nous models (API key)", keyProvider: true },
  { id: "zai", name: "z.ai / GLM", description: "Zhipu GLM models", keyProvider: true },
  { id: "kimi-coding", name: "Kimi", description: "Moonshot Kimi (coding)", keyProvider: true },
  { id: "openai-codex", name: "OpenAI Codex", description: "Sign in with OpenAI" },
  { id: "copilot", name: "GitHub Copilot", description: "Uses your GitHub token" },
  { id: "nous", name: "Nous Portal (OAuth)", description: "Sign in with Nous" },
  { id: "auto", name: "Auto", description: "Detect from configured credentials" },
];

type Status = { kind: "ok" | "err"; msg: string } | null;

interface Props {
  embedded?: boolean;
  onNext?: () => void;
  testId?: string;
}

export default function HermesProviderConfig({ embedded, onNext, testId }: Props) {
  const [models, setModels] = useState<HermesModel[]>([]);
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(true);

  const [selectedProvider, setSelectedProvider] = useState<string>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Status>(null);

  // ClawBox AI — a managed provider that still runs THROUGH Hermes.
  const [clawai, setClawai] = useState<{ hasToken: boolean; tier: string; active: boolean; model: string } | null>(null);
  const [applyingClawai, setApplyingClawai] = useState(false);
  const [clawaiStatus, setClawaiStatus] = useState<Status>(null);

  useEffect(() => {
    let alive = true;
    fetch("/setup-api/hermes/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { models?: HermesModel[]; current?: string }) => {
        if (!alive) return;
        setModels(Array.isArray(d.models) ? d.models : []);
        if (typeof d.current === "string" && d.current) setModel(d.current);
      })
      .catch(() => { if (alive) setSaveStatus({ kind: "err", msg: "Couldn't load models" }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/setup-api/hermes/clawai")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!alive) return;
        setClawai(d);
        if (d?.active) setSelectedProvider("clawai");
      })
      .catch(() => { /* ClawBox AI just won't show; non-fatal */ });
    return () => { alive = false; };
  }, []);

  const modelOptions = useMemo(() => {
    if (model && !models.some((m) => m.id === model)) {
      return [{ id: model, description: "current" }, ...models];
    }
    return models;
  }, [models, model]);

  // ClawBox AI first (when available), then the native providers.
  const providerList: (ProviderDef & { special?: boolean; tier?: string })[] = useMemo(() => {
    const base = [...PROVIDERS];
    if (clawai?.hasToken) {
      base.unshift({ id: "clawai", name: "ClawBox AI", description: clawai.model, special: true, tier: clawai.tier });
    }
    return base;
  }, [clawai]);

  const selectedDef = providerList.find((p) => p.id === selectedProvider);

  async function useClawai() {
    setApplyingClawai(true);
    setClawaiStatus(null);
    try {
      const res = await fetch("/setup-api/hermes/clawai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setClawai((c) => (c ? { ...c, active: true } : c));
      if (typeof data.model === "string") setModel(data.model);
      setClawaiStatus({ kind: "ok", msg: "ClawBox AI is now your active model" });
    } catch (e) {
      setClawaiStatus({ kind: "err", msg: e instanceof Error ? e.message : "Couldn't switch to ClawBox AI" });
    } finally {
      setApplyingClawai(false);
    }
  }

  async function saveModelProvider() {
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await fetch("/setup-api/hermes/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, provider: selectedProvider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      // If a key was entered for a key-provider, save it too.
      if (selectedDef?.keyProvider && apiKey.trim()) {
        const kr = await fetch("/setup-api/hermes/provider-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: selectedProvider, apiKey: apiKey.trim() }),
        });
        const kd = await kr.json().catch(() => ({}));
        if (!kr.ok) throw new Error(kd?.error || `Key: HTTP ${kr.status}`);
        setApiKey("");
      }
      // Selecting a non-clawai provider means ClawBox AI is no longer active.
      setClawai((c) => (c ? { ...c, active: false } : c));
      setSaveStatus({ kind: "ok", msg: "Saved" });
    } catch (e) {
      setSaveStatus({ kind: "err", msg: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  const selectCls =
    "w-full rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]";
  const labelCls = "block text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5";

  function statusLine(s: Status) {
    if (!s) return null;
    return <p className={`text-xs mt-1.5 ${s.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>{s.msg}</p>;
  }

  const isClawaiSelected = selectedProvider === "clawai";

  return (
    <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
      <div className="card-surface rounded-2xl p-5 sm:p-8">
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-1">Hermes models</h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed text-sm">
          This device runs on Hermes. Choose an inference provider and default model —
          they switch through Hermes natively, no dashboard needed.
        </p>

        {/* Provider radio-cards (OpenClaw-style) */}
        <div role="radiogroup" aria-label="AI Provider" className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden">
          {providerList.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <label
                key={provider.id}
                className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer ${
                  isSelected ? "bg-orange-500/5" : "hover:bg-[var(--surface-card)]"
                }`}
              >
                <input
                  type="radio"
                  name="hermes-ai-provider"
                  value={provider.id}
                  checked={isSelected}
                  onChange={() => { setSelectedProvider(provider.id); setSaveStatus(null); }}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
                    isSelected ? "border-[var(--coral-bright)]" : "border-gray-600"
                  }`}
                >
                  {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                </span>
                <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] shrink-0 overflow-visible">
                  <AIProviderIcon provider={provider.id} size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-200">
                    {provider.name}
                    {provider.special && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-orange-500/15 text-orange-400 leading-none">
                        {CLAWBOX_AI_TIER_LABEL[(provider.tier as "flash" | "pro")] ?? "AI"}
                      </span>
                    )}
                    {clawai?.active && provider.id === "clawai" && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-emerald-500/15 text-emerald-400 leading-none">Active</span>
                    )}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)] truncate">{provider.description}</span>
                </div>
              </label>
            );
          })}
        </div>

        {/* Contextual controls for the selection */}
        {isClawaiSelected ? (
          <div className="mt-5">
            <button
              type="button"
              onClick={useClawai}
              disabled={applyingClawai || clawai?.active}
              className="w-full rounded-xl bg-[var(--coral-bright)] text-white font-semibold py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {clawai?.active ? "ClawBox AI in use" : applyingClawai ? "Switching…" : "Use ClawBox AI"}
            </button>
            {statusLine(clawaiStatus)}
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div>
              <label className={labelCls} htmlFor="hermes-model">Default model</label>
              <select
                id="hermes-model"
                className={selectCls}
                value={model}
                disabled={loading}
                onChange={(e) => setModel(e.target.value)}
              >
                {loading && <option>Loading…</option>}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}{m.description ? ` — ${m.description}` : ""}
                  </option>
                ))}
              </select>
            </div>

            {selectedDef?.keyProvider && (
              <div>
                <label className={labelCls} htmlFor="hermes-key">{selectedDef.name} API key</label>
                <input
                  id="hermes-key"
                  type="password"
                  className={selectCls}
                  placeholder="Paste API key (optional if already set)"
                  value={apiKey}
                  autoComplete="off"
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            )}

            <button
              type="button"
              onClick={saveModelProvider}
              disabled={saving || loading || !model}
              className="w-full rounded-xl bg-[var(--coral-bright)] text-white font-semibold py-3 hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save model & provider"}
            </button>
            {statusLine(saveStatus)}
          </div>
        )}

        {!embedded && (
          <button
            type="button"
            onClick={() => onNext?.()}
            className="mt-7 w-full rounded-xl bg-[var(--surface-card)] text-[var(--text-primary)] font-semibold py-3 hover:opacity-90 transition-opacity"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
