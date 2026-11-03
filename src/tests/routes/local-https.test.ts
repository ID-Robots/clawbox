import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveEnv } from "@/tests/helpers/env";
import { DAY, HOST, writeStateFile } from "@/tests/helpers/local-https";

/**
 * /setup-api/local-https (the owner's switch and status) and
 * /setup-api/local-https/hint (where a plain-HTTP page may move, read before
 * sign-in). Pinned: only the owner's browser, on this box's own pages, reads
 * or flips the switch — it publishes the LAN address — and the hint offers a
 * url only while :443 serves a valid certificate for the switched-on name, to
 * a LAN request that is not already there.
 */

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  status: { enabled: false, hostname: null, serving: false, issuing: false } as Record<string, unknown>,
  setEnabled: vi.fn(async (enabled: boolean) => ({ ...h.status, enabled })),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/local-https", () => ({
  localHttpsStatus: vi.fn(async () => h.status),
  setLocalHttpsEnabled: h.setEnabled,
}));

const LISTENER = Symbol.for("clawbox.local-https.listener");

function post(body: unknown) {
  return new Request("http://192.168.1.20/setup-api/local-https", {
    method: "POST",
    headers: { "content-type": "application/json", host: "192.168.1.20" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/setup-api/local-https", () => {
  beforeEach(() => {
    h.owner.mockResolvedValue(true);
    h.sameOrigin.mockReturnValue(true);
    h.setEnabled.mockClear();
  });

  it("answers the owner the status, uncached", async () => {
    const { GET } = await import("@/app/setup-api/local-https/route");
    const res = await GET(new Request("http://192.168.1.20/setup-api/local-https"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(h.status);
  });

  it("refuses anyone but the owner, reading or switching", async () => {
    h.owner.mockResolvedValue(false);
    const { GET, POST } = await import("@/app/setup-api/local-https/route");
    const read = await GET(new Request("http://192.168.1.20/setup-api/local-https"));
    expect(read.status).toBe(403);
    expect((await read.json()).code).toBe("owner_only");
    const write = await POST(post({ enabled: true }));
    expect(write.status).toBe(403);
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("refuses a switch from another origin", async () => {
    h.sameOrigin.mockReturnValue(false);
    const { POST } = await import("@/app/setup-api/local-https/route");
    const res = await POST(post({ enabled: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ enabled: "yes" }], [[true]], ["not json"]])("refuses the body %j", async (body) => {
    const { POST } = await import("@/app/setup-api/local-https/route");
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_body");
  });

  it("switches and answers the new status", async () => {
    const { POST } = await import("@/app/setup-api/local-https/route");
    const res = await POST(post({ enabled: true }));
    expect(res.status).toBe(200);
    expect(h.setEnabled).toHaveBeenCalledWith(true);
    expect((await res.json()).enabled).toBe(true);
  });

  it("is a 500 with a code when the switch cannot be saved", async () => {
    h.setEnabled.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const { POST } = await import("@/app/setup-api/local-https/route");
    const res = await POST(post({ enabled: false }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("store_write_failed");
  });
});

describe("/setup-api/local-https/hint", () => {
  let root: string;
  let restoreEnv: () => void;
  let before: unknown;

  beforeEach(() => {
    restoreEnv = saveEnv("CLAWBOX_ROOT");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "local-https-hint-"));
    process.env.CLAWBOX_ROOT = root;
    before = (globalThis as Record<symbol, unknown>)[LISTENER];
  });
  afterEach(() => {
    (globalThis as Record<symbol, unknown>)[LISTENER] = before;
    fs.rmSync(root, { recursive: true, force: true });
    restoreEnv();
  });

  function serve(over: Partial<{ hostname: string; notAfter: number }> = {}, port = 443) {
    (globalThis as Record<symbol, unknown>)[LISTENER] = {
      status: () => ({ hostname: HOST, notBefore: Date.now() - DAY, notAfter: Date.now() + 60 * DAY, fingerprint256: "AA", ...over }),
      port,
      refresh: () => {},
    };
  }

  async function hint(host: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/setup-api/local-https/hint/route");
    const res = await GET(new Request(`http://${host}/setup-api/local-https/hint`, { headers: { host, ...headers } }));
    expect(res.headers.get("cache-control")).toBe("no-store");
    return (await res.json()) as { url: string | null };
  }

  it("offers the secure address while it is on and served", async () => {
    writeStateFile(root, { enabled: true, hostname: HOST });
    serve();
    expect(await hint("192.168.1.20")).toEqual({ url: `https://${HOST}` });
    expect(await hint("clawbox.local")).toEqual({ url: `https://${HOST}` });
  });

  it("names the port when the listener is not on 443", async () => {
    writeStateFile(root, { enabled: true, hostname: HOST });
    serve({}, 8443);
    expect(await hint("192.168.1.20")).toEqual({ url: `https://${HOST}:8443` });
  });

  it("offers nothing while no valid certificate is served", async () => {
    writeStateFile(root, { enabled: true, hostname: HOST });
    delete (globalThis as Record<symbol, unknown>)[LISTENER];
    expect(await hint("192.168.1.20")).toEqual({ url: null });
    serve({ notAfter: Date.now() - 1 });
    expect(await hint("192.168.1.20")).toEqual({ url: null });
    (globalThis as Record<symbol, unknown>)[LISTENER] = { status: () => null, port: 443, refresh: () => {} };
    expect(await hint("192.168.1.20")).toEqual({ url: null });
  });

  it("offers nothing once the owner switched it off, whatever is still served", async () => {
    writeStateFile(root, { enabled: false, hostname: null });
    serve();
    expect(await hint("192.168.1.20")).toEqual({ url: null });
  });

  it("offers nothing for a served name the state does not name", async () => {
    writeStateFile(root, { enabled: true, hostname: "aaaabbbbccccdddd.lan.clawbox.com" });
    serve();
    expect(await hint("192.168.1.20")).toEqual({ url: null });
  });

  it("offers nothing through the tunnel, on loopback, or on the name itself", async () => {
    writeStateFile(root, { enabled: true, hostname: HOST });
    serve();
    expect(await hint("box.clawbox.tech", { "cf-connecting-ip": "203.0.113.7" })).toEqual({ url: null });
    expect(await hint("localhost")).toEqual({ url: null });
    expect(await hint("127.0.0.1")).toEqual({ url: null });
    expect(await hint(HOST)).toEqual({ url: null });
    expect(await hint("")).toEqual({ url: null });
  });
});
