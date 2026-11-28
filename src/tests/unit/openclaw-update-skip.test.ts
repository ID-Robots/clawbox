import { describe, expect, it } from "vitest";
import {
  installedOpenclawVersion,
  openclawSkippedLine,
  openclawUpdateSkip,
} from "@/lib/openclaw-update-skip";

/**
 * The full update's "is the installed OpenClaw already the pinned one?"
 * question. A wrong YES skips an install the box needed, so everything short
 * of an exact, readable match answers NO and the step runs as it always has.
 */
describe("openclawUpdateSkip", () => {
  it("skips when the installed core equals the pin, and names that version", () => {
    expect(openclawUpdateSkip("OpenClaw 2026.10.9 (3f2a1bc)\n", "2026.10.9\n"))
      .toEqual({ skip: true, version: "2026.10.9" });
  });

  it("does not skip when the versions differ", () => {
    expect(openclawUpdateSkip("OpenClaw 2026.10.7 (3f2a1bc)", "2026.10.9"))
      .toEqual({ skip: false, version: null });
  });

  it("reads field 2 of a banner that carries a build hash, and a pre-release suffix", () => {
    expect(installedOpenclawVersion("OpenClaw 2026.10.9 (3f2a1bc)")).toBe("2026.10.9");
    expect(openclawUpdateSkip("OpenClaw 2026.5.3-1 (abc1234)", "2026.5.3-1"))
      .toEqual({ skip: true, version: "2026.5.3-1" });
  });

  it("compares by exact equality, never by substring", () => {
    // The pin is a substring of the installed version, and the other way round.
    expect(openclawUpdateSkip("OpenClaw 2026.10.10 (abc)", "2026.10.1").skip).toBe(false);
    expect(openclawUpdateSkip("OpenClaw 2026.10.1 (abc)", "2026.10.10").skip).toBe(false);
    expect(openclawUpdateSkip("OpenClaw 2026.10.9-beta.1 (abc)", "2026.10.9").skip).toBe(false);
    // The pin appearing somewhere in the banner is not field 2 equalling it.
    expect(openclawUpdateSkip("OpenClaw 2026.10.7 (built for 2026.10.9)", "2026.10.9").skip).toBe(false);
  });

  it("does not skip on a missing, empty or unreadable banner", () => {
    for (const banner of [null, undefined, "", "   \n", "none"]) {
      expect(openclawUpdateSkip(banner, "2026.10.9"), String(banner)).toEqual({ skip: false, version: null });
    }
  });

  it("does not skip on a garbled banner", () => {
    for (const banner of [
      "2026.10.9",                                   // no product word: field 2 is absent
      "OpenClaw",                                    // no version at all
      "OpenClaw (3f2a1bc) 2026.10.9",                // field 2 is not a version
      "Error: Cannot find module 'openclaw' 2026.10.9",
      "node: OpenClaw 2026.10.9",                    // field 1 is not the product
      "OpenClaw 2026.10",                            // not a full version
      "OpenClaw v2026.10.9 (abc)",                   // not the npm spelling the pin uses
    ]) {
      expect(openclawUpdateSkip(banner, "2026.10.9"), banner).toEqual({ skip: false, version: null });
    }
  });

  it("reads the pin's first token, as the pin file is written with trailing text", () => {
    expect(openclawUpdateSkip("OpenClaw 2026.10.9 (abc)", "2026.10.9   # bumped for TASK-2400\nsecond line\n"))
      .toEqual({ skip: true, version: "2026.10.9" });
    expect(openclawUpdateSkip("OpenClaw 2026.10.9 (abc)", "  2026.10.9\tnotes"))
      .toEqual({ skip: true, version: "2026.10.9" });
  });

  it("does not skip on a missing, empty or garbled pin", () => {
    for (const pin of [null, undefined, "", "  \n", "latest", "# 2026.10.9"]) {
      expect(openclawUpdateSkip("OpenClaw 2026.10.9 (abc)", pin), String(pin)).toEqual({ skip: false, version: null });
    }
  });

  it("says what it skipped in one line", () => {
    expect(openclawSkippedLine("2026.10.9")).toBe("OpenClaw already at 2026.10.9; skipped");
  });
});
