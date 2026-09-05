import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * TASK-671 (split from F-28 / PR #594): one `openclaw channels status` start
 * must fill the memo for EVERY channel, not one channel per start.
 *
 * `--channel` is optional on that command — measured against the installed CLI
 * (openclaw 2026.8.1) on the OpenClaw box, where the un-filtered payload keys
 * `channelAccounts` and `channels` by `discord`/`telegram`/`whatsapp` even on a
 * box that has only Telegram configured — and `readChannelRow`'s parser already
 * indexes into a multi-channel payload. So the CLI has always handed back every
 * channel in one process start and this module threw all but one row away.
 *
 * It matters because a cold Channels hub, and Settings on a phone (the panels'
 * `!isMobile` escapes never return early there), read several channel statuses
 * on one mount. Measured on the box, three runs each:
 *   un-filtered  `channels status --json`                 3.72 / 3.25 / 3.19 s
 *   filtered     `channels status --channel <id> --json`  3.17 / 3.15 / 3.10 s
 * — the whole cost is the CLI cold start, and walking every channel adds about
 * a quarter of a second. Two filtered reads are ~6.3 s where one un-filtered
 * read is ~3.4 s.
 *
 * The CLI is mocked at `spawnOpenclawCli`, below every layer this touches, so
 * the count is of real would-be process starts.
 */

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(async () => {}),
  spawnOpenclawCli: vi.fn(),
}));

import { spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);

/** What one mocked `channels status` start costs, standing in for the seconds. */
const CLI_MS = 100;

let statusStarts = 0;
/** Every `channels status` argv the module actually spawned. */
let statusArgs: string[][] = [];
let cliFails = false;

/** The gateway's answer for a box with all three channels present. */
function payload() {
  return JSON.stringify({
    channelAccounts: {
      telegram: [{ configured: true, enabled: true, connected: true }],
      whatsapp: [{ configured: true, enabled: true, linked: true, connected: true }],
      discord: [{ configured: true, enabled: true, connected: false }],
    },
  });
}

let channels: typeof import("@/lib/openclaw-channels");

beforeEach(async () => {
  // The memo is module-level; a cache carried between cases would answer the
  // next one.
  vi.resetModules();
  vi.clearAllMocks();
  statusStarts = 0;
  statusArgs = [];
  cliFails = false;
  // A failed read is logged; the failure case below is deliberate.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockSpawn.mockImplementation(async (args: string[]) => {
    if (args[0] === "channels" && args[1] === "status") {
      statusStarts += 1;
      statusArgs.push(args);
      await new Promise((resolve) => setTimeout(resolve, CLI_MS));
      if (cliFails) throw new Error("gateway unreachable");
      return payload();
    }
    return "{}";
  });
  channels = await import("@/lib/openclaw-channels");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one CLI start fills every channel's memo", () => {
  it("serves a Settings mount that reads three channels from one start", async () => {
    const [telegram, whatsapp, discord] = await Promise.all([
      channels.readCachedChannelRow("telegram"),
      channels.readCachedChannelRow("whatsapp"),
      channels.readCachedChannelRow("discord"),
    ]);

    expect(statusStarts).toBe(1);
    // The one start must be the UN-filtered read, or it could only have
    // answered about the channel it named.
    expect(statusArgs[0]).not.toContain("--channel");
    expect(telegram).toMatchObject({ connected: true });
    expect(whatsapp).toMatchObject({ linked: true });
    expect(discord).toMatchObject({ connected: false });
  });

  it("answers the second and third channel from memory, sequentially too", async () => {
    // The concurrent case above shares one in-flight promise. This is the other
    // half: a panel that reads its channels one after the other must find the
    // rest of the payload already stored rather than starting the CLI again.
    await channels.readCachedChannelRow("whatsapp");
    expect(statusStarts).toBe(1);
    await channels.readCachedChannelRow("discord");
    await channels.readCachedChannelRow("telegram");
    expect(statusStarts).toBe(1);
  });

  it("caches a channel absent from the payload as 'no row', not as unasked", async () => {
    // The gateway answered; a channel it did not mention was never set up. That
    // is a real answer and stands for a full window — leaving it unset would
    // re-spawn the CLI on every poll for exactly the un-configured box this
    // change is for.
    vi.useFakeTimers({ toFake: ["Date"] });
    mockSpawn.mockImplementation(async (args: string[]) => {
      if (args[0] === "channels" && args[1] === "status") {
        statusStarts += 1;
        statusArgs.push(args);
        return JSON.stringify({ channelAccounts: { telegram: [{ configured: true }] } });
      }
      return "{}";
    });

    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ configured: true });
    expect(await channels.readCachedChannelRow("whatsapp")).toBeNull();
    expect(await channels.readCachedChannelRow("discord")).toBeNull();
    expect(statusStarts).toBe(1);

    vi.setSystemTime(Date.now() + 4_000);
    expect(await channels.readCachedChannelRow("whatsapp")).toBeNull();
    expect(statusStarts).toBe(1);
  });

  it("keeps a failed read on the short window, for every channel", async () => {
    // "The gateway could not be asked" is not an answer about any channel, so
    // it must not be pinned for a whole answer window — on the channel that
    // asked or on the ones the same payload would have covered.
    vi.useFakeTimers({ toFake: ["Date"] });
    cliFails = true;
    expect(await channels.readCachedChannelRow("whatsapp")).toBeNull();
    expect(await channels.readCachedChannelRow("discord")).toBeNull();
    expect(statusStarts).toBe(1);

    cliFails = false;
    vi.setSystemTime(Date.now() + 5_000);
    expect(await channels.readCachedChannelRow("discord")).toMatchObject({ connected: false });
    expect(statusStarts).toBe(2);
  });

  it("never lets one channel's invalidation discard another's fresh row", async () => {
    // The epochs are per channel and one read now covers many of them, so the
    // shared read has to store per channel: a pairing that invalidates WhatsApp
    // while the read is out must drop only WhatsApp's answer.
    const inFlight = channels.readCachedChannelRow("whatsapp");
    channels.invalidateChannelStatus("whatsapp");
    await inFlight;

    // Discord's row came from the same payload and nothing invalidated it.
    expect(await channels.readCachedChannelRow("discord")).toMatchObject({ connected: false });
    expect(statusStarts).toBe(1);

    // WhatsApp's was dropped, so it is asked again.
    expect(await channels.readCachedChannelRow("whatsapp")).toMatchObject({ linked: true });
    expect(statusStarts).toBe(2);
  });

  it("never answers a poll made after a change from the read that started before it", async () => {
    // The guard PR #594 added, kept across the shape change: a read still out
    // when the owner's scan lands must neither answer the poll that follows it
    // nor be stored, and its cleanup must not evict the read that replaced it.
    const stale = channels.readCachedChannelRow("whatsapp");
    channels.invalidateChannelStatus("whatsapp");
    const fresh = channels.readCachedChannelRow("whatsapp");
    expect(await fresh).toMatchObject({ linked: true });
    await stale;
    expect(statusStarts).toBe(2);
    await channels.readCachedChannelRow("whatsapp");
    expect(statusStarts).toBe(2);
  });

  it("still asks about one channel only when the caller wants a read right now", async () => {
    // `readChannelRow` is the uncached "ask the gateway now" read that
    // `waitForChannelConnected` polls a transition with. Filtering there is
    // right: it is about one channel and pays no memo.
    await channels.readChannelRow("whatsapp");
    expect(statusStarts).toBe(1);
    expect(statusArgs[0]).toContain("--channel");
    expect(statusArgs[0]).toContain("whatsapp");
  });
});
