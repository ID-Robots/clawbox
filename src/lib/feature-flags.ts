export const FEATURE_FLAG_KEYS = {
  clawkeep: "ff_clawkeep_enabled",
  remoteControl: "ff_remote_control_enabled",
} as const;

export type FeatureFlagId = keyof typeof FEATURE_FLAG_KEYS;

export interface FeatureFlagDefinition {
  id: FeatureFlagId;
  key: (typeof FEATURE_FLAG_KEYS)[FeatureFlagId];
  label: string;
  description: string;
}

export const FEATURE_FLAGS: FeatureFlagDefinition[] = [
  {
    id: "clawkeep",
    key: FEATURE_FLAG_KEYS.clawkeep,
    label: "ClawKeep",
    description: "Show the ClawKeep app and related backup entry points on the desktop.",
  },
  {
    id: "remoteControl",
    key: FEATURE_FLAG_KEYS.remoteControl,
    label: "Remote Control",
    description: "Link this device to your ClawBox portal account and access it remotely via a Cloudflare tunnel.",
  },
];

export function isFeatureFlagEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
