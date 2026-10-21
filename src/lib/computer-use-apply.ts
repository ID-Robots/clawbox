import { execFile } from "child_process";
import { promisify } from "util";

import { getKnown, resolveConfigRoot } from "@/lib/config-store";
import { harnessesHere, restartHermesGatewayIfRunning } from "@/lib/clawbox-mcp-registration";
import { COMPUTER_USE_KEY, computerUseSwitchFromValue, type ComputerUseSwitch } from "@/lib/computer-use-switch";
import path from "@/lib/runtime-path";

const execFileAsync = promisify(execFile);
const REGISTER_SCRIPT = path.join("scripts", "register-mcp.sh");

/**
 * The I/O half of the computer_use switch (the pure half is
 * src/lib/computer-use-switch.ts): read the stored decision, and apply one.
 */

/** Only the Hermes edition (and dual) has a leg; see computer-use-switch.ts. */
export function computerUseSupported(): boolean {
  return harnessesHere().hermes;
}

/** The stored decision; a store that cannot be read is `null`, not a guess. */
export async function readStoredComputerUseSwitch(): Promise<ComputerUseSwitch | null> {
  const { value, known } = await getKnown(COMPUTER_USE_KEY);
  return known ? computerUseSwitchFromValue(value) : null;
}

/** The line register-mcp.sh prints once `hermes tools <verb> computer_use` answered 0. */
export function computerUseAppliedLine(enabled: boolean): string {
  return `computer_use toolset ${enabled ? "on" : "off"} (Settings switch)`;
}

export interface ComputerUseApplyResult {
  /** Hermes' CLI took the new state. */
  applied: boolean;
  /** A running messaging gateway restarted; null = none was running. */
  gatewayRestarted: boolean | null;
  error: string | null;
}

/**
 * Make the saved switch true now, through the SAME code the boot runs:
 * register-mcp.sh, which takes `${HERMES_CONFIG}.lock`, reads the key just
 * saved and runs Hermes' own `hermes tools enable|disable computer_use`. One
 * path for both, so what a toggle does and what the next boot repeats cannot
 * drift apart.
 *
 * The script exits 0 when the CLI refuses (a boot must never abort over this
 * step), so its exit status is not the answer: only the line it prints AFTER
 * the CLI answered 0 counts as applied. Then a running messaging gateway is
 * restarted so it stops serving the old toolset. Never throws.
 */
export async function applyComputerUseSwitch(enabled: boolean): Promise<ComputerUseApplyResult> {
  const root = resolveConfigRoot();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("/bin/bash", [path.join(root, REGISTER_SCRIPT)], {
      env: { ...process.env, CLAWBOX_ROOT: root, HOME: process.env.HOME || "/home/clawbox" },
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    console.error("[computer-use] register-mcp.sh failed:", err instanceof Error ? err.message : err);
    const partial = (err as { stdout?: unknown } | null)?.stdout;
    stdout = typeof partial === "string" ? partial : "";
  }
  if (!stdout.includes(computerUseAppliedLine(enabled))) {
    return {
      applied: false,
      gatewayRestarted: null,
      error: "The switch is saved, but Hermes did not take it yet. The next web-server start applies it.",
    };
  }
  const restarted = await restartHermesGatewayIfRunning();
  return {
    applied: true,
    gatewayRestarted: restarted,
    error: restarted === false
      ? "The switch is saved and Hermes took it, but the messaging gateway did not restart. The next gateway start applies it."
      : null,
  };
}
