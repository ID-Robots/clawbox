"use client";

import { useEffect, useMemo, useState } from "react";

// Hermes-edition replacement for the OpenClaw AI-provider step. Hermes manages
// its own providers/models, so instead of ClawBox's openclaw.json flow we drive
// Hermes' own config: GET/POST /setup-api/hermes/models (default model +
// provider) and POST /setup-api/hermes/provider-key (api-key credentials).

interface HermesModel {
  id: string;
  description?: string;
}

// Mirrors ALLOWED_PROVIDERS in the models route; label + whether it takes a key.
const PROVIDERS: { id: string; label: string; keyProvider?: boolean }[] = [
  { id: "auto", label: "Auto — detect from credentials" },
  { id: "openrouter", label: "OpenRouter", keyProvider: true },
  { id: "anthropic", label: "Anthropic", keyProvider: true },
  { id: "nous", label: "Nous Portal (OAuth)" },
  { id: "nous-api", label: "Nous Portal (API key)", keyProvider: true },
  { id: "gemini", label: "Google Gemini", keyProvider: true },
  { id: "zai", label: "z.ai / GLM", keyProvider: true },
  { id: "kimi-coding", label: "Kimi (coding)", keyProvider: true },
  { id: "openai-codex", label: "OpenAI Codex (OAuth)" },
  { id: "copilot", label: "GitHub Copilot" },
];

const KEY_PROVIDERS = PROVIDERS.filter((p) => p.keyProvider);

type Status = { kind: "ok" | "err"; msg: string } | null;

interface Props {
  embedded?: boolean;
  onNext?: () => void;
  testId?: string;
}

export default function HermesProviderConfig({ embedded, onNext, testId }: Props) {
  const [models, setModels] = useState<HermesModel[]>([]);
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("auto");
  const [loading, setLoading] = useState(true);
  const [savingModel, setSavingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState<Status>(null);

  const [keyProvider, setKeyProvider] = useState(KEY_PROVIDERS[0]?.id ?? "openrouter");
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<Status>(null);

  useEffect(() => {
    let alive = true;
    fetch("/setup-api/hermes/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { models?: HermesModel[]; current?: string }) => {
        if (!alive) return;
        setModels(Array.isArray(d.models) ? d.models : []);
        if (typeof d.current === "string" && d.current) setModel(d.current);
      })
      .catch(() => { if (alive) setModelStatus({ kind: "err", msg: "Couldn't load models" }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const modelOptions = useMemo(() => {
    // Ensure the current default is present even if it's not in the catalog.
    if (model && !models.some((m) => m.id === model)) {
      return [{ id: model, description: "current" }, ...models];
    }
    return models;
  }, [models, model]);

  async function saveModelProvider() {
    setSavingModel(true);
    setModelStatus(null);
    try {
      const res = await fetch("/setup-api/hermes/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setModelStatus({ kind: "ok", msg: "Saved" });
    } catch (e) {
      setModelStatus({ kind: "err", msg: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSavingModel(false);
    }
  }

  async function saveKey() {
    setSavingKey(true);
    setKeyStatus(null);
    try {
      const res = await fetch("/setup-api/hermes/provider-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: keyProvider, apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setKeyStatus({ kind: "ok", msg: "API key saved" });
      setApiKey("");
    } catch (e) {
      setKeyStatus({ kind: "err", msg: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSavingKey(false);
    }
  }

  const selectCls =
    "w-full rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]";
  const labelCls = "block text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5";

  function statusLine(s: Status) {
    if (!s) return null;
    return (
      <p className={`text-xs mt-1.5 ${s.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>{s.msg}</p>
    );
  }

  return (
    <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
      <div className="card-surface rounded-2xl p-5 sm:p-8">
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-1">Hermes models</h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed text-sm">
          This device runs on Hermes. Pick the default model and inference provider,
          and add a provider API key — no need to open the dashboard.
        </p>

        {/* Model + provider */}
        <div className="space-y-4">
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

          <div>
            <label className={labelCls} htmlFor="hermes-provider">Inference provider</label>
            <select
              id="hermes-provider"
              className={selectCls}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={saveModelProvider}
            disabled={savingModel || loading || !model}
            className="w-full rounded-xl bg-[var(--coral-bright)] text-white font-semibold py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {savingModel ? "Saving…" : "Save model & provider"}
          </button>
          {statusLine(modelStatus)}
        </div>

        {/* Provider API key */}
        <div className="mt-7 pt-6 border-t border-[var(--border-subtle)] space-y-4">
          <div>
            <label className={labelCls} htmlFor="hermes-key-provider">Provider API key</label>
            <select
              id="hermes-key-provider"
              className={selectCls}
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
            >
              {KEY_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <input
              type="password"
              className={selectCls}
              placeholder="Paste API key"
              value={apiKey}
              autoComplete="off"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={saveKey}
            disabled={savingKey || apiKey.trim().length < 8}
            className="w-full rounded-xl border border-[var(--border-subtle)] text-[var(--text-primary)] font-semibold py-2.5 hover:bg-[var(--surface-card)] transition-colors disabled:opacity-50"
          >
            {savingKey ? "Saving…" : "Save API key"}
          </button>
          {statusLine(keyStatus)}
        </div>

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
