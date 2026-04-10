import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    rm: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    chown: vi.fn(),
  },
}));

vi.mock("@/lib/updater", () => ({
  resetUpdateState: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/test/data",
}));

import { resetUpdateState } from "@/lib/updater";

type ReaddirResult = Awaited<ReturnType<typeof fs.readdir>>;

const mockResetUpdateState = vi.mocked(resetUpdateState);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs);

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: object,
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args[0] || ""}`;

    let result: { stdout: string; stderr: string } | Error | undefined;
    for (const k of Object.keys(results)) {
      if (key.includes(k)) {
        result = results[k];
        break;
      }
    }

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("POST /setup-api/setup/reset", () => {
  let resetPost: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Mock fetch for Ollama
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    }));

    // Mock process.getuid/getgid
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 1000,
      getgid: () => 1000,
    });

    mockFs.readdir.mockResolvedValue([]);
    mockFs.rm.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockResetUpdateState.mockReturnValue();
    setupExecFileMock({
      nmcli: { stdout: "", stderr: "" },
      systemctl: { stdout: "", stderr: "" },
    });

    const mod = await import("@/app/setup-api/setup/reset/route");
    resetPost = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("performs factory reset successfully", async () => {
    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockResetUpdateState).toHaveBeenCalled();
  });

  it("resets update state", async () => {
    await resetPost();
    expect(mockResetUpdateState).toHaveBeenCalled();
  });

  it("deletes data directory contents except preserved files", async () => {
    mockFs.readdir.mockResolvedValueOnce(
      ["config.json", "oauth-state.json", "network.env"] as unknown as ReaddirResult,
    );

    await resetPost();

    // Should delete config.json and oauth-state.json but not network.env
    expect(mockFs.rm).toHaveBeenCalled();
  });

  it("handles ENOENT error for data directory gracefully", async () => {
    const enoent = new Error("ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    mockFs.readdir.mockRejectedValueOnce(enoent);

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("deletes Ollama models", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "llama2" }, { name: "mistral" }] }),
      })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await resetPost();

    // Should have called delete for each model
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/delete",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("continues when Ollama is not available", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("deletes WiFi connections", async () => {
    setupExecFileMock({
      nmcli: { stdout: "HomeWifi:802-11-wireless\nWorkWifi:802-11-wireless\n", stderr: "" },
      systemctl: { stdout: "", stderr: "" },
    });

    await resetPost();

    // Should have called nmcli to list and delete connections
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("seeds openclaw.json with token auth", async () => {
    await resetPost();

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("openclaw.json"),
      expect.stringContaining('"mode": "token"'),
      expect.any(Object)
    );
  });

  it("schedules reboot after reset", async () => {
    await resetPost();

    // Fast-forward timers to trigger the reboot
    await vi.advanceTimersByTimeAsync(1500);

    // systemctl reboot should have been called
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("returns 500 when file deletion has failures", async () => {
    mockFs.readdir.mockResolvedValueOnce(
      ["file1.json", "file2.json"] as unknown as ReaddirResult,
    );
    mockFs.rm
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Permission denied"));

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("incomplete");
    expect(body.failures).toBeDefined();
  });

  it("returns 500 on unexpected error", async () => {
    mockResetUpdateState.mockImplementation(() => {
      throw new Error("Unexpected failure");
    });

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Unexpected failure");
  });

  it("returns generic error for non-Error throws", async () => {
    mockResetUpdateState.mockImplementation(() => {
      throw "unknown error";
    });

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Factory reset failed");
  });

  it("continues when WiFi cleanup fails", async () => {
    setupExecFileMock({
      nmcli: new Error("nmcli not found"),
      systemctl: { stdout: "", stderr: "" },
    });

    const res = await resetPost();
    const body = await res.json();

    // Should still succeed
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("continues when openclaw.json seeding fails", async () => {
    mockFs.writeFile.mockRejectedValue(new Error("Write failed"));

    const res = await resetPost();
    const body = await res.json();

    // Should still succeed (seeding is non-fatal)
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
