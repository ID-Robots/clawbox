"use strict";

// The owner's "Share OpenClaw with all users" switch, for production-server.js:
// socket upgrades never reach Next, so the proxy reads config.json itself. The
// rule and the names are src/lib/non-owner-scope.ts's, mirrored here because a
// CommonJS entry point cannot import TypeScript; a unit test pins the two.

/** The key in data/config.json. */
const OPENCLAW_SHARED_KEY = "openclaw_shared_with_users";

/** A ClawBox user's own chat socket: always relayed (scripts/gateway-user-relay.js). */
const USER_CHAT_WS_PATH = "/user-chat-ws";

/** Only a literal `true` shares. */
function openclawSharedFrom(value) {
  return value === true;
}

module.exports = { OPENCLAW_SHARED_KEY, USER_CHAT_WS_PATH, openclawSharedFrom };
