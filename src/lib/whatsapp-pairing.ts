// In-UI WhatsApp QR pairing.
//
// WHAT `hermes whatsapp` ACTUALLY DOES, AND WHY A ROUTE CAN DO IT TOO
//
// src/lib/hermes-whatsapp.ts says pairing is unreachable from a route handler
// because `hermes whatsapp` is a zero-flag TTY wizard. That is true of the
// *wizard*, and it is not true of the *pairing*. Reading hermes_cli/main.py
// `cmd_whatsapp` step 6, the wizard's entire contribution to pairing is one
// subprocess call:
//
//     node bridge.js --pair-only --session ~/.hermes/whatsapp/session
//
// Everything the TTY does around it is prompting for a mode and an allowlist —
// which the ClawBox panel already owns — and printing next steps.
//
// And the bridge does not require a TTY at all. scripts/whatsapp-bridge/
// bridge.js parses a second flag, `--pair-json`, which switches every pairing
// event from human output to one JSON object per line on stdout:
//
//     {"ts":…,"event":"started","session":"…"}
//     {"ts":…,"event":"qr","qr":"https://wa.me/settings/linked_devices#2@r+S+UAaO14iA…,cXuvu…,zbSBe…,TrmodF…,1"}
//     {"ts":…,"event":"disconnected","reason":515}
//     {"ts":…,"event":"connected","user":{"id":"…","name":"…"}}
//     {"ts":…,"event":"error","error":"logged_out","reason":401}
//
// `qr` carries the RAW payload Baileys emits — the same string qrcode-terminal
// renders as ASCII in the wizard. On this Baileys version it is a ~277-character
// `https://wa.me/settings/linked_devices#…` deep link whose fragment holds the
// five comma-separated pairing fields. So the UI can render a real QR from the
// real payload; nothing here screen-scrapes ASCII art, and no PTY is involved.
//
// THE TIMEOUT PROBLEM, WHICH IS THE ACTUAL FEATURE
//
// A WhatsApp QR payload is valid for ~60 s and Baileys gives up after a handful
// of refreshes, closing the socket. An owner who opens the panel and then walks
// to fetch their phone comes back to a dead code. Two layers keep that from
// ever being visible:
//
//   1. In-process rotation. Baileys re-emits `qr` on every refresh, and the
//      bridge's own reconnect scheduler restarts the socket after a non-fatal
//      close. Each new payload simply replaces the last one in the snapshot.
//   2. Process-level restart. When the bridge exits anyway (retries exhausted,
//      crash, logged_out), this manager respawns it — indefinitely, with no
//      attempt ceiling — for as long as the panel is still polling.
//
// "Still polling" is the liveness signal, and it is what bounds the process:
// every GET touches `lastPollAt`, and a reaper stops the bridge REAP_AFTER_MS
// after the last touch. Close the tab and the process is gone within a minute;
// leave the panel open for an hour and there is always a fresh QR on screen.
//
// SESSION LOCATION
//
// `~/.hermes/whatsapp/session`, byte-for-byte where `cmd_whatsapp` points the
// bridge (`get_hermes_home() / "whatsapp" / "session"`). The adapter resolves
// new-then-legacy and therefore reads it, and a box paired here is
// indistinguishable from a box paired at the terminal.

import { spawn } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { hermesHome } from "@/lib/hermes-env";
import { resolveWhatsappBridgeDir, whatsappBridgeDir, WHATSAPP_ENV_ENABLED } from "@/lib/hermes-whatsapp";
import { setHermesEnvValues } from "@/lib/hermes-env";

/** Stop the bridge this long after the last status poll. */
export const REAP_AFTER_MS = 60_000;
/** Delay before respawning a bridge that exited without pairing. */
export const RESTART_DELAY_MS = 2_000;
/**
 * Ceiling on the *delay* between respawns — never on the number of them.
 *
 * A bridge that dies before it can emit a QR (bad install, revoked session, a
 * Jetson under memory pressure) used to respawn every 2 s forever, which on
 * this hardware is a node process every two seconds for as long as the panel
 * is open. Backing the interval off preserves the promise the feature makes —
 * no attempt limit, no visible timeout — while making a broken box cost a
 * spawn every half minute instead of thirty a minute.
 */
