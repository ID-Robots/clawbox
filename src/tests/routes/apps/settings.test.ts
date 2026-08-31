import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  setSkillEnabled: vi.fn().mockResolvedValue(undefined),
}));

describe("/setup-api/apps/settings", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsMod.default.writeFile).mockResolvedValue(undefined);
    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    vi.mocked(setSkillEnabled).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/apps/settings/route");
    POST = mod.POST;
  });

  it("rejects invalid appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "../hack", settings: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // "__proto__" passes the charset regex; through setSkillEnabled it would
  // resolve to Object.prototype and set `enabled` on every object in the
  // process.
  it("rejects reserved appIds before they reach setSkillEnabled", async () => {
    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    for (const appId of ["__proto__", "constructor", "prototype"]) {
      const req = new Request("http://localhost/setup-api/apps/settings", {
        method: "POST",
        body: JSON.stringify({ appId, settings: { _setEnabled: true } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    }
    expect(setSkillEnabled).not.toHaveBeenCalled();
  });

  it("rejects missing settings", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("writes the enable/disable switch straight to openclaw.json", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app", settings: { _setEnabled: false } }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);
    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    expect(setSkillEnabled).toHaveBeenCalledWith("test-app", false);
  });

  it("refuses a non-boolean _setEnabled — the string \"false\" must not enable", async () => {
    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    for (const value of ["false", "true", 1, 0, null, {}]) {
      const req = new Request("http://localhost/setup-api/apps/settings", {
        method: "POST",
        body: JSON.stringify({ appId: "test-app", settings: { _setEnabled: value } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    }
    expect(setSkillEnabled).not.toHaveBeenCalled();
  });

  it("answers 500 without the underlying message when the write fails", async () => {
    const { setSkillEnabled } = await import("@/lib/openclaw-config");
    vi.mocked(setSkillEnabled).mockRejectedValue(new Error("EACCES: /home/clawbox/.openclaw/openclaw.json"));
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app", settings: { _setEnabled: true } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to toggle skill");
  });

  it("writes config for home-assistant", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({
        appId: "home-assistant",
        settings: { ha_url: "http://ha.local:8123", ha_token: "token123" },
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.configWritten).toBe(true);
  });

  it("returns ok without config writer for unknown app", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "unknown-app", settings: { key: "val" } }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.configWritten).toBe(false);
  });

  it("rejects invalid value types", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({
        appId: "home-assistant",
        settings: { ha_url: ["array"] },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
