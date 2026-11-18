import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 — the owner resets another user's password
 * (`POST /setup-api/users/password`): owner's cookie and our own page only,
 * the user's sessions end BEFORE the password changes, and the helper's
 * `setpasswd` verb does the change. Nobody else, never the agent's bearer.
 */

const h = vi.hoisted(() => ({
  who: vi.fn(),
  sameOrigin: vi.fn(() => true),
  findUser: vi.fn(),
  rotate: vi.fn(),
  reset: vi.fn(),
  order: [] as string[],
  begin: vi.fn(() => true),
  end: vi.fn(),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/clawbox-users", () => ({
  findUser: h.findUser,
  rotateUserSessionVersion: h.rotate,
  resetUserPassword: h.reset,
}));
vi.mock("@/lib/password-change-lock", () => ({ beginPasswordChange: h.begin, endPasswordChange: h.end }));
vi.mock("@/lib/auth", () => ({
  getSystemUsername: () => "owner",
  isSafePasswordChars: (s: string) => !/[\u0000-\u001f\u007f]/.test(s),
}));

let POST: (req: Request) => Promise<Response>;

const req = (body: unknown) => new Request("http://box.local/setup-api/users/password", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://box.local" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.who.mockResolvedValue({ username: "owner", isOwner: true });
  h.sameOrigin.mockReturnValue(true);
  h.begin.mockReturnValue(true);
  h.findUser.mockImplementation(async (name: string) => (name === "ivan" ? { username: "ivan", createdAt: "x", sv: "1" } : null));
  h.rotate.mockImplementation(async () => { h.order.push("rotate"); return "2"; });
  h.reset.mockImplementation(async () => { h.order.push("reset"); return "ok"; });
  ({ POST } = await import("@/app/setup-api/users/password/route"));
});

describe("POST /setup-api/users/password", () => {
  it("ends the user's sessions first, then resets the password", async () => {
    const res = await POST(req({ username: "ivan", password: "a-new-password" }));
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["rotate", "reset"]);
    expect(h.reset).toHaveBeenCalledWith("ivan", "a-new-password");
    expect(h.begin).toHaveBeenCalledWith("ivan");
    expect(h.end).toHaveBeenCalledWith("ivan");
  });

  it("refuses everyone but the owner — another user, the agent's bearer — 403 owner_only", async () => {
    for (const person of [{ username: "maria", isOwner: false }, null]) {
      h.who.mockResolvedValue(person);
      const res = await POST(req({ username: "ivan", password: "a-new-password" }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("refuses another site's page riding the owner's cookie", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await POST(req({ username: "ivan", password: "a-new-password" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });

  it("refuses the owner's own account, an unknown user and a bad password", async () => {
    expect((await POST(req({ username: "owner", password: "a-new-password" }))).status).toBe(409);
    expect((await POST(req({ username: "olga", password: "a-new-password" }))).status).toBe(404);
    expect((await POST(req({ username: "Bad Name", password: "a-new-password" }))).status).toBe(400);
    expect((await POST(req({ username: "ivan", password: "short" }))).status).toBe(400);
    expect((await POST(req({ username: "ivan", password: "has\nnewline" }))).status).toBe(400);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("changes nothing when the sessions could not be ended", async () => {
    h.rotate.mockRejectedValue(new Error("store"));
    const res = await POST(req({ username: "ivan", password: "a-new-password" }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("sessions_not_ended");
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("answers 404 when the user was removed meanwhile, and changes nothing", async () => {
    h.rotate.mockResolvedValue(null);
    const res = await POST(req({ username: "ivan", password: "a-new-password" }));
    expect(res.status).toBe(404);
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("says when the box's helper predates the verb", async () => {
    h.reset.mockResolvedValue("unavailable");
    const res = await POST(req({ username: "ivan", password: "a-new-password" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("password_change_unavailable");
  });

  it("refuses while that user's password is already being changed", async () => {
    h.begin.mockReturnValue(false);
    expect((await POST(req({ username: "ivan", password: "a-new-password" }))).status).toBe(409);
  });
});
