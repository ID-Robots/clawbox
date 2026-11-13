/**
 * A member of staff's own Hermes profile on an organisation box (TASK-2444,
 * TASK-2445). SERVER ONLY.
 *
 * WHY A PROFILE. The pinned Hermes dashboard hosts several profile homes in
 * one process: a session opened with `profile: <name>` binds HERMES_HOME to
 * `~/.hermes/profiles/<name>` for its agent build and every turn
 * (tui_gateway/methods_session.py `_create_session`, server.py
 * `_profile_home`), and `get_secret()` is scoped to that home from then on
 * (tui_gateway/launch_profile_policy.py). So a profile is to Hermes what an
 * agent is to OpenClaw (src/lib/org-staff-agents.ts), and gives both halves of
 * the task natively:
 *
 *   * its TOOLS — `platform_toolsets.cli` and `agent.disabled_toolsets` of the
 *     profile's own config.yaml decide which tools a session's agent is built
 *     with (tui_gateway/agent_factory.py `_load_enabled_toolsets`); the lists
 *     are config/org-staff-policy.json's, and the profile names no MCP server,
 *     so none of the device's MCP tools are there either;
 *   * its MEMORY — `memories/MEMORY.md` and `USER.md`, its `state.db` (so
 *     `session_search` finds only their own conversations) and its skills
 *     directory, all under the profile home.
 *
 * The rest of the profile follows the owner's: config.yaml is the owner's with
 * the staff keys laid over it, rewritten when either changes; `.env` and
 * `auth.json` are links to the owner's, so the box's provider keys and
 * sign-ins serve the member without a copy that could go stale; SOUL.md (the
 * assistant's persona) is copied. `workspace/` is the member's own folder —
 * the session's working directory and the only place clawbox_staff_guard
 * (scripts/hermes-plugins/) lets a file tool write.
 *
 * PLUGINS ARE PER PROFILE TOO. The dashboard keeps one plugin manager per
 * profile home and scans `<home>/plugins` for it (hermes_cli/plugins.py
 * `_plugin_managers_by_home`, plugins_discovery.py `collect_directory_manifests`),
 * and a tool call's `pre_tool_call` hooks are that manager's. A guard installed
 * only in the owner's `~/.hermes/plugins` never sees a member's calls — measured
 * on a board: a member's `read_file` opened /etc and the owner's config while the
 * owner's manager had the guard loaded. So the profile's own `plugins/` links the
 * installed guard and its config enables it, before the profile is first served.
 *
 * Under `~/.hermes`, which the Files app refuses to everybody
 * (src/lib/file-guard.ts), so no other user opens it.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import { randomUUID } from "crypto";
import yaml from "js-yaml";
import path from "@/lib/runtime-path";
import { hermesHome } from "@/lib/hermes-env";
import { STAFF_HERMES_TOOLS, staffAgentId } from "@/lib/org-staff-policy";
import { createSerialLock } from "@/lib/serial-lock";

export interface StaffHermesProfile {
  /** The profile name the dashboard is handed (`profile` on session.create / resume / slash.exec). */
  profile: string;
  /** The profile's HERMES_HOME. */
  home: string;
  /** Their own folder: the session's working directory. */
  folder: string;
}

type Json = Record<string, unknown>;

/** The Hermes plugin that holds a staff profile's file tools to the member's folder. */
export const STAFF_GUARD_HERMES_PLUGIN = "clawbox_staff_guard";

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Where one member of staff's profile lives, or null for a name that is not a username. */
export function staffHermesProfilePaths(username: string, root: string = hermesHome()): StaffHermesProfile | null {
  const profile = staffAgentId(username);
  if (!profile) return null;
  const home = path.join(root, "profiles", profile);
  return { profile, home, folder: path.join(home, "workspace") };
}

