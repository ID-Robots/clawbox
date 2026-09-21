/**
 * In-handler authentication for /setup-api/* route handlers.
 *
 * Middleware (src/middleware.ts) is the primary gate, but it is one
 * hand-maintained list in front of a ~100-route surface: one mis-ordered
 * `startsWith`, one rewrite, one route reached by a path the matcher doesn't
 * cover, and a destructive handler runs unauthenticated. TASK-443's
 * factory-reset incident is exactly that failure mode — `setup/reset` was
 * `export async function POST()`, a handler that could not have read a cookie
 * if it wanted to.
 *
 * So the destructive handlers check for themselves too. `requireSession`
 * returns a 401 NextResponse to return verbatim, or `null` to proceed.
 *
 * Deliberately self-contained: this module reads data/config.json and
 * data/.session-secret directly rather than going through `@/lib/config-store`
 * and `@/lib/auth`. That mirrors middleware's own resolution (so the two can't
 * drift), keeps the second line of defence independent of the app modules it is
 * defending, and means a route test that mocks config-store doesn't
 * accidentally mock the auth check out of existence.
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { verifyMcpBearer } from "./mcp-token";
import { hasOwnerPassword } from "./system-password";

function dataDir(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data");
}

interface ConfigFacts {
  setupComplete: boolean;
  passwordConfigured: boolean;
  sessionGeneration: number;
}

/**
 * Fail-closed config read. A config.json that is genuinely absent is a
 * first-boot device (no owner). Any other read/parse failure is a provisioned
 * box with a damaged file, and is treated as "has an owner" so a corrupt or
 * clobbered config can't reopen the bootstrap window.
 */
function readConfigFacts(): ConfigFacts {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      setup_complete?: unknown;
      password_configured?: unknown;
      session_generation?: unknown;
    };
    const gen = typeof parsed.session_generation === "number" && Number.isFinite(parsed.session_generation)
      ? parsed.session_generation
      : 0;
    return {
      setupComplete: parsed.setup_complete === true,
      passwordConfigured: parsed.password_configured === true,
      sessionGeneration: gen,
    };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { setupComplete: !missing, passwordConfigured: !missing, sessionGeneration: 0 };
  }
}

/**
 * Fail-closed setup flags for the pre-auth /login ⇄ /setup handoff, mirroring
 * middleware's readConfigCached failure semantics exactly: an ABSENT
 * config.json is a first-boot box (both false, bootstrap window open); an
 * unreadable/corrupt one is a provisioned box (both true, everything gated).
 *
 * setup/status must serve THESE rather than config-store's fail-OPEN read
 * (which returns {} on a parse error): that told an unauthenticated /login
 * page the wizard was open while middleware kept /setup shut, and the two
 * redirects chased each other forever on a box with a damaged config — the
 * same loop class as the password_configured bounce, one truncated file away.
 */
export function readSetupGateFacts(): { setupComplete: boolean; passwordConfigured: boolean } {
  const { setupComplete, passwordConfigured } = readConfigFacts();
  return { setupComplete, passwordConfigured };
}

function sessionSecret(): string | null {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  try {
    const onDisk = fs.readFileSync(path.join(dataDir(), ".session-secret"), "utf-8").trim();
    return onDisk.length >= 32 ? onDisk : null;
  } catch {
    return null;
  }
}

export interface RequireSessionOptions {
  /**
   * Let the request through while the device is in the genuine first-boot
   * bootstrap window — no password has ever been set, so there is no owner to
   * authenticate as and no credential to protect. Set this ONLY for routes the
   * wizard must reach before CredentialsStep runs (wifi/connect, update/run).
   * Everything destructive leaves it false and fails closed.
   */
  allowBootstrap?: boolean;
}

/**
 * True once the device has an owner credential — the point from which every
 * sensitive route must fail closed.
 *
 * Checks BOTH sources deliberately. `password_configured` lives in
 * data/config.json, which factory reset wipes and a partial restore can drop;
 * /etc/shadow is the real thing. TASK-444a is precisely that drift: config.json
 * says "no password" while the account has one, and the initial-set path
 * re-opens to an anonymous caller.
 *
 * "Has one" means a password somebody chose. The shipped image and a factory
 * reset both leave the published default on the account, and an account anyone
 * can already log in to has no owner — keying on the bare /etc/shadow hash
 * locked the first-boot wizard (wifi/connect, update/run) out of every new box.
 */
export async function deviceHasOwner(): Promise<boolean> {
  if (readConfigFacts().passwordConfigured) return true;
  return (await hasOwnerPassword()) === true;
}

function readSessionCookie(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  const m = /(?:^|;\s*)clawbox_session=([^;]*)/.exec(raw);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function verifySignedCookie(cookie: string, secret: string, expectedGen: number): boolean {
  const dot = cookie.indexOf(".");
  if (dot < 0) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!payload || !/^[0-9a-f]{64}$/i.test(sig)) return false;

  try {
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(sig.toLowerCase(), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return false;
    // Cookies minted before the last password change are revoked.
    return (typeof data.gen === "number" ? data.gen : 0) === expectedGen;
  } catch {
    return false;
  }
}

/**
 * True when the request carries a valid session cookie or the MCP bearer.
 *
 * Deliberately does NOT honour `CLAWBOX_TEST_MODE`, unlike `requireSession`
 * below. The two answer different questions: `requireSession` is a GATE ("may
 * this request run at all"), and test mode is the documented escape hatch that
 * opens the whole /setup-api surface to the e2e-install harness. This is an
 * IDENTITY question ("is this the owner"), asked by handlers that shape their
 * response — `setup/status` serves a trimmed payload to anyone who isn't. A
 * harness that can reach a route still isn't the owner, and letting test mode
 * say otherwise would mean the trimmed payload is never exercised end-to-end.
 */
export async function hasValidSession(request: Request | undefined): Promise<boolean> {
  // Next.js always hands a Request to a route handler; a caller that doesn't
  // (an older test, a direct invocation) gets "not authenticated" rather than
  // a TypeError that a `catch` upstream could turn into a success path.
  if (!request || typeof request.headers?.get !== "function") return false;

  const authHeader = request.headers.get("authorization");
  if (authHeader && verifyMcpBearer(authHeader)) return true;

  const cookie = readSessionCookie(request);
  if (!cookie) return false;
  const secret = sessionSecret();
  if (!secret) return false;
  return verifySignedCookie(cookie, secret, readConfigFacts().sessionGeneration);
}

/**
 * Returns a 401 response when the caller may not run this route, or `null`
 * when it may. Mirrors middleware's decision order so the two can't disagree:
 * MCP bearer → session cookie → test mode → bootstrap window.
 */
export async function requireSession(
  request: Request | undefined,
  opts: RequireSessionOptions = {},
): Promise<NextResponse | null> {
  if (await hasValidSession(request)) return null;

  // Same escape hatch middleware §3b uses for the e2e-install harness, which
  // drives the whole wizard over HTTP with no cookie jar. install.sh only
  // writes this flag when it boots under CLAWBOX_TEST_MODE.
  if (process.env.CLAWBOX_TEST_MODE === "1") return null;

  if (opts.allowBootstrap && !(await deviceHasOwner())) return null;

  return NextResponse.json({ error: "Authentication required" }, { status: 401 });
}
