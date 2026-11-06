/**
 * The owner's OWN OpenAI access for a coding run — the third provider beside
 * the box's ClawBox AI plan and the owner's Anthropic access (see
 * src/lib/coding-provider.ts). An `openai` run is the Codex CLI
 * (src/lib/coding-codex.ts), so everything here is about what Codex will
 * authenticate with.
 *
 * TWO WAYS IN, AND BOTH ARE THE BOX'S OWN
 *
 *  - an API KEY, saved here. Into the device secret store under its own scope
 *    (`OPENAI_SECRET_SCOPE`), the same encrypted file and the same discipline
 *    as the Anthropic account pool's credentials — never data/config.json, never
 *    a route's answer, never a log line. A run is handed it as `CODEX_API_KEY`,
 *    the variable `codex exec` authenticates with, and its commands are spawned
 *    with that one variable excluded (coding-codex.ts).
 *  - a CHATGPT SIGN-IN, made through Codex's own device flow
 *    (`codex login --device-auth`) into the coding agent's CODEX_HOME under the
 *    box's data folder. Codex stores and refreshes that login itself. It is
 *    NOT the gateway's ChatGPT sign-in and never touches `~/.codex`: that one is
 *    mirrored there by scripts/codex-auth-mirror.js, and one refresh token must
 *    have exactly one holder. A device-flow sign-in here is a separate grant.
 *
 * The key wins when both are there, as an Anthropic key wins over a `claude`
 * login: it is the one the owner pasted for this purpose.
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { CODEX_BINARY_PATH, CODEX_HOME_DIR } from "@/lib/coding-codex";
import { OPENAI_API_KEY_SECRET_NAME, OPENAI_SECRET_SCOPE } from "@/lib/coding-provider";
import { deleteDeviceSecret, readDeviceSecret, setDeviceSecret } from "@/lib/project-secrets";
import { findSignInLink, scrubReason } from "@/lib/hermes-cli-login";

/** An API key's shape, before it is ever stored or sent anywhere. */
const KEY_PREFIX = "sk-";
const MIN_KEY_CHARS = 20;
export const MAX_OPENAI_KEY_CHARS = 500;

/** How long the optional live check may take before the box stops waiting. */
const VERIFY_TIMEOUT_MS = 10_000;
/** OpenAI's cheapest authenticated call: it lists models and bills nothing. */
const VERIFY_URL = "https://api.openai.com/v1/models";

/**
 * When OpenAI last refused a run for a usage or plan limit, as the epoch ms the
 * limit is over — the "limited" in the provider's status. Not a secret.
 */
export const OPENAI_LIMITED_UNTIL_CONFIG_KEY = "coding_agent_openai_limited_until";

export type OpenAISource = "key" | "chatgpt";
export type OpenAIStatus = "connected" | "disconnected" | "limited";

export interface OpenAIConnection {
  /** Would an `openai` run have something to authenticate with? */
  connected: boolean;
  /** An API key is saved on the box. */
  hasKey: boolean;
  /** A ChatGPT sign-in is in the coding agent's CODEX_HOME. */
  hasLogin: boolean;
  /** What a run would use now. Never the credential. */
  source: OpenAISource | null;
  /** Connected, not connected, or connected but at a usage limit until `limitedUntil`. */
  status: OpenAIStatus;
  limitedUntil: number | null;
  /** The Codex CLI is where install.sh puts it — without it no `openai` run can start. */
  codexInstalled: boolean;
}

/** Where the coding agent's Codex keeps its login, sessions and rules. */
export function codexHome(): string {
  return path.join(DATA_DIR, CODEX_HOME_DIR);
}

/** The Codex binary a run is spawned with. */
export function codexBinary(): string {
  return path.join(os.homedir(), CODEX_BINARY_PATH);
}

/** Make CODEX_HOME, owner-only. Idempotent. */
export function ensureCodexHome(): string {
  const dir = codexHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort: a folder this process made is already 0700
  }
  return dir;
}

