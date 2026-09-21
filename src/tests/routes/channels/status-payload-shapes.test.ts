import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * TASK-671 — the un-filtered `channels status` payload says the SAME thing
 * about a channel as the filtered one.
 *
 * Swapping the memo from `--channel <id>` to one un-filtered read is only safe
 * if `rowFromPayload` reads the same row out of either shape; if the un-filtered
 * form stubbed a channel the filtered form omits, every memoised caller would
 * change what it reports on an un-configured box — the WhatsApp card would stop
 * saying "Not configured" and start offering a QR flow that cannot complete.
 *
 * So these are not invented fixtures. They are the two payloads captured
 * verbatim from the OpenClaw box (openclaw 2026.8.1) with the gateway up,
 * WhatsApp configured but never linked and Discord never configured — the exact
 * state that would expose the difference. The Telegram entries are left out
 * because that channel IS configured on that box and its rows are not this
 * test's subject.
 *
 * What the capture shows: the two payloads differ ONLY in which channels they
 * list. Every field of the channel they both name is identical.
 */

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: vi.fn(() => false),
  gatewayRestartGeneration: vi.fn(() => 0),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(async () => {}),
  spawnOpenclawCli: vi.fn(),
}));

import { spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);

/** `channelAccounts.whatsapp[0]`, identical in both captures. */
const WHATSAPP_ACCOUNT = {
  accountId: "default",
  enabled: true,
  lastStartAt: null,
  lastStopAt: null,
  restartPending: false,
  reconnectAttempts: 0,
  healthState: "stopped",
  lifecycle: "stopped",
  busy: false,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastConnectedAt: null,
  lastDisconnect: null,
  lastMessageAt: null,
  lastEventAt: null,
  lastRunActivityAt: null,
  configured: true,
  linked: false,
  running: false,
  stateReason: "not linked",
  lastError: null,
};

/** `channels.whatsapp`, identical in both captures. */
const WHATSAPP_CHANNEL = {
  configured: true,
  statusState: "not-linked",
  linked: false,
  authAgeMs: null,
  self: { e164: null, jid: null, lid: null },
  running: false,
  connected: false,
  lastConnectedAt: null,
  lastDisconnect: null,
  reconnectAttempts: 0,
  lastInboundAt: null,
  lastMessageAt: null,
  lastEventAt: null,
  busy: false,
  lastRunActivityAt: null,
  lastError: null,
  healthState: "stopped",
  lifecycle: "stopped",
};

/** Discord, never configured on that box — only the un-filtered read names it. */
const DISCORD_ACCOUNT = {
  accountId: "default",
  enabled: true,
  lastStartAt: null,
  lastStopAt: null,
  restartPending: false,
  reconnectAttempts: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
  tokenSource: "none",
  tokenStatus: "missing",
  lastConnectedAt: null,
  lastDisconnect: null,
  lastEventAt: null,
  configured: false,
  running: false,
  stateReason: "not configured",
  lastError: null,
};

const UNFILTERED = JSON.stringify({
  channelAccounts: { whatsapp: [WHATSAPP_ACCOUNT], discord: [DISCORD_ACCOUNT] },
  channels: {
    whatsapp: WHATSAPP_CHANNEL,
    discord: { configured: false, running: false, lastStartAt: null, lastStopAt: null, lastError: null, tokenSource: "none", lastProbeAt: null },
  },
});

const FILTERED_WHATSAPP = JSON.stringify({
  channelAccounts: { whatsapp: [WHATSAPP_ACCOUNT] },
  channels: { whatsapp: WHATSAPP_CHANNEL },
});

let channels: typeof import("@/lib/openclaw-channels");

async function loadWith(stdout: string) {
  vi.resetModules();
  vi.clearAllMocks();
  mockSpawn.mockImplementation(async (args: string[]) =>
    args[0] === "channels" && args[1] === "status" ? stdout : "{}",
  );
  channels = await import("@/lib/openclaw-channels");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the un-filtered payload reads the same as the filtered one", () => {
  it("gives WhatsApp byte-for-byte the row its own filtered read gives", async () => {
    await loadWith(UNFILTERED);
    const shared = await channels.readCachedChannelRow("whatsapp");

    await loadWith(FILTERED_WHATSAPP);
    const perChannel = await channels.readChannelRow("whatsapp");

    expect(shared).toEqual(perChannel);
    // And it is the ACCOUNT row, the only one carrying `linked` — the field
    // `readOpenclawWhatsappStatus` decides "is a device paired" from.
    expect(shared).toMatchObject({ configured: true, linked: false, stateReason: "not linked" });
  });

  it("parses the same status out of either payload", async () => {
    await loadWith(UNFILTERED);
    const shared = await channels.readCachedChannelStatus("whatsapp");

    await loadWith(FILTERED_WHATSAPP);
    const perChannel = await channels.readChannelStatus("whatsapp");

    expect(shared).toEqual(perChannel);
  });

  it("still reports a channel the gateway does not name at all as no row", async () => {
    // The invariant the memo's TTL split rests on: an ANSWERED payload that
    // does not mention a channel means that channel was never set up, and that
    // stands for a full window. `slack` is on no box here.
    await loadWith(UNFILTERED);
    expect(await channels.readCachedChannelRow("slack")).toBeNull();
    expect(await channels.readCachedChannelRowResult("slack")).toEqual({
      answered: true,
      row: null,
    });
  });

  it("reads Discord's un-configured row rather than inventing a configured one", async () => {
    // The other half of the same worry: a channel the un-filtered payload DOES
    // name must not read as configured just because it is present.
    await loadWith(UNFILTERED);
    expect(await channels.readCachedChannelRow("discord")).toMatchObject({
      configured: false,
      running: false,
      tokenStatus: "missing",
    });
  });
});
