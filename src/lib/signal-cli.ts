// signal-cli on the box: finding it, linking an account, and asking what it
// holds.
//
// Both harnesses talk to Signal through signal-cli and document the same way
// to give it an account: `signal-cli link -n <name>` prints a provisioning URI
// (shown as a QR code), waits for a phone to scan it, then prints the number it
// was associated with. Neither harness wraps that in a non-interactive command
// (OpenClaw's `channels add` is a TTY wizard), so ClawBox runs signal-cli
// itself — as the same user as the gateway, so the account lands in the data
// directory the gateway's managed daemon reads.
//
// ClawBox does not install signal-cli: on the Jetson that means a JVM build and
// a JRE, which is an open decision (see channel-preview.ts). Every caller is
// told plainly when it is missing.
//
// Everything is argv (spawn/execFile, never a shell). Nothing here logs a
// provisioning URI — it is a one-time credential for the account.

import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "./runtime-path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Where signal-cli lands when installed by hand or from the release tarball. */
const EXTRA_DIRS = ["/usr/local/bin", "/opt/signal-cli/bin", "/usr/bin"];

/** A Signal account number: E.164, a plus and 7-15 digits, no leading zero. */
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

/** Absolute path of an executable signal-cli, or null when there is none. */
export async function findSignalCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  const home = env.HOME || "/home/clawbox";
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    ...EXTRA_DIRS,
  ];
  for (const dir of [...new Set(dirs)]) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "signal-cli");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// signal-cli starts a JVM on most builds; on a Jetson that alone is seconds.
const LIST_TIMEOUT_MS = 60_000;

/**
 * The account numbers signal-cli holds on this box (`listAccounts`), or null
 * when it could not be asked. Lines look like `Number: +15551234567`.
 */
export async function listSignalAccounts(cliPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["listAccounts"], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return [...new Set(stdout.match(/\+[1-9][0-9]{6,14}/g) ?? [])];
  } catch {
    return null;
  }
}

// ── Linking ─────────────────────────────────────────────────────────────────

/** The provisioning URI: `sgnl://linkdevice?…` (current) or `tsdevice:/?…` (older builds). */
const LINK_URI_RE = /(sgnl:\/\/linkdevice\?\S+|tsdevice:\/?\?\S+)/;
const ASSOCIATED_RE = /Associated with:?\s*(\+[1-9][0-9]{6,14})/i;

/** How long a QR code stays scannable before the attempt is abandoned. */
export const LINK_TIMEOUT_MS = 3 * 60_000;
/** After the phone accepted, how long signal-cli may take to finish writing. */
const LINK_FINISH_GRACE_MS = 60_000;

export type SignalLinkState =
  | { state: "idle" }
  | { state: "waiting"; uri: string | null; startedAt: number }
  | { state: "linked"; account: string }
  | { state: "failed"; reason: "timeout" | "cancelled" | "error" };

interface LinkSession {
  child: ChildProcess;
  state: SignalLinkState;
  /** The number signal-cli printed once the phone accepted; set before exit. */
  associated: string | null;
  timer: ReturnType<typeof setTimeout>;
}

// One link attempt per box: a second QR code while the first is still live
// would let two phones race for the same device slot.
let session: LinkSession | null = null;
let lastResult: SignalLinkState = { state: "idle" };

/** End the attempt with `next`; `kill` only for a timeout or a cancel. */
function settle(current: LinkSession, next: SignalLinkState, kill: boolean): void {
  if (session !== current) return;
  clearTimeout(current.timer);
  current.state = next;
  lastResult = next;
  session = null;
  if (kill && current.child.exitCode === null && current.child.signalCode === null) {
    current.child.kill("SIGTERM");
  }
}

/**
 * Start `signal-cli link -n <deviceName>`, or return the attempt already
 * running. The URI arrives on stdout a moment after start; poll
 * {@link readSignalLink} for it and for the outcome.
 *
 * The outcome is only decided when signal-cli EXITS: after printing the number
 * it still writes the new account's keys, and killing it then would leave a
 * half-linked device behind.
 */
export function startSignalLink(cliPath: string, deviceName: string): SignalLinkState {
  if (session) return session.state;
  const child = spawn(cliPath, ["link", "-n", deviceName], { stdio: ["ignore", "pipe", "pipe"] });
  const startedAt = Date.now();
  const current: LinkSession = {
    child,
    state: { state: "waiting", uri: null, startedAt },
    associated: null,
    timer: setTimeout(() => {
      if (current.associated === null) {
        settle(current, { state: "failed", reason: "timeout" }, true);
        return;
      }
      // A phone that already accepted is finishing up: give it a bounded grace
      // rather than kill it mid-write, and never wait forever.
      current.timer = setTimeout(
        () => settle(current, { state: "linked", account: current.associated ?? "" }, true),
        LINK_FINISH_GRACE_MS,
      );
    }, LINK_TIMEOUT_MS),
  };
  session = current;
  lastResult = current.state;

  let buffer = "";
  const onData = (chunk: Buffer) => {
    if (session !== current) return;
    buffer = (buffer + chunk.toString("utf-8")).slice(-8192);
    const associated = buffer.match(ASSOCIATED_RE);
    if (associated) current.associated = associated[1];
    const uri = buffer.match(LINK_URI_RE);
    if (uri && current.state.state === "waiting" && current.state.uri === null) {
      current.state = { state: "waiting", uri: uri[1], startedAt };
      lastResult = current.state;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", () => settle(current, { state: "failed", reason: "error" }, false));
  child.on("close", (code) => {
    // Exit 0 without the "Associated with" line still means the phone
    // accepted; the caller then reads the number back with listAccounts.
    settle(
      current,
      code === 0 ? { state: "linked", account: current.associated ?? "" } : { state: "failed", reason: "error" },
      false,
    );
  });
  return current.state;
}

/** The running attempt, or how the last one ended. */
export function readSignalLink(): SignalLinkState {
  return session ? session.state : lastResult;
}

/** Abandon the running attempt (the QR code stops working). */
export function cancelSignalLink(): SignalLinkState {
  if (session) settle(session, { state: "failed", reason: "cancelled" }, true);
  return lastResult;
}

/** Test seam: forget everything about previous attempts. */
export function resetSignalLinkForTests(): void {
  if (session) {
    clearTimeout(session.timer);
    session.child.kill("SIGTERM");
  }
  session = null;
  lastResult = { state: "idle" };
}

// ── The daemon Hermes talks to ──────────────────────────────────────────────

/** Where Hermes is told to find the signal-cli HTTP daemon (its documented default). */
export const SIGNAL_DAEMON_URL = "http://127.0.0.1:8080";

/** Is a signal-cli HTTP daemon answering its health check at `url`? */
export async function signalDaemonReachable(url = SIGNAL_DAEMON_URL): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/v1/check`, { signal: AbortSignal.timeout(3_000) });
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
