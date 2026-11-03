/**
 * The session cookie judged on the server, now and again later.
 *
 * Two callers. src/lib/route-auth.ts judges a request once, as it arrives — the
 * in-handler second line of defence behind the middleware. And a response that
 * goes on for minutes after that moment (a streamed Hermes chat turn,
 * src/lib/harness/hermes-live-turn.ts) holds a {@link SessionLease}: the same
 * judgement, repeatable, so the response can end when the session does.
 * scripts/upgrade-session-watch.js does that for sockets; this is the HTTP half
 * of SUP-1017 (TASK-2131), where a Hermes answer kept streaming to a browser
 * whose session had run out halfway through it.
 *
 * Deliberately self-contained, like route-auth always was: it reads
 * data/config.json and data/.session-secret directly rather than going through
 * `@/lib/config-store` and `@/lib/auth`. That mirrors the middleware's own
 * resolution (so the two cannot drift), keeps the check independent of the app
 * modules it is defending, and means a route test that mocks config-store does
 * not mock the session check out of existence. It also imports nothing that
 * spawns a process, so a chat route — whose tests stand in for child_process —
 * can hold a lease without dragging route-auth's password helpers in.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import path from "./runtime-path";
import { ownerUsername } from "./owner-username";
import {
  USERS_CONFIG_KEY,
  identityFromClaims,
  parseUserRegistry,
  registryVersions,
  type SessionIdentity,
} from "./session-identity";

function dataDir(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data");
}

export interface ConfigFacts {
  setupComplete: boolean;
  passwordConfigured: boolean;
  sessionGeneration: number;
  /** Non-owner users (TASK-1256): username → session version. */
  users: ReadonlyMap<string, string>;
}

const NO_USERS: ReadonlyMap<string, string> = new Map();

/**
 * Fail-closed config read. A config.json that is genuinely absent is a
 * first-boot device (no owner). Any other read/parse failure is a provisioned
 * box with a damaged file, and is treated as "has an owner" so a corrupt or
 * clobbered config can't reopen the bootstrap window.
 */
export function readConfigFacts(): ConfigFacts {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      setup_complete?: unknown;
      password_configured?: unknown;
      session_generation?: unknown;
      [USERS_CONFIG_KEY]?: unknown;
    };
    const gen = typeof parsed.session_generation === "number" && Number.isFinite(parsed.session_generation)
      ? parsed.session_generation
      : 0;
    return {
      setupComplete: parsed.setup_complete === true,
      passwordConfigured: parsed.password_configured === true,
      sessionGeneration: gen,
      users: registryVersions(parseUserRegistry(parsed[USERS_CONFIG_KEY], ownerUsername())),
    };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { setupComplete: !missing, passwordConfigured: !missing, sessionGeneration: 0, users: NO_USERS };
  }
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

/** The `clawbox_session` cookie a request carries, decoded, or null. */
export function readSessionCookie(request: Request): string | null {
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

function verifySignedCookie(cookie: string, secret: string, expectedGen: number): Record<string, unknown> | null {
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!payload || !/^[0-9a-f]{64}$/i.test(sig)) return null;

  try {
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(sig.toLowerCase(), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data !== "object" || data === null) return null;
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return null;
    // Cookies minted before the last password change are revoked.
    if ((typeof data.gen === "number" ? data.gen : 0) !== expectedGen) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A session cookie judged NOW — signature, expiry, generation, and whether the
 * person it names may still sign in — as its claims and whom they speak for,
 * or null when this box would not admit it.
 */
export function judgeSessionCookie(cookie: string): { claims: Record<string, unknown>; identity: SessionIdentity } | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const facts = readConfigFacts();
  const claims = verifySignedCookie(cookie, secret, facts.sessionGeneration);
  if (!claims) return null;
  const identity = identityFromClaims(claims, ownerUsername(), facts.users);
  return identity ? { claims, identity } : null;
}

/** The session a long-lived response was admitted on. */
export interface SessionLease {
  /** When the admitting cookie runs out (its own `exp`), in ms since the epoch. */
  readonly expiresAt: number;
  /**
   * Whether this box would still admit that same cookie now: false once it has
   * run out, or a password change or a removed user has revoked it.
   */
  stillValid(): boolean;
}

/**
 * The lease of the request's session cookie, or null when it carries none this
 * box honours. Null also for the agent's MCP bearer and the test harness, which
 * have no session to outlive: only a cookie-admitted response is bounded by it.
 */
export function sessionLease(request: Request | undefined): SessionLease | null {
  if (!request || typeof request.headers?.get !== "function") return null;
  const cookie = readSessionCookie(request);
  if (!cookie) return null;
  const judged = judgeSessionCookie(cookie);
  if (!judged || typeof judged.claims.exp !== "number") return null;
  return {
    expiresAt: judged.claims.exp * 1000,
    stillValid: () => judgeSessionCookie(cookie) !== null,
  };
}
