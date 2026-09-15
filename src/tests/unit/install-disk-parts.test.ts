/**
 * An install that writes to several directories is measured per FILESYSTEM:
 * parts that share one add up, parts on different ones do not, and a part whose
 * device could not be read is never guessed into someone else's group.
 */
import { describe, expect, it } from "vitest";
import { sumPartsByDevice } from "@/lib/install-disk";

const MIB = 1024 * 1024;

describe("sumPartsByDevice", () => {
  it("adds up the parts that land on one filesystem", () => {
    expect(sumPartsByDevice([
      { dir: "/tmp", bytes: 2048 * MIB, device: "259" },
      { dir: "/home/clawbox/.local", bytes: 768 * MIB, device: "259" },
      { dir: "/home/clawbox/.cache", bytes: 256 * MIB, device: "259" },
    ])).toEqual([{ dir: "/tmp", bytes: 3072 * MIB }]);
  });

  it("keeps parts on different filesystems apart", () => {
    expect(sumPartsByDevice([
      { dir: "/tmp", bytes: 2048 * MIB, device: "40" },
      { dir: "/home/clawbox/.local", bytes: 768 * MIB, device: "259" },
      { dir: "/home/clawbox/.cache", bytes: 256 * MIB, device: "259" },
    ])).toEqual([
      { dir: "/tmp", bytes: 2048 * MIB },
      { dir: "/home/clawbox/.local", bytes: 1024 * MIB },
    ]);
  });

  it("never folds a part with an unknown device into another group", () => {
    expect(sumPartsByDevice([
      { dir: "/a", bytes: 1, device: null },
      { dir: "/b", bytes: 2, device: null },
      { dir: "/c", bytes: 4, device: "259" },
    ])).toEqual([
      { dir: "/a", bytes: 1 },
      { dir: "/b", bytes: 2 },
      { dir: "/c", bytes: 4 },
    ]);
  });
});
