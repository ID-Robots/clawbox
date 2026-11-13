import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * A file an agent's reply names in a member of staff's chat is THAT member's
 * (TASK-2516): an owner-granted MCP tool writes a document, the reply carries
 * `MEDIA:<path>`, and the download card opens for the member — and for no
 * other member. Pinned end to end: the claim as the OpenClaw relay makes it
 * (production-server.js's roots, scripts/chat-reply-media.js) and as the
 * Hermes route makes it (src/lib/chat-reply-media.ts), then the real media
 * route, with only the session mocked.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn<(req?: Request) => Promise<{ username: string; isOwner: boolean } | null>>(async () => null),
  harness: "openclaw" as "openclaw" | "hermes",
}));
vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/org-mode-server", () => {
  const orgMemberOf = async (req: Request) => {
    const who = await h.who(req);
    return who && !who.isOwner ? { username: who.username } : null;
  };
  return { orgMemberOf, isOrgMemberRequest: async (req: Request) => (await orgMemberOf(req)) !== null };
});
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => h.harness,
}));

const OWNER: Who = { username: "clawbox", isOwner: true };
const ALICE: Who = { username: "alice", isOwner: false };
const BOB: Who = { username: "bob", isOwner: false };

const requireCjs = createRequire(import.meta.url);
type ClaimModule = typeof import("../../../scripts/chat-reply-media.js");
type OwnersModule = typeof import("../../../scripts/chat-media-owners.js");

let tmpHome: string;
let GET: (req: NextRequest) => Promise<Response>;
let claims: ClaimModule;
let ownersCjs: OwnersModule;
const saved: Record<string, string | undefined> = {};

const openclawHome = () => path.join(tmpHome, ".openclaw");
const mediaRoot = () => path.join(openclawHome(), "media");

