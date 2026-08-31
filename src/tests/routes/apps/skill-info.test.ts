import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
}));

// Inline implementations, not chained .mockReturnValue: the config's
// `mockReset: true` wipes chained values before every test while a vi.fn(impl)
// keeps its implementation, and this factory only runs once per file.
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  getSkillsDir: vi.fn(() => "/home/clawbox/.openclaw/workspace"),
  openclawIsAbsent: vi.fn(() => false),
  readSkillEnabled: vi.fn(async () => true),
}));

const SKILLS = {
  skills: [
    { name: "test-skill", description: "Test", emoji: "🔧", eligible: true, source: "builtin" },
    { name: "other-skill", description: "Other", emoji: null, eligible: false, missing: { env: ["API_KEY"], bins: [], config: [] }, source: "custom" },
  ],
};

function get(query = "") {
  return new NextRequest(new URL(`http://localhost/setup-api/apps/skill-info${query}`));
}

describe("/setup-api/apps/skill-info", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { promisify } = await import("util");
    exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify(SKILLS) });
    vi.mocked(promisify).mockReturnValue(exec as never);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.stat).mockRejectedValue(new Error("ENOENT"));
    const { readSkillEnabled } = await import("@/lib/openclaw-config");
    vi.mocked(readSkillEnabled).mockResolvedValue(true);
    const mod = await import("@/app/setup-api/apps/skill-info/route");
    GET = mod.GET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all skills", async () => {
    const res = await GET(get());
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("test-skill");
  });

  it("returns single skill by appId with its switch read from openclaw.json", async () => {
    const res = await GET(get("?appId=test-skill"));
    const body = await res.json();
    expect(body.name).toBe("test-skill");
    expect(body.enabled).toBe(true);

    const { readSkillEnabled } = await import("@/lib/openclaw-config");
    vi.mocked(readSkillEnabled).mockResolvedValue(false);
    expect((await (await GET(get("?appId=test-skill"))).json()).enabled).toBe(false);
  });

  it("returns a 404 the window can tell apart for a skill that is gone", async () => {
    const res = await GET(get("?appId=nonexistent"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Skill not found", code: "not_installed" });
    // No folder on disk, so no rescan for it.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("refuses a traversal-shaped appId without touching the filesystem", async () => {
    const fsMod = await import("fs/promises");
    for (const appId of ["../../../etc", ".", "a/b", "x".repeat(65)]) {
      const res = await GET(get(`?appId=${encodeURIComponent(appId)}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Skill not found", code: "not_installed" });
    }
    expect(fsMod.default.stat).not.toHaveBeenCalled();
  });

  it("rescans once for a skill folder the cached list does not know yet", async () => {
    await GET(get("?appId=test-skill"));
    expect(exec).toHaveBeenCalledTimes(1);

    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.stat).mockResolvedValue({ isDirectory: () => true } as never);
    exec.mockResolvedValue({ stdout: JSON.stringify({ skills: [...SKILLS.skills, { name: "just-installed", eligible: true }] }) });
    const res = await GET(get("?appId=just-installed"));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("just-installed");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("answers 503 skills_unavailable when the CLI fails and nothing is cached", async () => {
    exec.mockRejectedValue(new Error("spawn failed"));
    const res = await GET(get("?appId=test-skill"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Skill list unavailable", code: "skills_unavailable" });
  });

  it("serves a stale list at once and refreshes it behind the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    // Inside the freshness window: nothing spawned.
    vi.setSystemTime(new Date("2026-08-31T10:00:10Z"));
    await GET(get());
    expect(exec).toHaveBeenCalledTimes(1);

    // Past it: the cached list is answered without waiting, and a rescan runs.
    vi.setSystemTime(new Date("2026-08-31T10:01:00Z"));
    let resolveScan: (v: unknown) => void = () => {};
    exec.mockImplementation(() => new Promise((r) => { resolveScan = r; }));
    const res = await GET(get());
    expect((await res.json())).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(2);
    resolveScan({ stdout: JSON.stringify({ skills: [] }) });
  });
});
