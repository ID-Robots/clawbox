// @vitest-environment node
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/route-auth", () => ({ sessionIdentity: vi.fn() }));

import { sessionIdentity } from "@/lib/route-auth";
import { DATA_DIR } from "@/lib/config-store";
import { DELETE, GET, POST } from "@/app/setup-api/apps/public-link/route";
import { MAX_LINKS, createPublicLink, disablePublicLink, listPublicLinks, parseApiAllow } from "@/lib/public-app-links";

/**
 * TASK-1478 — the owner's half of public app links: who may publish, what is
 * written, and that the serving half (scripts/public-app-links.js) accepts
 * exactly what this half writes.
 */
const require_ = createRequire(import.meta.url);
const serving = require_("../../../../scripts/public-app-links.js") as {
  readLinks: (root: string) => { id: string; appId: string; token: string }[];
  validLink: (raw: unknown) => unknown;
};

const ROOT = path.dirname(DATA_DIR);
const LINKS_DIR = path.join(DATA_DIR, "public-links");

function makeApp(id: string, meta: Record<string, unknown> = { name: id }) {
  const dir = path.join(DATA_DIR, "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
}

function req(method: string, body?: unknown): Request {
  return new Request("http://box/setup-api/apps/public-link", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const owner = { username: "clawbox", isOwner: true } as never;
const member = { username: "guest", isOwner: false } as never;

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  makeApp("notes");
  vi.mocked(sessionIdentity).mockResolvedValue(owner);
  delete process.env.CLAWBOX_TEST_MODE;
});

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("who may publish", () => {
  it("refuses a caller with no owner session — the agent's MCP bearer included", async () => {
    vi.mocked(sessionIdentity).mockResolvedValue(null);
    const bearer = new Request("http://box/setup-api/apps/public-link", { method: "POST", headers: { authorization: "Bearer mcp-token" }, body: JSON.stringify({ appId: "notes", mode: "permanent" }) });
    expect((await POST(bearer)).status).toBe(401);
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await DELETE(req("DELETE", { appId: "notes" }))).status).toBe(401);
    expect(fs.existsSync(path.join(LINKS_DIR, "links.json"))).toBe(false);
  });

  it("refuses a signed-in ClawBox user who is not the owner", async () => {
    vi.mocked(sessionIdentity).mockResolvedValue(member);
    const res = await POST(req("POST", { appId: "notes", mode: "permanent" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
  });
});

describe("publishing", () => {
  it("writes a 0600 list the serving side accepts, with a fresh 256-bit token", async () => {
    const res = await POST(req("POST", { appId: "notes", mode: "temporary", ttlMinutes: 60, apiAllow: ["/api/scores", " ", "/api/scores"] }));
    expect(res.status).toBe(201);
    const { link } = await res.json();
    expect(link).toMatchObject({ appId: "notes", mode: "temporary", state: "starting", url: null, apiAllow: ["/api/scores"] });
    expect(JSON.stringify(link)).not.toMatch(/token/);

    const file = path.join(LINKS_DIR, "links.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const served = serving.readLinks(ROOT);
    expect(served).toHaveLength(1);
    expect(served[0].appId).toBe("notes");
    expect(Buffer.from(served[0].token, "base64url")).toHaveLength(32);
    expect(fs.readFileSync(path.join(LINKS_DIR, "audit.log"), "utf-8")).toContain("\"created\"");
    expect(fs.readFileSync(path.join(LINKS_DIR, "audit.log"), "utf-8")).not.toContain(served[0].token);
  });

  it.each([
    [{ appId: "nope", mode: "permanent" }, 404],
    [{ appId: "../etc", mode: "permanent" }, 400],
    [{ appId: "__proto__", mode: "permanent" }, 400],
    [{ appId: "notes", mode: "forever" }, 400],
    [{ appId: "notes", mode: "temporary" }, 400],
    [{ appId: "notes", mode: "temporary", ttlMinutes: 0 }, 400],
    [{ appId: "notes", mode: "temporary", ttlMinutes: 60 * 24 * 31 }, 400],
    [{ appId: "notes", mode: "permanent", apiAllow: ["api"] }, 400],
    [{ appId: "notes", mode: "permanent", apiAllow: ["/a/../../b"] }, 400],
  ])("refuses %j", async (body, status) => {
    expect((await POST(req("POST", body))).status).toBe(status);
    expect(serving.readLinks(ROOT)).toHaveLength(0);
  });

  it("one link per app, and a cap on how many apps are public", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent" });
    expect((await POST(req("POST", { appId: "notes", mode: "permanent" }))).status).toBe(409);
    for (let i = 1; i < MAX_LINKS; i += 1) {
      makeApp(`app${i}`);
      await createPublicLink({ appId: `app${i}`, mode: "permanent" });
    }
    makeApp("onetoomany");
    const res = await POST(req("POST", { appId: "onetoomany", mode: "permanent" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("too_many");
  });

  it("parseApiAllow", () => {
    expect(parseApiAllow(undefined)).toEqual([]);
    expect(parseApiAllow(["/api/a", "/api/a", ""])).toEqual(["/api/a"]);
    expect(() => parseApiAllow("x")).toThrow();
    expect(() => parseApiAllow(Array.from({ length: 17 }, (_, i) => `/a${i}`))).toThrow();
  });
});

describe("listing", () => {
  it("shows the full link only once the tunnel reports a trycloudflare origin", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent" });
    const id = serving.readLinks(ROOT)[0].id;
    const token = serving.readLinks(ROOT)[0].token;
    expect((await listPublicLinks())[0]).toMatchObject({ state: "offline", url: null });

    fs.writeFileSync(path.join(LINKS_DIR, "runtime.json"), JSON.stringify({ [id]: { url: "https://evil.example.com", state: "live" } }));
    expect((await listPublicLinks())[0].url).toBeNull();

    fs.writeFileSync(path.join(LINKS_DIR, "runtime.json"), JSON.stringify({ [id]: { url: "https://calm-river.trycloudflare.com", state: "live" } }));
    const res = await GET(req("GET"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { links } = await res.json();
    expect(links[0]).toMatchObject({ state: "live", url: `https://calm-river.trycloudflare.com/?k=${token}` });

    makeApp("notes", { name: "notes", port: 4321 });
    expect((await listPublicLinks())[0].url).toBe(`https://calm-river.trycloudflare.com/apps/notes/?k=${token}`);
  });

  it("drops expired temporary links from the list", async () => {
    const t0 = Date.now();
    await createPublicLink({ appId: "notes", mode: "temporary", ttlMinutes: 1 }, t0);
    expect(await listPublicLinks(t0 + 30_000)).toHaveLength(1);
    expect(await listPublicLinks(t0 + 60_000)).toHaveLength(0);
    expect(serving.readLinks(ROOT)).toHaveLength(0);
    expect(fs.readFileSync(path.join(LINKS_DIR, "audit.log"), "utf-8")).toContain("\"expired\"");
  });
});

describe("disabling", () => {
  it("removes the link at once; a new link gets a new token", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent" });
    const first = serving.readLinks(ROOT)[0];
    const res = await DELETE(req("DELETE", { appId: "notes" }));
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(serving.readLinks(ROOT)).toHaveLength(0);
    expect(fs.readFileSync(path.join(LINKS_DIR, "audit.log"), "utf-8")).toContain("\"disabled\"");

    await createPublicLink({ appId: "notes", mode: "permanent" });
    const second = serving.readLinks(ROOT)[0];
    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
  });

  it("is a no-op for an app with no link", async () => {
    expect(await disablePublicLink("notes")).toBe(false);
    expect((await DELETE(req("DELETE", {}))).status).toBe(400);
  });

  it("an unreadable list stops an uninstall before the app is removed", async () => {
    // A directory where the list should be: reading it fails (EISDIR), as an
    // unreadable file would, whoever the tests run as.
    fs.mkdirSync(path.join(LINKS_DIR, "links.json"), { recursive: true });
    const during = vi.fn(async () => undefined);
    await expect(disablePublicLink("notes", "app_uninstalled", during)).rejects.toThrow();
    expect(during).not.toHaveBeenCalled();
  });

  it("a list that cannot be rewritten stops an uninstall before the app is removed", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent" });
    // The atomic write's rename over links.json fails once.
    const rename = vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    const during = vi.fn(async () => undefined);
    try {
      await expect(disablePublicLink("notes", "app_uninstalled", during)).rejects.toThrow("EIO");
    } finally {
      rename.mockRestore();
    }
    expect(during).not.toHaveBeenCalled();
    expect(serving.readLinks(ROOT)).toHaveLength(1);
  });

  it("an entry the serving side would serve without apiAllow is one the owner can see and disable", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent" });
    const file = path.join(LINKS_DIR, "links.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    delete stored.links[0].apiAllow;
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    expect(serving.readLinks(ROOT)).toHaveLength(1);
    expect((await listPublicLinks())[0]).toMatchObject({ appId: "notes", apiAllow: [] });
    expect(await disablePublicLink("notes")).toBe(true);
    expect(serving.readLinks(ROOT)).toHaveLength(0);
  });
});
