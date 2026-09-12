"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import { BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";

/**
 * Settings → Coding Agent: the owner's OWN Anthropic account, beside the
 * GitHub card and built the same way — its own route, its own read, its own
 * refusal slot, so a failure here never takes the settings above it down.
 *
 * TWO WAYS IN AND ONLY ONE OF THEM IS OURS. A `claude` login the owner made
 * in the Terminal app is reported and never touched: this card can neither
 * create it nor remove it, and says so rather than showing a Disconnect that
 * would not do what it says. The API key IS ours to hold, so it has Save and
 * Remove — and the field is emptied the instant the save lands, because a
 * credential left sitting in an input is a credential in the DOM of every tab
 * that page is open in.
 *
 * The key is never read BACK. The route answers whether one is stored, never
 * the value and never a masked form of it, so there is nothing here to
 * pre-fill and nothing for a screenshot to leak.
 */

export interface AnthropicState {
  connected: boolean;
  hasKey: boolean;
  hasLogin: boolean;
  source: "key" | "login" | null;
  models?: string[];
  defaultModel?: string | null;
  /** POST only: did Anthropic confirm the key, or could the box not ask? */
  verified?: boolean;
}

/** How long the two-tap Remove stays armed — the panel's own CONFIRM_MS. */
const CONFIRM_MS = 5_000;

export default function CodingAgentAnthropicCard({ onChanged }: {
  /** Fired after a save or a removal, so the panel re-reads readiness: this
   *  card is what decides whether an `anthropic` run may start at all. */
  onChanged?: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<AnthropicState | null>(null);
  /** True once a read has ACTUALLY answered. `state === null` cannot stand in
   *  for it: that is also what the card holds before the first read, and
   *  before this the render path drew "not connected" over a request that had
   *  simply failed — a false statement about the owner's account. */
  const [read, setRead] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const disarm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmRemove(false);
  }, []);
  const arm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => {
      confirmTimer.current = null;
      setConfirmRemove(false);
    }, CONFIRM_MS);
    setConfirmRemove(true);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/coding-agent/anthropic", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json() as AnthropicState);
      setRead(true);
    } catch {
      // Not new information about the account: the card keeps what it last
      // knew rather than claiming the owner has been disconnected — and while
      // it has never known anything, it says nothing at all.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** The route's own sentence when it sent one — it names the actual refusal. */
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
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/setup-api/coding-agent/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.anthropicSaveFailed")));
      const next = await res.json() as AnthropicState;
      setState(next);
      setRead(true);
      // Out of the DOM the moment it has landed.
      setDraft("");
      // Said only when the check did NOT happen: claiming "saved" is the
      // normal outcome, claiming "checked" when the box was offline is a lie.
      setNote(next.verified === false ? t("codingAgent.anthropicSavedUnchecked") : null);
      onChangedRef.current?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.anthropicSaveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/setup-api/coding-agent/anthropic", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.anthropicRemoveFailed")));
      setState(await res.json() as AnthropicState);
      setRead(true);
      onChangedRef.current?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.anthropicRemoveFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={CARD} data-testid="coding-agent-anthropic-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">key</span>
          <span className="text-xs text-[var(--text-secondary)]">{t("codingAgent.anthropicTitle")}</span>
          {!read ? (
            // Nothing is known yet — the first read is in flight, or it
            // failed. Either way "not connected" would be a claim about the
            // owner's account that this card is in no position to make.
            <span className="text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-anthropic-state">
              {t("codingAgent.anthropicUnknown")}
            </span>
          ) : state?.source === "key" ? (
            <span className="text-[11px] text-emerald-400" data-testid="coding-agent-anthropic-state">
              {t("codingAgent.anthropicViaKey")}
            </span>
          ) : state?.source === "login" ? (
            <span className="text-[11px] text-emerald-400" data-testid="coding-agent-anthropic-state">
              {t("codingAgent.anthropicViaLogin")}
            </span>
          ) : (
            <span className="text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-anthropic-state">
              {t("codingAgent.anthropicOff")}
            </span>
          )}
        </div>
        {/* Only for the key — a login this card did not make is not this
            card's to end. */}
        {read && state?.hasKey && (
          <button
            type="button"
            onClick={() => { if (confirmRemove) { disarm(); void remove(); } else arm(); }}
            onBlur={disarm}
            disabled={busy !== null}
            data-testid="coding-agent-anthropic-remove"
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 shrink-0 ${
              confirmRemove
                ? "border-red-400/40 text-red-300 hover:bg-red-400/10"
                : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
            }`}
          >
            {confirmRemove ? t("codingAgent.anthropicRemoveConfirm") : t("codingAgent.anthropicRemove")}
          </button>
        )}
      </div>

      <p className="mt-2 text-[11px] text-[var(--text-muted)] leading-relaxed">
        {t("codingAgent.anthropicHint")}
      </p>

      <div className="flex items-center gap-2 mt-2.5">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("codingAgent.anthropicKeyLabel")}
          placeholder={t("codingAgent.anthropicKeyPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          disabled={busy !== null}
          data-testid="coding-agent-anthropic-key"
          className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null || draft.trim() === ""}
          data-testid="coding-agent-anthropic-save"
          className={BTN_SECONDARY}
        >
          {busy === "save" ? t("codingAgent.anthropicSaving") : t("codingAgent.anthropicSave")}
        </button>
      </div>

      {/* The login the owner made themselves, when there is no key: said so
          they know where the access is coming from, and that removing a key
          here would not have ended it. */}
      {read && state?.hasLogin && !state.hasKey && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-anthropic-login-note">
          {t("codingAgent.anthropicLoginNote")}
        </p>
      )}

      {note && <StatusMessage type="info" message={note} />}
      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
