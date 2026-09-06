// The record of an approval question ClawBox has asked the owner in chat.
//
// WHY THIS EXISTS AND WHAT IT IS NOT. A Telegram inline-keyboard button carries
// at most 64 bytes of `callback_data`, and a draft is named by a UUID (36) plus
// a 32-character fingerprint (see email-pending.ts) — which does not fit. So the
// button carries a short HANDLE and this file is the map from that handle back
// to the draft the owner was actually shown.
//
// That is the only job. The handle is NOT a capability and NOT a secret: it
// travels in a callback_data field Telegram echoes back, and it is worthless on
// its own. What authorises an approval is the identity of the person who
// pressed the button, checked against the owner allowlist, in
// email-approval.ts. This store exists so the press can be tied to ONE draft
// with the exact content that was on screen when the question was asked.
//
// ONE PROMPT, TWO NAMES. A question can also be asked in the owner's ORDINARY
// conversation with the box, where there is no button to press and the answer
// is a line he TYPES (email-approval-reply.ts). A 16-character handle is not a
// thing anyone types, so a prompt is also named by a short `code`.
//
// AND THE CODE IS THE ONE THING HERE THAT IS NOT WRITTEN DOWN. Only its SHA-256
// is stored, and `findPromptByCode` hashes what it is given before it looks. The
// handle can be in the clear because it is worthless on its own — it travels in
// a callback_data field Telegram echoes back, and what authorises that tap is
// the identity of the presser. The typed path has the same identity check and
// one difference that matters: everything it needs arrives over HTTP from
// inside this box, so a caller that could READ this file could also make the
// request. Keeping only the hash means the file yields nothing usable, and the
// code exists in the message ClawBox posted and in the owner's head.
//
// This is not a MAC and does not need to be: the input is high-entropy and
// unguessable within the store's own attempt budget, so there is no salt and no
// constant-time compare to get wrong. It is a one-way name, and that is all.
//
// WHY THE FINGERPRINT IS COPIED IN HERE. The prompt freezes what the owner is
// being asked about, exactly as the desktop batch card does (#498). The agent
// keeps running while the owner reads; a draft queued during that pause has a
// different id and is not in any prompt, and a draft whose text somehow changed
// no longer matches the fingerprint recorded here. Approval therefore names a
// draft AND its content, never "whatever is in the queue now".
//
// STORAGE: data/email-approval-prompts.json, 0600 via temp+rename, the same
// discipline email-pending.ts and config-store use. It holds no message text —
// only ids, a fingerprint and chat/message numbers — so agent-composed content
// never lands in a second file.

import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { CHAT_ID_RE } from "@/lib/email-approval-telegram";

const PROMPTS_PATH = path.join(DATA_DIR, "email-approval-prompts.json");

/**
 * How many questions may be outstanding. Deliberately the same number as
 * MAX_PENDING: there can never be more prompts than there are drafts to ask
 * about, and a store that could grow past the queue it describes would be
 * describing something that is not there.
 */
export const MAX_PROMPTS = 20;

/**
 * How long a button stays live.
 *
 * A day, not forever. An inline keyboard sits in the owner's chat history
 * indefinitely, so without an expiry a button scrolled past last month would
 * still send mail the moment someone thumbed it while scrolling. Expiry is
 * enforced on READ, so a prompt that has aged out is already gone by the time
 * anything asks about it.
 */
export const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

/** One outstanding question. */
export interface ApprovalPrompt {
  /** Short opaque key carried in callback_data. Not a credential. */
  handle: string;
  /**
   * SHA-256 of the code the owner was given — never the code.
   *
   * OPTIONAL because a prompt written by an older build has none: it is still
   * answerable with its button, and only unreachable by typing — which is the
   * right way for this to degrade, and better than regenerating a record whose
   * button is already live in somebody's chat.
   */
  codeHash?: string;
  draftId: string;
  /** draftFingerprint() of the draft AT THE MOMENT THE QUESTION WAS ASKED. */
  fingerprint: string;
  /** Where the question was posted, so the outcome can be written back. */
  messages: PromptMessage[];
  /** Epoch ms. */
  createdAt: number;
}

export interface PromptMessage {
  chatId: string;
  messageId: number;
}

/**
 * The whole file. `offset` is Telegram's getUpdates cursor and lives here
 * rather than in its own file because it has exactly one writer — the poller —
 * and that writer is already writing this file.
 *
 * Keeping the cursor OUT of config.json is deliberate: config is read and
 * re-parsed by every settings request, and a value the poller rewrites is
 * churn in a file that holds credentials.
 */
interface PromptStore {
  version: 1;
  /** Next getUpdates offset. 0 means "whatever Telegram has". */
  offset: number;
  prompts: ApprovalPrompt[];
}

const EMPTY: PromptStore = { version: 1, offset: 0, prompts: [] };

