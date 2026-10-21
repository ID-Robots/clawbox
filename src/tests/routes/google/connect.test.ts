import crypto from "crypto";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveEnv } from "@/tests/helpers/env";

// The connect and disconnect cases run the real scripts/register-mcp.sh (bash +
// python3): vitest's 5 s defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * /setup-api/google/connect — "Connect Google": the owner's Calendar + Drive
 * through ClawBox's own Google client, behind CLAWBOX_GOOGLE_CONNECT (off by
 * default). Pinned: with the flag off every route is a 404 and nothing is
 * written; with it on only the owner, from this box's pages, can connect; the
 * grant lands in HERMES_HOME in the shape the google-workspace skill reads;
 * the real register-mcp.sh then takes the skill off skills.disabled, and a
 * disconnect puts it back. The AI-model sign-in files are never touched.
 */

const h = vi.hoisted(() => ({
  denied: null as Response | null,
  sameOrigin: vi.fn(() => true),
  restart: vi.fn(async (): Promise<boolean | null> => null),
}));

vi.mock("@/lib/route-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-auth")>()),
  requireSession: vi.fn(async () => h.denied),
}));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/clawbox-mcp-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-mcp-registration")>()),
  restartHermesGatewayIfRunning: h.restart,
}));

const REPO = path.resolve(__dirname, "../../../..");
const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const DRIVE = "https://www.googleapis.com/auth/drive.file";
// Placeholders in the shape of a Google Desktop client; never a real one.
const CLIENT_ID = "000000000000-test.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";

const CAN_RUN_SCRIPT =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0;
const withScript = CAN_RUN_SCRIPT ? describe : describe.skip;

let root: string;
let home: string;
let hermesHome: string;
let editionFile: string;
let restoreEnv: () => void;
let routeAuth: typeof import("@/lib/route-auth");
let GET: (req: Request) => Promise<Response>;
let START: (req: Request) => Promise<Response>;
let EXCHANGE: (req: Request) => Promise<Response>;
let DISCONNECT: (req: Request) => Promise<Response>;

const tokenPath = () => path.join(hermesHome, "google_token.json");
const secretPath = () => path.join(hermesHome, "google_client_secret.json");
const statePath = () => path.join(root, "data", "google-connect-state.json");
const configPath = () => path.join(hermesHome, "config.yaml");

