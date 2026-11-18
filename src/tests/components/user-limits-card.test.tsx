import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import UserLimitsCard from "@/components/UserLimitsCard";
import AuditLogCard from "@/components/AuditLogCard";

/**
 * TASK-2446 — Settings → System → Users, the owner's two new cards: the
 * limits for every other user (with each user's home usage) and the audit
 * log. Both stay hidden for anyone the routes refuse; the limits card sends
 * only whole numbers in range and says when they are saved; the log shows
 * who did what, to whom, from where.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}));

const MB = 1024 * 1024;
const LIMITS = { uploadMaxMb: 100, homeQuotaMb: 10240, chatPerMinute: 20, chatPerHour: 300 };
const MAX = { uploadMaxMb: 1048576, homeQuotaMb: 67108864, chatPerMinute: 10000, chatPerHour: 1000000 };
const status = (limits = LIMITS) => ({
  limits,
  defaults: LIMITS,
  max: MAX,
  orgMode: true,
  users: [
    { username: "ivan", usedBytes: 512 * MB, truncated: false, quotaBytes: limits.homeQuotaMb * MB },
    { username: "maria", usedBytes: null, truncated: false, quotaBytes: limits.homeQuotaMb * MB },
    { username: "petar", usedBytes: 3 * 1024 * MB, truncated: true, quotaBytes: null },
  ],
});

function json(statusCode: number, body: unknown) {
  return Promise.resolve({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, json: () => Promise.resolve(body) });
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => vi.unstubAllGlobals());

describe("UserLimitsCard", () => {
  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/setup-api/settings/user-limits" && (init?.method ?? "GET") === "GET") return json(200, status());
      if (url === "/setup-api/settings/user-limits" && init?.method === "POST") {
        return json(200, status({ ...LIMITS, ...JSON.parse(String(init.body)) }));
      }
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stays hidden for anyone the route refuses", async () => {
    fetchMock.mockImplementation(() => json(403, { code: "owner_only" }));
    const { container } = render(<UserLimitsCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=user-limits]")).toBeNull();
  });

  it("shows the limits in force and how full each home is", async () => {
    render(<UserLimitsCard />);
    expect(await screen.findByTestId("user-limits")).toBeInTheDocument();
    expect(screen.getByTestId("user-limits-uploadMaxMb")).toHaveValue("100");
    expect(screen.getByTestId("user-limits-homeQuotaMb")).toHaveValue("10240");
    expect(screen.getByText("100 MB")).toBeInTheDocument();
    expect(screen.getByText("10 GB")).toBeInTheDocument();
    expect(screen.getByTestId("user-limits-usage-ivan")).toHaveTextContent('users.limits.usage{"used":"512 MB","quota":"10 GB"}');
    expect(screen.getByTestId("user-limits-usage-maria")).toHaveTextContent("users.limits.usageUnknown");
    expect(screen.getByTestId("user-limits-usage-petar")).toHaveTextContent('users.limits.usageNoQuota{"used":"users.limits.atLeast{\\"size\\":\\"3 GB\\"}"}');
    // Nothing changed yet: nothing to save.
    expect(screen.getByTestId("user-limits-save")).toBeDisabled();
  });

  it("refuses to send anything but a whole number in range", async () => {
    render(<UserLimitsCard />);
    const field = await screen.findByTestId("user-limits-chatPerMinute");
    fireEvent.change(field, { target: { value: "2.5" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText('users.limits.invalid{"max":10000}')).toBeInTheDocument();
    expect(screen.getByTestId("user-limits-save")).toBeDisabled();
    fireEvent.change(field, { target: { value: "10001" } });
    expect(screen.getByTestId("user-limits-save")).toBeDisabled();
  });

  it("saves the owner's change and says so", async () => {
    render(<UserLimitsCard />);
    const upload = await screen.findByTestId("user-limits-uploadMaxMb");
    fireEvent.change(upload, { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("user-limits-chatPerHour"), { target: { value: "0" } });
    expect(screen.getByText("users.limits.unlimited")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("user-limits-save"));
    expect(await screen.findByTestId("user-limits-saved")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    // Only what the owner changed: a field left alone keeps what another window may have saved.
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ uploadMaxMb: 25, chatPerHour: 0 });
    expect(screen.getByTestId("user-limits-uploadMaxMb")).toHaveValue("25");
  });

  it("holds the fields while a save is on its way", async () => {
    let answer: (v: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Promise((r) => { answer = r; }) : json(200, status()));
    render(<UserLimitsCard />);
    fireEvent.change(await screen.findByTestId("user-limits-uploadMaxMb"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("user-limits-save"));
    await waitFor(() => expect(screen.getByTestId("user-limits-uploadMaxMb")).toBeDisabled());
    answer(await json(200, status({ ...LIMITS, uploadMaxMb: 50 })));
    await waitFor(() => expect(screen.getByTestId("user-limits-uploadMaxMb")).toBeEnabled());
    expect(screen.getByTestId("user-limits-uploadMaxMb")).toHaveValue("50");
  });

  it("says when the limits could not be read, and reads them again on request", async () => {
    let calls = 0;
    fetchMock.mockImplementation(() => (++calls === 1 ? json(500, { error: "boom" }) : json(200, status())));
    render(<UserLimitsCard />);
    expect(await screen.findByTestId("user-limits-load-failed")).toHaveTextContent("users.limits.loadFailed");
    fireEvent.click(screen.getByTestId("user-limits-retry"));
    expect(await screen.findByTestId("user-limits-uploadMaxMb")).toHaveValue("100");
  });

  it("hides the failure line again when a retry is refused as not the owner's", async () => {
    let calls = 0;
    fetchMock.mockImplementation(() => (++calls === 1 ? json(500, {}) : json(403, { code: "owner_only" })));
    const { container } = render(<UserLimitsCard />);
    expect(await screen.findByTestId("user-limits-load-failed")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("user-limits-retry"));
    await waitFor(() => expect(container.querySelector("[data-testid=user-limits]")).toBeNull());
  });

  it("says why a save failed", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json(500, { error: "The settings file could not be written." }) : json(200, status()));
    render(<UserLimitsCard />);
    fireEvent.change(await screen.findByTestId("user-limits-uploadMaxMb"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("user-limits-save"));
    expect(await screen.findByTestId("user-limits-failed")).toHaveTextContent("users.limits.failed The settings file could not be written.");
  });
});

describe("AuditLogCard", () => {
  const entries = [
    { ts: "2026-11-17T10:05:00.000Z", event: "org_mode", actor: "clawbox", ip: "192.0.2.4", detail: { on: true } },
    { ts: "2026-11-17T10:04:00.000Z", event: "user_create", actor: "clawbox", target: "ivan" },
    { ts: "2026-11-17T10:03:00.000Z", event: "login_failed", actor: null, ip: "198.51.100.7", detail: { locked: true, remote: true } },
  ];

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/setup-api/settings/audit-log")) return json(200, { entries, more: true });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stays hidden for anyone the route refuses", async () => {
    fetchMock.mockImplementation(() => json(403, { code: "owner_only" }));
    const { container } = render(<AuditLogCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=audit-log]")).toBeNull();
  });

  it("lists who did what, to whom and from where, newest first", async () => {
    render(<AuditLogCard />);
    const rows = await screen.findAllByTestId("audit-log-entry");
    expect(rows.map((r) => r.getAttribute("data-event"))).toEqual(["org_mode", "user_create", "login_failed"]);
    expect(rows[0]).toHaveTextContent("users.audit.event.orgMode");
    expect(rows[0]).toHaveTextContent("users.audit.on");
    expect(rows[0]).toHaveTextContent('users.audit.from{"address":"192.0.2.4"}');
    expect(rows[1]).toHaveTextContent("users.audit.event.userCreate · ivan");
    expect(rows[2]).toHaveTextContent("users.audit.nobody");
    expect(rows[2]).toHaveTextContent("users.audit.remote · users.audit.locked");
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/settings/audit-log?limit=100", expect.anything());
  });

  it("loads older entries on request, and again on refresh", async () => {
    render(<AuditLogCard />);
    fireEvent.click(await screen.findByTestId("audit-log-more"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/settings/audit-log?limit=300", expect.anything()));
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("audit-log-refresh"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(calls + 1));
  });

  it("says when nothing has been recorded", async () => {
    fetchMock.mockImplementation(() => json(200, { entries: [], more: false }));
    render(<AuditLogCard />);
    expect(await screen.findByTestId("audit-log-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-log-more")).toBeNull();
  });
});