export const RESTART_DELAY_MAX_MS = 30_000;
/** How often the reaper/restart watchdog runs. */
export const TICK_MS = 5_000;
/** npm install ceiling. A cold Baileys install on a Jetson is minutes, not seconds. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type WhatsappPairPhase =
  /** Nothing running. */
  | "idle"
  /** Installing the bridge's node_modules. */
  | "preparing"
  /** Bridge spawned, no QR on screen yet. */
  | "starting"
  /** A live QR payload is on screen. */
  | "waiting"
  /** The QR was scanned; WhatsApp is completing the link. */
  | "scanned"
  /** creds.json written; the channel is linked. */
  | "paired"
  /** Unrecoverable — the bridge itself is missing or its install failed. */
  | "error";

export interface WhatsappPairSnapshot {
  phase: WhatsappPairPhase;
  /** Raw Baileys payload for the client to render. null unless phase is "waiting". */
  qr: string | null;
  qrIssuedAt: number | null;
  /** Distinct QR payloads produced this session — the rotation counter. */
  qrCount: number;
  /** Bridge respawns this session. Proves auto-restart without exposing a timeout. */
  restarts: number;
  user: { id: string | null; name: string | null } | null;
  /** Machine-readable reason, never a raw stack. */
  error: string | null;
  startedAt: number | null;
}

/** One running bridge process, narrowed to what the manager needs. */
export interface BridgeProcessHandle {
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface PairingDeps {
  /** Absolute path to the bridge checkout. */
  bridgeDir(): string;
  /** Where creds.json must land — the CLI's own session directory. */
  sessionDir(): string;
  /** node_modules present? */
  bridgeInstalled(): Promise<boolean>;
  /** bridge.js present? Distinguishes "not a Hermes box" from "deps missing". */
  bridgeScriptExists(): Promise<boolean>;
  /** Run the dependency install the CLI runs. */
  install(): Promise<void>;
  /** creds.json present in the session directory? */
  credsExist(): Promise<boolean>;
  /** Delete the session directory's contents. */
  clearSession(): Promise<void>;
  /** Persist what step 7 of `cmd_whatsapp` persists on success. */
  markEnabled(): Promise<void>;
  spawnBridge(): BridgeProcessHandle;
  now(): number;
}

const IDLE: WhatsappPairSnapshot = {
  phase: "idle",
  qr: null,
  qrIssuedAt: null,
  qrCount: 0,
  restarts: 0,
  user: null,
  error: null,
  startedAt: null,
};

/**
 * WhatsApp requested a restart after a successful link. Baileys surfaces it as
 * an ordinary close, but it is the one disconnect reason that means "the scan
 * worked" — so it is what flips the panel to "connecting" instead of leaving
 * the owner staring at a QR they already used.
 */
const RESTART_REQUIRED = 515;

export class WhatsappPairingManager {
  private snap: WhatsappPairSnapshot = { ...IDLE };
  private deps: PairingDeps;
  private proc: BridgeProcessHandle | null = null;
  private lastPollAt = 0;
  private stdoutBuf = "";
  private starting = false;
  /** Set while stop() tears down, so the exit handler does not respawn. */
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Respawns since the last sign of progress. Drives the backoff, nothing else. */
  private consecutiveFailures = 0;
  /** WhatsApp revoked the stored session; the next launch must start blank. */
  private sessionRevoked = false;

  constructor(deps: PairingDeps) {
    this.deps = deps;
  }

  /** Snapshot without touching liveness — for callers that are not the poller. */
  peek(): WhatsappPairSnapshot {
    return { ...this.snap };
  }

  /** Snapshot AND renew the keepalive. This is what the GET route calls. */
  poll(): WhatsappPairSnapshot {
    this.lastPollAt = this.deps.now();
    return { ...this.snap };
  }

