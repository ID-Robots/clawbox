/**
 * The chat's tab inventory on disk — the one list every browser signed in to
 * this box shares. SERVER ONLY; the record shape and the merge rules are in
 * `chat-tabs.ts`, which the popup imports too.
 *
 * STORAGE: data/chat-tabs.json, 0600, written through a temp file and a rename,
 * read and written synchronously so one request's read-merge-write can never
 * interleave with another's inside this process. It lives under DATA_DIR and
 * is not on the factory reset's keep-list, so a reset takes it with the
 * transcripts — its labels are the first words of the owner's conversations.
 *
 * DISCOVERY. The list a device sends is not the only evidence of a tab: the
 * conversation itself is on the box. A tab opened on a phone before this
 * inventory existed — or on a phone that has not opened the chat since — has
 * a session the gateway filed, or a transcript file, and no entry here. Each
 * read therefore adopts the tab-shaped sessions it finds that were never
 * listed and never closed:
 *   - Hermes: `data/chat-transcripts/desktop-<id>.jsonl`, named after the
 *     first thing the owner said in it, as the popup would have named it;
 *   - OpenClaw: `agent:<agent>:clawbox-<id>` rows in each agent's session
 *     store (read-only — see openclaw-session-store.ts), or in the legacy
 *     `sessions.json` of an agent the doctor has not migrated yet.
 * Only those shapes: a Telegram chat, a cron job's session or a coding run's
 * are the agent's business, were never tabs, and stay out of the strip.
 * A closed key is never adopted again, which is what keeps a session whose
 * delete lagged (a run still holding it) from walking back in.
 */

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { readTranscript, TRANSCRIPT_DIR, TRANSCRIPT_LIMITS } from "@/lib/harness/transcript-store";
import { AGENTS_DIR_DEFAULT, listAgentIds, readSessionEntries } from "@/lib/openclaw-session-store";
import {
  isChatTabKey,
  mergeTabInventory,
  parseTabInventory,
  tabLabelFromText,
  type ChatTabInventory,
  type ChatTabRecord,
  type TabInventoryChange,
} from "@/lib/chat-tabs";

const INVENTORY_PATH = path.join(DATA_DIR, "chat-tabs.json");
const FILE_MODE = 0o600;

function readInventory(): ChatTabInventory {
  let raw: string;
  try {
    raw = fs.readFileSync(INVENTORY_PATH, "utf8");
  } catch {
    return { tabs: [], closed: [] };
  }
  try {
    return parseTabInventory(JSON.parse(raw));
  } catch {
    // A torn or hand-edited file is an empty strip, not a 500 on every chat
    // open. The next change writes a whole one over it.
    console.warn("[chat-tabs] data/chat-tabs.json is not valid JSON; starting from an empty list");
    return { tabs: [], closed: [] };
  }
}

