/**
 * ONE browser per box.
 *
 * The browser the owner uses on the remote desktop and the browser the
 * assistant drives are the same Chromium: one process, one profile, one CDP
 * endpoint, started by one unit (clawbox-browser.service). A site the owner
 * signs in to on the desktop is a site the assistant can use, and what the
 * assistant does happens in a window the owner can watch.
 *
 * Before this, a box had two. The gateway's browser tool started a hidden
 * Chromium of its own on a profile of its own (`~/.openclaw/browser/…`)
 * whenever the desktop browser was not already open — on the same port, so
 * which of the two the assistant got depended on who had started first, and
 * its sign-ins lived where the owner could not see them.
 *
 * Three parts, all here:
 *
 *   1. The gateway is told to ATTACH, never launch (`applySharedBrowserBlock`):
 *      a `clawbox` browser profile pointing at the desktop browser's endpoint
 *      with `attachOnly`, made the default profile.
 *   2. The profile that survives is the desktop one. `agentProfileMigration`
 *      runs once per box and says what happens to the assistant's old one.
 *   3. Because the gateway no longer starts a browser, something has to keep
 *      the shared one up: `startSharedBrowserKeeper`.
 *
 * The escape hatch is `CLAWBOX_BROWSER_AGENT_ISOLATED=1` in the launch env file
 * (src/lib/desktop-browser-config.ts). With it, all three stand down and the
 * box behaves as it did before: a hidden assistant browser, and a desktop
 * browser that is opened and closed by hand.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import path from "./runtime-path";
import type { BootMigration } from "./boot-migrations";
import { cdpEndpoint, type DesktopBrowserConfig } from "./desktop-browser-config";

const exec = promisify(execFile);

/** The gateway browser profile that IS the desktop browser. Matches `^[a-z0-9-]+$`. */
export const SHARED_PROFILE = "clawbox";
/** The gateway's built-in managed profile — the hidden browser this replaces. */
const MANAGED_PROFILE = "openclaw";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bring a gateway config's `browser` block in line with the desktop browser.
 * Mutates `config`; answers whether anything changed.
 *
 * SHARED (the default): `browser.profiles.clawbox` attaches to the desktop
 * browser's endpoint and is never launched by the gateway, and it becomes the
 * default profile — unless the owner has picked a default of their own (a
 * remote browser, a second profile), which is left exactly as it is. Every
 * other key in the block, and every other profile, is kept.
 *
 * ISOLATED: what this function wrote is taken out again, and only that, so the
 * gateway falls back to its own managed browser.
 */
export function applySharedBrowserBlock(
  config: Record<string, unknown>,
  desktop: Pick<DesktopBrowserConfig, "cdpPort" | "agentIsolated">,
): boolean {
  const browser = isPlainObject(config.browser) ? config.browser : null;
  const profiles = browser && isPlainObject(browser.profiles) ? browser.profiles : null;
  const current = profiles && isPlainObject(profiles[SHARED_PROFILE]) ? profiles[SHARED_PROFILE] : null;

  if (desktop.agentIsolated) {
    if (!browser) return false;
    let changed = false;
    if (browser.defaultProfile === SHARED_PROFILE) {
      delete browser.defaultProfile;
      changed = true;
    }
    if (profiles && SHARED_PROFILE in profiles) {
      delete profiles[SHARED_PROFILE];
      if (Object.keys(profiles).length === 0) delete browser.profiles;
      changed = true;
    }
    if (changed && Object.keys(browser).length === 0) delete config.browser;
    return changed;
  }

  const cdpUrl = cdpEndpoint(desktop);
  const defaultProfile = browser?.defaultProfile;
  const ownsDefault = defaultProfile === undefined || defaultProfile === MANAGED_PROFILE || defaultProfile === SHARED_PROFILE;
  const profileOk = current !== null && current.cdpUrl === cdpUrl && current.attachOnly === true && !("cdpPort" in current);
  if (profileOk && (!ownsDefault || defaultProfile === SHARED_PROFILE)) return false;

  const nextBrowser = browser ?? {};
  const nextProfiles = profiles ?? {};
  // `cdpPort` and `cdpUrl` are two ways of naming one endpoint; leaving an old
  // port beside the new URL would be two answers to the same question.
  const { cdpPort: _dropped, ...rest } = current ?? {};
  void _dropped;
  nextProfiles[SHARED_PROFILE] = { ...rest, cdpUrl, attachOnly: true };
  nextBrowser.profiles = nextProfiles;
  if (ownsDefault) nextBrowser.defaultProfile = SHARED_PROFILE;
  config.browser = nextBrowser;
  return true;
}

