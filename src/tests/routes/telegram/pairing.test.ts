import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  readTelegramAllowFrom: vi.fn(),
  listTelegramPairingRequests: vi.fn(),
  readTelegramPairingRequests: vi.fn(),
  approveTelegramPairing: vi.fn(),
  // The route imports this constant for its own format check — the mock must
  // provide it or `PAIRING_CODE_RE.test(...)` throws and every POST 500s.
  PAIRING_CODE_RE: /^[A-Z0-9]{8}$/,
}));

import { get, set } from "@/lib/config-store";
import {
  readTelegramAllowFrom,
  listTelegramPairingRequests,
  readTelegramPairingRequests,
  approveTelegramPairing,
} from "@/lib/openclaw-config";

const mockGet = vi.mocked(get);
const mockReadAllow = vi.mocked(readTelegramAllowFrom);
const mockListPending = vi.mocked(listTelegramPairingRequests);
const mockReadPending = vi.mocked(readTelegramPairingRequests);
const mockApprove = vi.mocked(approveTelegramPairing);
const mockSet = vi.mocked(set);

describe("/setup-api/telegram/pairing", () => {
  let GET: (req: Request) => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;

  function getReq(url = "http://localhost/setup-api/telegram/pairing"): Request {
    return new Request(url);
  }
  function postReq(body: unknown): Request {
    return new Request("http://localhost/setup-api/telegram/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGet.mockResolvedValue("123:abc");
    mockReadAllow.mockResolvedValue(["6057319791"]);
    mockListPending.mockResolvedValue([]);
    mockReadPending.mockResolvedValue([]);
    mockApprove.mockResolvedValue();

    const mod = await import("@/app/setup-api/telegram/pairing/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- GET ---

  it("GET reports not configured when there is no bot token", async () => {
    mockGet.mockResolvedValue(null);
    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.approved).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(mockReadAllow).not.toHaveBeenCalled();
  });

  it("GET returns the approved list and skips the slow pending CLI by default", async () => {
    const res = await GET(getReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.approved).toEqual([{ id: "6057319791" }]);
    expect(body.pending).toEqual([]);
    expect(mockListPending).not.toHaveBeenCalled();
  });

  it("GET includes pending requests via the CLI when ?pending=1", async () => {
    mockListPending.mockResolvedValue([{ code: "FQL2A98K", id: "999" }]);
    const res = await GET(getReq("http://localhost/setup-api/telegram/pairing?pending=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockListPending).toHaveBeenCalledTimes(1);
    expect(mockReadPending).not.toHaveBeenCalled();
    expect(body.pending).toEqual([{ code: "FQL2A98K", id: "999" }]);
  });

  it("GET reads the pairing store file (not the CLI) when ?poll=1", async () => {
    mockReadPending.mockResolvedValue([{ code: "ABCD2345", id: "42" }]);
    const res = await GET(getReq("http://localhost/setup-api/telegram/pairing?poll=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockReadPending).toHaveBeenCalledTimes(1);
    expect(mockListPending).not.toHaveBeenCalled();
    expect(body.pending).toEqual([{ code: "ABCD2345", id: "42" }]);
  });

  it("GET returns 500 when reading the approved list fails", async () => {
    mockReadAllow.mockRejectedValue(new Error("boom"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
  });

  // --- POST ---

  it("POST rejects invalid JSON", async () => {
    const res = await POST(postReq("not json"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("POST rejects a malformed code without calling the CLI", async () => {
    const res = await POST(postReq({ code: "abc" }));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("POST uppercases the code, approves with --notify, and returns the refreshed list", async () => {
    mockReadAllow.mockResolvedValue(["6057319791", "999"]);
    const res = await POST(postReq({ code: "fql2a98k" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockApprove).toHaveBeenCalledWith("FQL2A98K");
    expect(body.approved).toEqual([{ id: "6057319791" }, { id: "999" }]);
  });

  it("POST captures the requester's name from the pending store and stores it", async () => {
    mockGet.mockImplementation(async (key: string) =>
      key === "telegram_bot_token"
        ? "123:abc"
        : key === "telegram_approved_names"
          ? { "999": "Ivan" }
          : null,
    );
    mockReadAllow.mockResolvedValue(["999"]);
    mockReadPending.mockResolvedValue([{ code: "FQL2A98K", id: "999", meta: { firstName: "Ivan" } }]);

    const res = await POST(postReq({ code: "fql2a98k" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith("telegram_approved_names", { "999": "Ivan" });
    expect(body.approved).toEqual([{ id: "999", name: "Ivan" }]);
  });

  it("POST maps an expired/unknown code to a 400", async () => {
    mockApprove.mockRejectedValue(new Error("no pending request for code"));
    const res = await POST(postReq({ code: "FQL2A98K" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/expired/i);
  });

  it("POST maps a CLI timeout to a 500", async () => {
    mockApprove.mockRejectedValue(new Error("openclaw pairing approve timed out after 30000ms"));
    const res = await POST(postReq({ code: "FQL2A98K" }));
    expect(res.status).toBe(500);
  });
});
