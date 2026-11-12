/**
 * A member of staff's own OpenClaw agent on an organisation box (TASK-2444,
 * TASK-2445). SERVER ONLY.
 *
 * WHY AN AGENT EACH. The pinned core's own rule for people who must not reach
 * each other's tools, sessions or files is "give them separate agents"
 * (docs/concepts/multi-user.md, "Trust boundary"), and an agent is exactly the
 * unit both halves of the task need:
 *
 *   * its TOOLS — `agents.entries.<id>.tools.allow` / `.deny`, which the core
 *     intersects with every other policy layer and applies before a model sees
 *     a tool (docs/tools/multi-agent-sandbox-tools.md, "Tool restrictions").
 *     The lists are config/org-staff-policy.json's; no web, no browser, no
 *     messages, no automations or sub-agents, no generation, no shell, none of
 *     the device's MCP tools, no gateway/config/plugin/update tools;
 *   * its MEMORY — its own workspace (`MEMORY.md`, `memory/`) and its own
 *     memory index in its own agent database, so "remember X" said to one
 *     member's assistant can only be read back by that member's assistant, and
 *     never lands in the owner's MEMORY.md.
 *
 * The workspace is `<OpenClaw home>/staff/<name>`: under the state directory,
 * where the Files app's carve-out (`workspace` / `workspace-<x>`,
 * src/lib/file-guard.ts) does NOT reach, so no other user opens it in Files.
 * It is also the member's own folder for anything the assistant writes for
 * them; clawbox-staff-guard (scripts/openclaw-plugins/) holds the file tools
 * to it.
 *
 * THE ROSTER. A box that never had more than the owner's agent has no roster
 * at all — the core's implicit `main`. Adding a second agent makes it a fleet,
 * and the core then routes nothing to an agent nobody named
 * (docs/concepts/multi-agent.md, "Routing rules"), so the same write names the
 * owner's agent: `agents.defaults.systemAgent.agentId` (which catches every
 * unbound channel message and owns heartbeats), `agents.ownership:
 * "explicit"` (Doctor would add it anyway), and the owner's agent's own entry
 * with its workspace pinned where it already is. Only what is ABSENT is
 * written, and what ClawBox wrote is recorded in the device store
 * (`org_staff_roster`). Turning the switch off — or removing the last member
 * of staff — removes the staff agents through the core's own `agents.delete`
 * and leaves those three: they name the agent the core already resolved, with
 * the workspace it already had, so the owner's assistant is unchanged.
 *
 * Applied through the running gateway (`agents.*` is hot in the core's reload
 * table, src/lib/gateway-hot-apply.ts): no restart, no dropped chat.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import path from "@/lib/runtime-path";
import { isDeepStrictEqual } from "node:util";
import { get, set } from "@/lib/config-store";
import { listUsers } from "@/lib/clawbox-users";
import { readOrgMode } from "@/lib/org-mode-server";
import { resolveDefaultAgentId } from "@/lib/openclaw-default-agent";
import {
  STAFF_MCP_ENTRY_PREFIX,
  STAFF_OPENCLAW_TOOLS,
  isStaffAgentId,
  staffAgentId,
} from "@/lib/org-staff-policy";
import type { StaffMcpEntry } from "@/lib/staff-mcp";

/** The device-store key recording what ClawBox added to the roster to make room for staff. */
export const ORG_STAFF_ROSTER_KEY = "org_staff_roster";

/** What ClawBox wrote around the staff agents, so it can take exactly that back. */
export interface StaffRosterMarks {
  /** The owner's agent's entry `{ workspace }`, written because the box had no roster. */
  ownerEntry: { id: string; workspace: string } | null;
  /** `agents.ownership: "explicit"`. */
  ownership: boolean;
  /** `agents.defaults.systemAgent.agentId` = the owner's agent. */
  systemAgent: string | null;
}

export const NO_MARKS: StaffRosterMarks = Object.freeze({ ownerEntry: null, ownership: false, systemAgent: null });

/** One write of a plan: a set (`value`) or an unset (`value` undefined). */
export interface RosterWrite {
  path: string;
  value?: unknown;
}

