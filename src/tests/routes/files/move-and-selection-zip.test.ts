/**
 * The Files app's multi-select, at the HTTP boundary:
 *
 *  - POST /setup-api/files?dir=<dest> `{ action: "move", paths, conflict }`
 *    (TASK-1274) — moves a selection into a folder, refuses a folder into
 *    itself and a protected container, asks about names the destination holds
 *    BEFORE moving anything, and carries Projects pins along;
 *  - POST `{ action: "zip", paths }` then GET `?zip=<ticket>` (TASK-1273) — a
 *    selection downloaded as one ZIP, judged again when its bytes are read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_ROOT = fs.realpathSync(os.tmpdir()) + `/clawbox-files-move-${process.pid}-${Date.now()}`;

type Route = typeof import("@/app/setup-api/files/route");
type PathRoute = typeof import("@/app/setup-api/files/[...path]/route");
type Pins = typeof import("@/lib/project-folders");
let POST: Route["POST"];
let GET: Route["GET"];
let RENAME: PathRoute["PUT"];
let pins: Pins;

const at = (...p: string[]) => path.join(TEST_ROOT, ...p);
const post = (dir: string, body: unknown) =>
  POST(new NextRequest(new URL(`http://localhost/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const move = (dir: string, paths: string[], conflict?: string) => post(dir, { action: "move", paths, ...(conflict ? { conflict } : {}) });

/** The names in a ZIP's central directory, in order. */
function zipNames(buf: Buffer): string[] {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function reset() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(at("Documents", "Reports"), { recursive: true });
  fs.mkdirSync(at("Downloads"), { recursive: true });
  fs.mkdirSync(at("projects", "site", "src"), { recursive: true });
  fs.mkdirSync(at("data"), { recursive: true });
  fs.writeFileSync(at("Downloads", "a.txt"), "alpha");
  fs.writeFileSync(at("Downloads", "b.txt"), "bravo");
  fs.writeFileSync(at("Downloads", "report.pdf"), "pdf-new");
  fs.writeFileSync(at("Documents", "report.pdf"), "pdf-old");
  fs.writeFileSync(at("projects", "site", "src", "app.js"), "console.log(1)\n");
  fs.mkdirSync(at(".ssh"));
  fs.writeFileSync(at(".ssh", "id_rsa"), "key");
}

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  reset();
  vi.resetModules();
  ({ POST, GET } = await import("@/app/setup-api/files/route"));
  ({ PUT: RENAME } = await import("@/app/setup-api/files/[...path]/route"));
  pins = await import("@/lib/project-folders");
});

beforeEach(() => reset());

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
});

