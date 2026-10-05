/**
 * /setup-api/project-folders — the Files app's "Projects": pin, list, unpin.
 * The rules themselves are pinned in src/tests/unit/project-folders.test.ts;
 * this holds the HTTP shape the Files app reads (status, `code`, the list that
 * comes back with every change).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const HOME = fs.realpathSync(os.tmpdir()) + `/clawbox-project-folders-route-${process.pid}-${Date.now()}`;

vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: async () => null }));

type Route = typeof import("@/app/setup-api/project-folders/route");
let route: Route;

const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(new URL(`http://localhost${url}`), {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } } : {}),
  });

beforeAll(async () => {
  process.env.FILES_ROOT = HOME;
  process.env.CLAWBOX_ROOT = path.join(HOME, "clawbox");
  fs.mkdirSync(path.join(HOME, "clawbox", "data"), { recursive: true });
  vi.resetModules();
  route = await import("@/app/setup-api/project-folders/route");
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
});

beforeEach(async () => {
  for (const name of fs.readdirSync(HOME)) {
    if (name !== "clawbox") fs.rmSync(path.join(HOME, name), { recursive: true, force: true });
  }
  const { PROJECT_FOLDERS_CONFIG_KEY } = await import("@/lib/project-folders");
  const config = await import("@/lib/config-store");
  await config.set(PROJECT_FOLDERS_CONFIG_KEY, []);
});

describe("/setup-api/project-folders", () => {
  it("lists nothing on a fresh box, with the workspace's projects folder offered", async () => {
    fs.mkdirSync(path.join(HOME, ".openclaw/workspace/projects/review"), { recursive: true });
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [],
      suggestions: [{ path: ".openclaw/workspace/projects", name: "projects" }],
      max: 50,
    });
  });

  it("pins a folder and answers the pin with the whole list; the offer goes away", async () => {
    fs.mkdirSync(path.join(HOME, ".openclaw/workspace/projects/review"), { recursive: true });
    const res = await route.POST(req("/setup-api/project-folders", { method: "POST", body: { path: "~/.openclaw/workspace/projects" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      added: true,
      folder: { path: ".openclaw/workspace/projects", name: "projects" },
      folders: [{ path: ".openclaw/workspace/projects", name: "projects" }],
    });
    const list = await (await route.GET()).json();
    expect(list.folders).toHaveLength(1);
    expect(list.suggestions).toEqual([]);
  });

  it("answers a refusal with its status and a code the Files app words", async () => {
    fs.mkdirSync(path.join(HOME, ".ssh"));
    fs.writeFileSync(path.join(HOME, "file.txt"), "x");
    const cases: Array<[unknown, number, string]> = [
      [{ path: "~/.ssh" }, 403, "protected"],
      [{ path: "/etc" }, 400, "outside_root"],
      [{ path: "~/missing" }, 404, "not_found"],
      [{ path: "~/file.txt" }, 400, "not_directory"],
      [{ path: "~" }, 400, "is_root"],
      [{}, 400, "invalid"],
    ];
    for (const [body, status, code] of cases) {
      const res = await route.POST(req("/setup-api/project-folders", { method: "POST", body }));
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect((await res.json()).code, JSON.stringify(body)).toBe(code);
    }
    // A body that is not JSON at all is the same "invalid", never a 500.
    const junk = await route.POST(new NextRequest(new URL("http://localhost/setup-api/project-folders"), { method: "POST", body: "{nope" }));
    expect(junk.status).toBe(400);
  });

  it("refuses the box's data directory and the checkout above it with protected/403; a public subtree of it can still be pinned", async () => {
    fs.mkdirSync(path.join(HOME, "clawbox", "data", "code-projects", "hello"), { recursive: true });
    try {
      for (const typed of ["~/clawbox/data", path.join(HOME, "clawbox", "data"), "clawbox/data/", "~/clawbox"]) {
        const res = await route.POST(req("/setup-api/project-folders", { method: "POST", body: { path: typed } }));
        expect(res.status, typed).toBe(403);
        expect(await res.json(), typed).toEqual({
          error: "That folder holds the box's private data and cannot be shown here",
          code: "protected",
        });
      }
      expect((await (await route.GET()).json()).folders).toEqual([]);
      const ok = await route.POST(req("/setup-api/project-folders", { method: "POST", body: { path: "~/clawbox/data/code-projects" } }));
      expect(ok.status).toBe(200);
      expect((await ok.json()).folder).toEqual({ path: "clawbox/data/code-projects", name: "code-projects" });
    } finally {
      fs.rmSync(path.join(HOME, "clawbox", "data", "code-projects"), { recursive: true, force: true });
    }
  });

  it("unpins by ?path=, and a folder that has gone can still be unpinned", async () => {
    fs.mkdirSync(path.join(HOME, "site"));
    await route.POST(req("/setup-api/project-folders", { method: "POST", body: { path: "site" } }));
    fs.rmSync(path.join(HOME, "site"), { recursive: true });
    expect((await (await route.GET()).json()).folders).toEqual([{ path: "site", name: "site", missing: true }]);
    const res = await route.DELETE(req(`/setup-api/project-folders?path=${encodeURIComponent("site")}`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folders: [] });
    const none = await route.DELETE(req("/setup-api/project-folders", { method: "DELETE" }));
    expect(none.status).toBe(400);
  });
});