/** `plugins.enabled` / `plugins.disabled` as a list of names: a YAML list, or the JSON text `hermes config set` leaves. */
function pluginNames(value: unknown): string[] {
  let names: unknown = value;
  if (typeof value === "string") {
    try {
      names = JSON.parse(value);
    } catch {
      names = null;
    }
  }
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/**
 * The staff profile's config.yaml: the owner's, with the staff keys laid over
 * it. Pure.
 */
export function staffHermesConfig(ownerConfig: unknown, folder: string, mcpServers: Record<string, unknown> = {}): Json {
  const cfg: Json = isRecord(ownerConfig) ? structuredClone(ownerConfig) : {};
  // Tools: exactly the staff toolsets, the rest switched off last.
  cfg.platform_toolsets = { cli: [...STAFF_HERMES_TOOLS.toolsets] };
  cfg.agent = { ...(isRecord(cfg.agent) ? cfg.agent : {}), disabled_toolsets: [...STAFF_HERMES_TOOLS.disabledToolsets] };
  delete cfg.toolsets;
  // None of the device's MCP tools (or any other MCP server the owner added)
  // — only the relay entries of the servers the owner granted THIS member
  // (TASK-2516, src/lib/staff-mcp.ts `hermesStaffMcpServers`), each carrying
  // their own relay token.
  delete cfg.mcp_servers;
  if (Object.keys(mcpServers).length > 0) cfg.mcp_servers = structuredClone(mcpServers);
  // Their own built-in memory, written without asking anyone: an external
  // provider could be a store the owner's memory shares.
  const memory = isRecord(cfg.memory) ? cfg.memory : {};
  cfg.memory = { ...memory, memory_enabled: true, user_profile_enabled: true, write_approval: false, provider: "" };
  // No learned skills: neither the background review nor the curator.
  const auxiliary = isRecord(cfg.auxiliary) ? cfg.auxiliary : {};
  const review = isRecord(auxiliary.background_review) ? auxiliary.background_review : {};
  cfg.auxiliary = { ...auxiliary, background_review: { ...review, enabled: false } };
  cfg.curator = { ...(isRecord(cfg.curator) ? cfg.curator : {}), enabled: false };
  // Their folder is where a relative path lands.
  cfg.terminal = { ...(isRecord(cfg.terminal) ? cfg.terminal : {}), cwd: folder };
  // Out of the host's messaging multiplexer (hermes_cli/profiles.py
  // `profiles_to_serve`): `.env` is the owner's, and a served profile would
  // start the owner's Telegram/Discord/e-mail adapters a second time — and its
  // own cron ticker. The member's profile is served to the dashboard chat only.
  cfg.gateway = { ...(isRecord(cfg.gateway) ? cfg.gateway : {}), standalone: true };
  delete cfg.cron;
  // The staff guard runs in the profile's own plugin manager: enabled here,
  // never disabled (the owner's other plugins stay as they are).
  const plugins = isRecord(cfg.plugins) ? cfg.plugins : {};
  cfg.plugins = {
    ...plugins,
    enabled: [...new Set([...pluginNames(plugins.enabled), STAFF_GUARD_HERMES_PLUGIN])],
    disabled: pluginNames(plugins.disabled).filter((n) => n !== STAFF_GUARD_HERMES_PLUGIN),
  };
  return cfg;
}

/**
 * Point `link` at `target`, replacing whatever is there (a link is removed,
 * never followed); remove it when the target does not exist.
 */
async function linkTo(link: string, target: string): Promise<void> {
  const exists = fs.existsSync(target);
  let current: string | null = null;
  try {
    current = await fsp.readlink(link);
  } catch {
    current = null;
  }
  if (exists && current === target) return;
  await fsp.rm(link, { force: true, recursive: true });
  if (exists) await fsp.symlink(target, link);
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  let current: string | null = null;
  try {
    current = await fsp.readFile(file, "utf-8");
  } catch {
    current = null;
  }
  if (current === content) return false;
  // A temp file of its own per write: two writers never share one.
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsp.writeFile(temp, content, { mode: 0o600 });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
  return true;
}

/** One writer of the guard's grants file at a time: two members' preparations each change their own line of it. */
const grantsLock = createSerialLock();

/**
 * Set (or, with none, remove) one staff profile's line in the guard's grants
 * file beside the installed plugin, and drop the lines of profiles not in
 * `keep` when it is given. 0600, written whole by rename. Throws when it
 * cannot: the caller then grants nothing.
 */
async function writeHermesStaffGrants(root: string, change: { agentId?: string; entries?: readonly string[]; keep?: ReadonlySet<string> }): Promise<void> {
  const { STAFF_MCP_GRANTS_FILE } = await import("@/lib/staff-mcp");
  const dir = path.join(root, "plugins", STAFF_GUARD_HERMES_PLUGIN);
  await grantsLock(async () => {
    const file = path.join(dir, STAFF_MCP_GRANTS_FILE);
    let agents: Record<string, string[]> = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf-8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.agents)) {
        for (const [id, list] of Object.entries(parsed.agents)) {
          if (Array.isArray(list)) agents[id] = list.filter((n): n is string => typeof n === "string");
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    }
    if (change.keep) agents = Object.fromEntries(Object.entries(agents).filter(([id]) => change.keep!.has(id)));
    if (change.agentId) {
      if (change.entries && change.entries.length > 0) agents[change.agentId] = [...change.entries].sort();
      else delete agents[change.agentId];
    }
    await writeIfChanged(file, `${JSON.stringify({ agents }, null, 2)}\n`);
  });
}

