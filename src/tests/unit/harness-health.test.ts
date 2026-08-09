import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// harnessHealthy probes the harness's loopback server and, for hermes, falls
// back to the CLI binary. Mock fetch + fs so we can drive both paths.
vi.mock("fs", () => ({
  default: { accessSync: vi.fn() },
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

import fs from "fs";
import { harnessHealthy } from "@/lib/harness";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("harnessHealthy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the first probe answers", async () => {
    mockFetch.mockResolvedValue({ body: { cancel: vi.fn() } });
    expect(await harnessHealthy("openclaw")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds on a later attempt", async () => {
    // First two probes fail (e.g. event-loop starvation right after a switch),
    // the third answers — the harness must be reported healthy, not "down".
    mockFetch
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ body: { cancel: vi.fn() } });
    expect(await harnessHealthy("openclaw")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("reports openclaw down when every probe fails", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await harnessHealthy("openclaw")).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("falls back to the hermes CLI binary when the serve probe is down", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(fs.accessSync).mockReturnValue(undefined);
    expect(await harnessHealthy("hermes")).toBe(true);
  });

  it("reports hermes down when the probe fails and the binary is missing", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(await harnessHealthy("hermes")).toBe(false);
  });
});