export function isCodexInstalled(): boolean {
  try {
    const stat = fs.statSync(codexBinary());
    if (!stat.isFile()) return false;
    fs.accessSync(codexBinary(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is this a plausible OpenAI key? Shape only — and never an Anthropic one pasted in the wrong field. */
export function looksLikeOpenAIKey(value: string): boolean {
  return (
    value.startsWith(KEY_PREFIX)
    && !value.startsWith("sk-ant-")
    && value.length >= MIN_KEY_CHARS
    && value.length <= MAX_OPENAI_KEY_CHARS
    && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** Save the owner's key. @throws Error with an owner-facing sentence when the value is not a key. */
export async function setOpenAIKey(value: string): Promise<void> {
  const key = value.trim();
  if (!looksLikeOpenAIKey(key)) {
    throw new Error(`That does not look like an OpenAI API key — they start with "${KEY_PREFIX}".`);
  }
  await setDeviceSecret({ scope: OPENAI_SECRET_SCOPE, name: OPENAI_API_KEY_SECRET_NAME, value: key });
  // A new credential is a new answer to "is OpenAI at its limit?".
  await clearOpenAILimit();
}

/** Forget the stored key. The ChatGPT sign-in, if any, is left alone. */
export async function clearOpenAIKey(): Promise<void> {
  await deleteDeviceSecret({ scope: OPENAI_SECRET_SCOPE, name: OPENAI_API_KEY_SECRET_NAME });
}

/**
 * The stored key, for a run's spawn only — never a route. Null when there is
 * none or the store cannot be opened (the run then falls back to the sign-in).
 */
export async function readOpenAIKey(): Promise<string | null> {
  const found = await readDeviceSecret({ scope: OPENAI_SECRET_SCOPE, name: OPENAI_API_KEY_SECRET_NAME });
  return found.found ? found.value : null;
}

async function hasOpenAIKey(): Promise<boolean> {
  return (await readOpenAIKey()) !== null;
}

/**
 * Is there a sign-in in the coding agent's CODEX_HOME? Codex writes `auth.json`
 * there on a successful `codex login`, with its tokens (ChatGPT) or a key.
 */
export function hasCodexLogin(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codexHome(), "auth.json"), "utf8")) as Record<string, unknown>;
    const tokens = raw.tokens && typeof raw.tokens === "object" ? (raw.tokens as Record<string, unknown>) : null;
    const hasTokens = Boolean(tokens && (typeof tokens.refresh_token === "string" || typeof tokens.access_token === "string"));
    const hasKey = typeof raw.OPENAI_API_KEY === "string" && raw.OPENAI_API_KEY !== "";
    return hasTokens || hasKey;
  } catch {
    return false;
  }
}

/** The limit's end, when it is still ahead; null otherwise. */
async function limitedUntil(now: number): Promise<number | null> {
  const raw = await configGet(OPENAI_LIMITED_UNTIL_CONFIG_KEY);
  return typeof raw === "number" && Number.isFinite(raw) && raw > now ? raw : null;
}

/** Remember that OpenAI refused a run for a limit, until `until` (coding-codex.ts, codexLimitUntil). */
export async function noteOpenAILimit(until: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(until) || until <= now) return;
  await configSet(OPENAI_LIMITED_UNTIL_CONFIG_KEY, until);
}

/** A run on OpenAI got its answer: whatever limit was remembered is over. */
export async function clearOpenAILimit(): Promise<void> {
  if ((await configGet(OPENAI_LIMITED_UNTIL_CONFIG_KEY)) === undefined) return;
  await configSet(OPENAI_LIMITED_UNTIL_CONFIG_KEY, undefined);
}

/** When OpenAI is back, for the spawn gate: null when it is not limited. */
export async function openAILimitedUntil(now = Date.now()): Promise<number | null> {
  try {
    return await limitedUntil(now);
  } catch {
    return null;
  }
}

/** The whole connection state, for the status payload and for readiness. */
export async function getOpenAIConnection(now = Date.now()): Promise<OpenAIConnection> {
  const [hasKey, until] = await Promise.all([
    // A store that cannot be read is not a key: the sign-in may still answer.
    hasOpenAIKey().catch(() => false),
    openAILimitedUntil(now),
  ]);
  const hasLogin = hasCodexLogin();
  const connected = hasKey || hasLogin;
  return {
    connected,
    hasKey,
    hasLogin,
    source: hasKey ? "key" : hasLogin ? "chatgpt" : null,
    status: !connected ? "disconnected" : until !== null ? "limited" : "connected",
    limitedUntil: connected ? until : null,
    codexInstalled: isCodexInstalled(),
  };
}

export type KeyVerdict = "ok" | "rejected" | "unreachable";

/**
 * Ask OpenAI whether this key works, before it is saved. The same rule as the
 * Anthropic check: only a definite refusal, in OpenAI's own JSON, stops the
 * save; an offline box or a captive portal's page leaves it "unreachable", and
 * the key is stored unchecked.
 */
export async function verifyOpenAIKey(key: string): Promise<KeyVerdict> {
  try {
    const res = await fetch(VERIFY_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return (await answeredInJson(res)) ? "rejected" : "unreachable";
    if (!res.ok) return "unreachable";
    return "ok";
  } catch {
    return "unreachable";
  }
}

async function answeredInJson(res: Response): Promise<boolean> {
  try {
    JSON.parse(await res.text());
    return true;
  } catch {
    return false;
  }
}

// ─── ChatGPT sign-in: `codex login --device-auth` ───────────────────────────

export type CodexLoginStatus = "starting" | "pending" | "approved" | "failed" | "expired" | "cancelled";

/** What the browser may see of a sign-in in progress. Never a token. */
export interface CodexLoginView {
  id: string;
  status: CodexLoginStatus;
  /** The page the owner opens — only ever OpenAI's own device page. */
  verificationUrl: string | null;
  /** The one-time code the owner types there. */
  userCode: string | null;
  error: string | null;
  expiresAt: number;
}

interface CodexLoginSession extends CodexLoginView {
  child: ChildProcess | null;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The device page Codex prints, parsed — never a lookalike host. */
const DEVICE_LINK = { host: "auth.openai.com", pathPrefix: "/codex/device" };
/** "ABCD-EFGHI": the shape of Codex's one-time code. */
const USER_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;
/** Codex says the code expires in 15 minutes. */
export const CODEX_LOGIN_TTL_MS = 15 * 60_000;
/** How long the CLI gets to print its link before the start is called failed. */
const LINK_WAIT_MS = 20_000;
const OUTPUT_CAP = 32 * 1024;
const KILL_GRACE_MS = 3_000;
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

interface LoginStore {
  session: CodexLoginSession | null;
}
const globalStore = globalThis as unknown as { __clawboxCodexLogin?: LoginStore };
const loginStore: LoginStore = globalStore.__clawboxCodexLogin ?? (globalStore.__clawboxCodexLogin = { session: null });

export type CodexSpawn = (bin: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; detached: boolean }) => ChildProcess;
const realSpawn: CodexSpawn = (bin, args, opts) => spawn(bin, [...args], { ...opts, stdio: ["ignore", "pipe", "pipe"] });
let spawnImpl: CodexSpawn = realSpawn;

/** Test seam only. */
export function _setCodexSpawnForTests(impl: CodexSpawn | null): void {
  spawnImpl = impl ?? realSpawn;
}

/** Test seam only: forget the sign-in in progress (and end its process). */
export function _resetCodexLoginForTests(): void {
  const session = loginStore.session;
  if (session) finishLogin(session, "cancelled", null);
  loginStore.session = null;
}

/**
 * The environment the CLI gets for a sign-in or a sign-out: the box's
 * CODEX_HOME and nothing of the web server's own. No colour, so the link and
 * the code arrive as plain text.
 */
export function codexCliEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  return {
    HOME: home,
    USER: process.env.USER || path.basename(home),
    LANG: process.env.LANG || "C.UTF-8",
    PATH: [path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    CODEX_HOME: codexHome(),
    NO_COLOR: "1",
    TERM: "dumb",
  } as unknown as NodeJS.ProcessEnv;
}

function view(session: CodexLoginSession): CodexLoginView {
  const { id, status, verificationUrl, userCode, error, expiresAt } = session;
  return { id, status, verificationUrl, userCode, error, expiresAt };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

function finishLogin(session: CodexLoginSession, status: CodexLoginStatus, error: string | null): void {
  if (session.status !== "starting" && session.status !== "pending") return;
  session.status = status;
  session.error = error;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  const child = session.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    signalGroup(child, "SIGTERM");
    const hardKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalGroup(child, "SIGKILL");
    }, KILL_GRACE_MS);
    hardKill.unref?.();
  }
}

