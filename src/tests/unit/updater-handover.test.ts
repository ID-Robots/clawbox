import { describe, expect, it } from "vitest";
import { classifyUpdaterHandover } from "@/lib/updater-handover";
const marker = { version: 1, previousBuildId: "gold-main-build" };
describe("legacy updater handover", () => {
  it("does not overlap root installation even when the new build already exists", () => {
    for (const state of [null, "activating", "active", "deactivating", "reloading"]) {
      expect(classifyUpdaterHandover(marker, "beta-build", state)).toBe("wait");
    }
  });
  it("requires both a completed bootstrap and positive evidence of a new build", () => {
    expect(classifyUpdaterHandover(marker, "beta-build", "inactive")).toBe("ready");
    expect(classifyUpdaterHandover(marker, "gold-main-build", "inactive")).toBe("failed");
    expect(classifyUpdaterHandover(marker, "", "inactive")).toBe("failed");
    expect(classifyUpdaterHandover(marker, "beta-build", "failed")).toBe("failed");
  });
  it("does not infer success from malformed or incompatible records", () => {
    for (const bad of [null, true, {}, {version: 2, previousBuildId: "old"}, {version: 1, previousBuildId: ""}]) {
      expect(classifyUpdaterHandover(bad, "beta-build", "inactive")).toBe("failed");
    }
  });
});
