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

/** A text document, as the composer's own picker would offer it. */
const TEXT = Buffer.from("just some notes and nothing a viewer could render");

/**
 * Which harness this box runs, per test.
 *
 * `canAttachDocuments` is a property of the harness, and it is the whole point
 * of the gate under test: a document staged on a Hermes box is disk the agent
 * has no way to open, because `chat --image` is image-only and the path
 * resolver in `image_routing.py` matches picture extensions by design.
 */
let harness: "openclaw" | "hermes" = "openclaw";
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness,
}));

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

/**
 * The same body, but delivered in separate chunks with a gap between them.
 *
 * A single-buffer body hands busboy everything at once, which hides the
 * ordering that matters here: a real connection delivers a multipart request
 * over several reads, so a rejection can land while parts are still arriving.
 */
function chunkedRequest(chunks: Buffer[]): NextRequest {
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      controller.close();
    },
  });
  return new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** `n` form fields, as their own chunk. */
function fieldParts(n: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nv${i}\r\n`,
    ));
  }
  return Buffer.concat(parts);
}

/** A trailing file part plus the closing boundary, as its own chunk. */
function filePart(filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + "Content-Type: application/octet-stream\r\n\r\n",
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
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

/** What is staged right now, or `[]` when nothing ever created the directory. */
function staged(): string[] {
  return fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : [];
}

/**
 * Require the staging directory to be empty and to STAY empty for a window.
 *
 * Cleanup finishes after the response, so these assertions have to wait for
 * something. A fixed sleep is the wrong instrument twice over: too short and it
 * flakes on a loaded CI box, too long and every run pays for it.
 *
 * But "poll until empty" is worse than the sleep it replaces, because the
 * regressions these tests exist for stage the orphan file *after* the response
 * resolves -- so the first read is empty, a stop-on-empty poll returns
 * immediately, and the test passes while the orphan lands a moment later. It
 * would have gone green on the very bug it was written to catch.
 *
 * So: empty is necessary but not sufficient. The directory has to read empty
 * continuously for `settleMs`, and any file appearing inside that window resets
 * it. Clean runs still finish in about the settle time rather than the timeout.
 */
async function expectStagingDrains(timeoutMs = 5000, settleMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let listed = staged();
  let emptySince = listed.length ? null : Date.now();
  while (Date.now() < deadline) {
    if (emptySince !== null && Date.now() - emptySince >= settleMs) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    listed = staged();
    // A file appearing after an empty read is exactly the leak under test:
    // restart the window rather than accept the earlier reading.
    emptySince = listed.length ? null : (emptySince ?? Date.now());
  }
  expect(listed).toEqual([]);
}

/** `n` file parts, so a request can trip the one-file limit. */
function fileParts(n: number, content: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="f${i}.png"\r\n`
          + "Content-Type: application/octet-stream\r\n\r\n",
      ),
      content,
      Buffer.from("\r\n"),
    ]));
  }
  return Buffer.concat(parts);
}

/** Write a staged file directly and backdate it, to set up a retention sweep. */
function seedStaged(name: string, bytes: Buffer, ageMs: number): string {
  fs.mkdirSync(stagingDir(), { recursive: true });
  const full = path.join(stagingDir(), name);
  fs.writeFileSync(full, bytes);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(full, when, when);
  return full;
}

