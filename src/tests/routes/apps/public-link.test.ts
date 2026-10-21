// @vitest-environment node
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/route-auth", () => ({ sessionIdentity: vi.fn() }));
// The box account's password check (unix_chkpwd) — never the real helper here.
vi.mock("@/lib/auth", async (original) => ({ ...(await original<typeof import("@/lib/auth")>()), verifyPassword: vi.fn(async () => false) }));

import { sessionIdentity } from "@/lib/route-auth";
import { verifyPassword } from "@/lib/auth";
import { DATA_DIR } from "@/lib/config-store";
import { DELETE, GET, PATCH, POST } from "@/app/setup-api/apps/public-link/route";
import { MAX_API_ALLOW, MAX_LINKS, createPublicLink, disablePublicLink, listPublicLinks, parseApiAllow, setPublicLinkPassword, verifyLinkPasswordHash } from "@/lib/public-app-links";

/**
 * TASK-1478 — the owner's half of public app links: who may publish, what is
 * written, and that the serving half (scripts/public-app-links.js) accepts
 * exactly what this half writes.
 */
const require_ = createRequire(import.meta.url);
const serving = require_("../../../../scripts/public-app-links.js") as {
  readLinks: (root: string) => { id: string; appId: string; token: string; password: { hash: string; key: string } | null }[];
  validLink: (raw: unknown) => unknown;
  methodAllowed: (link: unknown, method: string, rest: string) => boolean;
  verifyPasswordHash: (password: string, hash: string) => Promise<boolean>;
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
  vi.mocked(verifyPassword).mockReset().mockResolvedValue(false);
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

  it("lets another signed-in ClawBox user publish, and shows them a live link with its token masked", async () => {
    vi.mocked(sessionIdentity).mockResolvedValue(member);
    const res = await POST(req("POST", { appId: "notes", mode: "permanent" }));
    expect(res.status).toBe(201);

    const { id, token } = serving.readLinks(ROOT)[0];
    fs.writeFileSync(path.join(LINKS_DIR, "runtime.json"), JSON.stringify({ [id]: { url: "https://calm-river.trycloudflare.com", state: "live" } }));
    const theirs = (await (await GET(req("GET"))).json()).links;
    expect(theirs[0]).toMatchObject({ state: "live", tokenMasked: true });
    expect(theirs[0].url).not.toContain(token);
    expect(theirs[0].url).toMatch(/^https:\/\/calm-river\.trycloudflare\.com\/\?k=•+$/);

    // The owner sees the same link in clear.
    vi.mocked(sessionIdentity).mockResolvedValue({ username: "clawbox", isOwner: true });
    const owners = (await (await GET(req("GET"))).json()).links;
    expect(owners[0].url).toBe(`https://calm-river.trycloudflare.com/?k=${token}`);
    expect(owners[0].tokenMasked).toBeUndefined();
  });
});

