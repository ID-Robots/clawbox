import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The status flag used to mean "ClawBox has a token in its own config store",
 * which on a Hermes device was simply untrue: the OpenClaw path saved a token
 * on a box with no gateway to consume it, and the UI reported a configured bot
 * that could never answer. On Hermes the flag now comes from Hermes.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-telegram", () => ({
  hermesTelegramRegistered: vi.fn(),
  hermesGatewayStatus: vi.fn(),
}));

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { hermesTelegramRegistered, hermesGatewayStatus } from "@/lib/hermes-telegram";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockRegistered = vi.mocked(hermesTelegramRegistered);
const mockGateway = vi.mocked(hermesGatewayStatus);

const TOKEN = "123456789:ABCDefGHIjklMNOpqrsTUVwxyz";
const UP = { installed: true, running: true, scope: "system" as const };
const DOWN = { installed: false, running: false, scope: null };

describe("GET /setup-api/telegram/status on Hermes", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Keep the network out of it: the bot-info lookup is a Telegram API call.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );

    mockGet.mockResolvedValue(TOKEN);
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(true);
    mockGateway.mockResolvedValue(UP);

    GET = (await import("@/app/setup-api/telegram/status/route")).GET;
  });

  it("reports a bot Hermes knows about, and that it is receiving", async () => {
    const body = await (await GET()).json();

    expect(body).toMatchObject({
      configured: true,
      verified: true,
      receiving: true,
      gateway: UP,
    });
  });

  // The case the old flag got wrong: token stored, Hermes never told about it.
  it("reports not-configured when Hermes has no Telegram platform", async () => {
    mockRegistered.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(body.configured).toBe(false);
    expect(body.verified).toBe(true);
  });

  it("is configured but not receiving when the gateway is down", async () => {
    mockGateway.mockResolvedValue({ installed: true, running: false, scope: "system" });
    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, receiving: false });
  });

  // A probe that could not run is not evidence that the bot is gone.
  it("falls back to the stored token when Hermes cannot be asked", async () => {
    mockRegistered.mockResolvedValue(null);
    mockGateway.mockResolvedValue(DOWN);
    const body = await (await GET()).json();

    expect(body.configured).toBe(true);
    expect(body.verified).toBe(false);
  });

  it("does not probe Hermes at all when no token is stored", async () => {
    mockGet.mockResolvedValue(undefined);
    const body = await (await GET()).json();

    expect(body).toEqual({ configured: false });
    expect(mockRegistered).not.toHaveBeenCalled();
  });

  it("re-probes after the bot token changes instead of serving the old answer", async () => {
    await GET();
    expect(mockRegistered).toHaveBeenCalledTimes(1);

    // Same token within the cache window — one probe is enough.
    await GET();
    expect(mockRegistered).toHaveBeenCalledTimes(1);

    mockGet.mockResolvedValue("987654321:a-different-bot");
    mockRegistered.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(mockRegistered).toHaveBeenCalledTimes(2);
    expect(body.configured).toBe(false);
  });

  it("remembers a probe it could not answer for far less time than one it could", async () => {
    // `null` is "Hermes could not be asked", and the row now offers Retry over
    // exactly that state. Keeping it for the full fifteen seconds made that
    // button a dead press: the same unknown came straight back out of the
    // cache without the CLI being re-entered at all.
    vi.useFakeTimers();
    try {
      mockRegistered.mockResolvedValue(null);
      await GET();
      expect(mockRegistered).toHaveBeenCalledTimes(1);

      // Inside the failure window the box must not re-enter a wedged CLI...
      vi.setSystemTime(Date.now() + 2_000);
      await GET();
      expect(mockRegistered).toHaveBeenCalledTimes(1);

      // ...but the unknown may not stand for a successful answer's window.
      vi.setSystemTime(Date.now() + 2_000);
      mockRegistered.mockResolvedValue(true);
      expect((await (await GET()).json()).verified).toBe(true);
      expect(mockRegistered).toHaveBeenCalledTimes(2);

      // A real answer still gets the full window.
      vi.setSystemTime(Date.now() + 5_000);
      await GET();
      expect(mockRegistered).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the OpenClaw path alone", async () => {
    mockHarness.mockResolvedValue("openclaw");
    const body = await (await GET()).json();

    expect(body.configured).toBe(true);
    expect(body.gateway).toBeUndefined();
    expect(mockRegistered).not.toHaveBeenCalled();
    expect(mockGateway).not.toHaveBeenCalled();
  });
});
