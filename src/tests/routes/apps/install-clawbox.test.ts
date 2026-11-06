/**
 * POST /setup-api/apps/install for a ClawBox app (`source: "clawbox"`): the
 * Store's own record is read by the route — never taken from the caller —
 * and handed to src/lib/store-install.ts; its refusals keep their status,
 * code and sentence. A skill install is untouched, except that a slug ClawHub
 * does not know is tried as a ClawBox app when the Store says it is one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/openclaw-apps-server", () => ({ openclawAppsGuard: vi.fn(async () => null) }));
const skillRoot = vi.hoisted(() => ({ dir: "" }));
vi.mock("@/lib/openclaw-config", () => ({
  openclawSkillRoot: vi.fn(() => skillRoot.dir),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  openclawSkillsAgentArgs: vi.fn(async () => []),
  OpenclawConfigUnreadableError: class OpenclawConfigUnreadableError extends Error {},
}));
const lookupClawhubOwner = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clawhub-url", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawhub-url")>()),
  lookupClawhubOwner,
}));
const installClawboxApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store-install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store-install")>()),
  installClawboxApp,
}));

const PORTAL = "https://portal.example";
const RECORD = {
  source: "clawbox",
  slug: "hello-app",
  name: "Hello App",
  summary: "Says hello",
  category: "clawbox-apps",
  kind: "webapp",
  version: "1.0.0",
  packageUrl: "/api/store/apps/hello-app/package",
  sha256: "a".repeat(64),
  size: 1234,
};
const fetchMock = vi.fn();
let restore: () => void;
let POST: (req: Request) => Promise<Response>;

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/apps/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  restore = saveEnv("PORTAL_WEB");
  process.env.PORTAL_WEB = PORTAL;
  skillRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-clawbox-skills-"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  vi.clearAllMocks();
  installClawboxApp.mockResolvedValue({
    ok: true, appId: "hello-app", folder: "hello-app", directory: "/projects/hello-app", version: "1.0.0", kind: "webapp",
    registered: true, webappUrl: "/setup-api/webapps?app=hello-app", detail: null, alreadyInstalled: false,
  });
  POST = (await import("@/app/setup-api/apps/install/route")).POST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore();
  fs.rmSync(skillRoot.dir, { recursive: true, force: true });
});

describe("installing a ClawBox app", () => {
  it("reads the record from the Store and installs that — not anything the caller sent", async () => {
    fetchMock.mockImplementation(async (url: string) => (url === `${PORTAL}/api/store/apps/hello-app` ? json(200, RECORD) : json(404, {})));
    const res = await POST(post({ appId: "hello-app", source: "clawbox", packageUrl: "https://evil.example/x.tgz", sha256: "b".repeat(64) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, appId: "hello-app", source: "clawbox", version: "1.0.0", folder: "hello-app", kind: "webapp",
      registered: true, webappUrl: "/setup-api/webapps?app=hello-app", detail: null, alreadyInstalled: false,
      iconPath: "/setup-api/apps/icon/hello-app",
    });
    expect(installClawboxApp).toHaveBeenCalledWith(expect.objectContaining({ slug: "hello-app", packageUrl: RECORD.packageUrl, sha256: RECORD.sha256 }));
    expect(lookupClawhubOwner).not.toHaveBeenCalled();
  });

  it("keeps the installer's refusal: a SHA-256 mismatch is 422, not retryable", async () => {
    fetchMock.mockResolvedValue(json(200, RECORD));
    installClawboxApp.mockResolvedValue({ ok: false, code: "sha256_mismatch", error: "The package does not match.", retryable: false, status: 422 });
    const res = await POST(post({ appId: "hello-app", source: "clawbox" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "The package does not match.", code: "sha256_mismatch", retryable: false, appId: "hello-app", source: "clawbox" });
  });

  it("refuses a record that is not a ClawBox app, and one the Store does not have", async () => {
    fetchMock.mockResolvedValue(json(200, { ...RECORD, source: undefined }));
    let res = await POST(post({ appId: "hello-app", source: "clawbox" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "invalid_listing", retryable: false });
    fetchMock.mockResolvedValue(json(404, {}));
    res = await POST(post({ appId: "hello-app", source: "clawbox" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(installClawboxApp).not.toHaveBeenCalled();
  });

  it("is offline, retryable, when the Store cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await POST(post({ appId: "hello-app", source: "clawbox" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "offline", retryable: true });
  });

  it("refuses a source it does not know, and a ClawHub publisher on a ClawBox app", async () => {
    expect((await POST(post({ appId: "hello-app", source: "elsewhere" }))).status).toBe(400);
    expect((await POST(post({ appId: "@someone/hello-app", source: "clawbox" }))).status).toBe(400);
  });

  it("tries a slug ClawHub does not know as a ClawBox app when the Store says it is one", async () => {
    lookupClawhubOwner.mockResolvedValue({ status: "not_found" });
    fetchMock.mockImplementation(async (url: string) => (url.endsWith("/api/store/apps/hello-app") ? json(200, RECORD) : json(404, {})));
    const res = await POST(post({ appId: "hello-app" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, source: "clawbox" });
    expect(installClawboxApp).toHaveBeenCalledTimes(1);
  });

  it("still answers not_found for a slug that is neither", async () => {
    lookupClawhubOwner.mockResolvedValue({ status: "not_found" });
    fetchMock.mockResolvedValue(json(200, { slug: "hello-app", name: "Hello", category: "developer" }));
    const res = await POST(post({ appId: "hello-app" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(installClawboxApp).not.toHaveBeenCalled();
  });
});