export interface StaffRosterPlan {
  writes: RosterWrite[];
  marks: StaffRosterMarks;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A config path segment, bracket-quoted: agent ids carry `-`. */
function entryPath(id: string): string {
  return `agents.entries[${JSON.stringify(id)}]`;
}

/** A member of staff's workspace — their memory and their own folder. */
export function staffWorkspaceDir(openclawHome: string, username: string): string {
  return path.join(openclawHome, "staff", username);
}

/**
 * The deny every agent that is NOT a member of staff's carries while any
 * member has a granted MCP server (src/lib/staff-mcp.ts): those entries carry
 * a member's relay token, so the owner's agents neither list nor call them.
 */
export const STAFF_MCP_DENY_GLOB = `${STAFF_MCP_ENTRY_PREFIX}*`;

/** A config path to one `mcp.servers` entry. */
function mcpServerPath(name: string): string {
  return `mcp.servers[${JSON.stringify(name)}]`;
}

/**
 * The roster entry of one member of staff's agent. `mcpEntries` are the names
 * of their own relay entries (src/lib/staff-mcp.ts): each adds `<entry>__*` to
 * the allow-list — that member's granted tools, and nobody else's.
 */
export function staffAgentEntry(openclawHome: string, username: string, mcpEntries: readonly string[] = []): Json {
  return {
    name: `${username} (staff)`,
    workspace: staffWorkspaceDir(openclawHome, username),
    // No skills: a skill is instructions that may lean on tools staff do not have.
    skills: [],
    // No sub-agents of any agent, its own included (`sessions_spawn` is denied too).
    subagents: { allowAgents: [] },
    tools: {
      // The allow-list below is the whole selection, whatever the box-wide
      // `tools.profile` says: a global profile the owner (or the owner's
      // agent) flips to `full` or `coding` neither widens nor starves it.
      profile: "full",
      allow: [...STAFF_OPENCLAW_TOOLS.allow, ...mcpEntries.map((name) => `${name}__*`)],
      deny: [...STAFF_OPENCLAW_TOOLS.deny],
      elevated: { enabled: false },
    },
  };
}

interface RosterView {
  shape: "none" | "entries" | "list";
  ids: string[];
  entryOf(id: string): Json | null;
}

function viewRoster(config: unknown): RosterView {
  const agents = isRecord(config) && isRecord(config.agents) ? config.agents : null;
  if (agents && agents.entries !== undefined) {
    const entries = isRecord(agents.entries) ? agents.entries : {};
    return {
      shape: "entries",
      ids: Object.keys(entries).map((id) => id.toLowerCase()),
      entryOf: (id) => {
        for (const [key, value] of Object.entries(entries)) if (key.toLowerCase() === id && isRecord(value)) return value;
        return null;
      },
    };
  }
  if (agents && Array.isArray(agents.list)) {
    const list = agents.list.filter(isRecord);
    return {
      shape: "list",
      ids: list.map((entry) => String(entry.id ?? "").toLowerCase()).filter(Boolean),
      entryOf: (id) => list.find((entry) => String(entry.id ?? "").toLowerCase() === id) ?? null,
    };
  }
  return { shape: "none", ids: [], entryOf: () => null };
}

export interface StaffRosterInput {
  /** The members of staff who get an agent: everyone in `clawbox_users` while `org_mode` is on, else none. */
  staff: readonly string[];
  /** Where OpenClaw keeps its state (`~/.openclaw`). */
  openclawHome: string;
  /** The owner's agent's workspace as the gateway resolves it today. */
  ownerWorkspace: string;
  /** What an earlier sync recorded, or null. */
  marks: StaffRosterMarks | null;
  /** Each member's granted MCP relay entries (src/lib/staff-mcp.ts); none when absent. */
  mcp?: ReadonlyMap<string, readonly StaffMcpEntry[]>;
}

/** `deny` with the staff MCP glob added (`want`) or taken out, or undefined when nothing changes. */
function nextDeny(current: unknown, want: boolean): { changed: boolean; value: string[] | undefined } {
  const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === "string") : [];
  const has = list.includes(STAFF_MCP_DENY_GLOB);
  if (want === has) return { changed: false, value: list };
  if (want) return { changed: true, value: [...list, STAFF_MCP_DENY_GLOB] };
  const rest = list.filter((v) => v !== STAFF_MCP_DENY_GLOB);
  return { changed: true, value: rest.length > 0 ? rest : undefined };
}