/**
 * The boot repair: make the gateway's config say what `applySharedBrowserBlock`
 * decides. Answers true when the file was rewritten, which is the caller's cue
 * to restart the gateway (it reads the browser block at start).
 *
 * A config that reads as empty is left alone: before the setup wizard has run
 * there is no gateway config yet, and a file holding only a browser block is
 * not one the installer expects to find.
 */
export async function ensureSharedBrowserProfile(deps: {
  readConfig: () => Promise<Record<string, unknown>>;
  writeConfig: (config: Record<string, unknown>) => Promise<void>;
  readDesktop: () => Promise<DesktopBrowserConfig>;
  gatewayAbsent: () => boolean;
}): Promise<boolean> {
  if (deps.gatewayAbsent()) return false;
  const config = await deps.readConfig();
  if (Object.keys(config).length === 0) return false;
  if (!applySharedBrowserBlock(config, await deps.readDesktop())) return false;
  await deps.writeConfig(config);
  return true;
}

// ─── The profile migration ───────────────────────────────────────────────────

/** Where the outcome is recorded, for the Browser settings panel to read. */
export const PROFILE_MIGRATION_KEY = "browser_profile_migration";

export type ProfileMigrationOutcome =
  /** The box never had an assistant profile. Nothing to say. */
  | "none"
  /** The desktop profile did not exist; the assistant's became it. */
  | "adopted"
  /** Both existed (or adopting was not safe). The desktop one is used; the assistant's is kept on disk. */
  | "kept-separate";

export interface ProfileMigrationRecord {
  outcome: ProfileMigrationOutcome;
  /** The assistant profile(s) found, left untouched on disk in every outcome. */
  agentProfiles: string[];
  /** Why an assistant profile was not adopted, when one was not. */
  reason?: string;
}

/** Disk caches Chromium rebuilds by itself; not worth copying, and they are most of a profile's size. */
const CACHE_DIR_NAMES = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "GraphiteDawnCache", "ShaderCache", "CacheStorage", "ScriptCache", "Crashpad", "component_crx_cache"]);
/** One browser's claim on a profile directory. A copy must not carry the old browser's. */
const SINGLETON_RE = /^Singleton(Lock|Socket|Cookie)$/;