function req(route: string, body?: unknown): Request {
  return new Request(`http://box.local/setup-api/google/connect${route}`, body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

let editionWrites = 0;
function setEdition(edition: string): void {
  fs.writeFileSync(editionFile, `CLAWBOX_EDITION=${edition}\n`);
  // The edition read is cached by mtime; give every write its own.
  editionWrites += 1;
  const t = new Date(Date.UTC(2026, 0, 1) + editionWrites * 1000);
  fs.utimesSync(editionFile, t, t);
}

function disabledSkills(): unknown {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath()],
    { encoding: "utf-8" },
  );
  return (JSON.parse(out).skills as Record<string, unknown> | undefined)?.disabled;
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3599,
    scope: `${CALENDAR} ${DRIVE}`,
    token_type: "Bearer",
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Start a sign-in and hand back the state Google would echo in the redirect. */
async function started(): Promise<{ url: URL; state: string }> {
  const res = await START(req("/start", {}));
  expect(res.status).toBe(200);
  const url = new URL((await res.json()).url);
  return { url, state: url.searchParams.get("state") ?? "" };
}

beforeAll(async () => {
  restoreEnv = saveEnv(
    "CLAWBOX_ROOT", "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_BIN", "BUN_BIN",
    "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE", "CLAWBOX_GOOGLE_CONNECT", "CLAWBOX_GOOGLE_CLIENT_ID",
    "CLAWBOX_GOOGLE_CLIENT_SECRET", "CLAWBOX_GOOGLE_REDIRECT_URI",
  );
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-google-connect-root-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-google-connect-home-"));
  hermesHome = path.join(home, ".hermes");
  editionFile = path.join(home, "edition.env");
  // What register-mcp.sh insists on before it writes: the MCP entry point, and
  // the hermes/bun binaries it names (stand-ins that succeed).
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  fs.symlinkSync(path.join(REPO, "scripts"), path.join(root, "scripts"));
  for (const bin of ["fake-hermes", "fake-bun"]) {
    fs.writeFileSync(path.join(home, bin), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(home, bin), 0o755);
  }
  process.env.CLAWBOX_ROOT = root;
  process.env.HOME = home;
  process.env.HERMES_HOME = hermesHome;
  process.env.HERMES_CONFIG = configPath();
  process.env.HERMES_BIN = path.join(home, "fake-hermes");
  process.env.BUN_BIN = path.join(home, "fake-bun");
  process.env.CLAWBOX_EDITION_FILE = editionFile;
  delete process.env.CLAWBOX_EDITION;
  setEdition("hermes");
  vi.resetModules();
  routeAuth = await import("@/lib/route-auth");
  ({ GET } = await import("@/app/setup-api/google/connect/route"));
  ({ POST: START } = await import("@/app/setup-api/google/connect/start/route"));
  ({ POST: EXCHANGE } = await import("@/app/setup-api/google/connect/exchange/route"));
  ({ POST: DISCONNECT } = await import("@/app/setup-api/google/connect/disconnect/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(hermesHome, { recursive: true, force: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(configPath(), "model:\n  default: x\n");
  for (const f of fs.readdirSync(path.join(root, "data"))) fs.rmSync(path.join(root, "data", f), { force: true });
  setEdition("hermes");
  process.env.CLAWBOX_GOOGLE_CONNECT = "1";
  process.env.CLAWBOX_GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.CLAWBOX_GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  delete process.env.CLAWBOX_GOOGLE_REDIRECT_URI;
  h.denied = null;
  h.sameOrigin.mockReturnValue(true);
  h.restart.mockReset();
  h.restart.mockResolvedValue(null);
  vi.mocked(routeAuth.requireSession).mockClear();
});

describe("with the flag off", () => {
  it.each(["", "0", "true"])("answers 404 on every route and writes nothing (CLAWBOX_GOOGLE_CONNECT=%j)", async (flag) => {
    process.env.CLAWBOX_GOOGLE_CONNECT = flag;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await GET(req(""))).status).toBe(404);
    expect((await START(req("/start", {}))).status).toBe(404);
    expect((await EXCHANGE(req("/exchange", { redirect: "http://127.0.0.1:1/?code=x" }))).status).toBe(404);
    expect((await DISCONNECT(req("/disconnect", {}))).status).toBe(404);
    expect(fs.existsSync(statePath())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeAuth.requireSession).not.toHaveBeenCalled();
  });

  it("leaves a token already on the box alone", async () => {
    process.env.CLAWBOX_GOOGLE_CONNECT = "";
    fs.writeFileSync(tokenPath(), JSON.stringify({ refresh_token: "r", client_id: CLIENT_ID }));
    expect((await DISCONNECT(req("/disconnect", {}))).status).toBe(404);
    expect(fs.existsSync(tokenPath())).toBe(true);
  });
});

describe("who may use it", () => {
  it("asks for the owner on every route", async () => {
    await GET(req(""));
    await START(req("/start", {}));
    expect(routeAuth.requireSession).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(routeAuth.requireSession).mock.calls) {
      expect(call[1]).toEqual({ ownerOnly: true });
    }
  });

  it("passes the owner gate's refusal through — the agent's bearer gets no sign-in", async () => {
    h.denied = new Response(JSON.stringify({ error: "Only the box owner can do this.", code: "owner_only" }), { status: 403 });
    const res = await START(req("/start", {}));
    expect(res.status).toBe(403);
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("refuses a write from another origin", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await START(req("/start", {}));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(fs.existsSync(statePath())).toBe(false);
  });
});

describe("GET", () => {
  it("reports an unconfigured client", async () => {
    delete process.env.CLAWBOX_GOOGLE_CLIENT_ID;
    expect(await (await GET(req(""))).json()).toEqual({
      configured: false, hermes: true, connected: false, ownClient: false, scopes: [], pending: false,
    });
  });

  it("does not count a grant without a refresh token as connected", async () => {
    fs.writeFileSync(tokenPath(), JSON.stringify({ token: "a", client_id: CLIENT_ID }));
    expect((await (await GET(req(""))).json()).connected).toBe(false);
  });

  it("tells an own-client grant from ClawBox's", async () => {
    fs.writeFileSync(tokenPath(), JSON.stringify({ refresh_token: "r", client_id: "someone-elses-client", scopes: [CALENDAR] }));
    expect(await (await GET(req(""))).json()).toMatchObject({ connected: true, ownClient: true, scopes: [CALENDAR] });
  });
});

describe("start", () => {
  it("refuses without a provisioned client", async () => {
    delete process.env.CLAWBOX_GOOGLE_CLIENT_ID;
    const res = await START(req("/start", {}));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("not_configured");
  });

  it("refuses on an edition without Hermes", async () => {
    setEdition("openclaw");
    const res = await START(req("/start", {}));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_hermes");
  });

  it("builds Google's consent URL with PKCE and keeps the verifier on the box", async () => {
    const { url, state } = await started();
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:1");
    expect(q.get("scope")).toBe(`${CALENDAR} ${DRIVE}`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(state.length).toBeGreaterThan(20);
    // The secret and the verifier never travel to the browser.
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    const stored = JSON.parse(fs.readFileSync(statePath(), "utf-8"));
    expect(stored.state).toBe(state);
    expect(q.get("code_challenge")).toBe(
      crypto.createHash("sha256").update(stored.codeVerifier).digest("base64url"),
    );
    expect(url.toString()).not.toContain(stored.codeVerifier);
    expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    expect((await (await GET(req(""))).json()).pending).toBe(true);
  });

  it("leaves an AI-model sign-in in flight alone", async () => {
    const aiState = path.join(root, "data", "oauth-state.json");
    const handoff = path.join(root, "data", "oauth-device-tokens.json");
    fs.writeFileSync(aiState, "{\"provider\":\"anthropic\"}");
    fs.writeFileSync(handoff, "{\"provider\":\"anthropic\"}");
    await started();
    expect(fs.readFileSync(aiState, "utf-8")).toBe("{\"provider\":\"anthropic\"}");
    expect(fs.readFileSync(handoff, "utf-8")).toBe("{\"provider\":\"anthropic\"}");
  });
});

describe("exchange — refusals", () => {
  it("needs a started sign-in", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await EXCHANGE(req("/exchange", { redirect: "http://127.0.0.1:1/?code=c" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_session");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body without the pasted address", async () => {
    expect((await EXCHANGE(req("/exchange", {}))).status).toBe(400);
    expect((await EXCHANGE(req("/exchange", { redirect: "   " }))).status).toBe(400);
  });

  it("answers an unprovisioned client before it reads the body, whatever was pasted", async () => {
    delete process.env.CLAWBOX_GOOGLE_CLIENT_ID;
    for (const body of [{}, { redirect: "   " }, { redirect: "http://127.0.0.1:1/?code=c" }]) {
      const res = await EXCHANGE(req("/exchange", body));
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("not_configured");
    }
  });

  it("refuses an address from another sign-in and drops the pending one", async () => {
    await started();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await EXCHANGE(req("/exchange", { redirect: "http://127.0.0.1:1/?state=forged&code=c" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("state_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("refuses an expired sign-in", async () => {
    await started();
    const stored = JSON.parse(fs.readFileSync(statePath(), "utf-8"));
    fs.writeFileSync(statePath(), JSON.stringify({ ...stored, createdAt: Date.now() - 11 * 60 * 1000 }));
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${stored.state}&code=c` }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("expired");
  });

  it("reports a refusal on Google's page", async () => {
    const { state } = await started();
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?error=access_denied&state=${state}` }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("denied");
  });

  it("stores nothing when Google refuses the code", async () => {
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/expired or was already used/);
    expect(fs.existsSync(tokenPath())).toBe(false);
  });

  it("refuses, and revokes, a grant without Calendar or Drive", async () => {
    const { state } = await started();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ scope: "openid" }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_scopes");
    expect(fetchMock.mock.calls[1][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(fs.existsSync(tokenPath())).toBe(false);
  });

  it("refuses a grant without a refresh token", async () => {
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: undefined }))
      .mockResolvedValueOnce(new Response("", { status: 200 })));
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("no_refresh_token");
    expect(fs.existsSync(tokenPath())).toBe(false);
  });
});

withScript("connect and disconnect, through the real register-mcp.sh", () => {
  it("stores the grant for the skill, enables it, and puts it back on disconnect", async () => {
    // A box that booted before: register-mcp.sh has google-workspace disabled.
    await DISCONNECT(req("/disconnect", {}));
    expect(disabledSkills()).toEqual(["himalaya", "email-inbox-triage", "google-workspace"]);

    const { state } = await started();
    const verifier = JSON.parse(fs.readFileSync(statePath(), "utf-8")).codeVerifier;
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=4%2F0Atest&scope=x` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true, hermes: true, connected: true, ownClient: false, scopes: [CALENDAR, DRIVE], pending: false, applied: true,
    });

    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "4/0Atest",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: "http://127.0.0.1:1",
      code_verifier: verifier,
    });

    // google-auth's authorized-user JSON, at 0600, under HERMES_HOME.
    const token = JSON.parse(fs.readFileSync(tokenPath(), "utf-8"));
    expect(token).toMatchObject({
      token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scopes: [CALENDAR, DRIVE],
    });
    expect(token.expiry).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(secretPath(), "utf-8"))).toEqual({
      installed: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://127.0.0.1:1"],
      },
    });
    expect(fs.statSync(secretPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(statePath())).toBe(false);
    // The harness side: the skill is off the distractor list now.
    expect(disabledSkills()).toEqual(["himalaya", "email-inbox-triage"]);
    expect(h.restart).toHaveBeenCalled();

    const revoke = vi.fn().mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", revoke);
    const off = await DISCONNECT(req("/disconnect", {}));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ connected: false, revoked: true, applied: true });
    expect(revoke.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(revoke.mock.calls[0][1].body)).toBe("token=test-refresh-token");
    expect(fs.existsSync(tokenPath())).toBe(false);
    expect(fs.existsSync(secretPath())).toBe(false);
    expect(disabledSkills()).toEqual(["himalaya", "email-inbox-triage", "google-workspace"]);
  });

  it("keeps only the scopes Google granted, and still connects with one of them", async () => {
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse({ scope: CALENDAR })));
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }));
    expect(res.status).toBe(200);
    expect((await res.json()).scopes).toEqual([CALENDAR]);
    expect(JSON.parse(fs.readFileSync(tokenPath(), "utf-8")).scopes).toEqual([CALENDAR]);
  });

  it("never overwrites the owner's own client file", async () => {
    const own = { installed: { client_id: "owners-own-client", client_secret: "owners-secret" } };
    fs.writeFileSync(secretPath(), JSON.stringify(own));
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()));
    expect((await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }))).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(secretPath(), "utf-8"))).toEqual(own);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 200 })));
    expect((await DISCONNECT(req("/disconnect", {}))).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(secretPath(), "utf-8"))).toEqual(own);
  });

  it("says so, never ok, when the grant could not be removed from the box", async () => {
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()));
    expect((await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }))).status).toBe(200);
    const kept = fs.readFileSync(tokenPath(), "utf-8");

    const fsp = (await import("fs/promises")).default;
    const realUnlink = fsp.unlink.bind(fsp);
    const unlink = vi.spyOn(fsp, "unlink").mockImplementation(async (target) =>
      String(target) === tokenPath()
        ? Promise.reject(Object.assign(new Error("read-only file system"), { code: "EROFS" }))
        : realUnlink(target),
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 200 })));
    const res = await DISCONNECT(req("/disconnect", {}));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("disconnect_failed");
    expect(fs.readFileSync(tokenPath(), "utf-8")).toBe(kept);
    unlink.mockRestore();
    quiet.mockRestore();
  });

  it("leaves a grant made with the owner's own client alone", async () => {
    const grant = JSON.stringify({ refresh_token: "r", client_id: "owners-own-client" });
    fs.writeFileSync(tokenPath(), grant);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await DISCONNECT(req("/disconnect", {}));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("own_client");
    expect(fs.readFileSync(tokenPath(), "utf-8")).toBe(grant);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a token file it did not write alone on disconnect", async () => {
    fs.writeFileSync(tokenPath(), "{\"token\": \"a\"}");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await DISCONNECT(req("/disconnect", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: false, revoked: false });
    expect(fs.readFileSync(tokenPath(), "utf-8")).toBe("{\"token\": \"a\"}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when the gateway did not restart", async () => {
    h.restart.mockResolvedValue(false);
    const { state } = await started();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokenResponse()));
    const res = await EXCHANGE(req("/exchange", { redirect: `http://127.0.0.1:1/?state=${state}&code=c` }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ connected: true, applied: false, code: "apply_failed" });
  });
});