/**
 * The writes that make `config`'s roster hold exactly the staff agents of
 * `input.staff`, and the marks to record after. Pure.
 */
export function planStaffRoster(config: unknown, input: StaffRosterInput): StaffRosterPlan {
  const view = viewRoster(config);
  const agents = isRecord(config) && isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const marks: StaffRosterMarks = { ...NO_MARKS, ...(input.marks ?? {}) };
  const writes: RosterWrite[] = [];

  const wanted = new Map<string, Json>();
  const mcpWanted = new Map<string, Json>();
  for (const username of input.staff) {
    const id = staffAgentId(username);
    const grants = input.mcp?.get(username) ?? [];
    if (id) {
      wanted.set(id, staffAgentEntry(input.openclawHome, username, grants.map((entry) => entry.name)));
      for (const entry of grants) mcpWanted.set(entry.name, entry.config);
    }
  }
  const anyMcp = mcpWanted.size > 0;
  const present = view.ids.filter((id) => isStaffAgentId(id));
  const others = view.ids.filter((id) => !isStaffAgentId(id));
  // The owner's agent — never a member of staff's, even on a roster that (by
  // hand) holds nothing else.
  const resolved = resolveDefaultAgentId(config);
  const owner = isStaffAgentId(resolved) ? others[0] ?? "main" : resolved;

  if (view.shape === "list") {
    // A legacy roster is one array: rewritten whole, the owner's entries as
    // they are (but for the staff MCP deny, below).
    const list = (agents.list as unknown[])
      .filter((entry) => !(isRecord(entry) && isStaffAgentId(String(entry.id ?? "").toLowerCase())))
      .map((entry) => {
        if (!isRecord(entry)) return entry;
        const tools = isRecord(entry.tools) ? entry.tools : {};
        const deny = nextDeny(tools.deny, anyMcp);
        if (!deny.changed) return entry;
        const { deny: _old, ...restTools } = tools;
        const nextTools = deny.value ? { ...restTools, deny: deny.value } : restTools;
        const { tools: _t, ...restEntry } = entry;
        return Object.keys(nextTools).length > 0 ? { ...restEntry, tools: nextTools } : restEntry;
      });
    const next = [...list, ...[...wanted].map(([id, entry]) => ({ id, ...entry }))];
    if (!isDeepStrictEqual(next, agents.list)) writes.push({ path: "agents.list", value: next });
  } else {
    for (const id of present) {
      if (!wanted.has(id)) writes.push({ path: entryPath(id) });
    }
    for (const [id, entry] of wanted) {
      if (!isDeepStrictEqual(view.entryOf(id), entry)) writes.push({ path: entryPath(id), value: entry });
    }
    // The owner's agents never see a member's relay entries.
    const entries = isRecord(agents.entries) ? agents.entries : {};
    for (const [key, value] of Object.entries(entries)) {
      if (isStaffAgentId(key.toLowerCase()) || !isRecord(value)) continue;
      const tools = isRecord(value.tools) ? value.tools : {};
      const deny = nextDeny(tools.deny, anyMcp);
      if (deny.changed) writes.push({ path: `${entryPath(key)}.tools.deny`, ...(deny.value ? { value: deny.value } : {}) });
    }
  }

  // The members' relay entries in `mcp.servers`: exactly the wanted ones of
  // ClawBox's prefix, every other server untouched.
  const mcpConfig = isRecord(config) && isRecord(config.mcp) ? config.mcp : {};
  const servers = isRecord(mcpConfig.servers) ? mcpConfig.servers : {};
  for (const name of Object.keys(servers)) {
    if (name.toLowerCase().startsWith(STAFF_MCP_ENTRY_PREFIX) && !mcpWanted.has(name)) writes.push({ path: mcpServerPath(name) });
  }
  for (const [name, entry] of mcpWanted) {
    if (!isDeepStrictEqual(servers[name], entry)) writes.push({ path: mcpServerPath(name), value: entry });
  }

  const systemAgentNow = isRecord(defaults.systemAgent) ? defaults.systemAgent.agentId : undefined;
  if (wanted.size > 0) {
    // Make room for a fleet, naming only what is absent.
    if (view.shape === "none" || (view.shape === "entries" && others.length === 0)) {
      writes.unshift({
        path: entryPath(owner),
        value: { workspace: input.ownerWorkspace, ...(anyMcp ? { tools: { deny: [STAFF_MCP_DENY_GLOB] } } : {}) },
      });
      marks.ownerEntry = { id: owner, workspace: input.ownerWorkspace };
    }
    if (view.shape !== "list" && agents.ownership === undefined) {
      writes.push({ path: "agents.ownership", value: "explicit" });
      marks.ownership = true;
    }
    if (systemAgentNow === undefined) {
      writes.push({ path: "agents.defaults.systemAgent.agentId", value: owner });
      marks.systemAgent = owner;
    }
    return { writes, marks };
  }

  // No staff: the staff agents go (the loop above). What ClawBox wrote around
  // them — the owner's agent's entry with its workspace pinned where it
  // already was, `agents.ownership: "explicit"`, `systemAgent` = the owner's
  // agent — STAYS: it names the same agent with the same workspace the core
  // resolved before, so the owner's assistant behaves exactly as it did, and a
  // write that tried to take the roster away again is one more thing that can
  // fail half-way on a running gateway. The marks are kept so the next switch
  // knows the roster is ClawBox's.
  return { writes, marks };
}

