import { describe, expect, it } from "vitest";
import { samePairingRequests, sameSelection } from "@/lib/desktop-shell-equality";

/**
 * "Nothing changed" for the desktop's own state (src/lib/desktop-shell-equality.ts):
 * the answer that lets a setter keep the value it holds, so React does not
 * re-render the whole desktop for an equal copy. A false "same" would leave a
 * stale card or selection on screen, so each rule is pinned in both directions.
 */
describe("samePairingRequests", () => {
  const ann = { code: "PAIR1", id: "42", name: "Ann" };

  it("calls two empty lists the same — every answer on a box with no bot", () => {
    expect(samePairingRequests([], [])).toBe(true);
  });

  it("compares what the card draws, not the objects", () => {
    expect(samePairingRequests([ann], [{ ...ann }])).toBe(true);
    // A field the card never reads does not make it a new card.
    expect(samePairingRequests([ann], [{ ...ann, lastSeenAt: 5 } as typeof ann])).toBe(true);
  });

  it("sees every change the card would show", () => {
    expect(samePairingRequests([ann], [])).toBe(false);
    expect(samePairingRequests([], [ann])).toBe(false);
    expect(samePairingRequests([ann], [{ ...ann, code: "PAIR2" }])).toBe(false);
    expect(samePairingRequests([ann], [{ ...ann, id: "43" }])).toBe(false);
    expect(samePairingRequests([ann], [{ ...ann, name: "Anna" }])).toBe(false);
    const bob = { code: "PAIR3", id: "7", name: "Bob" };
    // The order is the order the cards stack in.
    expect(samePairingRequests([ann, bob], [bob, ann])).toBe(false);
  });
});

describe("sameSelection", () => {
  it("is membership, not identity or order", () => {
    expect(sameSelection(new Set(), new Set())).toBe(true);
    expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  });

  it("sees an icon added, dropped or swapped", () => {
    expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameSelection(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
    expect(sameSelection(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
  });
});
