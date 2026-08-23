import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-telegram", () => ({ hermesGatewayStatus: vi.fn() }));
vi.mock("@/lib/hermes-whatsapp", () => ({ readHermesWhatsappStatus: vi.fn() }));

import { getActiveHarness } from "@/lib/harness";
import { hermesGatewayStatus } from "@/lib/hermes-telegram";
import { readHermesWhatsappStatus } from "@/lib/hermes-whatsapp";

const mockHarness = vi.mocked(getActiveHarness);
const mockGateway = vi.mocked(hermesGatewayStatus);
const mockStatus = vi.mocked(readHermesWhatsappStatus);

let GET: typeof import("@/app/setup-api/whatsapp/status/route").GET;

const pairedStatus = {
  state: "paired" as const,
  enabled: true,
  paired: true,
  mode: "bot" as const,
  allowedUsers: ["15551234567"],
  allowAllUsers: false,
  bridgeReady: true,
  authorized: true,
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockHarness.mockResolvedValue("hermes");
  mockGateway.mockResolvedValue({ installed: true, running: true, scope: "system" });
  mockStatus.mockResolvedValue({ ...pairedStatus });
  GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;
});

describe("GET /setup-api/whatsapp/status", () => {
  it("reports supported:false on a non-Hermes harness without touching Hermes", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.supported).toBe(false);
    expect(body.state).toBe("unsupported");
    // Nothing OpenClaw-side is guessed at or written.
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockGateway).not.toHaveBeenCalled();
  });

  it("returns the full state on Hermes", async () => {
    const body = await (await GET()).json();
    expect(body.supported).toBe(true);
    expect(body.state).toBe("paired");
    expect(body.allowedUsers).toEqual(["15551234567"]);
    expect(body.gateway).toEqual({ installed: true, running: true });
  });

  it("passes the gateway's authorization verdict through to the panel", async () => {
    // Pairing and authorization are separate gates upstream. The panel can only
    // warn about the second one if this route reports it.
    mockStatus.mockResolvedValue({ ...pairedStatus, authorized: false });
    expect((await (await GET()).json()).authorized).toBe(false);
  });

  it("refuses to call a box 'receiving' while the gateway denies its owner", async () => {
    // The live failure this field exists for: linked, enabled, gateway up, and
    // every message dropped with "Unauthorized user".
    vi.resetModules();
    mockStatus.mockResolvedValue({ ...pairedStatus, authorized: false });
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;

    const body = await (await GET()).json();
    expect(body.state).toBe("paired");
    expect(body.gateway.running).toBe(true);
    expect(body.receiving).toBe(false);
  });

  it("is only 'receiving' when paired AND the gateway runs", async () => {
    expect((await (await GET()).json()).receiving).toBe(true);

    vi.resetModules();
    mockGateway.mockResolvedValue({ installed: true, running: false, scope: "system" });
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;
    expect((await (await GET()).json()).receiving).toBe(false);

    vi.resetModules();
    mockGateway.mockResolvedValue({ installed: true, running: true, scope: "system" });
    mockStatus.mockResolvedValue({ ...pairedStatus, state: "enabled_not_paired", paired: false });
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;
    expect((await (await GET()).json()).receiving).toBe(false);
  });

  it("degrades to 'gateway not running' instead of failing the whole panel", async () => {
    vi.resetModules();
    mockGateway.mockRejectedValue(new Error("hermes CLI timed out"));
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.gateway).toEqual({ installed: false, running: false });
    expect(body.receiving).toBe(false);
  });

  it("coalesces concurrent callers onto one gateway probe", async () => {
    await Promise.all([GET(), GET(), GET()]);
    expect(mockGateway).toHaveBeenCalledTimes(1);
  });

  it("returns 500 with a plain message when the env read fails", async () => {
    vi.resetModules();
    mockStatus.mockRejectedValue(new Error("boom"));
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;

    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});
