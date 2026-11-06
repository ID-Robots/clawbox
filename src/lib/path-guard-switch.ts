import { execFile } from "child_process";
import { promisify } from "util";

import { getKnown, resolveConfigRoot } from "@/lib/config-store";
import { harnessesHere, restartHermesGatewayIfRunning } from "@/lib/clawbox-mcp-registration";
import { isPlainObject, readConfigStrict, restartGateway } from "@/lib/openclaw-config";
import path from "@/lib/runtime-path";

const execFileAsync = promisify(execFile);

/**
 * The owner's switch for the protected-path guard (Settings -> "Protect ClawBox
 * files from the agent", TASK-1661).
 *
 * The guard (TASK-605) refuses agent tool calls that delete, move, overwrite or
 * truncate the ClawBox tree and the local-model folders: the
 * `clawbox-path-guard` OpenClaw plugin, and `approvals.deny` globs on the
 * Hermes edition. Both are reconciled at every boot (gateway-pre-start.sh,
 * register-mcp.sh), and both read THIS key before they write, so an owner's
 * off survives reboots and updates.
 *
 * ABSENT MEANS ON; only the boolean `false` is off, the same rule as the boot
 * scripts (`is False`).
 */
export const PATH_GUARD_ENABLED_KEY = "clawbox_path_guard_enabled";
export const PATH_GUARD_PLUGIN_ID = "clawbox-path-guard";
const REGISTER_SCRIPT = path.join("scripts", "register-mcp.sh");

export function isPathGuardEnabledValue(value: unknown): boolean {
  return value !== false;
}

export async function readPathGuardEnabled(): Promise<boolean> {
  const { value, known } = await getKnown(PATH_GUARD_ENABLED_KEY);
  if (!known) return true;
  return isPathGuardEnabledValue(value);
}

/**
 * What OpenClaw's config says about the plugin right now: true / false from
 * `plugins.entries.clawbox-path-guard.enabled`, null when this edition has no
 * OpenClaw or the config could not be read.
 */
export async function readPathGuardLoaded(): Promise<boolean | null> {
  if (!harnessesHere().openclaw) return null;
  try {
    const config = await readConfigStrict();
    const plugins = config.plugins;
    const entries = isPlainObject(plugins) ? plugins.entries : undefined;
    const entry = isPlainObject(entries) ? entries[PATH_GUARD_PLUGIN_ID] : undefined;
    return isPlainObject(entry) ? entry.enabled === true : false;
  } catch {
    return null;
  }
}

export interface PathGuardApplyResult {
  openclaw: { restarted: boolean } | null;
  hermes: { applied: boolean } | null;
  error: string | null;
}

/**
 * Make the saved switch true now. OpenClaw: restart the gateway — its
 * pre-start writes `plugins.entries.<id>.enabled` from the switch, so the
 * restart IS the apply (same pattern as the MCP switch). Hermes: re-run
 * register-mcp.sh, which adds or removes the rendered deny globs, then restart
 * a running messaging gateway; a restart that fails is reported, not applied.
 * Never throws.
 */
export async function applyPathGuardSwitch(enabled: boolean): Promise<PathGuardApplyResult> {
  const here = harnessesHere();
  const result: PathGuardApplyResult = { openclaw: null, hermes: null, error: null };
  if (here.openclaw) {
    try {
      await restartGateway();
      result.openclaw = { restarted: true };
      if ((await readPathGuardLoaded()) === !enabled) {
        result.error ??= "The switch is saved and the gateway restarted, but its config does not show the new state yet. Check the ClawBox gateway log.";
      }
    } catch (err) {
      console.error("[path-guard] gateway restart failed:", err instanceof Error ? err.message : err);
      result.openclaw = { restarted: false };
      result.error ??= "The switch is saved, but the assistant's gateway did not come back after the restart. The next gateway start applies it.";
    }
  }
  if (here.hermes) {
    const root = resolveConfigRoot();
    try {
      await execFileAsync("/bin/bash", [path.join(root, REGISTER_SCRIPT)], {
        env: { ...process.env, CLAWBOX_ROOT: root, HOME: process.env.HOME || "/home/clawbox" },
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      console.error("[path-guard] register-mcp.sh failed:", err instanceof Error ? err.message : err);
      result.hermes = { applied: false };
      result.error ??= "The switch is saved, but Hermes' config could not be updated. The next web-server start applies it.";
    }
    if (!result.hermes) {
      // Never throws: false = a running gateway did not restart (or its status
      // could not be read), so it still holds the old approvals; null = none
      // was running, and the next start reads the new config.
      const restarted = await restartHermesGatewayIfRunning();
      result.hermes = { applied: restarted !== false };
      if (restarted === false) {
        result.error ??= "The switch is saved and Hermes' config updated, but the messaging gateway did not restart. The next gateway start applies it.";
      }
    }
  }
  return result;
}
