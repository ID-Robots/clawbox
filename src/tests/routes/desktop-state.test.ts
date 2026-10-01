/**
 * GET/PUT /setup-api/desktop/state (TASK-1306): each signed-in ClawBox user
 * reads and writes their OWN saved windows, on the device, keyed by the
 * session — never by anything in the request — so a multi-user box never shows
 * one user another's windows or terminal session ids.
 */
import fs from "fs";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { dataDir, store } = await vi.hoisted(async () => {
  const [nodeFs, nodeOs, nodePath] = await Promise.all([import("fs"), import("os"), import("path")]);
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-desktop-state-")),
    store: { get: vi.fn() },
  };
});
vi.mock("@/lib/config-store", () => ({ DATA_DIR: dataDir, get: store.get }));

const auth = vi.hoisted(() => ({ requireSession: vi.fn(), sessionIdentity: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
vi.mock("@/lib/owner-username", () => ({ ownerUsername: () => "Owner.Name" }));

import { GET, PUT } from "@/app/setup-api/desktop/state/route";
import { desktopStateFile, removeDesktopState } from "@/lib/desktop-state-store";
import { snapshotDesktop } from "@/lib/desktop-state";

const URL_ = "http://clawbox.local/setup-api/desktop/state";

function as(user: { username: string; isOwner: boolean } | null) {
  auth.requireSession.mockResolvedValue(null);
  auth.sessionIdentity.mockResolvedValue(user);
}

function put(body: unknown, headers: Record<string, string> = {}) {
  return PUT(new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://clawbox.local", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const aliceDesk = snapshotDesktop([
  {
    id: "terminal-1", appId: "terminal", zIndex: 101, minimized: false, x: 20, y: 30, width: 800, height: 500,
    terminal: { tabs: [{ id: 1, session: "11111111-2222-4333-8444-555555555555" }], activeId: 1, nextId: 2 },
  },
], { savedAt: 10, viewport: { width: 1280, height: 800 } });

const ownerDesk = snapshotDesktop([
  { id: "files-1", appId: "files", zIndex: 100, minimized: false, x: 5, y: 5, width: 600, height: 400 },
], { savedAt: 20 });

beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockResolvedValue(undefined);
  fs.rmSync(path.join(dataDir, "desktop-state"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("/setup-api/desktop/state", () => {
  it("keeps each user's windows apart: what one saves, only they read back", async () => {
    as({ username: "alice", isOwner: false });
    expect((await put({ state: aliceDesk })).status).toBe(200);

    as({ username: "Owner.Name", isOwner: true });
    expect((await put({ state: ownerDesk })).status).toBe(200);
    const ownerRead = await (await GET(new Request(URL_))).json();
    expect(ownerRead).toEqual({ user: "Owner.Name", state: ownerDesk });

    as({ username: "alice", isOwner: false });
    const aliceRead = await (await GET(new Request(URL_))).json();
    expect(aliceRead).toEqual({ user: "alice", state: aliceDesk });

    as({ username: "bob", isOwner: false });
    expect(await (await GET(new Request(URL_))).json()).toEqual({ user: "bob", state: null });
  });

  it("writes the file readable by the web server's account only, under a name rebuilt from a safe alphabet", async () => {
    as({ username: "Owner.Name", isOwner: true });
    await put({ state: ownerDesk });
    const file = desktopStateFile("Owner.Name");
    expect(path.basename(file)).toBe("~4fwner~2e~4eame.json");
    expect(path.dirname(file)).toBe(path.join(dataDir, "desktop-state"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(path.dirname(desktopStateFile("../../etc/passwd"))).toBe(path.join(dataDir, "desktop-state"));
  });

  it("answers the MCP bearer and test mode, which carry no person, as the owner", async () => {
    as(null);
    await put({ state: ownerDesk });
    expect(await (await GET(new Request(URL_))).json()).toEqual({ user: "Owner.Name", state: ownerDesk });
  });

  it("refuses a caller the session gate refuses", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    expect((await GET(new Request(URL_))).status).toBe(401);
    expect((await put({ state: ownerDesk })).status).toBe(401);
    expect(auth.requireSession).toHaveBeenCalledWith(expect.any(Request), { allowNonOwner: true });
  });

  it("refuses a write from another site", async () => {
    as({ username: "alice", isOwner: false });
    const res = await put({ state: aliceDesk }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });

  it.each([
    ["not json", "invalid_json", 400],
    [{ state: { v: 9, windows: [] } }, "invalid_state", 400],
    [{ nothing: true }, "invalid_state", 400],
  ])("refuses %o", async (body, code, status) => {
    as({ username: "alice", isOwner: false });
    const res = await put(body);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it("refuses a body past the cap", async () => {
    as({ username: "alice", isOwner: false });
    const res = await put({ state: { ...aliceDesk, pad: "x".repeat(300 * 1024) } });
    expect(res.status).toBe(413);
  });

  it("stores what it sanitized, not what it was sent", async () => {
    as({ username: "alice", isOwner: false });
    await put({ state: { ...aliceDesk, windows: [...aliceDesk.windows, { id: "evil/../1", appId: "files" }], extra: "dropped" } });
    const saved = JSON.parse(fs.readFileSync(desktopStateFile("alice"), "utf-8"));
    expect(saved).toEqual(aliceDesk);
  });

  it("brings the owner's pre-TASK-1306 workspace back once, minimized, until the first save", async () => {
    store.get.mockResolvedValue([{ appId: "files", minimized: false, x: 1, y: 2, width: 600, height: 400 }]);
    as({ username: "Owner.Name", isOwner: true });
    const first = await (await GET(new Request(URL_))).json();
    expect(store.get).toHaveBeenCalledWith("pref:desktop_open_windows");
    expect(first.state.windows).toEqual([{ id: "files-legacy-0", appId: "files", minimized: true, x: 1, y: 2, width: 600, height: 400 }]);

    await put({ state: ownerDesk });
    expect((await (await GET(new Request(URL_))).json()).state).toEqual(ownerDesk);

    // A non-owner never inherits the owner's preference.
    as({ username: "alice", isOwner: false });
    expect((await (await GET(new Request(URL_))).json()).state).toBeNull();
  });

  it("forgets a removed user's windows", async () => {
    as({ username: "alice", isOwner: false });
    await put({ state: aliceDesk });
    await removeDesktopState("alice");
    expect(await (await GET(new Request(URL_))).json()).toEqual({ user: "alice", state: null });
  });

  it("answers a state file it cannot parse as no state", async () => {
    as({ username: "alice", isOwner: false });
    fs.mkdirSync(path.join(dataDir, "desktop-state"), { recursive: true });
    fs.writeFileSync(desktopStateFile("alice"), "{broken");
    expect(await (await GET(new Request(URL_))).json()).toEqual({ user: "alice", state: null });
  });
});
