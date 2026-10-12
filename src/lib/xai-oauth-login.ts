// The xAI (Grok) SIGN-IN, driven from the browser.
//
// Unlike every other sign-in this app offers, ClawBox does not speak the OAuth
// protocol itself here. The ChatGPT device flow and the Claude redirect flow
// talk to the vendor over HTTP from our own routes (oauth/device-start,
// oauth/exchange) and hand the tokens to the configure route; the xAI one is
// owned by the core's bundled `xai` plugin, whose manifest declares an
// `oauth` auth choice with `appGuidedAuth: "device-code"`. The plugin carries
// the client registration and writes the credential into the agent auth store
// itself, so the only thing ClawBox can do — and the only thing it should —
// is run the CLI that drives it:
//
//   openclaw models auth login --provider xai --method oauth --device-code
//     --profile-id xai:default [--force]
//
// and relay what the CLI prints (a verification URL and a one-time code) to
// the owner's browser, then wait for the process to finish. The GitHub login
// in src/lib/coding-github.ts has the same shape — one login in flight, module
// state, start/poll/cancel — and this file keeps that shape on purpose.
//
// THE OUTPUT FORMAT IS ASSUMED, NOT MEASURED. Nothing in this repository has
// read the plugin's device-code output, so `parseXaiDeviceLogin` is written to
// tolerate any reasonable wording: it takes the first URL it sees (preferring
// one that looks like a verification page) and a code from a `user_code=`
// query parameter, a "code: XXXX-XXXX" label, or a bare `XXXX-XXXX` token.
// What it must never do is hang: a login that has printed nothing usable by
// `PARSE_DEADLINE_MS` is failed, and every failure carries the CLI's own last
// lines so the owner (and whoever reads the report) sees what it said.
//
// No credential passes through here. The CLI prints a URL and a short code the
// owner types on another device; the token it receives stays in the CLI.

import { spawn, type ChildProcess } from "child_process";
import { findOpenclawBin, spawnOpenclawCli } from "@/lib/openclaw-config";

/** The one profile id the xAI credential lives under, either mode. */
export const XAI_PROFILE_ID = "xai:default";

/**
 * How long the CLI may run before it has shown a URL. Generous for a Jetson
 * cold start (the CLI alone is several seconds there) and short enough that a
 * CLI waiting on a prompt we cannot answer is reported, not waited on forever.
 */
const PARSE_DEADLINE_MS = 60_000;

/**
 * How long the whole login may stay open. Device codes are typically valid for
 * a quarter of an hour; past that the code on the owner's screen is dead
 * whatever the CLI is still doing.
 */
const LOGIN_LIFETIME_MS = 15 * 60_000;

/** How long `start` waits for the first useful answer before it replies. */
const START_WAIT_MS = 30_000;

/** How much of the CLI's own output a failure may carry. */
const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_CHARS = 500;

export interface XaiDeviceLoginPrompt {
  verificationUrl: string | null;
  userCode: string | null;
}

// Terminal control sequences: colour, cursor moves, OSC hyperlinks. The same
// pattern src/lib/openclaw-index-progress.ts strips from another CLI's output.
const TERMINAL_CONTROL_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** A URL that reads like the page the owner approves the code on. */
const VERIFICATION_HINT_RE = /device|verif|activate|code|oauth|auth|login|sign/i;
/** Codes are short, uppercase-ish groups: `ABCD-EFGH`, `ABCD1234`, `WDJB-MJHT`. */
const CODE_TOKEN = "[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+|[A-Z0-9]{6,12}";
/** "code: XXXX-XXXX", "user code XXXX-XXXX", "enter the code\n  XXXX-XXXX". */
const LABELLED_CODE_RE = new RegExp(`\\bcode\\b[^A-Za-z0-9\\n]{0,20}\\n?\\s{0,20}(${CODE_TOKEN})\\b`, "i");
/** A bare grouped code anywhere, uppercase only so ordinary words never match. */
const BARE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

export function stripTerminalControl(text: string): string {
  return text.replace(TERMINAL_CONTROL_RE, "").replace(/\r/g, "\n");
}

function trimUrl(raw: string): string {
  // Sentence punctuation that followed the URL in prose is not part of it.
  return raw.replace(/[).,;:!?\]}>]+$/, "");
}