  /**
   * Begin (or re-join) a pairing session.
   *
   * Idempotent on purpose: a double-click, or a second browser tab, must not
   * spawn a second bridge against the same session directory — two Baileys
   * sockets sharing one auth folder corrupt each other's keys. A call while a
   * session is live just renews the keepalive and returns the same snapshot.
   */
  async start(opts: { force?: boolean } = {}): Promise<WhatsappPairSnapshot> {
    this.lastPollAt = this.deps.now();

    if (this.snap.phase === "paired" && !opts.force) return this.peek();
    if (this.starting || this.proc) return this.peek();

    // Claim the slot BEFORE the first await, not after it. Two POSTs that land
    // in the same tick both clear the guard above before either one yields, so
    // anything asynchronous between the guard and the flag lets every caller
    // through — and each of them spawns a bridge into the same auth directory,
    // which is precisely the key corruption the idempotence above exists to
    // prevent. The flag is released in the `finally` at the bottom, after
    // launch() has published this.proc, so the window never reopens.
    this.starting = true;
    this.stopping = false;

    try {
      if (!(await this.deps.bridgeScriptExists())) {
        this.snap = { ...IDLE, phase: "error", error: "bridge_missing" };
        return this.peek();
      }

      this.snap = { ...IDLE, phase: "preparing", startedAt: this.deps.now() };

      try {
        if (opts.force) {
          await this.deps.clearSession();
          this.sessionRevoked = false;
        }

        // Upstream installs the bridge's dependencies from the wizard rather
        // than vendoring them (cmd_whatsapp step 4: `npm install --no-fund
        // --no-audit --progress=false` in the bridge directory). A fresh box
        // therefore has no node_modules until someone pairs, which is exactly
        // the gap this flow has to close — so we run the same install, and the
        // panel shows "preparing" while it does.
        if (!(await this.deps.bridgeInstalled())) {
          await this.deps.install();
        }
      } catch (err) {
        this.snap = {
          ...this.snap,
          phase: "error",
          error: err instanceof Error && err.message === "install_failed" ? "install_failed" : "prepare_failed",
        };
        return this.peek();
      }

      this.consecutiveFailures = 0;
      await this.launch();
      return this.peek();
    } finally {
      this.starting = false;
    }
  }

  /** Spawn one bridge and wire its event stream. */
  private async launch(): Promise<void> {
    if (this.stopping) return;

    // A session directory with no creds.json holds only ephemeral pre-keys from
    // an attempt nobody completed. Clearing it guarantees the next spawn starts
    // a clean registration and produces a QR immediately, instead of resuming
    // half-state that can sit silent. Never clear once creds.json exists —
    // that is the pairing we were asked to protect — UNLESS WhatsApp has told
    // us the credentials are revoked, in which case keeping them only buys
    // another 401 on every respawn, forever.
    if (this.sessionRevoked || !(await this.deps.credsExist())) {
      if (this.stopping) return;
      await this.deps.clearSession();
      this.sessionRevoked = false;
    }
    if (this.stopping) return;

    this.stdoutBuf = "";
    this.snap = {
      ...this.snap,
      phase: "starting",
      qr: null,
      qrIssuedAt: null,
      error: null,
      // stop() resets the snapshot to IDLE. A launch already in flight when
      // that happened would otherwise go on to serve a live QR over a snapshot
      // whose startedAt is null — a state no reader can make sense of.
      startedAt: this.snap.startedAt ?? this.deps.now(),
    };

    const proc = this.deps.spawnBridge();

    // Every await above is a place a DELETE can land. stop() tore down
    // everything it could see, and this child did not exist yet, so handing it
    // to this.proc now would create a bridge nothing tracks, nothing reaps and
    // nothing can kill — it would just sit there holding a Baileys websocket
    // and writing pre-keys into the session directory the next attempt uses.
    if (this.stopping) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      this.snap = { ...IDLE };
      return;
    }

