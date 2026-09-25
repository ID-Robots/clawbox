import { describe, expect, it } from "vitest";
import {
  cleanTabLabel,
  isChatTabKey,
  MAX_CLOSED,
  MAX_TABS,
  mergeTabInventory,
  nextTabSeq,
  parseTabInventory,
  parseTabList,
  parseTabRecord,
  tabLabelFromText,
  type ChatTabInventory,
} from "@/lib/chat-tabs";

/**
 * The tab inventory's merge — the whole cross-device contract (TASK-1159).
 *
 * The strip used to be each browser's own localStorage list, so a tab opened
 * on the phone never reached the desktop. The list is on the box now, and two
 * devices change it independently; what is pinned here is that the order their
 * changes land in cannot lose either one's, and that a stale cache cannot
 * bring back a tab that was closed somewhere else.
 */

const NOW = 1_790_000_000_000;
const PHONE_TAB = "agent:main:clawbox-0a1b2c3d4e5f";
const DESKTOP_TAB = "agent:main:clawbox-9f8e7d6c5b4a";
const empty = (): ChatTabInventory => ({ tabs: [], closed: [] });
const tab = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: "Chat 2", createdAt: NOW - 1000, autoLabel: true, seq: 2, ...extra });

describe("which keys are tabs", () => {
  it("admits the two shapes the transports mint, and nothing else", () => {
    expect(isChatTabKey(PHONE_TAB)).toBe(true);
    expect(isChatTabKey("desktop-0a1b2c3d4e5f")).toBe(true);
    for (const key of [
      "agent:main:main", // the main conversation is never a tab
      "desktop", // …on either edition
      "agent:main:telegram:direct:12345", // a channel's session is the agent's business
      "agent:main:cron:nightly",
      "clawbox-0a1b2c3d4e5f", // a bare key names a different session per default agent
      "AGENT:main:clawbox-0a1b2c3d4e5f", // the gateway lowercases what it files
      "desktop-../../openclaw", // a key becomes a filename on Hermes
      `agent:main:clawbox-${"a".repeat(80)}`,
      "",
      7,
      null,
    ]) {
      expect(isChatTabKey(key), String(key)).toBe(false);
    }
  });
});

describe("labels", () => {
  it("names a tab after the first thing said in it, as the popup always did", () => {
    expect(tabLabelFromText("Plan my week in Lisbon please")).toBe("Plan my week in Lisbon p…");
    expect(tabLabelFromText("short")).toBe("short");
    expect(tabLabelFromText("📎 photo.png\nwhat is this?")).toBe("what is this?");
    expect(tabLabelFromText("📎 photo.png")).toBeNull();
    expect(tabLabelFromText("   ")).toBeNull();
    expect(tabLabelFromText(undefined)).toBeNull();
  });

  it("strips what could make one name read as another, and bounds the rest", () => {
    expect(cleanTabLabel("a\u202eevil\u0000b\u2028c")).toBe("a evil b c");
    expect(cleanTabLabel("x".repeat(200))).toHaveLength(80);
    expect(cleanTabLabel(42)).toBe("");
  });
});

