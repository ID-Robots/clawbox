// Keeping a live chat in step with the transcript the box stored (TASK-1372).
//
// The gateway's live `chat` `final` frame is not the message the box stored. It
// often arrives with the agent's attachment stripped — a file the agent sent, a
// generated picture — while the transcript append carries it intact, and
// `chat.history` reads that append back. So a chat does not trust the final
// alone: it asks the gateway to push every append (`sessions.messages.subscribe`,
// answered with one `session.message` event per append), treats each push as a
// signal to re-read the transcript, and refuses to append a live final that only
// repeats a bubble the re-read has already painted with its media.
//
// Written once for both chats. The mascot chat (ChatPopup) had learned all of
// it; the full-page chat (ChatApp, `/app/clawbox`) had learned none of it, so a
// file the agent sent there showed its card only after a reload.

import type { ChatMessage } from "@/lib/chat-history-cache";
import { extractText } from "@/lib/harness/openclaw-gateway-adapter";
import { isSentinel, isInterSessionEnvelope } from "@/lib/chat-sentinels";
import { splitEmailRefs } from "@/lib/chat-email-refs";
import {
  boundedAudio,
  boundedFiles,
  extractAudioAttachments,
  extractFileAttachments,
  splitAssistantMedia,
  splitMediaDirectives,
} from "@/lib/chat-media";

/** How long a burst of transcript appends is coalesced into one history read. */
export const TRANSCRIPT_RECONCILE_DELAY_MS = 400;

// ── The live final ───────────────────────────────────────────────────────────

/** A finished reply as the live `final` frame carries it, split into parts. */
export interface LiveReply {
  /** The frame's text as sent — what the envelope check has to be asked of. */
  raw: string;
  /** The caption: `raw` with its `MEDIA:` lines taken out. */
  text: string;
  images: string[];
  audio: string[];
  files: string[];
}

/**
 * Read a live `final` the way both chats store it.
 *
 * A generated picture arrives as a `MEDIA:` line inside the reply text, a
 * spoken reply as a structured attachment part, and any other file the agent
 * sent by either (lib/chat-media.ts). Both shapes are read; neither is
 * guaranteed — and on the live frame, often neither is there at all, which is
 * what the rest of this module is for.
 */
export function readLiveReply(msg: unknown): LiveReply {
  const raw = extractText(msg);
  const { text, images: directiveImages, audio: directiveAudio, files: directiveFiles } = splitAssistantMedia(raw);
  const structured = extractFileAttachments(msg);
  return {
    raw,
    text,
    images: [...new Set([...directiveImages, ...structured.images])],
    audio: boundedAudio(extractAudioAttachments(msg), directiveAudio),
    files: boundedFiles(directiveFiles, structured.files),
  };
}

/** Does this reply carry anything besides its words? */
function hasMedia(reply: Pick<ChatMessage, "images" | "audio" | "files">): boolean {
  return (reply.images?.length ?? 0) > 0 || (reply.audio?.length ?? 0) > 0 || (reply.files?.length ?? 0) > 0;
}

/**
 * A final that is not a reply: empty, a protocol sentinel, or the gateway's
 * delivery-mirror "Sent." ack whose real reply follows by a history refetch.
 *
 * A picture, a clip or a file with no caption IS a reply: asking `!text` alone
 * would throw it away and refetch history instead.
 */
export function isAckOnlyReply(reply: Pick<LiveReply, "text" | "images" | "audio" | "files">): boolean {
  return (!reply.text && !hasMedia(reply)) || /^\s*Sent\.\s*$/.test(reply.text) || isSentinel(reply.text);
}

/**
 * Has the transcript re-read already put this reply on screen, WITH the media
 * the live frame is missing?
 *
 * The re-read often wins the race: `session.message` lands the stored reply,
 * media intact, before the live `final` arrives with the same words and the
 * media stripped. Appending the final then showed the reply twice — once with
 * its card, once without. Only the newest bubble can be that reply, and only a
 * final with no media of its own can be the stripped copy of one that has some.
 */
