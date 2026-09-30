import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/kiosk/tabs — the desktop taskbar's view of the kiosk Chrome.
 *
 * The lib is mocked; what this file pins is what crosses the HTTP boundary:
 * the GET is a plain 200 whether or not a kiosk exists, every POST re-checks
 * the owner's cookie AND our own origin before the lib is ever called (the
 * MCP bearer must not be able to open a page on the owner's screen or close
 * the desktop tab), and a dead port is a 503 `{ available: false }` rather
 * than a 500.
 */

const h = vi.hoisted(() => ({
  ownerSession: true,
  sameOrigin: true,
  calls: [] as string[],
  available: true,
}));

vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => h.ownerSession),
}));
vi.mock("@/lib/same-origin", () => ({
  isSameOriginRequest: vi.fn(() => h.sameOrigin),
}));

vi.mock("@/lib/kiosk-tabs", () => {
  const unavailable = { ok: false, available: false };
  const okFor = (call: string) => {
    h.calls.push(call);
    return h.available ? { ok: true, available: true } : unavailable;
  };
  return {
    listKioskTabs: vi.fn(async () => {
      h.calls.push("list");
      return h.available
        ? { available: true, tabs: [{ id: "A", title: "ClawBox", url: "http://localhost:3005/", favicon: "", isDesktop: true }] }
        : { available: false, tabs: [] };
    }),
    openKioskTab: vi.fn(async (url: string) => {
      if (!/^https?:/.test(url)) return { ok: false, available: true, error: "Invalid URL", code: "invalid_url" };
      const r = okFor(`open:${url}`);
      return r.ok ? { ...r, tab: { id: "N", title: "", url, favicon: "", isDesktop: false } } : r;
    }),
    activateKioskTab: vi.fn(async (id: string) => {
      if (id === "GONE") return { ok: false, available: true, error: "No such tab", code: "not_found" };
      return okFor(`activate:${id}`);
    }),
    closeKioskTab: vi.fn(async (id: string) => okFor(`close:${id}`)),
    goHome: vi.fn(async () => okFor("home")),
  };
});

import { GET, POST } from "@/app/setup-api/kiosk/tabs/route";

function post(body: unknown, raw = false): Request {
  return new Request("http://localhost/setup-api/kiosk/tabs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.ownerSession = true;
  h.sameOrigin = true;
  h.available = true;
  h.calls.length = 0;
});

describe("GET /setup-api/kiosk/tabs", () => {
  it("lists the tabs with no-store", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.tabs).toHaveLength(1);
    expect(body.tabs[0]).toMatchObject({ id: "A", isDesktop: true });
  });

  it("is a 200 { available: false } on a box with no kiosk — not an error", async () => {
    h.available = false;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, tabs: [] });
  });
});

describe("POST /setup-api/kiosk/tabs", () => {
  it("refuses the MCP bearer (no owner cookie) with 403 owner_only and calls nothing", async () => {
    h.ownerSession = false;
    const res = await POST(post({ action: "home" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(h.calls).toEqual([]);
  });

  it("refuses a cross-site POST riding the cookie with 403 cross_origin", async () => {
    h.sameOrigin = false;
    const res = await POST(post({ action: "close", id: "A" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(h.calls).toEqual([]);
  });

  it("refuses a body that is not JSON, and an action it does not know", async () => {
    expect((await POST(post("{not json", true))).status).toBe(400);
    const res = await POST(post({ action: "reboot" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_action");
    expect(h.calls).toEqual([]);
  });

  it("open → the lib, answering the new tab", async () => {
    const res = await POST(post({ action: "open", url: "https://claude.ai/x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, available: true, tab: { id: "N" } });
    expect(h.calls).toEqual(["open:https://claude.ai/x"]);
  });

  it("open without a url, or with a non-http one, is a 400", async () => {
    expect((await POST(post({ action: "open" }))).status).toBe(400);
    const res = await POST(post({ action: "open", url: "javascript:alert(1)" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_url");
    expect(h.calls).toEqual([]);
  });

  it("activate / close need an id and pass it through", async () => {
    expect((await POST(post({ action: "activate" }))).status).toBe(400);
    expect((await POST(post({ action: "close", id: 5 }))).status).toBe(400);
    expect((await POST(post({ action: "activate", id: "B" }))).status).toBe(200);
    expect((await POST(post({ action: "close", id: "B" }))).status).toBe(200);
    expect(h.calls).toEqual(["activate:B", "close:B"]);
  });

  it("a tab that has gone is a 404 not_found", async () => {
    const res = await POST(post({ action: "activate", id: "GONE" }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("home → the lib", async () => {
    expect((await POST(post({ action: "home" }))).status).toBe(200);
    expect(h.calls).toEqual(["home"]);
  });

  it("a dead port is a 503 { available: false }, never a 500", async () => {
    h.available = false;
    const res = await POST(post({ action: "open", url: "https://example.com/" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ available: false, ok: false });
  });
});
