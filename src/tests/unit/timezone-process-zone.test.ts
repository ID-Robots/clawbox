import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProcessTimeZone } from "@/lib/timezone";
import { saveEnv } from "@/tests/helpers/env";

/**
 * F-B of the Memory Shard sweep (2026-09-06): a timezone change did not reach
 * the RUNNING web server. Node fixes its zone at start, and the two
 * "device-local" schedulers arm their hour with `Date#setHours` in that zone,
 * so a server that came up in UTC kept arming "Tue 04:30" at 07:30 Sofia
 * after the owner had set Europe/Sofia. `applyProcessTimeZone` is the one
 * hook there is — Node honours a runtime `process.env.TZ` assignment — and
 * it has to be a VALIDATED one: a TZ Node does not know makes it fall back to
 * UTC silently, which is the zone this exists to leave.
 */

/** Noon UTC in January: Sofia is UTC+2 then, so a Sofia clock reads 14:00. */
const WINTER_NOON_UTC = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("applyProcessTimeZone", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = saveEnv("TZ");
  });

  afterEach(() => {
    // Restored, never deleted: vitest reuses the worker across files, and a
    // zone left behind here would move every later file's clock.
    restoreEnv();
  });

  it("puts the zone into the process, and the next Date carries it", () => {
    process.env.TZ = "UTC";
    expect(new Date(WINTER_NOON_UTC).getHours()).toBe(12);

    expect(applyProcessTimeZone("Europe/Sofia")).toBe("Europe/Sofia");

    expect(process.env.TZ).toBe("Europe/Sofia");
    expect(new Date(WINTER_NOON_UTC).getHours()).toBe(14);
  });

  it("applies ICU's canonical spelling, never the caller's", () => {
    // `europe/sofia` passes ICU (case-insensitive) and fails the box's own
    // zoneinfo; what reaches TZ is the spelling the OS leg was given.
    expect(applyProcessTimeZone("europe/sofia")).toBe("Europe/Sofia");
    expect(process.env.TZ).toBe("Europe/Sofia");
  });

  it.each([
    ["garbage", "Not/A/Zone"],
    ["an offset ICU accepts and timedatectl does not", "+03:00"],
    ["a path", "../../etc/passwd"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["undefined", undefined],
  ])("refuses %s and leaves TZ alone", (_label, value) => {
    process.env.TZ = "UTC";

    expect(applyProcessTimeZone(value)).toBeNull();

    expect(process.env.TZ).toBe("UTC");
    expect(new Date(WINTER_NOON_UTC).getHours()).toBe(12);
  });
});
