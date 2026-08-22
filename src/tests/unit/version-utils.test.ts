import { describe, expect, it } from "vitest";
import { cleanVersion, parseHermesVersion } from "@/lib/version-utils";

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

  it("reduces the multi-line banner to the version tag", () => {
    expect(parseHermesVersion(banner)).toBe("v0.20.5");
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
