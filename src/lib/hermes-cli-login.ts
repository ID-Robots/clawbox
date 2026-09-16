/**
 * Sign-in for the providers Hermes' dashboard marks "external".
 *
 * WHY THIS EXISTS. Hermes 2026.9.7 dropped its in-dashboard Anthropic login:
 * an unattended endpoint minting Claude subscription tokens outside
 * Anthropic's own client is against Anthropic's OAuth usage policy, so the
 * dashboard's catalogue answers `flow: "external"` and refuses `/start`. What
 * Hermes still ships is the ATTENDED login — `hermes auth add anthropic`, a
 * person at the keyboard, a browser page they approve, a code they paste
 * back — and that is the native mechanism this module drives. Nothing here
 * mints, stores or refreshes a token: Hermes' own command does all of that in
 * its own store, exactly as it would from a terminal. ClawBox only relays the
 * link out to the owner and the code back in.
 *
 * The same shape covers GitHub Copilot (`copilot login`, GitHub's device
 * flow: the CLI prints a code and a link and finishes on its own once GitHub
 * approves). Qwen's CLI login is not driven — its command needs the Qwen CLI
 * signed in first, which is a different product's job.
 *
 * The routes present these sessions in the SAME shape as the dashboard's
 * device-code sessions (`flow`, `auth_url` / `user_code` + `verification_url`,
 * `status: pending | approved | failed | expired`), so the provider panel's
 * existing sign-in state machine runs them unchanged.
 *
 * WHAT NEVER LEAVES THIS MODULE: the child's raw output. It can carry the
 * credential Hermes just stored (a "token preview", an access token on a
 * failure path). Callers get the parsed link, the parsed user code, a status
 * and a short, scrubbed reason — nothing else.
 *
 * SERVER ONLY.
 */

