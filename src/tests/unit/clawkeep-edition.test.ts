import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ClawKeep archives the OpenClaw agent through the openclaw CLI, so on an
// edition that ships no OpenClaw (Hermes) the feature genuinely cannot run.
// getStatus must surface that honestly so the UI can say so instead of printing
// an `npm install -g openclaw` remedy that contradicts the SKU.

vi.mock("@/lib/harness", () => ({ getEdition: vi.fn() }));

import { getEdition } from "@/lib/harness";
const mockGetEdition = vi.mocked(getEdition);

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-edition-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

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

describe("clawkeep getStatus — supportedOnEdition", () => {
  it("is false on the hermes edition", async () => {
    mockGetEdition.mockReturnValue("hermes");
    const status = await clawkeep.getStatus();
    expect(status.supportedOnEdition).toBe(false);
  });

  it("is true on the openclaw edition", async () => {
    mockGetEdition.mockReturnValue("openclaw");
    const status = await clawkeep.getStatus();
    expect(status.supportedOnEdition).toBe(true);
  });

  it("is true on the dual edition", async () => {
    mockGetEdition.mockReturnValue("dual");
    const status = await clawkeep.getStatus();
    expect(status.supportedOnEdition).toBe(true);
  });
});
