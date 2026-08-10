import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// config-store backs the stored active_harness; mock it so we control the value.
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => mockGet(...a),
  set: (...a: unknown[]) => mockSet(...a),
}));

// Control the dual-license verdict directly (the real module verifies an
// ed25519 signature; here we drive the two states the harness logic branches on).
let licenseValid = false;
vi.mock("@/lib/edition-license", () => ({
  isDualLicenseEnforced: () => true, // a public key is embedded → enforced
  verifyDualLicense: () => licenseValid,
}));

async function loadHarness(edition?: string) {
  vi.resetModules();
  if (edition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = edition;
  return import("@/lib/harness");
}

describe("harness edition lock", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
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
    await expect(h.setActiveHarness("hermes")).rejects.toThrow();
  });

  it("locks to hermes on the hermes edition", async () => {
    const h = await loadHarness("hermes");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("hermes");
    mockGet.mockResolvedValue("openclaw");
    expect(await h.getActiveHarness()).toBe("hermes");
    await expect(h.setActiveHarness("openclaw")).rejects.toThrow();
  });

  it("dual WITHOUT a valid license degrades to locked single (default harness)", async () => {
    licenseValid = false;
    const h = await loadHarness("dual");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("openclaw");
    await expect(h.setActiveHarness("hermes")).rejects.toThrow();
  });

  it("dual WITH a valid license unlocks the switcher", async () => {
    licenseValid = true;
    const h = await loadHarness("dual");
    expect(h.isSingleHarnessEdition()).toBe(false);
    expect(h.lockedHarness()).toBeNull();
    mockGet.mockResolvedValue("hermes");
    expect(await h.getActiveHarness()).toBe("hermes"); // honors stored value
    await h.setActiveHarness("openclaw");
    expect(mockSet).toHaveBeenCalledWith("active_harness", "openclaw");
  });

  it("treats an unknown edition value as the native openclaw edition", async () => {
    const h = await loadHarness("garbage");
    expect(h.getEdition()).toBe("openclaw");
    expect(h.isSingleHarnessEdition()).toBe(true);
  });
});