import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { HERMES_BIN } from "@/lib/harness";
import { readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";

const HOME_DIR = process.env.HOME || "/home/clawbox";
/** Where the installer puts the clawbox user's global npm CLIs (`NPM_PREFIX`). */
const NPM_GLOBAL_BIN = path.join(HOME_DIR, ".npm-global", "bin");
/** The Hermes setting that pins the Copilot CLI for its ACP provider. Hermes'
 *  dashboard runs with a PATH that does not include the npm prefix, so
 *  without the pin it reports Copilot as not installed — and its login as
 *  not done — on a box where it is both. */
export const HERMES_COPILOT_COMMAND_ENV = "HERMES_COPILOT_ACP_COMMAND";

export type CliLoginFlow = "pkce" | "device_code";
export type CliLoginStatus = "starting" | "pending" | "approved" | "failed" | "expired" | "cancelled";

interface CliLoginDriver {
  /** The executable: an absolute path, or a bare name looked up on PATH. */
  bin: () => string;
  /** Extra places to look for a bare `bin` before PATH. */
  binDirs?: readonly string[];
  /** Runs once the tool is found, before the login is spawned. */
  prepare?: (resolvedBin: string) => Promise<void>;
  args: readonly string[];
  flow: CliLoginFlow;
  /** The link the owner has to open. */
  url: RegExp;
  /** pkce: the prompt after which the CLI reads the pasted code from stdin. */
  codePrompt?: RegExp;
  /** device_code: the short code the owner types on the provider's page. */
  userCode?: RegExp;
}

const DRIVERS: Readonly<Record<string, CliLoginDriver>> = {
  anthropic: {
    bin: () => HERMES_BIN,
    // `--no-browser`: the box has no browser to open, and a headless
    // `webbrowser.open` can hang on some display stacks.
    args: ["auth", "add", "anthropic", "--no-browser"],
    flow: "pkce",
    // Verbatim from `hermes auth add anthropic --no-browser` on a box (Hermes
    // v0.21.1, 2026.9.7): a boxed banner, then the URL alone on its own line
    // indented two spaces, then "Authorization code: " read from stdin. The
    // fixture in the unit test is that capture.
    url: /https:\/\/claude\.ai\/oauth\/authorize\?[^\s│]+/,
    codePrompt: /Authorization code:/,
  },
  "copilot-acp": {
    bin: () => "copilot",
    binDirs: [NPM_GLOBAL_BIN, "/usr/local/bin"],
    // `--device-code`: the box is headless, and the CLI's default web flow
    // needs a loopback browser this process does not have.
    args: ["login", "--device-code"],
    flow: "device_code",
    prepare: async (resolvedBin) => {
      // Hermes' own setting (`hermes_cli/env_loader.py` lists it; its setup
      // flow names it when the CLI is elsewhere). Written once — a rewrite of
      // the harness's .env on every press would be a write for nothing.
      const current = await readHermesEnv().catch(() => ({} as Record<string, string>));
      if (current[HERMES_COPILOT_COMMAND_ENV] !== resolvedBin) {
        await setHermesEnvValues({ [HERMES_COPILOT_COMMAND_ENV]: resolvedBin });
      }
    },
    url: /https:\/\/github\.com\/login\/device[^\s]*/,
    userCode: /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
  },
};

export function cliLoginDriverFor(providerId: string): CliLoginFlow | null {
  return DRIVERS[providerId]?.flow ?? null;
}

/** The driver's executable on this box, or null. A bare name is looked up in
 *  the driver's own dirs first, then on PATH — the web server's PATH is
 *  systemd's, which knows nothing of the npm prefix. */
export async function resolveCliLoginBin(providerId: string): Promise<string | null> {
  const driver = DRIVERS[providerId];
  if (!driver) return null;
  const bin = driver.bin();
  const dirs = path.isAbsolute(bin)
    ? []
    : [...(driver.binDirs ?? []), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  const candidates = path.isAbsolute(bin) ? [bin] : dirs.map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Is the driver's executable on this box? */
export async function cliLoginAvailable(providerId: string): Promise<boolean> {
  return (await resolveCliLoginBin(providerId)) !== null;
}

export interface CliLoginSession {
  id: string;
  providerId: string;
  flow: CliLoginFlow;
  status: CliLoginStatus;
  authUrl: string;
  userCode: string;
  verificationUrl: string;
  /** Short, scrubbed. */
  error: string;
  expiresAt: number;
}

interface LiveSession extends CliLoginSession {
  child: ChildProcess | null;
  buffer: string;
  promptSeen: boolean;
  codeSent: boolean;
  exit: { code: number | null; signal: string | null } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long the owner has to finish on the provider's page. */
export const CLI_LOGIN_TTL_MS = 10 * 60_000;
/** How long the CLI gets to print its link before the start is called failed. */
const LINK_WAIT_MS = 20_000;
/** How long the CLI gets to exchange a submitted code. */
const EXCHANGE_WAIT_MS = 60_000;
const OUTPUT_CAP = 64 * 1024;
/** After SIGTERM, how long a login gets to exit before SIGKILL. */
const KILL_GRACE_MS = 3_000;

const sessions = new Map<string, LiveSession>();

export type SpawnLike = (
  bin: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; detached: boolean },
) => ChildProcess;
const realSpawn: SpawnLike = (bin, args, opts) => spawn(bin, [...args], { ...opts, stdio: ["pipe", "pipe", "pipe"] });
let spawnImpl: SpawnLike = realSpawn;

/** Test seam only. */
export function _setSpawnForTests(impl: SpawnLike | null): void {
  spawnImpl = impl ?? realSpawn;
}

/**
 * Stop a login and everything it started. The npm-installed `copilot` is a
 * launcher that spawns the real binary, so killing our child alone left the
 * grandchild polling GitHub after a cancel (seen on a box). Each login is
 * spawned in its own process group, and the group is what gets the signal.
 */
function signalLogin(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Test seam only: forget every session (kills live children). */
export function _resetCliLoginsForTests(): void {
  for (const session of sessions.values()) finish(session, "cancelled", "");
  sessions.clear();
}

function publicView(session: LiveSession): CliLoginSession {
  const { id, providerId, flow, status, authUrl, userCode, verificationUrl, error, expiresAt } = session;
  return { id, providerId, flow, status, authUrl, userCode, verificationUrl, error, expiresAt };
}

/**
 * A failure reason the browser may see. Anything that could be a credential
 * — long runs of token-looking characters, `sk-…` prefixes — is dropped, and
 * the whole thing is capped. The point is "which of the four things went
 * wrong", not the CLI's transcript.
 */
export function scrubReason(text: string): string {
  const lastLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[│╭╰─\s]+$/.test(line))
    .pop() ?? "";
  return lastLine
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .slice(0, 160);
}

function finish(session: LiveSession, status: CliLoginStatus, error: string): void {
  if (session.status === "approved" || session.status === "failed" || session.status === "expired" || session.status === "cancelled") return;
  session.status = status;
  session.error = error;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  const child = session.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    signalLogin(child, "SIGTERM");
    // A login nobody is looking at must not keep running: escalate if the
    // group has not gone in its grace period.
    const hardKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalLogin(child, "SIGKILL");
    }, KILL_GRACE_MS);
    hardKill.unref?.();
  }
}

function gc(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      finish(session, "expired", "");
    }
    // Keep a terminal session around briefly so a poll can read the outcome,
    // then forget it — the map must not grow with every attempt.
    if (session.status !== "pending" && session.status !== "starting" && session.expiresAt + 60_000 <= now) {
      sessions.delete(id);
    }
  }
}

function childEnv(): NodeJS.ProcessEnv {
  // No DISPLAY: the login must never try to open a browser on the box's own
  // screen. No inherited TERM tricks either — plain output parses.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [NPM_GLOBAL_BIN, path.join(HOME_DIR, ".local", "bin"), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    TERM: "dumb",
    NO_COLOR: "1",
    PYTHONUNBUFFERED: "1",
  };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.BROWSER;
  return env;
}

