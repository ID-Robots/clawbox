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

import {
  GatewayNotReadyError,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  spawnOpenclawCli,
} from "@/lib/openclaw-config";
import {
  ensureChannelPlugin,
  invalidateChannelStatus,
  readCachedChannelRowResult,
} from "@/lib/openclaw-channels";

/** OpenClaw's id for this channel — the plugin's, the config key's, the CLI's. */
export const WHATSAPP_CHANNEL_ID = "whatsapp";

/**
 * Is `channels.whatsapp.enabled` the thing standing in the way?
 *
 * EXPLICITLY false, never "not true": an absent key is a box that has never
 * configured the channel, which `/whatsapp/configure` owns and which this must
 * not decide for. An unreadable config answers false as well — the repair then
 * writes nothing and the restart below is still attempted, which is the same
 * outcome every core before 2026.9.1 had.
 */
async function whatsappChannelExplicitlyDisabled(): Promise<boolean> {
  try {
    const config = await readConfig();
    const channels = config.channels as Record<string, { enabled?: unknown }> | undefined;
    return channels?.[WHATSAPP_CHANNEL_ID]?.enabled === false;
  } catch {
    return false;
  }
}

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

/**
 * How many times `web.login.start` may be asked while the gateway is still
 * coming back from the reload, and how long to leave between the attempts.
 *
 * `restartGateway` gives up on its readiness wait after its own budget and says
 * so; a Jetson that has just spent three minutes on an npm install can take
 * longer than that to bind. One immediate shot at a port nobody is listening on
 * is not a verdict on the repair — it is a connection error reported to the
 * owner as "something went wrong" over a plugin that is installed and about to
 * work, and the Retry that follows succeeds. That is the false-failure shape.
 *
 * Only ever spent after a reload that said it had not finished: a refusal is an
 * ANSWER and ends the loop at once, so a box with no plugin never waits here.
 */
const GATEWAY_CATCHUP_ATTEMPTS = 3;
const GATEWAY_CATCHUP_GAP_MS = 5_000;

/**
 * How long a repair that was refused may answer for the box.
 *
 * The refusal is real and worth remembering — it is what stops Retry bouncing
 * the gateway once per press — but it is a MEASUREMENT of a box that people
 * change, and a verdict kept for the life of the web server is a box that can
 * never be repaired from its own panel: "a capability probed once and treated as
 * fact for the process lifetime" is the exact shape this codebase keeps
 * producing.
 *
 * BE PRECISE ABOUT WHAT THE WINDOW BUYS, because it is narrower than it looks.
 * Every press already begins with a bare `web.login.start` before any remedy,
 * and a login that starts clears this outright — so an owner who fixed the
 * plugin by hand AND bounced the gateway is served on the next press with no
 * window involved. The one case it unlocks is "the plugin on disk is now right
 * and the gateway has not been reloaded since", where the reload is the only
 * thing left to do and this remedy is the only thing on the box that does it
 * from the panel.
 *
 * AND WHAT IT COSTS: on a box where the plugin genuinely cannot load, an owner
 * who keeps pressing pays one gateway restart per window — every other channel
 * and every open session dropped. Half an hour is the compromise: at most two of
 * those an hour against a press-by-press bounce on one side and a box that can
 * only be repaired by restarting the web server on the other.
 *
 * The window runs from the refusal and is deliberately not extended by a press
 * it suppressed — a sliding window would make frequent pressing permanent again,
 * which is the bug this replaced.
 */
const REPAIR_REFUSAL_TTL_MS = 30 * 60_000;

/** What the repair answers: a code to report, or what it managed to do. */
type RepairOutcome =
  | { ok: false; error: WhatsappPairErrorCode }
  | {
      ok: true;
      /** The gateway was actually bounced, so it has had a chance to load the plugin. */
      reloaded: boolean;
      /** It was bounced AND had finished binding when we stopped waiting. */
      gatewayReady: boolean;
    };

/**
 * What this manager may put in `snapshot.error`.
 *
 * The panel maps each of these to a sentence, so the set is a contract rather
 * than free text: `plugin_missing` shares its wording with the Hermes manager's
 * `bridge_missing` ("no WhatsApp bridge on this ClawBox"), `install_failed` is
 * the one that says to check the network, and `start_failed` is the generic
 * tail. A code the panel does not know falls through to that tail, which is how
 * `plugin_missing` used to reach the owner as "something went wrong".
 */
