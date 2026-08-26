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
  it("is true on hermes without any openclaw CLI, because the archiver is built in", async () => {
    // THE regression this whole change is about. `openclawInstalled` is false
    // on a Hermes box and always will be; gating the backup button on it is
    // what made ClawKeep dead there.
    mockGetEdition.mockReturnValue("hermes");
    // NOT asserted against `openclawInstalled`: whether an `openclaw` binary
    // happens to sit on a developer's PATH is not the point. The point is that
    // Hermes does not care either way.
    expect((await clawkeep.getStatus()).archiverReady).toBe(true);
  }, STATUS_TIMEOUT_MS);

  it("follows the openclaw CLI on the openclaw edition", async () => {
    mockGetEdition.mockReturnValue("openclaw");
    const status = await clawkeep.getStatus();
    expect(status.archiverReady).toBe(status.openclawInstalled);
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
