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
//   openclaw models auth login --provider xai --method oauth
//     --profile-id xai:default [--force]
//
// and relay what the CLI prints (a verification URL and a one-time code) to
// the owner's browser, then wait for the process to finish. The GitHub login
// in src/lib/coding-github.ts has the same shape — one login in flight, module
// state, start/poll/cancel — and this file keeps that shape on purpose.
//
// MEASURED ON A BOX (OpenClaw 2026.9.4), and each of these was a wrong first
// guess:
//
//  * `--device-code` cannot be combined with `--method oauth` ("--device-code
//    cannot be combined with --method unless method is device-code.", exit 1).
//    The oauth method already IS the device-code flow for xai.
//  * Without a terminal the command refuses outright ("models auth login
//    requires an interactive TTY", exit 1). It runs under a pseudo-terminal —
//    util-linux `script`, see `xaiLoginSpawn`. node-pty is installed on the
//    boxes but only ever loaded by the standalone terminal server, never by a
//    Next route, and pulling a native addon into the route bundle is a bigger
//    change than this sign-in is worth.
//  * Under a terminal the output is a clack-style TUI: cursor codes, CR without
//    LF, box-drawing rails, and a spinner that redraws its line a character at
//    a time. The prompt, once that is cleaned, reads:
//
//      xAI OAuth Open this URL in your LOCAL browser and enter the code below.
//      URL: <https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234>
//      Code: WXYZ-1234 Code expires in 30 minutes. Never share it.
//      Open this URL in your LOCAL browser:https://accounts.x.ai/oauth2/device
//
//    followed by "Waiting for xAI device authorization..." until approval.
//    `parseXaiDeviceLogin` is pinned against that sample (and a raw form of
//    it) in src/tests/unit/xai-oauth-login.test.ts, and always reads the WHOLE
//    accumulated buffer, because words arrive split across redraws.
//
// STILL UNMEASURED: what the CLI prints after the owner approves, or when xAI
// refuses (no SuperGrok / X Premium). Success is therefore read two ways —
// exit code 0, or the sign-in appearing in the store while the process is
// still running — and any other exit is a failure that carries the CLI's own
// last lines. A login that never shows a link fails at `PARSE_DEADLINE_MS`
// with the same evidence. It never hangs.
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
 * How long the code lives when the CLI does not say. It does say — "Code
 * expires in 30 minutes." on 2026.9.4 — and its own number wins
 * (`expiresInMinutes`); this is only the floor for a wording we cannot read.
 */
const DEFAULT_CODE_LIFETIME_MIN = 30;

/** How long `start` waits for the first useful answer before it replies. */
const START_WAIT_MS = 30_000;

/**
 * How often a poll may ask the STORE whether the sign-in has landed while the
 * CLI is still running. One `models auth list` is a CLI cold start (~10 s on a
 * Jetson), so it is throttled and never more than one at a time.
 */
const STORE_CHECK_EVERY_MS = 20_000;

/** How much of the CLI's own output a failure may carry. */
const OUTPUT_TAIL_CHARS = 400;

export interface XaiDeviceLoginPrompt {
  verificationUrl: string | null;
  userCode: string | null;
  /** The code's lifetime in minutes, when the CLI states it. */
  expiresInMinutes: number | null;
}

// Terminal control sequences: colour, cursor moves, OSC hyperlinks. The same
// pattern src/lib/openclaw-index-progress.ts strips from another CLI's output.
const TERMINAL_CONTROL_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
/** Box drawing, block elements and the clack spinner/step glyphs (◇ ◒ ◐ ◓ ◑ ●…). */
const TUI_GLYPH_RE = /[─-▟■-◿☀-⛿✓✔✖✗]/g;
/** Other C0 controls the TUI emits (BEL, backspace, cursor show/hide leftovers). */
const C0_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

