"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BUTTON, CARD, CardHeading, FOCUS_RING, PRIMARY_BUTTON } from "@/components/local-ai/ui";

/**
 * Settings → Local AI → Speech to text → Your speech server (TASK-2501 PR-D).
 *
 * The owner's own OpenAI-compatible speech-to-text server, on this box or the
 * LAN, as the engine that transcribes the chat microphone and channel voice
 * notes. Reads `/setup-api/stt` (the engines, the primary, the local-only
 * lock) and writes `/setup-api/stt/endpoint` (Test, Save — which also makes it
 * the engine in use — and a two-tap Remove) and `/setup-api/stt` (Use, for a
 * saved server that is not in use). The key is write-only: the route says
 * whether one is on file and never what it is.
 */

interface EndpointView {
  configured: boolean;
  baseUrl?: string;
  model?: string;
  apiKeySet?: boolean;
}

interface SttView {
  primary?: string;
  localOnly?: boolean;
  engines?: { endpoint?: EndpointView };
}

interface Form {
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
}

type Message = { key: string; params?: Record<string, string | number> } | { raw: string };
type Outcome = { kind: "ok" | "warn" | "error"; message: Message };

const INPUT = `w-full rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] ${FOCUS_RING}`;
const LABEL = "block text-xs font-medium text-[var(--text-secondary)] mb-1";
const P = "localModels.sttEndpoint.";

/** The catalogue key for a route `code`, so the owner reads it in their language. */
const ERROR_KEYS: Record<string, string> = {
  unreachable: `${P}error.unreachable`,
  unauthorized: `${P}error.unauthorized`,
  address_refused: `${P}error.addressRefused`,
  invalid_base_url: `${P}error.baseUrl`,
  invalid_model: `${P}error.model`,
  invalid_api_key: `${P}error.apiKey`,
  bad_response: `${P}error.badResponse`,
  cloud_ai_locked: `${P}error.locked`,
};

function formFrom(view: EndpointView | null): Form {
  return { baseUrl: view?.baseUrl ?? "", model: view?.model ?? "", apiKey: "", clearApiKey: false };
}

function messageOf(payload: unknown): Message {
  const code = (payload as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ERROR_KEYS[code]) return { key: ERROR_KEYS[code] };
  return { key: `${P}error.generic` };
}

