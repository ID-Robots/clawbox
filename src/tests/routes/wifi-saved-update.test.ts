import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    // execFile signature varies — child_process.execFile(file, args, options, cb).
    // promisify wraps this and ALWAYS passes the cb as the last arg, so we look
    // for the function in either slot.
    const callback = (typeof _opts === "function" ? (_opts as typeof cb) : cb)!;
    const result = execFileMock(cmd, args);
    if (result?.error) {
      const err = result.error as Error & { stdout?: string };
      err.stdout = result.stdout ?? "";
      callback(err, { stdout: result.stdout ?? "", stderr: "" });
    } else {
      callback(null, { stdout: result?.stdout ?? "", stderr: "" });
    }
  },
}));

beforeEach(() => execFileMock.mockReset());
afterEach(() => execFileMock.mockReset());

describe("/setup-api/wifi/saved", () => {
  it("returns parsed profiles, filtering out the hotspot AP profile", async () => {
    execFileMock.mockReturnValue({
      stdout: [
        "TestNet-Home:802-11-wireless:50:wlan0",
        "ClawBox-Setup:802-11-wireless:0:wlan0",
        "Wired:802-3-ethernet:0:eth0",
      ].join("\n"),
    });
    const mod = await import("@/app/setup-api/wifi/saved/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles).toEqual([
      { name: "TestNet-Home", type: "802-11-wireless", priority: 50, device: "wlan0" },
    ]);
  });

  it("returns 500 when nmcli fails", async () => {
    execFileMock.mockReturnValue({ error: new Error("nmcli down") });
    const mod = await import("@/app/setup-api/wifi/saved/route");
    const res = await mod.GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe("/setup-api/wifi/update", () => {
  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/setup-api/wifi/update", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost/setup-api/wifi/update", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects unknown action", async () => {
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(makeRequest({ action: "delete-everything", ssid: "X" }));
    expect(res.status).toBe(400);
  });

  it("rejects empty SSID", async () => {
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(makeRequest({ action: "update", ssid: "" }));
    expect(res.status).toBe(400);
  });

  it("refuses to modify the hotspot profile", async () => {
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(makeRequest({ action: "forget", ssid: "ClawBox-Setup" }));
    expect(res.status).toBe(400);
  });

  it("forgets a saved network via nmcli connection delete", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(makeRequest({ action: "forget", ssid: "TestNet-Home" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, action: "forget" });
    const calls = execFileMock.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(" ")}`);
    expect(calls).toContain("nmcli connection delete TestNet-Home");
  });

  it("rejects passwords shorter than 8 chars", async () => {
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(
      makeRequest({ action: "update", ssid: "TestNet-Home", password: "short" }),
    );
    expect(res.status).toBe(400);
  });

  it("updates a network's password and reactivates it", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(
      makeRequest({
        action: "update",
        ssid: "TestNet-Home",
        password: "valid-password-123",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connected).toBe(true);
  });

  it("reports reactivateError when nmcli connection up fails", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "connection" && args[1] === "up") {
        return { error: new Error("802-11-wireless: AP not found") };
      }
      return { stdout: "" };
    });
    const mod = await import("@/app/setup-api/wifi/update/route");
    const res = await mod.POST(
      makeRequest({
        action: "update",
        ssid: "TestNet-Home",
        password: "valid-password-123",
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connected).toBe(false);
    expect(body.reactivateError).toMatch(/AP not found/);
  });
});
