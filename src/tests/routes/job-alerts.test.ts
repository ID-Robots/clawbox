import { beforeEach, describe, expect, it, vi } from "vitest";

// GET|POST /setup-api/job-alerts — the scheduled-job alerts' switch, who is
// told on Telegram, and what the last check found. Owner only: the answer
// quotes the scheduler's error text and lists the bot's approved users, and
// the assistant must not be able to switch off the alarm about its own jobs
// or change who hears it.

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));
// The pick's validator is the real one: what the route lets through is what
// the store keeps.
vi.mock("@/lib/job-alerts", async (importOriginal) => ({
  isRecipientPick: (await importOriginal<typeof import("@/lib/job-alerts")>()).isRecipientPick,
  checkScheduledJobs: vi.fn(),
  readJobAlertsStatus: vi.fn(),
  readJobAlertRecipients: vi.fn(),
  saveJobAlertSettings: vi.fn(),
}));

import { GET, POST } from "@/app/setup-api/job-alerts/route";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  checkScheduledJobs,
  readJobAlertRecipients,
  readJobAlertsStatus,
  saveJobAlertSettings,
} from "@/lib/job-alerts";

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

// Made-up ids.
const RECIPIENTS = {
  runtime: "openclaw",
  picked: null,
  known: true,
  approved: [{ id: "100000001", name: "Иван Иванов" }, { id: "100000002" }],
  effective: ["100000001", "100000002"],
  defaultCount: 5,
  maxPicked: 20,
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
  vi.mocked(readJobAlertRecipients).mockResolvedValue(RECIPIENTS as never);
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
    expect(await res.json()).toEqual({ ...STATUS, recipients: RECIPIENTS });
    expect(checkScheduledJobs).not.toHaveBeenCalled();
  });

  it("still answers the card when the recipients cannot be listed", async () => {
    vi.mocked(readJobAlertRecipients).mockRejectedValueOnce(new Error("store unreadable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...STATUS, recipients: null });
    warn.mockRestore();
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
    expect((await POST(req("POST", { recipients: ["100000001"] }))).status).toBe(403);
    expect(saveJobAlertSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["not json"],
    [null],
    [[true]],
    [{ enabled: "off" }],
    [{}],
    [{ recipients: "100000001" }],
    [{ recipients: ["100000001", "not-an-id"] }],
    [{ recipients: [100000001] }],
    [{ recipients: Array.from({ length: 21 }, (_, i) => String(100000000 + i)) }],
    // A bad half fails the whole body: nothing is half-saved.
    [{ enabled: true, recipients: "all" }],
  ])("400 for %j", async (body) => {
    const res = await POST(req("POST", body));
    expect(res.status).toBe(400);
    expect(saveJobAlertSettings).not.toHaveBeenCalled();
  });

  it("stores the owner's pick and answers the card without checking", async () => {
    const picked = { ...RECIPIENTS, picked: ["100000002"], effective: ["100000002"] };
    vi.mocked(readJobAlertRecipients).mockResolvedValue(picked as never);
    const res = await POST(req("POST", { recipients: ["100000002"] }));
    expect(res.status).toBe(200);
    expect(saveJobAlertSettings).toHaveBeenCalledWith({ recipients: ["100000002"] });
    expect(checkScheduledJobs).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, enabled: true, recipients: picked });
  });

  it("an empty pick is stored as nobody, and null goes back to the default", async () => {
    await POST(req("POST", { recipients: [] }));
    expect(saveJobAlertSettings).toHaveBeenLastCalledWith({ recipients: [] });
    await POST(req("POST", { recipients: null }));
    expect(saveJobAlertSettings).toHaveBeenLastCalledWith({ recipients: null });
  });

  it("the switch and the pick together are one write", async () => {
    const res = await POST(req("POST", { enabled: true, recipients: ["100000001"] }));
    expect(res.status).toBe(200);
    expect(saveJobAlertSettings).toHaveBeenCalledTimes(1);
    expect(saveJobAlertSettings).toHaveBeenCalledWith({ enabled: true, recipients: ["100000001"] });
  });

  it("a pick that will not store is 502", async () => {
    vi.mocked(saveJobAlertSettings).mockRejectedValueOnce(new Error("EACCES"));
    const res = await POST(req("POST", { recipients: ["100000001"] }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "write_failed" });
  });

  it("switching off stores it and answers without checking", async () => {
    vi.mocked(readJobAlertsStatus).mockResolvedValue({ ...STATUS, enabled: false, off: "pref" } as never);
    const res = await POST(req("POST", { enabled: false }));
    expect(saveJobAlertSettings).toHaveBeenCalledWith({ enabled: false });
    expect(await res.json()).toMatchObject({ ok: true, enabled: false, off: "pref" });
    expect(checkScheduledJobs).not.toHaveBeenCalled();
  });

  it("switching on stores it and checks at once", async () => {
    const res = await POST(req("POST", { enabled: true }));
    expect(saveJobAlertSettings).toHaveBeenCalledWith({ enabled: true });
    expect(checkScheduledJobs).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, enabled: true, checkedAt: NOW + 1 });
  });

  it("a store that will not take the write is 502, not a false success", async () => {
    vi.mocked(saveJobAlertSettings).mockRejectedValueOnce(new Error("EROFS"));
    const res = await POST(req("POST", { enabled: true }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "write_failed" });
  });
});