describe("records from untrusted input", () => {
  it("keeps a valid record and bounds its date and N", () => {
    expect(parseTabRecord(tab(PHONE_TAB), NOW)).toEqual({ key: PHONE_TAB, label: "Chat 2", createdAt: NOW - 1000, autoLabel: true, seq: 2 });
    // A clock a day ahead of the box's would sort the tab after every later one.
    expect(parseTabRecord(tab(PHONE_TAB, { createdAt: NOW + 3 * 86_400_000 }), NOW)?.createdAt).toBe(NOW);
    expect(parseTabRecord(tab(PHONE_TAB, { seq: 1 }), NOW)).not.toHaveProperty("seq");
    expect(parseTabRecord(tab(PHONE_TAB, { seq: 2.5 }), NOW)).not.toHaveProperty("seq");
  });

  it("treats a tab with no name as a placeholder, whatever it claimed", () => {
    expect(parseTabRecord({ key: PHONE_TAB, label: "  ", createdAt: NOW, autoLabel: false }, NOW)?.autoLabel).toBe(true);
  });

  it("refuses what is not a tab", () => {
    expect(parseTabRecord(null)).toBeNull();
    expect(parseTabRecord([PHONE_TAB])).toBeNull();
    expect(parseTabRecord({ key: "agent:main:main", label: "x", createdAt: NOW })).toBeNull();
  });

  it("drops invalid entries and repeats from a list", () => {
    expect(parseTabList([tab(PHONE_TAB), tab(PHONE_TAB, { label: "again" }), { key: "nope" }, "x"], NOW).map((t) => t.key)).toEqual([PHONE_TAB]);
    expect(parseTabList("not a list")).toEqual([]);
  });

  it("reads a damaged file as far as it goes, and a key both open and closed as closed", () => {
    expect(parseTabInventory(null)).toEqual({ tabs: [], closed: [] });
    expect(parseTabInventory({ tabs: "x", closed: 3 })).toEqual({ tabs: [], closed: [] });
    const inv = parseTabInventory({
      tabs: [tab(PHONE_TAB), tab(DESKTOP_TAB, { seq: 3 })],
      closed: [{ key: PHONE_TAB, at: NOW }, { key: "junk", at: 1 }, { key: DESKTOP_TAB }],
    }, NOW);
    expect(inv.tabs).toEqual([]);
    expect(inv.closed).toEqual([{ key: PHONE_TAB, at: NOW }, { key: DESKTOP_TAB, at: 0 }]);
  });
});

