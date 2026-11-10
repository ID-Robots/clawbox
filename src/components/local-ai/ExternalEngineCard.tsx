"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyProvidersChanged } from "@/lib/ui-events";
import { EXTERNAL_ENGINE_DEFAULTS } from "@/lib/external-engine-shared";
import { BUTTON, CARD, CardHeading, FOCUS_RING, PRIMARY_BUTTON } from "@/components/local-ai/ui";

/**
 * Settings → Local AI → External engine (TASK-2376).
 *
 * An OpenAI-compatible server the owner runs — an inference cluster, a vLLM /
 * SGLang / llama.cpp server on the machine or the LAN — used as the box's
 * Local AI instead of the model on the box. The card reads and writes ONE
 * route, `/setup-api/local-ai/external` (Test is its `/test` sibling): the
 * fields, a Test that asks the engine's `/models` and writes nothing, Save
 * (which tests again and makes it the chat's model), and a two-tap Remove that
 * puts the previous Local AI back. The API key is write-only: the route says
 * whether one is on file and never what it is.
 */

interface EngineView {
  configured: boolean;
  displayName?: string;
  modelRef?: string;
  baseUrl?: string;
  modelId?: string;
  contextWindow?: number;
  maxTokens?: number;
  imageInput?: boolean;
  apiKeySet?: boolean;
  activeHarness?: "openclaw" | "hermes";
  localOnlyMode?: boolean;
  hermesMinContextWindow?: number;
  unsupported?: string[];
  status?: { reachable: boolean; modelListed: boolean; latencyMs?: number; code?: string; error?: string };
}

interface Form {
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  modelId: string;
  contextWindow: string;
  maxTokens: string;
  imageInput: boolean;
}

/**
 * A sentence to show: a catalogue key with its values, or the route's own words
 * when it sent a code this card has no key for. Kept as a key and translated
 * at RENDER, so a result that lands before the locale table has loaded is not
 * frozen as the raw key.
 */
type Message = { key: string; params?: Record<string, string | number> } | { raw: string };

type Outcome = { kind: "ok" | "error"; message: Message; models?: string[] };

const INPUT = `w-full rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] ${FOCUS_RING}`;
const LABEL = "block text-xs font-medium text-[var(--text-secondary)] mb-1";

/** The catalogue key for a route `code`, so the owner reads it in their language. */
const ERROR_KEYS: Record<string, string> = {
  unreachable: "localModels.external.error.unreachable",
  unauthorized: "localModels.external.error.unauthorized",
  model_not_listed: "localModels.external.error.modelNotListed",
  bad_response: "localModels.external.error.badResponse",
  invalid_base_url: "localModels.external.error.baseUrl",
  invalid_model: "localModels.external.error.model",
  invalid_context_window: "localModels.external.error.contextWindow",
  invalid_max_tokens: "localModels.external.error.maxTokens",
  invalid_api_key: "localModels.external.error.apiKey",
  context_too_small_for_hermes: "localModels.external.error.hermesWindow",
  local_only_mode: "localModels.external.localOnly",
};

function formFrom(view: EngineView | null): Form {
  return {
    baseUrl: view?.baseUrl ?? "",
    apiKey: "",
    clearApiKey: false,
    modelId: view?.modelId ?? "",
    contextWindow: String(view?.contextWindow ?? EXTERNAL_ENGINE_DEFAULTS.contextWindow),
    maxTokens: String(view?.maxTokens ?? EXTERNAL_ENGINE_DEFAULTS.maxTokens),
    imageInput: view?.imageInput ?? false,
  };
}

/**
 * Would Test or Save send a key unencrypted to another machine? An http://
 * address that is not this box's loopback, with a key typed now or one on
 * file (and not being removed). HTTP stays allowed — a LAN server is the
 * common case — but the owner is told before the key goes out.
 */
