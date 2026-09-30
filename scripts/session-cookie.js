// The `clawbox_session` cookie check for WebSocket upgrades, in CommonJS.
//
// Upgrades never reach Next.js, so production-server.js verifies the cookie
// itself before it proxies /terminal-ws or /novnc-ws. It used to answer only
// "is there a valid session"; since multi-user ClawBox OS (TASK-1256) it has to
// answer WHOSE, because the Terminal starts its shell as the signed-in Linux
// user and the remote desktop stays the owner's.
//
// The rule is src/lib/session-identity.ts's, mirrored because this file cannot
// import TypeScript. src/tests/unit/session-identity.test.ts runs the same
// table against both, so the two cannot drift apart unnoticed:
//
//   no `u` claim           → the owner (every cookie minted before TASK-1256)
//   `u` = the owner        → the owner
//   `u` = registered user  → that user, while the registry lists them with the
//                            same session version `sv`
//   anything else          → nobody
//
// Every function fails closed and never throws — this runs inside the
// `upgrade` listener, where an uncaught throw would take the whole server down.

"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("crypto");
const os = require("os");

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SV_RE = /^[0-9a-f]{8,64}$/;
const USERS_CONFIG_KEY = "clawbox_users";

/** The owner's Linux username — src/lib/owner-username.ts's rule. */
function ownerUsername() {
  let osUsername;
  try {
    osUsername = os.userInfo().username;
  } catch {
    osUsername = undefined;
  }
  return process.env.CLAWBOX_USER
    || process.env.SUDO_USER
    || process.env.USER
    || osUsername
    || "clawbox";
}

/** config.json's `clawbox_users` → Map(username → session version), well-formed entries only. */
function parseUserRegistry(raw, owner) {
  const users = new Map();
  if (!Array.isArray(raw)) return users;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { username, sv } = item;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) continue;
    if (typeof sv !== "string" || !SV_RE.test(sv)) continue;
    if (username === owner || users.has(username)) continue;
    users.set(username, sv);
  }
  return users;
}

/** A verified payload → `{ username, isOwner }`, or null. */
function identityFromClaims(claims, owner, users) {
  const u = claims.u;
  if (u === undefined) return { username: owner, isOwner: true };
  if (typeof u !== "string") return null;
  if (u === owner) return { username: owner, isOwner: true };
  const sv = users.get(u);
  if (sv === undefined) return null;
  if (typeof claims.sv !== "string" || claims.sv !== sv) return null;
  return { username: u, isOwner: false };
}

/**
 * Verify the cookie in a raw `Cookie` header and say who it speaks for.
 *
 * @param {string | undefined} cookieHeader
 * @param {{ secret?: string, sessionGen: number, users: Map<string, string>, owner: string }} facts
 * @returns {{ username: string, isOwner: boolean } | null}
 */
function sessionIdentityFromCookieHeader(cookieHeader, facts) {
  try {
    const secret = facts.secret;
    if (!secret) return null;
    const m = /(?:^|;\s*)clawbox_session=([^;]+)/.exec(cookieHeader || "");
    if (!m) return null;
    const cookie = decodeURIComponent(m[1]);
    const dot = cookie.indexOf(".");
    if (dot < 0) return null;
    const payload = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const data = JSON.parse(decoded);
    if (typeof data !== "object" || data === null) return null;
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return null;
    // Reject cookies from before the last password change (session revocation).
    if ((typeof data.gen === "number" ? data.gen : 0) !== facts.sessionGen) return null;
    return identityFromClaims(data, facts.owner, facts.users);
  } catch {
    return null;
  }
}

module.exports = {
  USERS_CONFIG_KEY,
  ownerUsername,
  parseUserRegistry,
  identityFromClaims,
  sessionIdentityFromCookieHeader,
};
