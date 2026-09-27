import { describe, expect, it, vi, beforeEach } from "vitest";

// TASK-1256: Settings → Users. Owner cookie only (never another ClawBox user,
// never the MCP bearer), same-origin for the writes, and the owner and the
// caller can never be removed.

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn() }));
vi.mock("@/lib/route-auth", () => ({ sessionIdentity: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSystemUsername: vi.fn().mockReturnValue("clawbox") }));
vi.mock("@/lib/clawbox-users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clawbox-users")>("@/lib/clawbox-users");
  return {
    UserAdminError: actual.UserAdminError,
    listUsers: vi.fn(),
    createUser: vi.fn(),
    removeUser: vi.fn(),
  };
});

import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { sessionIdentity } from "@/lib/route-auth";
import { createUser, listUsers, removeUser, UserAdminError } from "@/lib/clawbox-users";
import { getSystemUsername } from "@/lib/auth";

const ALICE = { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" };

function req(method: string, body?: unknown): Request {
  return new Request("http://localhost/setup-api/users", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/setup-api/users", () => {
  let route: typeof import("@/app/setup-api/users/route");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(hasOwnerSession).mockResolvedValue(true);
    vi.mocked(isSameOriginRequest).mockReturnValue(true);
    vi.mocked(sessionIdentity).mockResolvedValue({ username: "clawbox", isOwner: true });
    vi.mocked(listUsers).mockResolvedValue([ALICE]);
    vi.mocked(getSystemUsername).mockReturnValue("clawbox");
    route = await import("@/app/setup-api/users/route");
  });

  describe("owner-only guard", () => {
    it.each([
      ["GET", undefined],
      ["POST", { username: "bob", password: "correct horse" }],
      ["DELETE", { username: "alice" }],
    ] as const)("%s refuses anyone but the owner (a second user, the MCP bearer) with 403 owner_only", async (method, body) => {
      vi.mocked(hasOwnerSession).mockResolvedValue(false);
      const handler = route[method];
      const res = await handler(req(method, body));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "owner_only" });
      expect(createUser).not.toHaveBeenCalled();
      expect(removeUser).not.toHaveBeenCalled();
      expect(listUsers).not.toHaveBeenCalled();
    });

    it.each(["POST", "DELETE"] as const)("%s refuses a cross-origin write even from the owner", async (method) => {
      vi.mocked(isSameOriginRequest).mockReturnValue(false);
      const res = await route[method](req(method, { username: "alice", password: "correct horse" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "cross_origin" });
      expect(createUser).not.toHaveBeenCalled();
      expect(removeUser).not.toHaveBeenCalled();
    });
  });

  it("GET lists the owner and the other users, never a session version", async () => {
    const res = await route.GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      owner: { username: "clawbox" },
      users: [{ username: "alice", createdAt: ALICE.createdAt }],
      currentUser: "clawbox",
    });
    expect(JSON.stringify(body)).not.toContain(ALICE.sv);
  });

  it("POST creates a user and answers 201 with the new listing", async () => {
    vi.mocked(createUser).mockResolvedValue({ username: "bob", createdAt: "2026-09-27T12:00:00.000Z", sv: "b0b0b0b0b0b0b0b0" });
    const res = await route.POST(req("POST", { username: "bob", password: "correct horse" }));
    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith("bob", "correct horse");
    const body = await res.json();
    expect(body.user).toEqual({ username: "bob", createdAt: "2026-09-27T12:00:00.000Z" });
    expect(JSON.stringify(body)).not.toContain("correct horse");
  });

  it("POST relays a refusal with its stable code and status", async () => {
    vi.mocked(createUser).mockRejectedValue(new UserAdminError("reserved_username", "That name is reserved for the system."));
    const res = await route.POST(req("POST", { username: "root", password: "correct horse" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reserved_username" });
  });

  it("DELETE removes a user, telling the library who is asking", async () => {
    const res = await route.DELETE(req("DELETE", { username: "alice" }));
    expect(res.status).toBe(200);
    expect(removeUser).toHaveBeenCalledWith("alice", { currentUser: "clawbox" });
  });

  it("DELETE relays the refusal to remove the owner", async () => {
    vi.mocked(removeUser).mockRejectedValue(new UserAdminError("cannot_remove_owner", "The box owner cannot be removed."));
    const res = await route.DELETE(req("DELETE", { username: "clawbox" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "cannot_remove_owner" });
  });

  it("DELETE without a username is a 400 before anything is touched", async () => {
    const res = await route.DELETE(req("DELETE", {}));
    expect(res.status).toBe(400);
    expect(removeUser).not.toHaveBeenCalled();
  });
});

describe("/setup-api/users/me", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(listUsers).mockResolvedValue([ALICE]);
  });

  it("names a second user and says they are not the owner", async () => {
    vi.mocked(sessionIdentity).mockResolvedValue({ username: "alice", isOwner: false });
    const { GET } = await import("@/app/setup-api/users/me/route");
    const res = await GET(new Request("http://localhost/setup-api/users/me"));
    expect(await res.json()).toEqual({ username: "alice", isOwner: false, multiUser: true });
  });

  it("answers 401 without a session (the MCP bearer is not a person)", async () => {
    vi.mocked(sessionIdentity).mockResolvedValue(null);
    const { GET } = await import("@/app/setup-api/users/me/route");
    const res = await GET(new Request("http://localhost/setup-api/users/me"));
    expect(res.status).toBe(401);
  });
});

describe("/login-api/users (the login picker)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(getSystemUsername).mockReturnValue("clawbox");
  });

  it("says nothing about names on a single-user box", async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    const { GET } = await import("@/app/login-api/users/route");
    const res = await GET(new Request("http://localhost/login-api/users"));
    expect(await res.json()).toEqual({ multiUser: false });
  });

  it("lists the owner first, then the other users, on the LAN", async () => {
    vi.mocked(listUsers).mockResolvedValue([ALICE]);
    const { GET } = await import("@/app/login-api/users/route");
    const res = await GET(new Request("http://localhost/login-api/users"));
    expect(await res.json()).toEqual({
      multiUser: true,
      users: [{ username: "clawbox", owner: true }, { username: "alice", owner: false }],
    });
  });

  it("names nobody over the remote-access tunnel", async () => {
    vi.mocked(listUsers).mockResolvedValue([ALICE]);
    const { GET } = await import("@/app/login-api/users/route");
    const res = await GET(new Request("http://localhost/login-api/users", { headers: { "cf-connecting-ip": "203.0.113.9" } }));
    expect(await res.json()).toEqual({ multiUser: true, users: null });
  });
});
