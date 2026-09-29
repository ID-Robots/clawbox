/**
 * GET /setup-api/files/<folder>?zip=1 — a folder downloaded as one ZIP, and
 * `&check=1`, what the Files app asks before it starts one. The archive's
 * bytes are pinned in src/tests/unit/zip-stream.test.ts; this holds the HTTP
 * half: the headers a browser saves by, the guard at the door, the answers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_ROOT = fs.realpathSync(os.tmpdir()) + `/clawbox-files-zip-${process.pid}-${Date.now()}`;

type Route = typeof import("@/app/setup-api/files/[...path]/route");
let GET: Route["GET"];

const get = (segments: string[], query = "") =>
  GET(
    new NextRequest(new URL(`http://localhost/setup-api/files/${segments.map(encodeURIComponent).join("/")}${query}`)),
    { params: Promise.resolve({ path: segments }) },
  );

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  fs.mkdirSync(path.join(TEST_ROOT, "Mein Projekt", "src"), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, "Mein Projekt", "src", "main.py"), "print('hallo')\n");
  fs.writeFileSync(path.join(TEST_ROOT, "Mein Projekt", "notes.md"), "# notes\n");
  fs.mkdirSync(path.join(TEST_ROOT, ".ssh"));
  fs.writeFileSync(path.join(TEST_ROOT, ".ssh", "id_rsa"), "key");
  vi.resetModules();
  ({ GET } = await import("@/app/setup-api/files/[...path]/route"));
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
});

describe("GET /setup-api/files/<folder>?zip=1", () => {
  it("streams the folder as an attachment named after it", async () => {
    const res = await get(["Mein Projekt"], "?zip=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Mein Projekt.zip"; filename*=UTF-8''${encodeURIComponent("Mein Projekt.zip")}`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
    expect(body.subarray(30, 30 + "Mein Projekt/".length).toString()).toBe("Mein Projekt/");
    expect(body.readUInt32LE(body.length - 22)).toBe(0x06054b50);
    expect(body.readUInt16LE(body.length - 22 + 10)).toBe(4);
  });

  it("answers `&check=1` with what the archive would hold, not the archive", async () => {
    const res = await get(["Mein Projekt"], "?zip=1&check=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Mein Projekt.zip",
      entries: 4,
      files: 2,
      bytes: "print('hallo')\n".length + "# notes\n".length,
      tooMany: false,
      limit: 100_000,
    });
  });

  it("refuses a credential store at the door, like every other download", async () => {
    const res = await get([".ssh"], "?zip=1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid path");
  });

  it("still says a folder is a folder without ?zip=1, and serves a FILE as itself with it", async () => {
    const dir = await get(["Mein Projekt"]);
    expect(dir.status).toBe(400);
    expect(await dir.json()).toEqual({ error: "Is a directory", code: "is_directory" });
    const file = await get(["Mein Projekt", "notes.md"], "?zip=1");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("# notes\n");
  });

  it("answers 404 for a folder that is not there", async () => {
    expect((await get(["nope"], "?zip=1")).status).toBe(404);
  });
});

describe("GET ?zip=1&check=1 past the entry cap", () => {
  it("answers 413 too_many_entries, so the Files app can say so before a download starts", async () => {
    vi.resetModules();
    vi.doMock("@/lib/zip-stream", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/lib/zip-stream")>();
      return { ...real, summarizeFolderForZip: (abs: string) => real.summarizeFolderForZip(abs, 2) };
    });
    try {
      const { GET: capped } = await import("@/app/setup-api/files/[...path]/route");
      const res = await capped(
        new NextRequest(new URL("http://localhost/setup-api/files/x?zip=1&check=1")),
        { params: Promise.resolve({ path: ["Mein Projekt"] }) },
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: "too_many_entries", tooMany: true, limit: 2 });
    } finally {
      vi.doUnmock("@/lib/zip-stream");
    }
  });
});
