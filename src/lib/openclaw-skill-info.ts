import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { findOpenclawBin, getSkillsDir, openclawIsAbsent } from "@/lib/openclaw-config";

/**
 * The skill list behind GET /setup-api/apps/skill-info.
 *
 * `openclaw skills list --json` is the one source for `eligible` and
 * `missing.*`: those are EVALUATED by OpenClaw (is the bin on PATH, is the env
 * var set), not declared, so reading SKILL.md ourselves would change what the
 * "Ready / Needs setup" badge means. But the scan costs 7–8 s on the Jetson,
 * and a 30 s cache meant nearly every open of an installed app's window paid
 * it. So the list is served stale-while-revalidate: whatever is cached is
 * answered at once and a refresh runs behind it once the copy is older than
 * {@link STALE_AFTER_MS}; only the first call after a web-server boot waits.
 * The install and uninstall routes call {@link refreshSkillsCache} so the
 * window opened right after an install already lists the new skill.
 *
 * Lives outside the route file because a route module may export only its
 * handlers, and the install/uninstall routes need the refresh hook.
 */

export interface SkillInfo {
  name: string;
  description: string;
  emoji: string | null;
  eligible: boolean;
  primaryEnv: string | null;
  requiredEnv: string[];
  requiredBins: string[];
  requiredConfig: string[];
  source: string;
}

/** Thrown when there is no list to answer with: the CLI failed and nothing was cached. */
export class SkillListUnavailableError extends Error {
  constructor(cause: string) {
    super(`Skill list unavailable: ${cause}`);
    this.name = "SkillListUnavailableError";
  }
}

const execFileAsync = promisify(execFile);
const STALE_AFTER_MS = 30_000;

let cachedSkills: SkillInfo[] | null = null;
let cacheTime = 0;
let inFlightLoad: Promise<SkillInfo[]> | null = null;

async function scanSkills(): Promise<SkillInfo[]> {
  const bin = findOpenclawBin();
  const { stdout } = await execFileAsync(bin, ["skills", "list", "--json"], {
    timeout: 30_000,
    env: { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH}` },
  });
  const data = JSON.parse(stdout);
  const skills = (data.skills || []) as Record<string, unknown>[];
  return skills.map((s) => ({
    name: (s.name as string) || "",
    description: (s.description as string) || "",
    emoji: (s.emoji as string) || null,
    eligible: !!(s.eligible),
    primaryEnv: (s.primaryEnv as string) || null,
    requiredEnv: ((s.missing as Record<string, unknown>)?.env as string[]) || [],
    requiredBins: ((s.missing as Record<string, unknown>)?.bins as string[]) || [],
    requiredConfig: ((s.missing as Record<string, unknown>)?.config as string[]) || [],
    source: (s.source as string) || "",
  }));
}

/** One scan at a time; concurrent callers share it. Rejects only when nothing is cached. */
function load(): Promise<SkillInfo[]> {
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = scanSkills()
    .then((skills) => {
      cachedSkills = skills;
      cacheTime = Date.now();
      return skills;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[skill-info] Failed to load skills:", msg);
      if (cachedSkills) return cachedSkills;
      throw new SkillListUnavailableError(msg);
    })
    .finally(() => { inFlightLoad = null; });
  return inFlightLoad;
}

/**
 * Every skill OpenClaw knows. Served from the cache when there is one — a
 * stale copy is answered immediately and refreshed behind the caller — and
 * awaited only when nothing has been scanned yet since boot.
 */
export async function listSkills(): Promise<SkillInfo[]> {
  if (cachedSkills) {
    if (Date.now() - cacheTime >= STALE_AFTER_MS) void load().catch(() => {});
    return cachedSkills;
  }
  return load();
}

/**
 * One skill by name, or null when OpenClaw does not have it.
 *
 * A miss in the cached list is re-checked against the disk before it becomes
 * a 404: a folder under `<workspace>/skills/<name>` that the list does not
 * mention was installed after the last scan (from the Terminal, or by the
 * agent's own shell), so the list is rescanned once for it. A name with no
 * folder is either bundled — and then already in the list — or gone, and
 * answers in milliseconds either way.
 */
export async function findSkill(appId: string): Promise<SkillInfo | null> {
  const skills = await listSkills();
  const hit = skills.find((s) => s.name === appId);
  if (hit) return hit;
  const scannedAt = cacheTime;
  const onDisk = await fs.stat(path.join(getSkillsDir(), "skills", appId)).then((s) => s.isDirectory()).catch(() => false);
  if (!onDisk) return null;
  // A refresh may have landed while the disk was checked; otherwise run one.
  const fresh = scannedAt === cacheTime ? await load() : (cachedSkills ?? skills);
  return fresh.find((s) => s.name === appId) ?? null;
}

/**
 * Rescan in the background after an install or uninstall. The current copy
 * keeps serving until the new one lands, so nobody waits on it. A no-op on a
 * device without the openclaw binary (the uninstall route runs on Hermes too).
 */
export function refreshSkillsCache(): void {
  if (openclawIsAbsent()) return;
  cacheTime = 0;
  void load().catch(() => {});
}