function onOutput(session: LiveSession, chunk: string): void {
  // Keep the TAIL: the line `scrubReason` wants is the last one printed.
  session.buffer = (session.buffer + chunk).slice(-OUTPUT_CAP);
  const driver = DRIVERS[session.providerId];
  if (!session.authUrl) {
    const link = session.buffer.match(driver.url)?.[0];
    if (link) {
      session.authUrl = link;
      if (driver.flow === "device_code") session.verificationUrl = link;
    }
  }
  if (driver.userCode && !session.userCode) {
    // The code is the LAST such token — a device-flow CLI may print a
    // version, a request id or a hostname earlier that matches the shape.
    const codes = session.buffer.match(new RegExp(driver.userCode.source, "g"));
    if (codes?.length) session.userCode = codes[codes.length - 1];
  }
  if (driver.codePrompt && !session.promptSeen && driver.codePrompt.test(session.buffer)) {
    session.promptSeen = true;
  }
  const ready = driver.flow === "pkce"
    ? Boolean(session.authUrl && session.promptSeen)
    : Boolean(session.authUrl && session.userCode);
  if (ready && session.status === "starting") session.status = "pending";
}

function onExit(session: LiveSession, code: number | null, signal: string | null): void {
  session.exit = { code, signal };
  if (session.status === "cancelled" || session.status === "expired") return;
  if (code === 0) {
    finish(session, "approved", "");
    return;
  }
  // A device-flow CLI that ends non-zero before the owner ever saw a link, or
  // a pkce CLI that died mid-exchange: either way the sign-in did not happen.
  finish(session, "failed", scrubReason(session.buffer));
}

function waitFor(session: LiveSession, ready: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (ready() || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Start the CLI login for `providerId`. Resolves once the link (and, for a
 * device flow, the code) has been parsed, or with the failure. One live
 * session per provider: starting again cancels the previous one, which is
 * what an owner pressing the button twice means.
 */
export async function startCliLogin(providerId: string): Promise<CliLoginSession> {
  gc();
  const driver = DRIVERS[providerId];
  if (!driver) throw new Error(`No CLI sign-in for ${providerId}`);
  for (const session of sessions.values()) {
    if (session.providerId === providerId && (session.status === "starting" || session.status === "pending")) {
      finish(session, "cancelled", "");
    }
  }
  const session: LiveSession = {
    id: crypto.randomBytes(18).toString("base64url"),
    providerId,
    flow: driver.flow,
    status: "starting",
    authUrl: "",
    userCode: "",
    verificationUrl: "",
    error: "",
    expiresAt: Date.now() + CLI_LOGIN_TTL_MS,
    child: null,
    buffer: "",
    promptSeen: false,
    codeSent: false,
    exit: null,
    timer: null,
  };
  sessions.set(session.id, session);
  try {
    const bin = await resolveCliLoginBin(providerId);
    if (!bin) {
      finish(session, "failed", "The sign-in tool is not installed on this box.");
      return publicView(session);
    }
    if (driver.prepare) {
      try {
        await driver.prepare(bin);
      } catch {
        // The pin is a courtesy to the harness's status read; the login
        // itself does not depend on it.
      }
    }
    const child = spawnImpl(bin, driver.args, { env: childEnv(), detached: true });
    session.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onOutput(session, chunk));
    child.stderr?.on("data", (chunk: string) => onOutput(session, chunk));
    child.on("error", (err: Error) => finish(session, "failed", scrubReason(err.message)));
    child.on("exit", (code, signal) => onExit(session, code, signal));
  } catch (err) {
    finish(session, "failed", scrubReason(err instanceof Error ? err.message : String(err)));
    return publicView(session);
  }
  session.timer = setTimeout(() => finish(session, "expired", ""), CLI_LOGIN_TTL_MS);
  await waitFor(session, () => session.status !== "starting", LINK_WAIT_MS);
  if (session.status === "starting") {
    finish(session, "failed", scrubReason(session.buffer) || "The sign-in tool printed no link.");
  }
  return publicView(session);
}

export function readCliLogin(sessionId: string): CliLoginSession | null {
  gc();
  const session = sessions.get(sessionId);
  return session ? publicView(session) : null;
}

/**
 * pkce only: hand the pasted code to the CLI and wait for its verdict — exit
 * 0 is the credential stored by Hermes' own code, anything else a refusal.
 */
export async function submitCliLoginCode(sessionId: string, code: string): Promise<CliLoginSession | null> {
  gc();
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.flow !== "pkce" || session.status !== "pending" || session.codeSent || !session.child?.stdin) {
    return publicView(session);
  }
  session.codeSent = true;
  try {
    session.child.stdin.write(`${code}\n`);
    session.child.stdin.end();
  } catch (err) {
    finish(session, "failed", scrubReason(err instanceof Error ? err.message : String(err)));
    return publicView(session);
  }
  await waitFor(session, () => session.exit !== null || session.status !== "pending", EXCHANGE_WAIT_MS);
  if (session.status === "pending") finish(session, "failed", "The sign-in tool did not answer in time.");
  return publicView(session);
}

export function cancelCliLogin(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  finish(session, "cancelled", "");
  return true;
}