describe("merging one device's change", () => {
  it("adds a tab another device opened, in the order they were opened", () => {
    const fromPhone = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB, { createdAt: NOW - 50 })] }, NOW);
    expect(fromPhone.changed).toBe(true);
    const fromDesktop = mergeTabInventory(fromPhone.inventory, { upsert: [tab(DESKTOP_TAB, { createdAt: NOW - 100 })] }, NOW);
    expect(fromDesktop.inventory.tabs.map((t) => t.key)).toEqual([DESKTOP_TAB, PHONE_TAB]);
  });

  it("is a no-op when the device holds nothing new — a sync can be repeated", () => {
    const once = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB)] }, NOW).inventory;
    const twice = mergeTabInventory(once, { upsert: [tab(PHONE_TAB)] }, NOW);
    expect(twice.changed).toBe(false);
    expect(twice.inventory).toEqual(once);
  });

  it("gives two offline 'Chat 2's different numbers, so the strip never shows one name twice", () => {
    const phone = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB, { seq: 2 })] }, NOW).inventory;
    const both = mergeTabInventory(phone, { upsert: [tab(DESKTOP_TAB, { seq: 2, createdAt: NOW - 10 })] }, NOW).inventory;
    expect(both.tabs.find((t) => t.key === PHONE_TAB)?.seq).toBe(2);
    expect(both.tabs.find((t) => t.key === DESKTOP_TAB)?.seq).toBe(3);
    expect(nextTabSeq(both.tabs)).toBe(4);
  });

  it("gives a nameless tab found without an N the next free one", () => {
    const inv = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB, { seq: 5 }), { key: DESKTOP_TAB, label: "", createdAt: NOW, autoLabel: true }] }, NOW).inventory;
    expect(inv.tabs.find((t) => t.key === DESKTOP_TAB)?.seq).toBe(6);
  });

  it("lets a placeholder take its first real name, once, from whichever device names it", () => {
    const inv = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB)] }, NOW).inventory;
    const named = mergeTabInventory(inv, { upsert: [tab(PHONE_TAB, { label: "Plan my week in Lisbon p…", autoLabel: false })] }, NOW);
    expect(named.changed).toBe(true);
    expect(named.inventory.tabs[0]).toMatchObject({ label: "Plan my week in Lisbon p…" });
    expect(named.inventory.tabs[0].autoLabel).toBeUndefined();
    // A device still holding the placeholder cannot un-name it…
    expect(mergeTabInventory(named.inventory, { upsert: [tab(PHONE_TAB)] }, NOW).changed).toBe(false);
    // …and there is no rename, so a second name does not replace the first.
    const renamed = mergeTabInventory(named.inventory, { upsert: [tab(PHONE_TAB, { label: "Other", autoLabel: false })] }, NOW);
    expect(renamed.changed).toBe(false);
    expect(renamed.inventory.tabs[0].label).toBe("Plan my week in Lisbon p…");
  });

  it("closes a tab for every device, and a stale cache cannot bring it back", () => {
    const open = mergeTabInventory(empty(), { upsert: [tab(PHONE_TAB), tab(DESKTOP_TAB, { seq: 3 })] }, NOW).inventory;
    const closed = mergeTabInventory(open, { close: [PHONE_TAB] }, NOW);
    expect(closed.changed).toBe(true);
    expect(closed.inventory.tabs.map((t) => t.key)).toEqual([DESKTOP_TAB]);
    expect(closed.inventory.closed).toEqual([{ key: PHONE_TAB, at: NOW }]);
    // The phone was offline and still lists it.
    const stale = mergeTabInventory(closed.inventory, { upsert: [tab(PHONE_TAB), tab(DESKTOP_TAB, { seq: 3 })] }, NOW + 5);
    expect(stale.changed).toBe(false);
    expect(stale.inventory.tabs.map((t) => t.key)).toEqual([DESKTOP_TAB]);
  });

  it("closes a key it never listed, so a close that raced its own add still wins", () => {
    const closed = mergeTabInventory(empty(), { close: [PHONE_TAB] }, NOW).inventory;
    expect(mergeTabInventory(closed, { upsert: [tab(PHONE_TAB)] }, NOW).inventory.tabs).toEqual([]);
    // …and a close repeated by a device that has not heard back is harmless.
    expect(mergeTabInventory(closed, { close: [PHONE_TAB] }, NOW + 9).changed).toBe(false);
  });

  it("ignores a close of something that is not a tab", () => {
    const inv = mergeTabInventory(empty(), { close: ["agent:main:main", "../x"] }, NOW);
    expect(inv.changed).toBe(false);
    expect(inv.inventory.closed).toEqual([]);
  });

  it("stops adding at the cap and forgets the oldest closes past theirs", () => {
    const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => tab(`desktop-${i.toString(16).padStart(12, "0")}`, { createdAt: NOW - i }));
    expect(mergeTabInventory(empty(), { upsert: many }, NOW).inventory.tabs).toHaveLength(MAX_TABS);

    const closes: ChatTabInventory = {
      tabs: [],
      closed: Array.from({ length: MAX_CLOSED }, (_, i) => ({ key: `desktop-${i.toString(16).padStart(12, "0")}`, at: NOW - MAX_CLOSED + i })),
    };
    const next = mergeTabInventory(closes, { close: [PHONE_TAB] }, NOW);
    expect(next.inventory.closed).toHaveLength(MAX_CLOSED);
    expect(next.inventory.closed.some((c) => c.key === PHONE_TAB)).toBe(true);
    // The oldest (at = NOW - MAX_CLOSED) is the one forgotten.
    expect(next.inventory.closed.some((c) => c.key === "desktop-000000000000")).toBe(false);
  });

  it("refuses an invalid record without dropping the valid ones beside it", () => {
    const inv = mergeTabInventory(empty(), { upsert: [{ key: "agent:main:main", label: "x", createdAt: NOW } as never, tab(PHONE_TAB)] }, NOW).inventory;
    expect(inv.tabs.map((t) => t.key)).toEqual([PHONE_TAB]);
  });
});
