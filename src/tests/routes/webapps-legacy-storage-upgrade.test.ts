/**
 * @vitest-environment node
 *
 * TASK-1150 — a box updated from v3.9 to v4.0 opened every webapp on EMPTY
 * storage, with no error. This is that box, deterministically: a v3.9 data/
 * with several webapps and the data they saved the way v3.9 let them, run
 * through the real routes against real files.
 *
 * The frame is a `vm` context standing in for the sandboxed iframe: its own
 * `fetch` rejects (an opaque origin carries no session, so the request that
 * used to reach /setup-api/kv is refused) and its `localStorage` throws a
 * SecurityError, the two things an opaque origin does to a v3.9 app. Its
 * `parent.postMessage` reaches the desktop's real bridge
 * (`serveWebappKvRequest`, attributed to the frame's own app the way the
 * desktop attributes it), whose `fetch` reaches the real route handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { NextRequest } from "next/server";
import { saveEnv } from "@/tests/helpers/env";
import { WEBAPP_KV_CLIENT_SNIPPET } from "@/lib/webapp-sandbox";

type Handler = (req: NextRequest) => Promise<Response>;
type Guest = Record<string, unknown> & {
  app: Record<string, (...args: unknown[]) => unknown>;
  deliver: (data: unknown) => void;
  nativeFetch: ReturnType<typeof vi.fn>;
};

let restoreEnv: () => void;
let base: string;
let root: string;
let data: string;
let routes: { webappsGET: Handler; storageGET: Handler; storagePOST: Handler; kvGET: Handler; kvPOST: Handler };
let bridge: typeof import("@/lib/webapp-kv-bridge");
let migration: typeof import("@/lib/webapp-legacy-storage-migration");

/** What a v3.9 box had in data/kv.json. */
const KV_V39: Record<string, string> = {
  // todo-list followed the guide's own example: its id is "todo-list", its keys "todo:…".
  "todo:items": JSON.stringify(["milk", "eggs"]),
  // notes namespaced with its exact id.
  "notes:list": JSON.stringify([{ text: "hello" }]),
  "notes:settings": JSON.stringify({ dark: true }),
  // habits built its namespace in a constant, and kept one bare key.
  "streaks:data": JSON.stringify({ days: 12 }),
  "habits-theme": "dark",
  // A v4-era app's own data, already under its namespace.
  "weather:city": "Sofia",
  // Something no app names.
  "unknown:thing": "nobody's",
  // ClawBox's own state.
  "ui:pending-actions": "[]",
  "clawbox-winsize-files": JSON.stringify({ width: 800, height: 600 }),
  clawai_tier_seen: "pro",
};

const TODO_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Todo</title></head>
<body><ul id="list"></ul>
<script>
  async function load() {
    const res = await fetch('/setup-api/kv?key=todo:items');
    const data = await res.json();
    return JSON.parse(data.value || '[]');
  }
  async function save(items) {
    const res = await fetch('/setup-api/kv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'todo:items', value: JSON.stringify(items) }),
    });
    return res.json();
  }
  window.app = { load, save };
</script></body></html>`;

const NOTES_HTML = `<!doctype html><html><head><title>Notes</title></head><body><script>
  async function list() {
    const res = await fetch(new Request(location.origin + '/setup-api/kv?prefix=notes:'));
    return { status: res.status, body: await res.json() };
  }
  async function saveMany(entries) {
    const res = await fetch('/setup-api/kv/', { method: 'POST', body: JSON.stringify({ entries }) });
    return res.json();
  }
  async function remove(key) {
    const res = await fetch('/setup-api/kv', { method: 'POST', body: JSON.stringify({ delete: key }) });
    return res.json();
  }
  async function bad() {
    const res = await fetch('/setup-api/kv?key=' + encodeURIComponent('no spaces allowed'));
    return { status: res.status, body: await res.json() };
  }
  window.app = { list, saveMany, remove, bad };
