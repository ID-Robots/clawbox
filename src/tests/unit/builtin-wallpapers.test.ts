import { describe, expect, it } from "vitest";
import {
  brandingHarness,
  brandWallpaperId,
  builtinWallpapers,
  defaultWallpaperId,
  renderedWallpaperId,
} from "@/lib/builtin-wallpapers";

/**
 * The built-in wallpaper list is EDITION-SCOPED (owner ruling 2026-09-06), and
 * the rule lives here rather than in the two pages that draw it — the desktop
 * and `/app/settings` each held a copy of the list with a comment asking for
 * them to be kept in step by hand.
 *
 * The three questions this module answers are deliberately separate, because
 * they have different answers on a box that has not said which edition it is:
 * what may be OFFERED, what may be PAINTED, and what may be WRITTEN.
 */

const ids = (harness: string | null) => builtinWallpapers(harness).map((wp) => wp.id);

describe("which built-ins an edition offers", () => {
  it("gives an OpenClaw box its own brand and the neutral one", () => {
    expect(ids("openclaw")).toEqual(["clawbox", "deep-space"]);
  });

  it("gives a Hermes box its own brand and the neutral one", () => {
    expect(ids("hermes")).toEqual(["hermes", "deep-space"]);
  });

  it("gives an unknown edition the neutral one alone", () => {
    // Not "both", and not a guess at one: a brand shown on a doubt is the other
    // product's artwork on the customer's screen half the time.
    expect(ids(null)).toEqual(["deep-space"]);
  });

  it("does not carry the other edition's image file at all", () => {
    // The tile is an <img src>, so an entry that is merely unselectable would
    // still fetch the picture. This is about what the PAGE requests — both
    // files ship on both editions and stay fetchable by URL, which the ruling
    // does not ask about.
    expect(builtinWallpapers("openclaw").map((wp) => wp.image)).not.toContain("/hermes-wallpaper.jpeg");
    expect(builtinWallpapers("hermes").map((wp) => wp.image)).not.toContain("/clawbox-wallpaper.jpeg");
    expect(builtinWallpapers(null).every((wp) => wp.image === "")).toBe(true);
  });

  it("treats an unrecognised harness name as unknown", () => {
    // `/app/settings` stores `d?.active || "unknown"` for a failed probe, and a
    // future harness id must not fall through to one of today's brands.
    expect(ids("unknown")).toEqual(["deep-space"]);
    expect(ids("")).toEqual(["deep-space"]);
  });
});

describe("which harness's branding the device wears", () => {
  it("follows the ACTIVE harness, so the dual SKU shows the one that is running", () => {
    expect(brandingHarness({ active: "hermes", activeKnown: true })).toBe("hermes");
    expect(brandingHarness({ active: "openclaw", activeKnown: true })).toBe("openclaw");
  });

  it("discards `active` entirely when the device could not resolve it", () => {
    // Where `active` is a fallback it is a fallback to "openclaw" whatever the
    // box really is — an unreadable edition lock, or an unreadable config store
    // on a licensed `dual`. Taking it would brand a Hermes device as a ClawBox.
    expect(brandingHarness({ active: "openclaw", activeKnown: false })).toBeNull();
    expect(brandingHarness({ active: "hermes", activeKnown: false })).toBeNull();
  });

  it("says nothing for a probe that has not answered, or a server that predates the field", () => {
    expect(brandingHarness(null)).toBeNull();
    expect(brandingHarness(undefined)).toBeNull();
    expect(brandingHarness({ active: "openclaw" })).toBeNull();
  });
});

describe("painting a fallback vs persisting one", () => {
  it("paints — and offers to write — this edition's own brand once it is known", () => {
    expect(defaultWallpaperId("openclaw")).toBe("clawbox");
    expect(defaultWallpaperId("hermes")).toBe("hermes");
    expect(brandWallpaperId("openclaw")).toBe("clawbox");
    expect(brandWallpaperId("hermes")).toBe("hermes");
  });

  it("paints the neutral wallpaper while it is not, and offers nothing to write", () => {
    // The paint corrects itself the moment the device answers. `wp_id` is
    // box-wide SQLite and does not (#728), so the write is refused instead —
    // which is the whole reason these are two functions and not one.
    expect(defaultWallpaperId(null)).toBe("deep-space");
    expect(brandWallpaperId(null)).toBeNull();
  });
});

describe("what a saved wp_id actually paints", () => {
  it("keeps a built-in this edition ships", () => {
    expect(renderedWallpaperId("clawbox", "openclaw", 0)).toBe("clawbox");
    expect(renderedWallpaperId("deep-space", "hermes", 0)).toBe("deep-space");
  });

  it("heals the OTHER edition's brand to this one", () => {
    // A box re-imaged onto the other edition, or a choice made before the
    // ruling. For the PAINT only — the caller writes nothing back.
    expect(renderedWallpaperId("hermes", "openclaw", 0)).toBe("clawbox");
    expect(renderedWallpaperId("clawbox", "hermes", 0)).toBe("hermes");
  });

  it("shows neither brand while the edition is unknown", () => {
    expect(renderedWallpaperId("clawbox", null, 0)).toBe("deep-space");
    expect(renderedWallpaperId("hermes", null, 0)).toBe("deep-space");
  });

  it("keeps an uploaded picture on every edition, known or not", () => {
    expect(renderedWallpaperId("custom-1", "hermes", 3)).toBe("custom-1");
    expect(renderedWallpaperId("custom-0", null, 1)).toBe("custom-0");
  });

  it("falls back for an upload this browser cannot answer", () => {
    expect(renderedWallpaperId("custom-5", "hermes", 3)).toBe("hermes");
    expect(renderedWallpaperId("custom-5", null, 3)).toBe("deep-space");
  });

  it("does not flash the default before this browser's list has been read", () => {
    // Every `custom-<n>` is out of range against an empty initial state, so a
    // perfectly good selection would blink the brand on every load.
    expect(renderedWallpaperId("custom-2", "openclaw", null)).toBe("custom-2");
  });

  it("lands on the default for nothing chosen at all", () => {
    expect(renderedWallpaperId("", "openclaw", 0)).toBe("clawbox");
    expect(renderedWallpaperId("", null, 0)).toBe("deep-space");
  });
});