/** The staff agent id an `agents.entries["<id>"]` path removes, or null. */
function staffIdOfEntryPath(configPath: string): string | null {
  const m = /^agents\.entries\["([^"]+)"\]$/.exec(configPath);
  return m && isStaffAgentId(m[1]) ? m[1] : null;
}

/**
 * Remove one agent the way the core removes agents (`agents.delete`, which
 * `openclaw agents delete` itself routes through the running gateway), its
 * files kept. False when the gateway could not be asked — the caller then
 * edits the config instead; a refusal throws.
 */
async function deleteAgentThroughGateway(agentId: string): Promise<boolean> {
  const { gatewayWsCall, GatewayWsUnavailableError } = await import("@/lib/openclaw-gateway-ws");
  try {
    await gatewayWsCall("agents.delete", { agentId, deleteFiles: false });
    return true;
  } catch (err) {
    if (err instanceof GatewayWsUnavailableError) return false;
    throw err;
  }
}

/** The plan's writes, for the journal. */
function describe(writes: readonly RosterWrite[]): string {
  return writes.map((w) => `${w.value === undefined ? "unset" : "set"} ${w.path}`).join(", ");
}

// ─── The server side ────────────────────────────────────────────────────────

let syncChain: Promise<unknown> = Promise.resolve();

function readMarks(raw: unknown): StaffRosterMarks | null {
  if (!isRecord(raw)) return null;
  const owner = isRecord(raw.ownerEntry) && typeof raw.ownerEntry.id === "string" && typeof raw.ownerEntry.workspace === "string"
    ? { id: raw.ownerEntry.id, workspace: raw.ownerEntry.workspace }
    : null;
  return {
    ownerEntry: owner,
    ownership: raw.ownership === true,
    systemAgent: typeof raw.systemAgent === "string" ? raw.systemAgent : null,
  };
}

/**
 * Seed a member of staff's workspace once: their own USER.md (so the core
 * does not start its first-conversation ritual, and so the assistant knows
 * whom it serves) and the assistant's persona copied from the owner's
 * workspace. Their MEMORY.md is theirs to grow; nothing of the owner's is
 * copied into it. 0700: their folder is no other account's business.
 */
