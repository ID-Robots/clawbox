// Telling the OWNER something happened, on the screen they are actually looking
// at.
//
// A draft that waits silently in Settings → Email is a draft nobody approves.
// The desktop already has a notification path: the shell polls the KV store for
// `ui:pending-action` and renders `{ type: "notify" }` — the same mechanism the
// `ui_notify` MCP tool drives (mcp/tools/desktop.ts). This writes that key
// directly rather than going out through the HTTP API, because the caller is
// already inside the device's own server process.
//
// Deliberately one-way and best-effort. It cannot ask a question, and a
// notification that fails to appear must never turn a successfully-queued draft
// into a failed send — every caller swallows the error.

import { kvSet } from "@/lib/kv-store";

const UI_ACTION_KEY = "ui:pending-action";
const MAX_MESSAGE_CHARS = 280;

/**
 * Show a short notice on the ClawBox desktop.
 *
 * The message is written by ClawBox, never by the agent: the text a draft
 * carries is untrusted, so nothing from a pending email is interpolated in
 * here. "An email is waiting for you" is the whole payload — the owner reads
 * the actual message in the panel, where it is rendered as text.
 */
export async function notifyOwner(message: string): Promise<void> {
  kvSet(
    UI_ACTION_KEY,
    JSON.stringify({ type: "notify", message: message.slice(0, MAX_MESSAGE_CHARS), ts: Date.now() }),
  );
}
