import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-files-path-tests-${process.pid}-${Date.now()}`);

type RouteHandler = (req: NextRequest, context: { params: Promise<{ path: string[] }> }) => Promise<Response>;

let filesPathGet: RouteHandler;
let filesPathPut: RouteHandler;
let filesPathDelete: RouteHandler;

function createRequest(
  pathname: string,
  options?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(new URL(`http://localhost${pathname}`), options);
}

function createParams(pathSegments: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: pathSegments }) };
}

// Point CLAWBOX_ROOT at the same temp tree as FILES_ROOT so the ClawBox data
// dir lands *inside* the browse root — which is the real arrangement on the
// device, where the browse root is $HOME and the data dir sits under it.
const DATA_DIR = path.join(TEST_ROOT, "data");

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  ({ GET: filesPathGet, PUT: filesPathPut, DELETE: filesPathDelete } = await import("@/app/setup-api/files/[...path]/route"));
});

beforeEach(async () => {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  await fsp.mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("GET /setup-api/files/[...path]", () => {
  it("downloads a file", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "test.txt"), "hello world");

    const req = createRequest("/setup-api/files/test.txt");
    const res = await filesPathGet(req, createParams(["test.txt"]));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("test.txt");
    expect(res.headers.get("Content-Type")).toBe("text/plain");

    const body = await res.arrayBuffer();
    expect(new TextDecoder().decode(body)).toBe("hello world");
  });

  it("downloads nested file", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "subdir"));
    fs.writeFileSync(path.join(TEST_ROOT, "subdir", "nested.txt"), "nested content");

    const req = createRequest("/setup-api/files/subdir/nested.txt");
    const res = await filesPathGet(req, createParams(["subdir", "nested.txt"]));

    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(new TextDecoder().decode(body)).toBe("nested content");
  });

  it("returns 404 for non-existent file", async () => {
    const req = createRequest("/setup-api/files/nonexistent.txt");
    const res = await filesPathGet(req, createParams(["nonexistent.txt"]));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  it("returns 400 for directory", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "mydir"));

    const req = createRequest("/setup-api/files/mydir");
    const res = await filesPathGet(req, createParams(["mydir"]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Is a directory");
  });

  it("rejects path traversal", async () => {
    const req = createRequest("/setup-api/files/../../../etc/passwd");
    const res = await filesPathGet(req, createParams(["..", "..", "..", "etc", "passwd"]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid path");
  });
});

describe("PUT /setup-api/files/[...path]", () => {
  it("renames a file", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "old.txt"), "content");

    const req = createRequest("/setup-api/files/old.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "new.txt" }),
    });
    const res = await filesPathPut(req, createParams(["old.txt"]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "new.txt"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "old.txt"))).toBe(false);
  });

  it("renames a directory", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "olddir"));

    const req = createRequest("/setup-api/files/olddir", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "newdir" }),
    });
    const res = await filesPathPut(req, createParams(["olddir"]));

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(TEST_ROOT, "newdir"))).toBe(true);
  });

  it("returns 400 when newName is missing", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "file.txt"), "content");

    const req = createRequest("/setup-api/files/file.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await filesPathPut(req, createParams(["file.txt"]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("newName required");
  });

  it("returns 404 for non-existent file", async () => {
    const req = createRequest("/setup-api/files/nonexistent.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "new.txt" }),
    });
    const res = await filesPathPut(req, createParams(["nonexistent.txt"]));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  it("returns 409 when destination exists", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "source.txt"), "source");
    fs.writeFileSync(path.join(TEST_ROOT, "dest.txt"), "dest");

    const req = createRequest("/setup-api/files/source.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "dest.txt" }),
    });
    const res = await filesPathPut(req, createParams(["source.txt"]));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("Already exists");
  });

  it("rejects path traversal in newName", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "file.txt"), "content");

    const req = createRequest("/setup-api/files/file.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "../../etc/malicious" }),
    });
    const res = await filesPathPut(req, createParams(["file.txt"]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid destination");
  });
});

describe("the ClawBox data directory through the files route", () => {
  // file-guard's own suite owns the inventory; these rows exist to pin that the
  // route is wired to it — a long-standing store, a name an atomic write
  // generates at runtime, a name that does not exist yet, and a nested one.
  const serverState = [
    ["a long-standing store", ["data", "config.json"]],
    ["a runtime-named sidecar", ["data", "oauth-device-tokens.json.tmp.deadbeef"]],
    ["a name added after this test was written", ["data", "some-future-store.json"]],
    ["a nested file", ["data", "cloudflared", "cert.pem"]],
  ] as const;

  beforeEach(async () => {
    for (const [, segments] of serverState) {
      const abs = path.join(TEST_ROOT, ...segments);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "server state");
    }
  });

  it.each(serverState)("does not download %s", async (_label, segments) => {
    const res = await filesPathGet(
      createRequest(`/setup-api/files/${segments.join("/")}`),
      createParams([...segments]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid path");
  });

  it.each(serverState)("does not delete %s", async (_label, segments) => {
    const res = await filesPathDelete(
      createRequest(`/setup-api/files/${segments.join("/")}`, { method: "DELETE" }),
      createParams([...segments]),
    );
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(TEST_ROOT, ...segments))).toBe(true);
  });

  it("does not rename a data-dir file out of the way", async () => {
    const res = await filesPathPut(
      createRequest("/setup-api/files/data/config.json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: "config.txt" }),
      }),
      createParams(["data", "config.json"]),
    );
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);
  });

  it.each([
    ["webapps", ["data", "webapps", "demo", "index.html"]],
    ["code-projects", ["data", "code-projects", "my-app", "app.js"]],
  ] as const)("still downloads from the public subtree %s", async (_label, segments) => {
    const abs = path.join(TEST_ROOT, ...segments);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, "public content");

    const res = await filesPathGet(
      createRequest(`/setup-api/files/${segments.join("/")}`),
      createParams([...segments]),
    );
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("public content");
  });

  it("still reaches an ordinary file elsewhere under the browse root", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "notes.txt"), "mine");
    const res = await filesPathGet(
      createRequest("/setup-api/files/notes.txt"),
      createParams(["notes.txt"]),
    );
    expect(res.status).toBe(200);
  });
});

describe("DELETE /setup-api/files/[...path]", () => {
  it("deletes a file", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "todelete.txt"), "content");

    const req = createRequest("/setup-api/files/todelete.txt", { method: "DELETE" });
    const res = await filesPathDelete(req, createParams(["todelete.txt"]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "todelete.txt"))).toBe(false);
  });

  it("deletes a directory recursively", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "dir", "subdir"), { recursive: true });
    fs.writeFileSync(path.join(TEST_ROOT, "dir", "file.txt"), "content");
    fs.writeFileSync(path.join(TEST_ROOT, "dir", "subdir", "nested.txt"), "nested");

    const req = createRequest("/setup-api/files/dir", { method: "DELETE" });
    const res = await filesPathDelete(req, createParams(["dir"]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "dir"))).toBe(false);
  });

  it("returns 404 for non-existent file", async () => {
    const req = createRequest("/setup-api/files/nonexistent.txt", { method: "DELETE" });
    const res = await filesPathDelete(req, createParams(["nonexistent.txt"]));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  it("rejects path traversal", async () => {
    const req = createRequest("/setup-api/files/../../../etc/passwd", { method: "DELETE" });
    const res = await filesPathDelete(req, createParams(["..", "..", "..", "etc", "passwd"]));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid path");
  });
});
