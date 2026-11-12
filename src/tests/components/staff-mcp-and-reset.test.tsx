/**
 * TASK-2377 — Settings → System → Users: the owner's "Reset password" for
 * another user, and the "Tools for members of staff" card (grants, a header,
 * per-member credentials shown masked and never echoed back).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import UsersPanel from "@/components/UsersPanel";
import StaffMcpCard from "@/components/StaffMcpCard";

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}));

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const VIEW = {
  orgMode: true,
  harness: "openclaw",
  staffMcpSupported: true,
  servers: [
    { name: "docs", transport: "http", usable: true, granted: true, header: "Authorization" },
    { name: "local", transport: "stdio", usable: false, reason: "transport", granted: false, header: "Authorization" },
  ],
  users: [{ username: "ivan", credentials: { docs: "••••0001" } }, { username: "maria", credentials: {} }],
};

describe("the owner resets another user's password", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/setup-api/users" && method === "GET") {
        return json(200, { owner: { username: "clawbox" }, users: [{ username: "ivan", createdAt: "2026-11-12T09:00:00Z" }], currentUser: "clawbox", signIn: { available: true } });
      }
      if (url === "/setup-api/users/password") return json(200, { ok: true });
      if (url === "/setup-api/settings/staff-mcp") return json(200, VIEW);
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the new password once both fields agree, and says it was reset", async () => {
    render(<UsersPanel />);
    fireEvent.click(await screen.findByTestId("users-reset-open-ivan"));
    const save = screen.getByTestId("users-reset-save-ivan");
    fireEvent.change(screen.getByTestId("users-reset-password-ivan"), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByTestId("users-reset-confirm-ivan"), { target: { value: "different" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("users-reset-confirm-ivan"), { target: { value: "new-password-1" } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/users\.resetDone/)).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([u]) => u === "/setup-api/users/password")!;
    expect(JSON.parse(String(call[1].body))).toEqual({ username: "ivan", password: "new-password-1" });
  });
});

describe("the staff tools card", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/setup-api/settings/staff-mcp") {
        if ((init?.method ?? "GET") === "POST") return json(200, VIEW);
        return json(200, VIEW);
      }
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the servers, says why one cannot be offered, and shows credentials masked", async () => {
    render(<StaffMcpCard users={["ivan", "maria"]} orgMode />);
    expect(await screen.findByTestId("staff-mcp-grant-docs")).toBeChecked();
    expect(screen.getByTestId("staff-mcp-grant-local")).toBeDisabled();
    expect(screen.getByText(/users\.staffMcp\.notUsable/)).toBeInTheDocument();
    expect(screen.getByTestId("staff-mcp-cred-ivan-docs")).toHaveTextContent("••••0001");
    expect(screen.getByTestId("staff-mcp-cred-maria-docs")).toHaveTextContent("users.staffMcp.notSet");
  });

  it("sends a member's credential once and clears the field", async () => {
    render(<StaffMcpCard users={["ivan", "maria"]} orgMode />);
    const input = await screen.findByTestId("staff-mcp-cred-input-maria-docs");
    fireEvent.change(input, { target: { value: "maria-token" } });
    fireEvent.click(screen.getByTestId("staff-mcp-cred-save-maria-docs"));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(String(post[1].body))).toEqual({ username: "maria", server: "docs", credential: "maria-token" });
  });

  it("saves the granted list with its header", async () => {
    render(<StaffMcpCard users={["ivan"]} orgMode />);
    fireEvent.change(await screen.findByTestId("staff-mcp-header-docs"), { target: { value: "X-Api-Key" } });
    fireEvent.click(screen.getByTestId("staff-mcp-save-grants"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(String(post[1].body))).toEqual({ servers: { docs: { header: "X-Api-Key" } } });
  });

  it("keeps an unsaved grant edit when a credential is saved", async () => {
    render(<StaffMcpCard users={["ivan", "maria"]} orgMode />);
    const header = await screen.findByTestId("staff-mcp-header-docs");
    fireEvent.change(header, { target: { value: "X-Api-Key" } });
    fireEvent.change(screen.getByTestId("staff-mcp-cred-input-maria-docs"), { target: { value: "maria-token" } });
    fireEvent.click(screen.getByTestId("staff-mcp-cred-save-maria-docs"));
    await waitFor(() => expect((screen.getByTestId("staff-mcp-cred-input-maria-docs") as HTMLInputElement).value).toBe(""));
    expect((screen.getByTestId("staff-mcp-header-docs") as HTMLInputElement).value).toBe("X-Api-Key");
    expect(screen.getByLabelText(/users\.staffMcp\.credentialFor.*maria/)).toBeInTheDocument();
  });

  it("says when the list could not be read, and reads it again on Retry", async () => {
    let fail = true;
    fetchMock.mockImplementation(() => (fail ? json(500, {}) : json(200, VIEW)));
    render(<StaffMcpCard users={["ivan"]} orgMode />);
    fireEvent.click(await screen.findByTestId("staff-mcp-retry"));
    fail = false;
    fireEvent.click(screen.getByTestId("staff-mcp-retry"));
    expect(await screen.findByTestId("staff-mcp-grant-docs")).toBeChecked();
  });

  it("says when a saved change is not active yet", async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => json(200, (init?.method ?? "GET") === "POST" ? { ...VIEW, applied: false } : VIEW));
    render(<StaffMcpCard users={["ivan"]} orgMode />);
    fireEvent.change(await screen.findByTestId("staff-mcp-header-docs"), { target: { value: "X-Api-Key" } });
    fireEvent.click(screen.getByTestId("staff-mcp-save-grants"));
    expect(await screen.findByText("users.staffMcp.notApplied")).toBeInTheDocument();
  });

  it("says members of staff get no MCP tools on Hermes", async () => {
    fetchMock.mockImplementation(() => json(200, { ...VIEW, harness: "hermes", staffMcpSupported: false, servers: [] }));
    render(<StaffMcpCard users={["ivan"]} orgMode />);
    expect(await screen.findByTestId("staff-mcp-hermes")).toBeInTheDocument();
  });
});
