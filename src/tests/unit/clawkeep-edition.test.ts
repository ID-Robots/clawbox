import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ClawKeep used to archive ONLY the OpenClaw agent, through the `openclaw`
// CLI, so the Hermes SKU got an honest "not available on this edition" card.
// It now archives either agent (`clawkeep/agent.py` picks the backend), so
// what getStatus has to be honest about changed shape: not WHETHER the feature
// works, but WHICH agent it captures and whether anything is still missing
// before it can run.

vi.mock("@/lib/harness", () => ({ getEdition: vi.fn() }));

import { getEdition } from "@/lib/harness";
const mockGetEdition = vi.mocked(getEdition);

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-edition-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

/** `getStatus()` spawns `which` for each of two binaries. That is milliseconds
 *  on the device and can exceed vitest's 5s default on a cold Windows host, so
 *  every case here gets room rather than being flaky by platform. */
const STATUS_TIMEOUT_MS = 30_000;

let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  await fs.mkdir(DATA_DIR, { recursive: true });
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("clawkeep getStatus — which agent this box archives", () => {
  it("names hermes on the hermes edition", async () => {
    mockGetEdition.mockReturnValue("hermes");
    expect((await clawkeep.getStatus()).agent).toBe("hermes");
  }, STATUS_TIMEOUT_MS);

  it("names openclaw on the openclaw edition", async () => {
    mockGetEdition.mockReturnValue("openclaw");
    expect((await clawkeep.getStatus()).agent).toBe("openclaw");
  }, STATUS_TIMEOUT_MS);

  it("names openclaw on dual, matching the daemon's own preference", async () => {
    // `device_agent()` in clawkeep/agent.py prefers OpenClaw on a dual box
    // because that is DEFAULT_HARNESS. The two must agree: the daemon is what
    // actually builds the archive, and a UI describing the other agent's
    // contents would be describing a backup nobody makes.
    mockGetEdition.mockReturnValue("dual");
    expect((await clawkeep.getStatus()).agent).toBe("openclaw");
  }, STATUS_TIMEOUT_MS);
});

describe("clawkeep getStatus — archiverReady", () => {
  // These pin the RELATIONSHIP rather than absolute values, because whether a
  // developer's machine happens to have `clawkeepd` or `openclaw` on PATH is
  // not what is being tested.

  it("on hermes, depends on the daemon and NOTHING else", async () => {
    // THE regression this whole change is about: `openclawInstalled` is false
    // on a Hermes box and always will be, so gating the backup on it is what
    // made ClawKeep dead there. The daemon still has to be present — it is
    // both the runner and, on Hermes, the archiver itself.
    mockGetEdition.mockReturnValue("hermes");
    const status = await clawkeep.getStatus();
    expect(status.archiverReady).toBe(status.daemonInstalled);
  }, STATUS_TIMEOUT_MS);

  it("on openclaw, needs the daemon AND the openclaw CLI", async () => {
    mockGetEdition.mockReturnValue("openclaw");
    const status = await clawkeep.getStatus();
    expect(status.archiverReady).toBe(status.daemonInstalled && status.openclawInstalled);
  }, STATUS_TIMEOUT_MS);

  it("never claims readiness on a box with no daemon", async () => {
    // The specific thing CodeRabbit caught: reporting a usable backup path on
    // a device that cannot create a backup at all.
    for (const edition of ["hermes", "openclaw", "dual"] as const) {
      mockGetEdition.mockReturnValue(edition);
      const status = await clawkeep.getStatus();
      if (!status.daemonInstalled) expect(status.archiverReady).toBe(false);
    }
  }, STATUS_TIMEOUT_MS);
});

describe("clawkeep getStatus — honesty about what is in the archive", () => {
  it("declares that a snapshot carries credentials on both editions", async () => {
    // The archive holds provider keys. The UI turns this into the warning that
    // a backup is a credential, so a false here would silently drop it.
    for (const edition of ["hermes", "openclaw"] as const) {
      mockGetEdition.mockReturnValue(edition);
      expect((await clawkeep.getStatus()).backupContainsCredentials).toBe(true);
    }
  }, STATUS_TIMEOUT_MS);

  it("no longer reports any edition as unsupported", async () => {
    for (const edition of ["hermes", "openclaw", "dual"] as const) {
      mockGetEdition.mockReturnValue(edition);
      expect((await clawkeep.getStatus()).supportedOnEdition).toBe(true);
    }
  }, STATUS_TIMEOUT_MS);
});
