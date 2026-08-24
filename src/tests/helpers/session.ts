/**
 * Test helpers for the in-handler session guard (`@/lib/route-auth`).
 *
 * `route-auth` deliberately reads data/config.json and data/.session-secret off
 * disk instead of going through `@/lib/config-store` / `@/lib/auth`, so it can't
 * be mocked out from under the route it's protecting. These helpers set up that
 * on-disk state under a temp CLAWBOX_ROOT and mint a matching cookie.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const SECRET = "test-session-secret-0123456789abcdef";

export interface SessionFixture {
  root: string;
  /** `Cookie` header value carrying a valid session. */
  cookie: string;
  cleanup: () => void;
}

export interface SessionFixtureOptions {
  /** Written to config.json. Defaults to a provisioned device (owner exists). */
  passwordConfigured?: boolean;
  setupComplete?: boolean;
  sessionGeneration?: number;
}

/** Sign a session cookie the way `route-auth` verifies it. */
export function signSessionCookie(
  opts: { expiresInSeconds?: number; gen?: number; secret?: string } = {},
): string {
  const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 3600);
  const payload = Buffer.from(JSON.stringify({ exp, gen: opts.gen ?? 0 })).toString("base64url");
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Point CLAWBOX_ROOT at a temp dir holding a config.json and a session secret,
 * and return a cookie header that authenticates against them. Call `cleanup()`
 * in afterEach.
 */
export function installSessionFixture(opts: SessionFixtureOptions = {}): SessionFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-session-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      password_configured: opts.passwordConfigured ?? true,
      setup_complete: opts.setupComplete ?? true,
      session_generation: opts.sessionGeneration ?? 0,
    }),
  );
  fs.writeFileSync(path.join(dataDir, ".session-secret"), SECRET, { mode: 0o600 });

  const previousRoot = process.env.CLAWBOX_ROOT;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.CLAWBOX_ROOT = root;
  // route-auth prefers SESSION_SECRET; keep both in agreement so a test that
  // leaves the env var set from elsewhere can't silently pass.
  process.env.SESSION_SECRET = SECRET;

  return {
    root,
    cookie: `clawbox_session=${signSessionCookie({ gen: opts.sessionGeneration ?? 0 })}`,
    cleanup() {
      if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = previousRoot;
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
