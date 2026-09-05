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
 * "Ready / Needs setup" badge means. But the scan is a full CLI boot — 4.2–5.3 s
 * measured on an Orin Nano, and the call carries a 30 s timeout for the times it
 * is worse — and `InstalledAppSettings` fetches this on every mount, so a 30 s
 * cache meant nearly every open of an installed app's window paid for one. So
 * the list is served stale-while-revalidate: whatever is cached is answered at
 * once and a refresh runs behind it once the copy is older than
 * {@link STALE_AFTER_MS}; only the first call after a web-server boot waits.
 *
 * The window is long because nothing in it changes on its own — a skill appears,
 * disappears or changes state only when something on this box acts — so the
 * freshness comes from INVALIDATION, not from the clock: install, uninstall and
 * both write paths of `apps/settings` all call {@link refreshSkillsCache}. The
 * two `apps/settings` paths matter as much as an install: OpenClaw never reports
 * a disabled skill as `eligible` (measured on a box: 31 of 59 skills disabled,
 * none of them eligible) and it evaluates a skill's required CONFIG the same way
 * it evaluates its bins and env (`missing.config`), so both the switch and a
 * saved credential change the fields the "Ready / Needs setup" badge is drawn
 * from.
 *
 * What that buys is the NEXT open of the window, not the one on screen:
 * `InstalledAppSettings` reads this once per mount and never refetches, so an
 * invalidation cannot repaint an open window. Without it, the window opened a
 * minute after a toggle or a Connect would describe the box as it was before —
 * for up to ten minutes rather than thirty seconds, which is what makes the
 * invalidation the price of the longer window rather than a nicety.
 *
 * ACCEPTED with the longer window: `eligible` can drift for up to ten minutes
 * when something OUTSIDE these routes changes it — a Terminal
 * `openclaw skills uninstall`/`enable`, an apt install that supplies a missing
 * binary, an env var exported into the gateway. {@link findSkill}'s disk
 * recheck covers only the out-of-band INSTALL, and only because that is a miss
 * in the cached list.
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
const STALE_AFTER_MS = 10 * 60_000;
/**
 * How long a FAILED scan is remembered. `load()`'s catch used to leave
 * `cacheTime` untouched, so once the CLI started failing with something cached
 * — and after any invalidation that value is 0 — every single request started
 * another 30 s-timeout scan. Caching only successes means the more wedged the
 * CLI is, the harder the box is asked to run it. Same success/failure split as
 * the gateway status memo in `hermes-telegram.ts`; kept at the old freshness
 * window, since a failing CLI is worth re-asking about more often than a
 * working one is.
 */
const FAILURE_STALE_AFTER_MS = 30_000;

let cachedSkills: SkillInfo[] | null = null;
let cacheTime = 0;
/** False when `cacheTime` was stamped by a FAILED scan rather than a good one. */
let cacheAnswered = true;
let inFlightLoad: { epoch: number; promise: Promise<SkillInfo[]> } | null = null;
/**
 * Invalidation count. A scan that STARTED before the last invalidation is
 * describing the state that invalidation was called because it changed, so it
 * may neither be JOINED nor STORED — clearing `cacheTime` alone would let a
 * scan already in flight land a moment later and stamp the pre-change list as
 * fresh for the whole window. Harmless while that window was 30 s; ten minutes
 * of it is not.
 *
 * All three halves of the gateway-status memo in `hermes-telegram.ts`, because
 * they only work together: don't store a pre-invalidation result, don't join a
 * pre-invalidation read (or an invalidation would discard the scan it joined
 * and start nothing in its place), and clear only your OWN in-flight entry, or
 * an abandoned read evicts the replacement the invalidation started.
 */
let scanEpoch = 0;

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
  const epoch = scanEpoch;
  if (inFlightLoad && inFlightLoad.epoch === epoch) return inFlightLoad.promise;
  const promise = scanSkills()
    .then((skills) => {
      if (epoch === scanEpoch) {
        cachedSkills = skills;
        cacheTime = Date.now();
        cacheAnswered = true;
      }
      return skills;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[skill-info] Failed to load skills:", msg);
      if (cachedSkills) {
        if (epoch === scanEpoch) {
          cacheTime = Date.now();
          cacheAnswered = false;
        }
        return cachedSkills;
      }
      throw new SkillListUnavailableError(msg);
    })
    .finally(() => {
      if (inFlightLoad?.epoch === epoch) inFlightLoad = null;
    });
  inFlightLoad = { epoch, promise };
  return promise;
}

/**
 * Every skill OpenClaw knows. Served from the cache when there is one — a
 * stale copy is answered immediately and refreshed behind the caller — and
 * awaited only when nothing has been scanned yet since boot.
 */
export async function listSkills(): Promise<SkillInfo[]> {
  if (cachedSkills) {
    const age = Date.now() - cacheTime;
    // `age >= 0` because Date.now() is wall-clock: an RTC corrected BACKWARDS
    // by NTP would otherwise pin the entry until the clock caught up.
    if (!(age >= 0 && age < (cacheAnswered ? STALE_AFTER_MS : FAILURE_STALE_AFTER_MS))) {
      void load().catch(() => {});
    }
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
// Every character a skill folder name may contain. A name is REBUILT from
// this alphabet before it touches a path (same discipline as webapp-icon's
// safeAppId): a `.test()` alone does not break the taint chain CodeQL
// follows for js/path-injection, a character-by-character rebuild does.
const SKILL_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-";

/** The name rebuilt from the alphabet, or null when it is no skill name. */
function safeSkillName(appId: string): string | null {
  if (appId.length < 1 || appId.length > 64) return null;
  // No leading dot or dash: never a hidden folder, never a flag lookalike.
  if (appId[0] === "." || appId[0] === "-") return null;
  let safe = "";
  for (const ch of appId) {
    const at = SKILL_NAME_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += SKILL_NAME_ALPHABET[at];
  }
  return safe;
}

export async function findSkill(appId: string): Promise<SkillInfo | null> {
  // The route validates its query param, but this is the function that puts
  // the name into a filesystem path, so the guard lives here too (CodeQL
  // js/path-injection): anything not a bare slug cannot be installed.
  const safeName = safeSkillName(appId);
  if (safeName === null) return null;
  const skills = await listSkills();
  const hit = skills.find((s) => s.name === safeName);
  if (hit) return hit;
  const scannedAt = cacheTime;
  const onDisk = await fs.stat(path.join(getSkillsDir(), "skills", safeName)).then((s) => s.isDirectory()).catch(() => false);
  if (!onDisk) return null;
  // A refresh may have landed while the disk was checked; otherwise run one.
  const fresh = scannedAt === cacheTime ? await load() : (cachedSkills ?? skills);
  return fresh.find((s) => s.name === safeName) ?? null;
}

/**
 * Rescan in the background after anything that changes what the list says: an
 * install, an uninstall, or a flip of a skill's enable switch. The current copy
 * keeps serving until the new one lands, so nobody waits on it. A no-op on a
 * device without the openclaw binary (the uninstall route runs on Hermes too).
 *
 * A scan already in flight when this is called was started BEFORE the change
 * and is dropped rather than stored (see {@link scanEpoch}); `cacheTime` stays
 * 0, so the next reader is served the old list at once and starts a scan that
 * can see the change.
 */
export function refreshSkillsCache(): void {
  if (openclawIsAbsent()) return;
  cacheTime = 0;
  cacheAnswered = true;
  scanEpoch += 1;
  void load().catch(() => {});
}