/**
 * Read a verification URL and a user code out of whatever the CLI has printed
 * so far. Pure, and the ONLY place the output format is assumed — see the
 * header. Either half may be null; the caller decides what is enough.
 */
export function parseXaiDeviceLogin(output: string): XaiDeviceLoginPrompt {
  const text = stripTerminalControl(output);
  const urls = Array.from(text.matchAll(URL_RE), (m) => trimUrl(m[0]));
  const verificationUrl = urls.find((url) => VERIFICATION_HINT_RE.test(url)) ?? urls[0] ?? null;

  let userCode: string | null = null;
  if (verificationUrl) {
    try {
      const fromQuery = new URL(verificationUrl).searchParams.get("user_code")
        ?? new URL(verificationUrl).searchParams.get("code");
      if (fromQuery && new RegExp(`^(?:${CODE_TOKEN})$`, "i").test(fromQuery)) userCode = fromQuery.toUpperCase();
    } catch {
      // Not a parseable URL — the label and bare-token reads below still apply.
    }
  }
  // The label is read on the text with the URLs removed, so a `code` in a
  // query string or path is never mistaken for the code itself.
  const prose = urls.reduce((out, url) => out.split(url).join(" "), text);
  if (!userCode) {
    const labelled = LABELLED_CODE_RE.exec(prose)?.[1];
    // Uppercase only, as printed: "code expires in 15 minutes" is a word.
    if (labelled && labelled === labelled.toUpperCase()) userCode = labelled;
  }
  if (!userCode) userCode = BARE_CODE_RE.exec(prose)?.[1] ?? null;
  return { verificationUrl, userCode };
}

