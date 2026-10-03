/**
 * TASK-1205: the pure half of the /updating screen's "What's new" panel.
 *
 * What is pinned here:
 *  - only a plain version reaches a URL, and the release page names its tag;
 *  - a payload the screen cannot read in full is no answer at all;
 *  - the panel is NEVER empty: the target's highlights, else this build's own
 *    for a target on the release line they describe, else the generic line and
 *    the release page — decided against THIS build's release line, because the
 *    page outlives the server that answered it.
 */
import { describe, expect, it } from "vitest";
import {
  CLAWBOX_RELEASES_URL,
  isNamedChannel,
  isUpdateWhatsNew,
  normalizeVersion,
  releasePageUrl,
  unknownUpdateWhatsNew,
  updateWhatsNewPanel,
  type UpdateWhatsNew,
} from "@/lib/update-whats-new";
import { WHATS_NEW_RELEASE } from "@/lib/whats-new";

const HIGHLIGHT = { title: "More of the phone for the chat", body: "On a phone the chat opens full screen." };

function answer(overrides: Partial<UpdateWhatsNew> = {}): UpdateWhatsNew {
  return {
    version: "4.2.0",
    channel: "main",
    source: "notes",
    highlights: [HIGHLIGHT],
    releaseUrl: "https://github.com/ID-Robots/clawbox/releases/tag/v4.2.0",
    ...overrides,
  };
}

describe("normalizeVersion and releasePageUrl", () => {
  it("accepts the shapes the box reports and strips the v", () => {
    expect(normalizeVersion("4.1.0")).toBe("4.1.0");
    expect(normalizeVersion(" v4.1.0 ")).toBe("4.1.0");
    expect(normalizeVersion("4.2.0-beta.1")).toBe("4.2.0-beta.1");
  });

  it("refuses anything that is not a version", () => {
    for (const bad of [null, undefined, 4, "", "beta@abc1234", "4.1", "../4.1.0", "4.1.0/../../x", "4.1.0 rm"]) {
      expect(normalizeVersion(bad)).toBeNull();
    }
  });

  it("links the tag's release page, else the releases list", () => {
    expect(releasePageUrl("4.1.0")).toBe("https://github.com/ID-Robots/clawbox/releases/tag/v4.1.0");
    expect(releasePageUrl("v4.1.0")).toBe("https://github.com/ID-Robots/clawbox/releases/tag/v4.1.0");
    expect(releasePageUrl(null)).toBe(CLAWBOX_RELEASES_URL);
    expect(releasePageUrl("beta@abc1234")).toBe(CLAWBOX_RELEASES_URL);
  });

  it("unknownUpdateWhatsNew carries what it knows and nothing else", () => {
    expect(unknownUpdateWhatsNew()).toEqual({
      version: null, channel: null, source: "none", highlights: [], releaseUrl: CLAWBOX_RELEASES_URL,
    });
    expect(unknownUpdateWhatsNew("v4.2.0", "beta")).toEqual({
      version: "4.2.0", channel: "beta", source: "none", highlights: [], releaseUrl: releasePageUrl("4.2.0"),
    });
  });
});

describe("isUpdateWhatsNew", () => {
  it("accepts the route's answers", () => {
    expect(isUpdateWhatsNew(answer())).toBe(true);
    expect(isUpdateWhatsNew(unknownUpdateWhatsNew())).toBe(true);
  });

  it("refuses a payload with holes, or a link off GitHub", () => {
    for (const bad of [
      null,
      "x",
      { ...answer(), source: "bundled" },
      { ...answer(), version: 4 },
      { ...answer(), channel: undefined },
      { ...answer(), highlights: "x" },
      { ...answer(), highlights: [{ title: "x" }] },
      { ...answer(), releaseUrl: "javascript:alert(1)" },
      { ...answer(), releaseUrl: "https://evil.example/releases" },
    ]) {
      expect(isUpdateWhatsNew(bad)).toBe(false);
    }
  });
});

describe("updateWhatsNewPanel", () => {
  it("draws the target's highlights when the notes were read", () => {
    expect(updateWhatsNewPanel(answer())).toEqual({
      kind: "notes",
      version: "4.2.0",
      channel: "main",
      highlights: [HIGHLIGHT],
      releaseUrl: releasePageUrl("4.2.0"),
    });
  });

  it("draws this build's own highlights for a target on the line they describe", () => {
    const version = `${WHATS_NEW_RELEASE}.2`;
    const panel = updateWhatsNewPanel(answer({ version, source: "none", highlights: [] }));
    expect(panel).toEqual({ kind: "bundled", version, channel: "main", releaseUrl: releasePageUrl(version) });
  });

  it("draws the generic line for a target on another line", () => {
    const panel = updateWhatsNewPanel(answer({ version: "9.0.0", source: "none", highlights: [] }));
    expect(panel).toEqual({ kind: "generic", version: "9.0.0", channel: "main", releaseUrl: releasePageUrl("9.0.0") });
  });

  it("draws the generic line and the releases list when there is no answer at all", () => {
    expect(updateWhatsNewPanel(null)).toEqual({
      kind: "generic", version: null, channel: null, releaseUrl: CLAWBOX_RELEASES_URL,
    });
  });

  it("never draws an empty list: notes with only blank items fall back", () => {
    const panel = updateWhatsNewPanel(answer({ version: "9.0.0", highlights: [{ title: "", body: "" }] }));
    expect(panel.kind).toBe("generic");
  });

  it("rebuilds the link from the version rather than trusting the wire", () => {
    const panel = updateWhatsNewPanel(answer({ releaseUrl: "https://github.com/someone-else/fork/releases" }));
    expect(panel.releaseUrl).toBe(releasePageUrl("4.2.0"));
  });
});

describe("isNamedChannel", () => {
  it("names every channel but the default one", () => {
    expect(isNamedChannel("beta")).toBe(true);
    expect(isNamedChannel("qa/feature")).toBe(true);
    expect(isNamedChannel("main")).toBe(false);
    expect(isNamedChannel("")).toBe(false);
    expect(isNamedChannel(null)).toBe(false);
  });
});
