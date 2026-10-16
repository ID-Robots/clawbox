/**
 * Each ClawBox user's chat, as the box keeps it — set up when the first user
 * is added, and forgotten when a user is removed. SERVER ONLY.
 *
 * The keys themselves are src/lib/chat-scope.ts; the wire filter for the
 * gateway socket is scripts/gateway-user-relay.js. Two things are left that
 * only the harness can do, and both go through its native surface:
 *
 *   * The AGENT must not read the owner's conversation into a user's either.
 *     OpenClaw's session tools (`sessions_list`, `sessions_history`,
 *     `sessions_search`, …) reach every session on the gateway under their
 *     default visibility, `all`. `tools.sessions.visibility: "tree"` narrows a
 *     session to itself and the subagents it spawned, while the owner's
 *     canonical main session keeps every same-agent session (docs/gateway/
 *     config-tools/sessions-and-subagents.md in the pinned core) — so it is
 *     set, through the native config write, the first time a user is added. A
 *     visibility the owner chose themselves (`self`, `tree`, `agent`) is left
 *     alone.
 *   * A removed user's conversations go with them, so a user created later
 *     under the same name starts with an empty chat: their gateway sessions
 *     through the native `sessions.delete` (transcript included), their Hermes
 *     transcripts, their tab list and the record of which Hermes sessions were
 *     theirs.
 */

import fs from "fs";
import { getActiveHarness } from "@/lib/harness";
import { chatKeyUser } from "@/lib/chat-scope";
import { forgetHermesSessionsOf } from "@/lib/chat-scope-server";
import { removeUserInventory } from "@/lib/chat-tab-store";
import { clearTranscript, TRANSCRIPT_DIR } from "@/lib/harness/transcript-store";

/** The native visibility that keeps a user's sessions to themselves. */
export const USER_SESSION_TOOLS_VISIBILITY = "tree";

/**
 * Narrow OpenClaw's session tools for a box that now has more than one
 * person. Best effort, never throws: the users exist either way, and a
 * failure is logged for the journal.
 */
export async function isolateUserChats(): Promise<void> {
  try {
    if ((await getActiveHarness()) !== "openclaw") return;
    const { readConfig, runOpenclawConfigSet } = await import("@/lib/openclaw-config");
    const config = (await readConfig()) as { tools?: { sessions?: { visibility?: unknown } } };
    const current = config?.tools?.sessions?.visibility;
    if (current !== undefined && current !== "all") return;
    await runOpenclawConfigSet(["tools.sessions.visibility", USER_SESSION_TOOLS_VISIBILITY]);
  } catch (err) {
    console.error("[user-chats] could not narrow the assistant's session tools:", err instanceof Error ? err.message : err);
  }
}

/** The gateway sessions of `username`, out of each agent's store (read-only). */
async function openclawKeysOf(username: string): Promise<string[]> {
  const { AGENTS_DIR_DEFAULT, listAgentIds, readSessionEntries } = await import("@/lib/openclaw-session-store");
  const keys: string[] = [];
  for (const agentId of listAgentIds(AGENTS_DIR_DEFAULT)) {
    for (const { key } of readSessionEntries(agentId, AGENTS_DIR_DEFAULT) ?? []) {
      if (chatKeyUser(key) === username) keys.push(key.toLowerCase());
    }
  }
  return keys;
}

/** Forget everything of `username`'s chat. Best effort, never throws. */
export async function forgetUserChats(username: string): Promise<void> {
  try {
    removeUserInventory(username);
  } catch (err) {
    console.error("[user-chats] could not remove the tab list:", err instanceof Error ? err.message : err);
  }
  forgetHermesSessionsOf(username);

  try {
    for (const entry of fs.readdirSync(TRANSCRIPT_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const key = entry.name.slice(0, -".jsonl".length);
      if (chatKeyUser(key) === username) await clearTranscript(key);
    }
  } catch {
    // No transcript directory: nothing was ever said on this edition.
  }

  try {
    if ((await getActiveHarness()) !== "openclaw") return;
    const keys = await openclawKeysOf(username);
    if (keys.length === 0) return;
    const { gatewayWsCall } = await import("@/lib/openclaw-gateway-ws");
    for (const key of keys) {
      await gatewayWsCall("sessions.delete", { key, deleteTranscript: true }).catch((err: unknown) => {
        console.error(`[user-chats] could not delete ${key}:`, err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    console.error("[user-chats] could not delete the user's conversations:", err instanceof Error ? err.message : err);
  }
}
