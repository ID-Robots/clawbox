"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import DeviceCodeCard from "./DeviceCodeCard";
import { BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";

/**
 * Settings → Coding Agent: the owner's OWN OpenAI account, for runs set to
 * OpenAI — which run on the Codex CLI. The twin of CodingAgentAnthropicCard,
 * built the same way (its own route, its own read, its own refusal slot), with
 * one difference: BOTH ways in are this box's own. The API key is stored here,
 * and the ChatGPT sign-in is made here too — Codex's device flow, in the coding
 * agent's own Codex home — so each has its own button to take it back.
 *
 * The key is never read back and the field is emptied the instant a save
 * lands, exactly as on the Anthropic card.
 */

export interface CodexLogin {
  id: string;
  status: "starting" | "pending" | "approved" | "failed" | "expired" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  expiresAt: number;
}

export interface OpenAIState {
  connected: boolean;
  hasKey: boolean;
  hasLogin: boolean;
  source: "key" | "chatgpt" | null;
  status: "connected" | "disconnected" | "limited";
  limitedUntil: number | null;
  codexInstalled: boolean;
  models?: string[];
  defaultModel?: string | null;
  /** POST of a key only: did OpenAI confirm it, or could the box not ask? */
  verified?: boolean;
  /** A sign-in in progress, on the answers that concern one. */
  login?: CodexLogin | null;
}

const CONFIRM_MS = 5_000;
/** How often a pending sign-in is asked about. */
const POLL_MS = 3_000;

const ROUTE = "/setup-api/coding-agent/openai";

const post = async (body: Record<string, unknown>): Promise<Response> => fetch(ROUTE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function CodingAgentOpenAICard({ onChanged }: {
  /** Fired after any change, so the panel re-reads readiness. */
  onChanged?: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<OpenAIState | null>(null);
  const [read, setRead] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | "login" | "signout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "signout" | null>(null);
  const [login, setLogin] = useState<CodexLogin | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  /** Writes started; a read issued before the latest one is dropped (see the Anthropic card). */
  const writes = useRef(0);

  const disarm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirm(null);
  }, []);
  const arm = (what: "remove" | "signout") => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => {
      confirmTimer.current = null;
      setConfirm(null);
    }, CONFIRM_MS);
    setConfirm(what);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const load = useCallback(async () => {
    const issuedAt = writes.current;
    try {
      const res = await fetch(ROUTE, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json() as OpenAIState;
      if (writes.current !== issuedAt) return;
      setState(next);
      setRead(true);
    } catch {
      // Keep what was last known; never claim "not connected" over a failed read.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const readError = async (res: Response, fallback: string): Promise<string> => {
    try {
      const body = await res.json() as { error?: unknown };
      return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
    } catch {
      return fallback;
    }
  };

  const save = async () => {
    const apiKey = draft.trim();
    if (!apiKey) return;
    writes.current += 1;
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      const res = await post({ apiKey });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.openaiSaveFailed")));
      const next = await res.json() as OpenAIState;
      setState(next);
      setRead(true);
      setDraft("");
      setNote(next.verified === false ? t("codingAgent.openaiSavedUnchecked") : null);
      onChangedRef.current?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.openaiSaveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const removeWhat = async (what: "key" | "login") => {
    writes.current += 1;
    setBusy(what === "key" ? "remove" : "signout");
    setError(null);
    setNote(null);
    const fallback = what === "key" ? t("codingAgent.openaiRemoveFailed") : t("codingAgent.openaiSignOutFailed");
    try {
      const res = await fetch(what === "key" ? ROUTE : `${ROUTE}?what=login`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, fallback));
      setState(await res.json() as OpenAIState);
      setRead(true);
      onChangedRef.current?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(null);
    }
  };

  /** A sign-in's answer, applied: the account state, and the sign-in or its end. */
  const applyLogin = useCallback((next: OpenAIState) => {
    setState(next);
    setRead(true);
    const current = next.login ?? null;
    if (!current) return;
    if (current.status === "approved") {
      setLogin(null);
      onChangedRef.current?.();
    } else if (current.status === "failed") {
      setLogin(null);
      setError(current.error || t("codingAgent.openaiSignInFailed"));
    } else if (current.status === "expired") {
      setLogin(null);
      setError(t("codingAgent.openaiSignInExpired"));
    } else if (current.status === "cancelled") {
      setLogin(null);
    } else {
      setLogin(current);
    }
  }, [t]);

  const startLogin = async () => {
    writes.current += 1;
    setBusy("login");
    setError(null);
    setNote(null);
    try {
      const res = await post({ action: "login-start" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.openaiSignInFailed")));
      applyLogin(await res.json() as OpenAIState);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.openaiSignInFailed"));
    } finally {
      setBusy(null);
    }
  };

  const cancelLogin = async () => {
    const id = login?.id;
    setLogin(null);
    if (!id) return;
    try {
      await post({ action: "login-cancel", id });
    } catch {
      // The sign-in ends by itself when its code expires.
    }
  };

  // While a sign-in waits on the owner, ask how it stands.
  const pendingId = login && (login.status === "pending" || login.status === "starting") ? login.id : null;
  useEffect(() => {
    if (!pendingId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await post({ action: "login-poll", id: pendingId });
        if (stopped) return;
        if (res.status === 404) {
          setLogin(null);
          setError(t("codingAgent.openaiSignInFailed"));
          return;
        }
        if (!res.ok) return;
        applyLogin(await res.json() as OpenAIState);
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [pendingId, applyLogin, t]);

  const stateLine = () => {
    if (!read) return <span className="text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-openai-state">{t("codingAgent.openaiUnknown")}</span>;
    if (state?.status === "limited" && state.limitedUntil) {
      return <span className="text-[11px] text-amber-400" data-testid="coding-agent-openai-state" data-status="limited">{t("codingAgent.openaiLimited", { time: clock(state.limitedUntil) })}</span>;
    }
    if (state?.source === "key") return <span className="text-[11px] text-emerald-400" data-testid="coding-agent-openai-state" data-status="connected">{t("codingAgent.openaiViaKey")}</span>;
    if (state?.source === "chatgpt") return <span className="text-[11px] text-emerald-400" data-testid="coding-agent-openai-state" data-status="connected">{t("codingAgent.openaiViaChatgpt")}</span>;
    return <span className="text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-openai-state" data-status="disconnected">{t("codingAgent.openaiOff")}</span>;
  };

  return (
    <div className={CARD} data-testid="coding-agent-openai-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">key</span>
          <span className="text-xs text-[var(--text-secondary)]">{t("codingAgent.openaiTitle")}</span>
          {stateLine()}
        </div>
        {read && state?.hasKey && (
          <button
            type="button"
            onClick={() => { if (confirm === "remove") { disarm(); void removeWhat("key"); } else arm("remove"); }}
            onBlur={disarm}
            disabled={busy !== null}
            data-testid="coding-agent-openai-remove"
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 shrink-0 ${
              confirm === "remove" ? "border-red-400/40 text-red-300 hover:bg-red-400/10" : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
            }`}
          >
            {confirm === "remove" ? t("codingAgent.openaiRemoveConfirm") : t("codingAgent.openaiRemove")}
          </button>
        )}
      </div>

      <p className="mt-2 text-[11px] text-[var(--text-muted)] leading-relaxed">{t("codingAgent.openaiHint")}</p>

      {read && state && !state.codexInstalled && (
        <p className="mt-2 text-[11px] text-amber-400 leading-relaxed" data-testid="coding-agent-openai-no-codex">{t("codingAgent.openaiNoCodex")}</p>
      )}

      <div className="flex items-center gap-2 mt-2.5">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("codingAgent.openaiKeyLabel")}
          placeholder={t("codingAgent.openaiKeyPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          disabled={busy !== null}
          data-testid="coding-agent-openai-key"
          className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null || draft.trim() === ""}
          data-testid="coding-agent-openai-save"
          className={BTN_SECONDARY}
        >
          {busy === "save" ? t("codingAgent.openaiSaving") : t("codingAgent.openaiSave")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2.5">
        {!login && !(read && state?.hasLogin) && (
          <button
            type="button"
            onClick={() => void startLogin()}
            disabled={busy !== null || (read && state?.codexInstalled === false)}
            data-testid="coding-agent-openai-signin"
            className={BTN_SECONDARY}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">login</span>
            {busy === "login" ? t("codingAgent.openaiSigningIn") : t("codingAgent.openaiSignIn")}
          </button>
        )}
        {read && state?.hasLogin && (
          <button
            type="button"
            onClick={() => { if (confirm === "signout") { disarm(); void removeWhat("login"); } else arm("signout"); }}
            onBlur={disarm}
            disabled={busy !== null}
            data-testid="coding-agent-openai-signout"
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
              confirm === "signout" ? "border-red-400/40 text-red-300 hover:bg-red-400/10" : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
            }`}
          >
            {confirm === "signout" ? t("codingAgent.openaiSignOutConfirm") : t("codingAgent.openaiSignOut")}
          </button>
        )}
      </div>

      {login?.verificationUrl && login.userCode && (
        <div className="mt-2.5" data-testid="coding-agent-openai-login">
          <DeviceCodeCard
            code={login.userCode}
            verificationUrl={login.verificationUrl}
            polling
            testId="coding-agent-openai-device"
            actions={(
              <button type="button" onClick={() => void cancelLogin()} data-testid="coding-agent-openai-signin-cancel" className={BTN_SECONDARY}>
                {t("codingAgent.openaiCancel")}
              </button>
            )}
          />
        </div>
      )}

      {/* Both are there: which one a run uses, so removing one is not a surprise. */}
      {read && state?.hasKey && state.hasLogin && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-openai-both-note">{t("codingAgent.openaiBothNote")}</p>
      )}

      {note && <StatusMessage type="info" message={note} />}
      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