export function finalAlreadyShownWithMedia(
  latestShown: ChatMessage | undefined,
  reply: Pick<ChatMessage, "text" | "images" | "audio" | "files">,
): boolean {
  return !hasMedia(reply) && reply.text.length > 0
    && latestShown?.role === "assistant" && latestShown.text === reply.text
    && hasMedia(latestShown);
}

/**
 * The transcript with one finished reply added, whatever produced it.
 *
 * Three rules, in order:
 * 1. A text-only copy of the bubble the transcript re-read already painted with
 *    its media is the same reply, and changes nothing (see above).
 * 2. The spoken half of a reply arrives as a SECOND message repeating the text
 *    of the one already rendered. Appending it verbatim showed the answer
 *    twice, once silent and once playable, so its audio is folded into the
 *    bubble it belongs to when the text matches.
 * 3. Anything else is a new bubble.
 *
 * Returns `previous` itself when nothing changes, so a React updater bails out.
 */
export function withAssistantReply(previous: ChatMessage[], reply: ChatMessage): ChatMessage[] {
  const last = previous[previous.length - 1];
  if (finalAlreadyShownWithMedia(last, reply)) return previous;
  const audio = reply.audio ?? [];
  if (reply.text.length > 0 && audio.length > 0 && !(reply.images?.length) && !(reply.files?.length)
      && last && last.role === "assistant" && last.text === reply.text) {
    const merged = boundedAudio(last.audio ?? [], audio);
    if (last.audio?.length === merged.length && last.audio.every((src, i) => src === merged[i])) return previous;
    return [...previous.slice(0, -1), { ...last, audio: merged }];
  }
  return [...previous, reply];
}

// ── The pushed append ────────────────────────────────────────────────────────

/**
 * The message a `session.message` push carries, when the push is for the
 * conversation bound to `boundKey`; null when it belongs to another one. A push
 * that names no session is taken as this chat's, as it always was.
 */
export function sessionMessagePush(payload: unknown, boundKey: string): { message: unknown } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const key = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
  if (key && key !== boundKey) return null;
  return { message: record.message };
}

/** A gateway message's own timestamp, when it carries a usable one. */
export function finiteMessageTimestamp(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

/** The spoken supplement a pushed assistant message carries. */
export interface PushedSpokenReply {
  /** The caption it repeats, with its `MEDIA:` and `EMAIL:` lines taken out. */
  text: string;
  audio: string[];
  timestamp: number | null;
}

/**
 * The spoken reply in a pushed message, or null when it carries none.
 *
 * Older gateways push the TTS supplement intact on `session.message` but omit
 * it from `chat.history`, so it is rendered from the push the moment it lands;
 * the on-box spoken-history route restores the same clip after a reload.
 */
export function pushedSpokenReply(message: unknown): PushedSpokenReply | null {
  const role = message && typeof message === "object"
    ? String((message as Record<string, unknown>).role ?? "").toLowerCase()
    : "";
  if (role !== "assistant") return null;
  const audio = boundedAudio(extractAudioAttachments(message));
  if (audio.length === 0) return null;
  const raw = extractText(message);
  if (isSentinel(raw) || isInterSessionEnvelope(raw, message)) return null;
  return { text: splitEmailRefs(splitMediaDirectives(raw).text).text, audio, timestamp: finiteMessageTimestamp(message) };
}

/**
 * The transcript with a pushed spoken reply given to the bubble it belongs to.
 *
 * Only a bubble after the latest user turn can own the push. Otherwise a late
 * supplement from the previous turn could be put on a new identical "Sure.";
 * when the target is ambiguous, the transcript re-read the push also schedules
 * is the sole authority. Returns `previous` itself when nothing changes.
 */
export function withPushedSpokenReply(previous: ChatMessage[], pushed: PushedSpokenReply): ChatMessage[] {
  let latestUser = -1;
  for (let i = previous.length - 1; i >= 0; i--) {
    if (previous[i].role === "user") { latestUser = i; break; }
  }
  for (let i = previous.length - 1; pushed.text && i > latestUser; i--) {
    const candidate = previous[i];
    // The STORED text still carries its `EMAIL:` lines — they are lifted at
    // render, not at write — and a caption can carry a `MEDIA:` line too, while
    // the pushed text has had them taken out. Compare like with like, or a turn
    // that named messages never matches its own spoken supplement and the
    // audio is dropped.
    if (candidate.role !== "assistant") continue;
    if (splitEmailRefs(splitMediaDirectives(candidate.text).text).text !== pushed.text) continue;
    if (candidate.audio?.length) return previous; // duplicate push
    const next = [...previous];
    next[i] = { ...candidate, audio: pushed.audio };
    return next;
  }
  // A genuinely audio-only reply has no caption to wait for.
  if (!pushed.text) {
    return [...previous, {
      role: "assistant" as const,
      text: "",
      timestamp: pushed.timestamp ?? Date.now(),
      audio: pushed.audio,
    }];
  }
  return previous;
}

/** The timer a chat keeps for its coalesced transcript re-read. */
export type ReconcileTimer = { current: ReturnType<typeof setTimeout> | null };

/**
 * Re-read the transcript once the burst an agent turn produces has settled.
 *
 * A pushed message is a SIGNAL, not something to merge: rather than splice it
 * into the list (and dedupe it against the one the `chat` stream may also
 * deliver), the chat re-reads history — the same reconcile a manual reload
 * used to be doing by hand. Each push restarts the wait, so a turn's appends
 * cost one read.
 */
export function scheduleTranscriptReconcile(
  timer: ReconcileTimer,
  run: () => void,
  delayMs: number = TRANSCRIPT_RECONCILE_DELAY_MS,
): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    timer.current = null;
    run();
  }, delayMs);
}