/**
 * The relay entries of the servers the owner granted `username`, as their
 * profile's `mcp_servers` (TASK-2516): the owner's Hermes servers from the
 * owner's config.yaml, the grants in data/staff-mcp.json, this member's relay
 * token. The guard's grants file is written FIRST; a store or a grants file
 * that cannot be read or written grants nothing (fail closed).
 */
async function staffHermesMcpServers(username: string, root: string, owner: unknown): Promise<Record<string, unknown>> {
  const agentId = staffAgentId(username);
  if (!agentId) return {};
  try {
    const [{ ensureRelayTokens, planStaffMcpEntries, hermesStaffMcpServers }, { hermesServerEntries }, { getLocalAiProxyRootUrl }] = await Promise.all([
      import("@/lib/staff-mcp"),
      import("@/lib/project-mcp-servers"),
      import("@/lib/local-ai-proxy-url"),
    ]);
    const store = await ensureRelayTokens([username]);
    const servers = hermesServerEntries(isRecord(owner) ? owner.mcp_servers : undefined);
    const entries = planStaffMcpEntries({ staff: [username], store, servers, relayBase: getLocalAiProxyRootUrl() }).get(username) ?? [];
    await writeHermesStaffGrants(root, { agentId, entries: entries.map((e) => e.name) });
    return hermesStaffMcpServers(entries);
  } catch (err) {
    console.error(`[org-staff] the staff MCP grants for ${username} could not be applied; none are given:`, err instanceof Error ? err.message : err);
    await writeHermesStaffGrants(root, { agentId }).catch(() => undefined);
    return {};
  }
}

/**
 * The owner changed the staff MCP grants (or the roster) on a Hermes box:
 * every existing member profile is rewritten with its entries now, the
 * guard's grants file keeps only the members named, and the dashboard reloads
 * its MCP servers when any profile's changed. A member with no profile yet
 * gets theirs on their first turn. Answers whether every profile was written.
 */
