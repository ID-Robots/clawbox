import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-2446 — a chat attachment of a ClawBox user who is not the owner is
 * held to the owner's upload limit for them, when that is below the route's
 * own 25 MB ceiling: refused 413 `upload_too_large` naming THEIR limit (the
 * composer shows the sentence under its "too large to attach" line), nothing
 * left staged. The owner, and a limit above the ceiling, keep the route's own
 * refusal.
 */

const KB = 1024;
const MB = 1024 * 1024;

const h = vi.hoisted(() => ({
  who: null as null | { username: string; isOwner: boolean },
  limits: { uploadMaxMb: 1, homeQuotaMb: 10240, chatPerMinute: 20, chatPerHour: 300 },
}));
vi.mock("@/lib/owner-session", () => ({
  personSession: vi.fn(async () => h.who),
  hasPersonSession: vi.fn(async () => h.who !== null),
  hasOwnerSession: vi.fn(async () => h.who?.isOwner === true),
}));
vi.mock("@/lib/user-limits-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user-limits-server")>()),
  readUserLimits: vi.fn(async () => h.limits),
}));
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "openclaw" as const,
}));

const BOUNDARY = "----clawboxlimitboundary";
let tmpHome: string;
let saved: Record<string, string | undefined>;
let POST: (req: NextRequest) => Promise<Response>;

function request(name: string, bytes: number, declare = false): NextRequest {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(bytes, 0x61),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...(declare ? { "content-length": String(body.length) } : {}),
    },
    body: new Uint8Array(body),
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

const staged = () => {
  const dir = path.join(tmpHome, ".openclaw", "media", "chat-attachments");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

beforeEach(async () => {
  saved = { HOME: process.env.HOME, OPENCLAW_HOME: process.env.OPENCLAW_HOME, CLAWBOX_ROOT: process.env.CLAWBOX_ROOT };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-attach-limit-"));
  fs.mkdirSync(path.join(tmpHome, ".openclaw"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
  process.env.CLAWBOX_ROOT = tmpHome;
  h.who = { username: "ivan", isOwner: false };
  h.limits = { uploadMaxMb: 1, homeQuotaMb: 10240, chatPerMinute: 20, chatPerHour: 300 };
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

describe("a user's chat attachment", () => {
  it("over their upload limit is refused with their limit, and nothing is left staged", async () => {
    const res = await POST(request("notes.txt", MB + 200 * KB));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toMatchObject({ code: "upload_too_large", limitBytes: MB });
    expect(body.error).toBe("This file is larger than the 1 MB upload limit for your account on this ClawBox.");
    await new Promise((r) => setTimeout(r, 50));
    expect(staged()).toEqual([]);
  });

  it("that declares its size is refused before it is read", async () => {
    const res = await POST(request("notes.txt", 2 * MB, true));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("upload_too_large");
    expect(staged()).toEqual([]);
  });

  it("under their limit is staged as before", async () => {
    const res = await POST(request("notes.txt", 200 * KB));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(staged()).toHaveLength(1);
  });

  it("is held only to the route's own ceiling when their limit is above it, or off", async () => {
    h.limits = { ...h.limits, uploadMaxMb: 0 };
    expect((await POST(request("notes.txt", 2 * MB))).status).toBe(200);
    h.limits = { ...h.limits, uploadMaxMb: 100 };
    const res = await POST(request("big.txt", 26 * MB));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(body.error).toMatch(/size limit/);
  });

  it("of the owner is never held to the users' limit", async () => {
    h.who = { username: "clawbox", isOwner: true };
    expect((await POST(request("notes.txt", 2 * MB))).status).toBe(200);
  });
});
