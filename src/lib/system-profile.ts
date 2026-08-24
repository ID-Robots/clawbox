/**
 * The settings model behind Settings → System → "Desktop environment" and
 * "Performance mode" (TASK-455).
 *
 * Both toggles are thin wrappers over a root-owned shell script that owns the
 * actual system change:
 *
 *   /usr/local/libexec/clawbox/clawbox-desktop-mode.sh   --check|--enable|--disable
 *   /usr/local/libexec/clawbox/clawbox-power-mode.sh     --check|--balanced|--performance
 *
 * The scripts are the source of truth for STATE — they read `systemctl
 * get-default` and `nvpmodel -q`, so a box changed over SSH still reports
 * honestly — and data/config.json only records the owner's last expressed
 * INTENT, for the cases where the live state can't be read (nvpmodel absent in
 * dev/CI) and so the UI has something to show before the first probe returns.
 *
 * Why `--check` runs WITHOUT sudo: it only reads systemctl/nvpmodel state, so
 * the status route needs no privilege at all and the sudoers grants
 * (config/clawbox-sudoers) cover just the four mutating invocations.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import * as configStore from "./config-store";

const execFileAsync = promisify(execFile);

/** Root-owned entrypoint directory. Overridable for tests only. */
export const LIBEXEC_DIR = process.env.CLAWBOX_LIBEXEC_DIR || "/usr/local/libexec/clawbox";

const DESKTOP_SCRIPT = "clawbox-desktop-mode.sh";
const POWER_SCRIPT = "clawbox-power-mode.sh";

/** config.json keys. Persisted intent, not live state — see the module note. */
export const DESKTOP_CONFIG_KEY = "desktop_environment_enabled";
export const POWER_CONFIG_KEY = "power_profile";

const COMMAND_TIMEOUT_MS = 20_000;

export type PowerMode = "balanced" | "performance";

export interface DesktopModeStatus {
  /** false when systemctl isn't available at all (dev machine, container). */
  supported: boolean;
  /** The persisted intent: is the box set to boot into the desktop? */
  enabled: boolean;
  /** Is the graphical stack up RIGHT NOW? */
  active: boolean;
  /** enabled !== active — the toggle has been flipped but not yet rebooted into. */
  rebootRequired: boolean;
  defaultTarget: string;
  displayManager: string;
}

export interface PowerModeStatus {
  /** false when nvpmodel isn't present — i.e. this is not a Jetson. */
  supported: boolean;
  mode: PowerMode;
  nvpmodelId: number | null;
  nvpmodelName: string;
  clocksPinned: boolean;
  balancedId: number | null;
  performanceId: number | null;
}

/**
 * Where the script actually lives.
 *
 * The root-owned copy is the only one the sudoers grants match, so mutations
 * always use it. `--check` falls back to the repo copy because it changes
 * nothing and needs no privilege — without that fallback the Settings panel
 * would be blank on a dev machine and in the component tests.
 */
export function resolveScript(name: string, opts: { allowRepoFallback?: boolean } = {}): string | null {
  const installed = path.join(LIBEXEC_DIR, name);
  if (fs.existsSync(installed)) return installed;
  if (!opts.allowRepoFallback) return null;
  const repo = path.join(
    process.env.CLAWBOX_ROOT || process.cwd(),
    "scripts",
    name,
  );
  return fs.existsSync(repo) ? repo : null;
}

/**
 * Run a script mode and parse the LAST JSON object it printed.
 *
 * Last, not first: the mutating modes echo a couple of human-readable progress
 * lines ("default target set to multi-user.target") before the closing state
 * report, and those lines are what an operator reading the journal actually
 * wants. Taking the last object means one parser serves both --check and the
 * mutations.
 */
async function runScript(script: string, args: string[], useSudo: boolean): Promise<Record<string, unknown>> {
  const cmd = useSudo ? "sudo" : script;
  const argv = useSudo ? [script, ...args] : args;
  const { stdout } = await execFileAsync(cmd, argv, { timeout: COMMAND_TIMEOUT_MS });
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));
  const last = lines[lines.length - 1];
  if (!last) throw new Error("script produced no status output");
  const parsed = JSON.parse(last) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("script status output was not an object");
  }
  return parsed as Record<string, unknown>;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isPowerMode(value: unknown): value is PowerMode {
  return value === "balanced" || value === "performance";
}

