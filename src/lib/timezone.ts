/**
 * The system timezone — Settings → System → "Time zone", and the one-shot the
 * setup wizard fires from the customer's own browser. TASK-514.
 *
 * The defect this exists for: the box shipped on `Etc/UTC` and nothing in the
 * product ever set or asked for a zone. The desktop clock still looked right,
 * because it is rendered by the BROWSER from the phone's or laptop's clock —
 * so the mismatch only showed up in the one place nobody could dismiss as
 * cosmetic: the assistant, which reads the OS clock, answering "10:11 AM UTC"
 * while the taskbar three inches away said 13:11. Every time-shaped request
 * behind it (reminders, "this morning", day boundaries, self-scheduled jobs)
 * inherited the same offset silently.
 *
 * Shape follows src/lib/system-profile.ts: a root-owned shell script owns the
 * actual change and is the source of truth for STATE, so a box whose zone was
 * set over SSH still reports honestly. `--check` and `--list` need no privilege
 * and run WITHOUT sudo; only `--set` goes through the grant in
 * config/clawbox-sudoers, which names this script with no argument spec because
 * the zone is validated in root-owned code — see the header of
 * scripts/clawbox-timezone.sh for why sudoers cannot express the narrower rule.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveScript } from "./system-profile";

const execFileAsync = promisify(execFile);

const TIMEZONE_SCRIPT = "clawbox-timezone.sh";
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * What a box that was never asked reports. Treated as "unset" rather than as a
 * choice: it is the systemd default, and a customer who genuinely wants UTC
 * picks it in Settings, which clears the marker below either way.
 */
export const DEFAULT_TIMEZONE = "Etc/UTC";

/**
 * config.json key. Set once the box has had a zone applied — by the wizard, by
 * Settings, or by the desktop's one-shot for a box that was already set up
 * before this shipped. Its only job is to stop the one-shot from ever asking
 * twice; the live zone always comes from the script.
 */
export const TIMEZONE_SYNCED_KEY = "timezone_auto_synced";

/** Longest IANA zone name is 30 chars ("America/Argentina/ComodRivadavia"). */
const MAX_ZONE_LENGTH = 64;

/**
 * Shape gate, mirroring validate_zone() in scripts/clawbox-timezone.sh.
 *
 * Deliberately duplicated rather than delegated: this copy turns junk into a
 * 400 before a shell is involved at all, and the root-side copy is the one that
 * actually holds — a caller that is not this web server never passes through
 * here. Neither is load-bearing on its own.
 *
 * The character class is what stops a zone name from being a path. No "." in
 * the set, so `../../etc` and every other traversal is refused on its shape
 * rather than by asking the filesystem; no leading slash, so it cannot be
 * absolute; no whitespace, quote, `$` or backslash, so it cannot grow a second
 * argument or survive being re-split by a shell.
 */
export function isValidTimezoneName(zone: unknown): zone is string {
  if (typeof zone !== "string") return false;
  if (zone.length === 0 || zone.length > MAX_ZONE_LENGTH) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9/_+-]*$/.test(zone)) return false;
  if (zone.endsWith("/")) return false;
  return true;
}

export class TimezoneUnavailableError extends Error {}

export interface TimezoneStatus {
  /** false when timedatectl isn't available at all (dev machine, container). */
  supported: boolean;
  /** The live IANA zone, read back from the OS. */
  timezone: string;
  /** The box's wall clock in that zone, e.g. "2026-09-03 20:34:38". */
  localTime: string;
  /** e.g. "+0300". */
  utcOffset: string;
  ntpSynchronized: boolean;
}

function scriptPath(opts: { allowRepoFallback?: boolean } = {}): string {
  const script = resolveScript(TIMEZONE_SCRIPT, opts);
  if (!script) {
    throw new TimezoneUnavailableError(
      `Timezone helper is not installed. Run: sudo bash install.sh --step systemd_services`,
    );
  }
  return script;
}

function parseStatus(stdout: string): TimezoneStatus {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .pop();
  if (!line) throw new Error("timezone helper produced no status output");
  const parsed = JSON.parse(line) as Partial<TimezoneStatus>;
  return {
    supported: parsed.supported === true,
    timezone: typeof parsed.timezone === "string" && parsed.timezone ? parsed.timezone : DEFAULT_TIMEZONE,
    localTime: typeof parsed.localTime === "string" ? parsed.localTime : "",
    utcOffset: typeof parsed.utcOffset === "string" ? parsed.utcOffset : "",
    ntpSynchronized: parsed.ntpSynchronized === true,
  };
}

/**
 * The live state. Runs the helper WITHOUT sudo — it only reads timedatectl —
 * and falls back to the repo copy so the Settings panel is populated on a dev
 * machine and in the component tests, exactly like readDesktopMode().
 */
export async function readTimezone(): Promise<TimezoneStatus> {
  const script = scriptPath({ allowRepoFallback: true });
  const { stdout } = await execFileAsync(script, ["--check"], { timeout: COMMAND_TIMEOUT_MS });
  return parseStatus(stdout);
}

/** Every zone the box will accept, for the Settings picker. No privilege needed. */
export async function listTimezones(): Promise<string[]> {
  const script = scriptPath({ allowRepoFallback: true });
  const { stdout } = await execFileAsync(script, ["--list"], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => isValidTimezoneName(l));
}

/**
 * Apply a zone. The ONLY privileged path in this module.
 *
 * Resolves the installed copy only — never the repo fallback — because the
 * sudoers grant matches `/usr/local/libexec/clawbox/clawbox-timezone.sh` and a
 * clawbox-writable script under the project directory could never be granted
 * safely (the rule the optimize-ollama.sh grant was moved to /usr/local/libexec
 * for). Returns the state read back AFTER the change, so the caller confirms
 * with the box's own clock rather than echoing what it just asked for.
 */
export async function setTimezone(zone: string): Promise<TimezoneStatus> {
  if (!isValidTimezoneName(zone)) {
    throw new Error(`Invalid timezone: ${JSON.stringify(zone)}`);
  }
  const script = scriptPath();
  const { stdout } = await execFileAsync(
    "/usr/bin/sudo",
    ["-n", script, "--set", zone],
    { timeout: COMMAND_TIMEOUT_MS },
  );
  return parseStatus(stdout);
}
