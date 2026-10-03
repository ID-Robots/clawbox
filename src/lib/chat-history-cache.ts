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
  // /setup-api/chat/media download URLs (or https URLs) for any other file the
  // agent sent — rendered as download cards with name and size.
  files?: string[];
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

/** The gateway suffixes its stored copy by role; the client holds the bare run id. */
function runIdOf(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.endsWith(":user") ? key.slice(0, -":user".length) : key;
}

/**
 * Which locally-appended user turns the server has NOT echoed back yet.
 *
 * A turn is added to the transcript the moment it is sent, so a history read
 * that lands before the write completes must not erase it. Deciding that by
 * timestamp alone is not possible: the local copy is stamped with the browser's
 * clock and the server's with the device's, and a browser running ahead makes
 * every local copy look newer than everything the server returned.
 *
 * Identity settles it — both sides carry the run's idempotency key. Text is
 * kept only as the fallback for when one side has no key (other harnesses,
 * older gateways), and cannot be the primary test: an attachment turn displays
 * "📎 pic.png\nwhat is this" locally while the gateway stores the prompt alone.
 * Two turns that BOTH carry a key and whose keys differ are different turns,
 * whatever they say: the same "yes" sent from the phone is not this browser's
 * "yes", and matching them by text hid the local one until the next read.
 *
 * What is left unmatched is kept if it can still be in flight. A turn with a
 * key is kept unless it is older than the oldest message the read returned —
 * that one has aged out of the history window, and re-appending it would put
 * it back at the end. It is NOT measured against the newest server message:
 * the local copy carries this browser's clock, and a browser running behind
 * the box would lose a turn it sent a moment ago. A turn with no key has only
 * its timestamp to go on, and keeps the old rule: newer than the whole replay.
 */
export function unechoedUserTurns<T extends ChatMessage>(
  previous: readonly T[],
  restored: readonly T[],
  lastServerTs: number,
): T[] {
  const serverRunIds = new Set<string>();
  const localRunIds = new Set<string>();
  for (const message of restored) {
    const runId = message.role === "user" ? runIdOf(message.idempotencyKey) : undefined;
    if (runId) serverRunIds.add(runId);
  }
  for (const message of previous) {
    const runId = message.role === "user" ? runIdOf(message.idempotencyKey) : undefined;
    if (runId) localRunIds.add(runId);
  }
  // Per-text stock of the server copies no local turn claimed by its key —
  // split by whether the copy has a key of its own. Counting rather than a
  // boolean so the same words sent twice keep the second bubble.
  const keyless = new Map<string, number>();
  const keyed = new Map<string, number>();
  for (const message of restored) {
    if (message.role !== "user") continue;
    const runId = runIdOf(message.idempotencyKey);
    if (runId && localRunIds.has(runId)) continue;
    const stock = runId ? keyed : keyless;
    stock.set(message.text, (stock.get(message.text) ?? 0) + 1);
  }
  const claim = (stock: Map<string, number>, text: string): boolean => {
    const left = stock.get(text) ?? 0;
    if (left <= 0) return false;
    stock.set(text, left - 1);
    return true;
  };
  const windowStart = restored.length > 0 ? restored[0].timestamp : 0;
  const pending: T[] = [];
  for (const message of previous) {
    if (message.role !== "user") continue;
    const runId = runIdOf(message.idempotencyKey);
    if (runId && serverRunIds.has(runId)) continue;
    // By text only where one side has no key to compare.
    if (claim(keyless, message.text)) continue;
    if (!runId && claim(keyed, message.text)) continue;
    if (runId ? message.timestamp >= windowStart : message.timestamp > lastServerTs) pending.push(message);
  }
  return pending;
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
  // Reached through `globalThis`, not `window`: this module is in the import
  // graph of the MCP server, which typechecks under `lib: ["esnext"]` +
  // `types: ["node"]` (mcp/tsconfig.json keeps the DOM out of a stdio process
  // deliberately), so the bare `window` was three of the errors nothing in CI
  // was running the check that would have caught. In a browser `globalThis` IS
  // the window; off one there is simply no localStorage and this is a no-op,
  // which is what the old `typeof window === "undefined"` guard did.
  const globals = globalThis as { localStorage?: { removeItem(key: string): void } };
  for (const key of LEGACY_KEYS) {
    // The ACCESS stays inside the try as well as the call: a browser in private
    // mode can throw on reading `localStorage` itself, not only on using it.
    try { globals.localStorage?.removeItem(key); } catch { /* private mode / quota — silent */ }
  }
}
