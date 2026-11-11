import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Whose chat a media file is (TASK-2435 review, CWE-639). On an organisation
 * box a member of staff is served, out of the shared media tree, only files
 * ClawBox wrote for THEIR chat: an upload they staged is theirs, another
 * member's is not, and naming its exact absolute path changes nothing. The
 * owner is served the tree as before. Pinned end to end through the real
 * staging route and the real media route, with only the session mocked.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn<(req?: Request) => Promise<{ username: string; isOwner: boolean } | null>>(async () => null),
}));
vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
// The organisation switch is on: a member is anyone signed in who is not the owner.
vi.mock("@/lib/org-mode-server", () => {
  const orgMemberOf = async (req: Request) => {
    const who = await h.who(req);
    return who && !who.isOwner ? { username: who.username } : null;
  };
  return { orgMemberOf, isOrgMemberRequest: async (req: Request) => (await orgMemberOf(req)) !== null };
});
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "openclaw",
}));

const BOUNDARY = "----clawboxownerboundary";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const OWNER: Who = { username: "clawbox", isOwner: true };
const ALICE: Who = { username: "alice", isOwner: false };
const BOB: Who = { username: "bob", isOwner: false };

let tmpHome: string;
let POST: (req: NextRequest) => Promise<Response>;
let GET: (req: NextRequest) => Promise<Response>;
let owners: typeof import("@/lib/chat-media-owners");
const saved: Record<string, string | undefined> = {};

