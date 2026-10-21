// What the guided channel routes (/setup-api/slack/*, …) share.
//
// Each channel's configure route differs only in how it checks its own
// credential and what it writes; what happens around that is the Discord
// route's contract, kept in one place so the channels cannot drift apart:
//
//   1. check the credential with the service itself, before anything is
//      written (a save that skipped it reports success for a bot that never
//      logs in);
//   2. on OpenClaw, install the official channel plugin BEFORE the config
//      write — `plugins install` rewrites the same openclaw.json;
//   3. write the credential the harness-native way, restart the gateway;
//   4. on OpenClaw, ask the gateway whether the channel actually came up, and
//      let `success` mean "reachable", not "the files were written".
//
// Access is the harnesses' own DM pairing on both editions: an unknown sender
// gets a one-time code, the owner approves it in Settings. ClawBox never writes
// an open DM policy or an allow-everyone switch.

import {
  GatewayNotReadyError,
  approveChannelPairing,
  restartGateway,
} from "@/lib/openclaw-config";
import {
  type ChannelPluginFailure,
  type ChannelStatus,
  invalidateChannelStatus,
  readCachedChannelStatus,
  waitForChannelConnected,
} from "@/lib/openclaw-channels";
import {
  type HermesChannelApproval,
  type HermesGatewaySnapshot,
  approveHermesChannelPairing,
  ensureHermesGateway,
  hermesGatewayStatus,
  hermesPlatformRegistered,
  readHermesGatewaySnapshot,
} from "@/lib/hermes-channels";
import type { Harness } from "@/lib/harness";

/** The channels this module serves, by ClawBox's (and OpenClaw's) id. */
export type GuidedChannelId = "slack" | "signal" | "msteams";

interface GuidedChannelSpec {
  /** OpenClaw's id: the config key's, the plugin's and the CLI's. */
  openclawId: string;
  /** Hermes' platform id for the same channel. */
  hermesPlatform: string;
  /**
   * "socket": the box dials out, and the gateway's `connected` is the truth.
   * "webhook": the service delivers to the box, so the most the box can know
   * is that it is LISTENING — whether the service reaches it is not visible
   * from here, and is never reported as connected.
   */
  transport: "socket" | "webhook";
}

export const GUIDED_CHANNELS: Readonly<Record<GuidedChannelId, GuidedChannelSpec>> = Object.freeze({
  slack: { openclawId: "slack", hermesPlatform: "slack", transport: "socket" },
  signal: { openclawId: "signal", hermesPlatform: "signal", transport: "socket" },
  // Hermes ships Teams as its bundled `teams` platform plugin.
  msteams: { openclawId: "msteams", hermesPlatform: "teams", transport: "webhook" },
});

/**
 * How many times to ask the gateway whether the channel came up, and how long
 * to wait between asks — the Discord route's budget (each probe pays the CLI's
 * cold start, so this is roughly a minute of wall clock).
 */
export const CHANNEL_VERIFY_ATTEMPTS = 5;
export const CHANNEL_VERIFY_DELAY_MS = 3_000;

/** Blocking reasons a save can return; any of them means "not reachable". */
export type ChannelSaveCode =
  | "plugin_install_failed"
  | "plugin_install_timeout"
  | "token_unresolved"
  | "channel_unverified"
  | "not_connected"
  | "restart_pending";

/**
 * Text of an error with every secret cut out of it — the backstop for a
 * harness path that some day quotes its argv in an error. A credential in the
 * journal is a live credential on disk, and this repo is public.
 */
export function scrubSecrets(err: unknown, secrets: readonly string[]): string {
  let text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text;
}

function pluginCode(reason: ChannelPluginFailure): ChannelSaveCode {
  return reason === "install_timeout" ? "plugin_install_timeout" : "plugin_install_failed";
}

/**
 * The gateway's own view of the channel, worst first. `null` from the probe is
 * UNKNOWN, never "fine".
 */
function liveCode(status: ChannelStatus | null, transport: GuidedChannelSpec["transport"]): ChannelSaveCode | undefined {
  if (!status) return "channel_unverified";
  if (status.tokenStatus === "configured_unavailable") return "token_unresolved";
  if (transport === "webhook") return status.running && !status.lastError ? undefined : "not_connected";
  if (!status.connected) return "not_connected";
  return undefined;
}

