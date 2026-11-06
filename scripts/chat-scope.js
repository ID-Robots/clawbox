"use strict";

// The OpenClaw half of src/lib/chat-scope.ts, for production-server.js's
// gateway relay (scripts/gateway-user-relay.js), which runs as plain CommonJS
// before Next.js and cannot import the TypeScript module. The key shapes and
// the reasoning behind them are in that file; src/tests/unit/chat-scope.test.ts
// runs both copies over the same table so they cannot drift.
//
//   main  agent:<agentId>:clawbox-user-<name>
//   tab   agent:<agentId>:clawbox-utab-<12 hex>-<name>

const NAME = "[a-z_][a-z0-9_-]{0,31}";
const TAB_ID = "[0-9a-f]{12}";
const AGENT = "[a-z0-9][a-z0-9_-]{0,63}";

const USER_MAIN_RE = new RegExp(`^agent:(${AGENT}):clawbox-user-(${NAME})$`);
const USER_TAB_RE = new RegExp(`^agent:(${AGENT}):clawbox-utab-${TAB_ID}-(${NAME})$`);
const NAME_RE = new RegExp(`^${NAME}$`);

/** The agent a gateway key belongs to (`agent:<id>:…`), `main` for a bare key. */
function agentIdOfKey(key) {
  const m = /^agent:([^:]+):/.exec(String(key));
  return (m ? m[1] : "main").toLowerCase();
}

/** A user's main conversation, under the agent the gateway's own main key names. */
function openclawUserMainKey(gatewayMainKey, username) {
  if (typeof username !== "string" || !NAME_RE.test(username)) {
    throw new Error(`Not a ClawBox username: ${JSON.stringify(username)}`);
  }
  return `agent:${agentIdOfKey(gatewayMainKey)}:clawbox-user-${username}`;
}

/** The user an OpenClaw key belongs to, or null for a key in the owner's space. */
function chatKeyUser(key) {
  if (typeof key !== "string") return null;
  const k = key.trim().toLowerCase();
  const m = USER_MAIN_RE.exec(k) || USER_TAB_RE.exec(k);
  return m ? m[2] : null;
}

/** May `username` (never the owner: the relay is only for other users) use the session behind `key`? */
function userMayUseKey(username, key) {
  if (typeof key !== "string" || !key.trim()) return false;
  return chatKeyUser(key) === username;
}

module.exports = { agentIdOfKey, openclawUserMainKey, chatKeyUser, userMayUseKey };