/** The last few lines the CLI printed, cleaned, for a failure the owner can read. */
export function outputTail(output: string): string {
  const lines = stripTerminalControl(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  return tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail;
}

export type XaiLoginPoll =
  /** The CLI is running and has not printed a URL yet. */
  | { status: "starting" }
  /** Waiting for the owner to approve the code. */
  | { status: "pending"; verificationUrl: string | null; userCode: string | null }
  /** The CLI exited 0: the plugin stored the sign-in. */
  | { status: "complete" }
  | { status: "failed"; detail: string; output?: string };

interface PendingLogin {
  child: ChildProcess;
  output: string;
  startedAt: number;
  /** Set once, when the process ends or is given up on. */
  result: XaiLoginPoll | null;
  timers: ReturnType<typeof setTimeout>[];
}

/** One login in flight, as for the GitHub device flow: a second start replaces the first. */
let pending: PendingLogin | null = null;

/** Indirection so tests can supply a fake child process. */
export const xaiLoginSpawn = {
  spawn: (bin: string, args: string[]): ChildProcess =>
    spawn(bin, args, {
      // stdin stays OPEN and silent: a CLI that stops on a prompt then waits,
      // and the parse deadline reports it, instead of reading EOF and doing
      // something nobody chose.
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/home/clawbox",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    }),
};

/** The exact argv, exported so the tests and the report name one command. */
export function xaiLoginArgs(replaceExisting: boolean): string[] {
  return [
    "models", "auth", "login",
    "--provider", "xai",
    "--method", "oauth",
    "--device-code",
    "--profile-id", XAI_PROFILE_ID,
    // Only when the store already holds an xAI profile: `--force` drops the
    // existing xai profiles before signing in, which is what switching from an
    // API key needs and what a first sign-in does not.
    ...(replaceExisting ? ["--force"] : []),
  ];
}

function settle(login: PendingLogin, result: XaiLoginPoll): void {
  if (login.result) return;
  login.result = result;
  for (const timer of login.timers) clearTimeout(timer);
  login.timers = [];
}

function kill(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  const hard = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 3_000);
  hard.unref?.();
}

/** What the login in flight looks like right now, without waiting. */
function snapshot(login: PendingLogin): XaiLoginPoll {
  if (login.result) return login.result;
  const prompt = parseXaiDeviceLogin(login.output);
  if (prompt.verificationUrl) return { status: "pending", ...prompt };
  return { status: "starting" };
}

/**
 * Start a sign-in, replacing any one in flight, and answer with the first
 * useful state: the URL and code, a failure, or (on a slow box) `starting`.
 */
export async function startXaiLogin(opts: { replaceExisting: boolean }): Promise<XaiLoginPoll> {
  cancelXaiLogin();
  let child: ChildProcess;
  try {
    child = xaiLoginSpawn.spawn(findOpenclawBin(), xaiLoginArgs(opts.replaceExisting));
  } catch (err) {
    return { status: "failed", detail: `Could not start the OpenClaw sign-in: ${err instanceof Error ? err.message : String(err)}` };
  }
  const login: PendingLogin = { child, output: "", startedAt: Date.now(), result: null, timers: [] };
  pending = login;

  const append = (chunk: Buffer | string) => {
    // Bounded: a CLI that loops on a progress line must not grow this forever.
    login.output = (login.output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => {
    settle(login, { status: "failed", detail: `Could not run the OpenClaw sign-in: ${err.message}` });
  });
  child.on("close", (code) => {
    if (code === 0) {
      settle(login, { status: "complete" });
      return;
    }
    settle(login, {
      status: "failed",
      detail: code === null
        ? "The sign-in was stopped before it finished."
        : `The sign-in did not complete (exit ${code}).`,
      output: outputTail(login.output) || undefined,
    });
  });

  login.timers.push(setTimeout(() => {
    if (login.result || parseXaiDeviceLogin(login.output).verificationUrl) return;
    settle(login, {
      status: "failed",
      detail: "The sign-in did not show a verification link. This is what OpenClaw printed:",
      output: outputTail(login.output) || "(nothing)",
    });
    kill(child);
  }, PARSE_DEADLINE_MS));
  login.timers.push(setTimeout(() => {
    settle(login, { status: "failed", detail: "The sign-in code expired. Start again for a fresh one." });
    kill(child);
  }, LOGIN_LIFETIME_MS));
  for (const timer of login.timers) timer.unref?.();

  // Wait for something worth showing, but never longer than START_WAIT_MS:
  // past that the browser polls, exactly as it does after a pending answer.
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const now = snapshot(login);
    if (now.status !== "starting") return now;
    if (pending !== login) return { status: "failed", detail: "The sign-in was replaced by another one." };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return snapshot(login);
}

/** One poll of the login in flight. */
export function pollXaiLogin(): XaiLoginPoll {
  if (!pending) return { status: "failed", detail: "No sign-in is in progress. Start again." };
  const now = snapshot(pending);
  // A finished login is answered once more and then forgotten, so a stale tab
  // cannot replay "complete" after the next start.
  if (now.status === "complete" || now.status === "failed") pending = null;
  return now;
}

/** Stop the login in flight, if any. The code on the owner's screen goes unused. */
export function cancelXaiLogin(): void {
  const login = pending;
  pending = null;
  if (!login) return;
  const wasRunning = !login.result;
  settle(login, { status: "failed", detail: "The sign-in was cancelled." });
  if (wasRunning) kill(login.child);
}

/** One row of `openclaw models auth list --json` that belongs to xAI. */
export interface XaiStoredProfile {
  id: string;
  /** `oauth` or `api_key`, as the store reports it. */
  type: string;
}

/**
 * The xAI rows of the agent auth store, read from `openclaw models auth list
 * --json` — the store's own reader, the same one the configure route's sign-in
 * guard asks (shape measured there on 2026.8.1:
 * `{profiles: [{id, provider, type, label, expiresAt}]}`). Asked of the STORE
 * because `models auth login` writes the store and not openclaw.json's
 * `auth.profiles` metadata, so the config alone cannot see a sign-in.
 *
 * Null when the store could not be read or answered in a shape this does not
 * recognise: unknown, never "no profiles".
 */
export async function readXaiStoredProfiles(): Promise<XaiStoredProfile[] | null> {
  let raw: string;
  try {
    raw = await spawnOpenclawCli(["models", "auth", "list", "--json"], { captureStdout: true, timeoutMs: 60_000 });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const profiles = parsed && typeof parsed === "object" ? (parsed as { profiles?: unknown }).profiles : undefined;
  if (!Array.isArray(profiles)) return null;
  const out: XaiStoredProfile[] = [];
  for (const row of profiles) {
    if (!row || typeof row !== "object") continue;
    const entry = row as { id?: unknown; provider?: unknown; type?: unknown };
    if (typeof entry.id !== "string") continue;
    const provider = typeof entry.provider === "string" ? entry.provider : entry.id.split(":")[0];
    if (provider.trim().toLowerCase() !== "xai") continue;
    out.push({ id: entry.id, type: String(entry.type ?? "").trim().toLowerCase() });
  }
  return out;
}
