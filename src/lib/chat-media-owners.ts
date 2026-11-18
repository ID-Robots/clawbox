/**
 * Whose chat a file in the chat media tree belongs to. SERVER ONLY.
 *
 * WHY IT EXISTS. `/setup-api/chat/media` serves files by absolute path out of
 * one media tree every chat on the box writes into (src/lib/harness/media-root.ts).
 * Containment in that tree says a file is chat media; it does not say WHOSE.
 * On an organisation box (src/lib/org-mode.ts) a member of staff who learnt
 * another person's media path could otherwise ask for it by name and be
 * served it (TASK-2435 review, CWE-639). So every file ClawBox writes into the
 * tree for a ClawBox user other than the owner is recorded here under that
 * user, and the media route serves a member only what is recorded as theirs.
 *
 * WHAT IS RECORDED, AND BY WHOM. Exactly the writes ClawBox makes on a
 * person's behalf, at the moment it makes them, for the person whose request
 * or conversation it is:
 *   - an upload staged by `chat/attachments` (and a dropped folder's root, and
 *     the text copy of an office document beside it);
 *   - a picture drawn by `chat/images`;
 *   - a picture adopted and a reply spoken by the Hermes chat turn.
 * Nothing is recorded from a path a request NAMES — only from paths this box
 * itself chose and wrote — so naming a path never makes it yours.
 *
 * FAIL CLOSED. A file with no record is nobody's to a member: the owner's own
 * media, the box's other sessions, and what the OpenClaw gateway writes into
 * the tree by itself. The owner is never asked about here and is served the
 * tree as before.
 *
 *   - the files an agent's reply in a MEMBER'S chat names on `MEDIA:` lines
 *     (TASK-2516, scripts/chat-reply-media.js): only fresh regular files in
 *     the chat media tree (not ClawBox's own staging folders) or the member's
 *     own folder, reached without a link — never another member's file, which
 *     a record is never taken from.
 *
 * One small JSON map, `{ realpath: username }`, bounded and kept oldest-first
 * so the oldest record goes first — the same retention the media itself ages
 * out under. Read and written synchronously, so a read-modify-write cannot
 * interleave with another one in this process (the same choice as the Hermes
 * session map in src/lib/chat-scope-server.ts). The implementation is
 * scripts/chat-media-owners.js, which production-server.js's user-chat relay
 * requires as well: one file, so the relay and the media route read one rule.
 */

import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import {
  createMediaOwners,
  MAX_MEDIA_OWNER_RECORDS as MAX_RECORDS,
  MAX_MEDIA_OWNER_RECORDS_PER_USER as MAX_PER_USER,
} from "../../scripts/chat-media-owners.js";

/** The owners file. */
export const MEDIA_OWNERS_PATH = path.join(DATA_DIR, "chat-media-owners.json");

/**
 * Records kept, for everyone together. Generously above what the media
 * retention leaves on disk at once (a few hundred pictures, thousands of short
 * spoken clips, a week of uploads), so a record never ages out ahead of its
 * file in practice. Past it, records whose file is already gone go first, and
 * only then the oldest.
 */
export const MAX_MEDIA_OWNER_RECORDS: number = MAX_RECORDS;

/**
 * Records kept for any one person. The uploads' retention bounds bytes, not
 * files, so without a share of their own one member staging thousands of tiny
 * files would push everyone else's records out — and with them everyone
 * else's media. Past it, that person's own oldest record goes.
 */
export const MAX_MEDIA_OWNER_RECORDS_PER_USER: number = MAX_PER_USER;

const owners = createMediaOwners(MEDIA_OWNERS_PATH);

/**
 * Record files this box just wrote into the chat media tree as `username`'s.
 * The files' real paths are what is kept, so a symlinked media root matches
 * what the media route resolves. A missing file, an empty entry or a name
 * outside the username rule is skipped. Best effort, never throws: a record
 * that could not be written leaves the file unservable to a member, which is
 * the safe way to fail. A file already recorded as someone else's stays theirs.
 */
export function recordMediaOwner(username: string, files: ReadonlyArray<string | null | undefined>): void {
  owners.recordMediaOwner(username, files);
}

/** `recordMediaOwner`, answering the real paths now recorded as theirs (one already someone else's is not among them). */
export function recordMediaOwnerReturning(username: string, files: ReadonlyArray<string | null | undefined>): string[] {
  return owners.recordMediaOwner(username, files);
}

/**
 * Is `real` — a resolved path inside the media tree whose resolved root is
 * `rootReal` — recorded as `username`'s? The file itself, or a folder it sits
 * in below the root (a dropped folder is recorded once, by its root).
 */
export function isMediaOwnedBy(username: string, real: string, rootReal: string): boolean {
  return owners.isMediaOwnedBy(username, real, rootReal);
}

/** Forget every record of a removed user, so a user created later under the name owns nothing. Best effort. */
export function forgetMediaOwner(username: string): void {
  owners.forgetMediaOwner(username);
}
