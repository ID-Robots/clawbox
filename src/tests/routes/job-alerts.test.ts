import { beforeEach, describe, expect, it, vi } from "vitest";

// GET|POST /setup-api/job-alerts — the scheduled-job alerts' switch and what
// the last check found. Owner only: the answer quotes the scheduler's error
// text, and the assistant must not be able to switch off the alarm about its
// own jobs.

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));
vi.mock("@/lib/job-alerts", () => ({
  checkScheduledJobs: vi.fn(),
  readJobAlertsStatus: vi.fn(),
  setJobAlertsEnabled: vi.fn(),
}));

import { GET, POST } from "@/app/setup-api/job-alerts/route";
import { hasOwnerSession } from "@/lib/owner-session";
import { checkScheduledJobs, readJobAlertsStatus, setJobAlertsEnabled } from "@/lib/job-alerts";

const NOW = Date.now();
const STATUS = {
  enabled: true,
  off: null,
  runtime: "openclaw",
  reachable: true,
  checkedAt: NOW,
  watched: 3,
  problems: [{ id: "j1", name: "Backup", problem: "failing", count: 2, since: NOW - 60_000, error: "exit code 1" }],
};

function req(method: string, body?: unknown) {
  return new Request("http://x/setup-api/job-alerts", {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasOwnerSession).mockResolvedValue(true);
  vi.mocked(readJobAlertsStatus).mockResolvedValue(STATUS as never);
  vi.mocked(checkScheduledJobs).mockResolvedValue({ ...STATUS, checkedAt: NOW + 1 } as never);
});

describe("GET /setup-api/job-alerts", () => {
  it("refuses anyone but the owner with 403 owner_only", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(false);
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "owner_only" });
    expect(readJobAlertsStatus).not.toHaveBeenCalled();
  });

  it("answers the last check while it is fresh", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
    expect(checkScheduledJobs).not.toHaveBeenCalled();
  });

  it("checks again when the last check is stale", async () => {
    vi.mocked(readJobAlertsStatus).mockResolvedValue({ ...STATUS, checkedAt: NOW - 5 * 60_000 } as never);
    const body = await (await GET(req("GET"))).json();
    expect(checkScheduledJobs).toHaveBeenCalledTimes(1);
    expect(body.checkedAt).toBe(NOW + 1);
  });

  it("does not check while switched off", async () => {
    vi.mocked(readJobAlertsStatus).mockResolvedValue({ ...STATUS, enabled: false, off: "pref", checkedAt: 0 } as never);
    await GET(req("GET"));
    expect(checkScheduledJobs).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/job-alerts", () => {
  it("refuses anyone but the owner", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(false);
    expect((await POST(req("POST", { enabled: false }))).status).toBe(403);
    expect(setJobAlertsEnabled).not.toHaveBeenCalled();
  });

  it.each([["not json"], [null], [[true]], [{ enabled: "off" }], [{}]])("400 for %j", async (body) => {
    const res = await POST(req("POST", body));
    expect(res.status).toBe(400);
    expect(setJobAlertsEnabled).not.toHaveBeenCalled();
  });

  it("switching off stores it and answers without checking", async () => {
    vi.mocked(readJobAlertsStatus).mockResolvedValue({ ...STATUS, enabled: false, off: "pref" } as never);
    const res = await POST(req("POST", { enabled: false }));
    expect(setJobAlertsEnabled).toHaveBeenCalledWith(false);
    expect(await res.json()).toMatchObject({ ok: true, enabled: false, off: "pref" });
    expect(checkScheduledJobs).not.toHaveBeenCalled();
  });

  it("switching on stores it and checks at once", async () => {
    const res = await POST(req("POST", { enabled: true }));
    expect(setJobAlertsEnabled).toHaveBeenCalledWith(true);
    expect(checkScheduledJobs).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, enabled: true, checkedAt: NOW + 1 });
  });

  it("a store that will not take the write is 502, not a false success", async () => {
    vi.mocked(setJobAlertsEnabled).mockRejectedValueOnce(new Error("EROFS"));
    const res = await POST(req("POST", { enabled: true }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "write_failed" });
  });
});
