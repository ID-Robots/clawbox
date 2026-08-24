// Window-level CustomEvent names shared between page.tsx and components.
// Defining them in one place avoids typo drift between the dispatch and
// listen sites.

export const OPEN_APP_EVENT = "clawbox:open-app";
export const FIX_ERROR_EVENT = "clawbox:fix-error";
export const OPEN_SETTINGS_SECTION_EVENT = "clawbox:open-settings-section";

/**
 * "The chat's model or provider selection changed."
 *
 * The OpenClaw-side counterpart to `HERMES_MODEL_STATE_EVENT`, and a signal
 * rather than data for the same reason: every listener re-asks the server.
 * Named here because it has three listen sites and an emit site in three
 * different files — as a bare string, a rename in one of them would leave the
 * others silently deaf, with the capability stale until a page reload.
 */
export const CHAT_MODEL_STATE_EVENT = "clawbox:chat-model-state-changed";

export function dispatchOpenApp(appId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail: { appId } }));
}

/**
 * Open Settings on a given section, whether or not the window is already up.
 *
 * Two handoffs, both load-bearing: the `window` property is read by
 * `SettingsApp` on mount and so survives a COLD open (its listener mounts
 * after this fires); the event reaches an already-open Settings window. This
 * is the sequence `page.tsx` open-a-section helpers also perform — named here
 * so the event string and the `__clawboxPendingSettingsSection` handoff live
 * in one place instead of drifting across each dispatch site.
 */
export function dispatchOpenSettingsSection(section: string): void {
  if (typeof window === "undefined") return;
  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = section;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section } }));
  dispatchOpenApp("settings");
}

export interface FixErrorContext {
  source: string;
  message: string;
  details?: string;
}

export function dispatchFixError(ctx: FixErrorContext): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FIX_ERROR_EVENT, { detail: ctx }));
}

export function buildFixErrorPrompt(ctx: FixErrorContext): string {
  const lines = [
    `I just hit an error in the ${ctx.source || "ClawBox UI"}. Please investigate why and fix it.`,
    "",
    "Error message:",
    ctx.message,
  ];
  if (ctx.details) lines.push("", "Extra context:", ctx.details);
  lines.push(
    "",
    "Steps: read relevant logs (e.g. `journalctl -u clawbox-setup -u clawbox-gateway -n 200`), check the failing command directly, and apply a concrete fix. Report back what you found and what you changed.",
  );
  return lines.join("\n");
}