async function seedStaffWorkspace(dir: string, username: string, ownerWorkspace: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  const userMd = path.join(dir, "USER.md");
  // Created only when absent (`wx`): a member's own USER.md is theirs to grow.
  await fsp
    .writeFile(
      userMd,
      [
        "# USER.md",
        "",
        `- **Name:** ${username}`,
        "- **Role:** a member of staff on this organisation's ClawBox. The box's owner is the administrator.",
        "- This assistant is theirs alone: what they ask you to remember stays in this workspace.",
        "- Files you write for them belong in this folder.",
        "- Whenever you write to MEMORY.md or a file under memory/, say in the same reply which file you wrote, that it is kept across chats, and that they can ask you to remove it.",
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    )
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "EEXIST") throw err;
    });
  for (const name of ["SOUL.md", "IDENTITY.md"]) {
    const target = path.join(dir, name);
    try {
      // COPYFILE_EXCL: copied only when the member's workspace has none yet.
      await fsp.copyFile(path.join(ownerWorkspace, name), target, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(target, 0o600).catch(() => undefined);
    } catch {
      // Theirs already, or the owner's workspace has none yet: the core seeds its own template.
    }
  }
}

/**
 * Make the OpenClaw roster match the organisation switch and the users: one
 * staff agent per member while `org_mode` is on, none otherwise. Serialised,
 * best effort, never throws — the switch and the users exist either way, and
 * the relay refuses a member's turn until their agent is there
 * (scripts/gateway-user-relay.js `staffReady`). Answers whether the roster now
 * says what it should.
 */
export function syncStaffAgents(): Promise<boolean> {
  const run = syncChain.then(() => syncStaffAgentsNow(), () => syncStaffAgentsNow());
  syncChain = run.catch(() => undefined);
  return run;
}

