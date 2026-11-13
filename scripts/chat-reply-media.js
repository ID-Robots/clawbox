"use strict";

/**
 * The files an agent's reply in a MEMBER OF STAFF'S chat names, recorded as
 * that member's (TASK-2516). SERVER ONLY. The one implementation: the OpenClaw
 * user-chat relay (scripts/gateway-user-relay.js, in production-server.js)
 * runs it on a reply before the member's browser sees it, and the Hermes chat
 * route (src/app/setup-api/hermes/chat/route.ts, through
 * src/lib/chat-reply-media.ts) on the turn's final text.
 *
 * WHY. An owner-granted MCP tool (a document writer) writes a file, and the
 * agent's reply names it on a `MEDIA:<absolute path>` line, which the chat
 * renders as a download card. `/setup-api/chat/media` serves a member only
 * what chat-media-owners records as theirs, so without a record the card was
 * a 404 for them.
 *
 * WHAT A REPLY CAN MAKE A MEMBER'S — the reply's text is model output, and a
 * member can ask their assistant to write any line, so a path is recorded only
 * when ALL of these hold:
 *   - it is absolute (or `file://`), with no `.`/`..` segment, no NUL, within
 *     4096 characters;
 *   - it lies in one of the member's roots: the chat media tree — minus the
 *     folders ClawBox records its own writes in (`skip`: staged uploads,
 *     generated pictures, spoken replies, a channel's inbound media) — or the
 *     member's own folder (their staff workspace / Hermes profile workspace);
 *     no dot segment below the root;
 *   - every component below the root is a real directory and the file a
 *     regular file with one link: a symlink anywhere refuses it (CWE-59), and
 *     so does a hard link;
 *   - it was written DURING the member's turn: modified no earlier than the
 *     turn began (or, unknown, `DEFAULT_TURN_MS` before the reply) and no
 *     later than the reply, give or take `SLACK_MS`. The owner's older media
 *     and another member's earlier file cannot be claimed by naming them;
 *   - nobody else's record covers it (chat-media-owners never reassigns one).
 */

const fs = require("fs");
const path = require("path");

/** A turn whose start is unknown (a relay that opened mid-turn) is taken to have begun this long before its reply. */
const DEFAULT_TURN_MS = 30 * 60_000;
/** Clock slack either side of the turn: a file's mtime and the gateway's timestamps come from one clock, but not one instant. */
const SLACK_MS = 5_000;
/** Paths read from one message: a reply naming more is cut, as the chat's own card list is. */
const MAX_PATHS_PER_MESSAGE = 16;
const MAX_PATH_CHARS = 4096;

/** The media-tree folders ClawBox records its own writes in at write time: never claimable by a reply. */
const MEDIA_TREE_OWN_FOLDERS = Object.freeze(["chat-attachments", "chat-generated", "chat-spoken", "inbound"]);

const MEDIA_LINE_RE = /^media:\s*(.*)$/i;
const FENCE_RE = /^(?:```|~~~)/;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One layer of the quoting a model wraps a path in (as src/lib/chat-media.ts unwraps it). */
function unwrapQuoted(value) {
  for (const quote of ["`", '"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * The payloads of a text's `MEDIA:` lines — at the start of a line, outside
 * fenced code — the rule of `splitMediaDirectives` (src/lib/chat-media.ts).
 * @param {unknown} text
 * @returns {string[]}
 */
function mediaDirectives(text) {
  if (typeof text !== "string" || !/media:/i.test(text)) return [];
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = MEDIA_LINE_RE.exec(trimmed);
    const payload = match ? unwrapQuoted(match[1].trim()) : "";
    if (payload) out.push(payload);
  }
  return out;
}

/** A local path a source names, or null (a web or data URL, a gateway URL). */
function localPathOf(source) {
  if (typeof source !== "string") return null;
  const value = source.trim();
  if (value.toLowerCase().startsWith("file://")) return value.slice("file://".length);
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/**
 * Every local path an ASSISTANT message names: its text's `MEDIA:` lines
 * (a string content or `text` parts), `mediaUrl`/`mediaUrls`, and an
 * attachment part's local source. Anything not the assistant's names nothing.
 * @param {unknown} message
 * @returns {string[]}
 */
function replyMediaPaths(message) {
  if (!isRecord(message) || message.role !== "assistant") return [];
  const sources = [];
  const content = message.content;
  if (typeof content === "string") sources.push(...mediaDirectives(content));
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text") sources.push(...mediaDirectives(part.text));
      else if (part.type === "attachment") {
        for (const key of ["path", "url", "mediaUrl", "source"]) if (typeof part[key] === "string") sources.push(part[key]);
      }
    }
  }
  if (typeof message.text === "string") sources.push(...mediaDirectives(message.text));
  if (typeof message.mediaUrl === "string") sources.push(message.mediaUrl);
  if (Array.isArray(message.mediaUrls)) for (const url of message.mediaUrls) if (typeof url === "string") sources.push(url);
  const out = [];
  for (const source of sources) {
    const local = localPathOf(source);
    if (local && !out.includes(local)) out.push(local);
    if (out.length >= MAX_PATHS_PER_MESSAGE) break;
  }
  return out;
}