describe("POST { action: move }", () => {
  it("moves a selection of files into a folder and reports each one", async () => {
    const res = await move("Documents", ["Downloads/a.txt", "Downloads/b.txt"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      moved: [
        { from: "Downloads/a.txt", to: "Documents/a.txt", name: "a.txt" },
        { from: "Downloads/b.txt", to: "Documents/b.txt", name: "b.txt" },
      ],
      skipped: [],
      failed: [],
    });
    expect(fs.readFileSync(at("Documents", "a.txt"), "utf8")).toBe("alpha");
    expect(fs.existsSync(at("Downloads", "a.txt"))).toBe(false);
  });

  it("moves a folder with everything in it", async () => {
    const res = await move("Documents", ["projects/site"]);
    expect(res.status).toBe(200);
    expect(fs.readFileSync(at("Documents", "site", "src", "app.js"), "utf8")).toBe("console.log(1)\n");
    expect(fs.existsSync(at("projects", "site"))).toBe(false);
  });

  it("refuses a folder into itself or one of its subfolders, and moves nothing", async () => {
    for (const dest of ["projects/site", "projects/site/src"]) {
      const res = await move(dest, ["projects/site", "Downloads/a.txt"]);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "into_itself", path: "projects/site" });
    }
    expect(fs.existsSync(at("projects", "site", "src", "app.js"))).toBe(true);
    expect(fs.existsSync(at("Downloads", "a.txt"))).toBe(true);
  });

  it("refuses a folder moved through a link into its own subtree", async () => {
    fs.symlinkSync(at("projects", "site", "src"), at("Documents", "into-site"));
    const res = await move("Documents/into-site", ["projects/site"]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("into_itself");
    expect(fs.existsSync(at("projects", "site", "src", "app.js"))).toBe(true);
  });

  it("asks about a name the destination already holds before moving anything", async () => {
    const res = await move("Documents", ["Downloads/a.txt", "Downloads/report.pdf"]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "conflict",
      conflicts: [{ path: "Downloads/report.pdf", name: "report.pdf" }],
    });
    // The batch was refused whole: a.txt did not go either.
    expect(fs.existsSync(at("Downloads", "a.txt"))).toBe(true);
    expect(fs.readFileSync(at("Documents", "report.pdf"), "utf8")).toBe("pdf-old");
  });

  it("keeps both on `rename`: the moved copy takes a number, the one that was there is untouched", async () => {
    const res = await move("Documents", ["Downloads/a.txt", "Downloads/report.pdf"], "rename");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toEqual([
      { from: "Downloads/a.txt", to: "Documents/a.txt", name: "a.txt" },
      { from: "Downloads/report.pdf", to: "Documents/report (2).pdf", name: "report (2).pdf" },
    ]);
    expect(fs.readFileSync(at("Documents", "report.pdf"), "utf8")).toBe("pdf-old");
    expect(fs.readFileSync(at("Documents", "report (2).pdf"), "utf8")).toBe("pdf-new");
  });

  it("leaves the clashing item where it is on `skip` and moves the rest", async () => {
    const res = await move("Documents", ["Downloads/a.txt", "Downloads/report.pdf"], "skip");
    const body = await res.json();
    expect(body.moved.map((m: { name: string }) => m.name)).toEqual(["a.txt"]);
    expect(body.skipped).toEqual([{ path: "Downloads/report.pdf", reason: "exists" }]);
    expect(fs.readFileSync(at("Downloads", "report.pdf"), "utf8")).toBe("pdf-new");
    expect(fs.readFileSync(at("Documents", "report.pdf"), "utf8")).toBe("pdf-old");
  });

  it("treats two selected items of one name as a clash with each other", async () => {
    fs.writeFileSync(at("Documents", "Reports", "a.txt"), "other alpha");
    const res = await move("projects", ["Downloads/a.txt", "Documents/Reports/a.txt"]);
    expect(res.status).toBe(409);
    expect((await res.json()).conflicts).toEqual([{ path: "Documents/Reports/a.txt", name: "a.txt" }]);
    const renamed = await (await move("projects", ["Downloads/a.txt", "Documents/Reports/a.txt"], "rename")).json();
    expect(renamed.moved.map((m: { name: string }) => m.name)).toEqual(["a.txt", "a (2).txt"]);
  });

  it("skips an item that is already in the destination rather than calling it a clash", async () => {
    const res = await move("Downloads", ["Downloads/a.txt"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ moved: [], skipped: [{ path: "Downloads/a.txt", reason: "same_folder" }] });
  });

  it("refuses the box's own containers, secret stores and paths outside the root", async () => {
    expect((await (await move("Documents", ["data"])).json()).code).toBe("protected_container");
    expect((await move("Documents", [""])).status).toBe(400);
    expect((await (await move("Documents", [".ssh/id_rsa"])).json()).code).toBe("invalid_path");
    expect((await (await move("Documents", ["../../etc/passwd"])).json()).code).toBe("invalid_path");
    // Into a secret store: the route's own `safePath` turns the destination away.
    expect((await move(".ssh", ["Downloads/a.txt"])).status).toBe(400);
    expect((await move("../outside", ["Downloads/a.txt"])).status).toBe(400);
    expect(fs.existsSync(at("Downloads", "a.txt"))).toBe(true);
  });

  it("answers 404 for a destination or an item that is not there, and 400 for a destination that is a file", async () => {
    expect((await move("Nope", ["Downloads/a.txt"])).status).toBe(404);
    expect((await move("Documents", ["Downloads/ghost.txt"])).status).toBe(404);
    const res = await move("Downloads/b.txt", ["Downloads/a.txt"]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("not_directory");
  });

  it("refuses a body that names no items", async () => {
    for (const paths of [undefined, [], "Downloads/a.txt", [1, 2], [""]]) {
      const res = await post("Documents", { action: "move", paths });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
  });

  it("carries a Projects pin along with the folder it names, and pins inside it too", async () => {
    await pins.addProjectFolder("projects/site");
    await pins.addProjectFolder("projects/site/src");
    const res = await move("Documents", ["projects/site"]);
    expect(res.status).toBe(200);
    expect((await pins.listProjectFolders()).map((f) => f.path)).toEqual(["Documents/site", "Documents/site/src"]);
  });

  it("carries a pin through a rename too", async () => {
    await pins.addProjectFolder("projects/site");
    const res = await RENAME(
      new NextRequest(new URL("http://localhost/setup-api/files/projects/site"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newName: "website" }),
      }),
      { params: Promise.resolve({ path: ["projects", "site"] }) },
    );
    expect(res.status).toBe(200);
    expect((await pins.listProjectFolders()).map((f) => f.path)).toEqual(["projects/website"]);
  });
});

