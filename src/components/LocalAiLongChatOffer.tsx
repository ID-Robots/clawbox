"use client";

import { localModelsEn } from "@/lib/edition-translations/en-local-models";
import { useTr } from "@/lib/i18n-floor";
import { LOCAL_COMPACTION_DEADLINE_MS, shortTokenCount } from "@/lib/chat-local-fit";

/**
 * The choice a long conversation gets when its chat is on Local AI (TASK-2127):
 * "This conversation is too long for the local model" — start a new chat with
 * Local AI (recommended: one click, and a message the owner already sent goes
 * with it) or shorten this one first.
 *
 * Without it, switching a ~100k-token chat to Gemma and asking one line meant
 * minutes of OpenClaw summarizing the history with the 2B model while the
 * status line said the model was loading. Two shapes:
 *  - `fit`: the conversation is larger than the local model's window — both
 *    choices, and the × to carry on as it is;
 *  - `timeout`: a local turn or a "shorten first" was still summarizing after
 *    LOCAL_COMPACTION_DEADLINE_MS and was stopped — the new chat alone.
 */
export interface LocalAiLongChatOfferProps {
  kind: "fit" | "timeout" | "failed";
  /** The conversation's size and the local window, for the `fit` sentence. */
  tokens?: number | null;
  window?: number | null;
  /** The message the owner sent, waiting for the choice. */
  pendingText?: string | null;
  /** A shorten is running: its button is spent. */
  shortening?: boolean;
  onNewChat: () => void;
  onShorten?: () => void;
  onDismiss: () => void;
}

/** The waiting message as the card quotes it: one line, at most 120 characters. */
function quoted(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export default function LocalAiLongChatOffer({
  kind, tokens, window, pendingText, shortening, onNewChat, onShorten, onDismiss,
}: LocalAiLongChatOfferProps) {
  const tr = useTr();
  const t = (key: string, params?: Record<string, string | number>) => tr(key, localModelsEn[key], params);
  const title = kind === "timeout"
    ? t("localModels.longChat.timeoutTitle", { seconds: Math.round(LOCAL_COMPACTION_DEADLINE_MS / 1000) })
    : t("localModels.longChat.title");
  const body = kind === "timeout"
    ? t("localModels.longChat.timeoutBody")
    : kind === "failed"
      ? t("localModels.longChat.failed")
      : t("localModels.longChat.body", {
        tokens: shortTokenCount(tokens ?? 0),
        window: shortTokenCount(window ?? 0),
      });
  return (
    <div
      role="alert"
      data-testid="chat-local-ai-long-chat"
      data-kind={kind}
      style={{
        margin: "8px 0", padding: "12px 14px", borderRadius: 10,
        background: "rgba(59,130,246,0.08)", border: "1px solid rgba(96,165,250,0.3)",
        display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "rgba(255,255,255,0.85)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span
          className="material-symbols-rounded"
          aria-hidden="true"
          style={{ fontSize: 18, color: "rgba(191,219,254,0.9)", marginTop: 1, flexShrink: 0 }}
        >
          {kind === "fit" ? "history" : "timer_off"}
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <strong style={{ color: "#fff", fontWeight: 600 }}>{title}</strong>
          <span style={{ color: "rgba(255,255,255,0.72)", lineHeight: 1.45 }}>{body}</span>
          {pendingText && (
            <span data-testid="chat-local-ai-long-chat-pending" style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>
              <q style={{ fontStyle: "italic", color: "rgba(255,255,255,0.75)" }}>{quoted(pendingText)}</q>{" "}
              {t("localModels.longChat.pending")}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("localModels.chatBannerDismiss")}
          data-testid="chat-local-ai-long-chat-dismiss"
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 2, borderRadius: 6,
            color: "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 17 }}>close</span>
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          onClick={onNewChat}
          data-testid="chat-local-ai-long-chat-new"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: "#3b82f6", color: "#fff", fontSize: 12.5, fontWeight: 600,
          }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>add_comment</span>
          {t("localModels.longChat.newChat")}
          <span
            style={{
              marginLeft: 2, padding: "1px 6px", borderRadius: 999, fontSize: 10.5, fontWeight: 600,
              background: "rgba(255,255,255,0.22)",
            }}
          >
            {t("localModels.longChat.recommended")}
          </span>
        </button>
        {kind === "fit" && onShorten && (
          <button
            type="button"
            onClick={onShorten}
            disabled={shortening}
            data-testid="chat-local-ai-long-chat-shorten"
            style={{
              padding: "6px 12px", borderRadius: 8, cursor: shortening ? "default" : "pointer",
              background: "transparent", border: "1px solid rgba(255,255,255,0.25)",
              color: shortening ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.85)", fontSize: 12.5,
            }}
          >
            {t("localModels.longChat.shorten")}
          </button>
        )}
      </div>
    </div>
  );
}
