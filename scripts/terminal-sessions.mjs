// @ts-check
/**
 * Terminal sessions that outlive the page (TASK-1306).
 *
 * A Terminal tab's shell lives on the box, not in the browser: the PTY and
 * whatever it runs (a ClawKeep backup, a long `find`) keep running when the
 * page is refreshed, the tab is closed or the network drops, and the window
 * that comes back reattaches to the SAME session and is shown what it missed.
 *
 * The pieces, all plain ESM so scripts/terminal-server.mjs can load them with
 * the Node that runs the web server (see the note at the top of that file):
 *
 * - `Scrollback` — the last N characters a session printed, replayed to a
 *   client that attaches. Capped per session; the cut is moved to the next line
 *   start so a replay never opens halfway through an escape sequence.
 * - `createSessionRegistry` — every live session, keyed by an unguessable id
 *   and owned by ONE ClawBox user. A session nobody is attached to is ended
 *   after `idleMs`; a user holding more than `maxDetachedPerUser` sessions
 *   nobody is watching loses the oldest (ended shells first) when a new one
 *   starts, so a script that opens sockets and walks away cannot pile up shells.
 * - `handleConnection` — the WebSocket protocol on top of the registry.
 *
 * Protocol (query string of the upgrade):
 *   (no `session`)      — the old behaviour, for the Coding Agent's run tail and
 *                         the standalone Terminal page: a fresh shell that ends
 *                         with its socket.
 *   `session=new`       — a fresh shell that OUTLIVES its socket; answered
 *                         `{ type: "started", session: <id>, … }`.
 *   `session=<id>`      — reattach: `{ type: "attached", session, … }`, then the
 *                         scrollback as one `{ type: "output", replay: true }`,
 *                         then live output. A shell that ended while nobody was
 *                         attached is replayed and followed by its `exit`.
 *                         An id this user does not own, or that no longer
 *                         exists (idle, a reboot, a restart of this server), is
 *                         answered `{ type: "gone" }` and closed — the window
 *                         says so rather than opening a fresh shell that looks
 *                         like the old one.
 *   `end=<id>`          — the owner closed the window or the tab by hand: the
 *                         shell is killed and the session forgotten
 *                         (`{ type: "ended" }`, or `gone` for an unknown id).
 *
 * A session another page is still attached to keeps both: output goes to every
 * attached client, input comes from any of them.
 */

import { randomUUID } from "node:crypto";

/** Characters of output a session keeps for a reattach — about 6,000 lines of 80 columns. */
export const DEFAULT_SCROLLBACK_CHARS = 512 * 1024;
/** How long a session nobody is attached to keeps running before it is ended. */
export const DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;
/** Sessions nobody is watching that one user may hold before the oldest is ended. */
export const DEFAULT_MAX_DETACHED_PER_USER = 32;
/** What a session id looks like — `randomUUID()`, and nothing a path or a log line could be steered with. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The registry's name for the box owner, who has no `x-clawbox-terminal-user`. */
export const OWNER_KEY = ":owner";

/** How far past the cap the buffer may grow before it is cut back, so a busy shell pays for one slice per 128 KiB and not one per chunk. */
const SCROLLBACK_SLACK = 1.25;
/** How far into a cut buffer the next line start is looked for. */
const LINE_SEARCH = 4096;

/**
 * An integer from the environment within [min, max], or the fallback.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function envInt(value, fallback, min, max) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Start a cut buffer at a line start: never inside an escape sequence, never on
 * the second half of a surrogate pair.
 *
 * @param {string} text
 * @returns {string}
 */
