import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
    // The route stats the skill directory before removing it, so the answer can
    // say whether a skill was actually there. Default: it was.
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  // See uninstall-edition.test.ts for the null (Hermes) half, tested against
  // the real implementation rather than a mock.
  openclawSkillRoot: vi.fn().mockReturnValue("/home/clawbox/.openclaw/workspace/skills"),
  clearSkillEntry: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/openclaw-skill-info", () => ({
  refreshSkillsCache: vi.fn(),
}));

vi.mock("@/lib/kv-store", () => ({
  kvDelete: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/test-data",
  getAll: vi.fn().mockResolvedValue({}),
  setMany: vi.fn().mockResolvedValue(undefined),
}));

describe("/setup-api/apps/uninstall", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { openclawSkillRoot, clearSkillEntry } = await import("@/lib/openclaw-config");
    vi.mocked(openclawSkillRoot).mockReturnValue("/home/clawbox/.openclaw/workspace/skills");
    vi.mocked(clearSkillEntry).mockResolvedValue(true);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.rm).mockResolvedValue(undefined);
    vi.mocked(fsMod.default.stat).mockResolvedValue({ isDirectory: () => true } as never);
    const { getAll, setMany } = await import("@/lib/config-store");
    vi.mocked(getAll).mockResolvedValue({});
    vi.mocked(setMany).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/apps/uninstall/route");
    POST = mod.POST;
  });

  function uninstall(appId: unknown) {
    return POST(new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId }),
    }));
  }

  it("uninstalls an app successfully", async () => {
    const res = await uninstall("test-app");
    const body = await res.json();
    expect(body).toEqual({ ok: true, appId: "test-app", skillRemoved: true });
  });

  it("rejects invalid appId", async () => {
    expect((await uninstall("../hack")).status).toBe(400);
  });

  it("rejects missing appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles uninstall error gracefully", async () => {
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.rm).mockRejectedValue(new Error("Permission denied"));
    expect((await uninstall("test-app")).status).toBe(500);
  });

  it("clears what the skill left in openclaw.json, KV and the preferences", async () => {
    const { getAll, setMany } = await import("@/lib/config-store");
    vi.mocked(getAll).mockResolvedValue({
      "pref:installed_apps": ["test-app", "other"],
      "pref:installed_meta": { "test-app": { name: "Test" }, other: { name: "Other" } },
      "pref:app_test-app_settings": { token: "x" },
    });
    const res = await uninstall("test-app");
    expect(res.status).toBe(200);

    // The config entry, or a reinstall inherits `enabled: false`.
    const { clearSkillEntry } = await import("@/lib/openclaw-config");
    expect(clearSkillEntry).toHaveBeenCalledWith("test-app");

    // The desktop's registry, written here and nowhere else.
    const writes = vi.mocked(setMany).mock.calls.map(([entries]) => entries);
    expect(writes).toContainEqual({
      "pref:installed_apps": ["other"],
      "pref:installed_meta": { other: { name: "Other" } },
    });
    expect(writes).toContainEqual({ "pref:app_test-app_settings": undefined });

    // The window's KV leftovers.
    const { kvDelete } = await import("@/lib/kv-store");
    expect(vi.mocked(kvDelete).mock.calls.map(([k]) => k)).toEqual([
      "clawbox-app-settings-test-app",
      "clawbox-skill-enabled-test-app",
      "clawbox-winsize-installed-test-app",
    ]);

    const { refreshSkillsCache } = await import("@/lib/openclaw-skill-info");
    expect(refreshSkillsCache).toHaveBeenCalled();
  });

  it("still answers ok when the openclaw.json cleanup fails: the files are already gone", async () => {
    const { clearSkillEntry } = await import("@/lib/openclaw-config");
    vi.mocked(clearSkillEntry).mockRejectedValue(new Error("EACCES"));
    const res = await uninstall("test-app");
    expect(await res.json()).toEqual({ ok: true, appId: "test-app", skillRemoved: true });
  });
});