// `<` and `>` end a URL: the TUI prints it as `URL: <https://…>`.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** A URL that reads like the page the owner approves the code on. */
const VERIFICATION_HINT_RE = /device|verif|activate|code|oauth|auth|login|sign/i;
/** Codes are short, uppercase-ish groups: `ABCD-EFGH`, `ABCD1234`, `WDJB-MJHT`. */
const CODE_TOKEN = "[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+|[A-Z0-9]{6,12}";
/** "Code: XXXX-XXXX", "user code XXXX-XXXX", "enter the code   XXXX-XXXX". */
const LABELLED_CODE_RE = new RegExp(`\\bcode\\b[^A-Za-z0-9]{0,20}(${CODE_TOKEN})\\b`, "gi");
/** A bare grouped code anywhere, uppercase only so ordinary words never match. */
const BARE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const EXPIRES_RE = /expires?\s+in\s+(\d{1,3})\s*min/i;

/**
 * The TUI's output as one line of prose: escapes stripped, every CR/LF and
 * every rail, box and spinner glyph turned into a space, runs of space
 * collapsed. Exported for the failure tail, which wants the same reading.
 */
export function cleanTuiOutput(text: string): string {
  return text
    .replace(TERMINAL_CONTROL_RE, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(TUI_GLYPH_RE, " ")
    .replace(C0_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

function trimUrl(raw: string): string {
  // Sentence punctuation that followed the URL in prose is not part of it.
  return raw.replace(/[).,;:!?\]}>]+$/, "");
}

/**
 * Read a verification URL, a user code and the code's lifetime out of
 * EVERYTHING the CLI has printed so far. Pure, and the only place the output
 * format is read — see the header for the measured sample. Any field may be
 * null; the caller decides what is enough.
 */
export function parseXaiDeviceLogin(output: string): XaiDeviceLoginPrompt {
  const text = cleanTuiOutput(output);
  const urls: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    // A URL that runs to the very end of what has arrived may still be
    // arriving — the TUI redraws a character at a time — so only a TERMINATED
    // one is taken. The CLI always prints more after its URLs.
    if ((match.index ?? 0) + match[0].length >= text.length) continue;
    urls.push(trimUrl(match[0]));
  }
  const withCode = urls.find((url) => /[?&](?:user_)?code=/i.test(url));
  const verificationUrl = withCode
    ?? urls.find((url) => VERIFICATION_HINT_RE.test(url))
    ?? urls[0]
    ?? null;

  let userCode: string | null = null;
  if (verificationUrl) {
    try {
      const params = new URL(verificationUrl).searchParams;
      const fromQuery = params.get("user_code") ?? params.get("code");
      if (fromQuery && new RegExp(`^(?:${CODE_TOKEN})$`, "i").test(fromQuery)) userCode = fromQuery.toUpperCase();
    } catch {
      // Not a parseable URL — the label and bare-token reads below still apply.
    }
  }
  // The label is read on the text with every URL removed, so a `code` in a
  // query string or path is never mistaken for the code itself.
  const prose = Array.from(text.matchAll(URL_RE), (m) => m[0])
    .reduce((out, url) => out.split(url).join(" "), text);
  if (!userCode) {
    for (const match of prose.matchAll(LABELLED_CODE_RE)) {
      // Uppercase only, as printed: "Code expires in 30 minutes" is a word.
      if (match[1] === match[1].toUpperCase()) {
        userCode = match[1];
        break;
      }
    }
  }
  if (!userCode) userCode = BARE_CODE_RE.exec(prose)?.[1] ?? null;

  const minutes = Number(EXPIRES_RE.exec(prose)?.[1]);
  return {
    verificationUrl,
    userCode,
    expiresInMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
  };
}

