/**
 * The owner-notice ring (src/lib/pending-actions.ts).
 *
 * What it must keep true for the desktops that poll it: an entry is appended,
 * never put in place of what is there; each carries an id and a timestamp a
 * reader can dedupe and advance on; the writer alone keeps the ring small; a
 * store that holds junk is started over rather than thrown at the reader; and
 * writers arriving together all land.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/kv-store", () => ({
  kvGet: (key: string) => store.get(key) ?? null,
  kvSet: (key: string, value: string) => { store.set(key, value); },
}));

import { PENDING_ACTION_TTL_MS, PENDING_ACTIONS_KEY, PENDING_ACTIONS_MAX, pushPendingAction } from "@/lib/pending-actions";

const ring = () => JSON.parse(store.get(PENDING_ACTIONS_KEY) ?? "null") as { id: string; ts: number; type?: string }[];

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
});

describe("pushPendingAction", () => {
  it("appends newest last, with an id and a timestamp, under the ring's own key", async () => {
    const before = Date.now();
    const first = await pushPendingAction({ type: "notify", message: "one" });
    const second = await pushPendingAction({ type: "notify", message: "two" });
    expect([...store.keys()]).toEqual([PENDING_ACTIONS_KEY]);
    expect(ring().map((e) => e.id)).toEqual([first.id, second.id]);
    expect(first.id).not.toBe(second.id);
    expect(first.ts).toBeGreaterThanOrEqual(before);
    expect(ring()[1]).toMatchObject({ type: "notify", message: "two" });
  });

  it("uses the id the caller gives, so a desktop can recognise the same notice across polls", async () => {
    await pushPendingAction({ type: "coding_agent", runId: "run-a" }, "coding:run-a");
    expect(ring()[0].id).toBe("coding:run-a");
  });

  it("keeps one entry per id — the newer one", async () => {
    await pushPendingAction({ type: "register_webapp", appId: "x", iconUrl: "v1" }, "webapp:x");
    await pushPendingAction({ type: "notify", message: "between" });
    await pushPendingAction({ type: "register_webapp", appId: "x", iconUrl: "v2" }, "webapp:x");
    expect(ring().map((e) => e.id)).toEqual([expect.any(String), "webapp:x"]);
    expect(ring()[1]).toMatchObject({ iconUrl: "v2" });
  });

  it("drops entries older than a minute and keeps at most the cap — the writer prunes, never the reader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await pushPendingAction({ type: "notify", message: "stale" }, "stale");
    vi.setSystemTime(1_000_000 + PENDING_ACTION_TTL_MS + 1);
    for (let i = 0; i < PENDING_ACTIONS_MAX + 3; i++) {
      await pushPendingAction({ type: "notify", message: `n${i}` }, `n${i}`);
    }
    const ids = ring().map((e) => e.id);
    expect(ids).not.toContain("stale");
    expect(ids).toHaveLength(PENDING_ACTIONS_MAX);
    // The oldest of the surplus went, the newest stayed.
    expect(ids[0]).toBe("n3");
    expect(ids[ids.length - 1]).toBe(`n${PENDING_ACTIONS_MAX + 2}`);
  });

  it("starts over when the stored value is not a ring", async () => {
    for (const junk of ["{not json", '{"id":"x"}', '[1, "two", {"ts": 5}, {"id": "no-ts"}]']) {
      store.set(PENDING_ACTIONS_KEY, junk);
      const entry = await pushPendingAction({ type: "notify", message: "fresh" });
      expect(ring().map((e) => e.id)).toEqual([entry.id]);
    }
  });

  it("loses nothing when writers arrive together", async () => {
    const entries = await Promise.all(
      Array.from({ length: 5 }, (_, i) => pushPendingAction({ type: "notify", message: `m${i}` })),
    );
    expect(ring().map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });
});
