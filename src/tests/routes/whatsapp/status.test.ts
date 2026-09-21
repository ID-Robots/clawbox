import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-whatsapp", () => ({
  readOpenclawWhatsappStatus: vi.fn(async () => ({
    state: "not_configured",
    enabled: false,
    paired: false,
    connected: false,
  })),
}));
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
  it("answers from the OpenClaw channel, without touching Hermes", async () => {
    // This used to assert `supported: false` / `state: "unsupported"`, which
    // was the honest answer while the OpenClaw WhatsApp plugin had no surface
    // a ClawBox build could drive. It has one now — see
    // src/tests/routes/whatsapp/openclaw.test.ts for that branch's contract.
    // What still has to hold here is that the Hermes probes stay untouched.
    mockHarness.mockResolvedValue("openclaw");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.harness).toBe("openclaw");
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

  it("asks the shared gateway reader rather than keeping a second copy of it", async () => {
    // The dedup and the TTL split live in `hermesGatewayStatus()` now, not
    // here. Three status routes ask for that same ~2 s CLI cold start, and
    // three private 15 s memos meant a cold Settings → Channels open ran it
    // three times concurrently — and, worse, shadowed the invalidation the
    // gateway restart paths call, so a save that restarted the gateway kept
    // being answered with the pre-restart process until the local copy aged
    // out. This route must therefore go to the shared reader every time and
    // let it decide what is cached; the memo's own behaviour is pinned in
    // `src/tests/unit/hermes-gateway-status-memo.test.ts`.
    await Promise.all([GET(), GET(), GET()]);
    expect(mockGateway).toHaveBeenCalledTimes(3);
  });

  it("returns 500 without echoing the exception message", async () => {
    // An unreadable ~/.hermes/.env arrives here as an EACCES whose message
    // carries the absolute path. The client gets a fixed string; the real
    // error goes to the server log.
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStatus.mockRejectedValue(new Error("EACCES: permission denied, open '/home/clawbox/.hermes/.env'"));
    GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Status check failed");
    expect(JSON.stringify(body)).not.toContain("/home/clawbox");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
