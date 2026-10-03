/**
 * Settings → Users and the tray's "signed in as" (TASK-1256, multi-user
 * ClawBox OS). Rendered with a `t` that answers the KEY, so every string is
 * shown to be going through the catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import UsersPanel from "@/components/UsersPanel";
import SystemTray from "@/components/SystemTray";
import { _resetSessionUserForTest } from "@/lib/use-session-user";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}${JSON.stringify(params)}` : key,
  }),
}));

const ALICE = { username: "alice", createdAt: "2026-09-20T09:30:00.000Z" };
const listing = (users: Array<{ username: string; createdAt: string }>) => ({
  owner: { username: "clawbox" },
  users,
  currentUser: "clawbox",
});

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("UsersPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/setup-api/users" && method === "GET") return json(200, listing([ALICE]));
      if (url === "/setup-api/users" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return json(201, { user: { username: body.username, createdAt: "2026-09-27T12:00:00.000Z" }, ...listing([ALICE, { username: body.username, createdAt: "2026-09-27T12:00:00.000Z" }]) });
      }
      if (url === "/setup-api/users" && method === "DELETE") return json(200, { removed: "alice", ...listing([]) });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the owner (not removable) and the other users", async () => {
    render(<UsersPanel />);
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("clawbox")).toBeInTheDocument();
    expect(screen.getByText("users.ownerBadge")).toBeInTheDocument();
    expect(screen.getByText("users.youBadge")).toBeInTheDocument();
    // One Remove button: alice's. Never the owner's.
    expect(screen.getAllByText("users.remove")).toHaveLength(1);
  });

  it("checks the name as it is typed and only enables Create for a valid user", async () => {
    render(<UsersPanel />);
    await screen.findByText("alice");
    const create = screen.getByRole("button", { name: "users.create" });

    fireEvent.change(screen.getByLabelText("users.username"), { target: { value: "Bob" } });
    expect(screen.getByText("users.errInvalidUsername")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("users.username"), { target: { value: "root" } });
    expect(screen.getByText("users.errReserved")).toBeInTheDocument();
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("users.username"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("users.password"), { target: { value: "correct horse" } });
    fireEvent.change(screen.getByLabelText("users.confirmPassword"), { target: { value: "correct hors" } });
    expect(screen.getByText("users.errMismatch")).toBeInTheDocument();
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("users.confirmPassword"), { target: { value: "correct horse" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    expect(await screen.findByText('users.created{"name":"bob"}')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ username: "bob", password: "correct horse" });
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("asks before removing, then removes", async () => {
    render(<UsersPanel />);
    await screen.findByText("alice");
    fireEvent.click(screen.getByText("users.remove"));
    expect(screen.getByText('users.removeConfirm{"name":"alice"}')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByText("users.removeConfirmButton"));
    expect(await screen.findByText('users.removed{"name":"alice"}')).toBeInTheDocument();
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(del?.[1]?.body))).toEqual({ username: "alice" });
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  });

  it("says plainly when the route refuses anyone but the owner", async () => {
    fetchMock.mockImplementation(() => json(403, { code: "owner_only" }));
    render(<UsersPanel />);
    expect(await screen.findByText("users.errOwnerOnly")).toBeInTheDocument();
  });
});

describe("SystemTray — signed-in user", () => {
  beforeEach(() => _resetSessionUserForTest());
  afterEach(() => vi.unstubAllGlobals());

  function stubMe(me: unknown) {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url === "/setup-api/users/me" ? json(200, me) : json(200, { online: true, latencyMs: 5 })));
  }

  it("names a second user, offers Switch user, and hides restart and shut down", async () => {
    stubMe({ username: "alice", isOwner: false, multiUser: true });
    render(<SystemTray isOpen onClose={() => {}} />);
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("tray.switchUser")).toBeInTheDocument();
    expect(screen.getByText("tray.nonOwnerHint")).toBeInTheDocument();
    expect(screen.queryByText("tray.restart")).toBeNull();
    expect(screen.queryByText("tray.shutDown")).toBeNull();
  });

  it("leaves a single-user owner's tray exactly as it was", async () => {
    stubMe({ username: "clawbox", isOwner: true, multiUser: false });
    render(<SystemTray isOpen onClose={() => {}} />);
    expect(await screen.findByText("tray.lock")).toBeInTheDocument();
    expect(screen.getByText("tray.restart")).toBeInTheDocument();
    expect(screen.queryByTestId("tray-session-user")).toBeNull();
    expect(screen.queryByText("tray.switchUser")).toBeNull();
  });
});
