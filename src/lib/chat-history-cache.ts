// Chat-message types + uuid helper. Gateway is canonical for history.

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  // Inline display only: data URLs for images the user attached, or
  // /setup-api/chat/media URLs for ones the agent generated.
  images?: string[];
  // /setup-api/chat/media URLs for spoken replies, rendered as players. Kept
  // separate from `images` rather than a single `media` list: the two are
  // different elements with different affordances, and merging them would make
  // every existing `images.length` check quietly wrong.
  audio?: string[];
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Remove stale chat caches written by older builds.
const LEGACY_KEYS = [
  "clawbox-chatpopup-history-v1",
  "clawbox-chat-history-v1",
];

export function purgeLegacyChatCaches(): void {
  if (typeof window === "undefined") return;
  for (const key of LEGACY_KEYS) {
    try { window.localStorage.removeItem(key); } catch { /* private mode / quota — silent */ }
  }
}
