import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// config-store backs the stored active_harness; mock it so we control the value.
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => mockGet(...a),
  set: (...a: unknown[]) => mockSet(...a),
}));

async function loadHarness(edition?: string) {
  vi.resetModules();
  if (edition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = edition;
  // Keep licensing unenforced (no pubkey) for these cases.
  delete process.env.CLAWBOX_LICENSE_PUBKEY;
  return import("@/lib/harness");
}

describe("harness edition lock", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
  });
  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
  });

  it("defaults to dual (switcher enabled) when no edition is set and licensing is unenforced", async () => {
    const h = await loadHarness(undefined);
    expect(h.getEdition()).toBe("dual");
    expect(h.isSingleHarnessEdition()).toBe(false);
    expect(h.lockedHarness()).toBeNull();
    mockGet.mockResolvedValue("hermes");
    expect(await h.getActiveHarness()).toBe("hermes"); // honors stored value
    await h.setActiveHarness("openclaw");
    expect(mockSet).toHaveBeenCalledWith("active_harness", "openclaw");
  });

  it("locks to hermes on the hermes edition, ignoring the stored value", async () => {
    const h = await loadHarness("hermes");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("hermes");
    mockGet.mockResolvedValue("openclaw"); // stale config must be ignored
    expect(await h.getActiveHarness()).toBe("hermes");
    await expect(h.setActiveHarness("openclaw")).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("locks to openclaw on the openclaw edition", async () => {
    const h = await loadHarness("openclaw");
    expect(h.isSingleHarnessEdition()).toBe(true);
    expect(h.lockedHarness()).toBe("openclaw");
    mockGet.mockResolvedValue("hermes");
    expect(await h.getActiveHarness()).toBe("openclaw");
  });

  it("treats an unknown edition value as dual", async () => {
    const h = await loadHarness("garbage");
    expect(h.getEdition()).toBe("dual");
    expect(h.isSingleHarnessEdition()).toBe(false);
  });
});