/** Shape check for one record read back off disk. Anything else is dropped. */
function isPrompt(value: unknown): value is ApprovalPrompt {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.handle === "string"
    && (v.codeHash === undefined || typeof v.codeHash === "string")
    && typeof v.draftId === "string"
    && typeof v.fingerprint === "string"
    && typeof v.createdAt === "number"
    && Array.isArray(v.messages)
    && v.messages.every(isPromptMessage)
  );
}

/** Shape check for one "where it was posted" entry. */
function isPromptMessage(value: unknown): value is PromptMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.chatId === "string" && typeof v.messageId === "number";
}

/**
 * Read, dropping anything expired or malformed.
 *
 * A corrupt file means "nothing is outstanding", never a throw: an unreadable
 * prompt store must not take email down, and the worst it can cost is a button
 * that answers "that request has expired".
 */
function readStore(now: number): PromptStore {
  try {
    if (!fs.existsSync(PROMPTS_PATH)) return { ...EMPTY };
    const parsed: unknown = JSON.parse(fs.readFileSync(PROMPTS_PATH, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
    const raw = parsed as Record<string, unknown>;
    const offset = typeof raw.offset === "number" && Number.isFinite(raw.offset) ? raw.offset : 0;
    const prompts = Array.isArray(raw.prompts)
      ? raw.prompts.filter(isPrompt).filter((p) => now - p.createdAt < PROMPT_TTL_MS)
      : [];
    return { version: 1, offset, prompts };
  } catch {
    return { ...EMPTY };
  }
}

/** Fresh temp at 0600, then atomic rename — the discipline config-store uses. */
function writeStore(store: PromptStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PROMPTS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break the store
  }
  fs.renameSync(tmp, PROMPTS_PATH);
}

/**
 * The alphabet a code is spelled in, and why it is this one.
 *
 * Upper case, digits, and no `O`/`0`, `I`/`1`, `L` or `U`: the code is read off
 * a phone screen and typed back by hand, and a person who mistypes it is told
 * "that request has already been answered or has expired" about a draft that is
 * sitting right there. `U` is out for the reason Crockford leaves it out.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * How long a code is.
 *
 * Five characters of this alphabet is a little over 24 million — plenty to keep
 * two of at most twenty live questions apart, which is the whole job. It is
 * deliberately NOT sized as a secret: the gate on an approval is the sender id
 * the harness reports, exactly as it is for the button, and a code long enough
 * to be a password would be one nobody types.
 */
const CODE_LEN = 5;

/** A code as it may be written back — the parser upper-cases before it asks. */
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

/** The stored form of a code. See the header: only this ever reaches the disk. */
function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * A code whose hash no live prompt is already using.
 *
 * Rejection sampling over `randomBytes` rather than `% alphabet.length`, which
 * would make the first two characters of the alphabet fractionally likelier —
 * irrelevant to security here, and the kind of thing that gets copied into a
 * file where it is not.
 */
function mintCode(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    while (code.length < CODE_LEN) {
      for (const byte of randomBytes(CODE_LEN * 2)) {
        if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue;
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (code.length === CODE_LEN) break;
      }
    }
    if (!taken.has(hashCode(code))) return code;
  }
  // Twenty collisions against at most twenty live prompts is not a state this
  // reaches; the caller treats a null the way it treats a full store.
  return "";
}

/**
 * The prompt a typed code names, WITHOUT consuming it.
 *
 * Consuming belongs to `claimPrompt`, which the caller reaches through the
 * handle once it has decided the sender may answer at all — so a stranger who
 * guesses a code cannot burn the owner's question, exactly as the button path
 * checks the presser before it claims.
 *
 * The code is hashed before the lookup, so nothing in the store is ever
 * compared against the plain text and nothing here can log it.
 */
export function findPromptByCode(code: string, now = Date.now()): ApprovalPrompt | null {
  const wanted = code.trim().toUpperCase();
  if (!CODE_RE.test(wanted)) return null;
  const hashed = hashCode(wanted);
  return readStore(now).prompts.find((p) => p.codeHash === hashed) ?? null;
}

/**
 * Ask about one draft.
 *
 * Returns null when the store is full rather than evicting: the same reasoning
 * as MAX_PENDING — dropping the oldest would let a burst of queued drafts push
 * an earlier question out of reach, and a question the owner can no longer
 * answer is worse than one that was never asked.
 */
