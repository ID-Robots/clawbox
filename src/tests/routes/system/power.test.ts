import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

describe("/setup-api/system/power", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    const mod = await import("@/app/setup-api/system/power/route");
    POST = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles shutdown action and triggers execFile after delay", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      method: "POST",
      body: JSON.stringify({ action: "shutdown" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, action: "shutdown" });
    // execFile should NOT have been called yet (before timer fires)
    expect(mockExecFile).not.toHaveBeenCalled();
    // Advance timers to trigger the setTimeout callback
    vi.advanceTimersByTime(2000);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "poweroff"],
      expect.anything()
    );
  });

  it("handles restart action and triggers execFile after delay", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      method: "POST",
      body: JSON.stringify({ action: "restart" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, action: "restart" });
    vi.advanceTimersByTime(2000);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "reboot"],
      expect.anything()
    );
  });

  it("rejects invalid action", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      method: "POST",
      body: JSON.stringify({ action: "invalid" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
