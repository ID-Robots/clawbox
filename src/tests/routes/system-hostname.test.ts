import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-hostname-tests-${process.pid}-${Date.now()}`);
const HOSTNAME_ENV_PATH = path.join(TEST_ROOT, "data", "hostname.env");

const execFileMock = vi.fn();
const setControlUiAllowedOriginsMock = vi.fn();
const restartGatewayMock = vi.fn();
const getMock = vi.fn();
const setMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const result = execFileMock(cmd, args);
    if (result?.error) cb(result.error, { stdout: "", stderr: "" });
    else cb(null, { stdout: result?.stdout ?? "", stderr: "" });
  },
}));
vi.mock("@/lib/openclaw-config", () => ({
  setControlUiAllowedOrigins: setControlUiAllowedOriginsMock,
  restartGateway: restartGatewayMock,
}));
vi.mock("@/lib/config-store", () => ({
  get: getMock,
  set: setMock,
}));

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.dirname(HOSTNAME_ENV_PATH), { recursive: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  execFileMock.mockReset();
  setControlUiAllowedOriginsMock.mockReset().mockResolvedValue(undefined);
  restartGatewayMock.mockReset().mockResolvedValue(undefined);
  getMock.mockReset();
  setMock.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await fs.rm(HOSTNAME_ENV_PATH, { force: true });
});

describe("/setup-api/system/hostname GET", () => {
  it("returns the configured hostname when set", async () => {
    getMock.mockResolvedValue("livingroom");
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.hostname).toBe("livingroom");
    expect(body.fqdn).toBe("livingroom.local");
  });

  it("falls back to os.hostname() when nothing is configured", async () => {
    getMock.mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.hostname).toBeTruthy();
    expect(body.default).toBe("clawbox");
  });
});

describe("/setup-api/system/hostname POST", () => {
  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/setup-api/system/hostname", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("rejects invalid JSON", async () => {
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("rejects names with invalid characters", async () => {
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "Has Space" }));
    expect(res.status).toBe(400);
  });

  it("rejects names that start with a hyphen", async () => {
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "-bad" }));
    expect(res.status).toBe(400);
  });

  it("rejects names longer than 63 characters", async () => {
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(
      makeRequest({ hostname: "a".repeat(64) }),
    );
    expect(res.status).toBe(400);
  });

  it("strips a trailing .local and lowercases", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "Kitchen.local" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostname).toBe("kitchen");
    expect(setMock).toHaveBeenCalledWith("hostname", "kitchen");
  });

  it("writes the hostname.env file with the new name", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    const mod = await import("@/app/setup-api/system/hostname/route");
    await mod.POST(makeRequest({ hostname: "writable" }));
    const envContents = await fs.readFile(HOSTNAME_ENV_PATH, "utf-8");
    expect(envContents).toBe("HOSTNAME=writable\n");
  });

  it("returns success with fqdn when systemd command succeeds", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "happy" }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fqdn).toBe("happy.local");
  });

  it("returns 500 when systemd command fails (but persists state)", async () => {
    execFileMock.mockReturnValue({ error: new Error("Failed to start unit") });
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "stillpersisted" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.hostname).toBe("stillpersisted");
    // Even on the systemd failure, the config write should have happened.
    expect(setMock).toHaveBeenCalledWith("hostname", "stillpersisted");
  });

  it("tolerates gateway-restart failures (logs but proceeds)", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    setControlUiAllowedOriginsMock.mockRejectedValue(new Error("config locked"));
    const mod = await import("@/app/setup-api/system/hostname/route");
    const res = await mod.POST(makeRequest({ hostname: "gracedeg" }));
    expect(res.status).toBe(200);
  });
});