export async function syncHermesStaffMcp(staff: readonly string[], root: string = hermesHome()): Promise<boolean> {
  let ok = true;
  const keep = new Set(staff.map((u) => staffAgentId(u)).filter((id): id is string => Boolean(id)));
  try {
    // No guard installed: no grant can be honoured, and nothing to record.
    if (fs.existsSync(path.join(root, "plugins", STAFF_GUARD_HERMES_PLUGIN))) await writeHermesStaffGrants(root, { keep });
  } catch (err) {
    ok = false;
    console.error("[org-staff] could not update the Hermes staff guard's grants:", err instanceof Error ? err.message : err);
  }
  for (const username of staff) {
    const paths = staffHermesProfilePaths(username, root);
    if (!paths || !fs.existsSync(paths.home)) continue;
    if (!(await ensureStaffHermesProfile(username, root))) ok = false;
  }
  return ok;
}

/**
 * Is the staff guard installed and enabled for the dashboard (register-mcp.sh,
 * step 2c)? Without it the `file` toolset the staff profile keeps would write
 * past the member's folder, so a member's turn does not run.
 */
function staffGuardInstalled(root: string, owner: unknown): boolean {
  if (!fs.existsSync(path.join(root, "plugins", STAFF_GUARD_HERMES_PLUGIN, "__init__.py"))) return false;
  const plugins = isRecord(owner) && isRecord(owner.plugins) ? owner.plugins : {};
  return pluginNames(plugins.enabled).includes(STAFF_GUARD_HERMES_PLUGIN);
}

/** The preparation in flight per profile (process-local). */
const preparing = new Map<string, Promise<StaffHermesProfile | null>>();

/**
 * Make sure `username`'s profile exists, follows the owner's config and carries
 * the staff guard. Null when it could not be made — the caller then refuses
 * the member's turn rather than run it on the owner's profile.
 */
export function ensureStaffHermesProfile(username: string, root: string = hermesHome()): Promise<StaffHermesProfile | null> {
  // One preparation per profile at a time: two turns of the same member
  // arriving together would otherwise interleave the link and config writes.
  const key = `${root}\0${username}`;
  const turn = (preparing.get(key) ?? Promise.resolve(null)).then(() => prepareStaffHermesProfile(username, root));
  preparing.set(key, turn);
  void turn.finally(() => {
    if (preparing.get(key) === turn) preparing.delete(key);
  });
  return turn;
}