/** The leading number of a Chromium version (`153.0.8010.12`, `Chromium 153.0…`), or null. */
export function chromiumMajor(text: string): number | null {
  const m = /(\d+)\.\d+\.\d+\.\d+/.exec(text);
  return m ? Number(m[1]) : null;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** The assistant profiles the gateway kept under `<openclawHome>/browser/<name>/user-data`. */
export async function findAgentProfiles(openclawHome: string): Promise<string[]> {
  const root = path.join(openclawHome, "browser");
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const found: Array<{ dir: string; mtime: number }> = [];
  for (const name of names) {
    const dir = path.join(root, name, "user-data");
    try {
      const stat = await fs.stat(path.join(dir, "Local State"));
      found.push({ dir, mtime: stat.mtimeMs });
    } catch {
      // Not a browser profile (or never started): nothing in it to keep.
    }
  }
  // Most recently used first: that is the one the assistant was signed in with.
  return found.sort((a, b) => b.mtime - a.mtime).map((p) => p.dir);
}

/**
 * Decide, once, which profile the one browser runs on — and never lose a
 * sign-in without saying so.
 *
 * THE DESKTOP PROFILE SURVIVES. It is the one the owner has been looking at:
 * their sign-ins, their bookmarks, their theme.
 *
 *   - No assistant profile on the box (it never browsed on its own): nothing
 *     to do.
 *   - An assistant profile and NO desktop profile (the owner never opened the
 *     Browser app): the assistant's profile becomes the desktop profile. It is
 *     copied, not moved, without its disk caches — the original stays where it
 *     was, so the escape hatch finds it as it left it.
 *   - Both exist: the desktop profile is used as it is. Two Chromium profiles
 *     cannot be merged safely (cookies, saved passwords and site storage are
 *     separate databases keyed to their own profile), so the assistant's is
 *     LEFT ON DISK, untouched, and the outcome is recorded — the Browser
 *     settings panel then tells the owner that sites only the assistant was
 *     signed in to need one sign-in in the shared browser, and where the old
 *     profile is.
 *
 * Adoption is refused — and treated as "both exist" — when it could damage the
 * copy: the desktop profile is one the owner configured themselves, or the
 * assistant's profile was last written by a NEWER Chromium than the desktop
 * one (Chromium refuses to open a profile from a later version).
 *
 * A browser still running on the assistant's profile means its databases are
 * mid-write, so it is closed first — it is the hidden browser this change
 * retires. If it will not go, the migration rejects, which is the register's
 * "ask again at the next boot".
 *
 * Skipped, and recorded as run, when the owner chose the isolated assistant
 * browser: there is nothing to unify on that box.
 */
export function agentProfileMigration(deps: {
  readDesktop: () => Promise<DesktopBrowserConfig>;
  openclawHome: string;
  /**
   * Close the assistant's hidden browser on this profile directory and say
   * whether the profile is free afterwards. It is the browser this change
   * retires, so closing it is not taking anything from anyone.
   */
  releaseProfile: (profileDir: string) => Promise<boolean>;
  /** The desktop browser's `--version` line, or null when it cannot be asked. */
  desktopBrowserVersion: (desktop: DesktopBrowserConfig) => Promise<string | null>;
  record: (value: ProfileMigrationRecord) => Promise<void>;
}): BootMigration {
  return {
    id: "browser-one-profile",
    label: "moved the box to one browser profile shared by the owner and the assistant",
    run: async () => {
      const desktop = await deps.readDesktop();
      if (desktop.agentIsolated) return false;
      const agentProfiles = await findAgentProfiles(deps.openclawHome);
      if (agentProfiles.length === 0) {
        await deps.record({ outcome: "none", agentProfiles });
        return false;
      }
      const keep = async (reason: string): Promise<boolean> => {
        await deps.record({ outcome: "kept-separate", agentProfiles, reason });
        console.log(`[boot-migrations] browser: the assistant's old profile is kept at ${agentProfiles[0]} and not used (${reason})`);
        return true;
      };

      if (await exists(path.join(desktop.profileDir, "Local State"))) return keep("the desktop browser already has a profile");
      if (!desktop.ownProfile) return keep("the desktop profile is one the owner configured");

      const source = agentProfiles[0];
      if (!(await deps.releaseProfile(source))) throw new Error("the assistant's browser is still running on its old profile");

      const lastVersion = await fs.readFile(path.join(source, "Last Version"), "utf-8").catch(() => "");
      const sourceMajor = chromiumMajor(lastVersion);
      const targetMajor = chromiumMajor((await deps.desktopBrowserVersion(desktop)) ?? "");
      if (sourceMajor === null || targetMajor === null) return keep("the two browsers' versions could not be compared");
      if (sourceMajor > targetMajor) return keep(`it was written by Chromium ${sourceMajor}, newer than the desktop browser's ${targetMajor}`);

      // Copied beside the destination and renamed into place, so a box that
      // loses power mid-copy has either no desktop profile or a whole one.
      const staging = `${desktop.profileDir}.adopting`;
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(path.dirname(desktop.profileDir), { recursive: true });
      await fs.cp(source, staging, {
        recursive: true,
        preserveTimestamps: true,
        // A symlink is copied as the link it is (SingletonLock is one), never followed.
        verbatimSymlinks: true,
        filter: (src) => {
          const name = path.basename(src);
          return !CACHE_DIR_NAMES.has(name) && !SINGLETON_RE.test(name);
        },
      });
      // An empty directory left by an earlier, failed start is the only thing
      // that can be in the way here — `Local State` was checked above.
      await fs.rm(desktop.profileDir, { recursive: true, force: true });
      await fs.rename(staging, desktop.profileDir);
      await deps.record({ outcome: "adopted", agentProfiles });
      return true;
    },
  };
}

/** `<binary> --version`, bounded; null when the binary cannot be found or asked. */
export async function chromiumVersionOf(executable: string | null): Promise<string | null> {
  if (!executable) return null;
  try {
    const { stdout } = await exec(executable, ["--version"], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ─── The keeper ──────────────────────────────────────────────────────────────

/** How often the keeper looks. A closed window is back within this. */
export const KEEPER_INTERVAL_MS = 20_000;
/** The longest it leaves a browser that will not start alone between tries. */
export const KEEPER_MAX_BACKOFF_MS = 5 * 60_000;

export type KeeperAction =
  /** The owner chose the isolated assistant browser: the keeper keeps nothing. */
  | "isolated"
  /** The shared browser is up. */
  | "running"
  /** It was down and the unit was asked to start it. */
  | "started"
  /** A person's browser holds the port; it is never closed to make room. */
  | "port-taken"
  /** The start was attempted and failed. */
  | "failed";

export interface KeeperDeps {
  readDesktop: () => Promise<DesktopBrowserConfig>;
  /** Pids of the browser on the configured profile, whoever started it. */
  findBrowserPids: (desktop: DesktopBrowserConfig) => Promise<number[]>;
  /** Who else answers on the CDP port: the assistant's hidden browser, or a person's. */
  findPortHolders: (desktop: DesktopBrowserConfig) => Promise<{ assistant: number[]; other: number[] }>;
  /** Close the assistant's hidden browser — and nothing else — off the port. */
  closeAssistantBrowser: (desktop: DesktopBrowserConfig) => Promise<number>;
  /** Write the start page where the launch script reads it, clear stale locks, start the unit. */
  startBrowser: (desktop: DesktopBrowserConfig) => Promise<void>;
}

/**
 * One look at the box, and at most one action.
 *
 * The shared browser must be up for the assistant to browse at all — the
 * gateway attaches and never launches — so "the owner closed the window" and
 * "the box rebooted" both end here, with the unit asked to start it again.
 *
 * The one thing it clears out of the way is the assistant's own hidden browser
 * (headless, or on a gateway-managed profile): on a box that just updated, that
 * is the SECOND browser this change removes, and it holds the port the shared
 * one needs. A person's browser on the port is reported and left alone.
 */
export async function keepSharedBrowser(deps: KeeperDeps): Promise<KeeperAction> {
  const desktop = await deps.readDesktop();
  if (desktop.agentIsolated) return "isolated";
  if ((await deps.findBrowserPids(desktop)).length > 0) return "running";
  const holders = await deps.findPortHolders(desktop);
  if (holders.other.length > 0 && holders.assistant.length === 0) return "port-taken";
  if (holders.assistant.length > 0) await deps.closeAssistantBrowser(desktop);
  try {
    await deps.startBrowser(desktop);
    return "started";
  } catch (err) {
    console.error("[browser] Could not start the shared browser:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/**
 * Keep the shared browser up for the life of this server.
 *
 * A start that keeps failing (no Chromium yet on a box mid-install, no display)
 * is retried at a doubling interval up to KEEPER_MAX_BACKOFF_MS, so a box that
 * cannot start a browser is not asking systemd to every twenty seconds.
 * Answers a stop function, for the test.
 */
export function startSharedBrowserKeeper(deps: KeeperDeps, options: { firstDelayMs?: number } = {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let delay = KEEPER_INTERVAL_MS;
  let lastLogged: KeeperAction | null = null;
  const tick = async () => {
    if (stopped) return;
    let action: KeeperAction = "failed";
    try {
      action = await keepSharedBrowser(deps);
    } catch (err) {
      console.error("[browser] Shared-browser check failed:", err instanceof Error ? err.message : err);
    }
    // "started" is followed by a look at the normal interval: the next tick is
    // what finds out whether it came up. Two in a row means it did not stay up.
    const struggling = action === "failed" || action === "port-taken" || (action === "started" && lastLogged === "started");
    delay = struggling ? Math.min(delay * 2, KEEPER_MAX_BACKOFF_MS) : KEEPER_INTERVAL_MS;
    if (action !== lastLogged && action !== "running") {
      if (action === "started") console.log("[browser] The shared browser was not running; started it");
      if (action === "port-taken") console.warn("[browser] Another browser holds the shared browser's CDP port; leaving it alone");
    }
    lastLogged = action;
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer.unref();
  };
  timer = setTimeout(tick, options.firstDelayMs ?? 5_000);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
