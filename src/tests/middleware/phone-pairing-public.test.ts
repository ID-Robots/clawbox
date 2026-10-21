import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phone pairing opens exactly three doors without a session: the page a phone
 * opens from the owner's QR invite (GET), and the two calls that page makes
 * (POST). Everything else under /setup-api/nodes — the list, the switch, the
 * invite, approve, reject, revoke — stays behind the owner's session.
 */

let tmpRoot: string;

beforeEach(() => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mw-phones-"));
  process.env.CLAWBOX_ROOT = tmpRoot;
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.CLAWBOX_TEST_MODE;
  fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "data", "config.json"),
    JSON.stringify({ setup_complete: true, password_configured: true }),
  );
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function run(pathname: string, method = "GET") {
  const { middleware } = await import("@/middleware");
  return middleware(new NextRequest(new URL(`http://localhost${pathname}`), { method }));
}

describe("phone pairing through the middleware", () => {
  it("serves the phone's page without a session", async () => {
    expect((await run("/phone-pair")).status).toBe(200);
    expect((await run("/phone-pair", "HEAD")).status).toBe(200);
  });

  it("does not take a write to the phone's page", async () => {
    expect((await run("/phone-pair", "POST")).status).not.toBe(200);
  });

  it.each(["/setup-api/nodes/request", "/setup-api/nodes/request/status"])("lets a phone POST %s without a session", async (p) => {
    expect((await run(p, "POST")).status).toBe(200);
  });

  it.each(["/setup-api/nodes/request", "/setup-api/nodes/request/status"])("does not open %s to any other method", async (p) => {
    expect((await run(p, "GET")).status).toBe(401);
  });

  it.each([
    "/setup-api/nodes",
    "/setup-api/nodes/settings",
    "/setup-api/nodes/invite",
    "/setup-api/nodes/approve",
    "/setup-api/nodes/reject",
    "/setup-api/nodes/revoke",
    "/setup-api/nodes/request/status/extra",
  ])("keeps %s behind the owner's session", async (p) => {
    expect((await run(p, "POST")).status).toBe(401);
  });
});