export default function SttEndpointCard({ onChanged }: { onChanged?: () => void }) {
  const { t } = useT();
  const [stt, setStt] = useState<SttView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(() => formFrom(null));
  const [busy, setBusy] = useState<null | "test" | "save" | "use" | "remove">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/stt", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as SttView;
      if (!alive.current) return;
      setStt(body);
      setReadFailed(false);
    } catch {
      if (alive.current) setReadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const endpoint = stt?.engines?.endpoint ?? null;
  const configured = endpoint?.configured === true;
  const inUse = configured && stt?.primary === "endpoint";
  const localOnly = stt?.localOnly === true;
  const say = (m: Message) => ("raw" in m ? m.raw : t(m.key, m.params));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const send = async (kind: "test" | "save"): Promise<void> => {
    setBusy(kind);
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/stt/endpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          ...(form.clearApiKey ? { clearApiKey: true } : {}),
          ...(kind === "test" ? { test: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!alive.current) return;
      if (!res.ok) {
        setOutcome({ kind: "error", message: messageOf(body) });
        return;
      }
      if (kind === "test") {
        setOutcome({ kind: "ok", message: { key: `${P}testOk`, params: { ms: Number(body?.latencyMs ?? 0) } } });
        return;
      }
      setEditing(false);
      setOutcome(
        typeof body?.warning === "string"
          ? { kind: "warn", message: { raw: body.warning } }
          : { kind: "ok", message: { key: `${P}saved` } },
      );
      await reload();
      onChanged?.();
    } catch {
      if (alive.current) setOutcome({ kind: "error", message: { key: `${P}error.generic` } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const use = async () => {
    setBusy("use");
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primary: "endpoint" }),
      });
      const body = await res.json().catch(() => null);
      if (!alive.current) return;
      if (!res.ok) setOutcome({ kind: "error", message: messageOf(body) });
      else if (typeof body?.warning === "string") setOutcome({ kind: "warn", message: { raw: body.warning } });
      await reload();
      onChanged?.();
    } catch {
      if (alive.current) setOutcome({ kind: "error", message: { key: `${P}error.generic` } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setOutcome(null);
    try {
      const res = await fetch("/setup-api/stt/endpoint", { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!alive.current) return;
      setConfirmRemove(false);
      if (!res.ok) {
        setOutcome({ kind: "error", message: messageOf(body) });
        return;
      }
      setOutcome(
        typeof body?.warning === "string"
          ? { kind: "warn", message: { raw: body.warning } }
          : { kind: "ok", message: { key: `${P}removed` } },
      );
      await reload();
      onChanged?.();
    } catch {
      if (alive.current) setOutcome({ kind: "error", message: { key: `${P}error.generic` } });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const tone = outcome?.kind === "ok" ? "text-emerald-300" : outcome?.kind === "warn" ? "text-amber-200" : "text-red-300";

  return (
    <section className={CARD} data-testid="local-ai-stt-endpoint-card" aria-busy={busy !== null}>
      <CardHeading title={t(`${P}title`)} hint={t(`${P}hint`)} />

      {localOnly && (
        <p role="note" data-testid="local-ai-stt-endpoint-local-only"
          className="mx-4 mb-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          {t(`${P}localOnly`)}
        </p>
      )}

      {stt === null && readFailed && (
        <div className="px-4 pb-4 flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-red-300">{t(`${P}readFailed`)}</p>
          <button type="button" className={BUTTON} onClick={() => void reload()}>{t(`${P}retry`)}</button>
        </div>
      )}

      {configured && !editing && (
        <div className="px-4 pb-3 space-y-1 text-xs text-[var(--text-secondary)]" data-testid="local-ai-stt-endpoint-summary">
          <p className="text-sm text-[var(--text-primary)] break-all">
            {t(inUse ? `${P}inUse` : `${P}standby`, { url: endpoint?.baseUrl ?? "", model: endpoint?.model ?? "" })}
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            {!inUse && (
              <button type="button" className={PRIMARY_BUTTON} data-testid="local-ai-stt-endpoint-use" disabled={busy !== null}
                onClick={() => void use()}>
                {t(`${P}use`)}
              </button>
            )}
            <button type="button" className={BUTTON} data-testid="local-ai-stt-endpoint-edit" disabled={busy !== null}
              onClick={() => { setForm(formFrom(endpoint)); setEditing(true); setOutcome(null); setConfirmRemove(false); }}>
              {t(`${P}edit`)}
            </button>
            {!confirmRemove ? (
              <button type="button" className={BUTTON} data-testid="local-ai-stt-endpoint-remove" disabled={busy !== null}
                onClick={() => setConfirmRemove(true)}>
                {t(`${P}remove`)}
              </button>
            ) : (
              <>
                <button type="button" className={`${BUTTON} border-red-500/40 text-red-300`} data-testid="local-ai-stt-endpoint-remove-confirm"
                  disabled={busy !== null} onClick={() => void remove()}>
                  {busy === "remove" ? t(`${P}removing`) : t(`${P}removeConfirm`)}
                </button>
                <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setConfirmRemove(false)}>
                  {t(`${P}cancel`)}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {stt !== null && !configured && !editing && (
        <div className="px-4 pb-4 flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--text-secondary)]">{t(`${P}notConfigured`)}</p>
          <button type="button" className={PRIMARY_BUTTON} data-testid="local-ai-stt-endpoint-setup"
            onClick={() => { setForm(formFrom(null)); setEditing(true); setOutcome(null); }}>
            {t(`${P}setUp`)}
          </button>
        </div>
      )}

      {editing && (
        <form className="px-4 pb-4 space-y-3" data-testid="local-ai-stt-endpoint-form"
          onSubmit={(e) => { e.preventDefault(); if (busy === null) void send("save"); }}>
          <div>
            <label className={LABEL} htmlFor="stt-endpoint-base-url">{t(`${P}baseUrl`)}</label>
            <input id="stt-endpoint-base-url" className={INPUT} data-testid="local-ai-stt-endpoint-base-url" type="url" inputMode="url"
              autoComplete="off" spellCheck={false} placeholder="http://192.168.1.20:8000/v1"
              value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">{t(`${P}baseUrlHint`)}</p>
          </div>
          <div>
            <label className={LABEL} htmlFor="stt-endpoint-model">{t(`${P}model`)}</label>
            <input id="stt-endpoint-model" className={INPUT} data-testid="local-ai-stt-endpoint-model" type="text" autoComplete="off"
              spellCheck={false} placeholder="whisper-1" value={form.model} onChange={(e) => set("model", e.target.value)} />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">{t(`${P}modelHint`)}</p>
          </div>
          <div>
            <label className={LABEL} htmlFor="stt-endpoint-api-key">{t(`${P}apiKey`)}</label>
            <input id="stt-endpoint-api-key" className={INPUT} data-testid="local-ai-stt-endpoint-api-key" type="password"
              autoComplete="new-password" spellCheck={false}
              placeholder={endpoint?.apiKeySet && !form.clearApiKey ? t(`${P}apiKeyKeep`) : ""}
              value={form.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
            {endpoint?.apiKeySet && (
              <label className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <input type="checkbox" data-testid="local-ai-stt-endpoint-clear-key" checked={form.clearApiKey}
                  onChange={(e) => set("clearApiKey", e.target.checked)} />
                {t(`${P}clearKey`)}
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={BUTTON} data-testid="local-ai-stt-endpoint-test" disabled={busy !== null || !form.baseUrl.trim()}
              onClick={() => void send("test")}>
              {busy === "test" ? t(`${P}testing`) : t(`${P}test`)}
            </button>
            <button type="submit" className={PRIMARY_BUTTON} data-testid="local-ai-stt-endpoint-save" disabled={busy !== null || !form.baseUrl.trim()}>
              {busy === "save" ? t(`${P}saving`) : t(`${P}save`)}
            </button>
            <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => { setEditing(false); setOutcome(null); }}>
              {t(`${P}cancel`)}
            </button>
          </div>
        </form>
      )}

      {outcome && (
        <p role={outcome.kind === "error" ? "alert" : "status"} data-testid="local-ai-stt-endpoint-outcome"
          className={`px-4 pb-4 text-xs ${tone}`}>
          {say(outcome.message)}
        </p>
      )}
    </section>
  );
}
