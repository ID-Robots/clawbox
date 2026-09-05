import { describe, expect, it } from "vitest";

/**
 * `fitRows` is the helper the two argument-less list tools use instead of
 * letting `capText` hard-slice their answer. Its edges are what decide whether
 * a device at an awkward volume gets a short answer or a broken one, and both
 * call sites pass a budget they computed themselves, so a budget of zero — or
 * below it — is reachable and must not throw or silently keep a row.
 */

import { fitRows } from "../../../mcp/lib/guard";

describe("fitRows", () => {
  it("keeps everything when everything fits", () => {
    expect(fitRows(["ab", "cd"], 100)).toEqual({ kept: ["ab", "cd"], omitted: 0 });
  });

  it("counts the separator, so an exact fit is exact", () => {
    // Two rows of two characters plus one newline each is six.
    expect(fitRows(["ab", "cd"], 6).omitted).toBe(0);
    expect(fitRows(["ab", "cd"], 5)).toEqual({ kept: ["ab"], omitted: 1 });
  });

  it("keeps nothing, and says so, when the budget is gone", () => {
    expect(fitRows(["ab", "cd"], 0)).toEqual({ kept: [], omitted: 2 });
    // A caller that reserved more than its cap gets a negative budget rather
    // than a clamped one; it must still answer, not throw or keep a row.
    expect(fitRows(["ab"], -50)).toEqual({ kept: [], omitted: 1 });
  });

  it("drops a single row that is longer than the whole budget", () => {
    expect(fitRows(["a".repeat(40)], 10)).toEqual({ kept: [], omitted: 1 });
  });

  it("takes the caller's cost function, because a JSON row is not its own length", () => {
    // The default is a line in a text answer. A row inside a pretty-printed
    // JSON array costs its ESCAPED form plus the indent and the comma, and a
    // `"` in a third party's card name is what makes those two differ.
    const jsonCost = (row: string) => JSON.stringify(row).length + 6;
    const row = '"'.repeat(10);
    expect(fitRows([row], row.length + 1).omitted).toBe(0);
    expect(fitRows([row], row.length + 1, jsonCost).omitted).toBe(1);
  });

  it("returns a copy, so a caller cannot edit the list it was given", () => {
    const rows = ["ab"];
    const { kept } = fitRows(rows, 100);
    kept.push("cd");
    expect(rows).toEqual(["ab"]);
  });
});
