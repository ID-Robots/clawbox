import { describe, it, expect, vi, beforeEach } from "vitest";
import { clawhubSkillUrl, isClawhubHandle, lookupClawhubOwner, pickClawhubMatch } from "@/lib/clawhub-url";

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

describe("isClawhubHandle", () => {
  it("accepts ClawHub's handle shapes and refuses everything that cannot be one", () => {
    for (const handle of ["steipete", "alex098929", "legionspace-hackathon", "a", "iAhmadZain", "a.b_c"]) {
      expect(isClawhubHandle(handle)).toBe(true);
    }
    for (const bad of ["", "-x", "x-", ".x", "ClawHub Community", "a/b", "@steipete", 42, undefined, "a".repeat(41)]) {
      expect(isClawhubHandle(bad)).toBe(false);
    }
  });
});

describe("pickClawhubMatch", () => {
  const matches = [
    { ownerHandle: "steipete", ref: "@steipete/weather", url: "https://clawhub.ai/steipete/skills/weather" },
    { ownerHandle: "thcjp", ref: "@thcjp/weather", url: "https://clawhub.ai/thcjp/skills/weather" },
  ];

  it("picks the one candidate the store's developer names, case-insensitively", () => {
    expect(pickClawhubMatch(matches, "THCJP")).toBe(matches[1]);
  });

  it("never guesses: no developer, a display name, or a stranger picks nothing", () => {
    expect(pickClawhubMatch(matches, undefined)).toBeUndefined();
    expect(pickClawhubMatch(matches, "ClawHub Community")).toBeUndefined();
    expect(pickClawhubMatch(matches, "weatherpro")).toBeUndefined();
  });
});

describe("lookupClawhubOwner", () => {
  const mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);

  beforeEach(() => {
    mockFetch.mockReset();
  });

  const answer = (status: number, body: unknown) =>
    mockFetch.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

  it("names the owner of a unique slug", async () => {
    answer(200, { skill: { slug: "weather-forecast" }, owner: { handle: "alex098929" } });
    await expect(lookupClawhubOwner("weather-forecast")).resolves.toEqual({ status: "found", ownerHandle: "alex098929" });
    expect(mockFetch).toHaveBeenCalledWith("https://clawhub.ai/api/v1/skills/weather-forecast", expect.anything());
  });

  it("lists the publishers of an ambiguous slug, dropping any that is not a handle", async () => {
    answer(409, {
      code: "AMBIGUOUS_SKILL_SLUG",
      matches: [
        { ownerHandle: "steipete", slug: "weather", ref: "@steipete/weather", url: "https://clawhub.ai/steipete/skills/weather" },
        { ownerHandle: "not a handle", ref: "@x/weather", url: "https://clawhub.ai/x" },
        { ownerHandle: "thcjp" },
      ],
    });
    await expect(lookupClawhubOwner("weather")).resolves.toEqual({
      status: "ambiguous",
      matches: [
        { ownerHandle: "steipete", ref: "@steipete/weather", url: "https://clawhub.ai/steipete/skills/weather" },
        { ownerHandle: "thcjp", ref: "@thcjp/weather", url: "https://clawhub.ai/thcjp/skills/weather" },
      ],
    });
  });

  it("reports a missing slug, and never throws for anything else", async () => {
    answer(404, "Skill not found");
    await expect(lookupClawhubOwner("nope")).resolves.toEqual({ status: "not_found" });

    answer(500, "boom");
    await expect(lookupClawhubOwner("x")).resolves.toMatchObject({ status: "unavailable" });

    mockFetch.mockRejectedValue(new Error("TimeoutError"));
    await expect(lookupClawhubOwner("x")).resolves.toMatchObject({ status: "unavailable", error: "TimeoutError" });
  });
});
