import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/whatsapp/status must not pay a CLI cold start per poll.
 *
 * The OpenClaw branch of this route answers from `openclaw channels status
 * --channel whatsapp --json`, which is a full CLI start plus a gateway round
 * trip — measured at 3.2-3.6 s on a Jetson, against 20-40 ms for the sibling
 * Discord panel, which asks the SAME CLI and simply remembers the answer for
 * 15 s. The Settings panel polls this route, so every poll burned those
 * seconds again.
 *
 * What is pinned here:
 *   * two polls inside the window cost ONE CLI start, and the second is served
 *     from memory rather than re-timed;
 *   * concurrent polls share one in-flight start (the panel and the section
 *     subtitle both read this route);
 *   * the memo EXPIRES — a status read after the window asks again;
 *   * a completed pairing drops it immediately, so a cached "not paired" can
 *     never outlive the scan that paired the phone.
 *
 * The CLI is mocked at `spawnOpenclawCli`, i.e. below every layer this fix
 * touches, so the count is of real would-be process starts.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-telegram", () => ({ hermesGatewayStatus: vi.fn() }));
vi.mock("@/lib/hermes-whatsapp", () => ({ readHermesWhatsappStatus: vi.fn() }));
vi.mock("@/lib/whatsapp-pairing", () => ({ getPairingManager: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(async () => {}),
  spawnOpenclawCli: vi.fn(),
}));

import { spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);

/** What one mocked `channels status` start costs, standing in for the Jetson's seconds. */
const CLI_MS = 200;

let statusStarts = 0;
let accountRow: Record<string, unknown> | null;
/** When true the mocked CLI fails, i.e. "the gateway could not be asked". */
let cliFails = false;

function row(over: Record<string, unknown> = {}) {
  return { configured: true, enabled: true, linked: false, connected: false, ...over };
}

let GET: typeof import("@/app/setup-api/whatsapp/status/route").GET;
let PAIR: typeof import("@/app/setup-api/whatsapp/pair/route").POST;

beforeEach(async () => {
  // The memo is module-level; a cache carried between cases would answer the
  // next one.
  vi.resetModules();
  vi.clearAllMocks();
  statusStarts = 0;
  accountRow = row();
  cliFails = false;
  // readChannelRow() logs a failed read; the failure case below is deliberate.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockSpawn.mockImplementation(async (args: string[]) => {
    if (args[0] === "channels" && args[1] === "status") {
      statusStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, CLI_MS));
      if (cliFails) throw new Error("gateway unreachable");
      // `accountRow: null` is a valid payload with no WhatsApp entry at all —
      // the gateway ANSWERING that the channel was never set up.
      return JSON.stringify({
        channelAccounts: accountRow ? { whatsapp: [accountRow] } : {},
      });
    }
    if (args[0] === "gateway" && args[1] === "call") {
      return JSON.stringify({ connected: true });
    }
    return "{}";
  });
  GET = (await import("@/app/setup-api/whatsapp/status/route")).GET;
  PAIR = (await import("@/app/setup-api/whatsapp/pair/route")).POST;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /setup-api/whatsapp/status — the CLI is asked once per window", () => {
  it("serves a second poll from memory instead of starting the CLI again", async () => {
    const coldAt = Date.now();
    const first = await (await GET()).json();
    const coldMs = Date.now() - coldAt;

    const warmAt = Date.now();
    const second = await (await GET()).json();
    const warmMs = Date.now() - warmAt;

    // The spawn count is the evidence; the two timings are a sanity check with
    // a wide margin, so a stalled CI runner cannot fail them on its own.
    expect(statusStarts).toBe(1);
    expect(second).toEqual(first);
    expect(coldMs).toBeGreaterThanOrEqual(CLI_MS / 2);
    expect(warmMs).toBeLessThan(CLI_MS / 2);
  });

  it("coalesces concurrent polls onto one CLI start", async () => {
    // The Settings panel and the channel list both read this route.
    const bodies = await Promise.all([GET(), GET(), GET()].map(async (res) => (await res).json()));
    expect(statusStarts).toBe(1);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("asks again once the window is over", async () => {
    // Only the clock is faked: the mocked CLI still takes its CLI_MS.
    vi.useFakeTimers({ toFake: ["Date"] });
    await GET();
    expect(statusStarts).toBe(1);

    vi.setSystemTime(Date.now() + 16_000);
    await GET();
    expect(statusStarts).toBe(2);
  });

  it("drops a cached 'not paired' the moment a scan completes", async () => {
    // The probe-once trap this cache could have introduced: the owner scans the
    // QR, the gateway reports the phone linked, and the panel keeps showing the
    // answer from before the scan until the window happens to run out.
    expect((await (await GET()).json()).state).toBe("enabled_not_paired");

    accountRow = row({ linked: true, connected: true });
    const paired = await (await PAIR(new Request("http://clawbox.local/setup-api/whatsapp/pair", {
      method: "POST",
    }))).json();
    expect(paired.phase).toBe("paired");

    const after = await (await GET()).json();
    expect(after.state).toBe("paired");
    expect(after.receiving).toBe(true);
    expect(statusStarts).toBe(2);
  });

  it("never answers a poll made after a change from the read that started before it", async () => {
    // Dropping only the stored row is not enough: a status read is 3.5 s of CLI
    // on a Jetson, so a poll that arrives after the scan can easily land while
    // the PREVIOUS read is still out — and joining it would hand the owner the
    // "not linked" row that read was already fetching when they scanned.
    const stale = GET();

    accountRow = row({ linked: true, connected: true });
    expect((await (await PAIR(new Request("http://clawbox.local/setup-api/whatsapp/pair", {
      method: "POST",
    }))).json()).phase).toBe("paired");

    expect((await (await GET()).json()).state).toBe("paired");
    // The abandoned read still resolves; it must neither answer the new poll
    // nor be stored, and its cleanup must not evict the read that replaced it.
    await stale;
    expect(statusStarts).toBe(2);
    expect((await (await GET()).json()).state).toBe("paired");
    expect(statusStarts).toBe(2);
  });

  it("does not hold on to 'the gateway could not be asked' for a whole answer window", async () => {
    // A failed read IS remembered — a wedged CLI must not be re-entered per
    // poll — but only briefly: this route reports an unreadable channel as
    // `not_configured`, which the panel draws as an actionable "Not configured"
    // card. Pinning that for 15 s after a gateway restart would call a paired,
    // connected box unconfigured long after it was healthy again.
    vi.useFakeTimers({ toFake: ["Date"] });
    cliFails = true;
    expect((await (await GET()).json()).state).toBe("not_configured");
    await GET();
    expect(statusStarts).toBe(1);

    cliFails = false;
    vi.setSystemTime(Date.now() + 5_000);
    expect((await (await GET()).json()).state).toBe("enabled_not_paired");
    expect(statusStarts).toBe(2);
  });

  it("holds 'this channel was never set up' for a full answer window", async () => {
    // The short window above is for a gateway that could not be ASKED. A
    // gateway that answered, and whose payload simply has no WhatsApp entry,
    // has told the truth about a box the owner never configured — the common
    // case, and the one that must not pay a cold start five times as often as
    // a configured box just because both render as `not_configured`.
    vi.useFakeTimers({ toFake: ["Date"] });
    accountRow = null;
    expect((await (await GET()).json()).state).toBe("not_configured");

    vi.setSystemTime(Date.now() + 4_000);
    expect((await (await GET()).json()).state).toBe("not_configured");
    expect(statusStarts).toBe(1);

    vi.setSystemTime(Date.now() + 12_000);
    await GET();
    expect(statusStarts).toBe(2);
  });
});
