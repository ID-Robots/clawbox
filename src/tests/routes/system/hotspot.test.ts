import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  setMany: vi.fn(),
  getAll: vi.fn(),
}));

import { get, setMany, getAll } from "@/lib/config-store";

const mockGet = vi.mocked(get);
const mockSetMany = vi.mocked(setMany);
const mockGetAll = vi.mocked(getAll);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs);

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args.join(" ")}`;

    let result = results[key];
    if (!result) {
      for (const k of Object.keys(results)) {
        if (key.includes(k) || k.includes(cmd)) {
          result = results[k];
          break;
        }
      }
    }

    // Handle both callback and promisified usage
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    // For promisified version, return a thenable object
    const returnObj = {
      then: (resolve: (value: { stdout: string; stderr: string }) => void, reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result || { stdout: "", stderr: "" });
        }
        return returnObj;
      },
      catch: (reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        }
        return returnObj;
      },
    };
    return returnObj as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("/setup-api/system/hotspot", () => {
  let hotspotGet: () => Promise<Response>;
  let hotspotPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockGet.mockResolvedValue(undefined);
    mockSetMany.mockResolvedValue();
    mockGetAll.mockResolvedValue({});
    setupExecFileMock({
      systemctl: { stdout: "", stderr: "" },
      bash: { stdout: "", stderr: "" },
    });

    const mod = await import("@/app/setup-api/system/hotspot/route");
    hotspotGet = mod.GET;
    hotspotPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /setup-api/system/hotspot", () => {
    it("returns default hotspot config", async () => {
      const res = await hotspotGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ssid).toBe("ClawBox-Setup");
      expect(body.hasPassword).toBe(false);
      expect(body.enabled).toBe(true);
    });

    it("returns configured hotspot settings", async () => {
      mockGetAll.mockResolvedValue({
        hotspot_ssid: "MyHotspot",
        hotspot_password: "secret123",
        hotspot_enabled: false,
      });

      const res = await hotspotGet();
      const body = await res.json();

      expect(body.ssid).toBe("MyHotspot");
      expect(body.hasPassword).toBe(true);
      expect(body.enabled).toBe(false);
    });
  });

  describe("POST /setup-api/system/hotspot", () => {
    it("saves hotspot settings successfully", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "NewHotspot", password: "password123" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "NewHotspot",
        hotspot_password: "password123",
      });
    });

    it("returns 400 for invalid JSON", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await hotspotPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid JSON");
    });

    it("returns 400 for missing SSID", async () => {
      const res = await hotspotPost(jsonRequest({}));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Hotspot name is required");
    });

    it("returns 400 for empty SSID", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "  " }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Hotspot name is required");
    });

    it("returns 400 for SSID too long", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "a".repeat(33) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("32 characters");
    });

    it("returns 400 for password too short", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", password: "short" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("at least 8 characters");
    });

    it("returns 400 for password too long", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", password: "a".repeat(64) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("63 characters");
    });

    it("saves without password", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "OpenHotspot" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "OpenHotspot",
        hotspot_password: undefined,
      });
    });

    it("handles enabled flag", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "MyHotspot",
        hotspot_password: undefined,
        hotspot_enabled: false,
      });
    });

    it("starts AP when enabled", async () => {
      mockGet.mockResolvedValue(true);

      await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));

      expect(mockExecFile).toHaveBeenCalled();
    });

    it("stops AP when disabled", async () => {
      await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));

      // Should call bash with stop-ap.sh
      expect(mockExecFile).toHaveBeenCalled();
    });

    it("continues even if AP toggle fails", async () => {
      setupExecFileMock({
        systemctl: new Error("Service failed"),
        bash: new Error("Script failed"),
      });

      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));
      const body = await res.json();

      // Should still succeed because AP toggle failure is non-fatal
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("returns 500 on setMany failure", async () => {
      mockSetMany.mockRejectedValue(new Error("Config write failed"));

      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot" }));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe("Config write failed");
    });

    it("trims SSID whitespace", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "  MyHotspot  " }));

      expect(res.status).toBe(200);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ hotspot_ssid: "MyHotspot" })
      );
    });
  });
});
