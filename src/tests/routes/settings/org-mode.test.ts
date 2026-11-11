import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/org-mode — the owner's "Organisation mode" switch
 * (src/lib/org-mode.ts). Pinned: off by default (and on anything but a literal
 * true), only the owner's own browser session may move it — never the agent's
 * bearer or another user, never from another site's page — and /users/me
 * tells every desktop what it says.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "clawbox", isOwner: true })),
  sameOrigin: vi.fn(() => true),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/route-auth", () => ({ sessionIdentity: h.who }));
vi.mock("@/lib/clawbox-users", () => ({ listUsers: vi.fn(async () => [{ username: "alice" }]) }));

let root: string;
let restoreEnv: () => void;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let me: (req: Request) => Promise<Response>;

const storePath = () => path.join(root, "data", "config.json");
const URL_ = "http://box.local/setup-api/settings/org-mode";
const get = () => GET(new Request(URL_));
const post = (body: unknown, init: { raw?: string } = {}) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init.raw ?? JSON.stringify(body),
  }));
const stored = () => JSON.parse(fs.readFileSync(storePath(), "utf-8")).org_mode;
const as = (who: Who) => h.who.mockResolvedValue(who);

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-org-mode-route-"));
  process.env.CLAWBOX_ROOT = root;
  ({ GET, POST } = await import("@/app/setup-api/settings/org-mode/route"));
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
});

describe("GET", () => {
  it("is off on a box that never saw the switch, and the owner may change it", async () => {
    expect(await (await get()).json()).toEqual({ orgMode: false, canChange: true });
  });

  it("reads only a literal true as on", async () => {
    for (const value of ["true", 1, null, false, {}]) {
      fs.writeFileSync(storePath(), JSON.stringify({ org_mode: value }));
      expect((await (await get()).json()).orgMode, String(value)).toBe(false);
    }
    fs.writeFileSync(storePath(), JSON.stringify({ org_mode: true }));
    expect((await (await get()).json()).orgMode).toBe(true);
  });

  it("tells another user, and the agent's bearer, that they may not change it", async () => {
    as({ username: "alice", isOwner: false });
    expect((await (await get()).json()).canChange).toBe(false);
    as(null);
    expect((await (await get()).json()).canChange).toBe(false);
  });
});

describe("POST", () => {
  it("lets the owner turn it on and off", async () => {
    const on = await post({ orgMode: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ orgMode: true, canChange: true });
    expect(stored()).toBe(true);
    const off = await post({ orgMode: false });
    expect(await off.json()).toEqual({ orgMode: false, canChange: true });
    expect(stored()).toBe(false);
  });

  it("refuses another ClawBox user, and writes nothing", async () => {
    as({ username: "alice", isOwner: false });
    const res = await post({ orgMode: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses the agent's bearer and anyone without a person session", async () => {
    as(null);
    const res = await post({ orgMode: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses a page of another site riding the owner's cookie", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ orgMode: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("takes only a boolean", async () => {
    for (const body of [{ orgMode: "true" }, { orgMode: 1 }, {}, [], null, { org_mode: true }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(undefined, { raw: "{not json" })).status).toBe(400);
    expect(fs.existsSync(storePath())).toBe(false);
  });
});

describe("/setup-api/users/me", () => {
  it("tells every desktop whether this is an organisation box", async () => {
    as({ username: "alice", isOwner: false });
    const ask = async () => (await me(new Request("http://box.local/setup-api/users/me"))).json();
    expect(await ask()).toEqual({ username: "alice", isOwner: false, multiUser: true, openclawShared: false, orgMode: false });
    fs.writeFileSync(storePath(), JSON.stringify({ org_mode: true }));
    expect((await ask()).orgMode).toBe(true);
    as({ username: "clawbox", isOwner: true });
    expect(await ask()).toMatchObject({ isOwner: true, orgMode: true });
  });
});
