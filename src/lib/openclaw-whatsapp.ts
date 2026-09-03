// WhatsApp on the OpenClaw harness.
//
// WHAT CHANGED SINCE "WHATSAPP IS HERMES-ONLY"
//
// /whatsapp/status used to say, correctly for its time:
//
//     OpenClaw documents a WhatsApp channel, but it is a separately-installed
//     plugin whose only login path is an interactive QR command, and none of it
//     is verifiable from a ClawBox build.
//
// The first half is still true — `@openclaw/whatsapp` is an npm plugin, and
// `openclaw channels login --channel whatsapp` renders ASCII art to a TTY. The
// second half is not. The plugin also exposes `loginWithQrStart` and
// `loginWithQrWait` on its channel API; the gateway publishes those as the
// `web.login.start` / `web.login.wait` RPC methods; and `openclaw gateway call`
// invokes any gateway method non-interactively. So the panel can drive the real
// pairing flow and get a PNG data URL back, with no PTY and no reimplementation
// of Baileys.
//
// This is the same argument the Hermes bridge's header makes about
// `hermes whatsapp`: the WIZARD needs a terminal, the PAIRING does not.
//
// WHY THIS LOOKS DIFFERENT FROM whatsapp-pairing.ts
//
// The Hermes path owns a Baileys process: it spawns the bridge, parses its
// JSON lines, restarts it when it dies, and reaps it when the panel stops
// polling. Here the GATEWAY owns the login. The plugin keeps its own active
// login (with its own TTL and QR rotation), so this module holds no child
// process at all — only the latest snapshot and a keepalive, so that a GET is
// a cheap read rather than a 10-second CLI cold start.
//
// NO SecretRef, deliberately. WhatsApp Web authenticates with stored linked-
// device credentials in the plugin's auth dir, not a bot token, so there is no
// env-backed credential here and nothing for envSecretRef() to mint.

import { spawnOpenclawCli } from "@/lib/openclaw-config";
import { invalidateChannelStatus, readCachedChannelRow } from "@/lib/openclaw-channels";

/** OpenClaw's id for this channel — the plugin's, the config key's, the CLI's. */
export const WHATSAPP_CHANNEL_ID = "whatsapp";

/** Stop the login this long after the last status poll, exactly like the Hermes manager. */
export const REAP_AFTER_MS = 60_000;
/** How often the keepalive watchdog runs. */
export const TICK_MS = 5_000;

/**
 * Budget for one `gateway call`.
 *
 * `web.login.wait` BLOCKS until the QR rotates or the login completes, so its
 * own `timeoutMs` param is what bounds it; this is the outer ceiling on the CLI
 * process, and has to be comfortably larger or we would kill a healthy wait.
 */
const RPC_SPAWN_TIMEOUT_MS = 90_000;
/** What we ask the gateway to wait for a QR rotation / scan before answering. */
const LOGIN_WAIT_MS = 25_000;
/** Bound on `web.login.start`, which returns as soon as there is a QR. */
const LOGIN_START_MS = 30_000;
/**
 * Headroom the RPC round trip gets over the method's own budget.
 *
 * `--timeout` bounds the transport; `params.timeoutMs` is how long the gateway
 * may spend producing the answer. Setting them equal is a race the caller
 * loses: `startWebLoginWithQr` is allowed the full window to produce the first
 * QR, and a transport deadline that expires in the same instant abandons the
 * call exactly as the answer is handed over — reported to the owner as
 * `start_failed` for a login that worked. A Jetson is precisely where that
 * window gets used up.
 */
const RPC_HEADROOM_MS = 5_000;

/** Phases, identical to the Hermes pairing manager's — one panel renders both. */
export type WhatsappPairPhase =
  | "idle"
  | "preparing"
  | "starting"
  | "waiting"
  | "scanned"
  | "paired"
  | "error";

export interface OpenclawWhatsappSnapshot {
  phase: WhatsappPairPhase;
  /**
   * Raw Baileys payload. Always null here: the plugin renders the QR itself
   * and hands back an image, so there is no payload to pass through. The field
   * stays in the shape because the Hermes path fills it and the panel reads
   * one snapshot type.
   */
  qr: string | null;
  /** PNG data URL, ready for an `<img src>`. */
  qrImage: string | null;
  qrIssuedAt: number | null;
  qrCount: number;
  restarts: number;
  user: { id: string | null; name: string | null } | null;
  gatewayRestartPending: boolean;
  /** Machine-readable reason, never a raw stack. */
  error: string | null;
  startedAt: number | null;
}

