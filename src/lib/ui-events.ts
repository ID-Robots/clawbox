// Window-level CustomEvent names shared between page.tsx and components.
// Defining them in one place avoids typo drift between the dispatch and
// listen sites.

export const OPEN_APP_EVENT = "clawbox:open-app";
export const FIX_ERROR_EVENT = "clawbox:fix-error";

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
