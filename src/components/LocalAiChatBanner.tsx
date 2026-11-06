"use client";

import { useCallback, useSyncExternalStore } from "react";
import { HERMES_LOCAL_REASONING_PROVIDER } from "@/lib/hermes-reasoning";
import { localModelsEn } from "@/lib/edition-translations/en-local-models";
import { useTr } from "@/lib/i18n-floor";

/**
 * The note at the top of the chat while it runs on Local AI — a model on this
 * box itself (llama.cpp or Ollama), not a cloud provider: "Running on this
 * box. The first reply can take up to a minute while the local model loads.
 * After that it's faster."
 *
 * A local model is read into memory on the first reply after it was idle, and
 * on a Jetson that can take most of a minute. Without the note, an owner who
 * just switched to Local AI saw a status line counting up from nothing and
 * reasonably took the chat for broken.
 *
 * Closed once, gone for good in this browser: the dismissal is kept in
 * localStorage, and in memory as well, so a browser that refuses storage
 * still loses the note for the rest of the page's life.
 */
export const LOCAL_AI_BANNER_DISMISSED_KEY = "clawbox:chat:localAiBannerDismissed";

let dismissedInMemory = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Closed in another tab of this browser: gone here too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return window.localStorage?.getItem(LOCAL_AI_BANNER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** On the server nothing has been read yet: draw no note rather than flash one. */
function readDismissedOnServer(): boolean {
  return true;
}

/** Has the owner closed the note? And the way to close it. */
export function useLocalAiBannerDismissed(): [dismissed: boolean, dismiss: () => void] {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, readDismissedOnServer);
  const dismiss = useCallback(() => {
    dismissedInMemory = true;
    try {
      window.localStorage?.setItem(LOCAL_AI_BANNER_DISMISSED_KEY, "1");
    } catch {
      /* localStorage unavailable: the in-memory flag holds it for this page */
    }
    for (const listener of listeners) listener();
  }, []);
  return [dismissed, dismiss];
}

/** Test-only: forget an in-memory dismissal. */
export function _resetLocalAiBannerForTest(): void {
  dismissedInMemory = false;
}

/**
 * Is the chat on Local AI? OpenClaw names it by the active model's source
 * (`llamacpp/…` and `ollama/…` are "local" in /setup-api/chat/model); Hermes
 * by the provider the header has picked, the box's own `clawlocal`.
 */
export function chatOnLocalAi(
  harness: string | null | undefined,
  hermesProvider: string | null | undefined,
  activeSource: string | null | undefined,
): boolean {
  return harness === "hermes" ? hermesProvider === HERMES_LOCAL_REASONING_PROVIDER : activeSource === "local";
}

/**
 * The status line's words while a Local AI turn waits for its first token,
 * with the English as the floor: a chat mounted with no catalogue above it
 * must not show the raw key.
 */
export function useLocalAiLoadingLabel(): string {
  const tr = useTr();
  return tr("localModels.chatLoading", localModelsEn["localModels.chatLoading"]);
}

interface LocalAiChatBannerProps {
  onDismiss: () => void;
}

export default function LocalAiChatBanner({ onDismiss }: LocalAiChatBannerProps) {
  const tr = useTr();
  const t = (key: string) => tr(key, localModelsEn[key]);
  return (
    <div
      role="note"
      data-testid="chat-local-ai-banner"
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        margin: "10px 14px 0", padding: "9px 8px 9px 12px",
        borderRadius: 10, flexShrink: 0,
        background: "rgba(59,130,246,0.08)",
        border: "1px solid rgba(96,165,250,0.28)",
        fontSize: 12.5, lineHeight: 1.45,
      }}
    >
      <span
        className="material-symbols-rounded"
        aria-hidden="true"
        style={{ fontSize: 17, color: "rgba(191,219,254,0.85)", marginTop: 1, flexShrink: 0 }}
      >
        computer
      </span>
      <p style={{ margin: 0, flex: 1, minWidth: 0, color: "rgba(255,255,255,0.72)" }}>
        <strong style={{ color: "#fff", fontWeight: 600 }}>{t("localModels.chatBannerTitle")}</strong>{" "}
        {t("localModels.chatBannerBody")}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("localModels.chatBannerDismiss")}
        data-testid="chat-local-ai-banner-dismiss"
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 2, borderRadius: 6,
          color: "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 17 }}>close</span>
      </button>
    </div>
  );
}
