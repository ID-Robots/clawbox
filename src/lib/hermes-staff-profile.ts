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
 * Under `~/.hermes`, which the Files app refuses to everybody
 * (src/lib/file-guard.ts), so no other user opens it.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import yaml from "js-yaml";
import path from "@/lib/runtime-path";
import { hermesHome } from "@/lib/hermes-env";
import { STAFF_HERMES_TOOLS, staffAgentId } from "@/lib/org-staff-policy";

export interface StaffHermesProfile {
  /** The profile name the dashboard is handed (`profile` on session.create / resume / slash.exec). */
  profile: string;
  /** The profile's HERMES_HOME. */
  home: string;
  /** Their own folder: the session's working directory. */
  folder: string;
}

type Json = Record<string, unknown>;

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

/**
 * The staff profile's config.yaml: the owner's, with the staff keys laid over
 * it. Pure.
 */
export function staffHermesConfig(ownerConfig: unknown, folder: string): Json {
  const cfg: Json = isRecord(ownerConfig) ? structuredClone(ownerConfig) : {};
  // Tools: exactly the staff toolsets, the rest switched off last.
  cfg.platform_toolsets = { cli: [...STAFF_HERMES_TOOLS.toolsets] };
  cfg.agent = { ...(isRecord(cfg.agent) ? cfg.agent : {}), disabled_toolsets: [...STAFF_HERMES_TOOLS.disabledToolsets] };
  delete cfg.toolsets;
  // None of the device's MCP tools (or any other MCP server the owner added).
  delete cfg.mcp_servers;
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
  return cfg;
}

/** Point `link` at `target`, replacing whatever is there; remove it when the target does not exist. */
async function linkTo(link: string, target: string): Promise<void> {
  const exists = fs.existsSync(target);
  let current: string | null = null;
  try {
    current = await fsp.readlink(link);
  } catch {
    current = null;
  }
  if (exists && current === target) return;
  await fsp.rm(link, { force: true });
  if (exists) await fsp.symlink(target, link);
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  let current: string | null = null;
  try {
    current = await fsp.readFile(file, "utf-8");
  } catch {
    current = null;
  }
  if (current === content) return;
  const temp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(temp, content, { mode: 0o600 });
  await fsp.rename(temp, file);
}

/**
 * Make sure `username`'s profile exists and follows the owner's config. Null
 * when it could not be made — the caller then refuses the member's turn
 * rather than run it on the owner's profile.
 */
export async function ensureStaffHermesProfile(username: string, root: string = hermesHome()): Promise<StaffHermesProfile | null> {
  const paths = staffHermesProfilePaths(username, root);
  if (!paths) return null;
  try {
    for (const dir of [paths.home, path.join(paths.home, "memories"), paths.folder]) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await fsp.chmod(paths.home, 0o700).catch(() => undefined);
    let owner: unknown = {};
    try {
      owner = yaml.load(await fsp.readFile(path.join(root, "config.yaml"), "utf-8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    const config = staffHermesConfig(owner, paths.folder);
    await writeIfChanged(
      path.join(paths.home, "config.yaml"),
      `# Written by ClawBox for an organisation's member of staff (src/lib/hermes-staff-profile.ts).\n# The owner's config with the staff tools and memory laid over it; rewritten from it.\n${yaml.dump(config, { noRefs: true, lineWidth: -1 })}`,
    );
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
