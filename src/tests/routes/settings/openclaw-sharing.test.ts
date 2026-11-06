import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/openclaw-sharing — the owner's "Share OpenClaw with all
 * users" switch. Pinned: off by default (and on anything but a literal true),
 * only the owner's own browser session may move it, never the agent's bearer
 * or another user, never from another site's page; and /users/me tells the
 * desktop what it says.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "clawbox", isOwner: true })),
  sameOrigin: vi.fn(() => true),
  harness: vi.fn(async () => "openclaw" as "openclaw" | "hermes"),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: h.harness }));
vi.mock("@/lib/route-auth", () => ({ sessionIdentity: h.who }));
vi.mock("@/lib/clawbox-users", () => ({ listUsers: vi.fn(async () => [{ username: "alice" }]) }));

let root: string;
let restoreEnv: () => void;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let me: (req: Request) => Promise<Response>;

const storePath = () => path.join(root, "data", "config.json");
const URL_ = "http://box.local/setup-api/settings/openclaw-sharing";
const get = () => GET(new Request(URL_));
const post = (body: unknown, init: { raw?: string } = {}) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init.raw ?? JSON.stringify(body),
  }));
const stored = () => JSON.parse(fs.readFileSync(storePath(), "utf-8")).openclaw_shared_with_users;
const as = (who: Who) => h.who.mockResolvedValue(who);

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-openclaw-sharing-route-"));
  process.env.CLAWBOX_ROOT = root;
  ({ GET, POST } = await import("@/app/setup-api/settings/openclaw-sharing/route"));
  ({ GET: me } = await import("@/app/setup-api/users/me/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  as({ username: "clawbox", isOwner: true });
  h.sameOrigin.mockReturnValue(true);
  h.harness.mockResolvedValue("openclaw");
});

describe("GET", () => {
  it("is off on a box that never saw the switch, and the owner may change it", async () => {
    expect(await (await get()).json()).toEqual({ shared: false, canChange: true, available: true });
  });

  it("reads only a literal true as shared", async () => {
    for (const value of ["true", 1, null, false]) {
      fs.writeFileSync(storePath(), JSON.stringify({ openclaw_shared_with_users: value }));
      expect((await (await get()).json()).shared, String(value)).toBe(false);
    }
    fs.writeFileSync(storePath(), JSON.stringify({ openclaw_shared_with_users: true }));
    expect((await (await get()).json()).shared).toBe(true);
  });

  it("tells another user they may not change it, and says when there is no OpenClaw to share", async () => {
    as({ username: "alice", isOwner: false });
    expect((await (await get()).json()).canChange).toBe(false);
    as({ username: "clawbox", isOwner: true });
    h.harness.mockResolvedValue("hermes");
    expect((await (await get()).json()).available).toBe(false);
  });
});

describe("POST", () => {
  it("lets the owner share OpenClaw and take it back", async () => {
    const on = await post({ shared: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ shared: true, canChange: true, available: true });
    expect(stored()).toBe(true);
    const off = await post({ shared: false });
    expect(await off.json()).toMatchObject({ shared: false });
    expect(stored()).toBe(false);
  });

  it("refuses another ClawBox user, and writes nothing", async () => {
    as({ username: "alice", isOwner: false });
    const res = await post({ shared: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses the agent's bearer and anyone without a person session", async () => {
    as(null);
    const res = await post({ shared: true });
    expect(res.status).toBe(403);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses a page of another site riding the owner's cookie", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ shared: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("takes only a boolean", async () => {
    for (const body of [{ shared: "true" }, { shared: 1 }, {}, [], null]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(undefined, { raw: "{not json" })).status).toBe(400);
    expect(fs.existsSync(storePath())).toBe(false);
  });
});

describe("/setup-api/users/me", () => {
  it("tells the desktop whether OpenClaw is shared, so a user's desktop shows its icon", async () => {
    as({ username: "alice", isOwner: false });
    expect(await (await me(new Request("http://box.local/setup-api/users/me"))).json()).toEqual({
      username: "alice", isOwner: false, multiUser: true, openclawShared: false,
    });
    fs.writeFileSync(storePath(), JSON.stringify({ openclaw_shared_with_users: true }));
    expect((await (await me(new Request("http://box.local/setup-api/users/me"))).json()).openclawShared).toBe(true);
  });
});