async function prepareStaffHermesProfile(username: string, root: string): Promise<StaffHermesProfile | null> {
  const paths = staffHermesProfilePaths(username, root);
  if (!paths) return null;
  try {
    for (const dir of [paths.home, path.join(paths.home, "memories"), path.join(paths.home, "plugins"), paths.folder]) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await fsp.chmod(paths.home, 0o700).catch(() => undefined);
    let owner: unknown = {};
    try {
      owner = yaml.load(await fsp.readFile(path.join(root, "config.yaml"), "utf-8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (!staffGuardInstalled(root, owner)) {
      console.error(`[org-staff] the ${STAFF_GUARD_HERMES_PLUGIN} plugin is not installed and enabled; ${username}'s turn is refused`);
      return null;
    }
    // The guard in the profile's own plugins/ (see the header), before anything
    // the dashboard could serve: a link, so register-mcp.sh's reinstall of the
    // owner's copy is the member's too.
    await linkTo(path.join(paths.home, "plugins", STAFF_GUARD_HERMES_PLUGIN), path.join(root, "plugins", STAFF_GUARD_HERMES_PLUGIN));
    const mcpServers = await staffHermesMcpServers(username, root, owner);
    const config = staffHermesConfig(owner, paths.folder, mcpServers);
    const configPath = path.join(paths.home, "config.yaml");
    const mcpBefore = await readMcpServersOf(configPath);
    await writeIfChanged(
      configPath,
      `# Written by ClawBox for an organisation's member of staff (src/lib/hermes-staff-profile.ts).\n# The owner's config with the staff tools and memory laid over it; rewritten from it.\n${yaml.dump(config, { noRefs: true, lineWidth: -1 })}`,
    );
    if (JSON.stringify(mcpBefore) !== JSON.stringify(config.mcp_servers ?? null)) {
      // Hermes connects a profile's MCP servers when it discovers them: a
      // changed grant reaches a session already open at its next turn only
      // once the dashboard reloads (src/lib/hermes-mcp-reload.ts).
      const { reloadMcpServers } = await import("@/lib/hermes-mcp-reload");
      void reloadMcpServers().catch(() => undefined);
    }
    await linkTo(path.join(paths.home, ".env"), path.join(root, ".env"));
    await linkTo(path.join(paths.home, "auth.json"), path.join(root, "auth.json"));
    try {
      await writeIfChanged(path.join(paths.home, "SOUL.md"), await fsp.readFile(path.join(root, "SOUL.md"), "utf-8"));
    } catch {
      // No persona on the owner's side yet: Hermes uses its own default.
    }
    return paths;
  } catch (err) {
    console.error(`[org-staff] could not prepare ${username}'s Hermes profile:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** A profile config's `mcp_servers` as written, or null (none, or unreadable). */
async function readMcpServersOf(file: string): Promise<unknown> {
  try {
    const doc = yaml.load(await fsp.readFile(file, "utf-8"), { schema: yaml.JSON_SCHEMA });
    return isRecord(doc) && doc.mcp_servers !== undefined ? doc.mcp_servers : null;
  } catch {
    return null;
  }
}

/** The last time a staff turn asked the dashboard to load the guard (process-local). */
let lastGuardReload = 0;
/** Asked at most this often, so a guard that will not load cannot have members restart the owner's chat backend in a loop. */
export const STAFF_GUARD_RELOAD_COOLDOWN_MS = 10 * 60_000;

/**
 * Has the RUNNING dashboard loaded the staff guard? Installed and enabled is
 * not loaded: Hermes scans for plugins once per manager, and register-mcp.sh
 * installs it from the web server's own boot, which can be after the
 * dashboard's (measured on a board: a member's `patch` reached openclaw.json
 * through a dashboard started before the plugin was there). `false` asks the
 * dashboard to reload its plugins — the shared door every caller uses
 * (src/lib/hermes-plugin-reload.ts), at most once per cooldown — and the
 * member's turn is refused until it has. `null`: the dashboard could not say
 * (it is down; a turn then runs on the CLI, which loads plugins afresh).
 *
 * `plugins.list` answers for the dashboard's launch (owner's) manager: proof
 * that this process scanned after the install and that the guard imports. A
 * member's profile manager is made the first time the profile is served, and
 * ensureStaffHermesProfile has linked the guard into it before that.
 */
export async function staffGuardLoaded(now: () => number = Date.now): Promise<boolean | null> {
  const { readLoadedHermesPlugins } = await import("@/lib/hermes-plugin-set");
  const loaded = await readLoadedHermesPlugins().catch(() => null);
  if (loaded === null) return null;
  if (loaded.includes(STAFF_GUARD_HERMES_PLUGIN)) return true;
  if (now() - lastGuardReload >= STAFF_GUARD_RELOAD_COOLDOWN_MS) {
    lastGuardReload = now();
    const { reloadHermesPlugins } = await import("@/lib/hermes-plugin-reload");
    void reloadHermesPlugins("the organisation's staff guard is installed but not loaded").catch((err: unknown) => {
      console.error("[org-staff] could not reload the dashboard's plugins:", err instanceof Error ? err.message : err);
    });
  }
  return false;
}

/** A removed member's profile goes with them: their memory, sessions and folder. Never throws. */
export async function forgetStaffHermesProfile(username: string, root: string = hermesHome()): Promise<void> {
  const paths = staffHermesProfilePaths(username, root);
  if (!paths) return;
  try {
    await fsp.rm(paths.home, { recursive: true, force: true });
  } catch (err) {
    console.error(`[org-staff] could not remove ${username}'s Hermes profile:`, err instanceof Error ? err.message : err);
  }
}