    this.proc = proc;
    // Identity guard, matching onExit's. A bridge we abandoned or replaced must
    // not keep rewriting the shared snapshot — and above all must not reach the
    // `connected` branch, which writes WHATSAPP_ENABLED=true.
    proc.onLine((line) => {
      if (this.proc !== proc) return;
      this.onStdout(line);
    });
    proc.onExit(() => this.onExit(proc));
    // Armed here rather than in start(): the restart path reaches launch()
    // through a timer, and a respawned bridge with no ticker behind it can
    // never be reaped.
    this.ensureTicker();
  }

  /** Split the raw stdout stream into lines. */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    const lines = this.stdoutBuf.split("\n");
    this.stdoutBuf = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") return;
    let event: { event?: unknown; qr?: unknown; reason?: unknown; error?: unknown; user?: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      // The bridge's reconnect scheduler and version resolver both log plain
      // text through console.log even in --pair-json mode. Non-JSON on this
      // stream is normal and must never abort the session.
      return;
    }
    this.handleEvent(event);
  }

  /** Exposed for tests: apply one already-parsed bridge event. */
  handleEvent(event: { event?: unknown; qr?: unknown; reason?: unknown; error?: unknown; user?: unknown }): void {
    switch (event.event) {
      case "started":
        if (this.snap.phase !== "waiting") this.snap = { ...this.snap, phase: "starting" };
        return;

      case "qr": {
        if (typeof event.qr !== "string" || !event.qr) return;
        // Rotation is just this: the newest payload wins, and the counter
        // records that it moved. No expiry timer, no user-visible countdown.
        this.snap = {
          ...this.snap,
          phase: "waiting",
          qr: event.qr,
          qrIssuedAt: this.deps.now(),
          qrCount: this.snap.qrCount + 1,
          error: null,
        };
        // A QR on screen is the only proof this bridge got as far as it needed
        // to. Whatever went wrong before it is forgiven, and the next respawn
        // starts from the fast delay again.
        this.consecutiveFailures = 0;
        return;
      }

      case "disconnected": {
        if (event.reason === RESTART_REQUIRED) {
          this.snap = { ...this.snap, phase: "scanned", qr: null, qrIssuedAt: null };
        } else if (this.snap.phase === "waiting") {
          // The payload on screen just died with the socket. Drop it rather
          // than leave a code that will never scan; the bridge reconnects and
          // a fresh `qr` arrives in a moment.
          this.snap = { ...this.snap, phase: "starting", qr: null, qrIssuedAt: null };
        }
        return;
      }

      case "connected": {
        const user =
          event.user && typeof event.user === "object"
            ? {
                id: typeof (event.user as { id?: unknown }).id === "string" ? (event.user as { id: string }).id : null,
                name:
                  typeof (event.user as { name?: unknown }).name === "string"
                    ? (event.user as { name: string }).name
                    : null,
              }
            : null;
        this.snap = { ...this.snap, phase: "paired", qr: null, qrIssuedAt: null, user, error: null };
        void this.onPaired();
        return;
      }

      case "error": {
        const reason = typeof event.error === "string" ? event.error : "bridge_error";
        // logged_out means WhatsApp revoked the stored session. Recovering does
        // need a blank session — but the restart path will not produce one on
        // its own, because launch() only wipes a directory with no creds.json
        // and a revoked session still has one. Say so explicitly, or every
        // respawn re-presents the same dead credentials and earns the same 401.
        if (reason === "logged_out") this.sessionRevoked = true;
        this.snap = {
          ...this.snap,
          // Leaving the phase alone left "waiting" on screen with the QR pulled
          // out from under it. The bridge is on its way down and a respawn is
          // what comes next, which is what "starting" means.
          phase: this.snap.phase === "paired" ? this.snap.phase : "starting",
          error: reason,
          qr: null,
          qrIssuedAt: null,
        };
        return;
      }

      default:
        return;
    }
  }

  /**
   * Success path. Mirrors `cmd_whatsapp` step 7, which writes
   * WHATSAPP_ENABLED=true only after creds.json exists — never before, so an
   * abandoned attempt cannot leave the gateway retrying a channel that was
   * never linked. Mode and allowlist stay owned by /whatsapp/configure.
   */
  private async onPaired(): Promise<void> {
    try {
      await this.deps.markEnabled();
    } catch {
      // The link itself is real and on disk; failing to flip the env var is a
      // degraded success, not a pairing failure. The panel's own enable toggle
      // remains available.
    }
    this.teardownProcess();
    this.clearTimers();
  }

  private onExit(proc: BridgeProcessHandle): void {
    if (this.proc !== proc) return; // a stale process we already replaced
    this.proc = null;
    if (this.stopping || this.snap.phase === "paired" || this.snap.phase === "error") return;

    if (this.deps.now() - this.lastPollAt > REAP_AFTER_MS) {
      this.snap = { ...IDLE };
      this.clearTimers();
      return;
    }

    // The bridge gave up. The owner has not. Respawn — no ceiling on attempts,
    // because an attempt limit IS the timeout this feature exists to remove.
    // The ceiling is on the delay instead: a bridge that keeps dying without
    // ever showing a QR gets progressively more time, up to RESTART_DELAY_MAX_MS.
    this.snap = { ...this.snap, phase: "starting", qr: null, qrIssuedAt: null, restarts: this.snap.restarts + 1 };
    const delay = Math.min(RESTART_DELAY_MS * 2 ** this.consecutiveFailures, RESTART_DELAY_MAX_MS);
    this.consecutiveFailures += 1;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.proc) return;
      void this.launch();
    }, delay);
    if (typeof this.restartTimer === "object" && "unref" in this.restartTimer) this.restartTimer.unref();
  }

  /** Reaper. Public so tests can drive it without a real clock. */
  tick(): void {
    // A paired session owns no bridge (onPaired kills it) and its snapshot is
    // the answer the panel wants for as long as it keeps asking.
    if (this.snap.phase === "paired") return;
    if (this.deps.now() - this.lastPollAt <= REAP_AFTER_MS) return;

    // Liveness decides, not phase. A bridge can be running while the snapshot
    // reads "idle" — a DELETE that raced an in-flight launch(), a respawn that
    // landed after a reset — and gating the reaper on the phase is exactly what
    // let those processes become uncollectable. Only stand down when there is
    // demonstrably nothing to collect.
    if (this.snap.phase === "idle" && !this.proc && !this.restartTimer) {
      this.clearTimers();
      return;
    }
    this.stop();
  }

  private ensureTicker(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.tickTimer === "object" && "unref" in this.tickTimer) this.tickTimer.unref();
  }

  private clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private teardownProcess(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
  }

  /** Cancel: stop the bridge and forget the session. Leaves creds.json alone. */
  stop(): WhatsappPairSnapshot {
    this.stopping = true;
    this.clearTimers();
    this.teardownProcess();
    this.snap = { ...IDLE };
    this.stdoutBuf = "";
    this.consecutiveFailures = 0;
    return this.peek();
  }
}