</script></body></html>`;

const HABITS_HTML = `<!doctype html><html><head><title>Habits</title></head><body><script>
  const NS = 'streaks';
  async function load() {
    const streaks = await (await fetch('/setup-api/kv?key=' + NS + ':data')).json();
    const theme = await (await fetch('/setup-api/kv?key=habits-theme')).json();
    return { streaks: JSON.parse(streaks.value), theme: theme.value };
  }
  window.app = { load };
</script></body></html>`;

const POMODORO_HTML = `<!doctype html><html><head><title>Pomodoro</title></head><body><script>
  const KEY = 'pomodoro-settings';
  function load() {
    return {
      settings: JSON.parse(localStorage.getItem(KEY) || 'null'),
      sessions: Object.keys(localStorage).filter(function (k) { return k.indexOf('session-') === 0; }).sort(),
      length: localStorage.length,
    };
  }
  function save(settings, n) {
    localStorage.setItem(KEY, JSON.stringify(settings));
    localStorage['session-' + n] = '1';
    delete localStorage['session-1'];
  }
  window.app = { load, save };
</script></body></html>`;

const WEATHER_HTML = `<!doctype html><html><head><title>Weather</title>${WEBAPP_KV_CLIENT_SNIPPET}</head><body><script>
  window.app = { city: function () { return window.clawboxKv.get('city'); } };
</script></body></html>`;

/** A v3.9 app whose code names data that is not its own. */
const GREEDY_HTML = `<!doctype html><html><head><title>Greedy</title></head><body><script>
  const wanted = ['ui:pending-actions', 'clawbox-winsize-files', 'clawai_tier_seen', 'notes:list', 'openclaw.control.settings.v1'];
  async function read(key) { return (await fetch('/setup-api/kv?key=' + key)).json(); }
  async function everything() { return (await fetch('/setup-api/kv')).json(); }
  window.app = { read, everything, wanted };