function onLoginOutput(session: CodexLoginSession, chunk: string): void {
  session.buffer = (session.buffer + chunk.replace(ANSI_RE, "")).slice(-OUTPUT_CAP);
  if (!session.verificationUrl) session.verificationUrl = findSignInLink(session.buffer, DEVICE_LINK);
  if (session.verificationUrl && !session.userCode) {
    // The code is printed AFTER the link; anything of its shape before the
    // link (a version, a request id) is not it.
    const afterLink = session.buffer.slice(session.buffer.indexOf(DEVICE_LINK.pathPrefix));
    const codes = afterLink.match(USER_CODE_RE);
    if (codes?.length) session.userCode = codes[0];
  }
  if (session.status === "starting" && session.verificationUrl && session.userCode) session.status = "pending";
}

/**
 * Start a ChatGPT sign-in for coding runs: `codex login --device-auth` in the
 * box's CODEX_HOME, answered once the CLI has printed its link and code (or
 * has failed to). A second start ends the first: there is one sign-in to make.
 */
export async function startCodexLogin(): Promise<CodexLoginView> {
  const previous = loginStore.session;
  if (previous) finishLogin(previous, "cancelled", null);
  const session: CodexLoginSession = {
    id: randomBytes(9).toString("base64url"),
    status: "starting",
    verificationUrl: null,
    userCode: null,
    error: null,
    expiresAt: Date.now() + CODEX_LOGIN_TTL_MS,
    child: null,
    buffer: "",
    timer: null,
  };
  loginStore.session = session;
  if (!isCodexInstalled()) {
    session.status = "failed";
    session.error = "The Codex CLI is not installed on this ClawBox. Run: sudo bash install.sh --step codex_cli";
    return view(session);
  }
  try {
    ensureCodexHome();
    const child = spawnImpl(codexBinary(), ["login", "--device-auth"], { env: codexCliEnv(), detached: true });
    session.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onLoginOutput(session, chunk));
    child.stderr?.on("data", (chunk: string) => onLoginOutput(session, chunk));
    child.on("error", (err) => finishLogin(session, "failed", scrubReason(err.message)));
    child.on("exit", (code) => {
      if (code === 0 && hasCodexLogin()) {
        finishLogin(session, "approved", null);
        void clearOpenAILimit().catch(() => {});
      }
      else finishLogin(session, "failed", scrubReason(session.buffer) || "The sign-in did not finish.");
    });
    session.timer = setTimeout(() => finishLogin(session, "expired", null), CODEX_LOGIN_TTL_MS);
    session.timer.unref?.();
  } catch (err) {
    finishLogin(session, "failed", scrubReason(err instanceof Error ? err.message : String(err)));
    return view(session);
  }
  const started = Date.now();
  while (session.status === "starting" && Date.now() - started < LINK_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (session.status === "starting") finishLogin(session, "failed", scrubReason(session.buffer) || "Codex did not print a sign-in link.");
  return view(session);
}