async function syncStaffAgentsNow(): Promise<boolean> {
  try {
    const { getActiveHarness } = await import("@/lib/harness");
    if ((await getActiveHarness()) !== "openclaw") return true;
    const { OPENCLAW_HOME, openclawIsAbsent, readConfigStrict, runOpenclawConfigSetBatch, runOpenclawConfigUnset } = await import("@/lib/openclaw-config");
    if (openclawIsAbsent()) return true;
    const { openclawWorkspaceDir } = await import("@/lib/language-persona");
    const orgMode = await readOrgMode();
    const staff = orgMode ? (await listUsers()).map((user) => user.username) : [];
    const ownerWorkspace = openclawWorkspaceDir();
    const config = await readConfigStrict();
    const marksBefore = readMarks(await get(ORG_STAFF_ROSTER_KEY));
    const mcpPlan = await staffMcpPlan(staff, config);
    // The guard's record first: a grant taken away is refused by the guard
    // before the policy catches up, and one added is refused by the policy
    // until it does — never the other way round. A record that could not be
    // written grants nothing in the config either (fail closed: revocations
    // still go through), and the sync says it did not land.
    const grantsWritten = await writeStaffMcpGrants(OPENCLAW_HOME, mcpPlan.entries);
    const mcp = grantsWritten ? mcpPlan.entries : new Map<string, StaffMcpEntry[]>();
    const plan = planStaffRoster(config, { staff, openclawHome: OPENCLAW_HOME, ownerWorkspace, marks: marksBefore, mcp });

    for (const username of staff) {
      await seedStaffWorkspace(staffWorkspaceDir(OPENCLAW_HOME, username), username, ownerWorkspace);
    }
    let ok = grantsWritten && mcpPlan.ok;
    if (plan.writes.length > 0) {
      // Record the marks FIRST (a crash after the write must not leave a
      // roster nobody remembers making).
      if (!isDeepStrictEqual(marksBefore ?? NO_MARKS, plan.marks)) await set(ORG_STAFF_ROSTER_KEY, plan.marks);
      const sets = plan.writes.filter((w) => w.value !== undefined);
      const removals = plan.writes.filter((w) => w.value === undefined);
      // Each removal on its own, so one the gateway refuses cannot keep the
      // others: a staff agent goes through the core's own `agents.delete`
      // (config entry, bindings and session-store rows together — the files
      // are kept, their memory is theirs if the switch comes back), the
      // config unset only when the gateway cannot be asked.
      for (const write of removals) {
        try {
          const id = staffIdOfEntryPath(write.path);
          if (!id || !(await deleteAgentThroughGateway(id))) await runOpenclawConfigUnset(write.path);
        } catch (err) {
          ok = false;
          console.error(`[org-staff] could not remove ${write.path}:`, err instanceof Error ? err.message : err);
        }
      }
      if (sets.length > 0) {
        try {
          await runOpenclawConfigSetBatch(sets.map((w) => [w.path, JSON.stringify(w.value), "--json"]));
        } catch (err) {
          ok = false;
          console.error("[org-staff] could not write the staff agents:", err instanceof Error ? err.message : err);
        }
      }
      console.log(`[org-staff] roster: ${describe(plan.writes)}${ok ? "" : " (not all of it landed)"}`);
    } else if (!isDeepStrictEqual(marksBefore ?? NO_MARKS, plan.marks)) {
      await set(ORG_STAFF_ROSTER_KEY, plan.marks);
    }
    return ok;
  } catch (err) {
    console.error("[org-staff] could not update the staff agents:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Each member's granted MCP relay entries (src/lib/staff-mcp.ts), from the
 * owner's store and the servers openclaw.json defines. A store that cannot be
 * read grants nothing (fail closed); members without a relay token get one.
 */
async function staffMcpPlan(staff: readonly string[], config: unknown): Promise<{ entries: Map<string, StaffMcpEntry[]>; ok: boolean }> {
  if (staff.length === 0) return { entries: new Map(), ok: true };
  try {
    const { ensureRelayTokens, planStaffMcpEntries } = await import("@/lib/staff-mcp");
    const { openclawServerEntries } = await import("@/lib/project-mcp-servers");
    const { getLocalAiProxyRootUrl } = await import("@/lib/local-ai-proxy-url");
    const store = await ensureRelayTokens(staff);
    const mcpConfig = isRecord(config) && isRecord(config.mcp) ? config.mcp : {};
    return { entries: planStaffMcpEntries({ staff, store, servers: openclawServerEntries(mcpConfig.servers), relayBase: getLocalAiProxyRootUrl() }), ok: true };
  } catch (err) {
    // Fail closed — no grant — and say the sync did not land.
    console.error("[org-staff] the staff MCP grants could not be read; none are given:", err instanceof Error ? err.message : err);
    return { entries: new Map(), ok: false };
  }
}

/**
 * The grants clawbox-staff-guard reads (`staff-mcp-grants.json` beside the
 * installed plugin): which relay entries each staff agent may call. Written
 * whole by rename, 0600. No plugin folder, no file: the guard then refuses
 * every staff MCP call (missing = refuse).
 */
async function writeStaffMcpGrants(openclawHome: string, mcp: ReadonlyMap<string, readonly StaffMcpEntry[]>): Promise<boolean> {
  const { STAFF_MCP_GRANTS_FILE, grantsDocument } = await import("@/lib/staff-mcp");
  const dir = path.join(openclawHome, "extensions", "clawbox-staff-guard");
  // No guard installed: nothing to record, and no grant can be honoured —
  // a failure only when there IS something to grant.
  if (!fs.existsSync(dir)) return mcp.size === 0;
  const file = path.join(dir, STAFF_MCP_GRANTS_FILE);
  const content = `${JSON.stringify(grantsDocument(mcp), null, 2)}\n`;
  try {
    if ((await fsp.readFile(file, "utf-8").catch(() => null)) === content) return true;
    const temp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(temp, content, { mode: 0o600 });
    await fsp.rename(temp, file);
    return true;
  } catch (err) {
    console.error("[org-staff] could not record the staff MCP grants for the guard:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * A removed member of staff's agent goes with them, and so does their
 * workspace — their memory and their folder — and the agent's own state
 * directory, so a user created later under the same name starts empty. Best
 * effort, never throws. Their sessions were deleted through the gateway first
 * (src/lib/user-chats.ts).
 */
export async function forgetStaffAgent(username: string): Promise<void> {
  const id = staffAgentId(username);
  if (!id) return;
  // Their MCP credentials and relay token first, so the sync below takes
  // their relay entries away with the agent.
  const { forgetStaffMcpUser } = await import("@/lib/staff-mcp");
  await forgetStaffMcpUser(username);
  await syncStaffAgents();
  try {
    const { OPENCLAW_HOME } = await import("@/lib/openclaw-config");
    await fsp.rm(staffWorkspaceDir(OPENCLAW_HOME, username), { recursive: true, force: true });
    await fsp.rm(path.join(OPENCLAW_HOME, "agents", id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[org-staff] could not remove ${username}'s workspace:`, err instanceof Error ? err.message : err);
  }
}
