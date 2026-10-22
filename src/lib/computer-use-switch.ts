/**
 * The owner's switch for Hermes' built-in `computer_use` toolset (desktop
 * control: mouse, keyboard, screenshots of the box's own desktop).
 *
 * SHIPPED DORMANT. The Settings control and /setup-api/settings/computer-use
 * exist only while `CLAWBOX_COMPUTER_USE_SETTING=1`; with the flag off nothing
 * writes the key below, so every box behaves exactly as before the switch
 * existed.
 *
 * ABSENT MEANS UNMANAGED, not off — the opposite of the path-guard switch
 * (src/lib/path-guard-switch.ts), and on purpose: Hermes ships `computer_use`
 * enabled, and a switch that read "absent" as off would take it away from every
 * existing Hermes box at the next boot. Only a stored boolean is a decision:
 * scripts/register-mcp.sh §4 applies it at every boot through Hermes' own
 * `hermes tools enable|disable computer_use` (the same mechanism as its
 * `tools disable browser`), so an owner's choice survives reboots, updates and
 * a reinstalled ~/.hermes; with no boolean it makes no call at all.
 *
 * The OpenClaw edition has no leg: ClawBox does not wire OpenClaw's own
 * computer-control surface, so the route answers `supported: false` there and
 * Settings explains it rather than offering a control that would do nothing.
 *
 * Pure: no I/O, so the chat route, the Settings route and the tests share one
 * reading of the flag and the key.
 */
export const COMPUTER_USE_KEY = "clawbox_computer_use";
export const COMPUTER_USE_SETTING_ENV = "CLAWBOX_COMPUTER_USE_SETTING";
export const COMPUTER_USE_TOOLSET = "computer_use";

export type ComputerUseSwitch = "on" | "off" | "unmanaged";

/** The feature flag: on only for exactly `1`, so a stray value keeps it dormant. */
export function computerUseSettingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMPUTER_USE_SETTING_ENV] ?? "").trim() === "1";
}

/** A stored value, read the way register-mcp.sh reads it: only a boolean decides. */
export function computerUseSwitchFromValue(value: unknown): ComputerUseSwitch {
  if (value === true) return "on";
  if (value === false) return "off";
  return "unmanaged";
}

/** The switch out of a parsed device store (data/config.json). */
export function readComputerUseSwitch(store: unknown): ComputerUseSwitch {
  if (typeof store !== "object" || store === null || Array.isArray(store)) return "unmanaged";
  return computerUseSwitchFromValue((store as Record<string, unknown>)[COMPUTER_USE_KEY]);
}

/**
 * A `hermes chat -t` whitelist with `computer_use` taken out when the owner
 * switched it off. `-t` names the built-in toolsets for that one turn and so
 * bypasses the platform selection `hermes tools disable` wrote; without this an
 * operator's CLAWBOX_SMALL_MODEL_TOOLSETS could hand the toolset back.
 */
export function withoutComputerUse(toolsets: readonly string[], state: ComputerUseSwitch): readonly string[] {
  return state === "off" ? toolsets.filter((name) => name !== COMPUTER_USE_TOOLSET) : toolsets;
}