/** The tail of what the CLI printed, cleaned, for a failure the owner can read. */
export function outputTail(output: string): string {
  const text = cleanTuiOutput(output);
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

export type XaiLoginPoll =
  /** The CLI is running and has not printed a URL yet. */
  | { status: "starting" }
  /** Waiting for the owner to approve the code. */
  | {
    status: "pending";
    verificationUrl: string | null;
    userCode: string | null;
    expiresInMinutes: number;
  }
  /** The plugin stored the sign-in (the CLI exited 0, or the store shows it). */
  | { status: "complete" }
  | { status: "failed"; detail: string; output?: string };

interface PendingLogin {
  child: ChildProcess;
  output: string;
  startedAt: number;
  /** Whether `xai:default` already held a sign-in when this login began. */
  signInAlreadyStored: boolean;
  /** Set once, when the process ends or is given up on. */
  result: XaiLoginPoll | null;
  timers: ReturnType<typeof setTimeout>[];
  /** When the code's lifetime timer was armed from the CLI's own number. */
  lifetimeFromCli: boolean;
  lastStoreCheckAt: number;
  storeCheck: Promise<void> | null;
}

/** One login in flight, as for the GitHub device flow: a second start replaces the first. */
let pending: PendingLogin | null = null;

/** POSIX single-quoting for the one string `script -c` hands to a shell. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The pseudo-terminal wrapper: util-linux `script`, quiet (-q), flushing every
 * write (-f), exiting with the command's own status (-e), discarding the
 * typescript (`/dev/null`). Every argument here is a literal of this module or
 * the resolved binary path, and each is quoted all the same.
 */
export function ptyCommand(bin: string, args: string[]): { file: string; args: string[] } {
  return { file: "script", args: ["-qfec", [bin, ...args].map(shellQuote).join(" "), "/dev/null"] };
}

/** Indirection so tests can supply a fake child process. */
export const xaiLoginSpawn = {
  spawn: (bin: string, args: string[]): ChildProcess => {
    const pty = ptyCommand(bin, args);
    // `turbopackIgnore`, as on the spawn in src/lib/openclaw-config.ts: the
    // file and its arguments are runtime values, and Turbopack otherwise tries
    // to trace them as module references — which walks the whole project,
    // including the box's runtime `data/`, and fails the production build on
    // a symlink there that leaves the tree.
    return spawn(/* turbopackIgnore: true */ pty.file, pty.args, {
      // Its own process group, so cancel and timeout can end `script`, the
      // shell it starts and the CLI under it in one signal.
      detached: true,
      // stdin stays OPEN and silent: the pty session expects it, and a CLI
      // that stops on a prompt then waits for the parse deadline to report it
      // instead of reading EOF and doing something nobody chose.
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/home/clawbox",
        // A wide terminal, so the URL is not wrapped across rows.
        COLUMNS: "200",
        TERM: process.env.TERM || "xterm",
      },
    });
  },
};