function write(file: string, body = "PK\u0003\u0004 docx"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** The claim exactly as production-server.js's relay makes it for an OpenClaw member. */
function relayClaim(username: string, paths: string[], since: number | null = Date.now() - 60_000) {
  const owners = ownersCjs.createMediaOwners(path.join(tmpHome, "data", "chat-media-owners.json"));
  return claims.claimReplyMedia({
    username,
    paths,
    since,
    until: Date.now(),
    roots: [
      { dir: mediaRoot(), skip: claims.MEDIA_TREE_OWN_FOLDERS },
      { dir: path.join(openclawHome(), "staff", username) },
    ],
    record: owners.recordMediaOwner,
  });
}

async function read(who: Who, file: string): Promise<number> {
  h.who.mockResolvedValue(who);
  const url = new URL("http://localhost/setup-api/chat/media");
  url.searchParams.set("path", file);
  url.searchParams.set("download", "1");
  return (await GET(new NextRequest(url))).status;
}

beforeEach(async () => {
  for (const k of ["HOME", "OPENCLAW_HOME", "CLAWBOX_ROOT", "HERMES_HOME"]) saved[k] = process.env[k];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reply-media-"));
  fs.mkdirSync(mediaRoot(), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = openclawHome();
  process.env.CLAWBOX_ROOT = tmpHome;
  process.env.HERMES_HOME = path.join(tmpHome, ".hermes");
  h.harness = "openclaw";
  vi.resetModules();
  GET = (await import("@/app/setup-api/chat/media/route")).GET;
  claims = requireCjs("../../../scripts/chat-reply-media.js");
  ownersCjs = requireCjs("../../../scripts/chat-media-owners.js");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("a document a member's reply names (OpenClaw relay)", () => {
  it("is downloadable by that member, a 404 for another member, and served to the owner as before", async () => {
    const doc = write(path.join(mediaRoot(), "word-docs", "report-1.docx"));
    expect(await read(ALICE, doc)).toBe(404); // nobody's yet
    const { recorded } = relayClaim("alice", [doc]);
    expect(recorded).toEqual([fs.realpathSync(doc)]);
    expect(await read(ALICE, doc)).toBe(200);
    expect(await read(BOB, doc)).toBe(404);
    expect(await read(OWNER, doc)).toBe(200);
  });

  it("member A cannot download member B's file, and B's reply naming A's file does not make it B's", async () => {
    const aDoc = write(path.join(mediaRoot(), "word-docs", "a.docx"));
    const bDoc = write(path.join(mediaRoot(), "word-docs", "b.docx"));
    relayClaim("alice", [aDoc]);
    relayClaim("bob", [bDoc]);
    expect(await read(ALICE, bDoc)).toBe(404);
    expect(await read(BOB, aDoc)).toBe(404);
    // Bob talks his assistant into naming Alice's document: never reassigned.
    const { recorded, refused } = relayClaim("bob", [aDoc]);
    expect(recorded).toEqual([]);
    expect(refused.map((r) => r.reason)).toEqual(["someone_elses"]);
    expect(await read(BOB, aDoc)).toBe(404);
    expect(await read(ALICE, aDoc)).toBe(200);
  });

  it("serves a file in the member's own assistant folder to them, never to another member, never a dotfile", async () => {
    const own = write(path.join(openclawHome(), "staff", "alice", "out", "letter.docx"));
    relayClaim("alice", [own]);
    expect(await read(ALICE, own)).toBe(200);
    expect(await read(BOB, own)).toBe(404);
    const hidden = write(path.join(openclawHome(), "staff", "alice", ".secrets", "x.docx"));
    expect(relayClaim("alice", [hidden]).recorded).toEqual([]);
    expect(await read(ALICE, hidden)).toBe(404);
  });

  it("does not record a MEDIA: path outside the allowed folders, and it stays a 404", async () => {
    const outside = write(path.join(tmpHome, "Documents", "payroll.docx"));
    const ownerWorkspace = write(path.join(openclawHome(), "workspace", "notes.docx"));
    const otherStaff = write(path.join(openclawHome(), "staff", "bob", "plan.docx"));
    const { recorded, refused } = relayClaim("alice", [outside, ownerWorkspace, otherStaff, "/etc/passwd"]);
    expect(recorded).toEqual([]);
    expect(refused.map((r) => r.reason)).toEqual(["outside", "outside", "outside", "outside"]);
    for (const file of [outside, ownerWorkspace, otherStaff]) expect(await read(ALICE, file)).toBe(404);
  });

  it("refuses traversal, symlinks (file and folder), hard links, ClawBox's own folders and stale files", async () => {
    const ownerDoc = write(path.join(tmpHome, "owner-secret.docx"));
    const linkFile = path.join(mediaRoot(), "word-docs", "link.docx");
    fs.mkdirSync(path.dirname(linkFile), { recursive: true });
    fs.symlinkSync(ownerDoc, linkFile);
    fs.symlinkSync(tmpHome, path.join(mediaRoot(), "escape"));
    const hard = path.join(mediaRoot(), "word-docs", "hard.docx");
    fs.linkSync(write(path.join(mediaRoot(), "word-docs", "orig.docx")), hard);
    const ownersUpload = write(path.join(mediaRoot(), "chat-attachments", "uuid-board.pdf"));
    const stale = write(path.join(mediaRoot(), "word-docs", "old.docx"));
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(stale, hourAgo, hourAgo);

    const traversal = `${mediaRoot()}/word-docs/../../../owner-secret.docx`;
    const { recorded, refused } = relayClaim("alice", [
      traversal,
      linkFile,
      path.join(mediaRoot(), "escape", "owner-secret.docx"),
      hard,
      ownersUpload,
      stale,
    ]);
    expect(recorded).toEqual([]);
    expect(refused.map((r) => r.reason)).toEqual(["traversal", "link", "link", "link", "own_folder", "not_this_turn"]);
    for (const file of [linkFile, hard, ownersUpload, stale]) expect(await read(ALICE, file)).toBe(404);
  });
});

describe("a document a member's reply names (Hermes route)", () => {
  it("records MEDIA: lines of the reply text for the member, and their profile folder is theirs alone", async () => {
    h.harness = "hermes";
    const hermesMedia = path.join(tmpHome, "data", "chat-media");
    const doc = write(path.join(hermesMedia, "word-docs", "quote.docx"));
    const { staffHermesProfilePaths } = await import("@/lib/hermes-staff-profile");
    const folder = staffHermesProfilePaths("alice")!.folder;
    const own = write(path.join(folder, "summary.docx"));
    const outside = write(path.join(tmpHome, "elsewhere.docx"));
    const { recordMemberReplyMedia } = await import("@/lib/chat-reply-media");
    const result = recordMemberReplyMedia({
      username: "alice",
      text: `Here it is.\nMEDIA:${doc}\nMEDIA:\`${own}\`\n\`\`\`\nMEDIA:${outside}\n\`\`\`\nMEDIA:${outside}`,
      mediaRoot: hermesMedia,
      ownFolder: folder,
      since: Date.now() - 60_000,
    });
    expect(result.recorded.sort()).toEqual([fs.realpathSync(doc), fs.realpathSync(own)].sort());
    expect(result.refused.map((r) => r.reason)).toEqual(["outside"]);
    expect(await read(ALICE, doc)).toBe(200);
    expect(await read(ALICE, own)).toBe(200);
    expect(await read(BOB, doc)).toBe(404);
    expect(await read(BOB, own)).toBe(404);
    expect(await read(ALICE, outside)).toBe(404);
    expect(await read(OWNER, doc)).toBe(200);
  });
});