/**
 * Restart the harness' gateway so a just-saved channel is served; report
 * rather than throw when it will not.
 *
 * No abort signal on purpose: callers reach this after their durable writes,
 * and a browser that went away must not cancel the half that makes them live.
 * A gateway still binding (GatewayNotReadyError) is a landed restart — the
 * live check that follows settles whether the channel is up.
 */
export async function applyChannelRestart(
  harness: Harness,
  secrets: readonly string[],
  logTag: string,
): Promise<boolean> {
  try {
    if (harness === "hermes") {
      const status = await ensureHermesGateway();
      // A refused restart leaves the previous process up, and the unprivileged
      // status probe cannot tell the two apart — so require both.
      return status.running && status.applied;
    }
    await restartGateway();
    return true;
  } catch (err) {
    if (err instanceof GatewayNotReadyError) return true;
    console.error(`[${logTag}] gateway restart failed:`, scrubSecrets(err, secrets));
    return false;
  }
}

/**
 * After the writes and the restart: the blocking reason, if any, worst first.
 *
 * A plugin that never installed explains everything below it, and "restart
 * pending" explains a channel that is not up; only when both are fine is the
 * gateway's own verdict the answer. On Hermes there is no CLI to ask here —
 * its status route reads the gateway's own snapshot — so only an unapplied
 * restart blocks.
 *
 * Either way the status memos for the channel are dropped on the way out: the
 * credential, the plugin and the gateway all changed, so anything remembered —
 * including a poll that ran mid-restart — describes the box before the save,
 * and the panel re-reads the card the moment this response lands.
 */
