/**
 * The message a gateway `chat` delta frame stands for (TASK-2228).
 *
 * The gateway (OpenClaw 2026.10.x, protocol 4) sends a run's live text as a
 * snapshot only until it knows this socket has a baseline: the first frame
 * carries `message` (the whole text so far) and `deltaText`, every later one
 * just `deltaText`, the characters added since. A frame that replaces the text
 * says `replace: true`, and a client that missed a frame gets a snapshot
 * again. The chats used to read `message` alone, so a streamed answer showed
 * its first few characters and then nothing until `final` — invisible only
 * while the core sent the whole answer in one frame.
 *
 * `mergeChatStreamMessage` is the rule the gateway's own client applies
 * (packages/gateway-client/src/chat-stream-message.ts in OpenClaw).
 */

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTextBlock(block: unknown): block is MessageRecord {
  return isRecord(block) && block.type === "text";
}

/** A snapshot includes its delta; append-only frames require an existing baseline. */
export function mergeChatStreamMessage(previous: unknown, payload: MessageRecord): unknown {
  if (payload.message !== undefined) return payload.message;
  const delta = payload.deltaText;
  if (typeof delta !== "string") return previous;
  const replace = payload.replace === true;
  if (!delta && !replace) return previous;
  if (!isRecord(previous) && !replace) return undefined;
  const message: MessageRecord = isRecord(previous) ? previous : { role: "assistant" };
  if (typeof message.content === "string") {
    return { ...message, content: replace ? delta : message.content + delta };
  }
  const content = Array.isArray(message.content) ? [...message.content] : [];
  if (replace) {
    return { ...message, content: [{ type: "text", text: delta }, ...content.filter((block) => !isTextBlock(block))] };
  }
  const index = content.findLastIndex(isTextBlock);
  const block = content[index];
  if (isTextBlock(block)) {
    content[index] = { ...block, text: `${typeof block.text === "string" ? block.text : ""}${delta}` };
  } else {
    content.push({ type: "text", text: delta });
  }
  return { ...message, content };
}

/** Runs whose live message a chat keeps at once: the newest few. */
const MAX_LIVE_RUNS = 8;

/** The live message of each run a chat is following, newest last; one per chat surface. */
export interface ChatStreamCursor {
  runs: Map<string | null, unknown>;
}

export function createChatStreamCursor(): ChatStreamCursor {
  return { runs: new Map() };
}

/**
 * Fold one delta frame into its run's live message and return the message it
 * now stands for. Each run keeps its own: an append-only frame of a run whose
 * start this chat never saw reads as no text until that run's next snapshot,
 * never as the tail of a different answer.
 */
export function advanceChatStream(cursor: ChatStreamCursor, payload: MessageRecord): unknown {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const message = mergeChatStreamMessage(cursor.runs.get(runId), payload);
  cursor.runs.delete(runId);
  if (message !== undefined) cursor.runs.set(runId, message);
  for (const oldest of cursor.runs.keys()) {
    if (cursor.runs.size <= MAX_LIVE_RUNS) break;
    cursor.runs.delete(oldest);
  }
  return message;
}