// ── Real dependencies ───────────────────────────────────────────────────────

/**
 * The session directory `cmd_whatsapp` passes to the bridge. The adapter's own
 * resolver prefers `platforms/whatsapp/session` and falls back here, so writing
 * where the CLI writes keeps a UI-paired box and a terminal-paired box
 * byte-identical.
 */
export function whatsappPairingSessionDir(): string {
  return path.join(hermesHome(), "whatsapp", "session");
}

/**
 * PATH with Hermes' managed Node directories in front, mirroring
 * hermes_constants.with_hermes_node_path so we run the same node the CLI would.
 */
function bridgeEnv(): NodeJS.ProcessEnv {
  const home = hermesHome();
  const managed = [path.join(home, "node", "bin"), path.join(home, "node")];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...managed.filter((d) => !current.includes(d)), ...current];
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

/**
 * The Node binary to run the bridge with.
 *
 * Mirrors hermes_constants.find_node_executable, which prefers Hermes' own
 * managed Node over whatever PATH resolves to. Where Hermes has no managed
 * Node we use the interpreter already running this server — a stronger
 * guarantee than a PATH lookup, since it is known to exist and to be a version
 * this codebase runs on.
 *
 * Resolving it here rather than passing a "node" literal to spawn() is also
 * what keeps the build working: Turbopack treats a literal `spawn("node", [x])`
 * as a request to trace `x` as a module, and the bridge lives in ~/.hermes,
 * outside this tree.
 */
