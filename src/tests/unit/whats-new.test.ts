import { describe, expect, it } from "vitest";
import { PORTAL_PLANS_URL } from "@/lib/clawai-usage";
import {
  displayVersion,
  hasPlanCta,
  isWhatsNewState,
  isWhatsNewVersion,
  releaseLineOf,
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_PLANS_URL,
  WHATS_NEW_RELEASE,
  withUtm,
  type WhatsNewState,
} from "@/lib/whats-new";

/** TASK-1059, TASK-1195: the pure half of the "What's new in 4.2" card. */

const VALID: WhatsNewState = {
  show: true,
  release: "4.2",
  version: "4.2.0",
  edition: "openclaw",
  cta: { paidFeatures: true, editionSwitch: "hermes" },
  freeMonthCode: null,
};

describe("the card's links", () => {
  it("tags the portal's plans page with this release's campaign, before the fragment", () => {
    expect(WHATS_NEW_PLANS_URL).toBe(
      "https://clawbox.com/portal/dashboard?utm_source=box&utm_medium=update_card&utm_campaign=v4.2#subscription",
    );
    const url = new URL(WHATS_NEW_PLANS_URL);
    expect(`${url.origin}${url.pathname}${url.hash}`).toBe(PORTAL_PLANS_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: "box",
      utm_medium: "update_card",
      utm_campaign: "v4.2",
    });
  });

  it("withUtm keeps an existing query and replaces a tag rather than repeating it", () => {
    expect(withUtm("https://example.com/p?a=1&utm_source=old#x", { utm_source: "box" }))
      .toBe("https://example.com/p?a=1&utm_source=box#x");
  });

  it("links the docs site's What's new page", () => {
    expect(WHATS_NEW_DOCS_URL).toBe("https://docs.clawbox.com/whats-new");
  });
});

describe("which versions the card is about", () => {
  it.each([
    ["4.2.0", [4, 2]],
    ["v4.2.0", [4, 2]],
    ["4.2.2", [4, 2]],
    ["v4.2.0-12-gabc1234", [4, 2]],
    ["4.2", [4, 2]],
    ["3.9.0", [3, 9]],
    ["4.20.0", [4, 20]],
    ["10.0.0", [10, 0]],
    [" 4.2.0 ", [4, 2]],
  ])("releaseLineOf(%j) is %j", (version, line) => {
    expect(releaseLineOf(version)).toEqual(line);
  });

  it.each([null, undefined, "", "unknown", "4", "vX.Y"])("releaseLineOf(%j) is null", (version) => {
    expect(releaseLineOf(version)).toBeNull();
  });

  it.each(["4.2.0", "4.2.9", "v4.2.0", "v4.2.0-12-gabc1234"])("is about %j, on the 4.2 line", (version) => {
    expect(isWhatsNewVersion(version)).toBe(true);
  });

  // 4.1.x is the release a box that already dismissed the 4.1 card may still
  // report (4.0.x the one before it); 4.20 is not 4.2; a later release waits
  // for a card of its own.
  it.each(["4.1.0", "4.1.3", "v4.1.0-12-gabc1234", "4.0.0", "4.20.0", "4.3.0", "3.9.0", "5.2.0", "unknown"])(
    "is not about %j",
    (version) => {
      expect(isWhatsNewVersion(version)).toBe(false);
    },
  );

  it("is about nothing when no version could be read", () => {
    expect(isWhatsNewVersion(null)).toBe(false);
    expect(isWhatsNewVersion(undefined)).toBe(false);
  });

  it("announces release 4.2, not 4.1", () => {
    expect(WHATS_NEW_RELEASE).toBe("4.2");
  });

  it("prints the version without its tag prefix", () => {
    expect(displayVersion("v4.2.0")).toBe("4.2.0");
    expect(displayVersion("4.2.0")).toBe("4.2.0");
    expect(displayVersion(null)).toBeNull();
    expect(displayVersion("v")).toBeNull();
  });
});

describe("the plan section", () => {
  it("has something to offer when either line applies", () => {
    expect(hasPlanCta({ paidFeatures: true, editionSwitch: null })).toBe(true);
    expect(hasPlanCta({ paidFeatures: false, editionSwitch: "openclaw" })).toBe(true);
    expect(hasPlanCta({ paidFeatures: false, editionSwitch: null })).toBe(false);
  });
});

describe("isWhatsNewState: the route's answer off the wire", () => {
  it("accepts a complete answer", () => {
    expect(isWhatsNewState(VALID)).toBe(true);
    expect(isWhatsNewState({ ...VALID, version: null, edition: "dual", cta: { paidFeatures: false, editionSwitch: null } })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "yes"],
    ["no show", { ...VALID, show: undefined }],
    ["a string show", { ...VALID, show: "true" }],
    ["no release", { ...VALID, release: undefined }],
    ["an unknown edition", { ...VALID, edition: "business" }],
    ["no cta", { ...VALID, cta: undefined }],
    ["a null cta", { ...VALID, cta: null }],
    ["an unknown switch target", { ...VALID, cta: { paidFeatures: true, editionSwitch: "dual" } }],
    ["a missing paidFeatures", { ...VALID, cta: { editionSwitch: null } }],
    ["a numeric version", { ...VALID, version: 4 }],
    ["no freeMonthCode field", { ...VALID, freeMonthCode: undefined }],
  ])("refuses %s", (_label, value) => {
    expect(isWhatsNewState(value)).toBe(false);
  });
});
