import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-2377 — the Files API serves a member of staff on an organisation box
 * ONLY their own Linux home and the shared folder, server-side, on every
 * route: listing, search, download, folder ZIP, selection ZIP, upload (both
 * kinds), mkdir, move, rename, delete. The owner, the agent's bearer (no
 * person) and every user of a home box are served the owner's home as before;
 * a non-owner on a box whose switch cannot be read is refused.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-member-${process.pid}-${Date.now()}`);
const OWNER = path.join(ROOT, "owner");
const IVAN = path.join(ROOT, "home", "ivan");
const MARIA = path.join(ROOT, "home", "maria");

const who = vi.hoisted(() => ({ current: null as null | { username: string; isOwner: boolean } }));
const org = vi.hoisted(() => ({ mode: true as boolean | null }));
const homes = vi.hoisted(() => ({ map: {} as Record<string, string>, grant: vi.fn(async () => "ok" as const) }));

vi.mock("@/lib/owner-session", () => ({
  personSession: vi.fn(async () => who.current),
  hasPersonSession: vi.fn(async () => who.current !== null),
  hasOwnerSession: vi.fn(async () => who.current?.isOwner === true),
}));
vi.mock("@/lib/org-mode-server", () => ({
  readOrgModeStrict: vi.fn(async () => org.mode),
  readOrgMode: vi.fn(async () => org.mode === true),
}));
vi.mock("@/lib/clawbox-users", () => ({
  userHomeDir: vi.fn(async (name: string) => homes.map[name] ?? null),
  grantHomeAccess: homes.grant,
}));

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let list: Handler;
let post: Handler;
let put: Handler;
let one: { GET: Handler; PUT: Handler; DELETE: Handler };
let resetCaches: () => void;

const url = (p: string) => new URL(`http://localhost${p}`);
const ctx = (segments: string[]) => ({ params: Promise.resolve({ path: segments }) });
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function listing(dir: string, extra = "") {
  return list(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}${extra}`)));
}

function multipart(dir: string, name: string, content: string) {
  const boundary = "----b" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  }));
}

beforeAll(async () => {
  for (const dir of [OWNER, IVAN, MARIA, path.join(OWNER, "clawbox"), path.join(OWNER, "backups"), path.join(IVAN, "Documents"), path.join(MARIA, "Documents")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(OWNER, "clawbox", "README.md"), "owner checkout");
  fs.writeFileSync(path.join(OWNER, "backups", "box.tar"), "owner backup");
  fs.writeFileSync(path.join(OWNER, ".bashrc"), "owner dotfile");
  fs.writeFileSync(path.join(IVAN, "Documents", "report.txt"), "ivan's report");
  fs.writeFileSync(path.join(MARIA, "Documents", "diary.txt"), "maria's diary");
  fs.symlinkSync(path.join(OWNER, "clawbox"), path.join(IVAN, "checkout"));
  fs.symlinkSync(path.join(MARIA, "Documents", "diary.txt"), path.join(IVAN, "diary.txt"));
  homes.map = { ivan: IVAN, maria: MARIA };
  process.env.FILES_ROOT = OWNER;
  process.env.CLAWBOX_ROOT = path.join(ROOT, "clawbox-data");
  vi.resetModules();
  ({ GET: list, POST: post, PUT: put } = await import("@/app/setup-api/files/route"));
  one = await import("@/app/setup-api/files/[...path]/route") as unknown as typeof one;
  ({ resetFilesScopeCachesForTests: resetCaches } = await import("@/lib/files-scope-server"));
});

beforeEach(() => {
  who.current = { username: "ivan", isOwner: false };
  org.mode = true;
  homes.grant.mockClear();
  resetCaches();
});

afterAll(() => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const names = async (res: Response) => ((await res.json()).files as Array<{ name: string }>).map((f) => f.name).sort();

describe("who is served what", () => {
  it("serves the owner the owner's home, unchanged", async () => {
    who.current = { username: "owner", isOwner: true };
    const res = await listing("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).toBeUndefined();
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["clawbox", "backups", ".bashrc"]));
  });

  it("serves the agent's bearer (no person) the owner's home", async () => {
    who.current = null;
    expect(await names(await listing(""))).toEqual(expect.arrayContaining(["clawbox", "backups"]));
  });

  it("serves a non-owner on a home box (org mode off) the owner's home, as before", async () => {
    org.mode = false;
    expect(await names(await listing(""))).toEqual(expect.arrayContaining(["clawbox", "backups"]));
  });

  it("refuses a request whose session cookie could not be resolved, never serving the owner's home", async () => {
    who.current = null;
    const res = await list(new NextRequest(url("/setup-api/files?dir="), { headers: { cookie: "clawbox_session=unresolvable" } }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("session_unknown");
  });

  it("refuses a non-owner when the switch cannot be read", async () => {
    org.mode = null;
    const res = await listing("");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("org_mode_unknown");
  });

  it("serves a member of staff only Home and Shared at the top", async () => {
    const res = await listing("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).toBe("member");
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(["Home", "Shared"]);
  });

  it("lists the member's own home, with links that lead out of it left out", async () => {
    const res = await listing("Home");
    expect(res.status).toBe(200);
    const listed = await names(res);
    expect(listed).toContain("Documents");
    expect(listed).not.toContain("checkout");
    expect(listed).not.toContain("diary.txt");
    expect(await names(await listing("Home/Documents"))).toEqual(["report.txt"]);
  });

  it("serves another member their own home, not the first one's", async () => {
    who.current = { username: "maria", isOwner: false };
    expect(await names(await listing("Home/Documents"))).toEqual(["diary.txt"]);
  });
});

describe("a member of staff cannot leave their folders", () => {
  it.each([
    "..", "../owner", "Home/..", "Home/../../owner", "Home/../..", "Shared/../clawbox", "clawbox", "backups", OWNER, `${OWNER}/clawbox`, "/etc",
    "Home/checkout", "Home/checkout/README.md",
  ])("refuses the listing of %s", async (dir) => {
    expect((await listing(dir)).status).toBe(400);
  });

  it("refuses downloads of the owner's files, through a link or a path", async () => {
    for (const segments of [["..", "owner", "clawbox", "README.md"], ["Home", "checkout", "README.md"], ["Home", "diary.txt"], ["clawbox", "README.md"], ["Shared", "..", "backups", "box.tar"]]) {
      const res = await one.GET(new NextRequest(url(`/setup-api/files/${segments.join("/")}`)), ctx(segments));
      expect(res.status, segments.join("/")).toBe(400);
    }
    const mine = await one.GET(new NextRequest(url("/setup-api/files/Home/Documents/report.txt")), ctx(["Home", "Documents", "report.txt"]));
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("ivan's report");
  });

  it("finds nothing of the owner's or another member's in a search from the top", async () => {
    const res = await listing("", "&search=r&hidden=1");
    expect(res.status).toBe(200);
    const paths = ((await res.json()).files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain("Home/Documents/report.txt");
    expect(paths.some((p) => p.includes("README") || p.includes("diary") || p.includes("backups"))).toBe(false);
  });

  it("zips a folder without what a link leads to outside it", async () => {
    const res = await one.GET(new NextRequest(url("/setup-api/files/Home?zip=1&check=1")), ctx(["Home"]));
    expect(res.status).toBe(200);
    const summary = await res.json();
    // Documents/ + report.txt + the top folder; neither link.
    expect(summary.files).toBe(1);
  });

  it("will not write at the virtual top folder or outside the folders", async () => {
    expect((await multipart("", "x.txt", "x")).status).toBe(400);
    expect((await post(new NextRequest(url("/setup-api/files?dir="), json({ action: "mkdir", name: "x" })))).status).toBe(400);
    expect((await post(new NextRequest(url("/setup-api/files?dir=Home"), json({ action: "mkdir", name: "../../owner/evil" })))).status).toBe(400);
    // The multipart parser keeps only the file name: it lands in their home.
    await multipart("Home", "../../owner/evil.txt", "x");
    expect(fs.existsSync(path.join(OWNER, "evil.txt"))).toBe(false);
    const putReq = new NextRequest(url(`/setup-api/files?dir=Home&name=${encodeURIComponent("../../owner/evil.txt")}`), { method: "PUT", body: "x" });
    expect((await put(putReq)).status).toBe(400);
    expect(fs.existsSync(path.join(OWNER, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(OWNER, "evil"))).toBe(false);
  });

  it("will not rename, move or delete their roots, nor rename something out of its folder", async () => {
    expect((await one.DELETE(new NextRequest(url("/setup-api/files/Home"), { method: "DELETE" }), ctx(["Home"]))).status).toBe(400);
    expect((await one.DELETE(new NextRequest(url("/setup-api/files/Shared"), { method: "DELETE" }), ctx(["Shared"]))).status).toBe(400);
    expect((await one.PUT(new NextRequest(url("/setup-api/files/Home"), { method: "PUT", body: JSON.stringify({ newName: "x" }) }), ctx(["Home"]))).status).toBe(400);
    expect((await post(new NextRequest(url("/setup-api/files?dir=Shared"), json({ action: "move", paths: ["Home"] })))).status).toBe(400);
    expect((await one.DELETE(new NextRequest(url("/setup-api/files/Home/checkout"), { method: "DELETE" }), ctx(["Home", "checkout"]))).status).toBe(400);
    expect(fs.existsSync(path.join(OWNER, "clawbox", "README.md"))).toBe(true);
    expect(fs.existsSync(IVAN)).toBe(true);
  });

  it("does not redeem another view's selection ZIP", async () => {
    const issued = await post(new NextRequest(url("/setup-api/files?dir=Home"), json({ action: "zip", paths: ["Home/Documents/report.txt"] })));
    expect(issued.status).toBe(200);
    const { ticket } = await issued.json();
    who.current = { username: "owner", isOwner: true };
    expect((await list(new NextRequest(url(`/setup-api/files?zip=${ticket}`)))).status).toBe(404);
    who.current = { username: "maria", isOwner: false };
    expect((await list(new NextRequest(url(`/setup-api/files?zip=${ticket}`)))).status).toBe(404);
    who.current = { username: "ivan", isOwner: false };
    expect((await list(new NextRequest(url(`/setup-api/files?zip=${ticket}`)))).status).toBe(200);
  });
});

describe("the shared folder", () => {
  it("is read and written by every member, and is <owner home>/Shared for the owner", async () => {
    expect((await multipart("Shared", "minutes.txt", "from ivan")).status).toBe(200);
    expect(fs.readFileSync(path.join(OWNER, "Shared", "minutes.txt"), "utf-8")).toBe("from ivan");
    who.current = { username: "maria", isOwner: false };
    expect(await names(await listing("Shared"))).toContain("minutes.txt");
    who.current = { username: "owner", isOwner: true };
    expect(await names(await listing("Shared"))).toContain("minutes.txt");
  });

  it("takes a member's move from their home and back", async () => {
    fs.writeFileSync(path.join(IVAN, "Documents", "move-me.txt"), "m");
    const res = await post(new NextRequest(url("/setup-api/files?dir=Shared"), json({ action: "move", paths: ["Home/Documents/move-me.txt"] })));
    expect(res.status).toBe(200);
    expect((await res.json()).moved).toEqual([{ from: "Home/Documents/move-me.txt", to: "Shared/move-me.txt", name: "move-me.txt" }]);
    expect(fs.existsSync(path.join(OWNER, "Shared", "move-me.txt"))).toBe(true);
  });
});

describe("a home the web server cannot reach", () => {
  it("is handed to the helper once, then refused 503 home_unavailable — never replaced by the owner's", async () => {
    const locked = path.join(ROOT, "home", "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o000);
    homes.map.locked = locked;
    who.current = { username: "locked", isOwner: false };
    try {
      if (process.getuid?.() === 0) return; // root reaches everything
      const res = await listing("Home");
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("home_unavailable");
      expect(homes.grant).toHaveBeenCalledWith("locked");
      // Not asked again at once.
      await listing("Home");
      expect(homes.grant).toHaveBeenCalledTimes(1);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("refuses a member with no account home", async () => {
    who.current = { username: "ghost", isOwner: false };
    const res = await listing("");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("home_unavailable");
  });
});
