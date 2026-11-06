import { describe, expect, it } from "vitest";
import { cleanVersion, parseHermesVersion, shipsOpenclaw, updateNoticeComponents } from "@/lib/version-utils";

describe("version-utils", () => {
  it("returns null for empty values", () => {
    expect(cleanVersion(undefined)).toBeNull();
    expect(cleanVersion(null)).toBeNull();
    expect(cleanVersion("")).toBeNull();
  });

  it("strips the OpenClaw prefix and commit hash suffix", () => {
    expect(cleanVersion("OpenClaw 2026.4.5 (3e72c03)")).toBe("2026.4.5");
  });

  it("strips git describe metadata", () => {
    expect(cleanVersion("v2.2.3-56-gb7948f0")).toBe("v2.2.3");
  });

  it("trims whitespace around cleaned values", () => {
    expect(cleanVersion(" 2026.3.13 (61d171a) ")).toBe("2026.3.13");
  });

  it("returns null when cleanup removes all content", () => {
    expect(cleanVersion("OpenClaw   ")).toBeNull();
  });

  it("leaves already clean versions intact", () => {
    expect(cleanVersion("v1.2.3")).toBe("v1.2.3");
  });
});

describe("parseHermesVersion", () => {
  // The real banner from a hermes-edition box (`hermes --version`, v0.20.5).
  const banner = [
    "Hermes Agent v0.20.5 (2026.8.19) — upstream 261a4efb — local 10914727 (+1 carried commit)",
    "Install directory: /home/clawbox/.hermes/hermes-agent",
    "Install method: git",
  ].join("\n");

  // The real banner at the commit HERMES_PIN_COMMIT now installs, read off the
  // Hermes box (TASK-784). Kept BESIDE the older one rather than replacing it
  // for two reasons: a box mid-update still prints the older banner, and the
  // two differ in their field separator, which pins that the parser does not
  // depend on one. (Which separator belongs to which VERSION is not something
  // this tree can say — the two v0.20.5 fixtures it carries disagree — so
  // nothing here claims it.)
  const banner021 = [
    "Hermes Agent v0.21.1 (2026.9.7) · upstream ead7e91d · local 2237be35 (+32678 carried commits)",
    "Install directory: /home/clawbox/.hermes/hermes-agent",
    "Install method: git",
    "Python: 3.11.15",
  ].join("\n");

  it("reduces the multi-line banner to the version tag", () => {
    expect(parseHermesVersion(banner)).toBe("v0.20.5");
  });

  it("reads the pinned build's banner, whichever separator upstream printed", () => {
    expect(parseHermesVersion(banner021)).toBe("v0.21.1");
  });

  it("takes the version, not the build date, when the tag is missing its v", () => {
    // Both tokens on this line are semver-ish and the build date comes SECOND,
    // so only "first match on line one" gets this right. Written without a
    // leading `v` because that is the one shape the banner tests above cannot
    // distinguish from a date.
    expect(parseHermesVersion("Hermes Agent 0.21.1 (2026.9.7) · local 2237be35")).toBe("0.21.1");
  });

  it("returns null for empty values", () => {
    expect(parseHermesVersion(undefined)).toBeNull();
    expect(parseHermesVersion(null)).toBeNull();
    expect(parseHermesVersion("")).toBeNull();
    expect(parseHermesVersion("   \n  ")).toBeNull();
  });

  it("keeps a bare tag as-is and tolerates a missing v prefix", () => {
    expect(parseHermesVersion("v0.20.5")).toBe("v0.20.5");
    expect(parseHermesVersion("Hermes Agent 0.21.0")).toBe("0.21.0");
  });

  it("keeps a prerelease suffix", () => {
    expect(parseHermesVersion("Hermes Agent v0.21.0-rc.2 (2026.9.1)")).toBe("v0.21.0-rc.2");
  });

  it("falls back to the first line when nothing looks like a version", () => {
    expect(parseHermesVersion("Hermes Agent (dev build)\nInstall method: git")).toBe(
      "Hermes Agent (dev build)",
    );
  });

  it("caps an unrecognised banner so it cannot blow out the About row", () => {
    const long = `Hermes ${"x".repeat(200)}`;
    const parsed = parseHermesVersion(long);
    expect(parsed).toHaveLength(65);
    expect(parsed?.endsWith("…")).toBe(true);
  });
});

describe("the desktop's update card names OpenClaw only where the update keeps it current", () => {
  const stale = { current: "OpenClaw 2026.10.7 (aaaaaaa)", target: "2026.10.9", updateAvailable: true };
  const current = { current: "v4.3.0", target: null, updateAvailable: false };

  it("never on the Hermes edition, even when the payload carries a stale core", () => {
    expect(shipsOpenclaw({ edition: "hermes" })).toBe(false);
    expect(updateNoticeComponents({ clawbox: current, openclaw: stale, edition: "hermes" }))
      .toEqual({ clawbox: false, openclaw: false });
  });

  it("on dual and on openclaw, and from a server too old to say its edition", () => {
    for (const edition of ["dual", "openclaw", undefined]) {
      expect(shipsOpenclaw({ edition })).toBe(true);
      expect(updateNoticeComponents({ clawbox: current, openclaw: stale, edition }).openclaw).toBe(true);
    }
    expect(shipsOpenclaw(null)).toBe(true);
  });

  it("keeps ClawBox's half on the Hermes edition", () => {
    const clawbox = { current: "v4.3.0", target: "beta@98ae3ba", updateAvailable: true };
    expect(updateNoticeComponents({ clawbox, openclaw: stale, edition: "hermes" }))
      .toEqual({ clawbox: true, openclaw: false });
  });

  it("compares versions where the flag is absent or null, as the card always did", () => {
    expect(updateNoticeComponents({ openclaw: { current: "2026.10.7", target: "2026.10.9" } }).openclaw).toBe(true);
    expect(updateNoticeComponents({ openclaw: { current: "2026.10.9", target: "2026.10.9", updateAvailable: null } }).openclaw).toBe(false);
    expect(updateNoticeComponents({ clawbox: { current: "v4.3.0", target: null, updateAvailable: null } }).clawbox).toBe(false);
    expect(updateNoticeComponents(null)).toEqual({ clawbox: false, openclaw: false });
  });
});
