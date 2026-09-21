/**
 * POST /setup-api/coding-agent/projects/desktop — put a project with a
 * clawbox.json port on the desktop, once its own server is found listening.
 * Owner-only and same-origin, like the import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const registerServerApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-proxy", () => ({ registerServerApp }));
const listProjects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({ listProjects }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;
let project: string;

function post(body: unknown, auth?: { cookie?: string; bearer?: string; origin?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth?.origin !== undefined) headers.origin = auth.origin;
  return new Request("http://localhost/setup-api/coding-agent/projects/desktop", { method: "POST", headers, body: JSON.stringify(body) });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-route-"));
  fs.writeFileSync(path.join(project, "clawbox.json"), JSON.stringify({ name: "Site", port: 4230 }));
  vi.resetModules();
  vi.clearAllMocks();
  listProjects.mockResolvedValue({ directory: path.dirname(project), projects: [{ folder: path.basename(project), directory: project, name: "Site" }] });
  registerServerApp.mockResolvedValue({ ok: true });
  POST = (await import("@/app/setup-api/coding-agent/projects/desktop/route")).POST;
});

afterEach(() => {
  session.cleanup();
  restore();
  fs.rmSync(project, { recursive: true, force: true });
});

describe("the desktop route", () => {
  const owner = () => ({ cookie: session.cookie, origin: "http://localhost" });

  it("is the owner's, from our page", async () => {
    expect((await POST(post({ directory: project }, { bearer: MCP_TOKEN }))).status).toBe(403);
    expect((await POST(post({ directory: project }, { cookie: session.cookie, origin: "https://evil.example" }))).status).toBe(403);
    expect(registerServerApp).not.toHaveBeenCalled();
  });

  it("registers one of the owner's projects from its manifest", async () => {
    const res = await POST(post({ directory: project }, owner()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: path.basename(project), url: `/apps/${path.basename(project)}/` });
    expect(registerServerApp).toHaveBeenCalledWith({ id: path.basename(project), directory: project, manifest: expect.objectContaining({ name: "Site", port: 4230 }) });
  });

  it("refuses a folder that is not a project, a manifest without a port, and says why a listener was refused", async () => {
    expect((await POST(post({ directory: "/somewhere/else" }, owner()))).status).toBe(404);
    fs.writeFileSync(path.join(project, "clawbox.json"), JSON.stringify({ name: "Site" }));
    expect((await POST(post({ directory: project }, owner()))).status).toBe(409);
    fs.writeFileSync(path.join(project, "clawbox.json"), JSON.stringify({ name: "Site", port: 4230 }));
    registerServerApp.mockResolvedValueOnce({ ok: false, reason: "not_listening", detail: "Nothing is listening on port 4230." });
    const res = await POST(post({ directory: project }, owner()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Nothing is listening on port 4230.", kind: "not_listening" });
    expect((await POST(post({}, owner()))).status).toBe(400);
  });
});
