import { describe, expect, it } from "vitest";
import { cleanVersion } from "@/lib/version-utils";

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
