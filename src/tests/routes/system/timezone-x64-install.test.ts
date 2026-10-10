import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startRootStep } from "@/lib/root-step-runner";
import { saveEnv } from "@/tests/helpers/env";

/**
 * The timezone's OS leg on a PC installed with install-x64.sh.
 *
 * That PC's root helper shipped without a set_timezone step, and the desktop's
 * TimezoneAdopter posts the browser's zone on every load. A failed OS leg
 * leaves the "applied" marker unset — deliberately, it is the retry — so the
 * step failed in the journal on every boot, over a clock that was already on
 * the zone being offered (the browser and the clock are the same desktop's).
 * A clock already on the zone has nothing for root to do; anything else still
 * asks root exactly as before.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-timezone-x64-${process.pid}-${Date.now()}`);

const { getMock, setMock, x64InstallMock, readlinkMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
  x64InstallMock: vi.fn(() => true),
  readlinkMock: vi.fn(async () => "/usr/share/zoneinfo/Europe/Sofia"),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: vi.fn(async () => {}) }));
vi.mock("@/lib/config-store", () => ({ get: getMock, set: setMock }));
vi.mock("@/lib/x64-integration", () => ({ hasX64Install: x64InstallMock }));
vi.mock("@/lib/edition-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/edition-source")>()),
  hasHermesHarness: vi.fn(() => false),
}));
vi.mock("@/lib/openclaw-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-config")>()),
  runOpenclawConfigSet: vi.fn(async () => {}),
  openclawIsAbsent: vi.fn(() => false),
}));
vi.mock("@/lib/clawkeep-scheduler", () => ({ refresh: vi.fn(async () => {}) }));
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({ refresh: vi.fn(async () => {}) }));
// Only the read of /etc/localtime is faked; the env file is written for real.
vi.mock("fs/promises", async (orig) => {
  const actual = await orig<typeof import("fs/promises") & { default: typeof import("fs/promises") }>();
  return { ...actual, readlink: readlinkMock, default: { ...actual.default, readlink: readlinkMock } };
});

const mockStartRootStep = vi.mocked(startRootStep);
let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "TZ");
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.join(TEST_ROOT, "data"), { recursive: true });
});

afterAll(async () => {
  restoreEnv();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  x64InstallMock.mockReturnValue(true);
  readlinkMock.mockResolvedValue("/usr/share/zoneinfo/Europe/Sofia");
  mockStartRootStep.mockResolvedValue(undefined);
});

function adopt(timezone: string): Request {
  return new Request("http://localhost/setup-api/system/timezone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timezone, adopt: true }),
  });
}

describe("the OS leg on an install-x64.sh PC", () => {
  it("is already done when the clock is on the offered zone — no root step, and the zone is recorded applied", async () => {
    const { POST } = await import("@/app/setup-api/system/timezone/route");
    const res = await POST(adopt("Europe/Sofia"));
    expect(res.status).toBe(200);
    expect(mockStartRootStep).not.toHaveBeenCalled();
    expect(readlinkMock).toHaveBeenCalledWith("/etc/localtime");
    // The marker is what stops the adopter offering it on every load.
    expect(setMock).toHaveBeenCalledWith("timezone_applied", "Europe/Sofia");
  });

  it("still asks root when the clock is on another zone", async () => {
    const { POST } = await import("@/app/setup-api/system/timezone/route");
    const res = await POST(adopt("America/New_York"));
    expect(res.status).toBe(200);
    expect(mockStartRootStep).toHaveBeenCalledWith("set_timezone");
  });

  it("names the command that installs a helper with the step when root refuses", async () => {
    readlinkMock.mockRejectedValue(Object.assign(new Error("EINVAL"), { code: "EINVAL" }));
    mockStartRootStep.mockRejectedValue(new Error("Job for clawbox-root-update@set_timezone.service failed"));
    const { POST } = await import("@/app/setup-api/system/timezone/route");
    const res = await POST(adopt("Europe/Sofia"));
    expect(res.status).toBe(502);
    const body = await res.json() as { warning?: string; applied?: boolean };
    expect(body.applied).toBe(false);
    expect(body.warning).toContain(`sudo bash ${TEST_ROOT}/install-x64.sh --step root_step_contract`);
    expect(setMock).not.toHaveBeenCalledWith("timezone_applied", expect.anything());
  });

  it("leaves every other host exactly as it was: root is asked even with the clock on the zone", async () => {
    x64InstallMock.mockReturnValue(false);
    const { POST } = await import("@/app/setup-api/system/timezone/route");
    const res = await POST(adopt("Europe/Sofia"));
    expect(res.status).toBe(200);
    expect(mockStartRootStep).toHaveBeenCalledWith("set_timezone");
    expect(readlinkMock).not.toHaveBeenCalled();
  });
});
