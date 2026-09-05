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
  if (typeof value !== "string") return false;
  const tz = value.trim();
  if (!tz || tz.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  if (tz.includes("..")) return false;
  try {
    // Throws RangeError for a zone ICU does not carry.
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone the SERVER process is running in — i.e. what the box's OS says.
 *
 * The same call OpenClaw's core makes when `userTimezone` is unset, which is
 * why an unfixed box answers in UTC.
 */
export function readOsTimeZone(): string {
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

  if (hasHermesHarness()) {
    try {
      await patchHermesConfig({ set: { [HERMES_TIMEZONE_KEY]: tz } });
      applied.push("hermes");
    } catch (err) {
      console.error("[timezone] could not set the Hermes timezone:", err);
      failure = failure
        ?? "The timezone was saved, but the assistant could not be told — it will keep answering in the old zone until this is retried.";
    }
  }

  return failure ? { applied, failure } : { applied };
}
