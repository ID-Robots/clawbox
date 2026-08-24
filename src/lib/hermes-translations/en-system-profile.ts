/**
 * Settings → System → Desktop environment + Performance mode (TASK-455).
 *
 * The help text carries the THERMAL RATIONALE on purpose: the measurement is
 * the reason the default changed, and an owner deciding whether to pin their
 * clocks should be told what that costs before they do it, not after their
 * living-room appliance is sitting at 75 C.
 */
export const systemProfileEn: Record<string, string> = {
  "systemProfile.title": "Desktop & power",

  "systemProfile.desktopLabel": "Desktop environment",
  "systemProfile.desktopHelp":
    "Runs the full GNOME desktop on the box's HDMI output and in Remote Desktop. Turn it off to run headless and get back about 700 MB of memory — nothing is uninstalled, so you can turn it back on any time.",

  "systemProfile.performanceLabel": "Performance mode",
  "systemProfile.performanceHelp":
    "Pins the CPU and GPU to their maximum clocks instead of letting them scale. Faster to first token, but the board then idles at about 7.2 W and sustained local inference measured 74.8 °C — just over the 74 °C passive-cooling limit. Leave it off unless you are running long jobs and have airflow.",

  "systemProfile.rebootRequired": "Restart the box to apply this change.",
  "systemProfile.unsupported": "Not available on this device.",

  "systemProfile.powerState": "Power profile: {profile} · clocks: {clocks}",
  "systemProfile.clocksPinned": "pinned",
  "systemProfile.clocksDynamic": "dynamic",

  "systemProfile.memoryGuards":
    "Memory limits in force: local AI {ollama}, browser {browser}, desktop {desktop}. Local AI serves {parallel} requests at a time.",

  "systemProfile.loadFailed": "Could not read the desktop and power settings.",
  "systemProfile.desktopFailed": "Could not change the desktop setting.",
  "systemProfile.powerFailed": "Could not change the power profile.",
};
