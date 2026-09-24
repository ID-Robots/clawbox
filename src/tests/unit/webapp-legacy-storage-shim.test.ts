/**
 * @vitest-environment node
 *
 * The guest half of the webapp legacy-storage layer (TASK-1150): the script
 * that goes first in a pre-v4.0 webapp's page. Run in a `vm` context standing
 * in for the sandboxed frame — a throwing localStorage, a parent that records
 * what the page posts — so every case is about the script alone. The whole
 * chain, script to kv.json, is webapps-legacy-storage-upgrade.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import vm from "vm";
import {
  injectLegacyStorageShim,
  legacyStorageShimScript,
  type LegacyStorageShimConfig,
} from "@/lib/webapp-legacy-storage-shim";

type Posted = { clawboxKv: { id: string; op: string; value: Record<string, unknown> } };

interface Frame {
  run: (code: string) => unknown;
  posted: Posted[];
  answer: (index: number, result: { ok: boolean; value?: unknown; error?: string }, source?: "parent" | "other") => void;
  nativeFetch: ReturnType<typeof vi.fn>;
}

function frame(config: LegacyStorageShimConfig, opts: { framed?: boolean; nativeStorage?: boolean } = {}): Frame {
  const framed = opts.framed ?? true;
  const posted: Posted[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const parent = { postMessage: (msg: Posted) => posted.push(msg) };
  const other = {};
  const nativeFetch = vi.fn(async () => new Response("native"));
  const ctx: Record<string, unknown> = {
    location: new URL("http://clawbox.local/setup-api/webapps?app=demo"),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "message") listeners.push(fn);
    },
    fetch: nativeFetch,
    Request,
    Response,
    URL,
    TextEncoder,
    DOMException,
    setTimeout,
    clearTimeout,
    console,
    __framedParent: parent,
    __opaque: () => {
      throw new DOMException("The document is sandboxed and lacks the 'allow-same-origin' flag.", "SecurityError");
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `globalThis.window = globalThis;
     globalThis.parent = ${framed ? "__framedParent" : "globalThis"};
     ${opts.nativeStorage ? "" : `Object.defineProperty(globalThis, "localStorage", { configurable: true, enumerable: true, get: __opaque });
     Object.defineProperty(globalThis, "sessionStorage", { configurable: true, enumerable: true, get: __opaque });`}`,
    ctx,
  );
  if (opts.nativeStorage) {
    vm.runInContext(
      `globalThis.localStorage = { getItem: function () { return "native"; }, setItem: function () {} };
       globalThis.sessionStorage = { getItem: function () { return "native"; }, setItem: function () {} };`,
      ctx,
    );
  }
  const script = legacyStorageShimScript(config).replace(/^<script>|<\/script>$/g, "");
  vm.runInContext(script, ctx);
  return {
    run: (code) => vm.runInContext(code, ctx),
    posted,
    nativeFetch,
    answer: (index, result, source = "parent") => {
      const id = posted[index].clawboxKv.id;
      for (const fn of listeners) fn({ data: { clawboxKvResult: { id, ...result } }, source: source === "parent" ? parent : other });
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("where the script goes", () => {
  const script = "<script>SHIM</script>";
  it("goes first inside <head>, never before the doctype", () => {
    expect(injectLegacyStorageShim("<!doctype html><html><head><title>x</title><script>app()</script>", script)).toBe(
      "<!doctype html><html><head><script>SHIM</script><title>x</title><script>app()</script>",
    );
    expect(injectLegacyStorageShim('<HTML lang="en"><HEAD class="h">', script)).toBe('<HTML lang="en"><HEAD class="h"><script>SHIM</script>');
    expect(injectLegacyStorageShim("<!DOCTYPE html><html><body><script>app()</script>", script)).toBe(
      "<!DOCTYPE html><html><script>SHIM</script><body><script>app()</script>",
    );
    expect(injectLegacyStorageShim("<!doctype html><script>app()</script>", script)).toBe(
      "<!doctype html><script>SHIM</script><script>app()</script>",
    );
    expect(injectLegacyStorageShim("<script>app()</script>", script)).toBe("<script>SHIM</script><script>app()</script>");
  });

  it("does not take <header> for <head>", () => {
    expect(injectLegacyStorageShim("<html><body><header>h</header>", script)).toBe("<html><script>SHIM</script><body><header>h</header>");
  });
});

describe("fetch('/setup-api/kv')", () => {
  it("goes through the bridge and comes back as the old route's Response", async () => {
    const f = frame({ kv: true, storage: null });
    const pending = f.run(`fetch('/setup-api/kv?key=todo:items').then(function (r) { return r.json().then(function (b) { return [r.status, b]; }); })`) as Promise<unknown>;
    await tick();
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0].clawboxKv).toMatchObject({ op: "legacyKv", value: { method: "GET", search: "?key=todo:items", body: "" } });
    f.answer(0, { ok: true, value: { status: 200, body: { key: "todo:items", value: "[1]" } } });
    expect(await pending).toEqual([200, { key: "todo:items", value: "[1]" }]);
    expect(f.nativeFetch).not.toHaveBeenCalled();
  });

  it("carries a POST body, a Request, an absolute URL and the trailing slash", async () => {
    const f = frame({ kv: true, storage: null });
    f.run(`fetch('/setup-api/kv/', { method: 'post', body: '{"key":"a","value":"b"}' })`);
    f.run(`fetch(new Request(location.origin + '/setup-api/kv', { method: 'POST', body: '{"delete":"a"}' }))`);
    await tick();
    await tick();
    expect(f.posted.map((p) => p.clawboxKv.value)).toEqual([
      { method: "POST", search: "", body: '{"key":"a","value":"b"}' },
      { method: "POST", search: "", body: '{"delete":"a"}' },
    ]);
  });

  it("leaves every other request to the browser", async () => {
    const f = frame({ kv: true, storage: null });
    await f.run(`fetch('/setup-api/files')`);
    await f.run(`fetch('https://example.com/setup-api/kv')`);
    await f.run(`fetch('/setup-api/kvx')`);
    expect(f.nativeFetch).toHaveBeenCalledTimes(3);
    expect(f.posted).toHaveLength(0);
  });

  it("rejects the way a failed network call does when the desktop refuses", async () => {
    const f = frame({ kv: true, storage: null });
    const pending = f.run(`fetch('/setup-api/kv?key=a')`) as Promise<unknown>;
    await tick();
    f.answer(0, { ok: false, error: "store_unreadable" });
    await expect(pending).rejects.toThrow("Failed to fetch");
  });

  it("ignores an answer from any window but its parent", async () => {
    const f = frame({ kv: true, storage: null });
    let settled = false;
    (f.run(`fetch('/setup-api/kv?key=a')`) as Promise<unknown>).then(() => (settled = true), () => (settled = true));
    await tick();
    f.answer(0, { ok: true, value: { status: 200, body: {} } }, "other");
    await tick();
    expect(settled).toBe(false);
  });

  it("is the browser's own fetch when the page is not framed", async () => {
    const f = frame({ kv: true, storage: null }, { framed: false });
    await f.run(`fetch('/setup-api/kv?key=a')`);
    expect(f.nativeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("localStorage", () => {
  it("is a working Storage, seeded with what the app saved", () => {
    const f = frame({ kv: false, storage: { seed: { theme: "dark", count: "2" }, persist: true } });
    expect(f.run(`localStorage.getItem('theme')`)).toBe("dark");
    expect(f.run(`localStorage.theme`)).toBe("dark");
    expect(f.run(`localStorage['count']`)).toBe("2");
    expect(f.run(`localStorage.getItem('nope')`)).toBeNull();
    expect(f.run(`localStorage.nope`)).toBeUndefined();
    expect(f.run(`localStorage.length`)).toBe(2);
    expect(f.run(`JSON.stringify(Object.keys(localStorage).sort())`)).toBe('["count","theme"]');
    expect(f.run(`'theme' in localStorage`)).toBe(true);
    expect(f.run(`typeof localStorage.setItem`)).toBe("function");
    expect(f.run(`localStorage.key(0) !== null && localStorage.key(5) === null`)).toBe(true);
    expect(f.run(`JSON.stringify(localStorage)`)).toBe('{"theme":"dark","count":"2"}');
    f.run(`localStorage.n = 5; delete localStorage.theme;`);
    expect(f.run(`localStorage.getItem('n')`)).toBe("5");
    expect(f.run(`localStorage.getItem('theme')`)).toBeNull();
  });

  it("sends the page's changes in order, one batch in flight at a time", async () => {
    const f = frame({ kv: false, storage: { seed: { a: "1" }, persist: true } });
    f.run(`localStorage.setItem('a', '2'); localStorage.setItem('b', '1'); localStorage.removeItem('a');`);
    await tick();
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0].clawboxKv).toMatchObject({ op: "legacyLocalStorage", value: { clear: false, set: { b: "1" }, remove: ["a"] } });

    // While that one is in flight, the next changes wait and coalesce.
    f.run(`localStorage.setItem('c', '1'); localStorage.clear(); localStorage.setItem('d', '4');`);
    await tick();
    expect(f.posted).toHaveLength(1);
    f.answer(0, { ok: true, value: { dropped: [] } });
    await tick();
    expect(f.posted).toHaveLength(2);
    expect(f.posted[1].clawboxKv.value).toEqual({ clear: true, set: { d: "4" }, remove: [] });
  });

  it("refuses a value too large to keep, the way a full storage does", () => {
    const f = frame({ kv: false, storage: { seed: {}, persist: true } });
    expect(() => f.run(`localStorage.setItem('big', 'x'.repeat(262145))`)).toThrow(/larger than ClawBox can store/);
    expect(f.run(`localStorage.getItem('big')`)).toBeNull();
  });

  it("keeps everything in memory when it must not persist", async () => {
    const f = frame({ kv: false, storage: { seed: {}, persist: false } });
    f.run(`localStorage.setItem('big', 'x'.repeat(300000))`);
    await tick();
    expect(f.posted).toHaveLength(0);
    expect((f.run(`localStorage.getItem('big')`) as string).length).toBe(300000);

    const top = frame({ kv: false, storage: { seed: { a: "1" }, persist: true } }, { framed: false });
    top.run(`localStorage.setItem('a', '2')`);
    await tick();
    expect(top.posted).toHaveLength(0);
    expect(top.run(`localStorage.getItem('a')`)).toBe("2");
  });

  it("gives sessionStorage back in memory", async () => {
    const f = frame({ kv: false, storage: { seed: { a: "1" }, persist: true } });
    f.run(`sessionStorage.setItem('s', '1')`);
    await tick();
    expect(f.run(`sessionStorage.getItem('s')`)).toBe("1");
    expect(f.run(`sessionStorage.getItem('a')`)).toBeNull();
    expect(f.posted).toHaveLength(0);
  });

  it("leaves a storage the page CAN use alone, and never runs twice", () => {
    const f = frame({ kv: false, storage: { seed: { a: "1" }, persist: true } }, { nativeStorage: true });
    expect(f.run(`localStorage.getItem('a')`)).toBe("native");
    f.run(legacyStorageShimScript({ kv: true, storage: { seed: { a: "x" }, persist: true } }).replace(/^<script>|<\/script>$/g, ""));
    expect(f.run(`localStorage.getItem('a')`)).toBe("native");
  });
});
