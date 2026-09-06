import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// config-store backs the stored active_harness; mock it so we control the value.
const mockGet = vi.fn();
const mockSwap = vi.fn();
vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => mockGet(...a),
  swap: (...a: unknown[]) => mockSwap(...a),
}));

// Control the dual-license verdict directly (the real module verifies an
// ed25519 signature; here we drive the two states the harness logic branches on).
let licenseValid = false;
vi.mock("@/lib/edition-license", () => ({
  isDualLicenseEnforced: () => true, // a public key is embedded → enforced
  verifyDualLicense: () => licenseValid,
}));

/** The one message the lock is allowed to fail with. Asserting it keeps an
 *  unrelated throw — a mock wired wrong, say — from passing for a lock. */
const LOCKED = "Harness switching is disabled on this edition";

async function loadHarness(edition?: string) {
  vi.resetModules();
  if (edition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = edition;
  return import("@/lib/harness");
}

describe("harness edition lock", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSwap.mockReset();
    licenseValid = false;
  });
  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
  });

  it("defaults to the native openclaw edition (single, locked) when nothing is set", async () => {
    const h = await loadHarness(undefined);
    expect(h.getEdition()).toBe("openclaw");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("openclaw");
    mockGet.mockResolvedValue("hermes"); // stale config ignored on a locked device
    expect(await h.getActiveHarness()).toBe("openclaw");
    await expect(h.setActiveHarness("hermes")).rejects.toThrow(LOCKED);
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it("locks to hermes on the hermes edition", async () => {
    const h = await loadHarness("hermes");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("hermes");
    mockGet.mockResolvedValue("openclaw");
    expect(await h.getActiveHarness()).toBe("hermes");
    await expect(h.setActiveHarness("openclaw")).rejects.toThrow(LOCKED);
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it("dual WITHOUT a valid license degrades to locked single (default harness)", async () => {
    licenseValid = false;
    const h = await loadHarness("dual");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("openclaw");
    await expect(h.setActiveHarness("hermes")).rejects.toThrow(LOCKED);
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it("stays locked on dual when the licence verdict is unavailable", async () => {
    // verifyDualLicense() answers false for everything it cannot confirm — a
    // missing licence, a bad signature, an unreadable expiry. The gate must not
    // read any of those as permission; the store is the thing being protected,
    // so assert it was never touched.
    licenseValid = false;
    const h = await loadHarness("dual");
    expect(h.isDualUnlocked()).toBe(false);
    expect(h.isSingleHarnessEdition()).toBe(true);
    await expect(h.setActiveHarness("hermes")).rejects.toThrow(LOCKED);
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it("dual WITH a valid license unlocks the switcher", async () => {
    licenseValid = true;
    const h = await loadHarness("dual");
    expect(h.isSingleHarnessEdition()).toBe(false);
    expect(h.lockedHarness()).toBeNull();
    mockGet.mockResolvedValue("hermes");
    expect(await h.getActiveHarness()).toBe("hermes"); // honors stored value
    mockSwap.mockResolvedValue("hermes");
    // The write answers with what it REPLACED — the caller's "did this change
    // anything" cannot be answered by a read it made earlier.
    expect(await h.setActiveHarness("openclaw")).toBe("hermes");
    expect(mockSwap).toHaveBeenCalledWith("active_harness", "openclaw");
  });

  it("reports the default as the predecessor when the store held no harness", async () => {
    // A box that has never switched, or one whose stored value is not a
    // harness at all: the same answer `getActiveHarness` gives it, so a
    // re-select of the default is still correctly read as "nothing moved".
    licenseValid = true;
    const h = await loadHarness("dual");
    mockSwap.mockResolvedValue(undefined);
    expect(await h.setActiveHarness("hermes")).toBe("openclaw");
    mockSwap.mockResolvedValue("nonsense");
    expect(await h.setActiveHarness("hermes")).toBe("openclaw");
  });

  it("treats an unknown edition value as the native openclaw edition", async () => {
    const h = await loadHarness("garbage");
    expect(h.getEdition()).toBe("openclaw");
    expect(h.isSingleHarnessEdition()).toBe(true);
  });
});
