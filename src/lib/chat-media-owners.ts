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
 * One small JSON map, `{ realpath: username }`, bounded and kept oldest-first
 * so the oldest record goes first — the same retention the media itself ages
 * out under. Read and written synchronously, so a read-modify-write cannot
 * interleave with another one in this process (the same choice as the Hermes
 * session map in src/lib/chat-scope-server.ts).
 */

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";

const OWNERS_PATH = path.join(DATA_DIR, "chat-media-owners.json");

/**
 * Records kept. Generously above what the media retention leaves on disk at
 * once (a few hundred pictures, thousands of short spoken clips, a week of
 * uploads), so a record never ages out ahead of its file in practice.
 */
export const MAX_MEDIA_OWNER_RECORDS = 10_000;

/** The username rule (src/lib/username-rules.ts), as chat-scope.ts spells it. */
const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

type Owners = Map<string, string>;

let cache: { ino: number; mtimeMs: number; size: number; owners: Owners } | null = null;

function readOwners(): Owners {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(OWNERS_PATH);
  } catch {
    cache = null;
    return new Map();
  }
  if (cache && cache.ino === stat.ino && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.owners;
  const owners: Owners = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(OWNERS_PATH, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [file, user] of Object.entries(parsed as Record<string, unknown>)) {
        if (path.isAbsolute(file) && typeof user === "string" && NAME_RE.test(user)) owners.set(file, user);
      }
    }
  } catch {
    // A damaged map is an empty one: a member is then served nothing, never more.
  }
  cache = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, owners };
  return owners;
}

function writeOwners(owners: Owners): void {
  const extra = owners.size - MAX_MEDIA_OWNER_RECORDS;
  if (extra > 0) {
    let dropped = 0;
    for (const file of owners.keys()) {
      if (dropped++ >= extra) break;
      owners.delete(file);
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = untraced(`${OWNERS_PATH}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(owners)), { mode: 0o600 });
  fs.renameSync(tmp, OWNERS_PATH);
  cache = null;
}

/**
 * Record files this box just wrote into the chat media tree as `username`'s.
 * The files' real paths are what is kept, so a symlinked media root matches
 * what the media route resolves. A missing file, an empty entry or a name
 * outside the username rule is skipped. Best effort, never throws: a record
 * that could not be written leaves the file unservable to a member, which is
 * the safe way to fail.
 */
export function recordMediaOwner(username: string, files: ReadonlyArray<string | null | undefined>): void {
  if (!NAME_RE.test(username)) return;
  const reals: string[] = [];
  for (const file of files) {
    if (!file || !path.isAbsolute(file)) continue;
    try {
      reals.push(fs.realpathSync(file));
    } catch {
      /* gone already: nothing to serve */
    }
  }
  if (reals.length === 0) return;
  try {
    const owners = new Map(readOwners());
    for (const real of reals) {
      const existing = owners.get(real);
      // Never taken from someone else: a record is made once, by the write
      // that created the file, and a later one cannot reassign it.
      if (existing !== undefined && existing !== username) continue;
      // Re-inserted, so a file written again counts as new for the bound.
      owners.delete(real);
      owners.set(real, username);
    }
    writeOwners(owners);
  } catch (err) {
    console.warn("[chat-media-owners] could not record media:", err instanceof Error ? err.message : err);
  }
}

/**
 * Is `real` — a resolved path inside the media tree whose resolved root is
 * `rootReal` — recorded as `username`'s? The file itself, or a folder it sits
 * in below the root (a dropped folder is recorded once, by its root).
 */
export function isMediaOwnedBy(username: string, real: string, rootReal: string): boolean {
  if (!NAME_RE.test(username)) return false;
  const owners = readOwners();
  let current = real;
  while (true) {
    const rel = path.relative(rootReal, current);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const owner = owners.get(current);
    if (owner !== undefined) return owner === username;
    current = path.dirname(current);
  }
}

/** Forget every record of a removed user, so a user created later under the name owns nothing. Best effort. */
export function forgetMediaOwner(username: string): void {
  try {
    const owners = new Map(readOwners());
    let changed = false;
    for (const [file, owner] of owners) {
      if (owner === username) {
        owners.delete(file);
        changed = true;
      }
    }
    if (changed) writeOwners(owners);
  } catch (err) {
    console.warn("[chat-media-owners] could not forget a user's media:", err instanceof Error ? err.message : err);
  }
}
