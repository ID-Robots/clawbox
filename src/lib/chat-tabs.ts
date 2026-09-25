/**
 * The chat's tab inventory — which side conversations the owner has open
 * beside the main one — as ONE list for every browser that signs in to the box.
 *
 * Client-safe on purpose (no `fs`): the popup and the route share the record
 * shape, the key rule and the merge, so what a phone sends and what the desktop
 * is handed back cannot drift apart. The disk half is `chat-tab-store.ts`.
 *
 * WHY THIS EXISTS (TASK-1159). The list used to live in each browser's own
 * localStorage. The SESSIONS behind the tabs were always on the box — the
 * gateway files one per `agent:<id>:clawbox-…` key, the Hermes transcript store
 * one file per `desktop-…` key — but nothing ever asked the box which ones
 * existed. A conversation started on the phone was therefore invisible on the
 * desktop, which showed its own (empty) list and the main "ClawBox" tab, and
 * vice versa. No server response was filtering anything: there was no server
 * response to filter.
 *
 * WHY A MERGE AND NOT A SAVED LIST. Two browsers writing "the list" whole would
 * each overwrite the other's newest tab. Every change here is monotonic
 * instead — a tab is added, a placeholder name becomes a real one, a closed key
 * is remembered as closed — so the order two devices' requests land in cannot
 * lose either one's change, and a device that was offline for a week can send
 * its whole cached list without resurrecting a tab closed elsewhere meanwhile.
 */

/** One side conversation, as the strip shows it and the box keeps it. */
export interface ChatTabRecord {
  /** The session key as the transport minted it — see `HarnessAdapter.newSessionKey`. */
  key: string;
  label: string;
  createdAt: number;
  /** Still carrying its "Chat N" placeholder: the first thing the owner
   *  types becomes the label, once. */
  autoLabel?: boolean;
  /** The N its placeholder was minted with; the next tab takes max+1, so
   *  closing "Chat 2" while "Chat 3" lives can never mint a second "Chat 3". */
  seq?: number;
}

/** A key closed on some device, and when — so no stale cache can bring it back. */
export interface ClosedChatTab {
  key: string;
  at: number;
}

/** Everything the box keeps about the strip. */
export interface ChatTabInventory {
  tabs: ChatTabRecord[];
  closed: ClosedChatTab[];
}

export const CHAT_TABS_ROUTE = "/setup-api/chat/tabs";

/** How long an auto-label may be before it is cut with an ellipsis. */
export const TAB_LABEL_MAX = 24;

/**
 * Bounds on what the box will keep. A strip past a few dozen conversations is
 * unusable long before it reaches the first; the second is what lets a close
 * made on one device win over a cached copy on another for a long while — each
 * entry is a key and a timestamp, so 500 of them are ~30 KB.
 */
export const MAX_TABS = 64;
export const MAX_CLOSED = 500;
/** A stored label: the auto-label is 25 characters, a translated placeholder a few more. */
const MAX_LABEL_CHARS = 80;

/**
 * The two key shapes a tab can have, and nothing else.
 *
 *   - OpenClaw: `agent:<agentId>:clawbox-<id>` — `newSessionKey` in
 *     openclaw-gateway-adapter.ts. Lowercase, because the gateway lowercases
 *     every key it files.
 *   - Hermes: `desktop-<id>` — the desktop transcript's key plus a suffix, a
 *     bare filename because the transcript store turns it into one.
 *
 * The inventory is narrower than "any session key" on purpose: it is what the
 * chat strip SHOWS, so a key the popup could never have minted — `agent:main:main`,
 * a Telegram or cron session, a coding run's — has no business in it, whoever
 * asked. Both shapes are 64 characters at most, the transcript key's own bound.
 */
const OPENCLAW_TAB_KEY_RE = /^agent:[a-z0-9][a-z0-9_-]{0,31}:clawbox-[a-z0-9]{1,24}$/;
const HERMES_TAB_KEY_RE = /^desktop-[a-z0-9]{1,24}$/;

export function isChatTabKey(key: unknown): key is string {
  return typeof key === "string"
    && key.length <= 64
    && (OPENCLAW_TAB_KEY_RE.test(key) || HERMES_TAB_KEY_RE.test(key));
}

/**
 * Characters a label may not carry: C0/C1 controls, DEL, the line and
 * paragraph separators, the bidi embeddings, overrides and isolates, and the
 * BOM. A label is shown in the strip on every device; none of these has a
 * reason to be in a tab name, and the bidi ones would let one name read as
 * another.
 */
const LABEL_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A label as the box stores it: stripped, one line, bounded. Empty means none. */
export function cleanTabLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(LABEL_STRIP_RE, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_LABEL_CHARS ? text.slice(0, MAX_LABEL_CHARS).trimEnd() : text;
}

/**
 * The name a tab takes from the first thing the owner said in it, or null when
 * there is nothing to name it by. The attachment line the composer prefixes
 * (`📎 name`) is not what the owner said, so it is dropped first.
 *
 * Shared by the popup (a tab named live) and the store (a conversation found on
 * the box with no name recorded), so both spell it the same.
 */
export function tabLabelFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/^📎 .*$/gm, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const label = clean.length > TAB_LABEL_MAX ? `${clean.slice(0, TAB_LABEL_MAX).trimEnd()}…` : clean;
  return cleanTabLabel(label) || null;
}

