import { describe, expect, it } from "vitest";
import { signalToLevel } from "@/lib/wifi-utils";

describe("wifi-utils", () => {
  describe("signalToLevel", () => {
    it("returns 4 for signal >= 75", () => {
      expect(signalToLevel(75)).toBe(4);
      expect(signalToLevel(80)).toBe(4);
      expect(signalToLevel(100)).toBe(4);
    });

    it("returns 3 for signal >= 50 and < 75", () => {
      expect(signalToLevel(50)).toBe(3);
      expect(signalToLevel(60)).toBe(3);
      expect(signalToLevel(74)).toBe(3);
    });

    it("returns 2 for signal >= 25 and < 50", () => {
      expect(signalToLevel(25)).toBe(2);
      expect(signalToLevel(35)).toBe(2);
      expect(signalToLevel(49)).toBe(2);
    });

    it("returns 1 for signal < 25", () => {
      expect(signalToLevel(0)).toBe(1);
      expect(signalToLevel(1)).toBe(1);
      expect(signalToLevel(24)).toBe(1);
    });

    // Boundary tests at each threshold
    it("handles exact boundary at 25", () => {
      expect(signalToLevel(24)).toBe(1);
      expect(signalToLevel(25)).toBe(2);
    });

    it("handles exact boundary at 50", () => {
      expect(signalToLevel(49)).toBe(2);
      expect(signalToLevel(50)).toBe(3);
    });

    it("handles exact boundary at 75", () => {
      expect(signalToLevel(74)).toBe(3);
      expect(signalToLevel(75)).toBe(4);
    });

    // Edge cases
    it("returns 1 for negative signal values", () => {
      expect(signalToLevel(-1)).toBe(1);
      expect(signalToLevel(-100)).toBe(1);
    });

    it("returns 4 for signal values above 100", () => {
      expect(signalToLevel(101)).toBe(4);
      expect(signalToLevel(999)).toBe(4);
    });

    it("handles fractional signal values", () => {
      expect(signalToLevel(24.9)).toBe(1);
      expect(signalToLevel(25.0)).toBe(2);
      expect(signalToLevel(49.9)).toBe(2);
      expect(signalToLevel(50.0)).toBe(3);
      expect(signalToLevel(74.9)).toBe(3);
      expect(signalToLevel(75.0)).toBe(4);
    });

    it("handles NaN by returning 1", () => {
      // NaN comparisons always return false, so all >= checks fail
      expect(signalToLevel(NaN)).toBe(1);
    });
  });

});