describe("publishing", () => {
  it("writes a 0600 list the serving side accepts, with a fresh 256-bit token", async () => {
    const res = await POST(req("POST", { appId: "notes", mode: "temporary", ttlMinutes: 60, apiAllow: ["/api/scores", " ", "/api/scores"] }));
    expect(res.status).toBe(201);
    const { link } = await res.json();
    expect(link).toMatchObject({ appId: "notes", mode: "temporary", state: "starting", url: null, apiAllow: ["/api", "/api/scores"], apiReadOnly: true });
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

  /**
   * A link that cannot reach the app's own API is a blank page for the
   * visitor, so a new link opens it — for reading only unless the owner asks
   * for read and write: strangers changing the app's data is an explicit choice.
   */
  it("opens the app's own /api read-only by default, read-write or not at all when asked, and the serving side enforces the choice", async () => {
    const res = await POST(req("POST", { appId: "notes", mode: "permanent" }));
    expect((await res.json()).link).toMatchObject({ apiAllow: ["/api"], apiReadOnly: true });
    let served = serving.validLink(serving.readLinks(ROOT)[0]) as { apiAllow: string[]; apiReadOnly: boolean };
    expect(served.apiAllow).toEqual(["/api"]);
    expect(served.apiReadOnly).toBe(true);
    expect(serving.methodAllowed(served, "GET", "/api/items")).toBe(true);
    expect(serving.methodAllowed(served, "POST", "/api/items")).toBe(false);
    expect(serving.methodAllowed(served, "POST", "/upload")).toBe(false);
    await disablePublicLink("notes");

    await createPublicLink({ appId: "notes", mode: "permanent", apiAccess: "full" });
    expect((await listPublicLinks())[0]).toMatchObject({ apiAllow: ["/api"], apiReadOnly: false });
    served = serving.validLink(serving.readLinks(ROOT)[0]) as typeof served;
    expect(serving.methodAllowed(served, "GET", "/api/items")).toBe(true);
    expect(serving.methodAllowed(served, "POST", "/api/items")).toBe(true);
    expect(serving.methodAllowed(served, "POST", "/upload")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(LINKS_DIR, "links.json"), "utf-8")).links[0]).not.toHaveProperty("apiReadOnly");
    await disablePublicLink("notes");

    await createPublicLink({ appId: "notes", mode: "permanent", apiAccess: "read", apiAllow: ["/upload"] });
    expect((await listPublicLinks())[0]).toMatchObject({ apiAllow: ["/api", "/upload"], apiReadOnly: true });
    served = serving.validLink(serving.readLinks(ROOT)[0]) as typeof served;
    expect(served.apiReadOnly).toBe(true);
    expect(serving.methodAllowed(served, "GET", "/api/items")).toBe(true);
    expect(serving.methodAllowed(served, "POST", "/api/items")).toBe(false);
    expect(serving.methodAllowed(served, "POST", "/upload")).toBe(false);
    await disablePublicLink("notes");

    await createPublicLink({ appId: "notes", mode: "permanent", apiAccess: "none" });
    expect((await listPublicLinks())[0]).toMatchObject({ apiAllow: [], apiReadOnly: false });
    served = serving.validLink(serving.readLinks(ROOT)[0]) as typeof served;
    expect(serving.methodAllowed(served, "GET", "/api/items")).toBe(false);
    await disablePublicLink("notes");

    expect((await POST(req("POST", { appId: "notes", mode: "permanent", apiAccess: "all" }))).status).toBe(400);
    expect(serving.readLinks(ROOT)).toHaveLength(0);
  });

  /** The serving side matches API paths by prefix, so "/" and "/api/" open the app's own /api as surely as "/api". */
  it("refuses a typed path that would open the app's own /api again on a link whose API is off", async () => {
    for (const apiAllow of [["/"], ["/api"], ["/api/"], ["/upload", "/api//"]]) {
      const res = await POST(req("POST", { appId: "notes", mode: "permanent", apiAccess: "none", apiAllow }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_api_allow");
      expect(serving.readLinks(ROOT)).toHaveLength(0);
    }

    // A path beside the app's own /api is still the owner's to open.
    expect((await POST(req("POST", { appId: "notes", mode: "permanent", apiAccess: "none", apiAllow: ["/upload", "/apis"] }))).status).toBe(201);
    expect((await listPublicLinks())[0]).toMatchObject({ apiAllow: ["/upload", "/apis"], apiReadOnly: false });
    await disablePublicLink("notes");
  });

  /** The serving side refuses a list longer than MAX_API_ALLOW: a link stored with one would be answered 201 here and never served. */
  it("counts the /api a new link opens against the cap on API paths, so it never stores a list the serving side refuses", async () => {
    const sixteen = Array.from({ length: MAX_API_ALLOW }, (_, i) => `/p${i}`);
    const res = await POST(req("POST", { appId: "notes", mode: "permanent", apiAllow: sixteen }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_api_allow");
    expect(serving.readLinks(ROOT)).toHaveLength(0);

    // Off adds nothing: sixteen typed paths are the whole list.
    expect((await POST(req("POST", { appId: "notes", mode: "permanent", apiAccess: "none", apiAllow: sixteen }))).status).toBe(201);
    expect(serving.validLink(serving.readLinks(ROOT)[0])).not.toBeNull();
    await disablePublicLink("notes");

    // Fifteen typed paths and /api fill the list exactly; an /api the owner typed is not counted twice.
    for (const typed of [sixteen.slice(1), ["/api", ...sixteen.slice(1)]]) {
      const ok = await POST(req("POST", { appId: "notes", mode: "permanent", apiAccess: "read", apiAllow: typed }));
      expect(ok.status).toBe(201);
      expect((await ok.json()).link.apiAllow).toHaveLength(MAX_API_ALLOW);
      expect(serving.validLink(serving.readLinks(ROOT)[0])).not.toBeNull();
      await disablePublicLink("notes");
    }
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

/** TASK-1515 — a password of the link's own, chosen by the owner. */
describe("a link password", () => {
  const PASSWORD = "tulip-harbor-93-quiet";
  const stored = () => JSON.parse(fs.readFileSync(path.join(LINKS_DIR, "links.json"), "utf-8")).links as Record<string, unknown>[];
  const everythingOnDisk = () => fs.readdirSync(LINKS_DIR).map((f) => fs.readFileSync(path.join(LINKS_DIR, f), "utf-8")).join("\n");

  it("is stored as a salted scrypt hash the serving side verifies — never as text, in the list or the audit log", async () => {
    const res = await POST(req("POST", { appId: "notes", mode: "permanent", password: PASSWORD }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link.passwordProtected).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    const record = stored()[0].password as { hash: string; key: string; setAt: number };
    expect(record.hash).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(record.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(everythingOnDisk()).not.toContain(PASSWORD);
    expect(fs.statSync(path.join(LINKS_DIR, "links.json")).mode & 0o777).toBe(0o600);

    const served = serving.readLinks(ROOT);
    expect(served).toHaveLength(1);
    expect(served[0].password).toEqual({ hash: record.hash, key: record.key });
    expect(await serving.verifyPasswordHash(PASSWORD, record.hash)).toBe(true);
    expect(await serving.verifyPasswordHash(`${PASSWORD}x`, record.hash)).toBe(false);
  });

  /**
   * The passwords the dialog actually produces, checked by both
   * halves: the owner's own verify (run before the record is written) and
   * the serving side's (run on a visitor's answer). A generated 20-character
   * password, one with spaces, one with accented letters typed in either
   * Unicode form, and a long one.
   */
  it("every password the dialog can set verifies on the serving side, in the owner's own check too", async () => {
    const passwords = ["Kq7mWn2PzRt4Hx9cVb3Y", "correct horse battery staple", "café-résumé-naïve-2026", "café-résumé-naïve-2026", "ключ-за-връзката-2026"];
    for (const password of passwords) {
      const res = await POST(req("POST", { appId: "notes", mode: "permanent", password }));
      expect(res.status, password).toBe(201);
      const record = stored()[0].password as { hash: string };
      expect(await serving.verifyPasswordHash(password, record.hash), password).toBe(true);
      expect(await verifyLinkPasswordHash(password, record.hash), password).toBe(true);
      expect(await serving.verifyPasswordHash(`${password}!`, record.hash), password).toBe(false);
      expect(await verifyLinkPasswordHash(`${password}!`, record.hash), password).toBe(false);
      await disablePublicLink("notes");
    }
    // The two Unicode forms of the same word are one password.
    await createPublicLink({ appId: "notes", mode: "permanent", password: passwords[2] });
    expect(await serving.verifyPasswordHash(passwords[3], (stored()[0].password as { hash: string }).hash)).toBe(true);
    // A record that is not one of ours never verifies, and never throws.
    expect(await verifyLinkPasswordHash(passwords[0], "scrypt$1$1$1$x$y")).toBe(false);
    expect(await verifyLinkPasswordHash(passwords[0], "")).toBe(false);
  }, 120_000); // each password is hashed at the real cost, three times over

  it("the list says only that there is one — no hash, no key", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent", password: PASSWORD });
    const res = await GET(req("GET"));
    const text = JSON.stringify(await res.json());
    expect(text).toContain("\"passwordProtected\":true");
    expect(text).not.toMatch(/scrypt|"hash"|"key"|"password"/);
  });

  it("a link made without one is open, and the box password is never consulted", async () => {
    const res = await POST(req("POST", { appId: "notes", mode: "permanent" }));
    expect((await res.json()).link.passwordProtected).toBe(false);
    expect("password" in stored()[0]).toBe(false);
    expect(serving.readLinks(ROOT)[0].password).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect((await listPublicLinks())[0].passwordProtected).toBe(false);
  });

  it("refuses a password that is too short, too long, not text or not typeable — and publishes nothing", async () => {
    for (const [password, code] of [["short", "password_too_short"], ["x".repeat(129), "password_too_long"], [12345678, "bad_password"], ["line\nbreak-long-enough", "bad_password"], ["", "password_too_short"]] as const) {
      const res = await POST(req("POST", { appId: "notes", mode: "permanent", password }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(code);
    }
    expect(serving.readLinks(ROOT)).toHaveLength(0);
  });

  it("refuses the ClawBox password as a link password", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await POST(req("POST", { appId: "notes", mode: "permanent", password: PASSWORD }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("password_is_system");
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(verifyPassword).toHaveBeenCalledWith(PASSWORD);
    expect(serving.readLinks(ROOT)).toHaveLength(0);

    await createPublicLink({ appId: "notes", mode: "permanent" });
    expect((await PATCH(req("PATCH", { appId: "notes", password: PASSWORD }))).status).toBe(400);
    expect(serving.readLinks(ROOT)[0].password).toBeNull();
  });

  it("accepts the password when the box cannot say whether it is its own", async () => {
    vi.mocked(verifyPassword).mockRejectedValue(new Error("helper missing"));
    expect((await POST(req("POST", { appId: "notes", mode: "permanent", password: PASSWORD }))).status).toBe(201);
  });

  it("is added, changed and removed without changing the link", async () => {
    await createPublicLink({ appId: "notes", mode: "temporary", ttlMinutes: 60, apiAllow: ["/api/scores"] });
    const before = serving.readLinks(ROOT)[0];
    const same = () => {
      const now = serving.readLinks(ROOT)[0];
      expect({ id: now.id, token: now.token, appId: now.appId }).toEqual({ id: before.id, token: before.token, appId: before.appId });
      expect(stored()[0]).toMatchObject({ mode: "temporary", apiAllow: ["/api", "/api/scores"] });
      return now;
    };

    let res = await PATCH(req("PATCH", { appId: "notes", password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, passwordProtected: true });
    const first = same().password!;
    expect(await serving.verifyPasswordHash(PASSWORD, first.hash)).toBe(true);

    res = await PATCH(req("PATCH", { appId: "notes", password: "a-second-password" }));
    expect(await res.json()).toEqual({ ok: true, passwordProtected: true });
    const second = same().password!;
    expect(second.hash).not.toBe(first.hash);
    // A new unlock key: whoever typed the old password is asked again.
    expect(second.key).not.toBe(first.key);
    expect(await serving.verifyPasswordHash(PASSWORD, second.hash)).toBe(false);
    expect(await serving.verifyPasswordHash("a-second-password", second.hash)).toBe(true);

    res = await PATCH(req("PATCH", { appId: "notes", password: null }));
    expect(await res.json()).toEqual({ ok: true, passwordProtected: false });
    expect(same().password).toBeNull();
    expect("password" in stored()[0]).toBe(false);

    const audit = fs.readFileSync(path.join(LINKS_DIR, "audit.log"), "utf-8");
    for (const event of ["password_set", "password_changed", "password_removed"]) expect(audit).toContain(`"${event}"`);
    expect(everythingOnDisk()).not.toContain(PASSWORD);
    expect(everythingOnDisk()).not.toContain("a-second-password");
  });

  it("is a person's to change: no session and the agent's bearer 401", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent", password: PASSWORD });
    const before = stored()[0].password;
    vi.mocked(sessionIdentity).mockResolvedValue(null);
    expect((await PATCH(req("PATCH", { appId: "notes", password: null }))).status).toBe(401);
    expect(stored()[0].password).toEqual(before);
  });

  it("a request that does not name the password changes nothing", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent", password: PASSWORD });
    const before = stored()[0].password;
    for (const body of [{ appId: "notes" }, { appId: "notes", password: 5 }, { appId: "notes", password: undefined }]) {
      expect((await PATCH(req("PATCH", body))).status).toBe(400);
    }
    expect((await PATCH(new Request("http://box/setup-api/apps/public-link", { method: "PATCH", body: "not json" }))).status).toBe(400);
    expect(stored()[0].password).toEqual(before);
  });

  it("needs a link to set a password on", async () => {
    const res = await PATCH(req("PATCH", { appId: "notes", password: PASSWORD }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_link");
    expect((await PATCH(req("PATCH", { appId: "../etc", password: PASSWORD }))).status).toBe(400);
    await expect(setPublicLinkPassword("notes", null)).rejects.toMatchObject({ code: "no_link" });
  });

  it("goes with the link: disabling removes it, and a new link starts without one", async () => {
    await createPublicLink({ appId: "notes", mode: "permanent", password: PASSWORD });
    expect((await DELETE(req("DELETE", { appId: "notes" }))).status).toBe(200);
    await createPublicLink({ appId: "notes", mode: "permanent" });
    expect(serving.readLinks(ROOT)[0].password).toBeNull();
  });
});
