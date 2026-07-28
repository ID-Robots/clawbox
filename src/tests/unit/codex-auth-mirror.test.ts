import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/codex-auth-mirror.js copies the ChatGPT/Codex credential out of
// core's auth profile store into the Codex CLI-style auth.json files the Codex
// runtime reads. The invariant it exists to protect:
//
//   EXACTLY ONE HOLDER MAY CARRY refresh_token.
//
// ChatGPT OAuth refresh tokens are single-use and rotating. 3.1.11 mirrored the
// refresh token into every agent's codex-home/auth.json, which the Codex
// app-server then rotated independently of core — two rotators, one token
// family, and every box signed in with ChatGPT died with
// `401 refresh_token_reused` a few hours after setup. See #278.
//
// These tests run the real shipped script against a temp OPENCLAW_HOME so a
// regression that reintroduces refresh_token (or stops self-healing a poisoned
// mirror) fails here rather than on a customer's box overnight.

const SCRIPT = path.resolve(process.cwd(), "scripts/codex-auth-mirror.js");

// Minimal JWT whose payload carries the ChatGPT account id claim.
function accessToken(accountId: string, marker = "a"): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `hdr.${payload}.sig-${marker}`;
}

let home: string;
let openclawHome: string;
let agentDir: string;
let homeAuthPath: string;
let codexHomeAuthPath: string;

function seedProfile(access: string, refresh = "refresh-secret") {
  writeFileSync(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      profiles: {
        "codex:default": { access, refresh, id: "id-token" },
      },
    }),
  );
}

function run(): string {
  return execFileSync("node", [SCRIPT, openclawHome, homeAuthPath], {
    encoding: "utf-8",
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "codex-auth-mirror-"));
  openclawHome = path.join(home, ".openclaw");
  agentDir = path.join(openclawHome, "agents", "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  homeAuthPath = path.join(home, ".codex", "auth.json");
  codexHomeAuthPath = path.join(agentDir, "codex-home", "auth.json");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("codex-auth-mirror.js", () => {
  it("never writes a refresh_token into any mirror", () => {
    seedProfile(accessToken("acct-1"));
    run();

    for (const file of [homeAuthPath, codexHomeAuthPath]) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      expect(parsed.tokens.refresh_token).toBeUndefined();
      // The whole serialized file, so a refresh token can't sneak in elsewhere.
      expect(readFileSync(file, "utf-8")).not.toContain("refresh-secret");
    }
  });

  it("mirrors the access token and account id the runtime needs", () => {
    seedProfile(accessToken("acct-42"));
    run();

    const parsed = JSON.parse(readFileSync(codexHomeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-42"));
    expect(parsed.tokens.account_id).toBe("acct-42");
    expect(parsed.tokens.id_token).toBe("id-token");
  });

  it("writes to CODEX_HOME as well as ~/.codex — the app-server only reads the former", () => {
    seedProfile(accessToken("acct-1"));
    run();

    expect(existsSync(homeAuthPath)).toBe(true);
    expect(existsSync(codexHomeAuthPath)).toBe(true);
  });

  it("self-heals a mirror poisoned by 3.1.11", () => {
    // Exactly what 3.1.11 left on disk: a mirror carrying the refresh token.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-1"),
          refresh_token: "poisoned-rotating-token",
          account_id: "acct-1",
        },
      }),
    );
    seedProfile(accessToken("acct-1"));

    const out = run();

    const parsed = JSON.parse(readFileSync(codexHomeAuthPath, "utf-8"));
    expect(parsed.tokens.refresh_token).toBeUndefined();
    expect(out).toContain("stripped refresh_token");
  });

  it("refreshes a stale mirror when core has rotated the access token", () => {
    seedProfile(accessToken("acct-1", "old"));
    run();
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.access_token)
      .toBe(accessToken("acct-1", "old"));

    // Core rotated; the timer runs again.
    seedProfile(accessToken("acct-1", "new"));
    const out = run();

    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.access_token)
      .toBe(accessToken("acct-1", "new"));
    expect(out).toContain("refreshed");
  });

  it("is idempotent — a second run with no rotation rewrites nothing", () => {
    seedProfile(accessToken("acct-1"));
    run();
    const out = run();
    expect(out).toContain("mirrors already current");
  });

  it("preserves a user's OPENAI_API_KEY — that path has no rotation problem", () => {
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    writeFileSync(
      homeAuthPath,
      JSON.stringify({ OPENAI_API_KEY: "sk-user-key", tokens: {} }),
    );
    seedProfile(accessToken("acct-1"));
    run();

    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).OPENAI_API_KEY).toBe("sk-user-key");
  });

  it("writes credentials owner-only", () => {
    seedProfile(accessToken("acct-1"));
    run();

    for (const file of [homeAuthPath, codexHomeAuthPath]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("exits cleanly before login instead of blocking gateway start", () => {
    const out = run(); // no profile seeded at all
    expect(out).toContain("no codex OAuth profile yet");
    expect(existsSync(homeAuthPath)).toBe(false);
  });

  it("reads the sqlite auth_profile_store — where core 2026.7.x actually keeps the login", () => {
    // Real boxes have no auth-profiles.json: core moved profiles into
    // openclaw-agent.sqlite. If this path regresses, the mirror silently writes
    // nothing and every ChatGPT box is back to `401 Missing bearer`.
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)");
    db.prepare("INSERT INTO auth_profile_store (store_key, store_json) VALUES (?, ?)").run(
      "primary",
      JSON.stringify({
        profiles: {
          "codex:default": {
            access: accessToken("acct-sqlite"),
            refresh: "refresh-secret",
            id: "id-token",
          },
        },
      }),
    );
    db.close();

    run();

    const parsed = JSON.parse(readFileSync(codexHomeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-sqlite"));
    expect(parsed.tokens.account_id).toBe("acct-sqlite");
    expect(parsed.tokens.refresh_token).toBeUndefined();
    expect(readFileSync(codexHomeAuthPath, "utf-8")).not.toContain("refresh-secret");
  });

  it("mirrors into every agent, not just main", () => {
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(second, { recursive: true });
    seedProfile(accessToken("acct-1"));
    run();

    const secondMirror = path.join(second, "codex-home", "auth.json");
    expect(existsSync(secondMirror)).toBe(true);
    expect(JSON.parse(readFileSync(secondMirror, "utf-8")).tokens.refresh_token).toBeUndefined();
  });
});

describe("gateway-pre-start.sh wiring", () => {
  const PRE_START = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

  it("delegates to the mirror script instead of inlining a credential writer", () => {
    const src = readFileSync(PRE_START, "utf-8");
    expect(src).toContain("scripts/codex-auth-mirror.js");
    // The inline heredoc that planted refresh tokens must be gone for good.
    expect(src).not.toMatch(/refresh_token:\s*p\.refresh/);
  });
});
