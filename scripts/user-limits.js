"use strict";

/**
 * Limits for the people on a ClawBox who are NOT its owner (TASK-2446) — the
 * one implementation, required by production-server.js's CommonJS (the
 * user-chat relay counts a user's chat turns, scripts/gateway-user-relay.js)
 * and re-exported for the TypeScript side by src/lib/user-limits.ts, which
 * explains the rules.
 *
 * Pure: no fs, no Next. The relay and the Next routes live in ONE process
 * (production-server.js requires Next's standalone server), but each loads its
 * own copy of this module, so the chat counter lives on `globalThis` under a
 * registered symbol: both copies count into the same window.
 */

/** The key in data/config.json. Absent or damaged: every limit at its default. */
const USER_LIMITS_KEY = "user_limits";

const MB = 1024 * 1024;

/**
 * Each limit: its default and the largest value the owner may set. 0 is "no
 * limit" for every one of them. The defaults are generous on purpose — a
 * single-user box has nobody they apply to, and on a shared box they stop
 * runaway use, not ordinary work:
 *
 *   - `uploadMaxMb`   one file a user uploads to Files or attaches in chat;
 *   - `homeQuotaMb`   what a user's own home folder may hold (the folder an
 *                     organisation box serves them as Files' Home);
 *   - `chatPerMinute` / `chatPerHour`  chat turns a user may start, counted
 *                     over a sliding minute and a sliding hour.
 */
const USER_LIMIT_FIELDS = Object.freeze({
  uploadMaxMb: Object.freeze({ default: 100, max: 1024 * 1024 }),
  homeQuotaMb: Object.freeze({ default: 10 * 1024, max: 64 * 1024 * 1024 }),
  chatPerMinute: Object.freeze({ default: 20, max: 10_000 }),
  chatPerHour: Object.freeze({ default: 300, max: 1_000_000 }),
});

const USER_LIMIT_NAMES = Object.freeze(Object.keys(USER_LIMIT_FIELDS));

/** @typedef {{ uploadMaxMb: number, homeQuotaMb: number, chatPerMinute: number, chatPerHour: number }} UserLimits */

/** @returns {UserLimits} */
function defaultUserLimits() {
  return {
    uploadMaxMb: USER_LIMIT_FIELDS.uploadMaxMb.default,
    homeQuotaMb: USER_LIMIT_FIELDS.homeQuotaMb.default,
    chatPerMinute: USER_LIMIT_FIELDS.chatPerMinute.default,
    chatPerHour: USER_LIMIT_FIELDS.chatPerHour.default,
  };
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function validLimit(name, value) {
  const field = USER_LIMIT_FIELDS[name];
  return !!field && typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= field.max;
}

/**
 * The limits as stored, read defensively: a field that is missing, not a
 * whole number or out of range is its default — a hand-edited or damaged
 * value never turns a limit off.
 *
 * @param {unknown} raw
 * @returns {UserLimits}
 */
function userLimitsFrom(raw) {
  const out = defaultUserLimits();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const name of USER_LIMIT_NAMES) {
    const value = /** @type {Record<string, unknown>} */ (raw)[name];
    if (validLimit(name, value)) out[name] = /** @type {number} */ (value);
  }
  return out;
}

/**
 * Judge an owner's change: every field named must be a whole number from 0 to
 * its maximum, and at least one must be named. Fields not named keep their
 * value. Never coerces ("100" is refused, not read as 100).
 *
 * @param {unknown} body
 * @returns {{ ok: true, patch: Partial<UserLimits> } | { ok: false, field: string | null }}
 */
function userLimitsPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: null };
  /** @type {Partial<UserLimits>} */
  const patch = {};
  for (const name of USER_LIMIT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(body, name)) continue;
    const value = /** @type {Record<string, unknown>} */ (body)[name];
    if (!validLimit(name, value)) return { ok: false, field: name };
    patch[name] = /** @type {number} */ (value);
  }
  return Object.keys(patch).length > 0 ? { ok: true, patch } : { ok: false, field: null };
}

/**
 * @param {number} mb
 * @returns {number | null} bytes, or null for "no limit"
 */