describe("a selection as one ZIP", () => {
  it("answers what the archive would hold and a ticket, then streams it", async () => {
    const res = await post("Downloads", { action: "zip", paths: ["Downloads/a.txt", "projects/site"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Downloads-selection.zip", files: 2, tooMany: false });
    expect(body.ticket).toMatch(/^[0-9a-f]{32}$/);

    const zip = await GET(new NextRequest(new URL(`http://localhost/setup-api/files?zip=${body.ticket}`)));
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toContain('filename="Downloads-selection.zip"');
    expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual(["a.txt", "site/", "site/src/", "site/src/app.js"]);
  });

  it("gives two items of one name different names inside the archive", async () => {
    fs.writeFileSync(at("Documents", "Reports", "a.txt"), "other");
    const body = await (await post("", { action: "zip", paths: ["Downloads/a.txt", "Documents/Reports/a.txt"] })).json();
    expect(body.name).toBe("selection.zip");
    const zip = await GET(new NextRequest(new URL(`http://localhost/setup-api/files?zip=${body.ticket}`)));
    expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual(["a.txt", "a (2).txt"]);
  });

  it("re-judges the items when the archive is read: one gone since is left out, not an error", async () => {
    const body = await (await post("Downloads", { action: "zip", paths: ["Downloads/a.txt", "Downloads/b.txt"] })).json();
    fs.unlinkSync(at("Downloads", "b.txt"));
    const zip = await GET(new NextRequest(new URL(`http://localhost/setup-api/files?zip=${body.ticket}`)));
    expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual(["a.txt"]);
  });

  it("refuses a protected, missing or outside item before issuing a ticket", async () => {
    expect((await post("", { action: "zip", paths: [".ssh"] })).status).toBe(400);
    expect((await post("", { action: "zip", paths: ["../etc"] })).status).toBe(400);
    expect((await post("", { action: "zip", paths: [""] })).status).toBe(400);
    expect((await post("", { action: "zip", paths: ["Downloads/ghost.txt"] })).status).toBe(404);
  });

  it("answers 404 zip_expired for a ticket it never issued", async () => {
    for (const ticket of ["0123456789abcdef0123456789abcdef", "not-a-ticket", ""]) {
      const res = await GET(new NextRequest(new URL(`http://localhost/setup-api/files?zip=${ticket}`)));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("zip_expired");
    }
  });
});
