import { describe, expect, it, vi, beforeEach } from "vitest";

describe("/login-api/logout", () => {
  let POST: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/app/login-api/logout/route");
    POST = mod.POST;
  });

  it("clears the session cookie", async () => {
    const res = await POST();
    const body = await res.json();
    expect(body.success).toBe(true);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("clawbox_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});
