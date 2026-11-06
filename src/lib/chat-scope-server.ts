/**
 * The server half of src/lib/chat-scope.ts: who a chat request is for, and
 * which conversations it may touch. SERVER ONLY.
 *
 * Every chat route that names a conversation — the Hermes transcript, its
 * pictures, the tab list, the spoken-reply repair — resolves the caller here
 * and holds the key to `mayUseChatKey`, so a ClawBox user reaches their own
 * chat and no one else's, and the owner's chat never lists theirs.
 *
 * The MCP bearer is the agent, not a person: it keeps reading the owner's
 * chat, exactly as it did before there were other users.
 */

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { personSession } from "@/lib/owner-session";
import { getSystemUsername } from "@/lib/auth";
import { chatKeyUser, defaultTranscriptKeyFor, mayUseChatKey, type ChatPrincipal } from "@/lib/chat-scope";
import { transcriptKeyIsSafe } from "@/lib/harness/transcript-key";

/** The person a chat request speaks for; the owner for the agent's bearer (and for no session, which middleware already refused). */
export async function chatPrincipalOf(request: Request): Promise<ChatPrincipal> {
  const person = await personSession(request);
  return person ?? { username: getSystemUsername(), isOwner: true };
}

export type TranscriptKeyVerdict =
  | { ok: true; key: string; principal: ChatPrincipal }
  | { ok: false; status: 400 | 403; error: string; code: "invalid_session_key" | "not_your_chat" };

/**
 * The transcript a request names — or, when it names none, the caller's own
 * main one (`desktop` for the owner, `desktop-user-<name>` for anyone else:
 * never the owner's for a user). Refused when it is not a bare filename, or
 * when it is someone else's conversation.
 */
export async function transcriptKeyFor(request: Request, raw: unknown): Promise<TranscriptKeyVerdict> {
  const principal = await chatPrincipalOf(request);
  const key = typeof raw === "string" && raw ? raw : defaultTranscriptKeyFor(principal);
  if (!transcriptKeyIsSafe(key)) {
    return { ok: false, status: 400, error: "Invalid session key", code: "invalid_session_key" };
  }
  if (!mayUseChatKey(principal, key)) {
    return { ok: false, status: 403, error: "That conversation belongs to someone else on this ClawBox.", code: "not_your_chat" };
  }
  return { ok: true, key, principal };
}

// ── Which transcript a Hermes session belongs to ─────────────────────────────
//
// A Hermes turn resumes a stored session by id (`session.resume` on the
// dashboard's JSON-RPC, `--resume` on the CLI). The id comes from the browser,
// so the box remembers which transcript key each session id was opened under
// for a ClawBox user, and a user's turn may resume only their own. An id the
// box never recorded is from the owner's chat (every session before there were
// other users is), which a user may not resume and the owner may.

const SESSION_KEYS_PATH = path.join(DATA_DIR, "hermes-chat-sessions.json");
const MAX_SESSION_KEYS = 2_000;
// The dashboard's timestamped ids, and from Hermes v0.22.4 the gateway's
// `local-` + 64 hex that a `hermes chat` turn opens (the chat route's rule).
const SESSION_ID_RE = /^(?:[0-9]{8}_[0-9]{6}_[0-9a-f]{6}|local-[0-9a-f]{64})$/;

function readSessionKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_KEYS_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (SESSION_ID_RE.test(id) && typeof key === "string" && transcriptKeyIsSafe(key)) out[id] = key;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Remember that `sessionId` carries the conversation behind `transcriptKey`.
 * Only a ClawBox user's keys are kept — an unrecorded id is the owner's — and
 * the file is bounded; best effort, never throws.
 */
export function noteHermesSession(sessionId: string | undefined, transcriptKey: string): void {
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || chatKeyUser(transcriptKey) === null) return;
  try {
    const all = readSessionKeys();
    if (all[sessionId] === transcriptKey) return;
    all[sessionId] = transcriptKey;
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSION_KEYS))) delete all[id];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = untraced(`${SESSION_KEYS_PATH}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_KEYS_PATH);
  } catch (err) {
    console.warn("[chat-scope] could not record a Hermes session:", err instanceof Error ? err.message : err);
  }
}

/**
 * The session id a turn may resume: `requested` when it is this person's,
 * otherwise "" — the turn then starts a fresh session instead of continuing
 * someone else's.
 */
export function hermesSessionFor(principal: ChatPrincipal, requested: string): string {
  if (!requested) return "";
  const key = readSessionKeys()[requested];
  if (key === undefined) return principal.isOwner ? requested : "";
  return mayUseChatKey(principal, key) ? requested : "";
}

/** Forget a removed user's sessions. Best effort. */
export function forgetHermesSessionsOf(username: string): void {
  try {
    const all = readSessionKeys();
    let changed = false;
    for (const [id, key] of Object.entries(all)) {
      if (chatKeyUser(key) === username) {
        delete all[id];
        changed = true;
      }
    }
    if (!changed) return;
    const tmp = untraced(`${SESSION_KEYS_PATH}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_KEYS_PATH);
  } catch {
    /* nothing to forget */
  }
}
