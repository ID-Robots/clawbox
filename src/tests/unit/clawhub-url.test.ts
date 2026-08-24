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

  it("returns undefined when the publisher or id is unknown, so callers can fall back", () => {
    expect(clawhubSkillUrl("security-audit-toolkit", undefined)).toBeUndefined();
    expect(clawhubSkillUrl(undefined, "gitgoodordietrying")).toBeUndefined();
    expect(clawhubSkillUrl("", "gitgoodordietrying")).toBeUndefined();
    expect(clawhubSkillUrl("/", "gitgoodordietrying")).toBeUndefined();
  });

  it("escapes path segments rather than letting them inject into the URL", () => {
    expect(clawhubSkillUrl("a b", "pub lisher")).toBe(
      "https://clawhub.ai/pub%20lisher/skills/a%20b",
    );
  });
});
