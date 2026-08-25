import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The seam TASK-527 turns on: the wizard authenticates itself, so the provider
 * sign-in flow needs no pre-auth carve-out.
 *
 * The other suites check the two halves separately — credentials.test.ts that a
 * cookie is minted, middleware.test.ts and oauth-flows.test.ts that the OAuth
 * routes refuse an anonymous caller. Neither would notice if the cookie one side
 * mints stopped being a cookie the other side accepts, which is the single
 * failure that would strand a fresh box: a wizard that can no longer finish
 * AIModelsStep, on a device whose only other way in is a password the user has
 * just this second chosen.
 *
 * So this suite runs the real thing end to end. `@/lib/auth` is NOT mocked here
 * (unlike credentials.test.ts, where `createSessionCookie` is a stub returning a
 * literal): the cookie asserted below is the one the route really signs, and it
 * is verified by the real middleware and the real `@/lib/route-auth`.
 */

const SESSION_SECRET = "wizard-handoff-secret-0123456789abcdef";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: { mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() },
}));

// The wizard's own view of the world on step 3: no password recorded yet.
vi.mock("@/lib/config-store", () => ({
  set: vi.fn(async () => {}),
  get: vi.fn(async () => false),
  DATA_DIR: "/test/data",
}));

// /etc/shadow is unreadable in the test environment; `null` is the route's
// "cannot tell", which leaves the config flag to decide — the as-flashed state.
vi.mock("@/lib/system-password", () => ({
  hasOwnerPassword: vi.fn(async () => null),
}));

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
}));

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: vi.fn(async () => new Response(
    JSON.stringify({ session_id: "0f6c1c2e-1111-2222-3333-444455556666", flow: "pkce" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )),
}));

describe("the wizard's own session carries it into provider sign-in (TASK-527)", () => {
  let tmpRoot: string;

  /** Device state on disk, as middleware and route-auth read it. */
  function writeConfig(fields: Record<string, unknown>) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(fields));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-handoff-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.SESSION_SECRET = SESSION_SECRET;
    // `@/lib/auth` is real here, so the install user comes from the environment;
    // pin it, or the chpasswd record is built from whatever account runs the
    // suite (and refused outright on a machine whose username isn't shell-safe).
    process.env.CLAWBOX_USER = "clawbox";
    delete process.env.CLAWBOX_TEST_MODE;
    // A factory-fresh box mid-wizard: no owner credential yet.
    writeConfig({ setup_complete: false, password_configured: false });
  });

  afterEach(() => {
    delete process.env.CLAWBOX_USER;
    delete process.env.CLAWBOX_ROOT;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Drive CredentialsStep's password POST and return the cookie it mints. */
  async function setInitialPassword(): Promise<string> {
    const childProcess = await import("child_process");
    vi.mocked(childProcess.execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: object,
      cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
    ) => {
      cb?.(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);

    const { POST } = await import("@/app/setup-api/system/credentials/route");
    const res = await POST(new Request("http://localhost/setup-api/system/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "the-owners-password" }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, authenticated: true });

    const minted = /clawbox_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(minted, "CredentialsStep must be handed a session cookie").toBeTruthy();
    return `clawbox_session=${minted}`;
  }

  it("mints a session on the initial password set that middleware then honours for the OAuth routes", async () => {
    const cookie = await setInitialPassword();

    // The password now exists on the device, so the bootstrap window is shut —
    // this is the state every request after CredentialsStep sees.
    writeConfig({ setup_complete: false, password_configured: true });
    vi.resetModules();
    const { middleware } = await import("@/middleware");

    for (const p of [
      "/setup-api/hermes/oauth/start",
      "/setup-api/hermes/oauth/submit",
      "/setup-api/hermes/oauth/poll",
      "/setup-api/hermes/oauth/cancel",
    ]) {
      const anonymous = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(anonymous.status, `${p} must refuse an anonymous caller`).toBe(401);

      const asWizard = await middleware(new NextRequest(new URL(`http://localhost${p}`), {
        headers: { cookie },
      }));
      expect(asWizard.status, `${p} must accept the wizard's own session`).toBe(200);
    }
  });

  it("hands that same cookie past the OAuth routes' own guard", async () => {
    // Not a restatement of the middleware case: this is the in-handler check in
    // `ownerGate`, which verifies the cookie independently (it reads
    // .session-secret and config.json itself rather than trusting middleware).
    // A cookie either side rejected would strand the wizard just as badly.
    const cookie = await setInitialPassword();
    writeConfig({ setup_complete: false, password_configured: true });

    const { POST: startPOST } = await import("@/app/setup-api/hermes/oauth/start/route");

    const anonymous = await startPOST(new Request("http://localhost/setup-api/hermes/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "anthropic" }),
    }));
    expect(anonymous.status).toBe(401);

    const asWizard = await startPOST(new Request("http://localhost/setup-api/hermes/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ providerId: "anthropic" }),
    }));
    expect(asWizard.status).toBe(200);
  });

  it("refuses a stranger on the open AP for the whole window, password or not", async () => {
    // The case that started TASK-527: before CredentialsStep runs, the device is
    // broadcasting `ClawBox-Setup` with no key. Nobody in radio range gets to
    // open a provider sign-in session against the box's dashboard, and the
    // allow-list not naming these paths is what guarantees it.
    const { middleware } = await import("@/middleware");

    for (const p of [
      "/setup-api/hermes/oauth",
      "/setup-api/hermes/oauth/start",
      "/setup-api/hermes/oauth/submit",
      "/setup-api/hermes/oauth/poll",
      "/setup-api/hermes/oauth/cancel",
      // A trailing slash is not a way around the allow-list either.
      "/setup-api/hermes/oauth/start/",
    ]) {
      const res = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(res.status, `${p} must be refused during the open-AP window`).toBe(401);
    }
  });

  it("still lets the wizard reach the steps that genuinely predate a password", async () => {
    // The counterweight: gating the OAuth flow must not have cost the wizard the
    // routes it really does need before it can have a credential.
    const { middleware } = await import("@/middleware");

    for (const p of ["/setup-api/setup/status", "/setup-api/wifi/scan", "/setup-api/system/credentials"]) {
      const res = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(res.status, `${p} must stay reachable on first boot`).toBe(200);
    }
  });
});
