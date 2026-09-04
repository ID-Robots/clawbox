// Telling the OWNER something happened, on the screen they are actually looking
// at.
//
// A draft that waits silently in Settings → Email is a draft nobody approves.
// The desktop already has a notification path: every open shell polls the
// owner-notice ring (src/lib/pending-actions.ts) and renders `{ type: "notify" }`
// as a toast — the same mechanism the `ui_notify` MCP tool drives
// (mcp/tools/desktop.ts). This pushes onto the ring directly rather than going
// out through the HTTP API, because the caller is already inside the device's
// own server process.
//
// Deliberately one-way and best-effort. It cannot ask a question, and a
// notification that fails to appear must never turn a successfully-queued draft
// into a failed send — every caller swallows the error.

import { parseNotifyAction, type NotifyAction } from "@/lib/notify-action";
import { pushPendingAction } from "@/lib/pending-actions";

const MAX_MESSAGE_CHARS = 280;

/**
 * Show a short notice on the ClawBox desktop.
 *
 * The message is written by ClawBox, never by the agent: the text a draft
 * carries is untrusted, so nothing from a pending email is interpolated in
 * here. "An email is waiting for you" is the whole payload — the owner reads
 * the actual message in the panel, where it is rendered as text.
 *
 * `action` makes the toast's body clickable, taking the owner to the place the
 * message names. It is re-checked against the allowlist here rather than
 * trusted from the caller: this function is the one door onto the ring for a
 * notice with a destination, and the desktop turns a destination into a click
 * target. A caller asking for one that is not on the list gets a plain notice,
 * never a broken one.
 */
export async function notifyOwner(message: string, action?: NotifyAction): Promise<void> {
  const target = action ? parseNotifyAction(action) : null;
  await pushPendingAction({
    type: "notify",
    message: message.slice(0, MAX_MESSAGE_CHARS),
    ...(target ? { action: target } : {}),
  });
}
