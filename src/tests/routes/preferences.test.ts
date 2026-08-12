import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  getAll: vi.fn().mockResolvedValue({}),
  setMany: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as config from "@/lib/config-store";

const mockGetAll = vi.mocked(config.getAll);
const mockSetMany = vi.mocked(config.setMany);

describe("/setup-api/preferences", () => {
  let GET: (req: Request) => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue({});
    mockSetMany.mockResolvedValue(undefined);
    const fsMod = (await import("fs/promises")).default;
    vi.mocked(fsMod.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsMod.readFile).mockResolvedValue("# USER.md\n");
    vi.mocked(fsMod.writeFile).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/preferences/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  describe("GET", () => {
    it("returns all preferences when all=1", async () => {
      mockGetAll.mockResolvedValue({ "pref:wp_opacity": 80, "pref:ui_theme": "dark", "other": "ignored" });
      const req = new Request("http://localhost/setup-api/preferences?all=1");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toEqual({ wp_opacity: 80, ui_theme: "dark" });
    });

    it("returns specific keys", async () => {
      mockGetAll.mockResolvedValue({ "pref:wp_opacity": 80, "pref:ui_theme": "dark" });
      const req = new Request("http://localhost/setup-api/preferences?keys=wp_opacity");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toEqual({ wp_opacity: 80 });
    });

    it("reads the store once however many keys are named", async () => {
      mockGetAll.mockResolvedValue({ "pref:wp_opacity": 80, "pref:ui_theme": "dark" });
      const req = new Request("http://localhost/setup-api/preferences?keys=wp_opacity,ui_theme");
      const res = await GET(req);
      expect(await res.json()).toEqual({ wp_opacity: 80, ui_theme: "dark" });
      expect(mockGetAll).toHaveBeenCalledTimes(1);
    });

    it("answers 400 when more keys are named than a read may carry", async () => {
      const many = Array.from({ length: 40 }, (_, i) => `ui_key${i}`).join(",");
      const res = await GET(new Request(`http://localhost/setup-api/preferences?keys=${many}`));
      expect(res.status).toBe(400);
      expect(mockGetAll).not.toHaveBeenCalled();
    });

    it("filters out non-allowed keys", async () => {
      mockGetAll.mockResolvedValue({ "pref:wp_opacity": 80, "pref:bad_key": "x" });
      const req = new Request("http://localhost/setup-api/preferences?keys=wp_opacity,bad_key");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toHaveProperty("wp_opacity");
      expect(body).not.toHaveProperty("bad_key");
    });

    it("returns error when no keys or all param", async () => {
      const req = new Request("http://localhost/setup-api/preferences");
      const res = await GET(req);
      expect(res.status).toBe(400);
    });
  });

  describe("POST", () => {
    it("sets allowed preferences", async () => {
      const req = new Request("http://localhost/setup-api/preferences", {
        method: "POST",
        body: JSON.stringify({ wp_opacity: 80, desktop_theme: "dark", ui_chat_open: 1 }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockSetMany).toHaveBeenCalledWith({
        "pref:wp_opacity": 80,
        "pref:desktop_theme": "dark",
        "pref:ui_chat_open": 1,
      });
    });

    it("filters out non-allowed keys", async () => {
      const req = new Request("http://localhost/setup-api/preferences", {
        method: "POST",
        body: JSON.stringify({ wp_opacity: 80, bad_key: "x" }),
      });
      await POST(req);
      expect(mockSetMany).toHaveBeenCalledWith({ "pref:wp_opacity": 80 });
    });

    it("handles language change", async () => {
      const req = new Request("http://localhost/setup-api/preferences", {
        method: "POST",
        body: JSON.stringify({ ui_language: "de" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("handles English language (removes language section)", async () => {
      const req = new Request("http://localhost/setup-api/preferences", {
        method: "POST",
        body: JSON.stringify({ ui_language: "en" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("returns error on invalid JSON", async () => {
      const req = new Request("http://localhost/setup-api/preferences", {
        method: "POST",
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });
});
