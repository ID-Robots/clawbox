import { describe, expect, it } from "vitest";
import { formatBytes, formatBytesApart } from "@/lib/format-bytes";
import { formatBytes as clawkeepFormatBytes } from "@/components/clawkeep-ui";

/**
 * Sizes on a German desktop kept the English decimal point — "24.1 GB" on
 * ClawKeep, "40.7 MB" on Memory Shard, "1.7 GB" on Local AI (locale sweep
 * DE-11, 2026-09-07). Both formatters take the UI locale now; without one
 * they answer exactly what they always did, so a server or lib caller and a
 * test fixture read the same figure as before.
 */

const TiB = 1024 ** 4;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe("formatBytes with a locale", () => {
  it("keeps the English figures byte-for-byte without a locale", () => {
    expect(formatBytes(24.1 * GiB)).toBe("24.1 GB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * MiB)).toBe("100 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBeNull();
    expect(clawkeepFormatBytes(24.1 * GiB)).toBe("24.1 GB");
    expect(clawkeepFormatBytes(40.7 * MiB)).toBe("40.7 MB");
    expect(clawkeepFormatBytes(0)).toBe("0 B");
  });

  it("writes the decimal separator the locale uses", () => {
    expect(formatBytes(24.1 * GiB, "de")).toBe("24,1 GB");
    expect(formatBytes(1.7 * GiB, "fr")).toBe("1,7 GB");
    expect(clawkeepFormatBytes(24.1 * GiB, "de")).toBe("24,1 GB");
    expect(clawkeepFormatBytes(40.7 * MiB, "de")).toBe("40,7 MB");
  });

  it("never groups thousands, in any locale", () => {
    // `toFixed` never grouped, so "1,010 B" would be a new figure in English
    // and "1.010 B" a fraction of a byte to a German reader. The band
    // [1000, 1024) at any unit is where grouping shows — a 1,010-byte run
    // artifact is an everyday case.
    expect(formatBytes(1010)).toBe("1010 B");
    expect(formatBytes(1010, "de")).toBe("1010 B");
    expect(formatBytes(1000 * GiB)).toBe("1000 GB");
    expect(formatBytes(1000 * GiB, "de")).toBe("1000 GB");
    expect(formatBytes(1500 * TiB, "fr")).toBe("1500 TB");
    expect(clawkeepFormatBytes(1010)).toBe("1010 B");
    expect(clawkeepFormatBytes(1010, "de")).toBe("1010 B");
    expect(clawkeepFormatBytes(1000 * GiB, "de")).toBe("1000 GB");
  });

  it("agrees with itself across the two modules for one number", () => {
    for (const n of [999, 1010, 1536, 40.7 * MiB, 24.1 * GiB, 250 * GiB, 1000 * GiB]) {
      expect(formatBytes(n, "de")).toBe(clawkeepFormatBytes(n, "de"));
    }
  });
});

/**
 * Two sizes set against each other in one sentence — "needs X but only Y is
 * free". Rounded separately, 1.24 GB against 1.21 GB printed "needs 1.2 GB but
 * only 1.2 GB is free": a refusal that read as if the backup had fitted. The
 * table is the one `clawkeep/tests/test_runner.py` holds for the daemon's own
 * sentence, so the two sides print the same figures for the same bytes.
 */
describe("formatBytesApart", () => {
  const cases: [number, number, string, string][] = [
    // Different figures already: exactly what formatBytes prints.
    [1_288_490_189, 322_122_547, "1.2 GB", "307 MB"],
    [2048, 0, "2.0 KB", "0 B"],
    // The same figure for different amounts gains decimals until they part.
    [1_331_439_862, 1_299_227_607, "1.24 GB", "1.21 GB"],
    [1_288_490_189, 1_288_490_189 - MiB, "1.200 GB", "1.199 GB"],
    [300 * MiB + 400_000, 300 * MiB - 200_000, "300.4 MB", "299.8 MB"],
    [5 * GiB + 40 * MiB, 5 * GiB, "5.04 GB", "5.00 GB"],
    // The same amount is the same figure, and is not made to look different.
    [1_288_490_189, 1_288_490_189, "1.2 GB", "1.2 GB"],
    [0, -5, "0 B", "0 B"],
    // Closer than three decimals can show: the shared figure, never a byte count.
    [1_288_490_189, 1_288_490_189 - 100, "1.2 GB", "1.2 GB"],
  ];

  it("prints two different amounts as two different figures", () => {
    for (const [a, b, first, second] of cases) {
      expect({ a, b, printed: formatBytesApart(a, b) }).toEqual({ a, b, printed: [first, second] });
    }
  });

  it("is the same whichever way round the two are given", () => {
    for (const [a, b, first, second] of cases) {
      expect(formatBytesApart(b, a)).toEqual([second, first]);
    }
  });

  it("keeps the locale's decimal separator and never groups", () => {
    expect(formatBytesApart(1_331_439_862, 1_299_227_607, "de")).toEqual(["1,24 GB", "1,21 GB"]);
    expect(formatBytesApart(1010 * GiB + 300 * MiB, 1010 * GiB, "de")).toEqual(["1010,3 GB", "1010,0 GB"]);
  });

  it("never falls back to a raw byte count", () => {
    for (const [a, b] of cases) {
      for (const figure of formatBytesApart(a, b)) expect(figure).not.toMatch(/\d{7,}/);
    }
  });
});
