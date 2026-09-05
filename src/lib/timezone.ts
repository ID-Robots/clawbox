/**
 * The box's timezone — the one setting the setup wizard never asked for.
 *
 * A ClawBox image ships as `Etc/UTC` and nothing in this repository ever moved
 * it, so the agent — which runs ON the box — had UTC as its only "now". It
 * answered "10:11 AM UTC" while the desktop clock beside it, rendered from the
 * BROWSER, read 01:11 PM; "remind me at 8am" and "what did I do this morning"
 * resolved against the wrong day boundary, and near midnight the box was on the
 * wrong DATE. Nothing looked broken, which is the worst shape a bug can take on
 * a device people are asked to trust with their day (TASK-514).
 *
 * Three things have to learn the zone, and each harness already owns its half —
 * ClawBox writes into their keys rather than inventing a mechanism:
 *
 *  - **OpenClaw**: `agents.defaults.userTimezone`, an IANA zone that feeds the
 *    system prompt's Temporal Context block, message envelopes, heartbeat
 *    active hours and cron. Unset, the core resolves the HOST zone via
 *    `Intl.DateTimeFormat().resolvedOptions().timeZone` — which is exactly the
 *    UTC we are fixing. (`docs/concepts/timezone.md`, installed 2026.8.1.)
 *  - **Hermes**: the top-level `timezone` key in `~/.hermes/config.yaml` —
 *    "IANA timezone … Empty string means use server-local time"
 *    (`hermes_cli/config_defaults.py:2166-2168`, installed 0.20.5).
 *  - **The OS**, through `timedatectl set-timezone` in the `set_timezone` root
 *    step. Not redundant with the two above: Hermes' own prompt tells the agent
 *    "Current time, date, timezone → use terminal (e.g. `date`)"
 *    (`agent/prompt_builder.py:499`), the Terminal app is the owner's too, and
 *    every log line on the box carries it.
 */
import fs from "fs/promises";
import path from "path";
import { hasHermesHarness } from "@/lib/edition-source";
import { openclawIsAbsent, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { patchHermesConfig } from "@/lib/hermes-config-yaml";

/** OpenClaw's own key. Not a ClawBox invention — see the module comment. */
export const OPENCLAW_TIMEZONE_KEY = "agents.defaults.userTimezone";
/** Hermes' own key, top level in config.yaml. */
export const HERMES_TIMEZONE_KEY = "timezone";
/** The config-store key holding what the box has been TOLD. */
export const TIMEZONE_STORE_KEY = "timezone";
/** "adopted" (offered by a browser) or "explicit" (a person chose it). */
export const TIMEZONE_SOURCE_KEY = "timezone_source";
/**
 * The zone that actually LANDED in the harness.
 *
 * Separate from {@link TIMEZONE_STORE_KEY} because they answer different
 * questions, and conflating them is how a half-applied fix records itself as
 * done: the OpenClaw CLI wants 10-12 s per call on a Jetson and the gateway is
 * still coming up at exactly the moment a first desktop load fires the
 * adoption, so the write can fail. If the "we were told" key alone gated the
 * offer, that box would answer in UTC for ever with its own state saying the
 * timezone was adopted.
 */
export const TIMEZONE_APPLIED_KEY = "timezone_applied";

export function timezoneEnvPath(): string {
  return path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "timezone.env");
}

/**
 * Is this a zone the platform knows?
 *
 * `Intl` is the authority and there is no list to maintain — but it is not the
 * whole check. The value crosses into `data/timezone.env`, is read back by
 * install.sh running as ROOT and is handed to `timedatectl`, so the shape gate
 * comes first: IANA names are `Area/Location` over a small alphabet, and
 * anything carrying `..`, a leading `/` or a shell metacharacter is refused
 * before `Intl` is asked. `Intl` additionally accepts offset strings like
 * `+03:00` on Node 20+, which `timedatectl` does not — the `:` is out by the
 * same gate.
 */
export function isValidTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}