/** The exact argv `openclaw` gets, exported so the tests and the report name one command. */
export function xaiLoginArgs(replaceExisting: boolean): string[] {
  return [
    "models", "auth", "login",
    "--provider", "xai",
    "--method", "oauth",
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

/** End the whole process group: `script`, its shell and the CLI under it. */
function kill(child: ChildProcess): void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone — or the group is, and the leader is all that is left.
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  signal("SIGTERM");
  const hard = setTimeout(() => signal("SIGKILL"), 3_000);
  hard.unref?.();
}

function armLifetime(login: PendingLogin, minutes: number): void {
  const timer = setTimeout(() => {
    settle(login, { status: "failed", detail: "The sign-in code expired. Start again for a fresh one." });
    kill(login.child);
  }, minutes * 60_000);
  timer.unref?.();
  login.timers.push(timer);
}

/** What the login in flight looks like right now, without waiting. */
function snapshot(login: PendingLogin): XaiLoginPoll {
  if (login.result) return login.result;
  const prompt = parseXaiDeviceLogin(login.output);
  if (prompt.verificationUrl) {
    return {
      status: "pending",
      verificationUrl: prompt.verificationUrl,
      userCode: prompt.userCode,
      expiresInMinutes: prompt.expiresInMinutes ?? DEFAULT_CODE_LIFETIME_MIN,
    };
  }
  return { status: "starting" };
}

/**
 * Start a sign-in, replacing any one in flight, and answer with the first
 * useful state: the URL and code, a failure, or (on a slow box) `starting`.
 *
 * `signInAlreadyStored` says the store held an xAI sign-in at `xai:default`
 * before this login began. A sign-in found in the store later then proves
 * nothing, so only the CLI's exit code may complete such a login.
 */
export async function startXaiLogin(opts: {
  replaceExisting: boolean;
  signInAlreadyStored?: boolean;
}): Promise<XaiLoginPoll> {
  cancelXaiLogin();
  let child: ChildProcess;
  try {
    child = xaiLoginSpawn.spawn(findOpenclawBin(), xaiLoginArgs(opts.replaceExisting));
  } catch (err) {
    return { status: "failed", detail: `Could not start the OpenClaw sign-in: ${err instanceof Error ? err.message : String(err)}` };
  }
  const login: PendingLogin = {
    child,
    output: "",
    startedAt: Date.now(),
    signInAlreadyStored: opts.signInAlreadyStored === true,
    result: null,
    timers: [],
    lifetimeFromCli: false,
    lastStoreCheckAt: 0,
    storeCheck: null,
  };
  pending = login;

  const append = (chunk: Buffer | string) => {
    // Bounded: the spinner redraws forever, and must not grow this without
    // limit. The prompt is printed once, near the start, so the HEAD is kept
    // and only the tail beyond it is trimmed.
    const next = login.output + chunk.toString();
    login.output = next.length > 40_000 ? next.slice(0, 20_000) + next.slice(-20_000) : next;
    // The code's lifetime as the CLI states it, armed once from the moment it
    // is read; until then the default timer below stands.
    if (!login.lifetimeFromCli && !login.result) {
      const minutes = parseXaiDeviceLogin(login.output).expiresInMinutes;
      if (minutes) {
        login.lifetimeFromCli = true;
        armLifetime(login, minutes);
      }
    }
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

  const deadline = setTimeout(() => {
    if (login.result || parseXaiDeviceLogin(login.output).verificationUrl) return;
    settle(login, {
      status: "failed",
      detail: "The sign-in did not show a verification link. This is what OpenClaw printed:",
      output: outputTail(login.output) || "(nothing)",
    });
    kill(child);
  }, PARSE_DEADLINE_MS);
  deadline.unref?.();
  login.timers.push(deadline);
  // The fallback lifetime, a little past the default code life so a CLI that
  // states its own number (and so arms the timer above) always ends first.
  armLifetime(login, DEFAULT_CODE_LIFETIME_MIN + 1);

  // Wait for something worth showing, but never longer than START_WAIT_MS:
  // past that the browser polls, exactly as it does after a pending answer.
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    const now = snapshot(login);
    if (now.status !== "starting") return now;
    if (pending !== login) return { status: "failed", detail: "The sign-in was replaced by another one." };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return snapshot(login);
}

/**
 * Has the sign-in landed in the store while the CLI is still running? What the
 * CLI prints after approval has not been measured, and a CLI that lingers
 * after storing the credential must not leave the owner on "waiting". Only
 * counted for a login that did not start with a sign-in already there.
 */
function checkStoreInBackground(login: PendingLogin): void {
  if (login.signInAlreadyStored || login.result || login.storeCheck) return;
  if (Date.now() - login.lastStoreCheckAt < STORE_CHECK_EVERY_MS) return;
  login.lastStoreCheckAt = Date.now();
  login.storeCheck = readXaiStoredProfiles()
    .then((rows) => {
      if (rows?.some((row) => row.id === XAI_PROFILE_ID && row.type === "oauth") && !login.result) {
        settle(login, { status: "complete" });
        kill(login.child);
      }
    })
    .catch(() => {})
    .finally(() => { login.storeCheck = null; });
}

/** One poll of the login in flight. */
export function pollXaiLogin(): XaiLoginPoll {
  if (!pending) return { status: "failed", detail: "No sign-in is in progress. Start again." };
  const now = snapshot(pending);
  // Only once the prompt is on screen: before that there is nothing the owner
  // could have approved.
  if (now.status === "pending") checkStoreInBackground(pending);
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