const IDLE: OpenclawWhatsappSnapshot = {
  phase: "idle",
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

/** What `web.login.start` / `web.login.wait` answer with. */
interface WebLoginResult {
  qrDataUrl?: unknown;
  connected?: unknown;
  message?: unknown;
}

/**
 * Call one gateway RPC method through the CLI.
 *
 * With `--json`, `openclaw gateway call` prints the method's RESULT OBJECT and
 * nothing else on success — there is no `ok` wrapper to unwrap and no `result`
 * key to reach through. On failure it writes an error payload and exits 1, so
 * the failure arrives here as a rejection from `spawnOpenclawCli` carrying that
 * text, which is what `isProviderMissing` matches against.
 *
 * The `ok === false` check below is therefore belt-and-braces for a build that
 * reports a refusal on exit 0, not the normal path.
 */
async function gatewayCall(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const out = await spawnOpenclawCli(
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(timeoutMs),
    ],
    { captureStdout: true, timeoutMs: RPC_SPAWN_TIMEOUT_MS },
  );
  const parsed: unknown = JSON.parse(out);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${method} returned no object`);
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.ok === false) {
    const error = payload.error as { message?: unknown; code?: unknown } | undefined;
    // The gateway's own words. Callers map this to a code; nothing renders it
    // raw, because it can name config paths.
    throw new Error(
      typeof error?.message === "string" ? error.message : `${method} failed`,
    );
  }
  return payload;
}

/**
 * A PNG data URL with an actual payload.
 *
 * The prefix alone is not enough: `"data:image/png;base64,"` is a well-formed
 * data URL for an empty image, and it would put a blank square on screen in the
 * `waiting` phase — a QR the owner cannot scan, with nothing saying why. The
 * base64 body is required, and its alphabet checked, because this string ends
 * up as an `<img src>` in the panel.
 */
const QR_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function readQrDataUrl(result: WebLoginResult): string | null {
  const value = result.qrDataUrl;
  // The schema the gateway validates against pins the prefix; re-checking the
  // whole shape here is what stops anything else reaching an <img src>.
  return typeof value === "string" && QR_DATA_URL_RE.test(value) ? value : null;
}

/**
 * "There is no WhatsApp login provider" — the gateway's answer when the plugin
 * is not loaded. Worth its own code: it is the one failure the owner fixes by
 * saving the channel again (which installs the plugin), not by rescanning.
 */
function isProviderMissing(err: unknown): boolean {
  return err instanceof Error && /login provider is not available/i.test(err.message);
}

/**
 * Drives `web.login.start` / `web.login.wait` and holds the latest snapshot.
 *
 * Mirrors WhatsappPairingManager's contract exactly — `start`/`poll`/`stop`,
 * the same phases, the same "polling is the liveness signal" rule — so the two
 * harnesses are interchangeable behind the routes.
 */
export class OpenclawWhatsappPairing {
  private snap: OpenclawWhatsappSnapshot = { ...IDLE };
  private lastPollAt = 0;
  private waiting = false;
  /**
   * Bumped every time a new login replaces the current one.
   *
   * `web.login.wait` can be in flight for tens of seconds, and `start({force})`
   * or `stop()` can land in the middle of it. Without this, the old wait's
   * answer — a QR for a session the gateway has already torn down — would be
   * written into the new snapshot, and the panel would show a code that can
   * never be scanned.
   */
  private epoch = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  peek(): OpenclawWhatsappSnapshot {
    return { ...this.snap };
  }

  /** Snapshot AND renew the keepalive. This is what the GET route calls. */
  poll(): OpenclawWhatsappSnapshot {
    this.lastPollAt = this.now();
    return { ...this.snap };
  }

  /**
   * Begin (or re-join) a login.
   *
   * Idempotent like the Hermes manager, and for a sharper reason here: the
   * gateway keeps ONE active login per account, and `web.login.start` stops the
   * running channel to take the socket over. A double-click must not do that
   * twice.
   */
  async start(opts: { force?: boolean } = {}): Promise<OpenclawWhatsappSnapshot> {
    this.lastPollAt = this.now();
    if (this.snap.phase === "paired" && !opts.force) return this.peek();
    if (this.snap.phase === "waiting" && !opts.force) return this.peek();

    this.epoch += 1;
    const epoch = this.epoch;
    this.snap = { ...IDLE, phase: "starting", startedAt: this.now() };
    this.ensureTicking();

    try {
      const result = await gatewayCall(
        "web.login.start",
        { force: opts.force === true, timeoutMs: LOGIN_START_MS },
        LOGIN_START_MS + RPC_HEADROOM_MS,
      );
      if (epoch !== this.epoch) return this.peek();
      this.apply(result);
    } catch (err) {
      if (epoch !== this.epoch) return this.peek();
      this.snap = {
        ...this.snap,
        phase: "error",
        error: isProviderMissing(err) ? "plugin_missing" : "start_failed",
      };
      console.error("[openclaw-whatsapp] login start failed:", err);
    }
    return this.peek();
  }

  stop(): OpenclawWhatsappSnapshot {
    // Bump first: a wait already in flight belongs to the session being ended,
    // and must not resurrect it by writing a QR into the idle snapshot.
    this.epoch += 1;
    this.clearTicking();
    this.snap = { ...IDLE };
    return this.peek();
  }

  /** Fold one RPC answer into the snapshot. */
  private apply(result: WebLoginResult): void {
    if (result.connected === true) {
      // THE pairing event. Until this instant the gateway's row said "not
      // linked", and a status poll one second later would otherwise repeat it
      // for the rest of the window while the owner looks at a paired phone.
      invalidateChannelStatus(WHATSAPP_CHANNEL_ID);
      this.snap = {
        ...this.snap,
        phase: "paired",
        qr: null,
        qrImage: null,
        // The channel is linked but the gateway has not been restarted around
        // it yet, so the panel is told rather than left to imply otherwise —
        // the same field the Hermes snapshot carries for the same reason.
        gatewayRestartPending: true,
        error: null,
      };
      return;
    }

    const qrImage = readQrDataUrl(result);
    if (!qrImage) {
      // No image and not connected: the login is alive but between codes.
      // Deliberately not an error — saying so would flash a failure at an owner
      // who is mid-scan.
      return;
    }
    const rotated = qrImage !== this.snap.qrImage;
    this.snap = {
      ...this.snap,
      phase: "waiting",
      qrImage,
      qrIssuedAt: rotated ? this.now() : this.snap.qrIssuedAt,
      qrCount: rotated ? this.snap.qrCount + 1 : this.snap.qrCount,
      error: null,
    };
  }

  private ensureTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    // Never hold the process open for a QR nobody is watching.
    this.tickTimer.unref?.();
  }

  private clearTicking(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /**
   * Keep the snapshot fresh while the panel is open.
   *
   * "Still polling" is the liveness signal, exactly as on Hermes: close the tab
   * and this stops within REAP_AFTER_MS, so a forgotten login is not calling
   * the gateway forever.
   */
  private async tick(): Promise<void> {
    if (this.waiting) return;
    if (this.snap.phase !== "waiting" && this.snap.phase !== "starting") return;
    if (this.now() - this.lastPollAt > REAP_AFTER_MS) {
      this.stop();
      return;
    }

    this.waiting = true;
    const epoch = this.epoch;
    try {
      const result = await gatewayCall(
        "web.login.wait",
        {
          timeoutMs: LOGIN_WAIT_MS,
          ...(this.snap.qrImage ? { currentQrDataUrl: this.snap.qrImage } : {}),
        },
        LOGIN_WAIT_MS + RPC_HEADROOM_MS,
      );
      // Discard an answer that belongs to a session which has since been
      // replaced or stopped.
      if (epoch === this.epoch) this.apply(result);
    } catch (err) {
      // A wait that failed is not a login that failed: the gateway may simply
      // have been busy. Keep the QR on screen and try again next tick, which is
      // what the Hermes manager's respawn loop achieves by other means.
      console.warn(
        "[openclaw-whatsapp] login wait failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.waiting = false;
    }
  }
}

let pairing: OpenclawWhatsappPairing | null = null;

/** Process-wide pairing session, mirroring getPairingManager() on Hermes. */
export function getOpenclawWhatsappPairing(): OpenclawWhatsappPairing {
  pairing ??= new OpenclawWhatsappPairing();
  return pairing;
}

/** Test seam — resets the module-level session. */
export function resetOpenclawWhatsappPairing(): void {
  pairing = null;
}

export interface OpenclawWhatsappStatus {
  state: "not_configured" | "enabled_not_paired" | "paired";
  enabled: boolean;
  /** A linked-device session exists. */
  paired: boolean;
  /** The gateway says the transport is up. */
  connected: boolean;
}

/**
 * What the gateway says about the WhatsApp channel.
 *
 * `paired` is derived from the gateway's own account row rather than from a
 * file under the plugin's auth dir: the dir layout is the plugin's private
 * business and reading it would be this repo guessing at another project's
 * internals. `configured` in that row means "there is an account the gateway
 * can act as", which is exactly the question.
 *
 * Read through the shared memo, because the panel POLLS this: the row costs a
 * CLI cold start, and every path in this file that changes the channel drops
 * the memo, so a poll can never repeat an answer the owner has already
 * overtaken.
 */
export async function readOpenclawWhatsappStatus(): Promise<OpenclawWhatsappStatus> {
  const row = await readCachedChannelRow(WHATSAPP_CHANNEL_ID);
  if (!row) {
    // Unknown, not "off". Reported as not_configured because that is the only
    // honest thing the panel can offer an action for, and the status card's
    // `receiving: false` says the rest.
    return { state: "not_configured", enabled: false, paired: false, connected: false };
  }

  // `linked` is the ONLY honest answer to "is a phone paired". `configured`
  // means "the gateway has an account entry for this channel", which becomes
  // true the moment the plugin loads and the channel is enabled — with nothing
  // scanned. Reading that as paired is exactly the lie this work removes; the
  // gateway says so itself alongside it, with `statusState: "not-linked"` and
  // `lastError: "not linked"`.
  const paired = row.linked === true;
  const connected = row.connected === true;
  // `configured` is deliberately NOT in this disjunction, and leaving it in was
  // the same mistake one field over. The plugin hardcodes it:
  //
  //   resolveAccountSnapshot: async ({ account, runtime }) => ({
  //     accountId, name, enabled: account.enabled,
  //     configured: true,                      // <- @openclaw/whatsapp 2026.7.1
  //     extra: { statusState: authState, linked, connected, ... },
  //   })
  //
  // and that snapshot IS the per-account row `channels status --json` publishes
  // (createAsyncComputedAccountStatusAdapter maps it onto the host's
  // `status.buildAccountSnapshot`). So `configured === true` on every WhatsApp
  // row there has ever been, including one the owner has just switched off —
  // which made this report the channel enabled, and the card "paired", for a
  // channel receiving nothing.
  //
  // `enabled` is the plugin's real answer (`account.enabled && cfg.web?.enabled
  // !== false`). `running` stays because a channel the gateway is actually
  // running is enabled whatever the config says; it is an observation, not a
  // constant.
  const enabled = row.enabled === true || row.running === true;

  return {
    state: !enabled ? "not_configured" : paired ? "paired" : "enabled_not_paired",
    enabled,
    paired,
    connected,
  };
}

/** Turn `channels.whatsapp` on or off, leaving every other key alone. */
export async function setOpenclawWhatsappEnabled(enabled: boolean): Promise<void> {
  await spawnOpenclawCli(["config", "set", "channels.whatsapp.enabled", String(enabled), "--json"], {
    timeoutMs: 45_000,
  });
  // `enabled` is half of what the status reads, so a remembered row is now a
  // statement about the config as it was before this call.
  invalidateChannelStatus(WHATSAPP_CHANNEL_ID);
}

/**
 * Drop the stored linked-device session.
 *
 * This removes the session from the ClawBox only. The linked-device entry on
 * the phone stays until the owner removes it in WhatsApp -> Linked Devices,
 * which is the honest thing to tell them rather than implying a remote revoke —
 * the same wording the Hermes unpair route already uses.
 */
export async function logoutOpenclawWhatsapp(): Promise<void> {
  await spawnOpenclawCli(["channels", "logout", "--channel", WHATSAPP_CHANNEL_ID], {
    timeoutMs: 60_000,
  });
  // The session this answered "linked" about is gone.
  invalidateChannelStatus(WHATSAPP_CHANNEL_ID);
}