function multipart(fields: Array<[string, string]>, filename: string, content: Buffer): Buffer {
  const field = ([name, value]: [string, string]) =>
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return Buffer.concat([
    ...fields.map(field),
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + "Content-Type: image/png\r\n\r\n",
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function upload(who: Who, filename: string, fields: Array<[string, string]> = []): Promise<Response> {
  h.who.mockResolvedValue(who);
  return POST(new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Uint8Array(multipart(fields, filename, PNG)),
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]));
}

async function read(who: Who, file: string): Promise<number> {
  h.who.mockResolvedValue(who);
  const url = new URL("http://localhost/setup-api/chat/media");
  url.searchParams.set("path", file);
  return (await GET(new NextRequest(url))).status;
}

const stagingDir = () => path.join(tmpHome, ".openclaw", "media", "chat-attachments");

beforeEach(async () => {
  for (const k of ["HOME", "OPENCLAW_HOME", "CLAWBOX_ROOT"]) saved[k] = process.env[k];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-media-owner-"));
  fs.mkdirSync(path.join(tmpHome, ".openclaw"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
  process.env.CLAWBOX_ROOT = tmpHome;
  vi.resetModules();
  POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
  GET = (await import("@/app/setup-api/chat/media/route")).GET;
  owners = await import("@/lib/chat-media-owners");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("a member's upload is theirs alone", () => {
  it("is served back to its member, refused to another member by absolute path, and served to the owner", async () => {
    const res = await upload(ALICE, "payslip.png");
    expect(res.status).toBe(200);
    const { path: staged } = (await res.json()) as { path: string };
    expect(path.isAbsolute(staged)).toBe(true);

    expect(await read(ALICE, staged)).toBe(200);
    expect(await read(BOB, staged)).toBe(404);
    expect(await read(OWNER, staged)).toBe(200);
  });

  it("does not make the owner's own upload readable to a member", async () => {
    const { path: staged } = (await (await upload(OWNER, "board-minutes.png")).json()) as { path: string };
    expect(await read(OWNER, staged)).toBe(200);
    expect(await read(ALICE, staged)).toBe(404);
  });

  it("serves a dropped folder's files to the member who dropped it, uploaded concurrently", async () => {
    const batch = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const results = await Promise.all(
      ["site/a.png", "site/b.png", "site/img/c.png"].map((rel) =>
        upload(ALICE, path.basename(rel), [["batch", batch], ["relativePath", rel]])),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const file = path.join(stagingDir(), batch, "site", "img", "c.png");
    expect(await read(ALICE, file)).toBe(200);
    expect(await read(BOB, file)).toBe(404);
  });

  it("refuses a member staging into someone else's folder batch, so they cannot claim it", async () => {
    const batch = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
    expect((await upload(ALICE, "a.png", [["batch", batch], ["relativePath", "site/a.png"]])).status).toBe(200);
    const alices = path.join(stagingDir(), batch, "site", "a.png");

    const res = await upload(BOB, "x.png", [["batch", batch], ["relativePath", "site/x.png"]]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "batch_in_use" });
    expect(fs.existsSync(path.join(stagingDir(), batch, "site", "x.png"))).toBe(false);
    expect(await read(BOB, alices)).toBe(404);

    // Nor the owner's, which carries no record at all.
    const ownersBatch = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    expect((await upload(OWNER, "o.png", [["batch", ownersBatch], ["relativePath", "docs/o.png"]])).status).toBe(200);
    expect((await upload(BOB, "y.png", [["batch", ownersBatch], ["relativePath", "docs/y.png"]])).status).toBe(409);
    expect(await read(BOB, path.join(stagingDir(), ownersBatch, "docs", "o.png"))).toBe(404);
  });
});

describe("the ownership record", () => {
  const file = (name: string) => {
    const p = path.join(stagingDir(), name);
    fs.mkdirSync(stagingDir(), { recursive: true });
    fs.writeFileSync(p, PNG);
    return p;
  };
  const root = () => fs.realpathSync(path.join(tmpHome, ".openclaw", "media"));
  const real = (p: string) => fs.realpathSync(p);

  it("is never reassigned to someone else once made", () => {
    const f = file("one.png");
    owners.recordMediaOwner("alice", [f]);
    owners.recordMediaOwner("bob", [f]);
    expect(owners.isMediaOwnedBy("alice", real(f), root())).toBe(true);
    expect(owners.isMediaOwnedBy("bob", real(f), root())).toBe(false);
  });

  it("skips names outside the username rule, relative paths and missing files", () => {
    const f = file("two.png");
    owners.recordMediaOwner("../Alice", [f]);
    owners.recordMediaOwner("alice", ["two.png", path.join(stagingDir(), "missing.png"), null, undefined]);
    expect(owners.isMediaOwnedBy("alice", real(f), root())).toBe(false);
    expect(owners.isMediaOwnedBy("../Alice", real(f), root())).toBe(false);
  });

  it("never answers for the media root itself or anything outside it", () => {
    const f = file("three.png");
    // A record of the root (or above it) would otherwise reach every file below.
    owners.recordMediaOwner("alice", [root(), tmpHome]);
    expect(owners.isMediaOwnedBy("alice", root(), root())).toBe(false);
    expect(owners.isMediaOwnedBy("alice", real(f), root())).toBe(false);
    expect(owners.isMediaOwnedBy("alice", path.join(tmpHome, "elsewhere.png"), root())).toBe(false);
  });

  it("reads a damaged record as empty: a member is then served nothing", () => {
    const f = file("four.png");
    owners.recordMediaOwner("alice", [f]);
    fs.writeFileSync(path.join(tmpHome, "data", "chat-media-owners.json"), "{not json");
    expect(owners.isMediaOwnedBy("alice", real(f), root())).toBe(false);
  });

  it("is bounded, the oldest record going first", () => {
    const first = file("first.png");
    owners.recordMediaOwner("alice", [first]);
    const map: Record<string, string> = JSON.parse(fs.readFileSync(path.join(tmpHome, "data", "chat-media-owners.json"), "utf8"));
    for (let i = 0; i < owners.MAX_MEDIA_OWNER_RECORDS; i += 1) map[`/media/filler-${i}.png`] = "bob";
    fs.writeFileSync(path.join(tmpHome, "data", "chat-media-owners.json"), JSON.stringify(map));
    const last = file("last.png");
    owners.recordMediaOwner("alice", [last]);
    const kept = Object.keys(JSON.parse(fs.readFileSync(path.join(tmpHome, "data", "chat-media-owners.json"), "utf8")));
    expect(kept).toHaveLength(owners.MAX_MEDIA_OWNER_RECORDS);
    expect(owners.isMediaOwnedBy("alice", real(first), root())).toBe(false);
    expect(owners.isMediaOwnedBy("alice", real(last), root())).toBe(true);
  });

  it("keeps the file private to the box's account", () => {
    owners.recordMediaOwner("alice", [file("five.png")]);
    expect(fs.statSync(path.join(tmpHome, "data", "chat-media-owners.json")).mode & 0o777).toBe(0o600);
  });
});
