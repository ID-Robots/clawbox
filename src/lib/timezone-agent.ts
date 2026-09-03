/**
 * Telling the ASSISTANT what time it is. TASK-514.
 *
 * Setting the OS zone fixes `date` and every process started afterwards, but it
 * does not by itself fix the running agent, and that is the half of the defect
 * customers actually saw. Two reasons, and this module answers both:
 *
 *  1. The gateway is a long-lived Node process. ICU resolves the default zone
 *     once and caches it, so a live `timedatectl set-timezone` does not reach a
 *     process that is already up — it keeps answering in the zone it booted in.
 *     Hence the gateway restart.
 *  2. OpenClaw has a first-class setting for this: `agents.defaults.userTimezone`
 *     (VERIFIED against the openclaw build installed on the device —
 *     `ZodOptional<ZodString>` in dist/plugin-sdk/config-schema.d.ts, read at
 *     dist/session-system-events-*.js as `cfg.agents?.defaults?.userTimezone`,
 *     documented as "Timezone for system prompt context … Falls back to host
 *     timezone"). It goes into the system prompt as `Time zone: <zone>`. Writing
 *     it explicitly means the agent's answer no longer depends on the host
 *     fallback happening to be right in whatever process it is asked from.
 *
 * Hermes has no openclaw.json, so on that SKU only the persona line is written
 * — which is also why the line is written on BOTH editions rather than treating
 * the config key as sufficient. `personaFilesFor()` resolves to the files the
 * RUNNING agent reads, and on a ClawBox the Hermes paths are symlinks into the
 * shared ~/.clawbox/agent-identity bridge, so one write keeps both in step.
 *
 * Everything here is BEST-EFFORT. A timezone that reached the OS is the fix;
 * failing the owner's request because the gateway would not restart would turn
 * a working change into an error message.
 */

import fs from "fs/promises";
import path from "path";
import { getActiveHarness } from "@/lib/harness";
import { personaFilesFor } from "@/lib/language-persona";
import {
  openclawIsAbsent,
  restartGateway,
  runOpenclawConfigSet,
} from "@/lib/openclaw-config";
import { isValidTimezoneName } from "@/lib/timezone";

/** The OpenClaw config path that ends up in the agent's system prompt. */
export const OPENCLAW_TIMEZONE_KEY = "agents.defaults.userTimezone";

const CONFIG_SET_TIMEOUT_MS = 60_000;

export interface AnnounceOptions {
  /**
   * Restart the gateway so a process that is already up stops answering in the
   * zone it booted in. Skipped by the setup wizard, which completes by starting
   * the harness anyway — a restart there would only lengthen the last screen.
   */
  restartHarness?: boolean;
}

export interface AnnounceResult {
  /** `agents.defaults.userTimezone` was written. */
  configWritten: boolean;
  /** The `- **Timezone:**` line in USER.md was written. */
  personaWritten: boolean;
  /** The gateway was restarted so a running agent picks the zone up. */
  harnessRestarted: boolean;
}

/**
 * Rewrite the persona `- **Timezone:**` line, idempotently.
 *
 * Same shape as writeLanguagePersona()'s language line and placed next to it on
 * purpose: USER.md is a short list of facts about the box's human, and where
 * they are is one of them.
 */
async function writeTimezonePersona(zone: string, userFile: string): Promise<boolean> {
  if (!isValidTimezoneName(zone)) return false;
  try {
    await fs.mkdir(path.dirname(userFile), { recursive: true }).catch(() => {});
    let userMd = await fs
      .readFile(userFile, "utf-8")
      .catch(() => "# USER.md - About Your Human\n");
    userMd = userMd.replace(/\n- \*\*Timezone:\*\*.*\n/g, "\n");
    const line = `- **Timezone:** ${zone} — the device clock is set to this zone; answer time questions in it`;
    if (userMd.includes("- **Language:**")) {
      userMd = userMd.replace(/(- \*\*Language:\*\*.*\n)/, `$1${line}\n`);
    } else if (userMd.includes("- **Name:**")) {
      userMd = userMd.replace(/(- \*\*Name:\*\*.*\n)/, `$1${line}\n`);
    } else {
      userMd = userMd.trimEnd() + `\n${line}\n`;
    }
    await fs.writeFile(userFile, userMd, "utf-8");
    return true;
  } catch (err) {
    console.error(
      `[timezone] Failed to update ${userFile}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Propagate an already-applied OS timezone to the assistant.
 *
 * Never throws: the caller has already changed the system clock's zone, which
 * is the fix; this is the part that makes the agent agree with it.
 */
export async function announceTimezoneToAgent(
  zone: string,
  opts: AnnounceOptions = {},
): Promise<AnnounceResult> {
  const result: AnnounceResult = {
    configWritten: false,
    personaWritten: false,
    harnessRestarted: false,
  };
  if (!isValidTimezoneName(zone)) return result;

  if (!openclawIsAbsent()) {
    try {
      await runOpenclawConfigSet([OPENCLAW_TIMEZONE_KEY, zone], {
        timeoutMs: CONFIG_SET_TIMEOUT_MS,
      });
      result.configWritten = true;
    } catch (err) {
      console.warn(
        "[timezone] Could not write agents.defaults.userTimezone:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  try {
    const files = personaFilesFor(await getActiveHarness());
    result.personaWritten = await writeTimezonePersona(zone, files.userFile);
  } catch (err) {
    console.warn(
      "[timezone] Could not write the persona timezone line:",
      err instanceof Error ? err.message : err,
    );
  }

  if (opts.restartHarness) {
    try {
      await restartGateway();
      result.harnessRestarted = true;
    } catch (err) {
      console.warn(
        "[timezone] Gateway restart failed; the agent keeps the zone it booted in until it next restarts:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}
