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

    // The MCP tools and `clawbox notify` still post the single-slot key; the
    // route folds it into the owner-notice ring every open desktop polls, and
    // the slot itself is never stored.
    it("folds the legacy ui:pending-action slot into the owner-notice ring", async () => {
      const store = new Map<string, string>();
      mockKvSet.mockImplementation((k: string, v: string) => { store.set(k, v); });
      mockKvGet.mockImplementation((k: string) => store.get(k) ?? null);

      const post = await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ key: "ui:pending-action", value: JSON.stringify({ type: "notify", message: "hi" }) }),
      }));
      expect(await post.json()).toEqual({ ok: true });

      const ringRes = await GET(new Request("http://localhost/setup-api/kv?key=ui:pending-actions"));
      const ring = JSON.parse((await ringRes.json()).value);
      expect(ring).toHaveLength(1);
      expect(ring[0]).toMatchObject({ type: "notify", message: "hi" });
      expect(typeof ring[0].id).toBe("string");
      expect(typeof ring[0].ts).toBe("number");

      // A second legacy post appends; it does not replace the first.
      await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ key: "ui:pending-action", value: JSON.stringify({ type: "notify", message: "there" }) }),
      }));
      const afterRes = await GET(new Request("http://localhost/setup-api/kv?key=ui:pending-actions"));
      const after = JSON.parse((await afterRes.json()).value);
      expect(after.map((a: { message: string }) => a.message)).toEqual(["hi", "there"]);

      const slotRes = await GET(new Request("http://localhost/setup-api/kv?key=ui:pending-action"));
      expect((await slotRes.json()).value).toBeNull();
    });

    // A failed ring append is the store's fault, not the request's: it must
    // answer 500, never fall into the outer catch's "Invalid JSON" 400.
    it("answers 500 when the ring append itself fails", async () => {
      mockKvSet.mockImplementation(() => { throw new Error("disk full"); });

      const single = await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ key: "ui:pending-action", value: JSON.stringify({ type: "notify", message: "hi" }) }),
      }));
      expect(single.status).toBe(500);
      expect((await single.json()).error).toBe("Could not record the notice");

      // The batched form: the other entries are already persisted before the
      // append runs, and the response says what actually failed.
      const batched = await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ entries: {
          valid_key: "1",
          "ui:pending-action": JSON.stringify({ type: "notify", message: "hi" }),
        } }),
      }));
      expect(batched.status).toBe(500);
      expect(mockKvSetMany).toHaveBeenCalledWith({ valid_key: "1" });
    });

    // The batched form must not become a side door for the retired slot:
    // `{entries}` used to persist it through kvSetMany, where no desktop
    // would ever see it.
    it("folds the legacy slot out of a batched entries post too", async () => {
      const store = new Map<string, string>();
      mockKvSet.mockImplementation((k: string, v: string) => { store.set(k, v); });
      mockKvGet.mockImplementation((k: string) => store.get(k) ?? null);

      const res = await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ entries: {
          "ui:pending-action": JSON.stringify({ type: "notify", message: "batched" }),
          other_key: "kept",
        } }),
      }));
      expect(await res.json()).toEqual({ ok: true });

      // The plain entry still lands; the slot never does.
      expect(mockKvSetMany).toHaveBeenCalledWith({ other_key: "kept" });
      const ringRes = await GET(new Request("http://localhost/setup-api/kv?key=ui:pending-actions"));
      const ring = JSON.parse((await ringRes.json()).value);
      expect(ring).toHaveLength(1);
      expect(ring[0]).toMatchObject({ type: "notify", message: "batched" });

      // A slot value the ring cannot hold is dropped like any other invalid
      // batch entry — not stored, not a 400 for the rest of the batch.
      const bad = await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({ entries: { "ui:pending-action": "not json", still_ok: "1" } }),
      }));
      expect(await bad.json()).toEqual({ ok: true });
      expect(mockKvSetMany).toHaveBeenLastCalledWith({ still_ok: "1" });
      const ringAfter = JSON.parse((await (await GET(
        new Request("http://localhost/setup-api/kv?key=ui:pending-actions"),
      )).json()).value);
      expect(ringAfter).toHaveLength(1);
    });

    // The legacy slot is how the `ui_notify` MCP tool and `clawbox notify`
    // reach the ring, and `ui_notify` is driven by the AGENT. A notice that
    // can be CLICKED is a different thing from a notice that can be read, so
    // an out-of-process writer may not name a destination: only ClawBox's own
    // in-process producers attach one.
    it("strips a click destination from a legacy notice — the agent cannot make a toast clickable", async () => {
      const store = new Map<string, string>();
      mockKvSet.mockImplementation((k: string, v: string) => { store.set(k, v); });
      mockKvGet.mockImplementation((k: string) => store.get(k) ?? null);

      await POST(new Request("http://localhost/setup-api/kv", {
        method: "POST",
        body: JSON.stringify({
          key: "ui:pending-action",
          value: JSON.stringify({ type: "notify", message: "click me", action: { open: "settings", section: "email" } }),
        }),
      }));

      const ring = JSON.parse((await (await GET(
        new Request("http://localhost/setup-api/kv?key=ui:pending-actions"),
      )).json()).value);
      expect(ring).toHaveLength(1);
      expect(ring[0]).toMatchObject({ type: "notify", message: "click me" });
      expect(ring[0]).not.toHaveProperty("action");
    });

    it("refuses a legacy pending action that is not a JSON object", async () => {
      for (const value of ["not json", JSON.stringify(["array"])]) {
        const res = await POST(new Request("http://localhost/setup-api/kv", {
          method: "POST",
          body: JSON.stringify({ key: "ui:pending-action", value }),
        }));
        expect(res.status).toBe(400);
      }
      expect(mockKvSet).not.toHaveBeenCalled();
    });
  });
});