/** Call off a re-read still waiting — the chat is going away or switching. */
export function cancelTranscriptReconcile(timer: ReconcileTimer): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

// ── Merging a history read into what is on screen ─────────────────────────────

// A reconcile usually returns a transcript identical to the one on screen.
// Handing React a fresh array anyway re-renders the whole list and re-fires the
// auto-scroll, which would yank a user who had scrolled up back to the bottom.
export function sameTranscript(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.role !== y.role || x.text !== y.text || x.timestamp !== y.timestamp) return false;
    if ((x.images?.length ?? 0) !== (y.images?.length ?? 0)) return false;
    // Without this a reply that gained its spoken half between two history
    // reads compares equal, React skips the render, and the player never
    // appears until something else forces one. Compared by URL and not only by
    // count: a reply whose recording was replaced keeps the count and changes
    // the file, and a player left pointing at the old one plays the wrong
    // words convincingly.
    const xa = x.audio ?? [], ya = y.audio ?? [];
    if (xa.length !== ya.length) return false;
    for (let j = 0; j < xa.length; j++) if (xa[j] !== ya[j]) return false;
    // Same rule as the audio above, for the same reason: a reply that gained
    // the model that served it between two reads must repaint, or the label
    // never appears. Declared here because this comparator is where a
    // late-arriving per-message field has to be named to survive a reconcile.
    if (x.model !== y.model || x.provider !== y.provider) return false;
    // A reply that gained a file between two reads must repaint its card.
    const xf = x.files ?? [], yf = y.files ?? [];
    if (xf.length !== yf.length) return false;
    for (let j = 0; j < xf.length; j++) if (xf[j] !== yf[j]) return false;
  }
  return true;
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
 * kept only as the fallback for turns without one (other harnesses, older
 * gateways), and cannot be the primary test: an attachment turn displays
 * "📎 pic.png\nwhat is this" locally while the gateway stores the prompt alone.
 */
