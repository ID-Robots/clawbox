import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The four WhatsApp routes on the OPENCLAW edition.
 *
 * All four used to answer a flat refusal:
 *
 *     { error: "WhatsApp is only available on the Hermes edition", supported: false }  // 501
 *
 * which was honest when it was written — the OpenClaw WhatsApp channel is a
 * separately-installed plugin whose only documented login is an interactive QR
 * command, and /whatsapp/status said so: "none of it is verifiable from a
 * ClawBox build".
 *
 * It is verifiable now. `@openclaw/whatsapp` exposes `loginWithQrStart` /
 * `loginWithQrWait`, the gateway publishes them as the `web.login.start` and
 * `web.login.wait` RPC methods, and `openclaw gateway call` invokes those
 * non-interactively — returning a PNG data URL rather than terminal ASCII art.
 *
 * THE RULE THIS FILE HOLDS: the OUTSIDE does not change. Same routes, same
 * request and response shapes, same phases, so the panel's pairing UX is the
 * one the owner already has on Hermes. Only what happens underneath differs.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-channels", () => ({
  ensureChannelPlugin: vi.fn(),
  invalidateChannelStatus: vi.fn(),
  readCachedChannelRow: vi.fn(),
  waitForChannelConnected: vi.fn(),
}));
vi.mock("@/lib/openclaw-whatsapp", () => ({
  WHATSAPP_CHANNEL_ID: "whatsapp",
  getOpenclawWhatsappPairing: vi.fn(),
  logoutOpenclawWhatsapp: vi.fn(),
  readOpenclawWhatsappStatus: vi.fn(),
  setOpenclawWhatsappEnabled: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class: both channel routes narrow on `instanceof GatewayNotReadyError`
  // to tell "the gateway has not finished binding" from "the restart was
  // refused", and `instanceof undefined` throws a TypeError the first time a
  // test makes the mocked restart reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  restartGateway: vi.fn(),
}));
vi.mock("@/lib/hermes-whatsapp", () => ({
  isWhatsappMode: (v: unknown) => v === "personal" || v === "business",
  normalizeWhatsappNumber: (v: string) => (/^\+?\d{6,15}$/.test(v) ? v.replace(/^\+/, "") : null),
  setHermesWhatsappConfig: vi.fn(),
  WhatsappNotPairedError: class extends Error {},
  whatsappSessionDirs: () => [],
  readHermesWhatsappStatus: vi.fn(),
}));
vi.mock("@/lib/hermes-telegram", () => ({
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(async () => ({ installed: false, running: false, scope: null })),
}));
vi.mock("@/lib/whatsapp-pairing", () => ({
  getPairingManager: vi.fn(),
  unpairWhatsapp: vi.fn(),
}));

import { getActiveHarness } from "@/lib/harness";
import { GatewayNotReadyError, restartGateway } from "@/lib/openclaw-config";
import { ensureChannelPlugin, waitForChannelConnected } from "@/lib/openclaw-channels";
import {
  getOpenclawWhatsappPairing,
  logoutOpenclawWhatsapp,
  readOpenclawWhatsappStatus,
  setOpenclawWhatsappEnabled,
} from "@/lib/openclaw-whatsapp";

const mockHarness = vi.mocked(getActiveHarness);
const mockEnsurePlugin = vi.mocked(ensureChannelPlugin);
const mockWait = vi.mocked(waitForChannelConnected);
const mockPairing = vi.mocked(getOpenclawWhatsappPairing);
const mockLogout = vi.mocked(logoutOpenclawWhatsapp);
const mockStatus = vi.mocked(readOpenclawWhatsappStatus);
const mockSetEnabled = vi.mocked(setOpenclawWhatsappEnabled);
const mockRestart = vi.mocked(restartGateway);

const IDLE_SNAPSHOT = {
  phase: "idle" as const,
  qr: null,
  qrImage: null,
  qrIssuedAt: null,
  qrCount: 0,
  restarts: 0,
  user: null,
  gatewayRestartPending: false,
  error: null,
  startedAt: null,
};

