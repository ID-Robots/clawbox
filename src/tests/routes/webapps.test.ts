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
  APP_ID_RE: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  // Where a deployed webapp lives. The route asks for the folder rather than
  // joining WEBAPPS_DIR itself, so the id it serves from is the rebuilt one.
  webappPath: (appId: string) => `/tmp/webapps/${appId}`,
  // The create path now deploys + registers via this shared chokepoint; stub
  // it so the route test doesn't hit real config IO (it owns the desktop
  // registration, covered separately in code-projects/webapp-registry tests).
  deployWebapp: vi.fn().mockResolvedValue(undefined),
  // The update path refreshes only index.html via this helper.
  writeWebappIndex: vi.fn().mockResolvedValue(undefined),
  // The legacy host:port stub path, stubbed to "this is not a stub" so these
  // cases stay about the plain serve/create/update route — the detector, the
  // migration and the down page are exercised against a real temp box in
  // webapps-legacy-stub.test.ts. Listed rather than left out because vitest
  // THROWS on an export a mock factory does not return, which turned every
  // index.html into a 404 the moment the route began looking at one.
  LEGACY_STUB_MAX_BYTES: 4096,
  legacyRedirectPort: () => null,
  serverAppDownHtml: (name: string, detail: string) => `${name}: ${detail}`,
  // The route maps this to a 400; deployWebapp throws it for a name it refuses.
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  },
}));

import fs from "fs/promises";
import { deployWebapp } from "@/lib/code-projects";
import { WEBAPP_DOCUMENT_CSP } from "@/lib/webapp-sandbox";
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

    // The agent's HTML opened TOP-LEVEL (launch:"window", a chat link, a
    // share link in a tab) must have the same opaque origin the framed copy
    // has, or its script runs with the owner's session cookie. The route sets
    // the header on every answer; the one that actually ships is the
    // next.config.ts entry pinned in src/tests/unit/desktop-csp-header.test.ts,
    // since a handler's CSP is dropped in production when the config already
    // sets one — this pins the route's own half.
    it("serves index.html under a CSP sandbox without allow-same-origin", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("<html><script>fetch('/setup-api/preferences?all=1')</script></html>") as never);
      const res = await GET(new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp")));
      expect(res.status).toBe(200);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp.startsWith("sandbox")).toBe(true);
      expect(csp).toBe(WEBAPP_DOCUMENT_CSP);
      expect(csp.split(/\s+/)).toContain("allow-scripts");
      expect(csp.split(/\s+/)).not.toContain("allow-same-origin");
    });

    it("serves a second page (&file=page.html) under the same sandbox", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("<html>page</html>") as never);
      const res = await GET(new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp&file=page.html")));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Content-Security-Policy")).toBe(WEBAPP_DOCUMENT_CSP);
    });

    it("serves an asset under the same sandbox too", async () => {
      // Inert on a stylesheet, load-bearing on an `&file=x.svg` navigated
      // top-level — so it is on every answer rather than on text/html alone.
      mockReadFile.mockResolvedValue(Buffer.from("body{}") as never);
      const res = await GET(new NextRequest(new URL("http://localhost/setup-api/webapps?app=myapp&file=style.css")));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toBe(WEBAPP_DOCUMENT_CSP);
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

    it("never has two desktop registrations inside the route at once", async () => {
      // A create ends in `registerWebappInPreferences`, which reads
      // pref:installed_apps and pref:installed_meta out of config.json, adds
      // one entry and writes the whole map back — with awaits between the read
      // and the write. Two of those overlapping both start from the same
      // snapshot and the second write drops the first's entry, so one of the
      // two apps ends up with its files on disk and no icon anywhere.
      // Measured directly against the real registry: two registrations begun
      // in one tick leave only the second app registered.
      //
      // The route cannot let that happen from here any more. `deployWebapp` is
      // held open on purpose, because overlap is the only thing this can watch
      // for — with the real one the two creates do their own file writes first
      // and drift apart, so the loss needs something to line them up.
      let inFlight = 0;
      let peak = 0;
      vi.mocked(deployWebapp).mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
      });

      const create = (appId: string, name: string) => POST(new NextRequest(new URL("http://localhost/setup-api/webapps"), {
        method: "POST",
        body: JSON.stringify({ appId, html: "<html></html>", name }),
      }));
      const answers = await Promise.all([create("notes", "Notes"), create("timer", "Timer")]);

      expect(answers.map((r) => r.status)).toEqual([200, 200]);
      expect(vi.mocked(deployWebapp)).toHaveBeenCalledTimes(2);
      expect(peak).toBe(1);
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