function nodeBinary(): string {
  const managed = path.join(hermesHome(), "node", "bin", "node");
  return existsSync(managed) ? managed : process.execPath;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export function createRealDeps(): PairingDeps {
  const bridgeDir = () => whatsappBridgeDir();
  const sessionDir = () => whatsappPairingSessionDir();

  return {
    bridgeDir,
    sessionDir,
    bridgeInstalled: () => pathExists(path.join(bridgeDir(), "node_modules")),

    // start() calls this first, and it is where the read-only-install-tree
    // resolution happens: everything below — the install, the spawn — then
    // reads the cached answer synchronously.
    async bridgeScriptExists() {
      const dir = await resolveWhatsappBridgeDir();
      return pathExists(path.join(dir, "bridge.js"));
    },

    async install() {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["install", "--no-fund", "--no-audit", "--progress=false"], {
          cwd: bridgeDir(),
          env: bridgeEnv(),
          stdio: ["ignore", "ignore", "pipe"],
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("install_failed"));
        }, INSTALL_TIMEOUT_MS);
        timer.unref?.();
        child.on("error", () => {
          clearTimeout(timer);
          reject(new Error("install_failed"));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error("install_failed"));
        });
      });
    },

    credsExist: () => pathExists(path.join(sessionDir(), "creds.json")),

    async clearSession() {
      await fs.rm(sessionDir(), { recursive: true, force: true });
      await fs.mkdir(sessionDir(), { recursive: true, mode: 0o700 });
    },

    async markEnabled() {
      await setHermesEnvValues({ [WHATSAPP_ENV_ENABLED]: "true" });
    },

    spawnBridge() {
      // Absolute script path, and cwd kept at the bridge directory so node
      // resolves the bridge's own node_modules.
      const script = path.join(bridgeDir(), "bridge.js");
      const child = spawn(nodeBinary(), [script, "--pair-only", "--pair-json", "--session", sessionDir()], {
        cwd: bridgeDir(),
        env: bridgeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      // stderr is drained but never parsed: Baileys' pino logger and npm both
      // write there, and an unread pipe fills and blocks the child.
      child.stderr?.resume();
      return {
        onLine: (cb) => child.stdout?.on("data", (d: string) => cb(d)),
        onExit: (cb) => {
          child.on("close", (code) => cb(code));
          child.on("error", () => cb(null));
        },
        kill: () => child.kill("SIGTERM"),
      };
    },

    now: () => Date.now(),
  };
}

// ── Process-wide singleton ──────────────────────────────────────────────────
//
// The pairing session outlives any one request, so it has to live at module
// scope — the same shape /whatsapp/status already uses for its gateway probe
// cache. Route handlers in one Next server share this instance.

let manager: WhatsappPairingManager | null = null;

export function getPairingManager(): WhatsappPairingManager {
  if (!manager) manager = new WhatsappPairingManager(createRealDeps());
  return manager;
}

/** Tests only: drop the singleton so each case starts from idle. */
export function resetPairingManagerForTests(replacement?: WhatsappPairingManager): void {
  manager = replacement ?? null;
}

/**
 * Unpair: stop any pairing session and delete the linked-device credentials
 * from BOTH locations the adapter is willing to read, then turn the channel
 * off. Removing creds while leaving WHATSAPP_ENABLED=true would leave the
 * gateway starting a bridge that can never connect — the exact state upstream's
 * deferred-enable comment exists to prevent.
 */
export async function unpairWhatsapp(sessionDirs: string[]): Promise<void> {
  getPairingManager().stop();
  for (const dir of sessionDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await setHermesEnvValues({ [WHATSAPP_ENV_ENABLED]: "false" });
}