function fromLineStart(text) {
  const newline = text.indexOf("\n");
  if (newline >= 0 && newline < LINE_SEARCH) return text.slice(newline + 1);
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

export class Scrollback {
  /** @param {number} cap characters kept */
  constructor(cap) {
    this.cap = Math.max(1, cap);
    this.buf = "";
  }

  /** @param {string} data */
  append(data) {
    this.buf += data;
    if (this.buf.length > this.cap * SCROLLBACK_SLACK) {
      this.buf = fromLineStart(this.buf.slice(this.buf.length - this.cap));
    }
  }

  /** @returns {string} at most `cap` characters, from a line start when cut */
  text() {
    return this.buf.length > this.cap ? fromLineStart(this.buf.slice(this.buf.length - this.cap)) : this.buf;
  }
}

/**
 * @typedef {object} PtyLike
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {(cb: (data: string) => void) => unknown} onData
 * @property {(cb: (e: { exitCode: number }) => void) => unknown} onExit
 * @property {number} [pid]
 */

/**
 * @typedef {object} SessionClient
 * @property {(text: string) => void} send
 * @property {() => void} close
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} owner
 * @property {PtyLike} pty
 * @property {Record<string, unknown>} info       what `started`/`attached` report: shell, cwd, user
 * @property {boolean} ephemeral                    ends with its last socket (no `session` asked for)
 * @property {boolean} claimed                      a client has spoken on it — see `detach`
 * @property {Set<SessionClient>} clients
 * @property {Scrollback} scrollback
 * @property {{ code: number } | null} exited
 * @property {number} createdAt
 * @property {number | null} detachedAt
 * @property {ReturnType<typeof setTimeout> | null} idleTimer
 */

/**
 * @param {{
 *   idleMs?: number,
 *   scrollbackChars?: number,
 *   maxDetachedPerUser?: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
 *   clearTimer?: (t: ReturnType<typeof setTimeout>) => void,
 *   newId?: () => string,
 *   log?: (line: string) => void,
 * }} [opts]
 */
export function createSessionRegistry(opts = {}) {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const scrollbackChars = opts.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS;
  const maxDetached = Math.max(1, opts.maxDetachedPerUser ?? DEFAULT_MAX_DETACHED_PER_USER);
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const newId = opts.newId ?? (() => randomUUID());
  const log = opts.log ?? (() => {});
  /** @type {Map<string, Session>} */
  const sessions = new Map();

  /** @param {Session} session @param {Record<string, unknown>} msg */
  function broadcast(session, msg) {
    if (session.clients.size === 0) return;
    const text = JSON.stringify(msg);
    for (const client of session.clients) client.send(text);
  }

  /** @param {Session} session */
  function clearIdle(session) {
    if (session.idleTimer !== null) clearTimer(session.idleTimer);
    session.idleTimer = null;
  }

  /** @param {Session} session */
  function armIdle(session) {
    clearIdle(session);
    const timer = setTimer(() => {
      session.idleTimer = null;
      if (sessions.get(session.id) !== session || session.clients.size > 0) return;
      log(`[terminal-server] Session ${session.id} was not reattached for ${Math.round(idleMs / 60000)} min — ending it`);
      end(session);
    }, idleMs);
    // A timer must not keep a server that was asked to stop alive.
    /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (timer)).unref?.();
    session.idleTimer = timer;
  }

  /**
   * Kill the shell (if it still runs), close every client and forget the session.
   *
   * @param {Session} session
   */
  function end(session) {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    clearIdle(session);
    if (!session.exited) {
      try {
        session.pty.kill();
      } catch (err) {
        log(`[terminal-server] Failed to kill PTY pid=${session.pty.pid} of session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const clients = [...session.clients];
    session.clients.clear();
    for (const client of clients) client.close();
  }

  /**
   * Make room for one more of `owner`'s sessions: past the cap, the sessions
   * nobody is watching go, ended shells first, then the longest unwatched.
   *
   * @param {string} owner
   */
  function makeRoom(owner) {
    const unwatched = [...sessions.values()]
      .filter((s) => s.owner === owner && !s.ephemeral && s.clients.size === 0)
      .sort((a, b) => (a.exited ? 0 : 1) - (b.exited ? 0 : 1) || (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
    for (let i = 0; i <= unwatched.length - maxDetached; i++) {
      log(`[terminal-server] ${unwatched.length} sessions nobody is attached to — ending the oldest, ${unwatched[i].id}`);
      end(unwatched[i]);
    }
  }

  return {
    /**
     * @param {{ owner: string, pty: PtyLike, info?: Record<string, unknown>, ephemeral?: boolean }} spec
     * @returns {Session}
     */
    create({ owner, pty, info = {}, ephemeral = false }) {
      if (!ephemeral) makeRoom(owner);
      /** @type {Session} */
      const session = {
        id: newId(),
        owner,
        pty,
        info,
        ephemeral,
        claimed: false,
        clients: new Set(),
        scrollback: new Scrollback(scrollbackChars),
        exited: null,
        createdAt: now(),
        detachedAt: null,
        idleTimer: null,
      };
      sessions.set(session.id, session);
      pty.onData((data) => {
        if (!ephemeral) session.scrollback.append(data);
        broadcast(session, { type: "output", data });
      });
      pty.onExit(({ exitCode }) => {
        log(`[terminal-server] PTY exited pid=${pty.pid} code=${exitCode} session=${session.id}`);
        session.exited = { code: exitCode };
        broadcast(session, { type: "exit", code: exitCode });
        const clients = [...session.clients];
        // The sockets' own close events detach them; an ended shell is kept,
        // with its output, until the idle time runs out, so a page that comes
        // back shows how it ended instead of "no longer exists".
        for (const client of clients) client.close();
        // A session ended by hand or by the idle clock is already forgotten:
        // its shell exiting is the kill arriving, and needs no clock.
        if (sessions.get(session.id) !== session) return;
        if (ephemeral) end(session);
        else if (clients.length === 0 && session.idleTimer === null) armIdle(session);
      });
      return session;
    },

    /**
     * The session `id`, if it exists and belongs to `owner` — another user's
     * id is answered exactly as an unknown one.
     *
     * @param {string} id
     * @param {string} owner
     * @returns {Session | null}
     */
    get(id, owner) {
      const session = sessions.get(id);
      return session && session.owner === owner ? session : null;
    },

    /** @param {Session} session @param {SessionClient} client */
    attach(session, client) {
      if (sessions.get(session.id) !== session) {
        client.close();
        return;
      }
      clearIdle(session);
      session.detachedAt = null;
      session.clients.add(client);
    },

    /** A client spoke on the session (its first resize): a page knows the id now. @param {Session} session */
    claim(session) {
      session.claimed = true;
    },

    /**
     * A client's socket went away. The last one leaving an ephemeral session —
     * or a new session whose page never got as far as speaking on it (a reload
     * during the handshake, React's development double mount), whose id no
     * page can know — ends it; any other session starts its idle clock.
     *
     * @param {Session} session
     * @param {SessionClient} client
     */
    detach(session, client) {
      if (!session.clients.delete(client)) return;
      if (sessions.get(session.id) !== session || session.clients.size > 0) return;
      if (session.ephemeral || !session.claimed) {
        end(session);
        return;
      }
      session.detachedAt = now();
      armIdle(session);
    },

    end,

    /** Every session, for shutdown and tests. @returns {Session[]} */
    list() {
      return [...sessions.values()];
    },

    /** End everything — the server is stopping. */
    shutdown() {
      for (const session of [...sessions.values()]) end(session);
    },
  };
}

/** @typedef {ReturnType<typeof createSessionRegistry>} SessionRegistry */

/**
 * @typedef {object} SocketLike
 * @property {number} readyState
 * @property {(text: string) => void} send
 * @property {(code?: number) => void} close
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

const OPEN = 1;

/** @param {SocketLike} ws @param {Record<string, unknown>} msg */
function sendTo(ws, msg) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
}

/** @param {SocketLike} ws */
function closeQuietly(ws) {
  try {
    ws.close(1000);
  } catch {
    /* socket already gone */
  }
}

/**
 * Serve one WebSocket connection.
 *
 * @param {SessionRegistry} registry
 * @param {SocketLike} ws
 * @param {{
 *   owner: string,
 *   params: URLSearchParams,
 *   spawn: (params: URLSearchParams) => { pty: PtyLike, info: Record<string, unknown> },
 *   log?: (line: string) => void,
 * }} ctx
 */
export function handleConnection(registry, ws, { owner, params, spawn, log = () => {} }) {
  const endId = params.get("end");
  if (endId !== null) {
    const doomed = SESSION_ID_RE.test(endId) ? registry.get(endId, owner) : null;
    if (doomed) {
      log(`[terminal-server] Session ${doomed.id} closed by hand — ending it`);
      registry.end(doomed);
    }
    sendTo(ws, { type: doomed ? "ended" : "gone" });
    closeQuietly(ws);
    return;
  }

  const requested = params.get("session");
  /** @type {Session} */
  let session;
  if (requested === null || requested === "new") {
    /** @type {{ pty: PtyLike, info: Record<string, unknown> }} */
    let spawned;
    try {
      spawned = spawn(params);
    } catch (err) {
      // Spawning can fail (EAGAIN/ENOMEM under load, a missing shell, a
      // node-pty ABI mismatch). Contained to this one socket: the client is
      // told and the server — and every other session — stays up.
      const message = err instanceof Error ? err.message : String(err);
      log(`[terminal-server] Failed to spawn PTY: ${message}`);
      sendTo(ws, { type: "output", data: `\r\n[terminal-server] Failed to start shell: ${message}\r\n` });
      sendTo(ws, { type: "exit", code: 1 });
      closeQuietly(ws);
      return;
    }
    session = registry.create({ owner, pty: spawned.pty, info: spawned.info, ephemeral: requested === null });
    sendTo(ws, { type: "started", ...(session.ephemeral ? {} : { session: session.id }), ...spawned.info });
  } else {
    const found = SESSION_ID_RE.test(requested) ? registry.get(requested, owner) : null;
    if (!found) {
      sendTo(ws, { type: "gone" });
      closeQuietly(ws);
      return;
    }
    session = found;
    // Known to the page that asked for it by id: nothing to wait for.
    registry.claim(session);
    sendTo(ws, { type: "attached", session: session.id, ...session.info });
    const replay = session.scrollback.text();
    if (replay) sendTo(ws, { type: "output", data: replay, replay: true });
    if (session.exited) {
      sendTo(ws, { type: "exit", code: session.exited.code });
      closeQuietly(ws);
      return;
    }
  }

  /** @type {SessionClient} */
  const client = {
    send: (text) => {
      if (ws.readyState === OPEN) ws.send(text);
    },
    close: () => closeQuietly(ws),
  };
  registry.attach(session, client);

  ws.on("message", (/** @type {unknown} */ raw) => {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      log(`[terminal-server] Bad message: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    registry.claim(session);
    if (session.exited) return;
    try {
      if (msg?.type === "input" && typeof msg.data === "string") {
        session.pty.write(msg.data);
      } else if (msg?.type === "resize") {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
          session.pty.resize(cols, rows);
        } else {
          log(`[terminal-server] Ignoring invalid resize cols=${msg.cols} rows=${msg.rows}`);
        }
      }
    } catch (err) {
      // A write to a PTY that is exiting under us.
      log(`[terminal-server] PTY write failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on("close", () => registry.detach(session, client));
  ws.on("error", (/** @type {unknown} */ err) => {
    log(`[terminal-server] WebSocket error: ${err instanceof Error ? err.message : String(err)}`);
    registry.detach(session, client);
  });
}