export function sendsKeyInClear(form: Pick<Form, "baseUrl" | "apiKey" | "clearApiKey">, keyOnFile: boolean): boolean {
  let url: URL;
  try {
    url = new URL(form.baseUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return false;
  return form.apiKey.trim() !== "" || (keyOnFile && !form.clearApiKey);
}

function bodyFrom(form: Form): Record<string, unknown> {
  return {
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    contextWindow: form.contextWindow.trim(),
    maxTokens: form.maxTokens.trim(),
    imageInput: form.imageInput,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    ...(form.clearApiKey ? { clearApiKey: true } : {}),
  };
}

export default function ExternalEngineCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [view, setView] = useState<EngineView | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(() => formFrom(null));
  const [busy, setBusy] = useState<null | "test" | "save" | "remove">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [httpConfirmed, setHttpConfirmed] = useState(false);
  const alive = useRef(true);
  // Set on every mount, not only at creation: React's Strict Mode runs the
  // cleanup and the effect again, and a ref left false would drop every answer.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // Only the newest read may land: a probe still in flight from mount must not
  // overwrite what a save has just read back.
  const loadSeq = useRef(0);

  const n = useCallback((v: number | undefined) => (typeof v === "number" ? v.toLocaleString(locale) : "—"), [locale]);

  const describe = useCallback((data: { code?: unknown; error?: unknown }): Message => {
    const key = typeof data.code === "string" ? ERROR_KEYS[data.code] : undefined;
    if (key) return { key, params: { min: n(view?.hermesMinContextWindow ?? 64000) } };
    return typeof data.error === "string" && data.error ? { raw: data.error } : { key: "localModels.external.error.generic" };
  }, [n, view?.hermesMinContextWindow]);

  const say = (message: Message): string => ("raw" in message ? message.raw : t(message.key, message.params));

  const load = useCallback(async (probe: boolean) => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/setup-api/local-ai/external${probe ? "?probe=1" : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as EngineView;
      if (alive.current && seq === loadSeq.current) setView(data);
    } catch {
      // The card simply keeps what it showed; the panel above has its own retry.
    }
  }, []);

  useEffect(() => {
    void load(false).then(() => load(true));
  }, [load]);

  // Every reset of the form — Set up, Edit, Cancel, a save or a removal —
  // also drops the owner's yes to plain HTTP: a yes is for the address and
  // key it was given for, never one restored from a saved engine.
  const resetForm = (next: Form) => {
    setForm(next);
    setHttpConfirmed(false);
  };

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    // A yes is for the address and key it was given for; changing either asks again.
    if (key === "baseUrl" || key === "apiKey" || key === "clearApiKey") setHttpConfirmed(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const runTest = async () => {
    setBusy("test");
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/local-ai/external/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFrom(form)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok === true) {
        setOutcome({ kind: "ok", message: { key: "localModels.external.testOk", params: { model: form.modelId.trim(), ms: n(data.latencyMs) } } });
      } else {
        setOutcome({ kind: "error", message: describe(data), models: Array.isArray(data.models) ? data.models : undefined });
      }
    } catch {
      setOutcome({ kind: "error", message: { key: "localModels.external.error.generic" } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const runSave = async () => {
    setBusy("save");
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/local-ai/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFrom(form)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditing(false);
        setHttpConfirmed(false);
        setOutcome({
          kind: "ok",
          message: typeof data.warning === "string" && data.warning
            ? { raw: data.warning }
            : { key: "localModels.external.saved", params: { model: data.displayName ?? form.modelId.trim() } },
        });
        notifyProvidersChanged();
        onChanged?.();
        await load(true);
      } else {
        setOutcome({ kind: "error", message: describe(data), models: Array.isArray(data.models) ? data.models : undefined });
      }
    } catch {
      setOutcome({ kind: "error", message: { key: "localModels.external.error.generic" } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const runRemove = async () => {
    setBusy("remove");
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/local-ai/external", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setConfirmRemove(false);
        setOutcome({
          kind: "ok",
          message: typeof data.warning === "string" && data.warning ? { raw: data.warning } : { key: "localModels.external.removed" },
        });
        resetForm(formFrom(null));
        notifyProvidersChanged();
        onChanged?.();
        await load(false);
      } else {
        setOutcome({ kind: "error", message: describe(data) });
      }
    } catch {
      setOutcome({ kind: "error", message: { key: "localModels.external.error.generic" } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const configured = view?.configured === true;
  // A key that would go unencrypted to another machine waits for the owner's
  // explicit yes; Test and Save stay disabled until then.
  const inClear = sendsKeyInClear(form, view?.apiKeySet === true);
  const sendBlocked = inClear && !httpConfirmed;
  const onHermes = view?.activeHarness === "hermes";
  const localOnly = view?.localOnlyMode === true;

  const outcomeBlock = outcome && (
    <div
      role={outcome.kind === "error" ? "alert" : "status"}
      data-testid="local-ai-external-result"
      className={`mx-4 mb-3 rounded-lg px-3 py-2 text-xs ${outcome.kind === "ok"
        ? "border border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200"
        : "border border-red-500/20 bg-red-500/[0.06] text-red-300"}`}
    >
      {say(outcome.message)}
      {outcome.models && outcome.models.length > 0 && editing && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="local-ai-external-listed">
          <span className="text-[var(--text-secondary)]">{t("localModels.external.listed")}</span>
          {outcome.models.slice(0, 12).map((id) => (
            <button key={id} type="button" className={BUTTON} onClick={() => set("modelId", id)}>{id}</button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className={CARD} data-testid="local-ai-external-card" aria-busy={busy !== null}>
      <CardHeading title={t("localModels.external.title")} hint={t("localModels.external.hint")} />

      {configured && !editing && (
        <div className="px-4 pb-3 space-y-1 text-xs text-[var(--text-secondary)]" data-testid="local-ai-external-summary">
          <p className="text-sm text-[var(--text-primary)]">
            {t("localModels.external.inUse", { model: view?.displayName ?? view?.modelId ?? "" })}
          </p>
          <p className="break-all">{t("localModels.external.endpoint", { url: view?.baseUrl ?? "" })}</p>
          <p>
            {onHermes
              ? t("localModels.external.windowOnly", { context: n(view?.contextWindow) })
              : t("localModels.external.window", { context: n(view?.contextWindow), max: n(view?.maxTokens) })}
          </p>
          <p data-testid="local-ai-external-status">
            {!view?.status
              ? t("localModels.external.status.checking")
              : view.status.modelListed
                ? t("localModels.external.status.ok", { ms: n(view.status.latencyMs) })
                : t("localModels.external.status.problem", { problem: say(describe(view.status)) })}
          </p>
          <p>{t("localModels.external.onDeviceIdle")}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            <button type="button" className={BUTTON} data-testid="local-ai-external-edit" disabled={busy !== null}
              onClick={() => { resetForm(formFrom(view)); setEditing(true); setOutcome(null); setConfirmRemove(false); }}>
              {t("localModels.external.edit")}
            </button>
            {!confirmRemove ? (
              <button type="button" className={BUTTON} data-testid="local-ai-external-remove" disabled={busy !== null}
                onClick={() => setConfirmRemove(true)}>
                {t("localModels.external.remove")}
              </button>
            ) : (
              <>
                <button type="button" className={`${BUTTON} border-red-500/40 text-red-300`} data-testid="local-ai-external-remove-confirm"
                  disabled={busy !== null} onClick={() => void runRemove()}>
                  {busy === "remove" ? t("localModels.external.removing") : t("localModels.external.removeConfirm")}
                </button>
                <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setConfirmRemove(false)}>
                  {t("localModels.external.cancel")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!configured && !editing && view !== null && (
        <div className="px-4 pb-4 flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--text-secondary)]">{t("localModels.external.notConfigured")}</p>
          <button type="button" className={PRIMARY_BUTTON} data-testid="local-ai-external-setup"
            onClick={() => { resetForm(formFrom(null)); setEditing(true); setOutcome(null); }}>
            {t("localModels.external.setUp")}
          </button>
        </div>
      )}

      {editing && (
        <form
          className="px-4 pb-4 space-y-3"
          data-testid="local-ai-external-form"
          onSubmit={(e) => { e.preventDefault(); if (busy === null && !localOnly && !sendBlocked) void runSave(); }}
        >
          {localOnly && (
            <p role="note" className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
              {t("localModels.external.localOnly")}
            </p>
          )}
          <div>
            <label className={LABEL} htmlFor="ext-base-url">{t("localModels.external.baseUrl")}</label>
            <input id="ext-base-url" className={INPUT} data-testid="local-ai-external-base-url" type="url" inputMode="url"
              autoComplete="off" spellCheck={false} placeholder="http://192.0.2.10:8000/v1"
              value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">{t("localModels.external.baseUrlHint")}</p>
            {inClear && (
              <div role="note" data-testid="local-ai-external-http-warning"
                className="mt-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
                <p>{t("localModels.external.httpKeyWarning")}</p>
                {/* An explicit yes, before Test or Save may send the key. */}
                <label className="mt-1.5 flex items-center gap-2">
                  <input type="checkbox" data-testid="local-ai-external-http-confirm" checked={httpConfirmed}
                    onChange={(e) => setHttpConfirmed(e.target.checked)} />
                  {t("localModels.external.httpKeyConfirm")}
                </label>
              </div>
            )}
          </div>
          <div>
            <label className={LABEL} htmlFor="ext-api-key">{t("localModels.external.apiKey")}</label>
            <input id="ext-api-key" className={INPUT} data-testid="local-ai-external-api-key" type="password"
              autoComplete="new-password" spellCheck={false}
              placeholder={view?.apiKeySet && !form.clearApiKey ? t("localModels.external.apiKeyKeep") : t("localModels.external.apiKeyHint")}
              value={form.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
            {view?.apiKeySet && (
              <label className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <input type="checkbox" data-testid="local-ai-external-clear-key" checked={form.clearApiKey}
                  onChange={(e) => set("clearApiKey", e.target.checked)} />
                {t("localModels.external.clearKey")}
              </label>
            )}
          </div>
          <div>
            <label className={LABEL} htmlFor="ext-model">{t("localModels.external.model")}</label>
            <input id="ext-model" className={INPUT} data-testid="local-ai-external-model" type="text" autoComplete="off"
              spellCheck={false} placeholder="Qwen/Qwen3-32B" value={form.modelId} onChange={(e) => set("modelId", e.target.value)} />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">{t("localModels.external.modelHint")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="ext-context">{t("localModels.external.contextWindow")}</label>
              <input id="ext-context" className={INPUT} data-testid="local-ai-external-context" type="number" min={1024} step={1}
                value={form.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ext-max">{t("localModels.external.maxTokens")}</label>
              <input id="ext-max" className={INPUT} data-testid="local-ai-external-max-tokens" type="number" min={256} step={1}
                disabled={onHermes} value={form.maxTokens} onChange={(e) => set("maxTokens", e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" data-testid="local-ai-external-image" disabled={onHermes} checked={form.imageInput}
              onChange={(e) => set("imageInput", e.target.checked)} />
            {t("localModels.external.imageInput")}
          </label>
          {onHermes && (
            <p className="text-[11px] text-[var(--text-muted)]" data-testid="local-ai-external-hermes-note">
              {t("localModels.external.hermesNote", { min: n(view?.hermesMinContextWindow ?? 64000) })}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={BUTTON} data-testid="local-ai-external-test" disabled={busy !== null || sendBlocked}
              onClick={() => void runTest()}>
              {busy === "test" ? t("localModels.external.testing") : t("localModels.external.test")}
            </button>
            <button type="submit" className={PRIMARY_BUTTON} data-testid="local-ai-external-save" disabled={busy !== null || localOnly || sendBlocked}>
              {busy === "save" ? t("localModels.external.saving") : t("localModels.external.save")}
            </button>
            <button type="button" className={BUTTON} disabled={busy !== null}
              onClick={() => { setEditing(false); setHttpConfirmed(false); setOutcome(null); }}>
              {t("localModels.external.cancel")}
            </button>
          </div>
        </form>
      )}

      {outcomeBlock}
    </section>
  );
}
