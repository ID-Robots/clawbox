import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn()),
}));

describe("/setup-api/apps/skill-info", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { promisify } = await import("util");
    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        skills: [
          { name: "test-skill", description: "Test", emoji: "🔧", eligible: true, source: "builtin" },
          { name: "other-skill", description: "Other", emoji: null, eligible: false, missing: { env: ["API_KEY"], bins: [], config: [] }, source: "custom" },
        ],
      }),
    }) as never);
    const mod = await import("@/app/setup-api/apps/skill-info/route");
    GET = mod.GET;
  });

  it("returns all skills", async () => {
    const req = new NextRequest(new URL("http://localhost/setup-api/apps/skill-info"));
    const res = await GET(req);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("test-skill");
  });

  it("returns single skill by appId", async () => {
    const req = new NextRequest(new URL("http://localhost/setup-api/apps/skill-info?appId=test-skill"));
    const res = await GET(req);
    const body = await res.json();
    expect(body.name).toBe("test-skill");
  });

  it("returns 404 for unknown skill", async () => {
    const req = new NextRequest(new URL("http://localhost/setup-api/apps/skill-info?appId=nonexistent"));
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});