</script></body></html>`;

function installApp(id: string, html: string): void {
  const dir = path.join(data, "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: id, color: "#f97316", icon: "" }));
}

function readKv(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(data, "kv.json"), "utf-8"));
}

/** The box a v3.9 → v4.x update leaves: apps, data, and a couple of hostile shapes. */
function buildV39Box(): void {
  fs.writeFileSync(path.join(data, "kv.json"), JSON.stringify(KV_V39));
  installApp("todo-list", TODO_HTML);
  installApp("notes", NOTES_HTML);
  installApp("habits", HABITS_HTML);
  installApp("pomodoro", POMODORO_HTML);
  installApp("weather", WEATHER_HTML);
  installApp("greedy", GREEDY_HTML);
  // An app folder that is a symlink out of data/webapps, whose code names todo's data.
  const outside = path.join(base, "outside-app");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "index.html"), TODO_HTML);
  fs.symlinkSync(outside, path.join(data, "webapps", "linked"));
  // An app whose index.html is a symlink to a file elsewhere.
  const sneaky = path.join(data, "webapps", "sneaky");
  fs.mkdirSync(sneaky, { recursive: true });
  fs.symlinkSync(path.join(outside, "index.html"), path.join(sneaky, "index.html"));
  // A folder that is not an app id at all.
  fs.mkdirSync(path.join(data, "webapps", "not an id"), { recursive: true });
  // A project's own server, registered with a meta.json and no document.
  fs.mkdirSync(path.join(data, "webapps", "server-app"), { recursive: true });
  fs.writeFileSync(path.join(data, "webapps", "server-app", "meta.json"), JSON.stringify({ name: "Server", port: 4000 }));
}

/** The desktop's fetch: relative URLs, answered by the real route handlers. */
async function desktopFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), "http://clawbox.local");
  const method = (init?.method ?? "GET").toUpperCase();
  const req = new NextRequest(url, { method, headers: init?.headers, body: method === "GET" ? undefined : init?.body });
  if (url.pathname === "/setup-api/webapps/storage") return method === "POST" ? routes.storagePOST(req) : routes.storageGET(req);
  if (url.pathname === "/setup-api/kv") return method === "POST" ? routes.kvPOST(req) : routes.kvGET(req);
  if (url.pathname === "/setup-api/webapps") return routes.webappsGET(req);
  throw new Error(`unexpected request ${method} ${url}`);
}

async function serve(id: string): Promise<string> {
  const res = await desktopFetch(`/setup-api/webapps?app=${id}`);
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * Load a served page into a sandboxed-frame stand-in and run its scripts, in
 * order. Its bridge messages are answered for `appId` — the frame's own app.
 */
function openInFrame(appId: string, html: string): Guest {
  const listeners: Array<(event: unknown) => void> = [];
  const parent = {
    postMessage: (message: { clawboxKv?: unknown }) => {
      const req = message?.clawboxKv as Parameters<typeof bridge.serveWebappKvRequest>[1] | undefined;
      if (!req) return;
      void bridge.serveWebappKvRequest(appId, req).then((result) => guest.deliver({ clawboxKvResult: result }));
    },
  };
  const opaque = () => {
    throw new DOMException("The document is sandboxed and lacks the 'allow-same-origin' flag.", "SecurityError");
  };
  // The opaque origin's own fetch: no session, refused.
  const nativeFetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const guest = {
    location: new URL(`http://clawbox.local/setup-api/webapps?app=${appId}`),
    parent,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "message") listeners.push(fn);
    },
    fetch: nativeFetch,
    nativeFetch,
    __opaque: opaque,
    Request,
    Response,
    URL,
    TextEncoder,
    DOMException,
    setTimeout,
    clearTimeout,
    console,
    deliver: (payload: unknown) => {
      for (const fn of listeners) fn({ data: payload, source: parent });
    },
  } as unknown as Guest;
  vm.createContext(guest);
  // From INSIDE the context: `window` is the page's own global, as in a
  // browser, and a throwing accessor defined on the sandbox object from
  // outside reads as "not defined" in node's vm rather than throwing.
  vm.runInContext(
    `globalThis.window = globalThis;
     Object.defineProperty(globalThis, "localStorage", { configurable: true, enumerable: true, get: __opaque });
     Object.defineProperty(globalThis, "sessionStorage", { configurable: true, enumerable: true, get: __opaque });`,
    guest,
  );
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], guest);
  return guest;
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-legacy-storage-"));
  root = path.join(base, "clawbox");
  data = path.join(root, "data");
  fs.mkdirSync(path.join(data, "webapps"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  const webapps = await import("@/app/setup-api/webapps/route");
  const storage = await import("@/app/setup-api/webapps/storage/route");
  const kv = await import("@/app/setup-api/kv/route");
  routes = {
    webappsGET: webapps.GET as unknown as Handler,
    storageGET: storage.GET as unknown as Handler,
    storagePOST: storage.POST as unknown as Handler,
    kvGET: kv.GET as unknown as Handler,
    kvPOST: kv.POST as unknown as Handler,
  };
  bridge = await import("@/lib/webapp-kv-bridge");
  migration = await import("@/lib/webapp-legacy-storage-migration");
  vi.stubGlobal("fetch", vi.fn(desktopFetch));
  buildV39Box();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the v3.9 → v4.0 regression, reproduced", () => {
  it("leaves every app's data on disk and out of its reach", async () => {
    // The data survived the update…
    expect(readKv()["todo:items"]).toBe(KV_V39["todo:items"]);

    // …the page is served exactly as written, so the app's own fetch goes to
    // the network from an opaque origin and is refused…
    const html = await serve("todo-list");
    expect(html).toBe(TODO_HTML);
    const todo = openInFrame("todo-list", html);
    await expect(todo.app.load()).rejects.toThrow("Failed to fetch");

    // …and the only storage path v4.0 offers it cannot see the data either:
    // the bridge refuses the key the app uses and finds nothing under its id.
    expect(await bridge.serveWebappKvRequest("todo-list", { id: "a", op: "get", key: "todo:items" })).toEqual({
      id: "a", ok: false, error: "key outside app namespace",
    });
    expect(await bridge.serveWebappKvRequest("todo-list", { id: "b", op: "get", key: "items" })).toEqual({ id: "b", ok: true, value: null });
    expect(await bridge.serveWebappKvRequest("todo-list", { id: "c", op: "list" })).toEqual({ id: "c", ok: true, value: {} });

    // A localStorage app does not even draw: the opaque origin throws.
    const pomodoro = openInFrame("pomodoro", await serve("pomodoro"));
    expect(() => pomodoro.app.load()).toThrow(/sandboxed/);
  });
});