export function unechoedUserTurns(
  previous: ChatMessage[],
  restored: ChatMessage[],
  lastServerTs: number,
): ChatMessage[] {
  const serverRunIds = new Set<string>();
  // Per-text stock of server copies. Counting rather than a boolean so the
  // same words sent twice keep the second bubble.
  const unclaimed = new Map<string, number>();
  for (const message of restored) {
    if (message.role !== "user") continue;
    const runId = runIdOf(message.idempotencyKey);
    if (runId) serverRunIds.add(runId);
    unclaimed.set(message.text, (unclaimed.get(message.text) ?? 0) + 1);
  }
  const claimText = (text: string): boolean => {
    const left = unclaimed.get(text) ?? 0;
    if (left <= 0) return false;
    unclaimed.set(text, left - 1);
    return true;
  };
  const pending: ChatMessage[] = [];
  for (const message of previous) {
    if (message.role !== "user") continue;
    const runId = runIdOf(message.idempotencyKey);
    if (runId && serverRunIds.has(runId)) {
      // Also spend this text's stock, so a later identical turn is not matched
      // against the copy this one already accounted for.
      claimText(message.text);
      continue;
    }
    if (claimText(message.text)) continue;
    // Nothing on the server matches. Keep it only if it is newer than the whole
    // replay — an older unmatched turn has aged out of the history window and
    // re-appending it would put it back in the wrong place.
    if (message.timestamp > lastServerTs) pending.push(message);
  }
  return pending;
}

// A live TTS supplement can arrive before an older gateway's history
// projection learns about it. Carry players across that short reconcile by
// message occurrence, never by a text->audio map: common replies such as
// "Sure." may appear many times, and one map entry would put the newest
// recording on every identical bubble.
export function preserveSpokenByOccurrence(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const restored = next.map(message => ({ ...message }));
  const used = new Set<number>();
  for (let i = previous.length - 1; i >= 0; i--) {
    const prior = previous[i];
    if (prior.role !== "assistant" || !prior.audio?.length) continue;
    let target = -1;
    if (prior.timestamp > 0) {
      target = restored.findIndex((candidate, index) =>
        !used.has(index) && candidate.role === "assistant"
        && candidate.timestamp === prior.timestamp && candidate.text === prior.text);
      if (target !== -1) {
        // Durable transcript recovery may already have filled this exact
        // occurrence. Treat that as the match even though there is nothing to
        // copy; falling through would clone the same recording onto a later
        // identical reply.
        if (!restored[target].audio?.length) {
          restored[target] = { ...restored[target], audio: boundedAudio(prior.audio) };
        }
        used.add(target);
        continue;
      }
    }
    for (let j = restored.length - 1; j >= 0; j--) {
      const candidate = restored[j];
      if (prior.text.length > 0 && !used.has(j) && candidate.role === "assistant" && !candidate.audio?.length
          && candidate.text === prior.text) {
        target = j;
        break;
      }
    }
    if (target !== -1) {
      restored[target] = { ...restored[target], audio: boundedAudio(prior.audio) };
      used.add(target);
    }
  }
  return restored;
}

/** Messages longer than this on either side are not aligned for note placement. */
const NOTE_ALIGN_WINDOW = 400;

/**
 * For each message of `a`, the index of the message of `b` it is aligned with,
 * or -1 — the longest order-preserving match of the two key sequences. Order
 * matters: a common "Sure." the window has dropped must not be matched to a
 * later one and drag everything after it out of place.
 */
function alignKeys(a: string[], b: string[]): number[] {
  const n = a.length, m = b.length;
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const matched = new Array<number>(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { matched[i] = j; i++; j++; }
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
    else j++;
  }
  return matched;
}

/**
 * The notes this chat wrote into the conversation itself, carried across a
 * history read that cannot contain them.
 *
 * A failed turn's sentence, "another model answered this", a queued send that
 * could not be delivered: the gateway's transcript has no such rows, so every
 * re-read used to drop them — harmless while a re-read meant a reload, not once
 * every turn ends in one. A note stays right after the message it followed,
 * found in the new list by role and text in order; failing that, right before
 * the message that followed it; failing both — it followed only what the box
 * has not stored yet — at the end, where it already was.
 */
