// A socket's session, watched for as long as the socket is open.
//
// A WebSocket is admitted once, at its upgrade, and then lives for as long as
// the tab does. production-server.js checked the `clawbox_session` cookie at
// that one moment and never again, so a chat, a terminal or a remote desktop
// opened before the session ran out kept working long after every HTTP request
// from the same desktop was answered 401 — the session gate covered requests,
// never connections.
//
// Each admitted socket is registered here with the cookie it came in on and is
// closed the moment that cookie would no longer be accepted:
//
//   - at its own expiry, by a timer set for the cookie's `exp`;
//   - on revocation — a password change bumps the session generation, removing
//     a ClawBox user drops them from the registry — by re-judging every open
//     socket's cookie every `recheckMs`.
//
// Both go through the same `verify` the upgrade gate uses, so a socket is
// closed for exactly the reasons its upgrade would be refused now. Nothing here
// throws: it runs inside the server's timers, where an uncaught throw would take
// the whole web server down.

"use strict";

/**
 * The close code a browser sees when the box ends its socket because the
 * session is over — an application code (4000-4999, RFC 6455 §7.4.2), mirrored
 * as SESSION_EXPIRED_CLOSE_CODE in src/lib/session-expiry.ts, which reads it as
 * "signed out" and sends the page to /login.
 */
const SESSION_EXPIRED_CLOSE_CODE = 4401;
const SESSION_EXPIRED_CLOSE_REASON = "Session expired";

/** How often an open socket's session is re-judged for a revocation. */
const DEFAULT_RECHECK_MS = 10_000;

// setTimeout's ceiling; a later expiry is simply re-armed when it fires.
const MAX_TIMER_MS = 2 ** 31 - 1;
// A re-armed expiry timer never spins: a clock that disagrees with the
// cookie's `exp` by a few hundred milliseconds waits at least this long.
const MIN_REARM_MS = 1_000;

/** A positive integer from the environment, or the fallback. */
function recheckMsFromEnv(value, fallback = DEFAULT_RECHECK_MS) {
  const ms = Number(value);
  return Number.isInteger(ms) && ms > 0 ? ms : fallback;
}

/**
 * @param {{
 *   verify: (cookieHeader: string | undefined) => { exp: number } | null,
 *   recheckMs?: number,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 * }} options
 */
function createUpgradeSessionWatch({ verify, recheckMs = DEFAULT_RECHECK_MS, now = Date.now, timers = globalThis }) {
  const live = new Set();
  let sweep = null;

  const unref = (handle) => {
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  };

  function forget(entry) {
    if (!live.delete(entry)) return;
    if (entry.timer) timers.clearTimeout(entry.timer);
    entry.timer = null;
    if (live.size === 0 && sweep) {
      timers.clearInterval(sweep);
      sweep = null;
    }
  }

  /** Close the socket unless its cookie still verifies; true while it stays open. */
  function judge(entry) {
    if (!live.has(entry)) return false;
    let session = null;
    try {
      session = verify(entry.cookieHeader);
    } catch {
      session = null;
    }
    if (session) return true;
    forget(entry);
    try {
      entry.close();
    } catch {
      // the socket is already gone
    }
    return false;
  }

  function armExpiry(entry, exp, minMs) {
    if (typeof exp !== "number" || !Number.isFinite(exp)) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(minMs, exp * 1000 - now()));
    entry.timer = unref(timers.setTimeout(() => {
      entry.timer = null;
      if (judge(entry)) armExpiry(entry, exp, MIN_REARM_MS);
    }, delay));
  }

  /**
   * Watch one admitted socket. `session` is what `verify` answered for its
   * upgrade; `close` ends the socket (and whatever it is relayed to). Returns
   * the function to call when the socket closes on its own.
   */
  function watch(cookieHeader, session, close) {
    const entry = { cookieHeader, close, timer: null };
    live.add(entry);
    armExpiry(entry, session && session.exp, 0);
    if (!sweep) {
      sweep = unref(timers.setInterval(() => {
        for (const e of [...live]) judge(e);
      }, recheckMs));
    }
    return () => forget(entry);
  }

  return { watch, size: () => live.size };
}

module.exports = {
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_CLOSE_REASON,
  DEFAULT_RECHECK_MS,
  recheckMsFromEnv,
  createUpgradeSessionWatch,
};
