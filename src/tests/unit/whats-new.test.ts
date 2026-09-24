import { describe, expect, it } from "vitest";
import { PORTAL_PLANS_URL } from "@/lib/clawai-usage";
import {
  displayVersion,
  hasPlanCta,
  isWhatsNewState,
  isWhatsNewVersion,
  majorVersionOf,
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_PLANS_URL,
  WHATS_NEW_RELEASE,
  withUtm,
  type WhatsNewState,
} from "@/lib/whats-new";

/** TASK-1059: the pure half of the "What's new in 4.0" card. */

const VALID: WhatsNewState = {
  show: true,
  release: "4.0",
  version: "4.0.0",
  edition: "openclaw",
  cta: { paidFeatures: true, editionSwitch: "hermes" },
  freeMonthCode: null,
};

describe("the card's links", () => {
  it("tags the portal's plans page with the update card's campaign, before the fragment", () => {
    expect(WHATS_NEW_PLANS_URL).toBe(
      "https://clawbox.com/portal/dashboard?utm_source=box&utm_medium=update_card&utm_campaign=v4#subscription",
    );
    const url = new URL(WHATS_NEW_PLANS_URL);
    expect(`${url.origin}${url.pathname}${url.hash}`).toBe(PORTAL_PLANS_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: "box",
      utm_medium: "update_card",
      utm_campaign: "v4",
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
    ["4.0.0", 4],
    ["v4.0.0", 4],
    ["4.1.2", 4],
    ["v4.0.0-12-gabc1234", 4],
    ["3.9.0", 3],
    ["10.0.0", 10],
    [" 4.0.0 ", 4],
  ])("majorVersionOf(%j) is %d", (version, major) => {
    expect(majorVersionOf(version)).toBe(major);
  });

  it.each([null, undefined, "", "unknown", "4", "vX.Y"])("majorVersionOf(%j) is null", (version) => {
    expect(majorVersionOf(version)).toBeNull();
  });

  it("is the 4.x line and nothing else", () => {
    expect(isWhatsNewVersion("4.0.0")).toBe(true);
    expect(isWhatsNewVersion("4.2.0")).toBe(true);
    expect(isWhatsNewVersion("3.9.0")).toBe(false);
    expect(isWhatsNewVersion("5.0.0")).toBe(false);
    expect(isWhatsNewVersion(null)).toBe(false);
  });

  it("announces release 4.0", () => {
    expect(WHATS_NEW_RELEASE).toBe("4.0");
  });

  it("prints the version without its tag prefix", () => {
    expect(displayVersion("v4.0.0")).toBe("4.0.0");
    expect(displayVersion("4.0.0")).toBe("4.0.0");
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
