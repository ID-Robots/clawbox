// @vitest-environment jsdom
/**
 * The webapp sandbox contract, host side.
 *
 * A framed webapp is HTML the agent wrote. The sandbox must never hand it the
 * desktop's origin, and the KV bridge that replaces the direct fetch it lost
 * must answer only the frame a request came from, only under that app's own
 * key namespace.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBAPP_IFRAME_SANDBOX, WEBAPP_KV_CLIENT_SNIPPET } from "@/lib/webapp-sandbox";
import {
  WEBAPP_FRAME_ID_ATTR,
  attachWebappKvBridge,
  serveWebappKvRequest,
  webappKvKey,
} from "@/lib/webapp-kv-bridge";

type FetchCall = { url: string; method: string; body: unknown };

function stubKv(answer: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: true, status: 200, json: async () => answer };
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete (window as Window & { clawboxKv?: unknown }).clawboxKv;
});

describe("the webapp sandbox", () => {
  it("never grants the framed app the desktop's origin", () => {
    expect(WEBAPP_IFRAME_SANDBOX).toContain("allow-scripts");
    expect(WEBAPP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("ships a guest snippet that defines window.clawboxKv and refuses to run outside a frame", async () => {
    // The snippet may carry its own <script> element; only the code is run here.
    const js = WEBAPP_KV_CLIENT_SNIPPET.replace(/<\/?script[^>]*>/gi, "");
    expect(js).not.toContain("/setup-api/kv");
    new Function(js)();
    const api = (window as Window & { clawboxKv?: Record<string, (...args: unknown[]) => Promise<unknown>> }).clawboxKv;
    expect(api).toBeDefined();
    expect(Object.keys(api!).sort()).toEqual(["delete", "get", "list", "set"]);
    // Top-level, window.parent === window: there is no host to answer.
    await expect(api!.get("items")).rejects.toThrow();
  });
});

describe("webappKvKey", () => {
  it("forces the app's namespace and refuses another app's", () => {
    expect(webappKvKey("notes", "items")).toBe("notes:items");
    expect(webappKvKey("notes", "notes:items")).toBe("notes:items");
    expect(webappKvKey("notes", "todo:items")).toBeNull();
    expect(webappKvKey("notes", "")).toBeNull();
    expect(webappKvKey("notes", 42)).toBeNull();
  });
});

describe("serveWebappKvRequest", () => {
  it("reads, writes, deletes and lists under the app's prefix with the host's fetch", async () => {
    const calls = stubKv({ key: "notes:items", value: "[1]" });
    expect(await serveWebappKvRequest("notes", { id: "a", op: "get", key: "items" })).toEqual({ id: "a", ok: true, value: "[1]" });
    expect(calls[0]).toMatchObject({ url: "/setup-api/kv?key=notes%3Aitems", method: "GET" });

    expect(await serveWebappKvRequest("notes", { id: "b", op: "set", key: "items", value: { a: 1 } })).toEqual({ id: "b", ok: true });
    expect(calls[1]).toMatchObject({ url: "/setup-api/kv", method: "POST", body: { key: "notes:items", value: '{"a":1}' } });

    expect(await serveWebappKvRequest("notes", { id: "c", op: "delete", key: "notes:items" })).toEqual({ id: "c", ok: true });
    expect(calls[2]).toMatchObject({ body: { delete: "notes:items" } });

    await serveWebappKvRequest("notes", { id: "d", op: "list" });
    expect(calls[3]).toMatchObject({ url: "/setup-api/kv?prefix=notes%3A", method: "GET" });
  });

  it("refuses a key outside the namespace and an unknown op without touching the store", async () => {
    const calls = stubKv();
    expect(await serveWebappKvRequest("notes", { id: "a", op: "get", key: "todo:items" })).toEqual({
      id: "a", ok: false, error: "key outside app namespace",
    });
    expect(await serveWebappKvRequest("notes", { id: "b", op: "drop" as "get", key: "items" })).toEqual({ id: "b", ok: false, error: "unsupported" });
    expect(await serveWebappKvRequest("notes", { id: "c", op: "get" })).toEqual({ id: "c", ok: false, error: "invalid key" });
    expect(calls).toHaveLength(0);
  });

  it("answers a failed call with the route's error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 413, json: async () => ({ error: "Value too large" }) })));
    expect(await serveWebappKvRequest("notes", { id: "a", op: "set", key: "items", value: "x" })).toEqual({ id: "a", ok: false, error: "Value too large" });
  });
});

describe("attachWebappKvBridge", () => {
  function mountFrame(appId: string) {
    const iframe = document.createElement("iframe");
    iframe.setAttribute(WEBAPP_FRAME_ID_ATTR, appId);
    document.body.appendChild(iframe);
    const guest = iframe.contentWindow!;
    const replies: unknown[] = [];
    vi.spyOn(guest, "postMessage").mockImplementation(((msg: unknown) => { replies.push(msg); }) as typeof guest.postMessage);
    return { guest, replies };
  }

  function post(source: Window, req: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent("message", { data: { clawboxKv: req }, source }));
  }

  it("answers the frame a request came from, under that app's namespace", async () => {
    const calls = stubKv({ key: "notes:items", value: "[1]" });
    const { guest, replies } = mountFrame("notes");
    const detach = attachWebappKvBridge();
    try {
      post(guest, { id: "r1", op: "get", key: "items" });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toEqual({ clawboxKvResult: { id: "r1", ok: true, value: "[1]" } });
      expect(calls[0].url).toBe("/setup-api/kv?key=notes%3Aitems");

      // Another app's keys are out of reach, however the request names them.
      post(guest, { id: "r2", op: "get", key: "todo:items" });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[1]).toEqual({ clawboxKvResult: { id: "r2", ok: false, error: "key outside app namespace" } });
      expect(calls).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it("ignores a message from a window that is not a webapp frame", async () => {
    const calls = stubKv();
    const { replies } = mountFrame("notes");
    const detach = attachWebappKvBridge();
    try {
      post(window, { id: "r1", op: "get", key: "items" });
      await new Promise((r) => setTimeout(r, 20));
      expect(replies).toHaveLength(0);
      expect(calls).toHaveLength(0);
    } finally {
      detach();
    }
  });

  it("stops answering once detached", async () => {
    const calls = stubKv();
    const { guest, replies } = mountFrame("notes");
    attachWebappKvBridge()();
    post(guest, { id: "r1", op: "get", key: "items" });
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
