// ── Feature Flags ──
// Simple flag system backed by the preferences store (ff_* keys).
// Flags default to off unless specified here.

export interface FeatureFlag {
  id: string           // stored as ff_{id} in prefs
  name: string         // human label
  description: string  // shown in settings
  default: boolean     // default state when not set
}

export const FEATURE_FLAGS: FeatureFlag[] = [
  {
    id: "vscode",
    name: "VS Code",
    description: "Show VS Code (code-server) app on the desktop",
    default: false,
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Show terminal emulator app on the desktop",
    default: false,
  },
]

/** Map of flag id → default value, for quick lookup */
export const FLAG_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  FEATURE_FLAGS.map(f => [f.id, f.default])
)

/** Resolve a set of stored ff_* prefs into a complete flags map */
export function resolveFlags(stored: Record<string, unknown>): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const f of FEATURE_FLAGS) {
    const key = `ff_${f.id}`
    flags[f.id] = key in stored && typeof stored[key] === "boolean"
      ? stored[key] as boolean
      : // also check without prefix (preferences strip pref: on load)
        f.id in stored && typeof stored[f.id] === "boolean"
          ? stored[f.id] as boolean
          : f.default
  }
  return flags
}

/** App IDs gated behind a feature flag of the same name */
export const FLAG_GATED_APPS = new Set(["vscode", "terminal"])
