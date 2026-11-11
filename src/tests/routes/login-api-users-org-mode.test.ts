import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /login-api/users on an organisation box (TASK-2435): its users are a
 * company's staff, so the login screen lists nobody, on the LAN too — everyone
 * types their username (the owner may leave it empty). A home box keeps its
 * picker on the LAN and asks for a name over the tunnel, as before.
 */

const h = vi.hoisted(() => ({
  users: vi.fn(async () => [{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" }]),
  orgMode: vi.fn(async (): Promise<boolean | null> => false),
  tunnel: vi.fn(() => false),
}));

vi.mock("@/lib/clawbox-users", () => ({ listUsers: h.users }));
vi.mock("@/lib/org-mode-server", () => ({ readOrgModeStrict: h.orgMode }));
vi.mock("@/lib/host-allowlist", () => ({ isTunnelRequest: h.tunnel }));
vi.mock("@/lib/auth", () => ({ getSystemUsername: () => "clawbox" }));

let GET: (req: Request) => Promise<Response>;
const ask = async () => (await GET(new Request("http://box.local/login-api/users"))).json();

beforeEach(async () => {
  ({ GET } = await import("@/app/login-api/users/route"));
  h.orgMode.mockResolvedValue(false);
  h.tunnel.mockReturnValue(false);
});

describe("the login screen's user list", () => {
  it("lists the users on a home box's LAN, owner first", async () => {
    expect(await ask()).toEqual({
      multiUser: true,
      users: [{ username: "clawbox", owner: true }, { username: "alice", owner: false }],
    });
  });

  it("lists nobody on an organisation box, so the page asks for a username", async () => {
    h.orgMode.mockResolvedValue(true);
    expect(await ask()).toEqual({ multiUser: true, users: null });
  });

  it("lists nobody when the switch cannot be read: it may be an organisation's box", async () => {
    h.orgMode.mockResolvedValue(null);
    expect(await ask()).toEqual({ multiUser: true, users: null });
  });

  it("lists nobody over the tunnel, as before", async () => {
    h.tunnel.mockReturnValue(true);
    expect(await ask()).toEqual({ multiUser: true, users: null });
  });

  it("is a single-user box's plain password screen when there are no users, organisation box or not", async () => {
    h.users.mockResolvedValueOnce([]);
    h.orgMode.mockResolvedValue(true);
    expect(await ask()).toEqual({ multiUser: false });
  });
});
