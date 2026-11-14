// What a member of staff's assistant may do on an organisation box
// (TASK-2444, TASK-2445). The table is config/org-staff-policy.json; this is
// its TypeScript reader and the pure rules built on it. scripts/org-staff-policy.js
// is the CommonJS mirror the user relay (scripts/gateway-user-relay.js) runs, and
// src/tests/unit/org-staff-policy.test.ts holds one case table to both.
//
// Pure: no `fs`, no Next. The server halves are src/lib/org-staff-agents.ts
// (the OpenClaw roster) and src/lib/hermes-staff-profile.ts (the Hermes profile).

import table from "../../config/org-staff-policy.json";

/** Every member of staff's agent (OpenClaw) and profile (Hermes) id starts with this. */
export const STAFF_AGENT_PREFIX: string = table.agentPrefix;

/** The prefix of every OpenClaw `mcp.servers` entry ClawBox writes for a member of staff (src/lib/staff-mcp.ts). */
export const STAFF_MCP_ENTRY_PREFIX: string = table.mcpEntryPrefix;

/** The slash commands a member of staff may send, without the slash. */
export const STAFF_SLASH_COMMANDS: readonly string[] = Object.freeze([...table.slashCommands]);

export const STAFF_OPENCLAW_TOOLS = Object.freeze({
  allow: Object.freeze([...table.openclaw.allow]) as readonly string[],
  deny: Object.freeze([...table.openclaw.deny]) as readonly string[],
  writeTools: Object.freeze([...table.openclaw.writeTools]) as readonly string[],
  readTools: Object.freeze([...table.openclaw.readTools]) as readonly string[],
});

export const STAFF_HERMES_TOOLS = Object.freeze({
  toolsets: Object.freeze([...table.hermes.toolsets]) as readonly string[],
  disabledToolsets: Object.freeze([...table.hermes.disabledToolsets]) as readonly string[],
  allowTools: Object.freeze([...table.hermes.allowTools]) as readonly string[],
  writeTools: Object.freeze([...table.hermes.writeTools]) as readonly string[],
  readTools: Object.freeze([...table.hermes.readTools]) as readonly string[],
});

/** ClawBox usernames (src/lib/username-rules.ts); anything else names no member of staff. */
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** The agent (OpenClaw) / profile (Hermes) id of one member of staff, or null for a name that is not a username. */
export function staffAgentId(username: string): string | null {
  return typeof username === "string" && USERNAME_RE.test(username) ? `${STAFF_AGENT_PREFIX}${username}` : null;
}

/** The member of staff an agent or profile id belongs to, or null when it is not a staff id. */
export function staffUsernameFromAgentId(agentId: unknown): string | null {
  if (typeof agentId !== "string" || !agentId.startsWith(STAFF_AGENT_PREFIX)) return null;
  const name = agentId.slice(STAFF_AGENT_PREFIX.length);
  return USERNAME_RE.test(name) ? name : null;
}

/** Is this id one of ClawBox's staff agents/profiles? */
export function isStaffAgentId(agentId: unknown): boolean {
  return staffUsernameFromAgentId(agentId) !== null;
}

// ─── Slash commands ─────────────────────────────────────────────────────────

/**
 * A word that starts with `/` at the start of the text or after whitespace —
 * the shape both cores read a command or an inline directive in
 * (`(?<!\S)\/name` in OpenClaw's directive parser; a leading `/name` in Hermes'
 * slash dispatch). `/think:high` and `/model x` both match; a path such as
 * `/srv/shared/report.pdf` does not (the word runs on into another `/`), nor does
 * `and/or` or `1/2`.
 */
const COMMAND_WORD_RE = /(?<!\S)\/([A-Za-z][\w-]*)(?=$|[\s:])/g;

/** OpenClaw's `! <command>` alias for `/bash`. */
const BANG_COMMAND_RE = /^!/;

export type StaffMessageVerdict =
  | { ok: true }
  | { ok: false; command: string };

/**
 * May a member of staff send this chat message?
 *
 *   - A message that STARTS with a command may start only with `/new` (alone:
 *     `/new <model>` would pick a model) or `/reasoning` (with its own
 *     argument).
 *   - `inline` (OpenClaw): no OTHER command word anywhere in the text, because
 *     the core strips and applies a directive such as `/model x` or `/think`
 *     from the middle of an ordinary message too ("Directive behavior details",
 *     docs/tools/slash-commands.md). Hermes reads a command only at the start.
 *   - A message starting with `!` is OpenClaw's shell alias and is refused on
 *     both runtimes.
 *
 * `command` names what was refused, for the refusal the member reads.
 */
export function staffMessageVerdict(message: unknown, options: { inline: boolean }): StaffMessageVerdict {
  if (typeof message !== "string") return { ok: true };
  const text = message.trim();
  if (BANG_COMMAND_RE.test(text)) return { ok: false, command: "!" };
  const words = [...text.matchAll(COMMAND_WORD_RE)];
  if (words.length === 0) return { ok: true };
  const leading = text.startsWith("/") ? words[0] : null;
  if (leading) {
    const name = leading[1].toLowerCase();
    if (!STAFF_SLASH_COMMANDS.includes(name)) return { ok: false, command: `/${leading[1]}` };
    // `/new` takes no argument from a member of staff: its argument is a model.
    if (name === "new" && text.length > leading[0].length) return { ok: false, command: "/new <model>" };
  }
  if (!options.inline) return { ok: true };
  for (const word of words) {
    if (word === leading) continue;
    return { ok: false, command: `/${word[1]}` };
  }
  return { ok: true };
}

/** The sentence a member of staff reads when a command is refused. */
export function staffCommandRefusal(command: string): string {
  return `${command} is not available on this organisation's ClawBox — ask your administrator. You can use /new and /reasoning.`;
}

/**
 * The rows of a command catalogue a member of staff is shown: `/new` and
 * `/reasoning` only. Works on either runtime's row shape (`name` or `id`,
 * with or without the slash).
 */
export function isStaffCatalogueCommand(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return STAFF_SLASH_COMMANDS.includes(name.trim().replace(/^\//, "").toLowerCase());
}
