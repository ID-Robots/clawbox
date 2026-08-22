import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));

const start = vi.fn();
const poll = vi.fn();
const stop = vi.fn();
const unpair = vi.fn();

vi.mock("@/lib/whatsapp-pairing", () => ({
  getPairingManager: () => ({ start, poll, stop }),
  unpairWhatsapp: unpair,
}));

vi.mock("@/lib/hermes-whatsapp", () => ({
  whatsappSessionDirs: () => ["/hermes/platforms/whatsapp/session", "/hermes/whatsapp/session"],
}));

import { getActiveHarness } from "@/lib/harness";

const mockHarness = vi.mocked(getActiveHarness);

const idle = {
  phase: "idle",
  qr: null,
  qrIssuedAt: null,
  qrCount: 0,
  restarts: 0,
  user: null,
  error: null,
  startedAt: null,
};

let POST: typeof import("@/app/setup-api/whatsapp/pair/route").POST;
let GET: typeof import("@/app/setup-api/whatsapp/pair/route").GET;
let DELETE: typeof import("@/app/setup-api/whatsapp/pair/route").DELETE;
let UNPAIR: typeof import("@/app/setup-api/whatsapp/unpair/route").POST;

function req(body?: unknown): Request {
  return new Request("http://localhost/setup-api/whatsapp/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockHarness.mockResolvedValue("hermes");
  start.mockResolvedValue({ ...idle, phase: "starting" });
  poll.mockReturnValue({ ...idle });
  stop.mockReturnValue({ ...idle });
  unpair.mockResolvedValue(undefined);

  const mod = await import("@/app/setup-api/whatsapp/pair/route");
  POST = mod.POST;
  GET = mod.GET;
  DELETE = mod.DELETE;
  UNPAIR = (await import("@/app/setup-api/whatsapp/unpair/route")).POST;
});

describe("POST /setup-api/whatsapp/pair", () => {
  it("starts a pairing session on Hermes", async () => {
    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.supported).toBe(true);
    expect(body.phase).toBe("starting");
    expect(start).toHaveBeenCalledWith({ force: false });
  });

  it("passes force through for a deliberate re-pair", async () => {
    await POST(req({ force: true }));
    expect(start).toHaveBeenCalledWith({ force: true });
  });

  it("treats a missing body as an ordinary start, not an error", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith({ force: false });
  });

  it("refuses on a non-Hermes harness without touching the bridge", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.supported).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns 500 rather than a half-answer when the manager throws", async () => {
    start.mockRejectedValue(new Error("spawn EACCES"));
    const res = await POST(req({}));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("spawn EACCES");
  });
});

describe("GET /setup-api/whatsapp/pair", () => {
  it("returns the snapshot including the raw QR payload", async () => {
    poll.mockReturnValue({ ...idle, phase: "waiting", qr: "2@PAYLOAD", qrCount: 3 });
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("waiting");
    expect(body.qr).toBe("2@PAYLOAD");
    expect(body.qrCount).toBe(3);
  });

  it("polls through the manager, which is what renews the keepalive", async () => {
    await GET();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("refuses on a non-Hermes harness", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const res = await GET();
    expect(res.status).toBe(501);
    expect(poll).not.toHaveBeenCalled();
  });
});

describe("DELETE /setup-api/whatsapp/pair", () => {
  it("stops the session and reports idle", async () => {
    const res = await DELETE();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("idle");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("refuses on a non-Hermes harness", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const res = await DELETE();
    expect(res.status).toBe(501);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/whatsapp/unpair", () => {
  it("clears every session location the adapter reads", async () => {
    const res = await UNPAIR();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(unpair).toHaveBeenCalledWith([
      "/hermes/platforms/whatsapp/session",
      "/hermes/whatsapp/session",
    ]);
  });

  it("refuses on a non-Hermes harness without deleting anything", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const res = await UNPAIR();

    expect(res.status).toBe(501);
    expect(unpair).not.toHaveBeenCalled();
  });

  it("reports a failure instead of claiming success", async () => {
    unpair.mockRejectedValue(new Error("EPERM"));
    const res = await UNPAIR();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("EPERM");
  });
});
