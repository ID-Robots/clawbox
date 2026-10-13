// Remote-desktop (VNC) resolution setting — TASK-1479.
//
// The virtual desktop (Xvfb :99, started by scripts/start-vnc.sh) used to be
// hardcoded to 1280x720. The owner may now pick one of a few presets. The list
// is deliberately closed: every extra pixel is RAM and CPU on an 8 GB Jetson,
// and an arbitrary geometry string would end up on Xvfb's command line.
//
// Storage: the preference lives in the config store under
// `pref:desktop_vnc_resolution` (same store and validation as every other
// desktop preference). start-vnc.sh is a shell script that cannot read
// config.json cheaply, so saving also writes a one-line env file under
// ~/.config/clawbox/ — outside the install tree (the updater never touches it)
// and outside ~/.cache (which may be cleared), so it survives reboot and update.
// The script re-validates that value against the same list.
//
// This module is shared with the Settings UI, so it must stay browser-safe: no
// Node built-ins. The env-file writer lives in ./vnc-resolution-server.

export const VNC_RESOLUTIONS = ["1280x720", "1600x900", "1920x1080"] as const;
export type VncResolution = (typeof VNC_RESOLUTIONS)[number];
export const DEFAULT_VNC_RESOLUTION: VncResolution = "1280x720";

/** Preference name in the config store (stored as `pref:<name>`). */
export const VNC_RESOLUTION_PREF = "desktop_vnc_resolution";

export function isVncResolution(value: unknown): value is VncResolution {
  return typeof value === "string" && (VNC_RESOLUTIONS as readonly string[]).includes(value);
}

/** Anything not on the allowlist falls back to the default. */
export function normalizeVncResolution(value: unknown): VncResolution {
  return isVncResolution(value) ? value : DEFAULT_VNC_RESOLUTION;
}
