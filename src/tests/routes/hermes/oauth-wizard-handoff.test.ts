import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BOOTSTRAP_ALLOWED_EXACT,
  BOOTSTRAP_ALLOWED_PREFIXES,
  isBootstrapAllowedPath,
} from "@/lib/setup-api-gate";

/**
 * The Hermes provider sign-in flow (`/setup-api/hermes/oauth/{start,submit,
 * poll,cancel}`) against the first-boot window — TASK-527.
 *
 * `start` opens a real OAuth session against the owner's dashboard and `submit`
 * feeds that session an authorization code, so both mint credential material on
 * the box. Under the old deny-list gate neither was ever named, which left them
 * answering anyone in radio range of the OPEN `ClawBox-Setup` AP the device
 * broadcasts for this whole window. TASK-443 closed that by inverting
 * `src/lib/setup-api-gate.ts` to an allow-list: the four paths are not on it, so
 * the default is now 401.
 *
 * Which means the thing worth pinning is no longer "is there a gate" but the
 * two ways the gate could quietly stop holding:
 *
 *   1. Somebody adds a prefix to the allow-list that happens to cover the
 *      subtree, and all four reopen at once with no test failing — the
 *      allow-list is a list of PREFIXES, and `/setup-api/hermes/oauth` is one
 *      plausible entry away from being on it.
 *   2. The cookie `system/credentials` mints on the initial password set stops
 *      being a cookie middleware accepts. Nothing else would catch that: the
 *      other suites check the two halves separately (credentials.test.ts that a
 *      cookie is minted, middleware.test.ts that these paths refuse an
 *      anonymous caller), and neither notices if the two no longer meet. The
 *      failure it would cause is the worst one available here — a fresh box
 *      that cannot finish AIModelsStep, whose only other way in is a password
 *      the user chose thirty seconds ago.
 *
 * So this suite drives the real handoff rather than a fixture: `@/lib/auth` is
 * NOT mocked, the cookie asserted below is the one the route really signs, and
 * it is checked by the real middleware reading a real config.json off a temp
 * CLAWBOX_ROOT.
 */

const SESSION_SECRET = "wizard-handoff-secret-0123456789abcdef";

const OAUTH_PATHS = [
  "/setup-api/hermes/oauth/start",
  "/setup-api/hermes/oauth/submit",
  "/setup-api/hermes/oauth/poll",
  "/setup-api/hermes/oauth/cancel",
] as const;

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

describe("the OAuth routes and the first-boot window (TASK-527)", () => {
  let tmpRoot: string;

  /** Device state on disk, as middleware reads it. */
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
    delete process.env.CLAWBOX_TEST_MODE;
    // A factory-fresh box mid-wizard: no owner credential yet.
    writeConfig({ setup_complete: false, password_configured: false });
  });

  afterEach(() => {
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

    const setCookie = res.headers.get("set-cookie") ?? "";
    const minted = /clawbox_session=([^;]+)/.exec(setCookie)?.[1];
    expect(minted, "CredentialsStep must be handed a session cookie").toBeTruthy();
    return `clawbox_session=${minted}`;
  }

  it("refuses a stranger on the open AP for the whole pre-setup window", async () => {
    // The case TASK-527 was raised for: before CredentialsStep runs, the device
    // is broadcasting `ClawBox-Setup` with no key, and nobody in radio range
    // gets to open a provider sign-in session against the box's dashboard.
    const { middleware } = await import("@/middleware");

    for (const p of [
      "/setup-api/hermes/oauth",
      ...OAUTH_PATHS,
      // A trailing slash is not a way around the allow-list either.
      "/setup-api/hermes/oauth/start/",
      // Nor is a cased path: middleware lower-cases before it matches.
      "/setup-api/hermes/oauth/Submit",
    ]) {
      const res = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(res.status, `${p} must be refused during the open-AP window`).toBe(401);
    }
  });

  it("still refuses an anonymous caller once setup is finished", async () => {
    // The other end of the device's life. The pre-setup 401 comes from the path
    // not being on the bootstrap allow-list; this one comes from the session
    // gate, so it is a genuinely different code path in middleware and worth
    // asserting rather than assuming.
    writeConfig({ setup_complete: true, password_configured: true });
    const { middleware } = await import("@/middleware");

    for (const p of OAUTH_PATHS) {
      const res = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(res.status, `${p} must refuse an anonymous caller post-setup`).toBe(401);
    }
  });

  it("mints a session on the initial password set that middleware then honours", async () => {
    const cookie = await setInitialPassword();

    // The password now exists on the device, so the bootstrap window is shut —
    // this is the state every request after CredentialsStep sees.
    writeConfig({ setup_complete: false, password_configured: true });
    vi.resetModules();
    const { middleware } = await import("@/middleware");

    for (const p of OAUTH_PATHS) {
      const anonymous = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(anonymous.status, `${p} must refuse an anonymous caller`).toBe(401);

      const asWizard = await middleware(new NextRequest(new URL(`http://localhost${p}`), {
        headers: { cookie },
      }));
      expect(asWizard.status, `${p} must accept the wizard's own session`).toBe(200);
    }
  });

  it("still lets the wizard reach the steps that genuinely predate a password", async () => {
    // The counterweight: keeping the OAuth flow gated must not have cost the
    // wizard the routes it really does need before it can have a credential.
    const { middleware } = await import("@/middleware");

    for (const p of ["/setup-api/setup/status", "/setup-api/wifi/scan", "/setup-api/system/credentials"]) {
      const res = await middleware(new NextRequest(new URL(`http://localhost${p}`)));
      expect(res.status, `${p} must stay reachable on first boot`).toBe(200);
    }
  });

  it("keeps the OAuth subtree off the bootstrap allow-list itself", () => {
    // Failure mode (1) in the header, caught at the list rather than through
    // middleware: the entries are PREFIXES, so one plausible addition —
    // `/setup-api/hermes` or `/setup-api/hermes/oauth`, to let the wizard read
    // the provider list a step earlier — silently reopens all four leaves.
    // Asserting against the list means such an edit fails here, next to the
    // comment explaining why it must not be made.
    for (const p of ["/setup-api/hermes/oauth", ...OAUTH_PATHS]) {
      expect(isBootstrapAllowedPath(p), `${p} must not be bootstrap-allowed`).toBe(false);
    }

    // The same property stated against the list rather than through the
    // matcher, so the diff that breaks it says which entry did it.
    for (const entry of [...BOOTSTRAP_ALLOWED_PREFIXES, ...BOOTSTRAP_ALLOWED_EXACT]) {
      expect(entry.includes("/oauth"), `allow-list entry ${entry} names the OAuth subtree`).toBe(false);
    }
  });
});