export function carryLocalNotes(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (!previous.some((m) => m.role === "system")) return next;
  // A harness that stores notes of its own is not handed a second copy.
  const stored = new Map<string, number>();
  for (const m of next) if (m.role === "system") stored.set(m.text, (stored.get(m.text) ?? 0) + 1);

  const key = (m: ChatMessage) => `${m.role}\u0000${m.text}`;
  const prevIdx: number[] = [];
  previous.forEach((m, i) => { if (m.role !== "system") prevIdx.push(i); });
  const nextIdx: number[] = [];
  next.forEach((m, j) => { if (m.role !== "system") nextIdx.push(j); });
  // Newest first is what matters, so a very long transcript aligns its tail.
  const prevTail = prevIdx.slice(-NOTE_ALIGN_WINDOW);
  const nextTail = nextIdx.slice(-NOTE_ALIGN_WINDOW);
  const aligned = alignKeys(prevTail.map((i) => key(previous[i])), nextTail.map((j) => key(next[j])));
  const matchOf = new Map<number, number>();
  prevTail.forEach((i, t) => { if (aligned[t] !== -1) matchOf.set(i, nextTail[aligned[t]]); });

  // Notes to insert AFTER a given index of `next` (-1: before everything), in
  // the order they appeared.
  const after = new Map<number, ChatMessage[]>();
  const atEnd: ChatMessage[] = [];
  for (let i = 0; i < previous.length; i++) {
    const note = previous[i];
    if (note.role !== "system") continue;
    const left = stored.get(note.text) ?? 0;
    if (left > 0) { stored.set(note.text, left - 1); continue; }
    let predecessor = -1;
    for (let p = i - 1; p >= 0; p--) if (previous[p].role !== "system") { predecessor = p; break; }
    let slot: number | null = null;
    if (predecessor !== -1 && matchOf.has(predecessor)) {
      slot = matchOf.get(predecessor)!;
      // After any note the harness stored there itself, which came first.
      while (slot + 1 < next.length && next[slot + 1].role === "system") slot++;
    } else {
      for (let s = i + 1; s < previous.length; s++) {
        if (previous[s].role === "system" || !matchOf.has(s)) continue;
        slot = matchOf.get(s)! - 1;
        break;
      }
    }
    if (slot === null) atEnd.push(note);
    else {
      const list = after.get(slot);
      if (list) list.push(note); else after.set(slot, [note]);
    }
  }
  const merged: ChatMessage[] = [...(after.get(-1) ?? [])];
  next.forEach((m, j) => {
    merged.push(m);
    const notes = after.get(j);
    if (notes) merged.push(...notes);
  });
  merged.push(...atEnd);
  return merged;
}

/**
 * The transcript after a history read: the server's list, with the turns it has
 * not echoed yet kept at the end and live spoken replies carried over.
 *
 * `keepLocalNotes` also carries the chat's own notes (see `carryLocalNotes`) —
 * the full-page chat's choice. The mascot chat clears and repaints its notes on
 * its own schedule and does not ask for it.
 *
 * Returns `previous` itself when the read changed nothing, so React skips the
 * render.
 */
export function mergeRestoredTranscript(
  previous: ChatMessage[],
  fromServer: ChatMessage[],
  opts?: { keepLocalNotes?: boolean },
): ChatMessage[] {
  if (previous.length === 0) return fromServer;
  // Carry an event that beat the disk/history read across this one
  // reconcile. One-to-one occurrence matching is essential here: a map
  // keyed by text put the newest recording on every historical "Sure.".
  const restored = preserveSpokenByOccurrence(previous, fromServer);
  const lastServerTs = restored.length > 0 ? restored[restored.length - 1].timestamp : 0;
  const inFlight = unechoedUserTurns(previous, restored, lastServerTs);
  const withTurns = inFlight.length === 0 ? restored : [...restored, ...inFlight];
  const next = opts?.keepLocalNotes ? carryLocalNotes(previous, withTurns) : withTurns;
  return sameTranscript(previous, next) ? previous : next;
}
