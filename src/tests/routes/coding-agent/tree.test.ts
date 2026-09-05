/**
 * GET /setup-api/coding-agent/tree — the project page's file explorer.
 *
 * The project is whatever `resolveWorkingDirectory` says it is (mocked here:
 * the rule itself is pinned in coding-agent's own tests); inside it, every
 * refusal is a 404 that looks the same, and nothing outside it can be listed
 * or read. Session-gated like the git block beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const resolveWorkingDirectory = vi.hoisted(() => vi.fn());
const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, resolveWorkingDirectory };
});
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession };
});

let GET: (req: Request) => Promise<Response>;
let root: string;
let project: string;

function get(query: string): Request {
  return new Request(`http://localhost/setup-api/coding-agent/tree?${query}`, { headers: { host: "localhost" } });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-route-"));
  project = path.join(root, "site");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# hi\n");
  fs.writeFileSync(path.join(project, "src", "app.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "no\n");
  vi.resetModules();
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  resolveWorkingDirectory.mockResolvedValue({ directory: project });
  GET = (await import("@/app/setup-api/coding-agent/tree/route")).GET;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listing", () => {
  it("lists the project root for a code project, asked by its id", async () => {
    const res = await GET(get("projectId=site"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing.path).toBe("");
    expect(body.listing.entries.map((e: { name: string; type: string }) => `${e.type}:${e.name}`)).toEqual(["directory:src", "file:README.md"]);
    expect(resolveWorkingDirectory).toHaveBeenCalledWith({ projectId: "site", directory: null });
  });

  it("lists a folder inside, for a folder project named by its directory", async () => {
    const res = await GET(get(`directory=${encodeURIComponent(project)}&path=src`));
    expect(res.status).toBe(200);
    expect((await res.json()).listing.entries.map((e: { name: string }) => e.name)).toEqual(["app.js"]);
    expect(resolveWorkingDirectory).toHaveBeenCalledWith({ projectId: null, directory: project });
  });

  it("answers 404 alike for .git, a climb, an absolute path and a folder that is not there", async () => {
    for (const bad of [".git", "..", "../", "/etc", "nope", "README.md"]) {
      const res = await GET(get(`projectId=site&path=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(404);
      expect((await res.json()).kind).toBe("not_found");
    }
    expect(fs.existsSync(path.join(root, "outside.txt"))).toBe(true);
  });
});

describe("reading a file", () => {
  it("answers the text and its size", async () => {
    const res = await GET(get("projectId=site&file=src%2Fapp.js"));
    expect(res.status).toBe(200);
    expect((await res.json()).file).toMatchObject({ path: "src/app.js", content: "console.log(1)\n", size: 15, binary: false, truncated: false });
  });

  it("refuses a climb, a folder and a file that is not there with the same 404", async () => {
    for (const bad of ["../outside.txt", "src", "nope.js", ".git/config"]) {
      const res = await GET(get(`projectId=site&file=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(404);
    }
  });
});

describe("the gates", () => {
  it("needs a session", async () => {
    requireSession.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 }));
    const res = await GET(get("projectId=site"));
    expect(res.status).toBe(401);
    expect(resolveWorkingDirectory).not.toHaveBeenCalled();
  });

  it("needs a project", async () => {
    const res = await GET(get("path=src"));
    expect(res.status).toBe(400);
    expect(resolveWorkingDirectory).not.toHaveBeenCalled();
  });

  it("passes the resolver's refusal through with its own status and kind", async () => {
    // The class the ROUTE holds: the mock spreads the actual module, and a
    // second importActual after resetModules would be a different class,
    // which `instanceof` in the route would not recognise.
    const { CodingAgentError, httpStatusForCodingError } = await import("@/lib/coding-agent");
    const err = new CodingAgentError("not_found", "There is no such project.");
    resolveWorkingDirectory.mockRejectedValueOnce(err);
    const res = await GET(get("directory=%2Ftmp%2Felsewhere"));
    expect(res.status).toBe(httpStatusForCodingError(err.kind));
    expect(res.status).toBe(404);
    expect((await res.json()).kind).toBe("not_found");
  });
});
