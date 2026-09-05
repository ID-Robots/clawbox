import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    // The removal itself says whether a skill was there: it runs without
    // `force`, so ENOENT means "nothing of that name" and anything else means
    // "there and not removed". Default: it was there and it went.
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  // See uninstall-edition.test.ts for the other two answers — null (the hermes
  // SKU) and the throw (a config that exists and cannot be read) — both tested
  // against the real implementation rather than a mock.
  openclawSkillRoot: vi.fn().mockReturnValue("/home/clawbox/.openclaw/workspace/skills"),
  clearSkillEntry: vi.fn().mockResolvedValue(true),
  OpenclawConfigUnreadableError: class OpenclawConfigUnreadableError extends Error {
    readonly code = "config_unreadable";
  },
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

  it("refuses, and removes nothing else, when the skill folder will not go", async () => {
    // A skill directory that is THERE and could not be removed used to be
    // reported as `skillRemoved: false` — the value the MCP tool states out
    // loud as "there was no skill of that name on disk" — while the tile, the
    // preferences and the KV went anyway. The removal is refused instead, so
    // the desktop entry the owner would retry from survives.
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.rm).mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "EACCES" }));

    const res = await uninstall("test-app");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "skill_remove_failed",
      retryable: true,
      appId: "test-app",
    });
    const { clearSkillEntry } = await import("@/lib/openclaw-config");
    const { kvDelete } = await import("@/lib/kv-store");
    expect(clearSkillEntry).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it("handles uninstall error gracefully", async () => {
    const fsMod = await import("fs/promises");
    // The skill half succeeds; the deployed webapp's removal is what fails.
    let calls = 0;
    vi.mocked(fsMod.default.rm).mockImplementation(async () => {
      if (calls++ === 0) return undefined;
      throw new Error("Permission denied");
    });
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

  it("fails with the code and the skill fact when a later step throws", async () => {
    // The outer catch's contract, pinned HERE rather than only in the MCP
    // fixture that quotes it: `mcp/tools/desktop.ts` matches this 500 on
    // `"code":"uninstall_failed"` plus `"skillRemoved":true` to tell the agent
    // the app is only partly gone. With the code asserted on one side alone,
    // renaming it would leave both suites green while the agent fell back to
    // "the service did not complete this request. Call clawbox_health".
    const fsMod = await import("fs/promises");
    // The skill folder goes; the webapp removal is what fails.
    vi.mocked(fsMod.default.rm)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    const res = await uninstall("test-app");

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "uninstall_failed",
      retryable: true,
      skillRemoved: true,
    });
  });
});