describe("/setup-api/chat/attachments", () => {
  beforeEach(async () => {
    harness = "openclaw";
    originalHome = process.env.HOME;
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-attach-"));
    openclawHome = path.join(tmpHome, ".openclaw");
    fs.mkdirSync(openclawHome, { recursive: true });
    // The route roots on OPENCLAW_HOME, read at module load — set it first.
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = openclawHome;
    // The Hermes staging root is <DATA_DIR>/chat-media, and DATA_DIR is read at
    // module load. Without this the Hermes cases below would stage into the
    // real /home/clawbox/clawbox/data on a device running the suite.
    process.env.CLAWBOX_ROOT = tmpHome;
    vi.resetModules();
    POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenclawHome;
    delete process.env.CLAWBOX_ROOT;
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
    expect(staged()).toEqual([]);
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
    expect(staged()).toEqual([]);
  });

  it("stages nothing after a rejection that arrives before the file does", async () => {
    // busboy's fields limit ends `field` events but not `file` ones. Rejecting
    // without tearing the parser down let the route answer 400 and then accept
    // the file anyway, leaving a staged file on the customer's disk that no
    // response ever named and nothing would come back for. Only reproducible
    // with a chunked body: in one buffer the `file` event lands early enough
    // for the catch to still see the path and clean up by luck.
    const res = await POST(chunkedRequest([fieldParts(9), filePart("orphan.png", PNG)]));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Too many form fields");
    await expectStagingDrains();
  });

  it("refuses a second file part rather than staging one of them", async () => {
    // busboy caps files at 1 by going quiet, so without the filesLimit handler
    // a two-file request looked like a perfectly ordinary one-file upload.
    const res = await POST(chunkedRequest([
      fileParts(2, PNG),
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ]));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Only one file per request");
    await expectStagingDrains();
  });

  it("refuses a request with more parts than the limit", async () => {
    // Parts are the cheapest thing to pile on: each one costs the sender almost
    // nothing and costs the parser real work.
    const res = await POST(chunkedRequest([
      fieldParts(20),
      filePart("late.png", PNG),
    ]));

    expect(res.status).toBe(400);
    // Fields and parts are both exceeded here; either rejection is the right
    // answer, and both have to leave the disk clean.
    expect((await res.json()).error).toMatch(/Too many (multipart parts|form fields)/);
    await expectStagingDrains();
  });

  it("reports a malformed part header as client input, not a server fault", async () => {
    // busboy raises "Malformed part header" on itself. Unclassified it reached
    // the catch as a plain Error and the caller was told 500 -- go and debug the
    // server -- for a request only they could fix.
    const body = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\n`
          + `Content-Disposition form-data; name="file"; filename="broken.png"\r\n\r\n`,
      ),
      PNG,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Malformed part header");
    await expectStagingDrains();
  });

  it("reports a body that ends early as client input, in both places busboy raises it", async () => {
    // The same client mistake surfaces on two different objects: with no file
    // part open busboy emits it, and mid-file the file's own stream does. Both
    // have to answer 400, so both paths are asserted here.
    const beforeFile = await POST(request(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhal`,
    )));
    expect(beforeFile.status).toBe(400);
    expect((await beforeFile.json()).error).toContain("Unexpected end of form");

    const midFile = await POST(request(Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="half.png"\r\n`
          + "Content-Type: application/octet-stream\r\n\r\n",
      ),
      PNG,
    ])));
    expect(midFile.status).toBe(400);
    expect((await midFile.json()).error).toContain("Unexpected end of form");
    await expectStagingDrains();
  });

  it("keeps a genuine server fault a 500 while parser faults become 400", async () => {
    // The classifier must not swallow everything: a dead connection is ours to
    // report, and the two cases arrive through the very same handlers.
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="gone.bin"\r\n`
            + "Content-Type: application/octet-stream\r\n\r\n",
        )));
        controller.enqueue(new Uint8Array(Buffer.alloc(512, 3)));
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error("client went away"));
      },
    });
    const res = await POST(new NextRequest("http://localhost/setup-api/chat/attachments", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      body,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("client went away");
  }, 10000);

  it("drops staged files past the retention age when the next upload arrives", async () => {
    // Nothing else ever removes one of these, so without a sweep the directory
    // only grows -- on a box whose disk also holds openclaw.json and the keys.
    const stale = seedStaged("stale.png", PNG, 8 * 24 * 60 * 60 * 1000);
    const fresh = seedStaged("fresh.png", PNG, 2 * 60 * 1000);

    const res = await POST(request(multipart("new.png", PNG)));
    expect(res.status).toBe(200);

    expect(fs.existsSync(stale)).toBe(false);
    // Inside the window: a week-old file goes, yesterday's stays.
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync((await res.json()).path)).toBe(true);
  });

  it("evicts the oldest staged files once the directory is over its size cap", async () => {
    // 500 MB of real bytes would make the suite unusable, so the cap is reached
    // with sparse files: the size the sweep reads is the apparent one.
    const big = (name: string, ageMs: number) => {
      const full = seedStaged(name, Buffer.alloc(0), ageMs);
      fs.truncateSync(full, 200 * 1024 * 1024);
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(full, when, when);
      return full;
    };
    const oldest = big("oldest.bin", 6 * 60 * 60 * 1000);
    const middle = big("middle.bin", 3 * 60 * 60 * 1000);
    const newest = big("newest.bin", 2 * 60 * 60 * 1000);

    const res = await POST(request(multipart("new.png", PNG)));
    expect(res.status).toBe(200);

    // 600 MB against a 500 MB cap: exactly one eviction, and it is the oldest.
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it("never sweeps a file young enough to still be arriving", async () => {
    // A concurrent upload's file is the newest thing in the directory and, once
    // the cap is exceeded, deleting it would hand that request's composer back
    // a path with nothing at it.
    const inFlight = seedStaged("in-flight.bin", Buffer.alloc(0), 0);
    fs.truncateSync(inFlight, 600 * 1024 * 1024);

    const res = await POST(request(multipart("new.png", PNG)));
    expect(res.status).toBe(200);
    expect(fs.existsSync(inFlight)).toBe(true);
  });

  it("stages the upload even when the retention sweep cannot read the directory", async () => {
    // Retention is a housekeeping side effect. If it ever became load-bearing,
    // a permission problem in it would start failing good uploads.
    const spy = vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(new Error("EACCES"));
    const res = await POST(request(multipart("shapes.png", PNG)));
    expect(res.status).toBe(200);
    // Without this the test would still pass if the sweep stopped running at
    // all: a route that never reads the directory cannot fail on a read.
    expect(spy).toHaveBeenCalled();
    expect(fs.existsSync((await res.json()).path)).toBe(true);
    spy.mockRestore();
  });

  it("answers, and cleans up, when the connection dies mid-file", async () => {
    // A source error used to leave busboy and the file stream alive, so the
    // write never settled and the awaited cleanup never returned: the route
    // produced no response at all. The race below fails the test rather than
    // hanging the suite.
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="half.bin"\r\n`
            + "Content-Type: application/octet-stream\r\n\r\n",
        )));
        controller.enqueue(new Uint8Array(Buffer.alloc(1024, 7)));
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error("client went away"));
      },
    });
    const req = new NextRequest("http://localhost/setup-api/chat/attachments", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      body,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

    const res = await Promise.race([
      POST(req),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("route never answered")), 4000)),
    ]);

    // Their connection broke, not their request: this is ours to report as 500.
    expect(res.status).toBe(500);
    await expectStagingDrains();
  }, 10000);

  // -- What this box can be handed ------------------------------------------
  //
  // The composer refuses these first (`partitionAttachments`), and that is the
  // better place to refuse them: nothing is uploaded and the reason can be
  // shown next to the file. This is the second gate, for a request that did not
  // come from that composer -- reachable, and verified so: a text/plain
  // document POSTed to a Hermes box was answered 200 and staged.

  /** Everything staged under the Hermes root, or [] when it was never made. */
  function hermesStaged(): string[] {
    const dir = path.join(tmpHome, "data", "chat-media", "chat-attachments");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it("refuses a document on a harness that has no way to open one", async () => {
    harness = "hermes";
    const res = await POST(request(multipart("notes.txt", TEXT)));
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/only attach images/i);
    // Refused before the write stream is opened: nothing lands on the disk.
    expect(hermesStaged()).toEqual([]);
  });

  it("takes the same document where the agent can open it", async () => {
    // The gate is per-harness, not a new blanket rule. OpenClaw reads documents
    // and must be unaffected.
    harness = "openclaw";
    const res = await POST(request(multipart("notes.txt", TEXT)));
    expect(res.status).toBe(200);
    expect(staged()).toHaveLength(1);
  });

  it("still takes a picture on the box that refused the document", async () => {
    harness = "hermes";
    const res = await POST(request(multipart("shapes.png", PNG)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("shapes.png");
    expect(fs.readFileSync(body.path)).toEqual(PNG);
  });

  it("is not fooled by a document wearing a picture's extension", async () => {
    // The name check is what decides whether the agent's resolver would pick
    // the file up, and a rename passes it. The client's MIME label is not
    // consulted anywhere in this decision -- it is a header on a request that
    // has already shown it did not come from our composer. Only the bytes say
    // what the file is.
    harness = "hermes";
    const res = await POST(request(multipart("invoice.png", TEXT)));
    expect(res.status).toBe(415);
    // The bytes had to be written before they could be read, so the point here
    // is that nothing is LEFT behind.
    await expectStagingDrains();
    expect(hermesStaged()).toEqual([]);
  });
});
