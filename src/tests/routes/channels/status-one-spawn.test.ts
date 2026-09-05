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
  gatewayRestartGeneration: vi.fn(() => 0),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(async () => {}),
  spawnOpenclawCli: vi.fn(),
}));

import { gatewayRestartGeneration, spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);
const mockRestarts = vi.mocked(gatewayRestartGeneration);

/** What one mocked `channels status` start costs, standing in for the seconds. */
const CLI_MS = 100;

let statusStarts = 0;
/** Every `channels status` argv the module actually spawned. */
let statusArgs: string[][] = [];
let cliFails = false;
/**
 * Per-start answers, consumed in order: `{ ms }` is how long that start takes
 * and `{ out }` what it prints (or `fail` for a spawn that throws). Two reads
 * can be in flight at once now, so a mock that answers every start with the
 * same latency and the same payload cannot exercise either the ordering or the
 * content divergence between them.
 */
let script: { ms: number; out?: string; fail?: boolean }[] = [];

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
  script = [];
  // A failed read is logged; the failure case below is deliberate.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockRestarts.mockReturnValue(0);
  mockSpawn.mockImplementation(async (args: string[]) => {
    if (args[0] === "channels" && args[1] === "status") {
      const step = script.shift();
      statusStarts += 1;
      statusArgs.push(args);
      await new Promise((resolve) => setTimeout(resolve, step?.ms ?? CLI_MS));
      if (step?.fail || (!step && cliFails)) throw new Error("gateway unreachable");
      return step?.out ?? payload();
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

  it("treats a gateway the CLI could not reach as a failed read, not as 'no channels'", async () => {
    // Measured on the OpenClaw box with `clawbox-gateway.service` stopped:
    // `channels status --json` exits 0 and prints a valid object —
    // `{ gatewayReachable: false, configOnly: true, error: "Gateway not
    // reachable at ws://…(ECONNREFUSED)…", configuredChannels: ["telegram"] }`
    // — with no `channelAccounts` and no `channels` key at all. Read as a
    // payload that is "the gateway answered and none of these channels exists",
    // which is pinned for the full 15 s answer window instead of the 3 s a
    // failed read gets. A gateway restart is the commonest event on this box.
    vi.useFakeTimers({ toFake: ["Date"] });
    script = [{
      ms: 0,
      out: JSON.stringify({
        gatewayReachable: false,
        configOnly: true,
        error: "Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED).",
        configuredChannels: ["telegram"],
      }),
    }];

    expect(await channels.readCachedChannelRow("telegram")).toBeNull();
    expect(statusStarts).toBe(1);

    // The short window, because this was not an answer about any channel.
    vi.setSystemTime(Date.now() + 5_000);
    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ connected: true });
    expect(statusStarts).toBe(2);
  });

  it("does not downgrade a channel's fresh answer because another channel's read failed", async () => {
    // One read now speaks for every channel, so a failure has to be careful in
    // a way a per-channel read never had to be: WhatsApp's poll failing must
    // not turn Telegram's two-second-old emerald dot into "could not ask".
    vi.useFakeTimers({ toFake: ["Date"] });
    script = [{ ms: 0 }, { ms: 0, fail: true }];

    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ connected: true });
    channels.invalidateChannelStatus("whatsapp");
    vi.setSystemTime(Date.now() + 2_000);
    expect(await channels.readCachedChannelRow("whatsapp")).toBeNull();
    expect(statusStarts).toBe(2);

    // Telegram's answer is still inside its window and still an answer.
    const telegram = await channels.readCachedChannelRowResult("telegram");
    expect(telegram).toEqual({ answered: true, row: expect.objectContaining({ connected: true }) });
    expect(statusStarts).toBe(2);
  });

  it("lets the read that STARTED last own the row, whatever order they finish in", async () => {
    // Two shared reads overlap whenever a change lands mid-flight. The older
    // one is slower here — two CLI cold starts competing on a Jetson is exactly
    // how that happens — so without a guard it lands second and stamps its
    // pre-restart rows as fresh.
    const stale = JSON.stringify({
      channelAccounts: { telegram: [{ configured: true, connected: true }] },
    });
    const fresh = JSON.stringify({
      channelAccounts: { telegram: [{ configured: true, connected: false }] },
    });
    script = [{ ms: 80, out: stale }, { ms: 10, out: fresh }];

    const first = channels.readCachedChannelRow("telegram");
    channels.invalidateChannelStatus("telegram");
    const second = channels.readCachedChannelRow("telegram");

    expect(await second).toMatchObject({ connected: false });
    await first;
    expect(statusStarts).toBe(2);
    // The slow first read has now settled. It must not have overwritten the
    // newer answer with the connection state it captured before the change.
    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ connected: false });
    expect(statusStarts).toBe(2);
  });

  it("drops every channel's row when the gateway is restarted by something that knows nothing about channels", async () => {
    // `restartGateway()` has ~14 callers — a model save, an STT change, a
    // browser install, the updater, boot — and none of them invalidates a
    // channel. On beta a channel held a row only if that channel had been
    // polled; now ONE poll seeds all three, so the stale answer covers channels
    // the owner never opened. The monotonic restart counter is what closes it.
    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ connected: true });
    expect(statusStarts).toBe(1);

    mockRestarts.mockReturnValue(1);
    script = [{ ms: 0, out: JSON.stringify({
      channelAccounts: { telegram: [{ configured: true, connected: false }] },
    }) }];
    expect(await channels.readCachedChannelRow("telegram")).toMatchObject({ connected: false });
    expect(statusStarts).toBe(2);
    // And the channels that were only seeded by the first read are re-asked too.
    expect(await channels.readCachedChannelRow("discord")).toBeNull();
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