describe("the migration", () => {
  it("copies each app's old data into its own namespace, and deletes nothing", () => {
    const result = migration.migrateLegacyWebappStorage(new Date("2026-09-24T00:00:00Z"));
    expect(result).toMatchObject({ ran: true, copied: 3 });

    const kv = readKv();
    expect(kv["todo-list:todo:items"]).toBe(KV_V39["todo:items"]);
    expect(kv["habits:streaks:data"]).toBe(KV_V39["streaks:data"]);
    expect(kv["habits:habits-theme"]).toBe("dark");
    // Every original is still where v3.9 left it — a box rolled back finds its data.
    for (const [key, value] of Object.entries(KV_V39)) expect(kv[key], key).toBe(value);
    // notes and weather were already in their own namespace: nothing to move.
    expect(Object.keys(kv).filter((k) => k.startsWith("notes:notes:") || k.startsWith("weather:weather:"))).toEqual([]);
    // Nothing of ClawBox's, and nothing of another app's, went to the app that named them.
    expect(Object.keys(kv).filter((k) => k.startsWith("greedy:"))).toEqual([]);
    // Nothing reached through a symlink.
    expect(Object.keys(kv).filter((k) => k.startsWith("linked:") || k.startsWith("sneaky:"))).toEqual([]);
    expect(kv["unknown:thing"]).toBe("nobody's");

    const record = JSON.parse(fs.readFileSync(path.join(data, "webapp-legacy-storage.json"), "utf-8"));
    expect(record.migratedAt).toBe("2026-09-24T00:00:00.000Z");
    expect(record.apps["todo-list"]).toMatchObject({ kv: true, localStorage: false, copied: ["todo:items"], kept: [] });
    expect(record.apps.habits.copied.sort()).toEqual(["habits-theme", "streaks:data"]);
    expect(record.apps.notes).toMatchObject({ kv: true, copied: [] });
    expect(record.apps.weather).toMatchObject({ kv: false, localStorage: false });
    expect(record.apps.greedy).toMatchObject({ kv: true, copied: [] });
    expect(record.apps.pomodoro.localStorage).toBe(true);
    expect(record.apps.pomodoro.tokens).toContain("pomodoro-settings");
    expect(record.apps.linked.refused).toMatch(/symlink/);
    expect(record.apps.sneaky.refused).toMatch(/not a regular file/);
    expect(record.apps["not an id"]).toBeUndefined();
    expect(record.apps["server-app"]).toEqual({ kv: false, localStorage: false, copied: [], kept: [] });
    expect(fs.statSync(path.join(data, "webapp-legacy-storage.json")).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a second run changes nothing at all", () => {
    migration.migrateLegacyWebappStorage();
    const kvAfterFirst = fs.readFileSync(path.join(data, "kv.json"), "utf-8");
    const recordAfterFirst = fs.readFileSync(path.join(data, "webapp-legacy-storage.json"), "utf-8");
    expect(migration.migrateLegacyWebappStorage()).toEqual({ ran: false, apps: 0, copied: 0 });
    expect(fs.readFileSync(path.join(data, "kv.json"), "utf-8")).toBe(kvAfterFirst);
    expect(fs.readFileSync(path.join(data, "webapp-legacy-storage.json"), "utf-8")).toBe(recordAfterFirst);
  });

  it("never overwrites data the app already has in its namespace", () => {
    const kv = { ...KV_V39, "todo-list:todo:items": JSON.stringify(["newer"]) };
    fs.writeFileSync(path.join(data, "kv.json"), JSON.stringify(kv));
    migration.migrateLegacyWebappStorage();
    expect(readKv()["todo-list:todo:items"]).toBe(JSON.stringify(["newer"]));
    const record = JSON.parse(fs.readFileSync(path.join(data, "webapp-legacy-storage.json"), "utf-8"));
    expect(record.apps["todo-list"]).toMatchObject({ copied: [], kept: ["todo:items"] });
  });

  it("refuses only the app whose files it cannot read, and still migrates the rest", () => {
    const locked = path.join(data, "webapps", "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "index.html"), TODO_HTML);
    fs.chmodSync(path.join(locked, "index.html"), 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Root reads a 0000 file anyway; the case only means something without it.
      if (process.getuid?.() === 0) return;
      expect(migration.migrateLegacyWebappStorage().ran).toBe(true);
      const record = JSON.parse(fs.readFileSync(path.join(data, "webapp-legacy-storage.json"), "utf-8"));
      expect(record.apps.locked.refused).toMatch(/could not be read \(EACCES\)/);
      expect(readKv()["todo-list:todo:items"]).toBe(KV_V39["todo:items"]);
      expect(Object.keys(readKv()).filter((k) => k.startsWith("locked:"))).toEqual([]);
    } finally {
      warn.mockRestore();
      fs.chmodSync(path.join(locked, "index.html"), 0o644);
    }
  });

  it("writes nothing and records nothing over a store it cannot read, and runs once it can", async () => {
    fs.writeFileSync(path.join(data, "kv.json"), "{ half a file");
    expect(() => migration.migrateLegacyWebappStorage()).toThrow();
    expect(fs.existsSync(path.join(data, "webapp-legacy-storage.json"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "kv.json"), "utf-8")).toBe("{ half a file");
    // With no record, apps are served as v4.0 served them — no layer that could
    // save an empty first screen over data that has not been moved yet.
    expect(await serve("todo-list")).toBe(TODO_HTML);

    fs.writeFileSync(path.join(data, "kv.json"), JSON.stringify(KV_V39));
    expect(migration.migrateLegacyWebappStorage().ran).toBe(true);
    expect(readKv()["todo-list:todo:items"]).toBe(KV_V39["todo:items"]);
  });
});

describe("after the migration, each app finds its data again", () => {
  beforeEach(() => {
    migration.migrateLegacyWebappStorage();
  });

  it("todo-list reads its items and keeps saving to one place", async () => {
    const html = await serve("todo-list");
    expect(html).not.toBe(TODO_HTML);
    expect(html.indexOf("__clawboxLegacyStorage")).toBeLessThan(html.indexOf("async function load"));
    const todo = openInFrame("todo-list", html);
    expect(await todo.app.load()).toEqual(["milk", "eggs"]);

    expect(await todo.app.save(["milk", "eggs", "bread"])).toEqual({ ok: true });
    const kv = readKv();
    expect(kv["todo-list:todo:items"]).toBe(JSON.stringify(["milk", "eggs", "bread"]));
    expect(kv["todo:items"]).toBe(KV_V39["todo:items"]); // the old copy is untouched
    expect(await todo.app.load()).toEqual(["milk", "eggs", "bread"]);
    // Nothing went to the network.
    expect(todo.nativeFetch).not.toHaveBeenCalled();
  });

  it("notes lists by prefix, batch-writes, deletes, and gets v3.9's refusals", async () => {
    const notes = openInFrame("notes", await serve("notes"));
    expect(await notes.app.list()).toEqual({
      status: 200,
      body: { "notes:list": KV_V39["notes:list"], "notes:settings": KV_V39["notes:settings"] },
    });
    expect(await notes.app.saveMany({ "notes:list": "[]", "notes:draft": "d", "bad key!": "dropped" })).toEqual({ ok: true });
    expect(await notes.app.remove("notes:settings")).toEqual({ ok: true });
    const kv = readKv();
    expect(kv["notes:list"]).toBe("[]");
    expect(kv["notes:draft"]).toBe("d");
    expect(kv["notes:settings"]).toBeUndefined();
    expect(Object.keys(kv).some((k) => k.includes("bad key"))).toBe(false);
    expect(await notes.app.bad()).toEqual({ status: 400, body: { error: "Invalid key" } });
  });

  it("habits finds the namespace it built in a constant and its bare key", async () => {
    const habits = openInFrame("habits", await serve("habits"));
    expect(await habits.app.load()).toEqual({ streaks: { days: 12 }, theme: "dark" });
  });

  it("an app that names other data reaches none of it", async () => {
    const greedy = openInFrame("greedy", await serve("greedy"));
    for (const key of greedy.app.wanted as unknown as string[]) {
      expect(await greedy.app.read(key), key).toEqual({ key, value: null });
    }
    expect(await greedy.app.everything()).toEqual({});
  });

  it("a v4-era app on the bridge is served exactly as written", async () => {
    const html = await serve("weather");
    expect(html).toBe(WEATHER_HTML);
    const weather = openInFrame("weather", html);
    expect(await weather.app.city()).toBe("Sofia");
  });

  it("pomodoro gets this browser's old localStorage back, and saves to its namespace", async () => {
    // What the desktop page finds in its own origin's storage — and sends.
    // The server takes only what the app's code named, never ClawBox's keys.
    const browser = {
      "pomodoro-settings": JSON.stringify({ work: 25 }),
      "session-1": "1",
      "session-2": "1",
      "openclaw.control.settings.v1": JSON.stringify({ token: "gateway-secret" }),
      "clawbox-custom-wallpapers": "[]",
      unrelated: "x",
    };
    const plan = await (await desktopFetch("/setup-api/webapps/storage?app=pomodoro")).json();
    expect(plan.migrated).toBe(true);
    expect(plan.plan.tokens).toContain("pomodoro-settings");
    const imported = await (
      await desktopFetch("/setup-api/webapps/storage", {
        method: "POST",
        body: JSON.stringify({ app: "pomodoro", op: "importBrowser", entries: browser }),
      })
    ).json();
    expect(imported.copied.sort()).toEqual(["pomodoro-settings", "session-1", "session-2"]);
    expect(imported.refused.sort()).toEqual(["clawbox-custom-wallpapers", "openclaw.control.settings.v1", "unrelated"]);

    const pomodoro = openInFrame("pomodoro", await serve("pomodoro"));
    expect(pomodoro.app.load()).toEqual({ settings: { work: 25 }, sessions: ["session-1", "session-2"], length: 3 });

    pomodoro.app.save({ work: 50 }, 3);
    await vi.waitFor(() => {
      const kv = readKv();
      expect(kv["pomodoro:localStorage:pomodoro-settings"]).toBe(JSON.stringify({ work: 50 }));
      expect(kv["pomodoro:localStorage:session-3"]).toBe("1");
      expect(kv["pomodoro:localStorage:session-1"]).toBeUndefined();
    });
    // The next open starts from what was saved.
    const again = openInFrame("pomodoro", await serve("pomodoro"));
    expect(again.app.load()).toEqual({ settings: { work: 50 }, sessions: ["session-2", "session-3"], length: 3 });

    // A second browser holding the old copy cannot bring it back over the edits.
    const second = await (
      await desktopFetch("/setup-api/webapps/storage", {
        method: "POST",
        body: JSON.stringify({ app: "pomodoro", op: "importBrowser", entries: { "pomodoro-settings": JSON.stringify({ work: 25 }), "session-1": "1" } }),
      })
    ).json();
    expect(second.copied).toEqual([]);
    expect(readKv()["pomodoro:localStorage:pomodoro-settings"]).toBe(JSON.stringify({ work: 50 }));
    expect(readKv()["pomodoro:localStorage:session-1"]).toBeUndefined();
  });
});
