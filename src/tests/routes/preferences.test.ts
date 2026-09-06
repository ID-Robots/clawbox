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
    // `access` is how the route asks whether OpenClaw has already introduced
    // the agent, which is what gates the persona write (personaWritesAllowed).
    access: vi.fn().mockResolvedValue(undefined),
  },
}));

// The route asks this ONE question about who is writing installed_*: cookie or
// not. Mocked so the tests say the answer outright rather than minting a
// session against a secret on disk; the helper's own suite covers the cookie.
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn().mockResolvedValue(false),
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
    // The steady state of a box in the field: the agent has been introduced,
    // so USER.md is there and the ritual's BOOTSTRAP.md is long gone.
    vi.mocked(fsMod.access).mockImplementation(async (target) => {
      if (String(target).endsWith("BOOTSTRAP.md")) throw new Error("ENOENT");
    });
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

    // installed_apps / installed_meta decide where a desktop icon OPENS and
    // how (`webappUrl`, `launch: "window"` → a top-level window.open). The
    // middleware admits the MCP bearer to this route, and the bearer is a
    // file anything running as the box's user can read, so a shape check
    // alone let the agent plant an entry that opened its own page as a
    // first-class document with the owner's cookie. Only a browser with the
    // owner's session may write the prefix; the contracted writers
    // (install/uninstall/webapp-registry) write the store directly.
    describe("installed_* writes", () => {
      const planted = {
        installed_meta: {
          evil: {
            name: "My app",
            color: "#f97316",
            iconUrl: "",
            webappUrl: "/setup-api/webapps?app=evil",
            launch: "window",
          },
        },
      };

      it("refuses the whole request from a caller without an owner session", async () => {
        const { hasOwnerSession } = await import("@/lib/owner-session");
        vi.mocked(hasOwnerSession).mockResolvedValue(false);
        const req = new Request("http://localhost/setup-api/preferences", {
          method: "POST",
          headers: { Authorization: "Bearer not-a-cookie" },
          body: JSON.stringify({ ...planted, wp_opacity: 80 }),
        });
        const res = await POST(req);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "owner_only" });
        // Whole, not partial: the innocent key in the same body does not land
        // either, so the caller cannot read the 403 as "the rest took".
        expect(mockSetMany).not.toHaveBeenCalled();
      });

      it("lands from the owner's own session", async () => {
        const { hasOwnerSession } = await import("@/lib/owner-session");
        vi.mocked(hasOwnerSession).mockResolvedValue(true);
        const req = new Request("http://localhost/setup-api/preferences", {
          method: "POST",
          headers: { Cookie: "clawbox_session=owner" },
          body: JSON.stringify(planted),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(mockSetMany).toHaveBeenCalledWith({ "pref:installed_meta": planted.installed_meta });
        expect(hasOwnerSession).toHaveBeenCalledTimes(1);
      });

      it("never asks about the session for a body that names no installed_* key", async () => {
        // The desktop's ordinary writes (wallpaper, window state) and the
        // agent's `preferences_set` stay exactly as they were.
        const { hasOwnerSession } = await import("@/lib/owner-session");
        const req = new Request("http://localhost/setup-api/preferences", {
          method: "POST",
          body: JSON.stringify({ wp_opacity: 80, hidden_installed: ["x"] }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(hasOwnerSession).not.toHaveBeenCalled();
        expect(mockSetMany).toHaveBeenCalledWith({ "pref:wp_opacity": 80, "pref:hidden_installed": ["x"] });
      });
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
