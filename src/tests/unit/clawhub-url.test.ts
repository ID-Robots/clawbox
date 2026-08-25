import { describe, it, expect } from "vitest";
import { clawhubSkillUrl } from "@/lib/clawhub-url";

describe("clawhubSkillUrl", () => {
  it("namespaces the skill under its publisher", () => {
    expect(clawhubSkillUrl("security-audit-toolkit", "gitgoodordietrying")).toBe(
      "https://clawhub.ai/gitgoodordietrying/skills/security-audit-toolkit",
    );
  });

  it("does not double the /skills/ segment for an already-namespaced id", () => {
    expect(clawhubSkillUrl("skills/security-audit-toolkit", "gitgoodordietrying")).toBe(
      "https://clawhub.ai/gitgoodordietrying/skills/security-audit-toolkit",
    );
    expect(clawhubSkillUrl("clawhub/cut", "someone")).toBe(
      "https://clawhub.ai/someone/skills/cut",
    );
  });

  it("returns undefined when the publisher is unknown, so callers can fall back", () => {
    // The publisher is the half we genuinely may not have: it is absent from
    // the store's list payload and from older install metadata.
    expect(clawhubSkillUrl("security-audit-toolkit", undefined)).toBeUndefined();
    expect(clawhubSkillUrl("", "gitgoodordietrying")).toBeUndefined();
    expect(clawhubSkillUrl("/", "gitgoodordietrying")).toBeUndefined();
  });

  it("refuses a display name, which is what most listings carry", () => {
    // 162 of the store's first 200 apps report developer "ClawHub Community" —
    // a label, not a handle. Percent-encoding it yields
    // /ClawHub%20Community/skills/<slug>, which ClawHub 404s. Falling back to
    // the store's own link is the only honest answer.
    expect(clawhubSkillUrl("stock-analysis", "ClawHub Community")).toBeUndefined();
    expect(clawhubSkillUrl("x", "two words")).toBeUndefined();
    expect(clawhubSkillUrl("x", "bad/segment")).toBeUndefined();
  });

  it("accepts the handle shapes the store actually publishes", () => {
    for (const handle of ["anotb", "iAhmadZain", "Pegasus02", "10e9928a", "max-sumrall", "a.b"]) {
      expect(clawhubSkillUrl("s", handle)).toBe(`https://clawhub.ai/${handle}/skills/s`);
    }
  });

  it("escapes the slug rather than letting it inject into the URL", () => {
    expect(clawhubSkillUrl("a b", "publisher")).toBe(
      "https://clawhub.ai/publisher/skills/a%20b",
    );
  });
});
