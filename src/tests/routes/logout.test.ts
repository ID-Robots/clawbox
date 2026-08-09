import { describe, expect, it, vi, beforeEach } from "vitest";

describe("/login-api/logout", () => {
  let POST: (request?: Request) => Promise<Response>;

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

  it("does not mark the clear cookie Secure on plain HTTP", async () => {
    const res = await POST(new Request("http://localhost/login-api/logout", { method: "POST" }));
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("marks the clear cookie Secure when the request arrived over HTTPS", async () => {
    const res = await POST(new Request("https://box.example/login-api/logout", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    }));
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});
