import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { identityFromClaims } from "@/lib/session-identity";

// setup/complete hands its caller a fresh 24 h session with no user in it,
// and a cookie without `u` is the OWNER's (`identityFromClaims`). So anyone
// the route lets through walks out as the owner: a user the owner added in
// Settings → Users, or the agent's MCP bearer, which middleware passes on
// every /setup-api route. Only the owner may run it (4.3 bug 1).

vi.mock("@/lib/language-persona", () => ({
  retireOnboardingRitual: vi.fn(async () => false),
  applyDeferredLanguagePersona: vi.fn(async () => false),
}));
vi.mock("@/lib/mcp-token", () => ({
  verifyMcpBearer: (header: string | null) => header === "Bearer agent-token",
}));

const ROOT = path.join(os.tmpdir(), `clawbox-setup-complete-non-owner-${process.pid}-${Date.now()}`);
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const ROUTE_URL = "http://localhost/setup-api/setup/complete";
const SECRET = "setup-complete-non-owner-secret-0123456789abcdef";
const GUEST_SV = "0123456789abcdef";
const USERS = [{ username: "guest", createdAt: "2026-01-01T00:00:00Z", sv: GUEST_SV }];

type RoutePost = (request: Request) => Promise<Response>;
let completePost: RoutePost;
let previousTestMode: string | undefined;
let previousSessionSecret: string | undefined;
let previousUser: string | undefined;

function post(headers: Record<string, string>): Request {
  return new Request(ROUTE_URL, { method: "POST", headers });
}

function cookieHeader(cookie: string): Record<string, string> {
  return { cookie: `clawbox_session=${encodeURIComponent(cookie)}` };
}

/** Who the cookie the route just set speaks for, or null when it set none. */
function mintedIdentity(res: Response) {
  const minted = /clawbox_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!minted) return null;
  const payload = decodeURIComponent(minted).split(".")[0];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  return identityFromClaims(claims, "owner", new Map([["guest", GUEST_SV]]));
}

beforeAll(async () => {
  previousTestMode = process.env.CLAWBOX_TEST_MODE;
  previousSessionSecret = process.env.SESSION_SECRET;
  previousUser = process.env.CLAWBOX_USER;
  process.env.CLAWBOX_ROOT = ROOT;
  process.env.CLAWBOX_USER = "owner";
  delete process.env.CLAWBOX_TEST_MODE;
  delete process.env.SESSION_SECRET;
  await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "data", ".session-secret"), SECRET, { mode: 0o600 });
  vi.resetModules();
  ({ POST: completePost } = await import("@/app/setup-api/setup/complete/route"));
});

beforeEach(async () => {
  await fs.writeFile(CONFIG_PATH, JSON.stringify({
    setup_complete: false,
    password_configured: true,
    session_generation: 0,
    clawbox_users: USERS,
  }));
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  if (previousTestMode === undefined) delete process.env.CLAWBOX_TEST_MODE;
  else process.env.CLAWBOX_TEST_MODE = previousTestMode;
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
  if (previousUser === undefined) delete process.env.CLAWBOX_USER;
  else process.env.CLAWBOX_USER = previousUser;
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("POST /setup-api/setup/complete from someone who is not the owner", () => {
  it("refuses a signed-in non-owner with 403 owner_only and mints no owner cookie", async () => {
    const guest = createSessionCookie(3600, SECRET, 0, { u: "guest", sv: GUEST_SV });

    const res = await completePost(post(cookieHeader(guest)));

    expect(mintedIdentity(res)?.isOwner).not.toBe(true);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "owner_only" });
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(false);
  });

  it("refuses the agent's MCP bearer with 403 owner_only and mints no owner cookie", async () => {
    const res = await completePost(post({ authorization: "Bearer agent-token" }));

    expect(mintedIdentity(res)?.isOwner).not.toBe(true);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still completes setup for the owner and hands them the auto-login cookie", async () => {
    const owner = createSessionCookie(3600, SECRET, 0);

    const res = await completePost(post(cookieHeader(owner)));

    expect(res.status).toBe(200);
    expect(mintedIdentity(res)?.isOwner).toBe(true);
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(true);
  });
});