function mbToBytes(mb) {
  return mb > 0 ? mb * MB : null;
}

// ── Chat turns, per user ─────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const STORE_KEY = Symbol.for("clawbox.userLimits.chatRequests");

/** username → the times (ms, oldest first) of their admitted turns in the last hour. */
function chatStore() {
  const g = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  let store = g[STORE_KEY];
  if (!(store instanceof Map)) {
    store = new Map();
    g[STORE_KEY] = store;
  }
  return /** @type {Map<string, number[]>} */ (store);
}

/**
 * @typedef {{ ok: true } | { ok: false, window: "minute" | "hour", limit: number, retryAfterSeconds: number }} ChatVerdict
 */

/**
 * May `username` start one more chat turn now? Admitted turns are counted, a
 * refused one is not — waiting the time it names is enough. Sliding windows,
 * so there is no edge at the top of the minute to burst across. The owner is
 * never asked: callers skip it.
 *
 * @param {string} username
 * @param {Pick<UserLimits, "chatPerMinute" | "chatPerHour">} limits
 * @param {number} [now]
 * @returns {ChatVerdict}
 */
function admitChatRequest(username, limits, now = Date.now()) {
  const perMinute = limits && Number.isInteger(limits.chatPerMinute) && limits.chatPerMinute > 0 ? limits.chatPerMinute : 0;
  const perHour = limits && Number.isInteger(limits.chatPerHour) && limits.chatPerHour > 0 ? limits.chatPerHour : 0;
  if (!perMinute && !perHour) return { ok: true };
  const store = chatStore();
  const keepMs = perHour ? HOUR_MS : MINUTE_MS;
  const times = (store.get(username) || []).filter((t) => t > now - keepMs && t <= now);
  if (perMinute) {
    const lastMinute = times.filter((t) => t > now - MINUTE_MS);
    if (lastMinute.length >= perMinute) {
      store.set(username, times);
      const frees = lastMinute[lastMinute.length - perMinute] + MINUTE_MS;
      return { ok: false, window: "minute", limit: perMinute, retryAfterSeconds: Math.max(1, Math.ceil((frees - now) / 1000)) };
    }
  }
  if (perHour && times.length >= perHour) {
    store.set(username, times);
    const frees = times[times.length - perHour] + HOUR_MS;
    return { ok: false, window: "hour", limit: perHour, retryAfterSeconds: Math.max(1, Math.ceil((frees - now) / 1000)) };
  }
  times.push(now);
  // Never more than either window can refuse on.
  const cap = Math.max(perMinute, perHour);
  store.set(username, times.length > cap ? times.slice(times.length - cap) : times);
  return { ok: true };
}

/**
 * Forget a user's count (their account was removed), or everyone's.
 * @param {string} [username]
 */
function forgetChatRequests(username) {
  if (username === undefined) chatStore().clear();
  else chatStore().delete(username);
}

/**
 * The sentence a refused turn answers with, on both runtimes. Its exact shape
 * is read back by the chat (src/lib/chat-error-text.ts, `userChatLimitSentence`),
 * which shows it in place of the generic failure line.
 *
 * @param {{ window: "minute" | "hour", limit: number, retryAfterSeconds: number }} verdict
 */
function chatLimitSentence(verdict) {
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterSeconds));
  const wait = seconds < 120
    ? `${seconds} ${seconds === 1 ? "second" : "seconds"}`
    : `${Math.ceil(seconds / 60)} minutes`;
  const what = `${verdict.limit} ${verdict.limit === 1 ? "message" : "messages"} ${verdict.window === "minute" ? "a minute" : "an hour"}`;
  return `You have reached your chat limit on this ClawBox: ${what}. Try again in ${wait}.`;
}

module.exports = {
  USER_LIMITS_KEY,
  USER_LIMIT_FIELDS,
  USER_LIMIT_NAMES,
  defaultUserLimits,
  userLimitsFrom,
  userLimitsPatch,
  mbToBytes,
  admitChatRequest,
  forgetChatRequests,
  chatLimitSentence,
};
