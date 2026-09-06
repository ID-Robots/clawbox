import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSessionCookie } from "../../helpers/session";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-setup-complete-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ROUTE_URL = "http://localhost/setup-api/setup/complete";

// The secret both halves read: `@/lib/route-auth` verifies the cookie against
// data/.session-secret under CLAWBOX_ROOT, and `@/lib/auth` mints the
// auto-login cookie from the same file. One string, written once, so the two
// cannot disagree inside this suite.
const SECRET = "setup-complete-test-secret-0123456789abcdef";

type RoutePost = (request: Request) => Promise<Response>;

let completePost: RoutePost;
let previousTestMode: string | undefined;
let previousSessionSecret: string | undefined;

/** A POST from the wizard: the session CredentialsStep was handed. */
function ownerPost(): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: { cookie: `clawbox_session=${signSessionCookie({ secret: SECRET })}` },
  });
}

/** A POST from nobody in particular — no cookie, no bearer. */
function anonymousPost(): Request {
  return new Request(ROUTE_URL, { method: "POST" });
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  // route-auth prefers SESSION_SECRET over the file and honours test mode;
  // neither may leak in from the environment, or the anonymous case below
  // would pass for the wrong reason.
  previousTestMode = process.env.CLAWBOX_TEST_MODE;
  previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.CLAWBOX_TEST_MODE;
  delete process.env.SESSION_SECRET;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, ".session-secret"), SECRET, { mode: 0o600 });
  vi.resetModules();
  ({ POST: completePost } = await import("@/app/setup-api/setup/complete/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  if (previousTestMode === undefined) delete process.env.CLAWBOX_TEST_MODE;
  else process.env.CLAWBOX_TEST_MODE = previousTestMode;
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("POST /setup-api/setup/complete", () => {
  it("marks setup as complete", async () => {
    const res = await completePost(ownerPost());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(true);
  });

  it("clears stored setup progress once setup is complete", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_progress_step: 6 }), "utf-8");

    await completePost(ownerPost());

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_progress_step).toBeUndefined();
  });

  it("sets setup_completed_at timestamp", async () => {
    const before = new Date().toISOString();
    await completePost(ownerPost());
    const after = new Date().toISOString();

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_completed_at).toBeDefined();

    const timestamp = new Date(config.setup_completed_at);
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it("preserves existing config values", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      existing_key: "preserved",
      wifi_configured: true,
    }), "utf-8");

    await completePost(ownerPost());

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.existing_key).toBe("preserved");
    expect(config.wifi_configured).toBe(true);
    expect(config.setup_complete).toBe(true);
  });

  it("can be called multiple times", async () => {
    const res1 = await completePost(ownerPost());
    expect(res1.status).toBe(200);

    const res2 = await completePost(ownerPost());
    expect(res2.status).toBe(200);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(true);
  });

  it("hands the owner the auto-login cookie so the desktop opens without a login screen", async () => {
    const res = await completePost(ownerPost());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("clawbox_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  // The route mints a 24 h owner session. Middleware's bootstrap allow-list
  // keeps it shut to an anonymous caller today; this is the handler refusing
  // for itself, so a loosened list or a path that dodges the matcher cannot
  // turn "mark setup complete" into "become the owner".
  it("answers 401 to an anonymous POST, writes no setup_complete and sets no cookie", async () => {
    const res = await completePost(anonymousPost());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
    expect(res.headers.get("set-cookie")).toBeNull();
    await expect(fs.access(CONFIG_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a cookie signed with some other secret", async () => {
    const forged = new Request(ROUTE_URL, {
      method: "POST",
      headers: { cookie: `clawbox_session=${signSessionCookie({ secret: "not-the-secret-on-this-box-0123456789" })}` },
    });

    const res = await completePost(forged);

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    await expect(fs.access(CONFIG_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a cookie from before the last password change", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ session_generation: 2 }), "utf-8");
    const stale = new Request(ROUTE_URL, {
      method: "POST",
      headers: { cookie: `clawbox_session=${signSessionCookie({ secret: SECRET, gen: 1 })}` },
    });

    const res = await completePost(stale);

    expect(res.status).toBe(401);
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBeUndefined();
  });
});
