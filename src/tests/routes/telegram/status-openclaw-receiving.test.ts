/**
 * /setup-api/telegram/status on the OPENCLAW edition — is anything LISTENING?
 *
 * The Hermes branch has answered `receiving` since it was written; this one
 * answered `{ configured: true, ...botInfo }` and nothing else. So the Channels
 * hub, which draws its dot from that field, had no answer at all on the edition
 * most boxes ship with and fell back to "configured" — the emerald dot over a
 * box whose gateway is stopped, which is the false success the field exists to
 * remove (TASK-693).
 *
 * The answer comes from the harness, not from an inference: `openclaw channels
 * status --channel telegram --json` through `readCachedChannelStatus`, the one
 * shared memo the Discord route already uses (15 s success / 3 s failure,
 * in-flight coalesced, invalidated by every channel write).
 *
 * And it is TRI-STATE. `null` means the gateway could not be asked — every
 * Telegram save restarts it, so the read right after one lands in that window —
 * and a panel that read that as a definite "not receiving" would accuse a
 * working bot at the exact moment the owner is watching.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-channels", () => ({ readCachedChannelStatus: vi.fn() }));
vi.mock("@/lib/telegram-bot-identity", () => ({ readActiveTelegramBot: vi.fn() }));
vi.mock("@/lib/hermes-telegram", () => ({
  hermesGatewayStatus: vi.fn(),
  hermesTelegramRegistered: vi.fn(),
}));

import { getActiveHarness } from "@/lib/harness";
import { readCachedChannelStatus } from "@/lib/openclaw-channels";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";

const mockHarness = vi.mocked(getActiveHarness);
const mockChannel = vi.mocked(readCachedChannelStatus);
const mockBot = vi.mocked(readActiveTelegramBot);

const TOKEN = "123456:clawbox-test-not-a-real-telegram-token";

function row(over: Partial<NonNullable<Awaited<ReturnType<typeof readCachedChannelStatus>>>> = {}) {
  return {
    configured: true,
    running: true,
    connected: true,
    tokenStatus: "available" as const,
    restartPending: false,
    lastError: null,
    ...over,
  };
}

function botResponse() {
  return new Response(JSON.stringify({ ok: true, result: { username: "clawbot", first_name: "Claw" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /setup-api/telegram/status — OpenClaw receiving", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    // The route holds module-level caches; one carried between tests would
    // answer the next.
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => botResponse()));
    mockHarness.mockResolvedValue("openclaw");
    mockBot.mockResolvedValue({ token: TOKEN, known: true, source: "harness" } as never);
    mockChannel.mockResolvedValue(row());
    GET = (await import("@/app/setup-api/telegram/status/route")).GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers receiving:true for a channel the gateway says is connected", async () => {
    const body = await (await GET()).json();
    expect(body.configured).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.receiving).toBe(true);
    expect(mockChannel).toHaveBeenCalledWith("telegram");
  });

  it("answers receiving:false for a bot that is set up and not listening", async () => {
    // The gateway is stopped, or the adapter is in a restart loop. This is the
    // case that used to draw the emerald dot.
    mockChannel.mockResolvedValue(row({ running: false, connected: false }));
    expect((await (await GET()).json()).receiving).toBe(false);
  });

  it("does not call a running-but-unconnected adapter live", async () => {
    // `running` alone is satisfied by a process that never finished connecting.
    mockChannel.mockResolvedValue(row({ connected: false }));
    expect((await (await GET()).json()).receiving).toBe(false);
  });

  it("answers receiving:null — never false — when the gateway could not be asked", async () => {
    mockChannel.mockResolvedValue(null);

    const body = await (await GET()).json();
    expect(body.configured, "the bot is still configured").toBe(true);
    expect(body.verified).toBe(false);
    expect(body.receiving).toBeNull();
  });
});
