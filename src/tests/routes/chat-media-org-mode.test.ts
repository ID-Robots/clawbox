import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * /setup-api/chat/media on an organisation box (TASK-2435 review): the agent's
 * workspace — the owner's notes and memory — is never served to a member of
 * staff, and in the shared media tree a member is served only what is
 * recorded as their own chat's (src/lib/chat-media-owners.ts): never another
 * member's file and never the owner's, even by its exact absolute path. The
 * owner, and every user on a home box, are served both trees as before.
 */

const h = vi.hoisted(() => ({
  member: vi.fn(async (): Promise<{ username: string } | null | "unknown"> => ({ username: "alice" })),
}));
vi.mock("@/lib/org-mode-server", () => ({ orgMemberOf: h.member, orgMemberStrictOf: h.member }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpHome: string;
let saved: Record<string, string | undefined>;
let GET: (req: NextRequest) => Promise<Response>;
let HEAD: (req: NextRequest) => Promise<Response>;
let owners: typeof import("@/lib/chat-media-owners");
let ownersFile: string;

const request = (p: string) => {
  const url = new URL("http://localhost/setup-api/chat/media");
  url.searchParams.set("path", p);
  return new NextRequest(url);
};
const get = (p: string) => GET(request(p));
const media = (...parts: string[]) => path.join(tmpHome, ".openclaw", "media", ...parts);
const as = (who: { username: string } | null | "unknown") => h.member.mockResolvedValue(who);

beforeEach(async () => {
  saved = { HOME: process.env.HOME, OPENCLAW_HOME: process.env.OPENCLAW_HOME };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-media-org-"));
  fs.mkdirSync(path.join(tmpHome, ".openclaw", "media", "tool-image-generation"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".openclaw", "media", "tool-image-generation", "cat.png"), PNG);
  fs.mkdirSync(path.join(tmpHome, ".openclaw", "workspace"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"), "the owner's notes");
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
  vi.resetModules();
  ({ GET, HEAD } = await import("@/app/setup-api/chat/media/route"));
  owners = await import("@/lib/chat-media-owners");
  ownersFile = path.join((await import("@/lib/config-store")).DATA_DIR, "chat-media-owners.json");
  fs.rmSync(ownersFile, { force: true });
  as({ username: "alice" });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(ownersFile, { force: true });
});

describe("a member of staff on an organisation box", () => {
  it("is refused (503), never served the owner's view, when the switch cannot be read (TASK-2516 review)", async () => {
    as("unknown");
    expect((await get(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"))).status).toBe(503);
    expect((await get(path.join(tmpHome, ".openclaw", "media", "tool-image-generation", "cat.png"))).status).toBe(503);
  });

  it("is never served the agent's workspace, by absolute or relative path", async () => {
    expect((await get(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"))).status).toBe(404);
    expect((await get("MEMORY.md")).status).toBe(400);
  });

  it("is served the media of their own chat", async () => {
    fs.mkdirSync(media("chat-generated"), { recursive: true });
    fs.writeFileSync(media("chat-generated", "alices.png"), PNG);
    owners.recordMediaOwner("alice", [media("chat-generated", "alices.png")]);
    const res = await get(media("chat-generated", "alices.png"));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await HEAD(request(media("chat-generated", "alices.png")))).status).toBe(200);
  });

  it("is served a file inside a folder they dropped, recorded once by its batch", async () => {
    fs.mkdirSync(media("chat-attachments", "batch-0001", "site"), { recursive: true });
    fs.writeFileSync(media("chat-attachments", "batch-0001", "site", "index.png"), PNG);
    owners.recordMediaOwner("alice", [media("chat-attachments", "batch-0001")]);
    expect((await get(media("chat-attachments", "batch-0001", "site", "index.png"))).status).toBe(200);
  });

  it("cannot read another user's media file by its absolute path (GET or HEAD, any spelling)", async () => {
    fs.mkdirSync(media("chat-attachments"), { recursive: true });
    const bobs = media("chat-attachments", "0b0b0b0b-bob-payslip.png");
    fs.writeFileSync(bobs, PNG);
    owners.recordMediaOwner("bob", [bobs]);

    expect((await get(bobs)).status).toBe(404);
    expect((await HEAD(request(bobs))).status).toBe(404);
    // A dot-dot detour through a file of their own changes nothing.
    fs.writeFileSync(media("chat-attachments", "alices.png"), PNG);
    owners.recordMediaOwner("alice", [media("chat-attachments", "alices.png")]);
    expect((await get(`${media("chat-attachments", "alices.png")}/../0b0b0b0b-bob-payslip.png`)).status).toBe(404);
    // Nor does a link of their own pointing at it.
    fs.symlinkSync(bobs, media("chat-attachments", "link.png"));
    owners.recordMediaOwner("alice", [media("chat-attachments", "link.png")]);
    expect((await get(media("chat-attachments", "link.png"))).status).toBe(404);
    // Bob himself still is.
    as({ username: "bob" });
    expect((await get(bobs)).status).toBe(200);
  });

  it("cannot read the owner's media, or anything nobody recorded, by its absolute path", async () => {
    expect((await get(media("tool-image-generation", "cat.png"))).status).toBe(404);
  });

  it("is told nothing about a file that is not theirs: the same 404 as a path that is not there", async () => {
    const big = media("tool-image-generation", "huge.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 600 * 1024 * 1024);
    owners.recordMediaOwner("bob", [big]);
    const res = await get(big);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual((await (await get(media("tool-image-generation", "absent.png"))).json()));
  });

  it("loses a removed user's records, so a later user of the same name owns nothing", async () => {
    fs.mkdirSync(media("chat-generated"), { recursive: true });
    fs.writeFileSync(media("chat-generated", "old.png"), PNG);
    owners.recordMediaOwner("alice", [media("chat-generated", "old.png")]);
    owners.forgetMediaOwner("alice");
    expect((await get(media("chat-generated", "old.png"))).status).toBe(404);
  });
});

describe("the owner, or a home box", () => {
  it("is served the workspace as before", async () => {
    as(null);
    const res = await get(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the owner's notes");
  });

  it("is served every file of the media tree as before, whoever's chat it came from", async () => {
    as(null);
    fs.mkdirSync(media("chat-attachments"), { recursive: true });
    fs.writeFileSync(media("chat-attachments", "bobs.png"), PNG);
    owners.recordMediaOwner("bob", [media("chat-attachments", "bobs.png")]);
    expect((await get(media("chat-attachments", "bobs.png"))).status).toBe(200);
    expect((await get(media("tool-image-generation", "cat.png"))).status).toBe(200);
  });
});
