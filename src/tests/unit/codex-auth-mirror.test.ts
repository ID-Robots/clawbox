import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync } from "node:fs";
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

function seedProfile(access: string, refresh: string = "refresh-secret", profileKey = "codex:default") {
  writeFileSync(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      profiles: {
        [profileKey]: { access, refresh, id: "id-token" },
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
  it("keeps the refresh_token — core's credential reader hard-rejects without it", () => {
    // core: readCodexCliCredentials()
    //   if (typeof refreshToken !== "string" || !refreshToken) return null;
    // A null credential means the codex plugin attaches no auth (`profile=-`
    // in the gateway log) and every turn dies on 401. Stripping this field is
    // exactly how the first attempt at the rotation fix broke Codex.
    seedProfile(accessToken("acct-1"));
    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.refresh_token).toBe("refresh-secret");
    expect(parsed.tokens.access_token).toBe(accessToken("acct-1"));
  });

  it("writes CODEX_HOME too — the app-server is the only correct API path", () => {
    // Without a credential in <agentDir>/codex-home the app-server can't run,
    // codex falls back to core's HTTP transport, and that posts to a
    // Cloudflare-challenged browser endpoint.
    seedProfile(accessToken("acct-1"));
    run();

    expect(existsSync(homeAuthPath)).toBe(true);
    expect(existsSync(codexHomeAuthPath)).toBe(true);
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-secret");
  });

  it("adopts an app-server rotation instead of overwriting it with a spent token", () => {
    // The app-server rotated its CODEX_HOME credential. Refresh tokens are
    // single-use, so core's stored copy is now the DEAD one — writing it back
    // over the file would burn the family on next use.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-1", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-1",
        },
      }),
    );
    seedProfile(accessToken("acct-1", "old"), "refresh-spent");

    const out = run();

    expect(out).toContain("adopted app-server rotation");
    // The rotated token survives everywhere, including core's own store.
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
  });

  it("writes an adopted rotation back into the openai:chatgpt profile too", () => {
    // Same rotation as above, on a box signed in the OpenClaw 2 way. A
    // write-back that only knew the two older keys returned false here, so
    // core kept the spent refresh token and the next pass wrote it over the
    // live file.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-v2", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-v2",
        },
      }),
    );
    seedProfile(accessToken("acct-v2", "old"), "refresh-spent", "openai:chatgpt");

    const out = run();

    expect(out).toContain("adopted app-server rotation");
    const store = JSON.parse(readFileSync(path.join(agentDir, "auth-profiles.json"), "utf-8"));
    expect(store.profiles["openai:chatgpt"].refresh).toBe("refresh-rotated-by-appserver");
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
  });

  it("does not write the same file twice when codex-home is a symlink to ~/.codex", () => {
    // A previous version resolved both destinations to one file and then
    // deleted the real credential through the link.
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    symlinkSync(path.dirname(homeAuthPath), path.join(agentDir, "codex-home"));
    seedProfile(accessToken("acct-1"));

    run();

    expect(existsSync(homeAuthPath)).toBe(true);
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.access_token)
      .toBe(accessToken("acct-1"));
  });

  it("mirrors the access token and account id the runtime needs", () => {
    seedProfile(accessToken("acct-42"));
    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-42"));
    expect(parsed.tokens.account_id).toBe("acct-42");
    expect(parsed.tokens.id_token).toBe("id-token");
  });

  it("reads the profile OpenClaw 2 files the sign-in under (openai:chatgpt)", () => {
    // src/lib/chatgpt-subscription.ts: the sign-in is an openai-provider OAuth
    // profile now; a mirror that only knew the two older keys would leave
    // every freshly signed-in box with no credential in ~/.codex/auth.json.
    seedProfile(accessToken("acct-v2"), "refresh-secret", "openai:chatgpt");
    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-v2"));
    expect(parsed.tokens.account_id).toBe("acct-v2");
  });

  it("refreshes a stale credential when core has rotated the access token", () => {
    seedProfile(accessToken("acct-1", "old"));
    run();
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.access_token)
      .toBe(accessToken("acct-1", "old"));

    // Core rotated; the timer runs again.
    seedProfile(accessToken("acct-1", "new"));
    const out = run();

    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.access_token)
      .toBe(accessToken("acct-1", "new"));
    expect(out).toContain("refreshed");
  });

  it("never clobbers a drifted file with core's copy — the file is the newer one", () => {
    // Only the app-server rotates, so a refresh token that differs from core's
    // means the app-server moved on and core's copy is spent. Writing core's
    // value back over the file would hand a dead token to the next request.
    seedProfile(accessToken("acct-1"), "refresh-from-appserver");
    run();
    seedProfile(accessToken("acct-1"), "refresh-spent");
    run();

    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-from-appserver");
    // ...and core has been realigned to it rather than the other way round.
    const store = JSON.parse(
      readFileSync(path.join(agentDir, "auth-profiles.json"), "utf-8"),
    );
    expect(store.profiles["codex:default"].refresh).toBe("refresh-from-appserver");
  });

  it("is idempotent — a second run with no rotation rewrites nothing", () => {
    seedProfile(accessToken("acct-1"));
    run();
    const out = run();
    expect(out).toContain("credential already current");
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

    expect(statSync(homeAuthPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(homeAuthPath)).mode & 0o777).toBe(0o700);
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

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-sqlite"));
    expect(parsed.tokens.account_id).toBe("acct-sqlite");
    expect(parsed.tokens.refresh_token).toBe("refresh-secret");
  });

  it("mirrors into every agent, not just main", () => {
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(second, { recursive: true });
    seedProfile(accessToken("acct-1"));
    run();

    expect(existsSync(path.join(second, "codex-home", "auth.json"))).toBe(true);
  });
});

describe("gateway-pre-start.sh wiring", () => {
  const PRE_START = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

  it("delegates to the mirror script instead of inlining a credential writer", () => {
    const src = readFileSync(PRE_START, "utf-8");
    expect(src).toContain("scripts/codex-auth-mirror.js");
    // The inline heredoc that mirrored into every codex-home must stay gone.
    expect(src).not.toMatch(/codex-home", "auth\.json"/);
  });
});