function connectedChannel() {
  return {
    configured: true,
    running: true,
    connected: true,
    tokenStatus: "available" as const,
    restartPending: false,
    lastError: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockHarness.mockResolvedValue("openclaw");
  mockEnsurePlugin.mockResolvedValue({ ok: true, installed: false });
  mockWait.mockResolvedValue(connectedChannel());
  mockSetEnabled.mockResolvedValue();
  mockRestart.mockResolvedValue();
  mockLogout.mockResolvedValue();
  mockStatus.mockResolvedValue({
    state: "paired",
    enabled: true,
    paired: true,
    connected: true,
    verified: true,
  });
  mockPairing.mockReturnValue({
    start: vi.fn(async () => ({ ...IDLE_SNAPSHOT, phase: "waiting" as const, qrImage: "data:image/png;base64,AAAA" })),
    poll: vi.fn(() => ({ ...IDLE_SNAPSHOT, phase: "waiting" as const, qrImage: "data:image/png;base64,AAAA" })),
    stop: vi.fn(() => ({ ...IDLE_SNAPSHOT })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

describe("POST /setup-api/whatsapp/configure — OpenClaw", () => {
  async function post(body: unknown) {
    const { POST } = await import("@/app/setup-api/whatsapp/configure/route");
    const res = await POST(
      new Request("http://localhost/setup-api/whatsapp/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  it("no longer refuses on OpenClaw", async () => {
    const res = await post({ enabled: true });

    expect(res.status).not.toBe(501);
    expect(res.body.supported).not.toBe(false);
  });

  it("installs the WhatsApp channel plugin before enabling the channel", async () => {
    await post({ enabled: true });

    expect(mockEnsurePlugin).toHaveBeenCalledWith("whatsapp");
    expect(mockEnsurePlugin.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetEnabled.mock.invocationCallOrder[0],
    );
  });

  it("does not report success when the channel never reaches connected", async () => {
    mockWait.mockResolvedValue({ ...connectedChannel(), running: false, connected: false });

    const res = await post({ enabled: true });

    expect(res.body.success).toBe(false);
    expect(res.body.warning).toBe("not_connected");
  });

  it("does not call a slow-but-healthy restart a failed save, and still asks the gateway", async () => {
    // TASK-608, the same split /discord/configure gets. `systemctl restart`
    // returned 0 and the gateway is starting; only the readiness poll gave up.
    // Answering `restart_pending` would call a landed save a failure AND skip
    // `waitForChannelConnected`, the live check that can actually settle it.
    mockRestart.mockRejectedValue(new GatewayNotReadyError());

    const res = await post({ enabled: true });

    expect(mockWait).toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: true, restarted: true });
    expect(res.body.warning).toBeUndefined();
  });

  it("still reports a refused restart as restart_pending", async () => {
    // Nothing is coming back on its own, so the live check would only spend its
    // attempts confirming that. This half must not move.
    mockRestart.mockRejectedValue(new Error("Unit clawbox-gateway.service is masked."));

    const res = await post({ enabled: true });

    expect(res.body).toMatchObject({ success: false, restarted: false, warning: "restart_pending" });
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("names a failed plugin install", async () => {
    mockEnsurePlugin.mockResolvedValue({ ok: false, reason: "install_failed" });

    expect((await post({ enabled: true })).body.warning).toBe("plugin_install_failed");
  });

  it("refuses an allowlist OpenClaw does not own, rather than silently dropping it", async () => {
    // OpenClaw admits senders through its own owner-approved pairing, exactly
    // as it does for Discord. Accepting the numbers and writing nothing would
    // hand back an allowlist the owner believes is in force.
    const res = await post({ allowedUsers: ["359888123456"] });

    expect(res.status).toBe(400);
    expect(res.body.allowlistSupported).toBe(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("turns the channel off without touching the stored link", async () => {
    const res = await post({ enabled: false });

    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(res.body.success).toBe(true);
  });
});

describe("GET /setup-api/whatsapp/status — OpenClaw", () => {
  async function get() {
    const { GET } = await import("@/app/setup-api/whatsapp/status/route");
    const res = await GET();
    return { status: res.status, body: await res.json() };
  }

  it("reports the channel as supported instead of 'unsupported'", async () => {
    const res = await get();

    expect(res.body.supported).toBe(true);
    expect(res.body.state).toBe("paired");
  });

  it("is receiving only when the gateway says the transport is up", async () => {
    mockStatus.mockResolvedValue({
      state: "paired",
      enabled: true,
      paired: true,
      connected: false,
      verified: true,
    });

    expect((await get()).body.receiving).toBe(false);
  });

  it("offers no allowlist, because OpenClaw owns sender approval", async () => {
    expect((await get()).body.allowlistSupported).toBe(false);
  });

  it("reports a link that exists but is switched off", async () => {
    mockStatus.mockResolvedValue({
      state: "enabled_not_paired",
      enabled: true,
      paired: false,
      connected: false,
      verified: true,
    });

    const res = await get();
    expect(res.body.state).toBe("enabled_not_paired");
    expect(res.body.receiving).toBe(false);
  });
});

describe("/setup-api/whatsapp/pair — OpenClaw", () => {
  it("starts a QR login and hands back a renderable image", async () => {
    const { POST } = await import("@/app/setup-api/whatsapp/pair/route");
    const res = await POST(new Request("http://localhost/setup-api/whatsapp/pair", { method: "POST" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.supported).toBe(true);
    expect(body.phase).toBe("waiting");
    // The plugin renders the QR itself; there is no raw Baileys payload to
    // hand out on this harness, so the panel gets an image instead.
    expect(body.qrImage).toMatch(/^data:image\/png;base64,/);
  });

  it("polls without spawning a second login", async () => {
    const { GET } = await import("@/app/setup-api/whatsapp/pair/route");
    const body = await (await GET()).json();

    expect(body.phase).toBe("waiting");
    expect(mockPairing.mock.results[0].value.start).not.toHaveBeenCalled();
  });

  it("cancels", async () => {
    const { DELETE } = await import("@/app/setup-api/whatsapp/pair/route");
    const body = await (await DELETE()).json();

    expect(body.phase).toBe("idle");
  });
});

describe("POST /setup-api/whatsapp/unpair — OpenClaw", () => {
  it("logs the session out and turns the channel off together", async () => {
    const { POST } = await import("@/app/setup-api/whatsapp/unpair/route");
    const res = await POST();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockLogout).toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });

  it("ends a live pairing session so no QR outlives the link", async () => {
    // The keepalive calls web.login.wait every few seconds. Left running
    // through an unpair it would keep asking about a channel that is now off,
    // and an in-flight answer would put a QR back on screen for a link the
    // owner just removed.
    await POST_unpair();

    expect(mockPairing.mock.results[0].value.stop).toHaveBeenCalled();
  });

  it("still turns the channel off when the logout fails", async () => {
    // Creds without the channel switched off is a gateway retrying a login it
    // cannot complete; the two have to move together.
    mockLogout.mockRejectedValue(new Error("gateway unreachable"));

    const res = await POST_unpair();
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(res.status).toBe(500);
  });

  async function POST_unpair() {
    const { POST } = await import("@/app/setup-api/whatsapp/unpair/route");
    return POST();
  }
});