export function createPrompt(
  input: { draftId: string; fingerprint: string; now?: number },
): { prompt: ApprovalPrompt; created: boolean; code: string } | null {
  const now = input.now ?? Date.now();
  const store = readStore(now);
  // One live question per draft, and the caller is TOLD it already had one.
  // Posting a second message for the same draft would put two live buttons in
  // the chat for one email: the first tap sends it and the second is left
  // saying "no longer waiting", which reads like a bug in the box.
  // The CODE is returned only to whoever created the prompt, and only then:
  // this is the one moment it exists outside the owner's message, and a caller
  // that finds an existing prompt gets "" because that code is not recoverable
  // from the store and must not be re-minted under a live question.
  const existing = store.prompts.find((p) => p.draftId === input.draftId);
  if (existing) return { prompt: existing, created: false, code: "" };
  if (store.prompts.length >= MAX_PROMPTS) return null;

  const code = mintCode(new Set(store.prompts.map((p) => p.codeHash).filter((h): h is string => !!h)));
  if (!code) return null;
  const prompt: ApprovalPrompt = {
    // 8 bytes. This is a lookup key in a file of at most twenty entries, not a
    // secret — but it is random rather than sequential so that nothing about
    // one handle tells you another one exists.
    handle: randomBytes(8).toString("hex"),
    codeHash: hashCode(code),
    draftId: input.draftId,
    fingerprint: input.fingerprint,
    messages: [],
    createdAt: now,
  };
  writeStore({ ...store, prompts: [...store.prompts, prompt] });
  return { prompt, created: true, code };
}

/**
 * Note where the question was posted, so the outcome can be edited in later.
 *
 * The message id is the one value here that came off the network, so it is
 * rebuilt as a bounded whole number before it reaches the disk rather than
 * written through. The chat id is checked against the same pattern the owner
 * allowlist is read with. What lands in the file is what these two lines
 * produced, not what a response contained.
 */
export function recordPromptMessage(handle: string, message: PromptMessage, now = Date.now()): void {
  if (!CHAT_ID_RE.test(message.chatId)) return;
  if (!Number.isSafeInteger(message.messageId) || message.messageId <= 0) return;
  const safe: PromptMessage = { chatId: message.chatId, messageId: Math.trunc(message.messageId) };
  const store = readStore(now);
  const prompt = store.prompts.find((p) => p.handle === handle);
  if (!prompt) return;
  if (prompt.messages.some((m) => m.chatId === safe.chatId && m.messageId === safe.messageId)) return;
  prompt.messages.push(safe);
  writeStore(store);
}

/**
 * Take a prompt OUT of the store, returning it. One handle answers once.
 *
 * SYNCHRONOUS, WITH NO AWAIT BETWEEN THE READ AND THE WRITE, for exactly the
 * reason claimPending() documents: one JS thread means a second callback for
 * the same handle cannot start until this call has returned, so two taps cannot
 * both find the prompt. An await in here — or a move to fs/promises — would put
 * the double-tap window back.
 *
 * This is the FIRST of two locks on a double tap. The second, and the
 * authoritative one, is claimPendingIfUnchanged() on the draft itself: this
 * store could be deleted off the disk and the draft would still only send once.
 */
export function claimPrompt(handle: string, now = Date.now()): ApprovalPrompt | null {
  const store = readStore(now);
  const found = store.prompts.find((p) => p.handle === handle);
  if (!found) return null;
  writeStore({ ...store, prompts: store.prompts.filter((p) => p.handle !== handle) });
  return found;
}

/** Look without consuming — for the poller's "is anything outstanding" check. */
export function countPrompts(now = Date.now()): number {
  return readStore(now).prompts.length;
}

export function listPrompts(now = Date.now()): ApprovalPrompt[] {
  return readStore(now).prompts;
}

/**
 * Drop the question(s) about a draft that has been decided somewhere else —
 * the desktop panel, the chat card, a reject.
 *
 * Without this, approving on the desktop would leave a live button in Telegram
 * whose only possible answer is "that draft is no longer waiting". Returns the
 * prompts removed so the caller can strike through the chat message.
 */
export function removePromptsForDraft(draftId: string, now = Date.now()): ApprovalPrompt[] {
  const store = readStore(now);
  const removed = store.prompts.filter((p) => p.draftId === draftId);
  if (removed.length === 0) return [];
  writeStore({ ...store, prompts: store.prompts.filter((p) => p.draftId !== draftId) });
  return removed;
}

/** Everything, for when the account is disconnected. Mirrors clearPending(). */
export function clearPrompts(): void {
  try {
    if (fs.existsSync(PROMPTS_PATH)) fs.unlinkSync(PROMPTS_PATH);
  } catch {
    // best-effort
  }
}

export function readOffset(now = Date.now()): number {
  return readStore(now).offset;
}

/**
 * Advance the getUpdates cursor.
 *
 * Never moves backwards. Telegram replays every update below the offset it is
 * given, so a cursor that regressed — two pollers, a restored backup — would
 * re-deliver taps that were already answered. Those are harmless (the handle is
 * gone, the draft is gone) but they would be answered with "expired" instead of
 * silence, which is noise in the owner's chat.
 */
export function advanceOffset(offset: number, now = Date.now()): void {
  if (!Number.isFinite(offset)) return;
  const store = readStore(now);
  if (offset <= store.offset) return;
  writeStore({ ...store, offset });
}