/** The sign-in in progress (or just finished), when the id is the one the caller started. */
export function readCodexLogin(id: string): CodexLoginView | null {
  const session = loginStore.session;
  if (!session || session.id !== id) return null;
  if (session.expiresAt <= Date.now()) finishLogin(session, "expired", null);
  return view(session);
}

/** End the sign-in in progress. Answers whether there was one with that id. */
export function cancelCodexLogin(id: string): boolean {
  const session = loginStore.session;
  if (!session || session.id !== id) return false;
  finishLogin(session, "cancelled", null);
  return true;
}

/**
 * Sign the coding agent's Codex out: `codex logout` in its own CODEX_HOME — the
 * CLI's own way, which is what removes its stored login. If the CLI cannot do it
 * (missing, or it fails), the file it would have removed goes instead, so the
 * owner's "sign out" is never answered with a login that is still there.
 */
export async function signOutCodex(): Promise<void> {
  const session = loginStore.session;
  if (session) finishLogin(session, "cancelled", null);
  if (isCodexInstalled()) {
    await new Promise<void>((resolve) => {
      execFile(codexBinary(), ["logout"], { env: codexCliEnv(), timeout: 15_000 }, () => resolve());
    });
  }
  try {
    fs.rmSync(untraced(path.join(codexHome(), "auth.json")), { force: true });
  } catch {
    // nothing to remove
  }
}
