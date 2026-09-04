/**
 * /setup-api/browser/setup — the owner's three decisions about the browser app.
 *
 * The properties that matter: the AGENT cannot finish the owner's setup or turn
 * the auto-open switch back on (middleware admits the MCP bearer on every
 * /setup-api path, so the route re-checks for a session cookie), the same
 * origin rule ClawKeep's setup route uses applies here too, and a start page
 * that is not an http(s) address is refused rather than handed to a Chromium
 * running on a screen the agent can screenshot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => true) }));

const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
}));

const writeFile = vi.fn(async (...args: unknown[]) => { void args; });
vi.mock("fs/promises", () => ({
  default: { mkdir: vi.fn(async () => undefined), writeFile },
}));

import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

const post = async (body: unknown) => {
  const { POST } = await import("@/app/setup-api/browser/setup/route");
  return POST(new Request("http://localhost/setup-api/browser/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
};

describe("/setup-api/browser/setup", () => {
  beforeEach(() => {
    store.clear();
    writeFile.mockClear();
    vi.mocked(hasOwnerSession).mockResolvedValue(true);
    vi.mocked(isSameOriginRequest).mockReturnValue(true);
  });

  it("refuses the agent's credential", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(false);
    const res = await post({ autoOpen: false });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
  });

  it("refuses a request made from another site's page", async () => {
    vi.mocked(isSameOriginRequest).mockReturnValue(false);
    const res = await post({ setupComplete: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });

  it("round-trips the three settings", async () => {
    const res = await post({ setupComplete: true, autoOpen: false, startUrl: "https://example.com/start" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ setupComplete: true, autoOpen: false, startUrl: "https://example.com/start" });
    expect(store.get("browser_setup_complete")).toBe(true);
    expect(store.get("browser_auto_open")).toBe(false);
  });

  it("hands the saved start page to the launch script", async () => {
    await post({ startUrl: "https://example.com/start" });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(String(writeFile.mock.calls[0][0])).toMatch(/\.cache\/clawbox\/browser\.env$/);
    expect(String(writeFile.mock.calls[0][1])).toContain("CLAWBOX_BROWSER_START_URL='https://example.com/start'");
  });

  it("refuses a start page that is not an http(s) address", async () => {
    const res = await post({ startUrl: "file:///etc/shadow" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_start_url");
    expect(store.has("browser_start_url")).toBe(false);
  });

  it("puts the default back when the start page is cleared", async () => {
    store.set("browser_start_url", "https://example.com/start");
    const res = await post({ startUrl: "" });
    expect((await res.json()).startUrl).toBe("https://www.google.com");
    expect(store.has("browser_start_url")).toBe(false);
  });

  it("refuses a setupComplete that is not a boolean", async () => {
    const res = await post({ setupComplete: "yes" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_body");
  });

  it("refuses a body that is not an object with the 400 it promises", async () => {
    // `null`, `[]` and `7` all PARSE, so the catch never ran and reading a
    // field off one of them threw outside this route's own handling — the
    // caller got a framework 500 where a stable `bad_body` was promised.
    const { POST } = await import("@/app/setup-api/browser/setup/route");
    for (const raw of ["null", "[]", "7", '"a string"']) {
      const res = await POST(new Request("http://localhost/setup-api/browser/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_body");
    }
    expect(writeFile).not.toHaveBeenCalled();
  });
});
