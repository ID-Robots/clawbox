/**
 * @vitest-environment node
 *
 * /setup-api/webapps/storage — the desktop's end of the webapp legacy-storage
 * layer (TASK-1150), and the serve-time half in /setup-api/webapps. The
 * end-to-end upgrade is webapps-legacy-storage-upgrade.test.ts; these are the
 * route's own edges: who may call it, what it refuses, and what it does when
 * the store cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { saveEnv } from "@/tests/helpers/env";

type Handler = (req: NextRequest) => Promise<Response>;

let restoreEnv: () => void;
let base: string;
let data: string;
let storageGET: Handler;
let storagePOST: Handler;
let webappsGET: Handler;

const LS_APP = `<!doctype html><html><head><title>Timer</title></head><body><script>
  var saved = localStorage.getItem('timer-state');
  fetch('/setup-api/kv?key=timer:laps');
</script></body></html>`;

function installApp(id: string, html: string): void {
  const dir = path.join(data, "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
}

function writeKv(kv: Record<string, string>): void {
  fs.writeFileSync(path.join(data, "kv.json"), JSON.stringify(kv));
}

function readKv(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(data, "kv.json"), "utf-8"));
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return storagePOST(
    new NextRequest("http://clawbox.local/setup-api/webapps/storage", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function migrate(): Promise<void> {
  const { migrateLegacyWebappStorage } = await import("@/lib/webapp-legacy-storage-migration");
  migrateLegacyWebappStorage();
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-storage-route-"));
  data = path.join(base, "clawbox", "data");
  fs.mkdirSync(path.join(data, "webapps"), { recursive: true });
  process.env.CLAWBOX_ROOT = path.join(base, "clawbox");
  vi.resetModules();
  const storage = await import("@/app/setup-api/webapps/storage/route");
  storageGET = storage.GET as unknown as Handler;
  storagePOST = storage.POST as unknown as Handler;
  webappsGET = (await import("@/app/setup-api/webapps/route")).GET as unknown as Handler;
  writeKv({ "timer:laps": "[3]", "timer:localStorage:timer-state": "stale" });
  installApp("timer", LS_APP);
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("who may call it", () => {
  it("refuses a cross-origin POST, and an opaque frame's `Origin: null` above all", async () => {
    for (const origin of ["null", "http://evil.example"]) {
      const res = await post({ app: "timer", op: "kv", request: { method: "GET", search: "?key=timer:laps" } }, { Origin: origin });
      expect(res.status, origin).toBe(403);
      expect((await res.json()).code).toBe("cross_origin");
    }
  });

  it("answers the desktop's own same-origin POST", async () => {
    const res = await post(
      { app: "timer", op: "kv", request: { method: "GET", search: "?key=timer:laps" } },
      { Origin: "http://clawbox.local" },
    );
    expect(res.status).toBe(200);
    // `timer:laps` is already in the timer app's own namespace.
    expect(await res.json()).toEqual({ status: 200, body: { key: "timer:laps", value: "[3]" } });
  });

  it("refuses an id that is not an app id, and an operation it does not have", async () => {
    for (const app of ["../etc", "__proto__", "a b", "", 42]) {
      const res = await post({ app, op: "kv", request: { method: "GET", search: "" } });
      expect(res.status, String(app)).toBe(400);
      expect((await res.json()).code).toBe("invalid_app_id");
    }
    const res = await post({ app: "timer", op: "drop" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("unknown_op");
    expect((await post("{ not json")).status).toBe(400);
    expect((await storageGET(new NextRequest("http://clawbox.local/setup-api/webapps/storage?app=..%2Fx"))).status).toBe(400);
  });
});

describe("the v3.9 KV answers", () => {
  it("keeps v3.9's statuses for a bad request", async () => {
    const kv = (request: Record<string, unknown>) => post({ app: "timer", op: "kv", request }).then((r) => r.json());
    expect(await kv({ method: "GET", search: "?key=bad key" })).toEqual({ status: 400, body: { error: "Invalid key" } });
    expect(await kv({ method: "GET", search: "?prefix=bad key" })).toEqual({ status: 400, body: { error: "Invalid prefix" } });
    expect(await kv({ method: "POST", body: "nope" })).toEqual({ status: 400, body: { error: "Invalid JSON" } });
    expect(await kv({ method: "POST", body: "null" })).toEqual({ status: 400, body: { error: "Invalid JSON" } });
    expect(await kv({ method: "POST", body: "{}" })).toEqual({ status: 400, body: { error: "Invalid request" } });
    expect(await kv({ method: "POST", body: JSON.stringify({ key: "__proto__", value: "x" }) })).toEqual({ status: 400, body: { error: "Invalid key" } });
    expect(await kv({ method: "POST", body: JSON.stringify({ key: "big", value: "x".repeat(256 * 1024 + 1) }) })).toEqual({
      status: 413,
      body: { error: "Value too large (max 262144 bytes)" },
    });
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, "v"]));
    expect(await kv({ method: "POST", body: JSON.stringify({ entries: many }) })).toEqual({ status: 413, body: { error: "Too many entries (max 500)" } });
    expect(await kv({ method: "PUT", body: "{}" })).toEqual({ status: 405, body: null });
  });

  it("answers 500 and writes nothing over a store it cannot read", async () => {
    fs.writeFileSync(path.join(data, "kv.json"), "{ torn");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ app: "timer", op: "kv", request: { method: "POST", body: JSON.stringify({ key: "a", value: "b" }) } });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("store_unreadable");
    expect(fs.readFileSync(path.join(data, "kv.json"), "utf-8")).toBe("{ torn");
    const ls = await post({ app: "timer", op: "localStorage", write: { set: { a: "b" } } });
    expect(ls.status).toBe(500);
    expect(fs.readFileSync(path.join(data, "kv.json"), "utf-8")).toBe("{ torn");
    errors.mockRestore();
  });
});

describe("localStorage writes", () => {
  it("applies clear, then removals, then sets — inside the app's namespace only", async () => {
    writeKv({
      "timer:localStorage:a": "1",
      "timer:localStorage:b": "2",
      "timer:laps": "[3]",
      "other:localStorage:a": "theirs",
    });
    const res = await post({ app: "timer", op: "localStorage", write: { clear: true, set: { c: "3", "my key": "4" }, remove: ["c-old"] } });
    expect(await res.json()).toEqual({ dropped: [] });
    const kv = readKv();
    expect(kv["timer:localStorage:a"]).toBeUndefined();
    expect(kv["timer:localStorage:b"]).toBeUndefined();
    expect(kv["timer:localStorage:c"]).toBe("3");
    expect(Object.keys(kv).some((k) => k.startsWith("timer:localStorage64:"))).toBe(true);
    expect(kv["timer:laps"]).toBe("[3]");
    expect(kv["other:localStorage:a"]).toBe("theirs");
  });

  it("reports what it could not keep", async () => {
    const res = await post({ app: "timer", op: "localStorage", write: { set: { huge: "x".repeat(256 * 1024 + 1), long: "ok", ["k".repeat(300)]: "v" } } });
    const { dropped } = await res.json();
    expect(dropped).toContain("huge");
    expect(dropped).toContain("k".repeat(300));
    expect(readKv()["timer:localStorage:long"]).toBe("ok");
  });
});

describe("the browser import", () => {
  it("has nothing to offer before the migration, or for an app it did not see", async () => {
    let res = await storageGET(new NextRequest("http://clawbox.local/setup-api/webapps/storage?app=timer"));
    expect(await res.json()).toEqual({ migrated: false, plan: null });
    const refused = await (await post({ app: "timer", op: "importBrowser", entries: { "timer-state": "x" } })).json();
    expect(refused).toEqual({ copied: [], kept: [], refused: ["timer-state"] });

    await migrate();
    installApp("later", LS_APP); // created after the migration's census
    res = await storageGET(new NextRequest("http://clawbox.local/setup-api/webapps/storage?app=later"));
    expect(await res.json()).toEqual({ migrated: true, plan: null });
    const later = await (await post({ app: "later", op: "importBrowser", entries: { "timer-state": "x" } })).json();
    expect(later.copied).toEqual([]);
  });

  it("keeps a value the app already has, and never asks for the same key twice", async () => {
    await migrate();
    const res = await (await post({ app: "timer", op: "importBrowser", entries: { "timer-state": "from the browser" } })).json();
    expect(res).toEqual({ copied: [], kept: ["timer-state"], refused: [] });
    expect(readKv()["timer:localStorage:timer-state"]).toBe("stale");
    const plan = await (await storageGET(new NextRequest("http://clawbox.local/setup-api/webapps/storage?app=timer"))).json();
    expect(plan.plan.imported).toEqual(["timer-state"]);
  });
});

describe("serving a legacy app's page", () => {
  it("puts its saved localStorage in the page, escaped so no value can end the script", async () => {
    writeKv({ "timer:localStorage:timer-state": "</script><script>alert(1)</script>\u2028" });
    await migrate();
    const res = await webappsGET(new NextRequest("http://clawbox.local/setup-api/webapps?app=timer"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    const shim = html.slice(0, html.indexOf("var saved"));
    expect(shim).toContain("__clawboxLegacyStorage");
    expect(shim).toContain("\\u003c/script\\u003e");
    expect(shim).not.toContain("</script><script>alert(1)");
    expect(shim).not.toContain("\u2028");
    // Exactly one closing tag of ours before the app's own script starts.
    expect(shim.match(/<\/script>/g)).toHaveLength(1);
  });

  it("keeps a PUBLIC app's saved data out of its page and saves nothing from it", async () => {
    writeKv({ "timer:localStorage:timer-state": "private" });
    fs.writeFileSync(
      path.join(data, "config.json"),
      JSON.stringify({ "pref:installed_meta": { timer: { name: "Timer", color: "#fff", iconUrl: "", webappUrl: "/setup-api/webapps?app=timer", public: true } } }),
    );
    await migrate();
    const html = await (await webappsGET(new NextRequest("http://clawbox.local/setup-api/webapps?app=timer"))).text();
    expect(html).toContain("__clawboxLegacyStorage");
    expect(html).not.toContain("private");
    expect(html).toContain('"persist":false');
  });

  it("leaves localStorage out of the layer when the saved data cannot be read", async () => {
    await migrate();
    fs.writeFileSync(path.join(data, "kv.json"), "{ torn");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await (await webappsGET(new NextRequest("http://clawbox.local/setup-api/webapps?app=timer"))).text();
    errors.mockRestore();
    // The KV half still goes in (it asks the store per request); the storage
    // half does not, so the app cannot start from an empty one and save it.
    expect(html).toContain('"kv":true');
    expect(html).toContain('"storage":null');
  });

  it("serves an asset, and a page that does not use the old APIs, untouched", async () => {
    await migrate();
    fs.writeFileSync(path.join(data, "webapps", "timer", "app.js"), "localStorage.getItem('x')");
    const asset = await webappsGET(new NextRequest("http://clawbox.local/setup-api/webapps?app=timer&file=app.js"));
    expect(await asset.text()).toBe("localStorage.getItem('x')");
    installApp("plain", "<!doctype html><html><head></head><body>hi</body></html>");
    const plain = await webappsGET(new NextRequest("http://clawbox.local/setup-api/webapps?app=plain"));
    expect(await plain.text()).toBe("<!doctype html><html><head></head><body>hi</body></html>");
  });
});
