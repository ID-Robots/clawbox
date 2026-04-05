import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/kv-store", () => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvDelete: vi.fn(),
  kvGetAll: vi.fn().mockReturnValue({}),
  kvSetMany: vi.fn(),
}));

import { kvGet, kvSet, kvDelete, kvGetAll, kvSetMany } from "@/lib/kv-store";

const mockKvGet = vi.mocked(kvGet);
const mockKvSet = vi.mocked(kvSet);
const mockKvDelete = vi.mocked(kvDelete);
const mockKvGetAll = vi.mocked(kvGetAll);
const mockKvSetMany = vi.mocked(kvSetMany);

describe("/setup-api/kv", () => {
  let GET: (req: Request) => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockKvGetAll.mockReturnValue({});
    const mod = await import("@/app/setup-api/kv/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  describe("GET", () => {
    it("returns single key value", async () => {
      mockKvGet.mockReturnValue("bar");
      const req = new Request("http://localhost/setup-api/kv?key=foo");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toEqual({ key: "foo", value: "bar" });
    });

    it("rejects invalid key", async () => {
      const req = new Request("http://localhost/setup-api/kv?key=../bad/path");
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("returns all keys with prefix", async () => {
      mockKvGetAll.mockReturnValue({ "clawbox.a": "1", "clawbox.b": "2" });
      const req = new Request("http://localhost/setup-api/kv?prefix=clawbox");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toEqual({ "clawbox.a": "1", "clawbox.b": "2" });
      expect(mockKvGetAll).toHaveBeenCalledWith("clawbox");
    });

    it("returns all keys without params", async () => {
      mockKvGetAll.mockReturnValue({ a: "1" });
      const req = new Request("http://localhost/setup-api/kv");
      const res = await GET(req);
      const body = await res.json();
      expect(body).toEqual({ a: "1" });
      expect(mockKvGetAll).toHaveBeenCalledWith(undefined);
    });
  });

  describe("POST", () => {
    it("sets a key-value pair", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ key: "foo", value: "bar" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockKvSet).toHaveBeenCalledWith("foo", "bar");
    });

    it("deletes a key", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ delete: "foo" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockKvDelete).toHaveBeenCalledWith("foo");
    });

    it("sets multiple entries", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ entries: { a: "1", b: "2" } }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockKvSetMany).toHaveBeenCalledWith({ a: "1", b: "2" });
    });

    it("rejects invalid key on set", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ key: "../bad", value: "x" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects invalid key on delete", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ delete: "../bad" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects invalid request body", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ unknown: true }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("handles invalid JSON", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("filters invalid keys in entries", async () => {
      const req = new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ entries: { valid_key: "1", "../bad": "2" } }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockKvSetMany).toHaveBeenCalledWith({ valid_key: "1" });
    });
  });
});