function writeInventory(inventory: ChatTabInventory): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = untraced(`${INVENTORY_PATH}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(inventory), { mode: FILE_MODE });
  // `mode` only applies to a file writeFileSync CREATES; a stale temp left at
  // 0644 by a crash would carry that onto the live file through the rename.
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    // best effort
  }
  fs.renameSync(tmp, INVENTORY_PATH);
}

/** Every key the inventory already has an opinion on: listed or closed. */
function knownKeys(inventory: ChatTabInventory): Set<string> {
  return new Set([...inventory.tabs.map((tab) => tab.key), ...inventory.closed.map((entry) => entry.key)]);
}

/**
 * Hermes tabs with a transcript on the box. `readTranscript` validates the key
 * again on its own way to the disk; the pattern here only decides which files
 * are tabs at all.
 */
export async function discoverHermesTabs(known: ReadonlySet<string>): Promise<ChatTabRecord[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(TRANSCRIPT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: ChatTabRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const key = entry.name.slice(0, -".jsonl".length);
    if (!key.startsWith("desktop-") || !isChatTabKey(key) || known.has(key)) continue;
    const records = await readTranscript(TRANSCRIPT_LIMITS.MAX_RECORDS, key);
    if (records.length === 0) continue;
    const firstSaid = records.find((record) => record.role === "user" && tabLabelFromText(record.text));
    const label = firstSaid ? tabLabelFromText(firstSaid.text) : null;
    const firstAt = records.find((record) => record.timestamp > 0)?.timestamp;
    let createdAt = firstAt ?? 0;
    if (!createdAt) {
      try {
        createdAt = fs.statSync(path.join(TRANSCRIPT_DIR, entry.name)).mtimeMs;
      } catch {
        createdAt = Date.now();
      }
    }
    found.push(label
      ? { key, label, createdAt }
      : { key, label: "", createdAt, autoLabel: true });
  }
  return found;
}

/** The session keys a legacy (pre-SQLite) agent lists in its `sessions.json`. */
function legacySessionEntries(agentsDir: string, agentId: string): Array<{ key: string; entry: Record<string, unknown> }> {
  try {
    const raw = fs.readFileSync(path.join(agentsDir, agentId, "sessions", "sessions.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter((pair): pair is [string, Record<string, unknown>] => !!pair[1] && typeof pair[1] === "object" && !Array.isArray(pair[1]))
      .map(([key, entry]) => ({ key, entry }));
  } catch {
    return [];
  }
}

/**
 * OpenClaw tabs the gateway holds a session for. Read-only, and per agent: a
 * migrated agent is read from its SQLite store, one the doctor has not reached
 * yet from its `sessions.json`.
 */
export function discoverOpenClawTabs(
  known: ReadonlySet<string>,
  agentsDir: string = AGENTS_DIR_DEFAULT,
): ChatTabRecord[] {
  const found: ChatTabRecord[] = [];
  for (const agentId of listAgentIds(agentsDir)) {
    const rows = readSessionEntries(agentId, agentsDir) ?? legacySessionEntries(agentsDir, agentId);
    for (const { key, entry } of rows) {
      const lower = key.toLowerCase();
      if (!lower.startsWith(`agent:${agentId.toLowerCase()}:clawbox-`) || !isChatTabKey(lower) || known.has(lower)) continue;
      const stamp = [entry.createdAt, entry.updatedAt].find(
        (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
      );
      // `label` is the one name the gateway keeps that a person gave the
      // session; `displayName` is the channel's, and would read "webchat".
      const label = tabLabelFromText(entry.label);
      found.push(label
        ? { key: lower, label, createdAt: stamp ?? Date.now() }
        : { key: lower, label: "", createdAt: stamp ?? Date.now(), autoLabel: true });
    }
  }
  return found;
}

/**
 * Apply one device's change, adopt what the box holds that the list does not,
 * and answer the list every device should now show.
 *
 * Discovery runs first and is the only thing here that awaits. The read, the
 * merge and the write after it are synchronous, so no other request can land
 * between them — two devices syncing at once each merge into the other's
 * result instead of writing over it. Discovery never throws: a store that
 * cannot be read is simply not evidence.
 */
export async function syncChatTabs(change: TabInventoryChange = {}): Promise<ChatTabRecord[]> {
  const known = knownKeys(readInventory());
  let discovered: ChatTabRecord[] = [];
  try {
    discovered = [...(await discoverHermesTabs(known)), ...discoverOpenClawTabs(known)];
  } catch (err) {
    console.warn("[chat-tabs] could not look for conversations on the box:", err);
  }
  // The device's own change first, so the name it gave a tab wins over one
  // guessed from the transcript, and a key it closes is closed before
  // discovery could offer it again.
  const own = mergeTabInventory(readInventory(), change);
  const adopted = mergeTabInventory(own.inventory, { upsert: discovered });
  if (own.changed || adopted.changed) writeInventory(adopted.inventory);
  return adopted.inventory.tabs;
}

/** Test seam: where the inventory lives. */
export const CHAT_TABS_FILE = INVENTORY_PATH;
