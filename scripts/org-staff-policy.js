"use strict";

// The organisation box's staff rules for production-server.js's user relay
// (scripts/gateway-user-relay.js): a CommonJS entry point cannot import
// TypeScript, so this mirrors src/lib/org-staff-policy.ts over the same table,
// config/org-staff-policy.json, and src/tests/unit/org-staff-policy.test.ts runs
// one case table through both.

const table = require("../config/org-staff-policy.json");

const STAFF_AGENT_PREFIX = table.agentPrefix;
const STAFF_SLASH_COMMANDS = Object.freeze([...table.slashCommands]);
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const COMMAND_WORD_RE = /(?<!\S)\/([A-Za-z][\w-]*)(?=$|[\s:])/g;
const BANG_COMMAND_RE = /^!/;

/** The OpenClaw agent of one member of staff, or null for a name that is not a username. */
function staffAgentId(username) {
  return typeof username === "string" && USERNAME_RE.test(username) ? `${STAFF_AGENT_PREFIX}${username}` : null;
}

/** May a member of staff send this chat message? See src/lib/org-staff-policy.ts. */
function staffMessageVerdict(message, options) {
  if (typeof message !== "string") return { ok: true };
  const text = message.trim();
  if (BANG_COMMAND_RE.test(text)) return { ok: false, command: "!" };
  const words = [...text.matchAll(COMMAND_WORD_RE)];
  if (words.length === 0) return { ok: true };
  const leading = text.startsWith("/") ? words[0] : null;
  if (leading) {
    const name = leading[1].toLowerCase();
    if (!STAFF_SLASH_COMMANDS.includes(name)) return { ok: false, command: `/${leading[1]}` };
    if (name === "new" && text.length > leading[0].length) return { ok: false, command: "/new <model>" };
  }
  if (!options || !options.inline) return { ok: true };
  for (const word of words) {
    if (word === leading) continue;
    return { ok: false, command: `/${word[1]}` };
  }
  return { ok: true };
}

function staffCommandRefusal(command) {
  return `${command} is not available on this organisation's ClawBox — ask your administrator. You can use /new and /reasoning.`;
}

function isStaffCatalogueCommand(name) {
  if (typeof name !== "string") return false;
  return STAFF_SLASH_COMMANDS.includes(name.trim().replace(/^\//, "").toLowerCase());
}

/**
 * Is `agentId` configured as a staff agent in this openclaw.json — present in
 * the roster (keyed `agents.entries`, or a legacy `agents.list`) WITH the staff
 * tool allow-list? The relay sends a member's turn only to an agent that
 * passes: a key on an agent the gateway does not have, or one whose policy
 * someone widened, must not run with the core's defaults (every tool).
 */
function staffAgentConfigured(config, agentId) {
  const agents = config && typeof config === "object" ? config.agents : null;
  if (!agents || typeof agents !== "object") return false;
  let entry = null;
  if (agents.entries !== undefined) {
    const entries = agents.entries;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      for (const [id, value] of Object.entries(entries)) {
        if (typeof id === "string" && id.toLowerCase() === agentId) entry = value;
      }
    }
  } else if (Array.isArray(agents.list)) {
    entry = agents.list.find((item) => item && typeof item === "object" && typeof item.id === "string" && item.id.toLowerCase() === agentId) || null;
  }
  if (!entry || typeof entry !== "object") return false;
  const tools = entry.tools;
  if (!tools || typeof tools !== "object" || !Array.isArray(tools.allow)) return false;
  const allowed = new Set(table.openclaw.allow);
  // Never more than the table names: a hand-widened allow-list is not staff.
  if (!tools.allow.every((tool) => typeof tool === "string" && allowed.has(tool))) return false;
  // The entry pins `profile: "full"` so the allow-list is the selection; no
  // `alsoAllow` may widen it.
  if (tools.profile !== "full" || tools.alsoAllow !== undefined) return false;
  const deny = Array.isArray(tools.deny) ? new Set(tools.deny) : new Set();
  return table.openclaw.deny.every((tool) => deny.has(tool));
}

/** The OpenClaw plugin that holds a staff agent's file tools to the member's folder. */
const STAFF_GUARD_PLUGIN_ID = "clawbox-staff-guard";

/**
 * Does this openclaw.json load the staff guard? The relay sends a member's
 * turn only while it does: without it the file tools the staff policy allows
 * would reach past the member's folder.
 */
function staffGuardEnabled(config) {
  const entry = config && config.plugins && config.plugins.entries ? config.plugins.entries[STAFF_GUARD_PLUGIN_ID] : null;
  return !!entry && typeof entry === "object" && entry.enabled === true;
}

module.exports = {
  STAFF_GUARD_PLUGIN_ID,
  staffGuardEnabled,
  STAFF_AGENT_PREFIX,
  STAFF_SLASH_COMMANDS,
  staffAgentId,
  staffMessageVerdict,
  staffCommandRefusal,
  isStaffCatalogueCommand,
  staffAgentConfigured,
};
