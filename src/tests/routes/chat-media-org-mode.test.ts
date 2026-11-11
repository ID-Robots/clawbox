import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * /setup-api/chat/media on an organisation box (TASK-2435 review): the agent's
 * workspace — the owner's notes and memory — is never served to a member of
 * staff; the media tree their chat's pictures live in still is. The owner,
 * and every user on a home box, are served both as before.
 */

const h = vi.hoisted(() => ({ member: vi.fn(async () => true) }));
vi.mock("@/lib/org-mode-server", () => ({ isOrgMemberRequest: h.member }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpHome: string;
let saved: Record<string, string | undefined>;
let GET: (req: NextRequest) => Promise<Response>;

const get = (p: string) => {
  const url = new URL("http://localhost/setup-api/chat/media");
  url.searchParams.set("path", p);
  return GET(new NextRequest(url));
};

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
  GET = (await import("@/app/setup-api/chat/media/route")).GET;
  h.member.mockResolvedValue(true);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("a member of staff on an organisation box", () => {
  it("is never served the agent's workspace, by absolute or relative path", async () => {
    expect((await get(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"))).status).toBe(404);
    expect((await get("MEMORY.md")).status).toBe(400);
  });

  it("is still served the chat's media", async () => {
    const res = await get(path.join(tmpHome, ".openclaw", "media", "tool-image-generation", "cat.png"));
    expect(res.status).toBe(200);
  });
});

describe("the owner, or a home box", () => {
  it("is served the workspace as before", async () => {
    h.member.mockResolvedValue(false);
    const res = await get(path.join(tmpHome, ".openclaw", "workspace", "MEMORY.md"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the owner's notes");
  });
});
