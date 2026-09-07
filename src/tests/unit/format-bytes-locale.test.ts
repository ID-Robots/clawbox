import { describe, expect, it } from "vitest";
import { formatBytes } from "@/lib/format-bytes";
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