export type WhatsappPairErrorCode = "plugin_missing" | "install_failed" | "start_failed";

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
  error: WhatsappPairErrorCode | null;
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
    {
      captureStdout: true,
      timeoutMs: RPC_SPAWN_TIMEOUT_MS,
      // `spawnOpenclaw` names the process by `labelArgs ?? args` when it builds
      // an error message, and `web.login.wait` carries `currentQrDataUrl` in its
      // params. Without this, one spawn timeout writes live pairing material
      // into the journal — which is exactly what /whatsapp/pair documents can
      // never happen ("neither is ever logged").
      labelArgs: ["gateway", "call", method, "--params", "<json>", "--json"],
    },
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
 * is not loaded, and the one failure on this path that has a remedy rather than
 * a message. `respondProviderUnavailable` in the core's web-login RPC sends it
 * whenever `resolveWebLoginProvider()` finds nothing, and appends its own
 * install hint ONLY for a channel already present in `config.channels` — which
 * a box that has never saved the channel is not, so what arrives is the bare
 * sentence. Either way the fix is the same one OpenClaw would print: install
 * the plugin and reload the gateway. See repairWebLoginProvider().
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
  /** The plugin install in flight, shared by every start that is waiting on it. */
  private repairing: Promise<RepairOutcome> | null = null;
  /**
   * When the repair last ran, reloaded the gateway, and was still refused.
   *
   * A TIME, not a flag, and the difference is the whole point: this is what was
   * MEASURED a moment ago, never a fact about the box. It keeps Retry from
   * reinstalling and bouncing the device once per press while the answer is
   * fresh; past {@link REPAIR_REFUSAL_TTL_MS} the box may have been changed
   * under us and the press is owed a real attempt. Cleared outright the moment
   * a login actually starts.
   */
  private repairRefusedAt: number | null = null;
  /**
   * `startAfterReload` is asking a gateway that has not finished coming back.
   *
   * Read by the keepalive, which would otherwise spend that whole window — up to
   * ~115 s, entered precisely because the port is known not to answer — firing a
   * `web.login.wait` every tick, each a 10-12 s CLI cold start certain to fail,
   * competing for a Jetson that has just finished an npm install. The reap still
   * runs: a panel that closed mid-catch-up must still end the session.
   */
  private catchingUp = false;
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
    // A second panel pressing the button during an install would otherwise
    // rewrite the phase back to `starting` — the first panel's poller then reads
    // "Starting the bridge…" with minutes of npm still to run — and spend a
    // whole `web.login.start` budget on a call certain to be refused.
    if (this.snap.phase === "preparing" && !opts.force) return this.peek();

    this.epoch += 1;
    const epoch = this.epoch;
    this.snap = { ...IDLE, phase: "starting", startedAt: this.now() };
    this.ensureTicking();

    let repaired = false;
    try {
      let result: Record<string, unknown>;
      try {
        result = await this.loginStart(opts.force === true);
      } catch (err) {
        if (!isProviderMissing(err)) throw err;
        if (epoch !== this.epoch) return this.peek();
        // Installed and reloaded moments ago, and the gateway still has no
        // provider: a second npm install and a second gateway bounce cannot
        // change that inside the window. Without this the red box's own Retry
        // button restarts the whole device on every press — Telegram, the agent
        // and every open session with it — since `restartGateway` clears the
        // unit's start-limit before each restart and nothing downstream would
        // stop that loop either.
        if (this.repairSuppressed()) {
          this.snap = { ...this.snap, phase: "error", error: "plugin_missing" };
          return this.peek();
        }
        // The gateway named the one failure that has a remedy. Run it and ask
        // again, rather than handing the owner a red box over a plugin this
        // device can install for itself.
        this.snap = { ...this.snap, phase: "preparing" };
        const repair = await this.repairWebLoginProvider();
        if (epoch !== this.epoch) return this.peek();
        if (!repair.ok) {
          this.snap = { ...this.snap, phase: "error", error: repair.error };
          return this.peek();
        }
        // Only a repair that actually bounced the gateway may latch a refusal
        // below: one that skipped the reload has not given the plugin its
        // chance, and answering `plugin_missing` for the rest of the process
        // over that would be a verdict we never earned.
        repaired = repair.reloaded;
        // The caller has been blocked on this POST for the whole install, so
        // the panel is demonstrably still open. Without this the first tick
        // after an install longer than REAP_AFTER_MS reaps the login start() is
        // about to return — the owner waits two minutes and gets the "Link your
        // phone" button back, with no QR and nothing saying why.
        this.lastPollAt = this.now();
        this.snap = { ...this.snap, phase: "starting" };
        this.catchingUp = true;
        try {
          result = await this.startAfterReload(opts.force === true, epoch, repair.gatewayReady);
        } finally {
          this.catchingUp = false;
        }
      }
      if (epoch !== this.epoch) return this.peek();
      // A login that started is proof the provider is there, whatever an
      // earlier attempt in this process concluded.
      this.repairRefusedAt = null;
      this.apply(result);
    } catch (err) {
      if (epoch !== this.epoch) return this.peek();
      const missing = isProviderMissing(err);
      // Refused again, after the plugin was installed and the gateway reloaded:
      // this box has no WhatsApp bridge as it stands, and the presses that
      // follow are answered from that rather than repeating the remedy.
      if (missing && repaired) this.repairRefusedAt = this.now();
      this.snap = {
        ...this.snap,
        phase: "error",
        error: missing ? "plugin_missing" : "start_failed",
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

  /** Is the last refusal still recent enough to answer with? */
  private repairSuppressed(): boolean {
    return (
      this.repairRefusedAt !== null &&
      this.now() - this.repairRefusedAt < REPAIR_REFUSAL_TTL_MS
    );
  }

  /** One `web.login.start`, with the budgets this module owes it. */
  private loginStart(force: boolean): Promise<Record<string, unknown>> {
    return gatewayCall(
      "web.login.start",
      { force, timeoutMs: LOGIN_START_MS },
      LOGIN_START_MS + RPC_HEADROOM_MS,
    );
  }

  /**
   * `web.login.start`, allowing for a gateway that is still coming back.
   *
   * A refusal ends the loop immediately: that is the gateway ANSWERING, and no
   * amount of waiting turns a missing provider into a present one.
   */
  private async startAfterReload(
    force: boolean,
    epoch: number,
    gatewayReady: boolean,
  ): Promise<Record<string, unknown>> {
    const attempts = gatewayReady ? 1 : GATEWAY_CATCHUP_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
      // Checked BEFORE every call, not only after one fails: this loop sleeps
      // between attempts, and `stop()` or a newer `start()` lands inside that
      // sleep. `web.login.start` is not a read — it stops the running channel to
      // take the socket over, and with `force` it would tear down a login a
      // later press has just begun — so waking up to issue one starts a login in
      // the gateway AFTER the owner cancelled, with the answer discarded here
      // and nothing on this side that will ever mention it again. Cancelling
      // tells the gateway nothing (there is no `web.login.stop`: `stop()` drops
      // local state and the plugin's own TTL is what ends an abandoned login, the
      // one real difference from the Hermes path, which kills its bridge), so the
      // only way not to leave one behind is not to start it. The caller discards
      // a stale epoch before it reads this error, so it never reaches the panel.
      if (epoch !== this.epoch) throw new Error("the pairing session was replaced");
      try {
        return await this.loginStart(force);
      } catch (err) {
        if (attempt >= attempts || isProviderMissing(err) || epoch !== this.epoch) throw err;
        console.warn(
          "[openclaw-whatsapp] the gateway has not finished coming back; asking again",
        );
        await new Promise((resolve) => setTimeout(resolve, GATEWAY_CATCHUP_GAP_MS));
      }
    }
  }

  /**
   * Put the WhatsApp plugin in service, on the gateway's own say-so.
   *
   * WHY THIS LIVES ON THE PAIRING PATH. `@openclaw/whatsapp` is an npm plugin
   * OpenClaw's stock extensions do not carry, and the only thing that installed
   * it was /whatsapp/configure — whose Enable toggle the panel keeps disabled
   * until a phone is paired, because on Hermes enabling a channel with no
   * creds.json is meaningless. On OpenClaw the order is the other way round, so
   * the two rules met in the middle: pairing wanted the plugin, the plugin
   * wanted the save, the save wanted a pairing, and "Link your phone" was the
   * only button on the card. The Hermes manager closes exactly this gap for its
   * own bridge in `preparing`, by running the wizard's npm install itself; this
   * is that step for the harness whose installer is `openclaw plugins`.
   *
   * Entered only from the gateway's refusal, and at most once per refusal
   * window (see `repairRefusedAt`), so a healthy box pays nothing — not an extra
   * `plugins list`, and above all not a gateway restart, which would drop every
   * other channel mid-conversation.
   *
   * IT WRITES `channels.whatsapp.enabled` ONLY WHEN THAT KEY IS WHAT BLOCKS THE
   * LOAD, which is a rule that changed under us with the 2026.9.3 pin — see the
   * measurement two paragraphs down. On 2026.8.1 it wrote the key never, on the
   * reasoning recorded here:
   *
   *     resolveWebLoginProvider = () => listChannelPlugins().find(p =>
   *       [...p.gatewayMethods ?? [], ...(p.gatewayMethodDescriptors ?? [])
   *         .map(d => d.name)].some(m => WEB_LOGIN_METHODS.has(m))) ?? null
   *
   * with `listChannelPlugins = () => listLoadedChannelPlugins()`. The question is
   * "is a LOADED plugin publishing `web.login.*`" and nothing in it reads
   * `config.channels`. So installing the plugin, writing `plugins.entries`, and
   * reloading the gateway is exactly the remedy, and enabling the channel is
   * still `/whatsapp/configure`'s job — the one the owner reaches after a phone
   * is linked.
   *
   * AND THAT IS NO LONGER THE WHOLE STORY, measured on 2026.9.3 against 2026.8.1
   * with the same config (TASK-788): 2026.9.1 "Configuration controls" stopped
   * LOADING a channel plugin whose `channels.<id>.enabled` is false. Same config,
   * both cores, `plugins.entries.<id>.enabled` true throughout:
   *
   *     channels.<id>.enabled = false
   *       2026.8.1  row: enabled true,  status loaded    → plugin loaded
   *       2026.9.3  row: enabled FALSE, status disabled  → plugin NOT loaded
   *
   * `/whatsapp/unpair` writes `channels.whatsapp.enabled = false`, and the panel
   * offers "Link your phone" without turning it back on — `/whatsapp/pair` never
   * touches that key. So on the new core the sequence that used to be harmless
   * (unpair, then re-link) IS the refusal: no loaded plugin publishes
   * `web.login.*`, the gateway refuses, and this repair is entered — where
   * installing an installed plugin, re-writing a `plugins.entries` that already
   * says true and bouncing the gateway changes nothing, because the key the core
   * now reads is the one nobody is writing. That is a loop the owner cannot see
   * the way out of, so "make the plugin loaded" has to include that key on a core
   * that gates loading on it.
   *
   * Only when it is explicitly `false`, and only from here: this is the one path
   * entered from a pairing the owner asked for and the gateway refused, so the
   * intent to have WhatsApp on is the owner's own. A healthy box reads the config
   * and writes nothing.
   */
  private repairWebLoginProvider(): Promise<RepairOutcome> {
    // Two panels — or one reopened while the first install is still running —
    // must not both drive `plugins install` into the same plugin store. Whoever
    // arrives second waits for the first one's answer instead of starting a
    // second npm install over it.
    this.repairing ??= this.installAndLoadPlugin().finally(() => {
      this.repairing = null;
    });
    return this.repairing;
  }

  /**
   * The repair itself: install, enable, reload — the half that touches the box.
   *
   * Split from `repairWebLoginProvider` so that the in-flight guard there wraps
   * exactly one body, and never so that a caller can reach this directly: every
   * entry has to go through that guard, or two panels drive `plugins install`
   * into the same plugin store at once.
   *
   * Answers what it managed to do rather than a bare success, because the two
   * facts have different consequences upstream — `reloaded: false` must never
   * latch a `plugin_missing` verdict (the plugin was never given its chance),
   * and `gatewayReady: false` is what buys the retry its catch-up attempts.
   */
  private async installAndLoadPlugin(): Promise<RepairOutcome> {
    const plugin = await ensureChannelPlugin(WHATSAPP_CHANNEL_ID);
    if (!plugin.ok) {
      console.error(`[openclaw-whatsapp] installing the WhatsApp plugin failed: ${plugin.reason}`);
      // An npm install on a device is a download, and the panel already has the
      // true words for that one. `unsupported_channel` cannot happen for a
      // channel that is in OFFICIAL_CHANNEL_PLUGINS, and if it ever did it
      // would mean precisely that no plugin can be installed for it.
      //
      // `install_timeout` is folded in ON PURPOSE, unlike `/whatsapp/configure`,
      // which keeps it apart as `plugin_install_timeout`: there the owner typed a
      // save and can be told the download ran out of time, whereas the panel's
      // one sentence here — "could not download what the bridge needs, check the
      // network" — is already the right words for a download killed at its
      // deadline, and a fourth code would need eleven new locale strings to say
      // the same thing.
      return {
        ok: false,
        error: plugin.reason === "unsupported_channel" ? "plugin_missing" : "install_failed",
      };
    }
    // Nobody is pairing any more: the owner cancelled, or left the panel, and
    // the DELETE that reaped the session cannot reach the install already in
    // flight. The package is on disk, so the restart is not lost — it is what
    // the next start pays, with someone watching. Bouncing the gateway now
    // would drop the Telegram conversation the owner has gone back to, minutes
    // after the pairing card they closed.
    if (this.snap.phase !== "preparing" && this.snap.phase !== "starting") {
      return { ok: true, reloaded: false, gatewayReady: false };
    }
    // The key a core from 2026.9.1 on reads before it loads the plugin at all,
    // cleared here because the restart below is what would otherwise reload the
    // same unloadable plugin. READ first: on every box but the one that came
    // through `/whatsapp/unpair` this costs a file read and writes nothing.
    if (await whatsappChannelExplicitlyDisabled()) {
      try {
        await setOpenclawWhatsappEnabled(true);
      } catch (err) {
        // Said, not swallowed, and not fatal: the restart may still produce a
        // working bridge on an older core, where this key never gated loading.
        console.error("[openclaw-whatsapp] enabling channels.whatsapp before the reload failed:", err);
      }
    }
    let gatewayReady = true;
    try {
      // Installed is not loaded: `plugins install` prints "Restart the gateway
      // to load plugins", and the gateway is what publishes web.login.*.
      await restartGateway();
    } catch (err) {
      // A gateway that took the restart but has not finished binding is
      // starting, not broken — the caller asks again while it comes up rather
      // than calling a working repair a failure. Anything else is a restart
      // that did not happen, and calling that a missing bridge would blame the
      // plugin for a service failure.
      if (!(err instanceof GatewayNotReadyError)) {
        console.error("[openclaw-whatsapp] reloading the gateway after the plugin install failed:", err);
        return { ok: false, error: "start_failed" };
      }
      gatewayReady = false;
    }
    // The gateway now owns a channel it did not have, so a remembered row
    // describes the box as it was before this repair.
    invalidateChannelStatus(WHATSAPP_CHANNEL_ID);
    return { ok: true, reloaded: true, gatewayReady };
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
    // `preparing` is deliberately outside the watchdog: there is no login to
    // reap while npm runs, and the caller is still blocked on the POST that
    // started it. The keepalive window restarts when the install ends, which is
    // what stops the first tick afterwards from reaping a healthy login.
    if (this.snap.phase !== "waiting" && this.snap.phase !== "starting") {
      // `preparing` keeps the interval, because the phase goes back to
      // `starting` when the install ends and the keepalive is what carries it
      // from there. A TERMINAL phase does not: an `error` or `paired` snapshot
      // would otherwise wake this every TICK_MS for the life of the web server
      // only to return here, and on a box that cannot be repaired the error
      // paths are now the expected outcome. A later `start()` re-arms it.
      if (this.snap.phase !== "preparing") this.clearTicking();
      return;
    }
    if (this.now() - this.lastPollAt > REAP_AFTER_MS) {
      this.stop();
      return;
    }
    // Deliberately after the reap and before the RPC: the catch-up loop already
    // owns the conversation with a gateway that is not listening yet, and a
    // second caller asking it the same question cannot help. See `catchingUp`.
    if (this.catchingUp) return;

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
  /**
   * Whether the gateway actually ANSWERED.
   *
   * `state: "not_configured"` is returned both when the gateway says there is
   * no such channel and when the gateway could not be asked at all. Those are
   * not the same claim, and a caller that cannot tell them apart draws "Not
   * configured" over a paired phone whenever the gateway is restarting.
   */
  verified: boolean;
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
  // The RESULT form, not the row: a null row means both "the gateway answered
  // and there is no such channel" and "the gateway could not be asked", and
  // reporting the second as the first is the false failure this reader feeds.
  const { answered, row } = await readCachedChannelRowResult(WHATSAPP_CHANNEL_ID);
  if (!row) {
    // Reported as not_configured because that is the only thing the panel can
    // offer an action for. `verified` carries the distinction the row alone
    // cannot: the gateway ANSWERING "there is no such channel" is a real fact
    // about an unconfigured box, and only a gateway that could not be asked is
    // unverified.
    return {
      state: "not_configured",
      enabled: false,
      paired: false,
      connected: false,
      verified: answered,
    };
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
    verified: true,
  };
}

/**
 * Turn `channels.whatsapp` on or off, leaving every other key alone.
 *
 * Through `runOpenclawConfigSet`, not a bare spawn: this is a config WRITE, so
 * it owes the same conflict retry and the same read-back after a kill as every
 * other one. On its own spawn the CLI could be SIGKILLed at 45 s having already
 * written the key, and the owner was told the save failed over a channel that
 * is now enabled.
 */
export async function setOpenclawWhatsappEnabled(enabled: boolean): Promise<void> {
  await runOpenclawConfigSet(["channels.whatsapp.enabled", String(enabled), "--json"], {
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
