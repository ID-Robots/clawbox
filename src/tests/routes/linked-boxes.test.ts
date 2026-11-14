/**
 * GET/PUT /setup-api/linked-boxes (TASK-2519): the owner's other ClawBoxes,
 * stored whole in the data directory. The owner's alone, both ways; a write
 * from our own page only; every entry rebuilt from its rules, never stored as
 * sent.
 */
import fs from "fs";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { dataDir, store, who } = await vi.hoisted(async () => {
  const [nodeFs, nodeOs, nodePath] = await Promise.all([import("fs"), import("os"), import("path")]);
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-linked-boxes-")),
    store: { get: vi.fn() },
    who: { personSession: vi.fn() },
  };
});
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: dataDir,
  get: store.get,
  readFailureKind: (err: unknown) => (err instanceof Error ? err.name : "unknown"),
}));
vi.mock("@/lib/owner-session", () => who);

import { GET, PUT } from "@/app/setup-api/linked-boxes/route";
import { LINKED_BOXES_FILE, readLinkedBoxes } from "@/lib/linked-boxes";

const URL_ = "http://clawbox.local/setup-api/linked-boxes";
const OWNER = { username: "owner", isOwner: true };

function get() {
  return GET(new Request(URL_));
}

function put(body: unknown, headers: Record<string, string> = {}) {
  return PUT(new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://clawbox.local", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  who.personSession.mockResolvedValue(OWNER);
  store.get.mockResolvedValue("main-box");
  fs.rmSync(LINKED_BOXES_FILE, { force: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("/setup-api/linked-boxes", () => {
  it("stores the file in the data directory", () => {
    expect(path.dirname(LINKED_BOXES_FILE)).toBe(dataDir);
  });

  it("starts empty, with this box's name for slot 1 and the kiosk's words in English", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      self: { name: "main-box" },
      boxes: [],
      max: 8,
      labels: { empty: "Nothing on Ctrl+Shift+{n} yet. Add a ClawBox in Settings → Linked ClawBoxes." },
    });
  });

  it("gives the kiosk's words in the box's language", async () => {
    store.get.mockImplementation(async (key: string) => (key === "pref:ui_language" ? "de" : "main-box"));
    const body = await (await get()).json();
    expect(body.labels.empty).toContain("Ctrl+Shift+{n}");
    expect(body.labels.empty).toMatch(/Einstellungen/);
  });

  it("refuses this box itself: the address the request came by, or a loopback one", async () => {
    for (const url of ["http://clawbox.local/", "clawbox.local", "http://localhost:3005", "http://127.0.0.1/", "http://[::1]:3000/"]) {
      const res = await put({ boxes: [{ name: "Me", url }] });
      expect(res.status, url).toBe(400);
      expect(await res.json(), url).toMatchObject({ code: "self", index: 0 });
    }
    // Another port on the same host is another server, so another box may live there.
    expect((await put({ boxes: [{ name: "Other", url: "http://clawbox.local:8080/" }] })).status).toBe(200);
  });

  it("names slot 1 after the system when no hostname is configured", async () => {
    store.get.mockResolvedValue(undefined);
    const body = await (await get()).json();
    expect(typeof body.self.name).toBe("string");
    expect(body.self.name.length).toBeGreaterThan(0);
  });

  it("a write replaces the whole list, rebuilt from its rules, and reads back", async () => {
    const res = await put({ boxes: [
      { name: "  Laptop  ", url: "https://laptop.example.com/login?next=%2F", extra: "dropped" },
      { name: "NAS", url: "nas.local:3005" },
    ] });
    expect(res.status).toBe(200);
    const want = [{ name: "Laptop", url: "https://laptop.example.com/" }, { name: "NAS", url: "http://nas.local:3005/" }];
    expect((await res.json()).boxes).toEqual(want);
    expect((await (await get()).json()).boxes).toEqual(want);
    const onDisk = JSON.parse(fs.readFileSync(LINKED_BOXES_FILE, "utf-8"));
    expect(onDisk).toEqual({ version: 1, boxes: want });
    expect(fs.statSync(LINKED_BOXES_FILE).mode & 0o777).toBe(0o600);
    // No temporary file left beside it.
    expect(fs.readdirSync(dataDir).filter((f) => f.startsWith("linked-boxes.json.tmp"))).toEqual([]);

    // Reordered and one removed: the new list is the list.
    await put({ boxes: [want[1]] });
    expect((await (await get()).json()).boxes).toEqual([want[1]]);
    await put({ boxes: [] });
    expect((await (await get()).json()).boxes).toEqual([]);
  });

  it("refuses a bad list whole, naming the entry, and keeps the old one", async () => {
    await put({ boxes: [{ name: "Laptop", url: "https://laptop.example.com" }] });
    const cases: [unknown, number, string, number?][] = [
      [{ boxes: "nope" }, 400, "invalid_body"],
      [{}, 400, "invalid_body"],
      ["not json", 400, "invalid_body"],
      [{ boxes: [{ name: "", url: "https://a.example" }] }, 400, "invalid_name", 0],
      [{ boxes: [{ name: "A", url: "https://a.example" }, { name: "B", url: "javascript:alert(1)" }] }, 400, "invalid_url", 1],
      [{ boxes: [{ name: "A", url: "https://user:pw@a.example" }] }, 400, "invalid_url", 0],
      [{ boxes: [{ name: "A", url: "https://a.example" }, { name: "B", url: "https://A.EXAMPLE/x" }] }, 400, "duplicate", 1],
      [{ boxes: Array.from({ length: 9 }, (_, i) => ({ name: `B${i}`, url: `https://b${i}.example` })) }, 400, "too_many"],
    ];
    for (const [body, status, code, index] of cases) {
      const res = await put(body);
      expect(res.status, code).toBe(status);
      const answer = await res.json();
      expect(answer.code, JSON.stringify(body)).toBe(code);
      if (index !== undefined) expect(answer.index).toBe(index);
    }
    expect(await readLinkedBoxes()).toEqual([{ name: "Laptop", url: "https://laptop.example.com/" }]);
  });

  it("refuses a body over the limit", async () => {
    const res = await put({ boxes: [], pad: "x".repeat(20 * 1024) });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("body_too_large");
  });

  it("is the owner's alone: another user, the agent's bearer and no session get 403 owner_only", async () => {
    for (const person of [{ username: "alice", isOwner: false }, null]) {
      who.personSession.mockResolvedValue(person);
      const r1 = await get();
      expect(r1.status).toBe(403);
      expect((await r1.json()).code).toBe("owner_only");
      const r2 = await put({ boxes: [{ name: "Evil", url: "https://evil.example" }] });
      expect(r2.status).toBe(403);
      expect((await r2.json()).code).toBe("owner_only");
    }
    expect(fs.existsSync(LINKED_BOXES_FILE)).toBe(false);
  });

  it("refuses a write from another site", async () => {
    const res = await put({ boxes: [{ name: "Evil", url: "https://evil.example" }] }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(fs.existsSync(LINKED_BOXES_FILE)).toBe(false);
  });

  it("reads a hand-edited file defensively and a broken one as empty", async () => {
    fs.writeFileSync(LINKED_BOXES_FILE, JSON.stringify({ version: 1, boxes: [
      { name: "Good", url: "https://good.example/" },
      { name: "Bad", url: "javascript:alert(1)" },
      "junk",
    ] }));
    expect((await (await get()).json()).boxes).toEqual([{ name: "Good", url: "https://good.example/" }]);
    fs.writeFileSync(LINKED_BOXES_FILE, "{ not json");
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).boxes).toEqual([]);
  });

  it("says so when the file cannot be read at all", async () => {
    fs.mkdirSync(LINKED_BOXES_FILE, { recursive: true });
    try {
      const res = await get();
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe("store_read_failed");
    } finally {
      fs.rmSync(LINKED_BOXES_FILE, { recursive: true, force: true });
    }
  });
});
