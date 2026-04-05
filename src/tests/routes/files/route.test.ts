import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-files-tests-${process.pid}-${Date.now()}`);

type RouteHandler = (req: NextRequest) => Promise<Response>;

let filesGet: RouteHandler;
let filesPost: RouteHandler;

/**
 * Build a NextRequest whose `.body` is a proper ReadableStream of multipart
 * form-data that busboy can parse.  `Readable.fromWeb` in the route will
 * convert it back to a Node stream.
 */
function createMultipartRequest(
  pathname: string,
  files: Array<{ fieldName: string; fileName: string; content: Buffer | string }>,
): NextRequest {
  const boundary = "----TestBoundary" + Date.now();
  const parts: Buffer[] = [];

  for (const { fieldName, fileName, content } of files) {
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    parts.push(Buffer.from(header));
    parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return new NextRequest(new URL(`http://localhost${pathname}`), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
}

/**
 * Create a multipart request with no file parts (just the closing boundary).
 */
function createEmptyMultipartRequest(pathname: string): NextRequest {
  const boundary = "----TestBoundary" + Date.now();
  const body = Buffer.from(`--${boundary}--\r\n`);

  return new NextRequest(new URL(`http://localhost${pathname}`), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
}

function createRequest(pathname: string, options?: RequestInit): NextRequest {
  return new NextRequest(new URL(`http://localhost${pathname}`), options);
}

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  await fsp.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  ({ GET: filesGet, POST: filesPost } = await import("@/app/setup-api/files/route"));
});

beforeEach(async () => {
  // Clean and recreate test directory
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  await fsp.mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  delete process.env.FILES_ROOT;
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("GET /setup-api/files", () => {
  it("lists files in root directory", async () => {
    // Create test files
    fs.writeFileSync(path.join(TEST_ROOT, "file1.txt"), "content1");
    fs.writeFileSync(path.join(TEST_ROOT, "file2.txt"), "content2");

    const req = createRequest("/setup-api/files");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files).toBeDefined();
    expect(body.files.length).toBe(2);

    const names = body.files.map((f: { name: string }) => f.name);
    expect(names).toContain("file1.txt");
    expect(names).toContain("file2.txt");
  });

  it("lists files in subdirectory", async () => {
    const subdir = path.join(TEST_ROOT, "subdir");
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, "nested.txt"), "nested content");

    const req = createRequest("/setup-api/files?dir=subdir");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe("nested.txt");
    expect(body.files[0].type).toBe("file");
  });

  it("returns file metadata", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "test.txt"), "hello world");

    const req = createRequest("/setup-api/files");
    const res = await filesGet(req);
    const body = await res.json();

    const file = body.files[0];
    expect(file.name).toBe("test.txt");
    expect(file.type).toBe("file");
    expect(file.size).toBe(11); // "hello world".length
    expect(file.modified).toBeDefined();
  });

  it("identifies directories correctly", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "mydir"));

    const req = createRequest("/setup-api/files");
    const res = await filesGet(req);
    const body = await res.json();

    const dir = body.files[0];
    expect(dir.name).toBe("mydir");
    expect(dir.type).toBe("directory");
    expect(dir.size).toBeNull();
  });

  it("rejects path traversal attempts", async () => {
    const req = createRequest("/setup-api/files?dir=../../../etc");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid path");
  });

  it("returns 404 for non-existent directory", async () => {
    const req = createRequest("/setup-api/files?dir=nonexistent");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Directory not found");
  });

  it("returns 400 when path is a file", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "afile.txt"), "content");

    const req = createRequest("/setup-api/files?dir=afile.txt");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Not a directory");
  });

  it("auto-creates base directory if missing", async () => {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });

    const req = createRequest("/setup-api/files");
    const res = await filesGet(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files).toEqual([]);
    expect(fs.existsSync(TEST_ROOT)).toBe(true);
  });
});

describe("POST /setup-api/files", () => {
  describe("mkdir action", () => {
    it("creates a new directory", async () => {
      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "newdir" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(fs.existsSync(path.join(TEST_ROOT, "newdir"))).toBe(true);
    });

    it("creates nested directory", async () => {
      fs.mkdirSync(path.join(TEST_ROOT, "parent"));

      const req = createRequest("/setup-api/files?dir=parent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "child" }),
      });

      const res = await filesPost(req);
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_ROOT, "parent", "child"))).toBe(true);
    });

    it("returns 400 when name is missing", async () => {
      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Name required");
    });

    it("returns 409 when directory already exists", async () => {
      fs.mkdirSync(path.join(TEST_ROOT, "existing"));

      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "existing" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toBe("Already exists");
    });

    it("rejects path traversal in name", async () => {
      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "../outside" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid name");
    });
  });

  describe("file upload", () => {
    it("uploads a file", async () => {
      const req = createMultipartRequest("/setup-api/files", [
        { fieldName: "file", fileName: "uploaded.txt", content: "file content" },
      ]);

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.name).toBe("uploaded.txt");

      // The route resolves on busboy "finish" which may fire before the
      // write stream has flushed all data to disk. Wait briefly for I/O.
      const filePath = path.join(TEST_ROOT, "uploaded.txt");
      await vi.waitFor(() => {
        expect(fs.readFileSync(filePath, "utf-8")).toBe("file content");
      }, { timeout: 2000, interval: 50 });
    });

    it("uploads file to subdirectory", async () => {
      fs.mkdirSync(path.join(TEST_ROOT, "uploads"));

      const req = createMultipartRequest("/setup-api/files?dir=uploads", [
        { fieldName: "file", fileName: "doc.pdf", content: "data" },
      ]);

      const res = await filesPost(req);
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_ROOT, "uploads", "doc.pdf"))).toBe(true);
    });

    it("returns ok with empty name when no file provided", async () => {
      // No file parts — busboy will emit finish without any file event
      const req = createEmptyMultipartRequest("/setup-api/files");

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.name).toBe("");
    });

    it("creates directory if it doesn't exist", async () => {
      const req = createMultipartRequest("/setup-api/files?dir=newparent", [
        { fieldName: "file", fileName: "test.txt", content: "test" },
      ]);

      const res = await filesPost(req);
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(TEST_ROOT, "newparent", "test.txt"))).toBe(true);
    });
  });

  describe("unknown action", () => {
    it("returns 400 for unknown action", async () => {
      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unknown" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Unknown action");
    });

    it("returns 400 for empty body", async () => {
      const req = createRequest("/setup-api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Unknown action");
    });
  });

  describe("path validation", () => {
    it("rejects path traversal in dir parameter", async () => {
      const req = createRequest("/setup-api/files?dir=../../etc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "test" }),
      });

      const res = await filesPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid path");
    });
  });
});
