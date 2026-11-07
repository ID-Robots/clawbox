/**
 * Which OpenClaw agent is "the agent" on this box: the id ClawBox names when it
 * asks the core about one agent's memory (`openclaw memory status|index
 * --agent <id>`), watches that agent's database for a pass's progress, and
 * gives its own index's status as on the edition without OpenClaw.
 *
 * SERVER ONLY: reads openclaw.json.
 *
 * NEVER "main" BY ASSUMPTION. It was hard-coded, and on a box whose agent is
 * called something else (a customer report, TASK-2248: four agents, the main
 * one `default`) every status read asked the core about an agent its config
 * does not have, and Memory Shard said "status unavailable" over memory that
 * was working. Nor is it read off the disk: that box still has the
 * `agents/main/` directory from before the rename, and an agent that has a
 * directory is not the agent the config names.
 *
 * Resolved the way the pinned core (OpenClaw 2026.10.9) names the owner of
 * work that comes with no `--agent` (`agents.defaults.systemAgent` in its
 * docs, `tryResolveAmbientOwnerAgentId` in its source), over the roster as its
 * `listAgentIds` reads it: keyed `agents.entries`, or a legacy `agents.list`,
 * ids normalised the way the CLI matches `--agent`.
 *
 *   1. `agents.defaults.systemAgent.agentId`, when it is a configured agent
 *      (Doctor records a migrated default there);
 *   2. the one entry marked `default: true`, unless `agents.ownership` is
 *      "explicit" (the core ignores the legacy marker then);
 *   3. the sole configured agent;
 *   4. "main" for a config with no roster at all, which is the core's own
 *      implicit agent, and for one that cannot be read.
 *
 * Where the core itself would refuse (several agents, none of them named the
 * default) this answers "main" when it is one of them and the roster's first
 * entry otherwise, the rule `openclawSkillsAgentArgs` already applies: a
 * reading about a real agent beats "status unavailable".
 */

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { CONFIG_PATH } from "@/lib/openclaw-config";

/** The core's implicit agent, and the answer when nothing else is configured. */
export const FALLBACK_AGENT_ID = "main";

const VALID_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * OpenClaw's `normalizeAgentId`: the lower-case, filesystem-safe form the CLI
 * compares `--agent` against. A value with nothing representable left in it is
 * the core's default, "main", as there.
 */
export function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (VALID_AGENT_ID.test(trimmed)) return trimmed.toLowerCase();
  const id = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return id || FALLBACK_AGENT_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface RosterEntry {
  id: string;
  entry: Record<string, unknown>;
}

/**
 * The roster as the core's `collectAgentEntries` reads it, or null when the
 * config holds none at all. `agents.entries` wins over `agents.list` when both
 * are there, and a roster key holding the wrong type is an empty roster rather
 * than no roster, as in the core.
 */
function readRoster(config: unknown): RosterEntry[] | null {
  if (!isRecord(config) || !isRecord(config.agents)) return null;
  const { entries, list } = config.agents;
  if (entries !== undefined) {
    if (!isRecord(entries)) return [];
    return Object.entries(entries)
      .filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]))
      .map(([id, entry]) => ({ id: normalizeAgentId(id), entry }));
  }
  if (list !== undefined) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .map((entry) => ({ id: normalizeAgentId(entry.id), entry }));
  }
  return null;
}

/**
 * Every configured agent id, as the core's `listAgentIds` answers it: unique,
 * normalised, in roster order, and `main` alone for a config with no roster.
 */
export function configuredAgentIds(config: unknown): string[] {
  const roster = readRoster(config);
  return roster === null ? [FALLBACK_AGENT_ID] : [...new Set(roster.map((agent) => agent.id))];
}

/** The default agent a parsed openclaw.json names; see the module comment for the order. */
export function resolveDefaultAgentId(config: unknown): string {
  const roster = readRoster(config);
  if (roster === null) return FALLBACK_AGENT_ID;
  const ids = [...new Set(roster.map((agent) => agent.id))];
  const agents = (config as { agents: Record<string, unknown> }).agents;
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const systemAgent = isRecord(defaults.systemAgent) ? defaults.systemAgent : {};
  const named = typeof systemAgent.agentId === "string" && systemAgent.agentId.trim()
    ? normalizeAgentId(systemAgent.agentId)
    : "";
  if (named && ids.includes(named)) return named;
  if (agents.ownership !== "explicit") {
    const marked = roster.filter((agent) => agent.entry.default === true);
    if (marked.length === 1) return marked[0].id;
  }
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) return FALLBACK_AGENT_ID;
  return ids.includes(FALLBACK_AGENT_ID) ? FALLBACK_AGENT_ID : ids[0];
}

let cached: { path: string; key: string; id: string } | null = null;

/**
 * {@link resolveDefaultAgentId} for this box's openclaw.json, read again only
 * when the file changes.
 *
 * Every status read and every pass asks, and the answer changes only when the
 * owner adds, renames or re-points an agent, so it is kept against the file's
 * identity (device, inode, size, mtime): one open and `fstat` per ask, a
 * re-read the moment the config is written, never a stale id across a rename.
 * A file that is not there answers {@link FALLBACK_AGENT_ID}; one that cannot
 * be read for a moment (caught half-written, an EIO) keeps the last answer
 * read from it rather than flipping a status read to an agent the box may not
 * have.
 *
 * Never rejects, whatever goes wrong: an index pass asks for it with the run
 * lock already taken.
 */
export async function openclawDefaultAgentId(configPath?: string): Promise<string> {
  try {
    return await readDefaultAgentId(configPath ?? CONFIG_PATH);
  } catch {
    return FALLBACK_AGENT_ID;
  }
}

async function readDefaultAgentId(configPath: string): Promise<string> {
  const last = cached?.path === configPath ? cached : null;
  // ONE handle for the identity and the content, so the id cached under a key
  // is the content of the very file that key describes: a path `stat` followed
  // by a path read could pair one file's identity with the next one's text.
  let handle: FileHandle;
  try {
    handle = await fs.open(configPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return FALLBACK_AGENT_ID;
    return last?.id ?? FALLBACK_AGENT_ID;
  }
  try {
    // BigInt stats: a float `mtimeMs` rounds two writes a few hundred
    // nanoseconds apart to one value, and a large inode loses digits as a
    // number. (ClawBox and OpenClaw both write the file by rename, so a
    // rewrite also brings a new inode.)
    const stat = await handle.stat({ bigint: true });
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    if (last?.key === key) return last.id;
    const id = resolveDefaultAgentId(JSON.parse(await handle.readFile({ encoding: "utf8" })));
    cached = { path: configPath, key, id };
    return id;
  } catch {
    return last?.id ?? FALLBACK_AGENT_ID;
  } finally {
    await handle.close().catch(() => { /* already closed */ });
  }
}
