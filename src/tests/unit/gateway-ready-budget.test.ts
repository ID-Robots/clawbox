import { afterEach, describe, expect, it } from "vitest";
import { gatewayReadyWaitMs } from "@/lib/openclaw-config";

/**
 * `GATEWAY_READY_WAIT_MS` is advertised in openclaw-config as an operator
 * escape hatch — "a box that needs longer can be given it without a rebuild" —
 * and nothing in the repo sets it, so the only way it is ever written is by
 * hand on a device. A typo therefore has to fail loudly or not at all.
 *
 * Unguarded, `Number("45s")` is NaN, `waitForPortOpen` reads a non-finite
 * budget as ONE probe, and a 30 s wait silently becomes a single connect whose
 * diagnostic line reads "nothing is listening on 18789 after NaNms". Same
 * guard, same reason, as `respawnWaitMs()` on the Hermes side.
 */
const KEY = "GATEWAY_READY_WAIT_MS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("gatewayReadyWaitMs", () => {
  it("defaults to 30 s when nothing overrides it", () => {
    delete process.env[KEY];
    expect(gatewayReadyWaitMs()).toBe(30000);
  });

  it("takes a valid override", () => {
    process.env[KEY] = "45000";
    expect(gatewayReadyWaitMs()).toBe(45000);
  });

  it("falls back to the default on a malformed or non-positive override", () => {
    for (const bad of ["45s", "", "0", "-1", "NaN"]) {
      process.env[KEY] = bad;
      expect(gatewayReadyWaitMs()).toBe(30000);
    }
  });

  it("is read per call, never frozen at import", () => {
    // A budget cached at module load is the probe-once shape: the box that
    // needs the longer wait would have to be restarted to get it.
    process.env[KEY] = "1000";
    expect(gatewayReadyWaitMs()).toBe(1000);
    process.env[KEY] = "2000";
    expect(gatewayReadyWaitMs()).toBe(2000);
  });
});