/**
 * The zone in ICU's own spelling, or null.
 *
 * CANONICALISED, not merely accepted, and that is the whole point of the
 * function. ICU is case-INSENSITIVE, so `europe/sofia` passes every check here
 * — while the root side asks the box's own zoneinfo database, which is a
 * case-sensitive filesystem lookup and answers no. The value would then be
 * written to the store, to `data/timezone.env` and into both harness keys, and
 * silently dropped by the root step. Only ICU's canonical spelling ever
 * reaches disk.
 *
 * The shape gate runs FIRST and is not redundant with ICU. The value crosses
 * into `data/timezone.env`, is read back by install.sh running as root and is
 * handed to `timedatectl`, so a leading `-` (option injection), a leading `/`,
 * a `..` or a shell metacharacter is refused before ICU is asked. ICU also
 * accepts offset strings like `+03:00` on Node 20+, which `timedatectl` does
 * not; the absent `:` is what keeps those out.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tz = value.trim();
  if (!tz || tz.length > 64) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return null;
  if (tz.includes("..")) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    // ICU canonicalises a LINK to its target ("Asia/Calcutta" → "Asia/Kolkata")
    // as well as the case. Re-run the shape gate over what comes back, because
    // what comes back is what is written.
    if (!resolved || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(resolved)) return null;
    return resolved;
  } catch {
    // RangeError: a zone ICU does not carry.
    return null;
  }
}

/**
 * The zone the SERVER process is running in — i.e. what the box's OS says.
 *
 * The same call OpenClaw's core makes when `userTimezone` is unset, which is
 * why an unfixed box answers in UTC.
 */
export async function readOsTimeZone(): Promise<string> {
  // `/etc/localtime` is what `timedatectl set-timezone` moves, and reading the
  // link is the only answer that is live. `Intl.DateTimeFormat()
  // .resolvedOptions().timeZone` — which is what OpenClaw's core falls back to,
  // and therefore what produced the UTC this fix is about — resolves ICU's
  // default ONCE PER PROCESS and caches it, so the long-lived clawbox-setup
  // server would keep reporting the pre-change zone until it restarted. That is
  // the probe-once class, on the one field that says whether the OS half landed.
  try {
    const target = await fs.readlink("/etc/localtime");
    const match = /zoneinfo\/(.+)$/.exec(target);
    if (match?.[1]) return match[1];
  } catch {
    // Not a symlink (some images copy the file), or unreadable.
  }
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface HarnessTimeZoneResult {
  /** Harnesses this device has that now carry the zone. */
  applied: ("openclaw" | "hermes")[];
  /** The first failure, in the owner's words. Absent when every leg landed. */
  failure?: string;
  /**
   * A leg that was WRITTEN but is not in effect yet, in the owner's words.
   *
   * Not a failure and not a success: Hermes bridges `config.yaml`'s `timezone`
   * into `HERMES_TIMEZONE` when its gateway STARTS (`gateway/run.py:2529` in
   * the installed 0.20.5) and `hermes_time.py` caches the resolved zone for the
   * process — it even ships a `reset_cache()` for exactly this. So a running
   * Hermes agent keeps answering in the old zone until it restarts, and saying
   * "the assistant now uses this timezone" would be a false success. Measured
   * read-only on the Hermes box, 2026-09-06.
   */
  pending?: string;
}

/**
 * Write the zone into whichever harnesses this device actually has.
 *
 * Both are attempted on a `dual` box, and the edition guards are not
 * decoration: `runOpenclawConfigSet` on the Hermes SKU manufactures an
 * `~/.openclaw` for a gateway that is removed and masked there, and
 * `patchHermesConfig` on the OpenClaw SKU writes a config.yaml no agent reads.
 */
export async function applyTimeZoneToHarness(tz: string): Promise<HarnessTimeZoneResult> {
  const applied: ("openclaw" | "hermes")[] = [];
  let failure: string | undefined;

  if (!openclawIsAbsent()) {
    try {
      // The CLI's own verified write, not a hand-edit of openclaw.json: it
      // validates against the core's schema and reconciles a concurrent writer.
      await runOpenclawConfigSet([OPENCLAW_TIMEZONE_KEY, tz]);
      applied.push("openclaw");
    } catch (err) {
      console.error("[timezone] could not set the OpenClaw user timezone:", err);
      failure = "The timezone was saved, but the assistant could not be told — it will keep answering in the old zone until this is retried.";
    }
  }

  let pending: string | undefined;
  if (hasHermesHarness()) {
    try {
      await patchHermesConfig({ set: { [HERMES_TIMEZONE_KEY]: tz } });
      applied.push("hermes");
      // Written, not yet in effect — see HarnessTimeZoneResult.pending. No
      // restart is issued from here: this can run from an ordinary desktop
      // load, and bouncing the agent underneath a turn in progress to apply a
      // clock setting is a worse trade than saying when it takes effect.
      pending = "Hermes reads the timezone when its gateway starts, so the assistant answers in the new "
        + "zone after the next restart (Settings → System → Restart assistant).";
    } catch (err) {
      console.error("[timezone] could not set the Hermes timezone:", err);
      failure = failure
        ?? "The timezone was saved, but the assistant could not be told — it will keep answering in the old zone until this is retried.";
    }
  }

  return { applied, ...(failure ? { failure } : {}), ...(pending ? { pending } : {}) };
}
