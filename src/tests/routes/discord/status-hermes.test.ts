import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * On a Hermes device a stored token proves nothing on its own — that is the
 * whole lesson of the Telegram bug. The flag comes from Hermes, and "we could
 * not ask Hermes" must never render as "your bot is gone".
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-discord", () => ({
  hermesDiscordRegistered: vi.fn(),
  hermesGatewayStatus: vi.fn(),
}));

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { hermesDiscordRegistered, hermesGatewayStatus } from "@/lib/hermes-discord";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockRegistered = vi.mocked(hermesDiscordRegistered);
const mockGatewayStatus = vi.mocked(hermesGatewayStatus);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

describe("GET /setup-api/discord/status — Hermes", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    mockGet.mockResolvedValue(TOKEN);
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(true);
    mockGatewayStatus.mockResolvedValue({ installed: true, running: true, scope: "system" });

    GET = (await import("@/app/setup-api/discord/status/route")).GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is live only when Hermes knows the platform AND its gateway is up", async () => {
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      configured: true,
      verified: true,
      receiving: true,
      username: "clawbot",
    });
  });

  it("is configured but not receiving when the gateway is down", async () => {
    mockGatewayStatus.mockResolvedValue({ installed: true, running: false, scope: "system" });

    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, receiving: false });
    expect(body.gateway).toMatchObject({ installed: true, running: false });
  });

  it("reports not-configured when Hermes says it has no Discord platform", async () => {
    mockRegistered.mockResolvedValue(false);
    const body = await (await GET()).json();
    expect(body).toMatchObject({ configured: false, verified: true, receiving: false });
  });

  it("falls back to the stored token — unverified — when Hermes cannot be asked", async () => {
    mockRegistered.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, verified: false });
  });

  it("asks Hermes only once for concurrent callers", async () => {
    await Promise.all([GET(), GET(), GET()]);
    expect(mockRegistered).toHaveBeenCalledTimes(1);
    expect(mockGatewayStatus).toHaveBeenCalledTimes(1);
  });

  it("never returns the token itself", async () => {
    expect(await (await GET()).text()).not.toContain(TOKEN);
  });
});
