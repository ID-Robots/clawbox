import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn(),
  },
}));

vi.mock("@/lib/code-projects", () => ({
  WEBAPPS_DIR: "/tmp/webapps",
  APP_ID_RE: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  // The create path now deploys + registers via this shared chokepoint; stub
  // it so the route test doesn't hit real config IO (it owns the desktop
  // registration, covered separately in code-projects/webapp-registry tests).
  deployWebapp: vi.fn().mockResolvedValue(undefined),
  // The update path refreshes only index.html via this helper.
  writeWebappIndex: vi.fn().mockResolvedValue(undefined),
}));

import fs from "fs/promises";
const mockReadFile = vi.mocked(fs.readFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockStat = vi.mocked(fs.stat);

describe("/setup-api/webapps", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/webapps/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  describe("GET", () => {
    it("serves index.html for valid app", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("<html>test</html>") as never);
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp"));
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    it("serves specific file", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("body{}") as never);
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp&file=style.css"));
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/css");
    });

    it("rejects invalid app ID", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps?app=../hack"));
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("rejects missing app ID", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"));
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing file", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT") as never);
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp"));
      const res = await GET(req);
      expect(res.status).toBe(404);
    });
  });

  describe("POST", () => {
    it("creates a webapp", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "myapp", html: "<html>test</html>", name: "My App" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.url).toContain("myapp");
    });

    it("rejects invalid app ID", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "../hack", html: "<html></html>" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects missing html", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "myapp" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects oversized html", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "myapp", html: "x".repeat(1_048_577) }),
      });
      const res = await POST(req);
      expect(res.status).toBe(413);
    });

    it("rejects a create with an empty name", async () => {
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "myapp", html: "<html></html>", name: "" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("updates an existing webapp when no name is sent", async () => {
      mockStat.mockResolvedValue({} as never);
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "myapp", html: "<html>updated</html>" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("returns 404 when updating a webapp that does not exist", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT") as never);
      const req = new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId: "ghost", html: "<html></html>" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
    });
  });
});