export async function settleChannelSave(
  harness: Harness,
  channel: GuidedChannelId,
  restarted: boolean,
  installFailure: ChannelPluginFailure | null,
): Promise<ChannelSaveCode | undefined> {
  const spec = GUIDED_CHANNELS[channel];
  if (harness === "hermes") {
    invalidateGuidedRegistered(channel);
    return restarted ? undefined : "restart_pending";
  }
  try {
    if (installFailure) return pluginCode(installFailure);
    if (!restarted) return "restart_pending";
    const live = await waitForChannelConnected(spec.openclawId, {
      attempts: CHANNEL_VERIFY_ATTEMPTS,
      delayMs: CHANNEL_VERIFY_DELAY_MS,
    });
    return liveCode(live, spec.transport);
  } finally {
    invalidateChannelStatus(spec.openclawId);
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * The states a guided channel card renders; `null` is "could not ask".
 * "listening" is a webhook channel whose gateway is up and error-free — all
 * the box can know about a service that delivers to it.
 */
export type GuidedChannelState = "connected" | "listening" | "offline";

/** An OpenClaw channel row, in the card's vocabulary. */
export function mapOpenclawGuidedState(
  status: ChannelStatus,
  transport: GuidedChannelSpec["transport"] = "socket",
): GuidedChannelState {
  // `running` alone was satisfied by a process in a restart loop.
  if (!status.running) return "offline";
  if (transport === "webhook") return status.lastError ? "offline" : "listening";
  return status.connected ? "connected" : "offline";
}

/** True only for a channel that is genuinely up; null where nobody can tell. */
function receivingOf(state: GuidedChannelState | null): boolean | null {
  if (state === null || state === "listening") return null;
  return state === "connected";
}

/** Hermes' gateway snapshot for one platform, in the card's vocabulary. */
export function mapHermesGuidedState(
  gatewayRunning: boolean,
  snapshot: HermesGatewaySnapshot,
  transport: GuidedChannelSpec["transport"] = "socket",
): GuidedChannelState {
  if (!gatewayRunning) return "offline";
  // A snapshot left behind by a gateway that is no longer the running one.
  if (snapshot.gatewayState !== null && snapshot.gatewayState !== "running") return "offline";
  const up = snapshot.platform?.state === "connected";
  // Hermes' "connected" for a webhook platform is its own listener being up:
  // whether the service reaches it is still unknown, as on OpenClaw.
  if (transport === "webhook") return up ? "listening" : "offline";
  return up ? "connected" : "offline";
}

export interface GuidedChannelLiveStatus {
  /** Hermes said it has no such platform → false; otherwise the stored credential stands. */
  configured: boolean;
  /** Whether the answer came from the harness, or from the stored credential alone. */
  verified: boolean;
  state: GuidedChannelState | null;
  /** True only when the channel is genuinely up; `null` when nobody could be asked. */
  receiving: boolean | null;
  /** OpenClaw could not resolve the env SecretRef (the env file never loaded). */
  tokenUnresolved: boolean;
}

// `send --list <platform>` costs a CLI start, so its answer is memoised per
// platform: 15 s when Hermes answered, 3 s when it could not be asked — the
// Discord status route's split, so Retry is never a dead press.
const REGISTERED_TTL_MS = 15_000;
const REGISTERED_FAILURE_TTL_MS = 3_000;
const registeredMemo = new Map<string, { value: boolean | null; at: number }>();
const registeredInFlight = new Map<string, Promise<boolean | null>>();

function probeRegistered(platform: string): Promise<boolean | null> {
  const memo = registeredMemo.get(platform);
  if (memo) {
    const ttl = memo.value === null ? REGISTERED_FAILURE_TTL_MS : REGISTERED_TTL_MS;
    const age = Date.now() - memo.at;
    if (age >= 0 && age < ttl) return Promise.resolve(memo.value);
  }
  const existing = registeredInFlight.get(platform);
  if (existing) return existing;
  const pending = hermesPlatformRegistered(platform)
    .then((value) => {
      registeredMemo.set(platform, { value, at: Date.now() });
      return value;
    })
    .finally(() => registeredInFlight.delete(platform));
  registeredInFlight.set(platform, pending);
  return pending;
}

/** Forget what Hermes said about a platform — a save just changed the answer. */
export function invalidateGuidedRegistered(channel: GuidedChannelId): void {
  registeredMemo.delete(GUIDED_CHANNELS[channel].hermesPlatform);
}

/**
 * What the active harness says about a channel whose credential is stored.
 *
 * OpenClaw: the shared `channels status` memo (one CLI start for every channel
 * at once). Hermes: `send --list`, `gateway status` and the gateway's own
 * per-platform snapshot — never just "a token is stored and a process is up".
 */
export async function readGuidedChannelStatus(
  harness: Harness,
  channel: GuidedChannelId,
): Promise<GuidedChannelLiveStatus> {
  const spec = GUIDED_CHANNELS[channel];
  if (harness === "hermes") {
    const [registered, gateway, snapshot] = await Promise.all([
      probeRegistered(spec.hermesPlatform),
      hermesGatewayStatus(),
      readHermesGatewaySnapshot(spec.hermesPlatform),
    ]);
    const configured = registered ?? true;
    const state = configured ? mapHermesGuidedState(gateway.running, snapshot, spec.transport) : "offline";
    return {
      configured,
      verified: registered !== null,
      state,
      receiving: gateway.answered === false ? null : receivingOf(state),
      tokenUnresolved: false,
    };
  }
  const row = await readCachedChannelStatus(spec.openclawId);
  const state = row ? mapOpenclawGuidedState(row, spec.transport) : null;
  return {
    configured: true,
    verified: row !== null,
    state,
    receiving: receivingOf(state),
    tokenUnresolved: row?.tokenStatus === "configured_unavailable",
  };
}

// ── Pairing ─────────────────────────────────────────────────────────────────

export class PairingCodeFormatError extends Error {
  constructor() {
    super("Invalid pairing code format");
    this.name = "PairingCodeFormatError";
  }
}

/**
 * Approve the DM pairing code a new sender got from the bot, on whichever
 * harness is active. Throws PairingCodeFormatError for a malformed code; any
 * other error means the harness refused it (unknown, expired, locked out).
 */
export async function approveGuidedPairing(
  harness: Harness,
  channel: GuidedChannelId,
  code: string,
): Promise<HermesChannelApproval> {
  const spec = GUIDED_CHANNELS[channel];
  try {
    if (harness === "hermes") return await approveHermesChannelPairing(spec.hermesPlatform, code);
    await approveChannelPairing(spec.openclawId, code);
    return {};
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid pairing code format") {
      throw new PairingCodeFormatError();
    }
    throw err;
  }
}