/** A timestamp as milliseconds: a number (ms, or seconds when small) or an ISO string; null otherwise. */
function timeOf(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The real path of a root, or null when it does not exist. */
function realRoot(dir) {
  try {
    return fs.realpathSync(/* turbopackIgnore: true */ dir);
  } catch {
    return null;
  }
}

/** `target` relative to `base` when strictly inside it, else null. */
function inside(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Why `raw` cannot be recorded for a turn between `since` and `until`, or the
 * file's real path when it can. Pure but for the file system reads.
 * @param {string} raw
 * @param {ReadonlyArray<{ dir: string, skip?: ReadonlyArray<string> }>} roots
 * @param {{ since: number | null, until: number }} turn
 * @returns {{ ok: true, real: string } | { ok: false, reason: string }}
 */
function claimable(raw, roots, turn) {
  const local = localPathOf(raw);
  if (!local) return { ok: false, reason: "not_local" };
  if (local.length > MAX_PATH_CHARS || local.includes("\0")) return { ok: false, reason: "bad_path" };
  // Lexical: no dot segment at all, so what is checked is what was named.
  const segments = local.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, reason: "traversal" };
  const absolute = path.resolve(local);
  for (const root of roots) {
    if (!root || typeof root.dir !== "string" || !path.isAbsolute(root.dir)) continue;
    const logical = path.resolve(root.dir);
    const real = realRoot(logical);
    if (!real) continue;
    const rel = inside(logical, absolute) ?? inside(real, absolute);
    if (rel === null) continue;
    const parts = rel.split(path.sep);
    if (parts.some((part) => part.startsWith("."))) return { ok: false, reason: "hidden" };
    if (root.skip && root.skip.includes(parts[0])) return { ok: false, reason: "own_folder" };
    // Walked from the root's REAL path, component by component, never
    // following a link: what is recorded is exactly what was named.
    let current = real;
    let stat = null;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        stat = fs.lstatSync(/* turbopackIgnore: true */ current);
      } catch {
        return { ok: false, reason: "missing" };
      }
      if (stat.isSymbolicLink()) return { ok: false, reason: "link" };
      if (i < parts.length - 1 && !stat.isDirectory()) return { ok: false, reason: "missing" };
    }
    if (!stat || !stat.isFile()) return { ok: false, reason: "not_a_file" };
    if (stat.nlink !== 1) return { ok: false, reason: "link" };
    const since = turn.since ?? turn.until - DEFAULT_TURN_MS;
    if (stat.mtimeMs < since - SLACK_MS || stat.mtimeMs > turn.until + SLACK_MS) return { ok: false, reason: "not_this_turn" };
    return { ok: true, real: current };
  }
  return { ok: false, reason: "outside" };
}

/**
 * Record the files a member's reply names as theirs, by the rules above.
 * Never throws.
 * @param {{
 *   username: string,
 *   paths: ReadonlyArray<string>,
 *   roots: ReadonlyArray<{ dir: string, skip?: ReadonlyArray<string> }>,
 *   since?: number | null,
 *   until?: number | null,
 *   record: (username: string, files: string[]) => string[] | void,
 * }} input
 * @returns {{ recorded: string[], refused: Array<{ path: string, reason: string }> }}
 */
function claimReplyMedia(input) {
  const recorded = [];
  const refused = [];
  try {
    const until = timeOf(input.until) ?? Date.now();
    const turn = { since: timeOf(input.since), until };
    const accepted = [];
    for (const raw of (input.paths || []).slice(0, MAX_PATHS_PER_MESSAGE)) {
      const verdict = claimable(raw, input.roots || [], turn);
      if (verdict.ok) accepted.push(verdict.real);
      else refused.push({ path: String(raw).slice(0, 300), reason: verdict.reason });
    }
    if (accepted.length > 0) {
      const mine = input.record(input.username, accepted);
      const kept = Array.isArray(mine) ? mine : accepted;
      for (const real of accepted) {
        if (kept.includes(real)) recorded.push(real);
        else refused.push({ path: real, reason: "someone_elses" });
      }
    }
  } catch (err) {
    console.warn("[chat-reply-media] could not record a reply's files:", err instanceof Error ? err.message : err);
  }
  return { recorded, refused };
}

/**
 * The claims one history answer carries: each assistant message with its
 * paths, its own timestamp as the reply's, and the user message before it as
 * the turn's start.
 * @param {unknown} messages
 * @returns {Array<{ paths: string[], since: number | null, until: number | null }>}
 */
function historyClaims(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let lastUser = null;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "user") {
      lastUser = timeOf(message.timestamp ?? message.createdAt ?? message.ts);
      continue;
    }
    const paths = replyMediaPaths(message);
    if (paths.length > 0) out.push({ paths, since: lastUser, until: timeOf(message.timestamp ?? message.createdAt ?? message.ts) });
  }
  return out;
}

module.exports = {
  DEFAULT_TURN_MS,
  SLACK_MS,
  MAX_PATHS_PER_MESSAGE,
  MEDIA_TREE_OWN_FOLDERS,
  mediaDirectives,
  replyMediaPaths,
  claimable,
  claimReplyMedia,
  historyClaims,
};
