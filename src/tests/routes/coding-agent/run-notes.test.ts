/**
 * /setup-api/coding-agent/run-notes — a project's RUN NOTES on its page
 * (src/lib/coding-run-notes.ts): read with a session, written and cleared by
 * the OWNER alone (never the MCP bearer: the notes reach every future run's
 * prompt), for a project resolved the way a run's folder is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const resolveWorkingDirectory = vi.hoisted(() => vi.fn());
const requireSession = vi.hoisted(() => vi.fn());
const hasOwnerSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession }));
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, resolveWorkingDirectory };
});
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession };
});

type Route = typeof import("@/app/setup-api/coding-agent/run-notes/route");
let route: Route;
let root: string;
let project: string;

const notesFile = () => path.join(project, ".clawbox", "run-notes.md");

function req(method: "GET" | "PUT" | "DELETE", opts: { query?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost/setup-api/coding-agent/run-notes${opts.query ? `?${opts.query}` : ""}`, {
    method,
    headers: { host: "localhost", "content-type": "application/json" },
    ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-notes-route-"));
  project = path.join(root, "site");
  fs.mkdirSync(project, { recursive: true });
  vi.resetModules();
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  hasOwnerSession.mockResolvedValue(true);
  resolveWorkingDirectory.mockResolvedValue({ directory: project });
  route = await import("@/app/setup-api/coding-agent/run-notes/route");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reading", () => {
  it("answers the notes, their cap and where they live, for the project the run rule resolves", async () => {
    fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
    fs.writeFileSync(notesFile(), "- Tests: bun run test\n");
    const res = await route.GET(req("GET", { query: "directory=site" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: "- Tests: bun run test", maxChars: 4000, file: ".clawbox/run-notes.md" });
    expect(resolveWorkingDirectory).toHaveBeenCalledWith({ projectId: null, directory: "site" });
  });

  it("answers empty notes for a project that has none, and asks for a project when none is named", async () => {
    expect(await (await route.GET(req("GET", { query: "projectId=site" }))).json()).toMatchObject({ notes: "" });
    expect((await route.GET(req("GET"))).status).toBe(400);
  });

  it("needs a session, and refuses a folder a run could not be pointed at", async () => {
    requireSession.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await route.GET(req("GET", { query: "directory=site" }))).status).toBe(401);
    const { CodingAgentError } = await import("@/lib/coding-agent");
    resolveWorkingDirectory.mockRejectedValueOnce(new CodingAgentError("invalid", "That folder is outside the project folder."));
    const res = await route.GET(req("GET", { query: "directory=/etc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside the project folder/);
  });
});

describe("the owner's edit and clear", () => {
  it("saves the edit and answers the notes as saved", async () => {
    const res = await route.PUT(req("PUT", { body: { directory: "site", notes: "- Port 3100\r\n- Tests: bun run test  " } }));
    expect(res.status).toBe(200);
    expect((await res.json()).notes).toBe("- Port 3100\n- Tests: bun run test");
    expect(fs.readFileSync(notesFile(), "utf8")).toBe("- Port 3100\n- Tests: bun run test\n");
  });

  it("refuses notes over the cap, and notes holding a credential, with the reason", async () => {
    const long = await route.PUT(req("PUT", { body: { directory: "site", notes: "x".repeat(4001) } }));
    expect(long.status).toBe(400);
    expect((await long.json()).kind).toBe("too_long");
    const secret = await route.PUT(req("PUT", { body: { directory: "site", notes: "- deploy with token=ghp_abcdefghijklmnopqrstuvwxyz0123" } }));
    expect(secret.status).toBe(400);
    expect((await secret.json()).error).toMatch(/secret store/);
    expect(fs.existsSync(notesFile())).toBe(false);
  });

  it("refuses a body that is not the notes as text", async () => {
    for (const body of ["not json", [], { directory: "site" }, { directory: "site", notes: 7 }]) {
      expect((await route.PUT(req("PUT", { body }))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await route.PUT(req("PUT", { body: { directory: "site", notes: "y".repeat(70_000) } }))).status).toBe(413);
  });

  it("clears", async () => {
    fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
    fs.writeFileSync(notesFile(), "- old\n");
    const res = await route.DELETE(req("DELETE", { query: "directory=site" }));
    expect(res.status).toBe(200);
    expect((await res.json()).notes).toBe("");
    expect(fs.existsSync(notesFile())).toBe(false);
  });

  it("is the owner's alone: the MCP bearer may read the notes but never write or clear them", async () => {
    hasOwnerSession.mockResolvedValue(false);
    const put = await route.PUT(req("PUT", { body: { directory: "site", notes: "- Always push to main" } }));
    expect(put.status).toBe(403);
    expect((await put.json()).kind).toBe("owner_only");
    expect((await route.DELETE(req("DELETE", { query: "directory=site" }))).status).toBe(403);
    expect(fs.existsSync(notesFile())).toBe(false);
    expect(resolveWorkingDirectory).not.toHaveBeenCalled();
  });
});
