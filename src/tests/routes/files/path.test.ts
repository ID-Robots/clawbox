import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// realpath'd, so that on a machine whose tmpdir is itself a link (macOS's
// /var -> /private/var) the symlink cases below compare like with like: the
// guard resolves a path and compares it with DATA_DIR, which is lexical.
const TEST_ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-path-tests-${process.pid}-${Date.now()}`);

type RouteHandler = (req: NextRequest, context: { params: Promise<{ path: string[] }> }) => Promise<Response>;

let filesPathGet: RouteHandler;
let filesPathPut: RouteHandler;
let filesPathDelete: RouteHandler;
let filesList: (req: NextRequest) => Promise<Response>;

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
  ({ GET: filesList } = await import("@/app/setup-api/files/route"));
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

  it("refuses a rename that is a PATH — a file may not leave its folder under a rename", async () => {
    // `../escape.txt` resolves to a path still inside the browse root, so the
    // containment check waved it through: the app said "Renamed" and the file
    // moved to the parent folder with nothing on screen to say where it went.
    fs.mkdirSync(path.join(TEST_ROOT, "scratch"));
    fs.writeFileSync(path.join(TEST_ROOT, "scratch", "a.txt"), "content");

    for (const newName of ["../escape.txt", "sub/escape.txt", "./a.txt", "..", "."]) {
      const res = await filesPathPut(
        createRequest("/setup-api/files/scratch/a.txt", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newName }),
        }),
        createParams(["scratch", "a.txt"]),
      );
      expect([newName, res.status]).toEqual([newName, 400]);
      expect((await res.json()).error).toBe("Invalid destination");
    }

    expect(fs.existsSync(path.join(TEST_ROOT, "scratch", "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "escape.txt"))).toBe(false);
  });

  it("returns 400 when newName is not a string", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "file.txt"), "content");

    const res = await filesPathPut(
      createRequest("/setup-api/files/file.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: { toString: "no" } }),
      }),
      createParams(["file.txt"]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("newName required");
  });

  it("answers 400, not a crash, for a body that is JSON but not an object", async () => {
    // `await req.json()` resolves for a body of literally `null` — the
    // `.catch` never fires — and reading `.newName` off it threw a TypeError
    // before the validation below could answer. The Files app saw a 500 for
    // what is an ordinary bad request. A bare string and an array are the same
    // shape of mistake and take the same road.
    fs.writeFileSync(path.join(TEST_ROOT, "file.txt"), "content");

    for (const raw of ["null", '"new.txt"', "[]", "7"]) {
      const req = createRequest("/setup-api/files/file.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      const res = await filesPathPut(req, createParams(["file.txt"]));
      expect(res.status, `a body of ${raw}`).toBe(400);
      expect((await res.json()).error).toBe("newName required");
      // …and the file is untouched.
      expect(fs.existsSync(path.join(TEST_ROOT, "file.txt"))).toBe(true);
    }
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

// The container is a different question from its contents. `data` itself is
// openable on purpose — the listing filters entry by entry and the public
// subtrees have to be reachable — and the rename/delete handlers reused that
// openability as permission to MOVE it: `data` → `data-copy` took every store
// inside out from under the containment rule, and a recursive delete removed
// the box's state in one request. The same for `~/.config` (only `.config/gh`
// is a protected segment) and for the browse root.
describe("the folders that HOLD the box's state, through the files route", () => {
  const rename = (segments: string[], newName: string) =>
    filesPathPut(
      createRequest(`/setup-api/files/${segments.join("/")}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName }),
      }),
      createParams([...segments]),
    );
  const remove = (segments: string[]) =>
    filesPathDelete(
      createRequest(`/setup-api/files/${segments.join("/")}`, { method: "DELETE" }),
      createParams([...segments]),
    );

  beforeEach(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(path.join(DATA_DIR, "config.json"), "{}");
    await fsp.writeFile(path.join(DATA_DIR, ".session-secret"), "s3cret");
    await fsp.mkdir(path.join(DATA_DIR, "webapps", "demo"), { recursive: true });
    await fsp.writeFile(path.join(DATA_DIR, "webapps", "demo", "index.html"), "<p>public</p>");
    await fsp.mkdir(path.join(TEST_ROOT, ".config", "gh"), { recursive: true });
    await fsp.writeFile(path.join(TEST_ROOT, ".config", "gh", "hosts.yml"), "oauth_token: ghp_x");
  });

  it("does not rename the data dir itself", async () => {
    const res = await rename(["data"], "data-copy");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("protected_container");
    // The folder is visible in the listing, so the answer says what it is
    // rather than pretending the path is invalid.
    expect(body.error).toContain("cannot be moved or deleted");
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "data-copy"))).toBe(false);
    // …and the store cannot be read under a new name.
    const get = await filesPathGet(
      createRequest("/setup-api/files/data-copy/config.json"),
      createParams(["data-copy", "config.json"]),
    );
    expect(get.status).not.toBe(200);
  });

  it("does not delete the data dir itself", async () => {
    const res = await remove(["data"]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("protected_container");
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(DATA_DIR, ".session-secret"))).toBe(true);
  });

  it("does not move or delete a folder that holds a credential store", async () => {
    const hosts = path.join(TEST_ROOT, ".config", "gh", "hosts.yml");
    const renamed = await rename([".config"], "cfg");
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).code).toBe("protected_container");
    expect(fs.existsSync(hosts)).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "cfg"))).toBe(false);

    const removed = await remove([".config"]);
    expect(removed.status).toBe(400);
    expect((await removed.json()).code).toBe("protected_container");
    expect(fs.existsSync(hosts)).toBe(true);
  });

  it("does not delete or rename the browse root itself", async () => {
    // `x/..` resolves to the root, which safePath accepts as-is.
    const removed = await remove(["data", ".."]);
    expect(removed.status).toBe(400);
    expect((await removed.json()).code).toBe("protected_container");
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);

    const renamed = await rename(["data", ".."], "elsewhere");
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).code).toBe("protected_container");
    expect(fs.existsSync(TEST_ROOT)).toBe(true);
  });

  it("does not let a sibling take the data dir's own path", async () => {
    await fsp.mkdir(path.join(TEST_ROOT, "data-copy"));
    await fsp.rm(DATA_DIR, { recursive: true, force: true });
    const res = await rename(["data-copy"], "data");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("protected_container");
    expect(fs.existsSync(path.join(TEST_ROOT, "data-copy"))).toBe(true);
    expect(fs.existsSync(DATA_DIR)).toBe(false);
  });

  it("recognises the data dir through a symlink to the checkout", async () => {
    // `~/link -> ~/clawbox` (here the checkout IS the browse root), then
    // `link/data`: as typed it is nobody's store; resolved, it is the data dir.
    const link = path.join(TEST_ROOT, "link");
    try {
      fs.symlinkSync(TEST_ROOT, link, "dir");
    } catch {
      return; // a filesystem that refuses symlinks has nothing to test here
    }
    const renamed = await rename(["link", "data"], "data-copy");
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).code).toBe("protected_container");
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_ROOT, "data-copy"))).toBe(false);

    const removed = await remove(["link", "data"]);
    expect(removed.status).toBe(400);
    expect(fs.existsSync(path.join(DATA_DIR, "config.json"))).toBe(true);
  });

  it("still renames and deletes an ordinary sibling of the data dir", async () => {
    // The rule is about the containers, not about the name `data`.
    await fsp.mkdir(path.join(TEST_ROOT, "data-backup"));
    await fsp.writeFile(path.join(TEST_ROOT, "data-backup", "notes.txt"), "mine");
    const renamed = await rename(["data-backup"], "data-archive");
    expect(renamed.status).toBe(200);
    expect(fs.existsSync(path.join(TEST_ROOT, "data-archive", "notes.txt"))).toBe(true);

    const removed = await remove(["data-archive"]);
    expect(removed.status).toBe(200);
    expect(fs.existsSync(path.join(TEST_ROOT, "data-archive"))).toBe(false);

    // …and a `.config-old` is not `.config`.
    await fsp.mkdir(path.join(TEST_ROOT, ".config-old"));
    expect((await remove([".config-old"])).status).toBe(200);
  });

  it("keeps the data dir listable and its public subtree downloadable", async () => {
    // Listability is exactly what the container rule must NOT touch: the
    // Files app reaches the webapps through it.
    const list = await filesList(createRequest("/setup-api/files?dir=data&hidden=1"));
    expect(list.status).toBe(200);
    const names = ((await list.json()).files as { name: string }[]).map((f) => f.name);
    expect(names).toContain("webapps");
    expect(names).not.toContain("config.json");

    const get = await filesPathGet(
      createRequest("/setup-api/files/data/webapps/demo/index.html"),
      createParams(["data", "webapps", "demo", "index.html"]),
    );
    expect(get.status).toBe(200);
    expect(new TextDecoder().decode(await get.arrayBuffer())).toBe("<p>public</p>");
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
