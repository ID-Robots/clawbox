import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// POST /setup-api/chat/attachments with a FOLDER's files (TASK-1276).
//
// A folder dropped on the chat composer is staged one file per request, each
// carrying `batch` (one id for the drop) and `relativePath` (its place in the
// folder) ahead of the file part. The files land under `<staging>/<batch>/`
// with the folder's structure rebuilt, and the answer's `root` is the folder
// as staged — the one path the turn names. The per-segment name rule is the
// loose file's, so no segment climbs out, hides, or carries a separator.

let harness: "openclaw" | "hermes" = "openclaw";
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness,
}));

const BOUNDARY = "----clawboxfolderboundary";
const BATCH = "0123456789abcdef0123456789abcdef";

let tmpHome: string;
let openclawHome: string;
let POST: (req: NextRequest) => Promise<Response>;
const saved: Record<string, string | undefined> = {};

/** A multipart body: text fields first (in order), then the file part. */
function body(fields: Array<[string, string]>, filename: string, content: Buffer, fieldsAfter: Array<[string, string]> = []): Buffer {
  const field = ([name, value]: [string, string]) =>
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return Buffer.concat([
    ...fields.map(field),
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + "Content-Type: application/octet-stream\r\n\r\n",
    ),
    content,
    Buffer.from("\r\n"),
    ...fieldsAfter.map(field),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

function request(buf: Buffer): NextRequest {
  return new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Uint8Array(buf),
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const stage = (relativePath: string, content = "x", batch = BATCH) =>
  POST(request(body([["batch", batch], ["relativePath", relativePath]], path.basename(relativePath), Buffer.from(content))));

const stagingDir = () => path.join(openclawHome, "media", "chat-attachments");

describe("/setup-api/chat/attachments — a dropped folder", () => {
  beforeEach(async () => {
    harness = "openclaw";
    for (const k of ["HOME", "OPENCLAW_HOME", "CLAWBOX_ROOT"]) saved[k] = process.env[k];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-attach-folder-"));
    openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    process.env.CLAWBOX_ROOT = tmpHome;
    vi.resetModules();
    POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rebuilds the folder under the batch and answers its root", async () => {
    const first = await stage("site/index.html", "<h1>hi</h1>");
    expect(first.status).toBe(200);
    const a = await first.json();
    const root = path.join(fs.realpathSync(stagingDir()), BATCH, "site");
    expect(a).toEqual({ ok: true, name: "index.html", path: path.join(root, "index.html"), root });

    const second = await (await stage("site/src/app.js", "console.log(1)")).json();
    expect(second.root).toBe(root);
    expect(fs.readFileSync(path.join(root, "src", "app.js"), "utf8")).toBe("console.log(1)");
    expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("keeps the file's own name rather than a uuid-prefixed one", async () => {
    const res = await (await stage("notes/README.md")).json();
    expect(path.basename(res.path)).toBe("README.md");
  });

  it("never lets a segment climb out, hide, or smuggle a separator", async () => {
    // `..` has nothing usable left after the leading dots go, so it is refused.
    expect((await stage("site/../../escape.txt")).status).toBe(400);
    expect((await stage("../escape.txt")).status).toBe(400);
    // A backslash is removed rather than kept as a separator; a leading dot is dropped.
    const res = await (await stage("site/.hidden/a\\b.txt")).json();
    const root = path.join(fs.realpathSync(stagingDir()), BATCH, "site");
    expect(res.path).toBe(path.join(root, "hidden", "ab.txt"));
    expect(fs.readdirSync(path.join(tmpHome))).not.toContain("escape.txt");
  });

  it("refuses a malformed batch, and a relative path without one", async () => {
    for (const batch of ["../x", "short", "has space in it", "a/b/c/d/e/f/g/h"]) {
      expect((await stage("site/a.txt", "x", batch)).status).toBe(400);
    }
    const res = await POST(request(body([["relativePath", "site/a.txt"]], "a.txt", Buffer.from("x"))));
    expect(res.status).toBe(400);
  });

  it("refuses a folder deeper than a drop may be", async () => {
    const deep = `${Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")}/a.txt`;
    expect((await stage(deep)).status).toBe(400);
  });

  it("ignores fields that trail the file part — they cannot re-route bytes already written", async () => {
    const res = await POST(request(body([], "loose.txt", Buffer.from("x"), [["batch", BATCH], ["relativePath", "site/elsewhere.txt"]])));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.root).toBeUndefined();
    expect(path.dirname(json.path)).toBe(fs.realpathSync(stagingDir()));
  });

  it("answers 409 for the same relative path twice, and keeps the first copy", async () => {
    await stage("site/a.txt", "first");
    const again = await stage("site/a.txt", "second");
    expect(again.status).toBe(409);
    expect(fs.readFileSync(path.join(fs.realpathSync(stagingDir()), BATCH, "site", "a.txt"), "utf8")).toBe("first");
  });

  it("still refuses a document inside a folder on a pictures-only box", async () => {
    harness = "hermes";
    vi.resetModules();
    POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
    expect((await stage("site/notes.txt")).status).toBe(415);
  });
});