/**
 * One record out of an untrusted value — a request body, a JSON file, a
 * localStorage entry — or null. `now` bounds `createdAt`: a clock a day ahead
 * of the box's would sort a tab after every tab made after it.
 */
export function parseTabRecord(value: unknown, now = Date.now()): ChatTabRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isChatTabKey(row.key)) return null;
  const label = cleanTabLabel(row.label);
  const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
    && row.createdAt > 0 && row.createdAt <= now + 24 * 60 * 60 * 1000
    ? Math.floor(row.createdAt)
    : now;
  const seq = typeof row.seq === "number" && Number.isInteger(row.seq) && row.seq >= 2 && row.seq <= 10_000
    ? row.seq
    : undefined;
  // A tab with no name to show is a placeholder, whatever it claimed.
  const autoLabel = row.autoLabel === true || !label;
  return { key: row.key, label, createdAt, ...(autoLabel ? { autoLabel: true } : {}), ...(seq !== undefined ? { seq } : {}) };
}

/** A list of records out of an untrusted value: the valid ones, first of each key. */
export function parseTabList(value: unknown, now = Date.now()): ChatTabRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ChatTabRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = parseTabRecord(entry, now);
    if (!record || seen.has(record.key)) continue;
    seen.add(record.key);
    out.push(record);
  }
  return out;
}

/** The inventory out of an untrusted value (the file on disk). Never throws. */
export function parseTabInventory(value: unknown, now = Date.now()): ChatTabInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { tabs: [], closed: [] };
  const row = value as Record<string, unknown>;
  const closed: ClosedChatTab[] = [];
  const seenClosed = new Set<string>();
  if (Array.isArray(row.closed)) {
    for (const entry of row.closed) {
      if (!entry || typeof entry !== "object") continue;
      const { key, at } = entry as Record<string, unknown>;
      if (!isChatTabKey(key) || seenClosed.has(key)) continue;
      seenClosed.add(key);
      closed.push({ key, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
    }
  }
  // A key both open and closed is closed: the close is the later fact.
  const tabs = parseTabList(row.tabs, now).filter((tab) => !seenClosed.has(tab.key));
  return { tabs: sortTabs(tabs), closed };
}

/** The strip's order: oldest first, which is the order the + appended them in. */
export function sortTabs(tabs: ChatTabRecord[]): ChatTabRecord[] {
  return [...tabs].sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The N the next placeholder takes: one past every N in use (main is 1). */
export function nextTabSeq(tabs: readonly Pick<ChatTabRecord, "seq">[]): number {
  return tabs.reduce((max, tab) => Math.max(max, tab.seq ?? 1), 1) + 1;
}

export interface TabInventoryChange {
  /** Tabs a device holds. Added when new, and a placeholder name is replaced by a real one. */
  upsert?: readonly ChatTabRecord[];
  /** Keys a device closed. */
  close?: readonly string[];
}

/**
 * Apply one device's change to the inventory. Pure: returns the next
 * inventory and whether anything moved (so the store can skip the write).
 *
 * The rules are the whole cross-device contract:
 *   - a closed key stays closed: an upsert of it is ignored, which is what
 *     stops a stale cache from bringing a closed conversation back;
 *   - a key already listed keeps its place and its date; only a placeholder
 *     name may change, and only to a real one (no rename UI exists, so the
 *     first name any device gives a tab is its name everywhere);
 *   - a new placeholder whose N another tab already holds takes the next free
 *     N, so two devices that each opened "Chat 2" offline end with a "Chat 2"
 *     and a "Chat 3", not two of one;
 *   - past MAX_TABS nothing new is added; past MAX_CLOSED the oldest closes
 *     are forgotten.
 */
export function mergeTabInventory(
  inventory: ChatTabInventory,
  change: TabInventoryChange,
  now = Date.now(),
): { inventory: ChatTabInventory; changed: boolean } {
  let changed = false;
  const closedAt = new Map(inventory.closed.map((entry) => [entry.key, entry.at] as const));
  let tabs = inventory.tabs.map((tab) => ({ ...tab }));

  for (const key of change.close ?? []) {
    if (!isChatTabKey(key)) continue;
    if (!closedAt.has(key)) {
      closedAt.set(key, now);
      changed = true;
    }
    const before = tabs.length;
    tabs = tabs.filter((tab) => tab.key !== key);
    if (tabs.length !== before) changed = true;
  }

  for (const raw of change.upsert ?? []) {
    const incoming = parseTabRecord(raw, now);
    if (!incoming || closedAt.has(incoming.key)) continue;
    const existing = tabs.find((tab) => tab.key === incoming.key);
    if (existing) {
      if (existing.autoLabel && !incoming.autoLabel && incoming.label) {
        existing.label = incoming.label;
        delete existing.autoLabel;
        changed = true;
      }
      continue;
    }
    if (tabs.length >= MAX_TABS) continue;
    const taken = new Set(tabs.map((tab) => tab.seq).filter((seq): seq is number => seq !== undefined));
    const record: ChatTabRecord = { ...incoming };
    if (record.autoLabel && (record.seq === undefined || taken.has(record.seq))) {
      record.seq = nextTabSeq(tabs);
    }
    tabs.push(record);
    changed = true;
  }

  let closed = [...closedAt].map(([key, at]) => ({ key, at }));
  if (closed.length > MAX_CLOSED) {
    closed = closed.sort((a, b) => b.at - a.at).slice(0, MAX_CLOSED);
    changed = true;
  }
  return { inventory: { tabs: sortTabs(tabs), closed }, changed };
}
