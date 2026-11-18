"use strict";

/**
 * Whose chat a file in the chat media tree belongs to — the one implementation,
 * required by production-server.js's CommonJS (the user-chat relay records the
 * files an agent's reply names, TASK-2516) and re-exported for the TypeScript
 * side by src/lib/chat-media-owners.ts, which explains the rule.
 *
 * One small JSON map, `{ realpath: username }`, bounded and kept oldest-first.
 * Read and written synchronously, so a read-modify-write cannot interleave with
 * another one in this process. Two copies of this module (the Next bundle's
 * and production-server's) each cache by the file's inode, mtime and size, so
 * each sees the other's writes (a write is a rename: a new inode).
 */

const fs = require("fs");
const path = require("./runtime-path.js");

/** Records kept, for everyone together (see src/lib/chat-media-owners.ts). */
const MAX_MEDIA_OWNER_RECORDS = 20_000;

/** Records kept for any one person. */
const MAX_MEDIA_OWNER_RECORDS_PER_USER = 4_000;

/** The username rule (src/lib/username-rules.ts), as chat-scope.ts spells it. */
const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * The record functions over one owners file.
 * @param {string} ownersPath absolute path of chat-media-owners.json
 */
function createMediaOwners(ownersPath) {
  /** @type {{ ino: number, mtimeMs: number, size: number, owners: Map<string, string> } | null} */
  let cache = null;

  /** @returns {Map<string, string>} */
  function readOwners() {
    // One descriptor for the stat and the read, so the cache is keyed on
    // exactly the bytes that were parsed (no check-then-use window).
    let fd;
    try {
      fd = fs.openSync(/* turbopackIgnore: true */ ownersPath, "r");
    } catch {
      cache = null;
      return new Map();
    }
    try {
      const stat = fs.fstatSync(fd);
      if (cache && cache.ino === stat.ino && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.owners;
      const owners = new Map();
      try {
        const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [file, user] of Object.entries(parsed)) {
            if (path.isAbsolute(file) && typeof user === "string" && NAME_RE.test(user)) owners.set(file, user);
          }
        }
      } catch {
        // A damaged map is an empty one: a member is then served nothing, never more.
      }
      cache = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, owners };
      return owners;
    } catch {
      cache = null;
      return new Map();
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Keep `username` within their share, then everyone within the whole. Oldest first, insertion order. */
  function bound(owners, username) {
    let theirs = 0;
    for (const owner of owners.values()) if (owner === username) theirs++;
    for (const [file, owner] of owners) {
      if (theirs <= MAX_MEDIA_OWNER_RECORDS_PER_USER) break;
      if (owner !== username) continue;
      owners.delete(file);
      theirs--;
    }
    if (owners.size <= MAX_MEDIA_OWNER_RECORDS) return;
    // A record whose file retention already swept protects nothing.
    for (const file of owners.keys()) {
      if (owners.size <= MAX_MEDIA_OWNER_RECORDS) return;
      if (!fs.existsSync(/* turbopackIgnore: true */ file)) owners.delete(file);
    }
    for (const file of owners.keys()) {
      if (owners.size <= MAX_MEDIA_OWNER_RECORDS) return;
      owners.delete(file);
    }
  }

  function writeOwners(owners) {
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(ownersPath), { recursive: true });
    const tmp = `${ownersPath}.tmp-${process.pid}`;
    fs.writeFileSync(/* turbopackIgnore: true */ tmp, JSON.stringify(Object.fromEntries(owners)), { mode: 0o600 });
    fs.renameSync(/* turbopackIgnore: true */ tmp, /* turbopackIgnore: true */ ownersPath);
    cache = null;
  }

  /**
   * Record files as `username`'s. Their real paths are kept. A file already
   * recorded as someone else's is never taken from them. Best effort, never
   * throws. Answers the real paths now recorded as theirs.
   * @param {string} username
   * @param {ReadonlyArray<string | null | undefined>} files
   * @returns {string[]}
   */
  function recordMediaOwner(username, files) {
    if (!NAME_RE.test(username)) return [];
    const reals = [];
    for (const file of files) {
      if (!file || !path.isAbsolute(file)) continue;
      try {
        reals.push(fs.realpathSync(/* turbopackIgnore: true */ file));
      } catch {
        /* gone already: nothing to serve */
      }
    }
    if (reals.length === 0) return [];
    try {
      const owners = new Map(readOwners());
      const mine = [];
      for (const real of reals) {
        const existing = owners.get(real);
        // Never taken from someone else: a record is made once, by the write
        // that created the file, and a later one cannot reassign it.
        if (existing !== undefined && existing !== username) continue;
        // Re-inserted, so a file written again counts as new for the bound.
        owners.delete(real);
        owners.set(real, username);
        mine.push(real);
      }
      bound(owners, username);
      writeOwners(owners);
      return mine;
    } catch (err) {
      console.warn("[chat-media-owners] could not record media:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Whose record covers `real` (a resolved path below `rootReal`): the file
   * itself, or a folder it sits in below the root. Null: nobody's.
   * @returns {string | null}
   */
  function mediaOwnerOf(real, rootReal) {
    const owners = readOwners();
    let current = real;
    while (true) {
      const rel = path.relative(rootReal, current);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      const owner = owners.get(current);
      if (owner !== undefined) return owner;
      current = path.dirname(current);
    }
  }

  /** Is `real` recorded as `username`'s? */
  function isMediaOwnedBy(username, real, rootReal) {
    if (!NAME_RE.test(username)) return false;
    return mediaOwnerOf(real, rootReal) === username;
  }

  /** Forget every record of a removed user. Best effort. */
  function forgetMediaOwner(username) {
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

  return { recordMediaOwner, isMediaOwnedBy, mediaOwnerOf, forgetMediaOwner };
}

module.exports = { createMediaOwners, MAX_MEDIA_OWNER_RECORDS, MAX_MEDIA_OWNER_RECORDS_PER_USER };