/**
 * The state a box reports when the toggle's machinery isn't installed — a dev
 * machine, CI, or a container test rig. `supported: false` is what makes the
 * UI render the switch disabled with an explanation instead of a broken
 * control or, worse, a switch that silently does nothing.
 */
function unsupportedDesktop(enabled: boolean): DesktopModeStatus {
  return {
    supported: false,
    enabled,
    active: enabled,
    rebootRequired: false,
    defaultTarget: "unknown",
    displayManager: "unknown",
  };
}

function unsupportedPower(mode: PowerMode): PowerModeStatus {
  return {
    supported: false,
    mode,
    nvpmodelId: null,
    nvpmodelName: "unknown",
    clocksPinned: false,
    balancedId: null,
    performanceId: null,
  };
}

async function persistedDesktopIntent(): Promise<boolean> {
  const stored = await configStore.get(DESKTOP_CONFIG_KEY);
  // Default ON. The desktop is a shipped, default-on feature, so an absent key
  // must read as "on" — never as "the owner turned it off".
  return typeof stored === "boolean" ? stored : true;
}

async function persistedPowerIntent(): Promise<PowerMode> {
  const stored = await configStore.get(POWER_CONFIG_KEY);
  return isPowerMode(stored) ? stored : "balanced";
}

export async function readDesktopMode(): Promise<DesktopModeStatus> {
  const script = resolveScript(DESKTOP_SCRIPT, { allowRepoFallback: true });
  const intent = await persistedDesktopIntent();
  if (!script) return unsupportedDesktop(intent);
  try {
    const raw = await runScript(script, ["--check"], false);
    return {
      supported: bool(raw.supported),
      enabled: bool(raw.enabled, intent),
      active: bool(raw.active, intent),
      rebootRequired: bool(raw.rebootRequired),
      defaultTarget: str(raw.defaultTarget, "unknown"),
      displayManager: str(raw.displayManager, "unknown"),
    };
  } catch {
    return unsupportedDesktop(intent);
  }
}

export async function readPowerMode(): Promise<PowerModeStatus> {
  const script = resolveScript(POWER_SCRIPT, { allowRepoFallback: true });
  const intent = await persistedPowerIntent();
  if (!script) return unsupportedPower(intent);
  try {
    const raw = await runScript(script, ["--check"], false);
    return {
      supported: bool(raw.supported),
      mode: isPowerMode(raw.mode) ? raw.mode : intent,
      nvpmodelId: intOrNull(raw.nvpmodelId),
      nvpmodelName: str(raw.nvpmodelName, "unknown"),
      clocksPinned: bool(raw.clocksPinned),
      balancedId: intOrNull(raw.balancedId),
      performanceId: intOrNull(raw.performanceId),
    };
  } catch {
    return unsupportedPower(intent);
  }
}

export class ProfileUnavailableError extends Error {
  constructor(script: string) {
    super(`${script} is not installed — run \`sudo bash install.sh --step performance_mode\``);
    this.name = "ProfileUnavailableError";
  }
}

/**
 * Flip the desktop on or off. Takes effect at the next boot by design — see
 * the header of clawbox-desktop-mode.sh for why we don't isolate the target
 * out from under a live session.
 */
export async function setDesktopMode(enabled: boolean): Promise<DesktopModeStatus> {
  const script = resolveScript(DESKTOP_SCRIPT);
  if (!script) throw new ProfileUnavailableError(DESKTOP_SCRIPT);
  await runScript(script, [enabled ? "--enable" : "--disable"], true);
  // Persist AFTER the script succeeds, so a failed toggle doesn't leave
  // config.json claiming a state the box was never put into.
  await configStore.set(DESKTOP_CONFIG_KEY, enabled);
  return readDesktopMode();
}

/** Switch the power profile. Applies immediately — no reboot. */
export async function setPowerMode(mode: PowerMode): Promise<PowerModeStatus> {
  const script = resolveScript(POWER_SCRIPT);
  if (!script) throw new ProfileUnavailableError(POWER_SCRIPT);
  await runScript(script, [mode === "performance" ? "--performance" : "--balanced"], true);
  await configStore.set(POWER_CONFIG_KEY, mode);
  return readPowerMode();
}
