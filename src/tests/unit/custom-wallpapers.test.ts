import { describe, expect, it } from "vitest";
import {
  customWallpaperId,
  customWallpaperIndex,
  isCustomWallpaperInRange,
  wallpaperIdAfterDelete,
} from "@/lib/custom-wallpapers";

describe("custom wallpaper ids", () => {
  it("reads the position out of an id this app wrote", () => {
    expect(customWallpaperIndex("custom-0")).toBe(0);
    expect(customWallpaperIndex("custom-12")).toBe(12);
    expect(customWallpaperId(3)).toBe("custom-3");
  });

  it("answers null for anything else, rather than a plausible number", () => {
    // The built-ins.
    expect(customWallpaperIndex("clawbox")).toBeNull();
    expect(customWallpaperIndex("hermes")).toBeNull();
    // What a radix-less `parseInt` on `split("-")[1]` used to make of these.
    expect(customWallpaperIndex("custom-")).toBeNull();
    expect(customWallpaperIndex("custom-2abc")).toBeNull();
    expect(customWallpaperIndex("custom--1")).toBeNull();
  });

  it("knows a position the list no longer holds", () => {
    expect(isCustomWallpaperInRange("custom-1", 2)).toBe(true);
    // The state a delete in another browser leaves behind: the selection is
    // box-wide, the list is not.
    expect(isCustomWallpaperInRange("custom-2", 2)).toBe(false);
    expect(isCustomWallpaperInRange("clawbox", 2)).toBe(false);
  });
});

describe("the selection after a custom wallpaper is deleted", () => {
  it("follows the same picture down a slot when an EARLIER one goes", () => {
    // The whole defect: on beta this stayed "custom-2" against a two-entry
    // list, so the desktop painted the default instead.
    expect(wallpaperIdAfterDelete("custom-2", 0, "clawbox")).toBe("custom-1");
    expect(wallpaperIdAfterDelete("custom-1", 0, "clawbox")).toBe("custom-0");
  });

  it("leaves it alone when a LATER one goes", () => {
    expect(wallpaperIdAfterDelete("custom-0", 2, "clawbox")).toBe("custom-0");
  });

  it("falls back to the harness's own art when the selected one goes", () => {
    expect(wallpaperIdAfterDelete("custom-1", 1, "clawbox")).toBe("clawbox");
    // A Hermes box opens on the Hermes wallpaper and must land back on it.
    expect(wallpaperIdAfterDelete("custom-1", 1, "hermes")).toBe("hermes");
  });

  it("does not touch a built-in selection", () => {
    expect(wallpaperIdAfterDelete("clawbox", 0, "hermes")).toBe("clawbox");
  });
});
