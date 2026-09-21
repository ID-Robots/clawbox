"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  isRunMessageRefusal,
  MAX_QUEUED_RUN_MESSAGES,
  MAX_RUN_MESSAGE_CHARS,
  RUN_MESSAGE_REFUSAL_KEYS,
  type RunMessage,
} from "@/lib/coding-run-messages";
import { BTN_PRIMARY, INSET_SURFACE } from "./coding-agent-ui";

/**
 * "Tell the agent…" — the one place a run that is still going can be steered.
 *
 * A delegated run is headless: it cannot ask a question, and until now nothing
 * could tell it anything either. The owner who saw a run heading the wrong way
 * had exactly two gestures, Stop and Pause, and both threw the turn away.
 *
 * What the box can honestly promise depends on the harness, so the card says
 * which happened rather than a flat "sent": a message the harness took in its
 * current session is DELIVERED, and one waiting for the run's next attempt or
 * the owner's Resume is QUEUED. Two words for two facts, because "sent" over a
 * message the run has not seen is the claim that would cost the owner the
 * twenty minutes this card exists to save.
 *
 * Its own component rather than more of CodingAgentApp for the reason
 * CodingRunDenials is: it WRITES, it has a state machine worth testing on its
 * own, and it is the second thing on the run page a person types into.
 */
export default function CodingRunMessageBox({
  runId,
  messages,
  onSent,
}: {
  runId: string;
  /** The queue as the run record carries it; absent on a server that predates it. */
  messages?: RunMessage[];
  /** A message reached the box. The host refreshes the run so the list follows. */
  onSent?: () => void;
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = messages ?? [];
  const waiting = rows.filter((m) => m.deliveredAt === null).length;
  const full = waiting >= MAX_QUEUED_RUN_MESSAGES;

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, text: body }),
      });
      if (!res.ok) {
        // The route answers a stable `code` beside its English sentence.
        // Prefer the code: it is worded in the owner's language here, and the
        // sentence is the server's. A code this build does not know falls back
        // to that sentence rather than to nothing.
        const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
        throw new Error(
          isRunMessageRefusal(data?.code)
            ? t(RUN_MESSAGE_REFUSAL_KEYS[data.code], { max: MAX_RUN_MESSAGE_CHARS, n: MAX_QUEUED_RUN_MESSAGES })
            : (data?.error || t("codingAgent.message.failed")),
        );
      }
      // Cleared only once the box has it: a textarea emptied over a refusal
      // would lose what the owner typed.
      setText("");
      onSent?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.message.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mt-3 ${INSET_SURFACE} px-4 py-3`} data-testid="coding-agent-run-message">
      <p className="text-[11px] font-medium text-[var(--text-secondary)]">{t("codingAgent.message.title")}</p>
      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.message.hint")}</p>
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="coding-agent-run-message-list">
          {rows.map((message, i) => (
            <li
              key={`${message.at}-${i}`}
              className="flex items-start gap-2 text-[11px] text-[var(--text-secondary)]"
              data-testid="coding-agent-run-message-row"
              data-delivered={message.deliveredAt === null ? "false" : "true"}
            >
              <span
                className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${
                  message.deliveredAt === null
                    ? "text-amber-300 border-amber-400/40"
                    : "text-emerald-300 border-emerald-400/40"
                }`}
              >
                {message.deliveredAt === null ? t("codingAgent.message.queued") : t("codingAgent.message.delivered")}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{message.text}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a new line — the New App card's rule,
          // and an IME composition is left alone so a Japanese or Chinese
          // desktop does not send on the key that accepts a candidate.
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void send();
        }}
        maxLength={MAX_RUN_MESSAGE_CHARS}
        rows={2}
        disabled={busy || full}
        placeholder={t("codingAgent.message.placeholder")}
        aria-label={t("codingAgent.message.title")}
        data-testid="coding-agent-run-message-input"
        className="mt-2 w-full resize-none rounded-lg bg-black/30 border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--coral-bright)]/50 disabled:opacity-50"
      />
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || full || !text.trim()}
          data-testid="coding-agent-run-message-send"
          className={BTN_PRIMARY}
        >
          {busy ? t("codingAgent.message.sending") : t("codingAgent.message.send")}
        </button>
        {full && (
          <span className="text-[11px] text-amber-300" data-testid="coding-agent-run-message-full">
            {t("codingAgent.message.errorQueueFull", { n: MAX_QUEUED_RUN_MESSAGES })}
          </span>
        )}
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-red-300" role="alert" data-testid="coding-agent-run-message-error">
          {error}
        </p>
      )}
    </div>
  );
}
