import { describe, expect, it } from "vitest";
import {
  conversationToFollow,
  mergeTabInventory,
  parseActiveRecord,
  parseActivity,
  parseTabInventory,
  type ChatTabInventory,
} from "@/lib/chat-tabs";

/**
 * Where the owner left off, as the box keeps it (TASK-1364).
 *
 * The strip was one list on every device (TASK-1159), but which tab was OPEN
 * stayed each browser's own: a conversation started on the desktop was on the
 * phone's strip and the phone opened main anyway. The box now records the
 * conversation the owner last sent a turn in, and each device decides from it
 * whether to move. What is pinned: what the record accepts, how a turn moves
 * it, that it only moves forward on the box's clock, that a close takes it
 * away, and the follow rule that keeps two devices from fighting over it.
 */

const NOW = 1_790_000_000_000;
const TAB = "agent:main:clawbox-0a1b2c3d4e5f";
const OTHER = "agent:main:clawbox-9f8e7d6c5b4a";
const MAIN = "agent:main:main";
const tab = (key: string) => ({ key, label: "Plan a trip to Lisbon", createdAt: NOW - 1000 });
const withTabs = (...keys: string[]): ChatTabInventory => ({ tabs: keys.map(tab), closed: [] });

describe("the record's shape", () => {
  it("is main (null) or a tab key, at a real time", () => {
    expect(parseActiveRecord({ key: null, at: NOW })).toEqual({ key: null, at: NOW });
    expect(parseActiveRecord({ key: TAB, at: NOW + 0.7 })).toEqual({ key: TAB, at: NOW });
    expect(parseActiveRecord({ key: "desktop-0a1b2c3d4e5f", at: 5 })).toEqual({ key: "desktop-0a1b2c3d4e5f", at: 5 });
  });

  it("refuses a channel's, a cron job's or the main key spelled out, and a missing or bad time", () => {
    for (const bad of [
      null, undefined, "x", [], {},
      { key: MAIN, at: NOW },
      { key: "agent:main:telegram:direct:42", at: NOW },
      { key: "agent:main:cron:nightly", at: NOW },
      { key: TAB },
      { key: TAB, at: 0 },
      { key: TAB, at: -1 },
      { key: TAB, at: Number.NaN },
      { key: TAB, at: "1790000000000" },
      { at: NOW },
    ]) {
      expect(parseActiveRecord(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads a reported activity as { key }, nothing, or not that shape", () => {
    expect(parseActivity(undefined)).toBeUndefined();
    expect(parseActivity({ key: null })).toEqual({ key: null });
    expect(parseActivity({ key: TAB })).toEqual({ key: TAB });
    for (const bad of [null, "main", [], {}, { key: MAIN }, { key: 42 }, { key: "../etc" }]) {
      expect(parseActivity(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("a turn moves the record", () => {
  it("records the conversation a turn was sent in, on the box's clock", () => {
    const next = mergeTabInventory(withTabs(TAB), { activity: { key: TAB } }, NOW);
    expect(next.changed).toBe(true);
    expect(next.inventory.active).toEqual({ key: TAB, at: NOW });
    const main = mergeTabInventory(next.inventory, { activity: { key: null } }, NOW + 5);
    expect(main.inventory.active).toEqual({ key: null, at: NOW + 5 });
  });

  it("names a tab opened and spoken in within the same request", () => {
    // The phone's first turn in a new tab carries the tab in `upsert` and the
    // turn in `activity`; the upsert lands first.
    const next = mergeTabInventory({ tabs: [], closed: [] }, { upsert: [tab(TAB)], activity: { key: TAB } }, NOW);
    expect(next.inventory.tabs.map((t) => t.key)).toEqual([TAB]);
    expect(next.inventory.active).toEqual({ key: TAB, at: NOW });
  });

  it("never goes back in time, whatever the box's clock says", () => {
    const first = mergeTabInventory(withTabs(TAB, OTHER), { activity: { key: TAB } }, NOW).inventory;
    // A box that booted before its clock was set, or one stepped back by NTP.
    const second = mergeTabInventory(first, { activity: { key: OTHER } }, NOW - 60_000).inventory;
    expect(second.active).toEqual({ key: OTHER, at: NOW + 1 });
    // The same turn reported twice is still a newer record — a newer turn.
    const third = mergeTabInventory(second, { activity: { key: OTHER } }, NOW + 1).inventory;
    expect(third.active!.at).toBe(NOW + 2);
  });

  it("does not record a tab the strip does not hold — closed, or never listed", () => {
    const closed: ChatTabInventory = { tabs: [], closed: [{ key: TAB, at: NOW - 5 }] };
    const ignored = mergeTabInventory(closed, { upsert: [tab(TAB)], activity: { key: TAB } }, NOW);
    expect(ignored.inventory.active).toBeUndefined();
    expect(mergeTabInventory(withTabs(TAB), { activity: { key: OTHER } }, NOW).inventory.active).toBeUndefined();
    expect(mergeTabInventory(withTabs(TAB), { activity: { key: MAIN } }, NOW).inventory.active).toBeUndefined();
  });

  it("is cleared by closing the conversation it names, and kept by closing another", () => {
    const active = mergeTabInventory(withTabs(TAB, OTHER), { activity: { key: TAB } }, NOW).inventory;
    const otherClosed = mergeTabInventory(active, { close: [OTHER] }, NOW + 1).inventory;
    expect(otherClosed.active).toEqual({ key: TAB, at: NOW });
    const itClosed = mergeTabInventory(otherClosed, { close: [TAB] }, NOW + 2);
    expect(itClosed.changed).toBe(true);
    expect(itClosed.inventory.active).toBeUndefined();
    // Main cannot be closed, so a record of main outlives every close.
    const main = mergeTabInventory(withTabs(TAB), { activity: { key: null } }, NOW).inventory;
    expect(mergeTabInventory(main, { close: [TAB] }, NOW + 1).inventory.active).toEqual({ key: null, at: NOW });
  });

  it("never issues an earlier record after a close cleared the last one", () => {
    // Every device stored NOW as seen; the tab is closed, and the box's clock
    // (booted before it was set) now reads a minute earlier.
    const active = mergeTabInventory(withTabs(TAB, OTHER), { activity: { key: TAB } }, NOW).inventory;
    const closed = mergeTabInventory(active, { close: [TAB] }, NOW + 1).inventory;
    expect(closed.active).toBeUndefined();
    expect(closed.activeAt).toBe(NOW);
    // …and the mark survives the file the store writes.
    const reread = parseTabInventory(JSON.parse(JSON.stringify(closed)), NOW);
    expect(reread.activeAt).toBe(NOW);
    const next = mergeTabInventory(reread, { activity: { key: OTHER } }, NOW - 60_000).inventory;
    expect(next.active).toEqual({ key: OTHER, at: NOW + 1 });
    expect(conversationToFollow({ record: next.active!, seenAt: NOW, current: MAIN, main: MAIN, canOpen: () => true }).follow).toBe(OTHER);
  });

  it("reads a mark from the file no lower than the record beside it", () => {
    expect(parseTabInventory({ tabs: [tab(TAB)], closed: [], active: { key: TAB, at: NOW } }, NOW).activeAt).toBe(NOW);
    expect(parseTabInventory({ tabs: [tab(TAB)], closed: [], active: { key: TAB, at: NOW }, activeAt: NOW + 7 }, NOW).activeAt).toBe(NOW + 7);
    expect(parseTabInventory({ tabs: [], closed: [], activeAt: "x" }, NOW).activeAt).toBeUndefined();
    expect(parseTabInventory({ tabs: [], closed: [], activeAt: -3 }, NOW).activeAt).toBeUndefined();
  });

  it("leaves the record alone when a device only syncs its strip", () => {
    const active = mergeTabInventory(withTabs(TAB), { activity: { key: TAB } }, NOW).inventory;
    const synced = mergeTabInventory(active, { upsert: [tab(TAB)] }, NOW + 1);
    expect(synced.changed).toBe(false);
    expect(synced.inventory.active).toEqual({ key: TAB, at: NOW });
  });

  it("survives the file, and a file naming a conversation the strip lost names nothing", () => {
    const active = mergeTabInventory(withTabs(TAB), { activity: { key: TAB } }, NOW).inventory;
    expect(parseTabInventory(JSON.parse(JSON.stringify(active)), NOW).active).toEqual({ key: TAB, at: NOW });
    expect(parseTabInventory({ tabs: [], closed: [], active: { key: TAB, at: NOW } }, NOW).active).toBeUndefined();
    expect(parseTabInventory({ tabs: [tab(TAB)], closed: [{ key: TAB, at: NOW }], active: { key: TAB, at: NOW } }, NOW).active).toBeUndefined();
    expect(parseTabInventory({ tabs: [], closed: [], active: { key: null, at: NOW } }, NOW).active).toEqual({ key: null, at: NOW });
    expect(parseTabInventory({ tabs: [], closed: [], active: "garbage" }, NOW).active).toBeUndefined();
    // A file from before the record existed reads exactly as it always did.
    expect(parseTabInventory({ tabs: [tab(TAB)], closed: [] }, NOW)).toEqual({ tabs: [tab(TAB)], closed: [] });
  });
});

describe("which conversation a device moves to", () => {
  const canOpen = (key: string) => key === TAB || key === OTHER;
  const decide = (record: { key: string | null; at: number } | null, seenAt: number, current: string) =>
    conversationToFollow({ record, seenAt, current, main: MAIN, canOpen });

  it("opens the conversation the owner was last in elsewhere — a side tab, or main", () => {
    expect(decide({ key: TAB, at: NOW }, 0, MAIN)).toEqual({ follow: TAB, seenAt: NOW });
    expect(decide({ key: null, at: NOW }, 0, TAB)).toEqual({ follow: MAIN, seenAt: NOW });
  });

  it("stays put on a record it has already accounted for: its own turn, or one it followed", () => {
    expect(decide({ key: TAB, at: NOW }, NOW, MAIN)).toEqual({ follow: null, seenAt: NOW });
    expect(decide({ key: TAB, at: NOW - 1 }, NOW, MAIN)).toEqual({ follow: null, seenAt: NOW });
  });

  it("has nothing to do with no record, or before it knows its own main", () => {
    expect(decide(null, 7, MAIN)).toEqual({ follow: null, seenAt: 7 });
    expect(conversationToFollow({ record: { key: TAB, at: NOW }, seenAt: 0, current: "", main: "", canOpen })).toEqual({ follow: null, seenAt: 0 });
  });

  it("counts a newer record for the conversation already on screen as seen", () => {
    expect(decide({ key: TAB, at: NOW }, 0, TAB)).toEqual({ follow: null, seenAt: NOW });
    expect(decide({ key: null, at: NOW }, 0, MAIN)).toEqual({ follow: null, seenAt: NOW });
  });

  it("does not open a conversation it cannot — and does not ask about it again", () => {
    // A key another transport minted (a dual box that switched harness), or a
    // tab neither this browser nor the box lists any more.
    const theirs = "desktop-0a1b2c3d4e5f";
    expect(decide({ key: theirs, at: NOW }, 0, MAIN)).toEqual({ follow: null, seenAt: NOW });
  });
});
