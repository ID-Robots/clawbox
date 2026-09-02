// Chat-message types + uuid helper. Gateway is canonical for history.

/**
 * One tool the agent used during a turn, as the finished record keeps it.
 *
 * Distinct from `ChatToolCall` in `chat-tool-events` on purpose: that one is a
 * LIVE pill with a phase and a clock, driven by the gateway's event stream and
 * thrown away when the turn ends. This one is what survives into the transcript
 * — a step that already happened, replayed identically after a refresh.
 */
export interface ChatToolSummary {
  name: string;
  detail?: string;
  status?: "ok" | "error";
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  // The model's internal monologue, kept OUT of `text` and rendered as a
  // collapsed disclosure under the answer. Absent on a turn that had none, and
  // on every message stored before the field existed.
  reasoning?: string;
  // The steps the agent took to answer, in call order.
  toolCalls?: ChatToolSummary[];
  // Inline display only: data URLs for images the user attached, or
  // /setup-api/chat/media URLs for ones the agent generated.
  images?: string[];
  // /setup-api/chat/media URLs for spoken replies, rendered as players. Kept
  // separate from `images` rather than a single `media` list: the two are
  // different elements with different affordances, and merging them would make
  // every existing `images.length` check quietly wrong.
  audio?: string[];
  // The run this turn belongs to. Set locally when the turn is sent and read
  // back off the gateway's own record, so a turn can be recognised as "the one
  // already on the server" without comparing text or clocks. The gateway
  // suffixes its copy by role (`<runId>:user`); `runIdOf` normalises that.
  idempotencyKey?: string;
  // Which model produced this reply, and the provider behind it — what
  // answered, not what was asked for. Recorded per turn by the Hermes route.
  model?: string;
  provider?: string;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // randomUUID is SECURE-CONTEXT-ONLY, and ClawBox pages live on plain-HTTP
  // LAN origins — so this branch is the one every real box runs. It used to
  // be Math.random, which was tolerable for idempotency keys and became
  // untenable the moment these ids started naming gateway sessions
  // (CodeQL js/insecure-randomness on PR #565). getRandomValues has no
  // secure-context gate anywhere ClawBox renders: RFC 4122 v4 from 16
  // crypto-strength bytes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
