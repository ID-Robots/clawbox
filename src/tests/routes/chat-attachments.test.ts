import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// POST /setup-api/chat/attachments — where a file attached in device chat is
// staged so the agent can open it.
//
// The composer names the returned absolute path in the message, and OpenClaw
// only reads media from a fixed root allowlist. $HOME/uploads (where the Files
// API writes) is not on it, so the `image` tool answered "Local media path is
// not under an allowed directory" and the assistant told the user it could not
// see the picture. TASK-417. `<stateDir>/media` IS on that allowlist, and this
// route is what puts the file there.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpHome: string;
let openclawHome: string;
let originalHome: string | undefined;
let originalOpenclawHome: string | undefined;
let POST: (req: NextRequest) => Promise<Response>;

const BOUNDARY = "----clawboxtestboundary";

/** A multipart body with one `file` part, built by hand so the bytes are exact. */
function multipart(filename: string, content: Buffer): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return Buffer.concat([head, content, tail]);
}

function request(body: Buffer, contentType = `multipart/form-data; boundary=${BOUNDARY}`): NextRequest {
  return new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(body),
    // Node's fetch Request requires `duplex` for a body stream; it is not in
    // the DOM RequestInit type, hence the cast.
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** The directory OpenClaw's allowlist covers: `<stateDir>/media`. */
function stagingDir(): string {
  return path.join(openclawHome, "media", "chat-attachments");
}

describe("/setup-api/chat/attachments", () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-attach-"));
    openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    // The route roots on OPENCLAW_HOME, read at module load — set it first.
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    vi.resetModules();
    POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenclawHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes the file under <stateDir>/media, which OpenClaw will read", async () => {
    const res = await POST(request(multipart("shapes.png", PNG)));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.name).toBe("shapes.png");
    // The assertion that matters: the path handed to the agent is inside the
    // media root, not $HOME/uploads.
    expect(path.dirname(body.path)).toBe(stagingDir());
    expect(path.resolve(body.path).startsWith(path.join(openclawHome, "media") + path.sep)).toBe(true);
    // Storage name is server-generated; the client name survives as the label.
    expect(path.basename(body.path)).toMatch(/^[0-9a-f-]{36}-shapes\.png$/);
    expect(fs.readFileSync(body.path)).toEqual(PNG);
  });

  it("creates the staging directory on a box that has never used it", async () => {
    expect(fs.existsSync(stagingDir())).toBe(false);
    const res = await POST(request(multipart("first.png", PNG)));
    expect(res.status).toBe(200);
    expect(fs.existsSync(stagingDir())).toBe(true);
  });

  it("keeps a traversal filename inside the staging directory", async () => {
    const res = await POST(request(multipart("../../../etc/evil.png", PNG)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(path.dirname(body.path)).toBe(stagingDir());
    expect(path.basename(body.path)).toMatch(/-evil\.png$/);
    expect(fs.existsSync(path.join(tmpHome, "evil.png"))).toBe(false);
  });

  it("strips separators that survive basename, and refuses what is left of a dotfile", async () => {
    const ok = await POST(request(multipart("a/b\\c.png", PNG)));
    const okBody = await ok.json();
    expect(path.dirname(okBody.path)).toBe(stagingDir());
    expect(okBody.name).not.toContain("/");
    expect(okBody.name).not.toContain("\\");

    // "..." reduces to nothing once leading dots go — the route must reject
    // rather than invent a name for a file the client did not name.
    const bad = await POST(request(multipart("...", PNG)));
    expect(bad.status).toBe(400);
  });

  it("does not land an upload as a dotfile", async () => {
    const res = await POST(request(multipart(".bashrc", PNG)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("bashrc");
    expect(path.basename(body.path)).toMatch(/-bashrc$/);
  });

  it("rejects a multipart content-type with no boundary as client input", async () => {
    // busboy's constructor throws on it; unguarded that surfaces as a 500 for a
    // request the caller can fix.
    const res = await POST(request(multipart("shapes.png", PNG), "multipart/form-data"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("boundary");
  });

  it("rejects a non-multipart body", async () => {
    const res = await POST(request(Buffer.from("{}"), "application/json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("multipart");
  });

  it("rejects a multipart body with no file part", async () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`,
    );
    const res = await POST(request(body));
    expect(res.status).toBe(400);
  });

  it("never lets a second upload overwrite the first one's bytes", async () => {
    // Two screenshots both called screenshot.png. Deriving the path from the
    // client name alone would truncate the first, and an earlier chat message
    // still points at it.
    const first = await (await POST(request(multipart("screenshot.png", PNG)))).json();
    const other = Buffer.concat([PNG, Buffer.from("second")]);
    const second = await (await POST(request(multipart("screenshot.png", other)))).json();

    expect(first.path).not.toBe(second.path);
    expect(first.name).toBe("screenshot.png");
    expect(second.name).toBe("screenshot.png");
    expect(fs.readFileSync(first.path)).toEqual(PNG);
    expect(fs.readFileSync(second.path)).toEqual(other);
  });

  it("refuses a request larger than the total limit with 413", async () => {
    // Per-file and per-field limits leave the SUM unbounded; this is the guard
    // on what actually arrives.
    const huge = Buffer.alloc(27 * 1024 * 1024, 0x41);
    const res = await POST(request(multipart("huge.bin", huge)));
    expect(res.status).toBe(413);
    const listed = fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : [];
    expect(listed).toEqual([]);
  });

  it("reports a broken staging directory as a server error, not a client one", async () => {
    // A read-only filesystem is our problem, and it happens before the try
    // block that used to be the only error path.
    fs.writeFileSync(path.join(openclawHome, "media"), "not a directory");
    const res = await POST(request(multipart("shapes.png", PNG)));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("attachment directory");
  });

  it("leaves no partial file behind when the upload is rejected", async () => {
    await POST(request(multipart("...", PNG)));
    // The name never resolved, so nothing should have been created at all.
    const listed = fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : [];
    expect(listed).toEqual([]);
  });
});
