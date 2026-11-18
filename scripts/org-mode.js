"use strict";

// The owner's organisation-box switch (`org_mode`), for production-server.js:
// socket upgrades never reach Next, so the proxy reads config.json itself.
// The rule and the name are src/lib/org-mode.ts's, mirrored here because a
// CommonJS entry point cannot import TypeScript; a unit test pins the two.
//
// On an organisation box a member of staff (any signed-in ClawBox user who is
// not the owner) gets Chat, Files and their own Settings, so the only socket
// left to them is their own chat (`userChat`, always relayed through
// scripts/gateway-user-relay.js). The Terminal, the remote desktop and the
// gateway's root socket (the Control UI, shared or not) are the owner's.

/** The key in data/config.json. */
const ORG_MODE_KEY = "org_mode";

/** Only a literal `true` is an organisation box. */
function orgModeFrom(value) {
  return value === true;
}

/**
 * Whether an organisation box refuses this admitted upgrade: never the
 * owner's, never on a home box, never a user's own chat socket.
 *
 * @param {{ userChat?: boolean }} gate the upgrade route
 * @param {{ isOwner: boolean } | null} identity who the cookie speaks for
 * @param {boolean} orgMode the switch as config.json holds it
 */
function orgModeRefusesUpgrade(gate, identity, orgMode) {
  if (!orgMode || !identity || identity.isOwner) return false;
  return !gate.userChat;
}

module.exports = { ORG_MODE_KEY, orgModeFrom, orgModeRefusesUpgrade };
