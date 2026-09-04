import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, chmodSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// vite cannot bundle the builtin; a test file is never bundled, so reaching it
// lazily here is safe (same rule as openclaw-session-store.test.ts).
const requireNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireNodeSqlite("node:sqlite");

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

/** The per-agent credential table, the only source before the 2026.8 relocation. */
function seedAgentStore(profiles: Record<string, unknown>): void {
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)",
  );
  db.prepare(
    "INSERT OR REPLACE INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
  ).run("primary", JSON.stringify({ version: 1, profiles }), Date.now());
  db.close();
}

/**
 * The gateway-wide store `openclaw doctor --fix` relocates the profiles into:
 * `<stateDir>/state/openclaw.sqlite`, table `config_machine_state`, row
 * `authProfiles.store`. Column names are the shipped ones (the core's own
 * downgrade SQL selects `value_json, updated_at_ms` from this table).
 */
function sharedStorePath(): string {
  return path.join(openclawHome, "state", "openclaw.sqlite");
}

function seedSharedStore(
  profiles: Record<string, unknown>,
  ownership: { location: string } | null = { location: "state-db" },
): void {
  mkdirSync(path.dirname(sharedStorePath()), { recursive: true });
  const db = new DatabaseSync(sharedStorePath());
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
  );
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  );
  upsert.run("authProfiles.store", JSON.stringify({ version: 1, profiles }), Date.now());
  // `auth.sharedStore` is the row core keys the decision on: it resolves the
  // shared store from THIS database only when the location is `state-db`, and
  // from `<stateDir>/agents/main/agent/openclaw-agent.sqlite` otherwise. A box
  // that has been through `doctor --fix` carries the row, so the fixture does.
  if (ownership) upsert.run("auth.sharedStore", JSON.stringify(ownership), Date.now());
  db.close();
}

function readAgentStore(): { profiles: Record<string, { access?: string; refresh?: string; key?: string }> } {
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), { readOnly: true });
  const row = db
    .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
    .get("primary") as { store_json: string };
  db.close();
  return JSON.parse(row.store_json);
}

function readSharedStore(): { profiles: Record<string, { access?: string; refresh?: string }> } {
  const db = new DatabaseSync(sharedStorePath(), { readOnly: true });
  const row = db
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get("authProfiles.store") as { value_json: string };
  db.close();
  return JSON.parse(row.value_json);
}

function run(): string {
  // Pinned, not inherited: the script honours OPENCLAW_STATE_DIR when resolving
  // the shared store, and CODEX_AUTH_MIRROR_QUIET suppresses the log lines
  // other tests assert on. Either one exported on a dev machine or a CI job
  // would silently point the child at another database.
  return execFileSync("node", [SCRIPT, openclawHome, homeAuthPath], {
    encoding: "utf-8",
    env: { ...process.env, OPENCLAW_STATE_DIR: "", CODEX_AUTH_MIRROR_QUIET: "" },
  });
}

/** The same run as `run()`, with both streams captured instead of stdout only. */
function runCapturing(): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [SCRIPT, openclawHome, homeAuthPath], {
    encoding: "utf-8",
    env: { ...process.env, OPENCLAW_STATE_DIR: "", CODEX_AUTH_MIRROR_QUIET: "" },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The same script, run as the TIMER runs it (`CODEX_AUTH_MIRROR_QUIET=1`), with
 * `fs.chmodSync` failing on the paths ending in `targetSuffix` and on nothing
 * else, and both streams captured.
 *
 * The syscall is faulted from a `--require` preload rather than stubbed in this
 * process: the script is a real child, and an unprivileged test cannot provoke
 * an EPERM on a file it owns — while a CI job running as root could not provoke
 * one at all. `writeMirror` chmods two things per destination, the containing
 * directory and the `auth.json`, so the suffix picks exactly one of them and
 * the other is left working.
 */
function runWithFailingChmod(targetSuffix: string): { stdout: string; stderr: string; status: number | null } {
  const preload = path.join(home, "chmod-fault.cjs");
  writeFileSync(
    preload,
    [
      'const fs = require("node:fs");',
      "const real = fs.chmodSync;",
      `const suffix = ${JSON.stringify(targetSuffix)};`,
      "fs.chmodSync = (target, mode) => {",
      "  if (String(target).endsWith(suffix)) {",
      '    const error = new Error("EPERM: operation not permitted, chmod");',
      '    error.code = "EPERM";',
      "    throw error;",
      "  }",
      "  return real(target, mode);",
      "};",
      "",
    ].join("\n"),
  );
  const result = spawnSync("node", ["--require", preload, SCRIPT, openclawHome, homeAuthPath], {
    encoding: "utf-8",
    env: { ...process.env, OPENCLAW_STATE_DIR: "", CODEX_AUTH_MIRROR_QUIET: "1" },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The same run again, faulting `fs.mkdirSync` on one exact directory: the shape
 * an `<agentDir>` the owner cannot write produces when the mirror tries to
 * create its `codex-home` (EACCES). Faulted rather than chmodded for the same
 * reason as the chmod fixture — a CI job running as root cannot be denied a
 * mkdir by any permission bits.
 */
function runWithFailingMkdir(target: string): { stdout: string; stderr: string; status: number | null } {
  const preload = path.join(home, "mkdir-fault.cjs");
  writeFileSync(
    preload,
    [
      'const fs = require("node:fs");',
      "const real = fs.mkdirSync;",
      `const target = ${JSON.stringify(target)};`,
      "fs.mkdirSync = (dir, options) => {",
      "  if (String(dir) === target) {",
      '    const error = new Error("EACCES: permission denied, mkdir");',
      '    error.code = "EACCES";',
      "    throw error;",
      "  }",
      "  return real(dir, options);",
      "};",
      "",
    ].join("\n"),
  );
  const result = spawnSync("node", ["--require", preload, SCRIPT, openclawHome, homeAuthPath], {
    encoding: "utf-8",
    env: { ...process.env, OPENCLAW_STATE_DIR: "", CODEX_AUTH_MIRROR_QUIET: "1" },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The agents' `codex-home` directories in the order main() will visit them.
 * Read through the same `readdirSync` the script uses, because that order is
 * the filesystem's rather than alphabetical: a test that assumed one would only
 * sometimes put the faulted destination IN FRONT of the survivor, and only then
 * prove that a failure there does not cost the destinations behind it.
 */
function agentCodexHomes(): string[] {
  const agentsRoot = path.join(openclawHome, "agents");
  return readdirSync(agentsRoot)
    .map((id) => path.join(agentsRoot, id, "agent"))
    .filter((dir) => existsSync(dir))
    .map((dir) => path.join(dir, "codex-home"));
}

/**
 * Every destination main() will visit, in its own order, and the ones a pass
 * actually left holding the credential. Asserting on the NAMES rather than a
 * count is the point: what an aborted destinations loop costs is a specific
 * file the box no longer has, and only the names say which.
 */
function allDestinations(): string[] {
  return [homeAuthPath, ...agentCodexHomes().map((dir) => path.join(dir, "auth.json"))];
}

function mirrored(refreshToken: string): string[] {
  return allDestinations().filter((file) => {
    try {
      return JSON.parse(readFileSync(file, "utf-8")).tokens.refresh_token === refreshToken;
    } catch {
      return false; // Missing, or not a credential file at all.
    }
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

  it("reads the first profile that carries a credential — a bare canonical entry does not hide a legacy one", () => {
    writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        profiles: {
          "openai:chatgpt": { provider: "openai", type: "oauth" },
          "codex:default": { access: accessToken("acct-legacy"), refresh: "refresh-secret", id: "id-token" },
        },
      }),
    );
    run();

    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.account_id).toBe("acct-legacy");
  });

  it("writes a rotation back into the profile it READ, not into a half-written canonical one", () => {
    // A sign-in interrupted after the entry was created but before the
    // credential landed: `openai:chatgpt` exists with no `access`, beside a
    // legacy `codex:default` that still works. The mirror reads the legacy
    // one — and used to write the rotated token into the empty canonical one,
    // leaving the entry it reads NEXT holding a refresh token already spent.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-legacy", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-legacy",
        },
      }),
    );
    writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        profiles: {
          "openai:chatgpt": { provider: "openai", type: "oauth" },
          "codex:default": { access: accessToken("acct-legacy", "old"), refresh: "refresh-spent", id: "id-token" },
        },
      }),
    );

    run();

    const store = JSON.parse(readFileSync(path.join(agentDir, "auth-profiles.json"), "utf-8"));
    expect(store.profiles["codex:default"].refresh).toBe("refresh-rotated-by-appserver");
    expect(store.profiles["openai:chatgpt"].refresh).toBeUndefined();
  });

  it("writes an adopted rotation back into the openai:chatgpt profile in the SQLite store too", () => {
    // The route above seeds the legacy JSON file, which the mirror reads
    // first; a 2026.8 box holds the store in SQLite only, and the write-back
    // that reaches it is a second code path with its own key lookup.
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
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO auth_profile_store (store_key, store_json) VALUES (?, ?)").run(
      "primary",
      JSON.stringify({
        profiles: {
          "openai:chatgpt": { access: accessToken("acct-v2", "old"), refresh: "refresh-spent", id: "id-token" },
        },
      }),
    );
    db.close();

    const out = run();

    expect(out).toContain("adopted app-server rotation");
    const reopened = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    const row = reopened.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json: string };
    reopened.close();
    expect(JSON.parse(row.store_json).profiles["openai:chatgpt"].refresh).toBe("refresh-rotated-by-appserver");
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

  it("reads the shared state-db store when the per-agent table is empty", () => {
    // Measured on the pinned core (OpenClaw 2026.8.1) on the OpenClaw box: the
    // per-agent `auth_profile_store` row exists with ZERO profiles while
    // `openclaw models auth list` reports eight, because `doctor --fix`
    // relocated the store to `state/openclaw.sqlite`
    // (`config_machine_state['authProfiles.store']`; the box records
    // `auth.sharedStore = {"location":"state-db"}`). Core resolves an agent
    // that has no local profile through that shared store — read-through
    // inheritance, docs/auth-credential-semantics.md in the installed package.
    //
    // The mirror read only the per-agent table, found an empty map, logged
    // "no codex OAuth profile yet, skipping" and left ~/.codex/auth.json
    // stale, so the owner's real ChatGPT sign-in never reached the Codex
    // runtime and every turn went out on the API-key profile and 401ed.
    seedAgentStore({});
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-shared"),
        refresh: "refresh-shared",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.access_token).toBe(accessToken("acct-shared"));
    expect(parsed.tokens.refresh_token).toBe("refresh-shared");
    expect(parsed.tokens.account_id).toBe("acct-shared");
  });

  it("still writes the plugin's own file when a codex-home rotation cannot be recorded", () => {
    // The skip is PER DESTINATION. `~/.codex/auth.json` is not a CODEX_HOME for
    // anything — the codex plugin reads it and never writes it — so a
    // divergence there is a stale copy and must be repaired. Only the
    // app-server's own file is left alone, and only because overwriting a live
    // rotation with core's spent copy is what burnt the family in #278.
    //
    // Abandoning the whole pass instead is worse than the bug: the ChatGPT
    // sign-in route DELETES ~/.codex/auth.json so this script recreates it, so
    // a box would come out of a re-login with no credential for the plugin at
    // all and every turn dying on `401 Missing bearer`.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-shared", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-shared",
        },
      }),
    );
    seedAgentStore({});
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-shared", "core"),
        refresh: "refresh-core",
        expires: Date.now() + 3_600_000,
      },
    });

    chmodSync(codexHomeAuthPath, 0o644);
    const skippedMtime = statSync(codexHomeAuthPath).mtimeMs;

    run();

    // The app-server's file is untouched...
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
    expect(statSync(codexHomeAuthPath).mtimeMs).toBe(skippedMtime);
    // ...but "left alone" is about its CONTENT. On a 2026.8 box this file keeps
    // that refresh token for the life of the box, so a mode nobody enforces is
    // a mode that never gets fixed — and a chmod overwrites no credential.
    expect(statSync(codexHomeAuthPath).mode & 0o777).toBe(0o600);
    // ...core's gateway-wide row is not rewritten from a timer...
    expect(readSharedStore().profiles["openai:chatgpt"].refresh).toBe("refresh-core");
    // ...and the plugin still gets a credential.
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token).toBe("refresh-core");
  });

  it("realigns a stale ~/.codex/auth.json — the state the reported box was in", () => {
    // The box in the report had a `~/.codex/auth.json` from Aug 27, predating
    // the sign-in. A fix that only creates the file when it is absent would
    // have left that box exactly where it was.
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    writeFileSync(
      homeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-old", "stale"),
          refresh_token: "refresh-from-a-previous-account",
          account_id: "acct-old",
        },
      }),
    );
    seedAgentStore({});
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-shared"),
        refresh: "refresh-shared",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.refresh_token).toBe("refresh-shared");
    expect(parsed.tokens.account_id).toBe("acct-shared");
  });

  it("prefers an agent's own profile over the shared one under the same id", () => {
    // Core's inheritance is a shallow per-id override with the agent's own
    // entry on top (mergeProfileRecordsWithOverridePrecedence). Merging the
    // other way round would hand the Codex runtime a credential core does not
    // resolve — and the direction is the load-bearing half of the merge.
    seedAgentStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-local"),
        refresh: "refresh-local",
        expires: Date.now() + 3_600_000,
      },
    });
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-shared"),
        refresh: "refresh-shared",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-local");
    expect(parsed.tokens.refresh_token).toBe("refresh-local");
  });

  it("writes a rotation back into the id it READ, not another the local table happens to carry", () => {
    // The merge made the read set wider than any one store, so "some
    // ChatGPT-shaped key in the local table" can be a different entry entirely.
    // Grafting an OAuth bundle onto an API key the owner pasted produces a
    // credential core cannot classify, and leaves the entry core DOES resolve
    // holding a refresh token the app-server has already spent.
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-shared", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-shared",
        },
      }),
    );
    seedAgentStore({ "openai:chatgpt": { type: "api_key", provider: "openai", key: "sk-owner-key" } });
    seedSharedStore({
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-shared", "core"),
        refresh: "refresh-core",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    // The owner's API key is not turned into half an OAuth profile.
    const local = readAgentStore().profiles["openai:chatgpt"];
    expect(local.refresh).toBeUndefined();
    expect(local.key).toBe("sk-owner-key");
  });

  it("mirrors into every agent, not just main", () => {
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(second, { recursive: true });
    seedProfile(accessToken("acct-1"));
    run();

    expect(existsSync(path.join(second, "codex-home", "auth.json"))).toBe(true);
  });

  it("prefers a LIVE local profile over an EXPIRED shared one filed under a preferred id", () => {
    // Reading both stores widened the candidate set; the ranking did not
    // follow. `openai:chatgpt` heads PROFILE_KEYS, so a shared entry whose
    // access token expired two hours ago outranked the agent's OWN live
    // credential — and `openai:default` is exactly the id `doctor --fix`
    // allocates when it migrates a legacy `openai-codex:default`. The Codex
    // runtime then got a spent refresh token rewritten over a live one every
    // ten minutes, and every turn 401ed.
    //
    // Core ranks by usability, never by id: `orderProfilesByMode` sorts oauth
    // before token before api_key, then an unexpired credential ahead of an
    // expired one (`resolveTokenExpiryState`) — openclaw dist/order-*.js.
    seedAgentStore({
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-local"),
        refresh: "refresh-local-live",
        expires: Date.now() + 3_600_000,
      },
    });
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-shared"),
        refresh: "refresh-shared-stale",
        expires: Date.now() - 7_200_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-local");
    expect(parsed.tokens.refresh_token).toBe("refresh-local-live");
  });

  it("prefers the LIVE shared profile when the agent's own copy is the expired one", () => {
    // The same rule in the other direction, so the fix cannot degenerate into
    // "always prefer the agent's own": here the local entry heads PROFILE_KEYS
    // and is dead, and the shared one is the sign-in that still works.
    seedAgentStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-local"),
        refresh: "refresh-local-stale",
        expires: Date.now() - 7_200_000,
      },
    });
    seedSharedStore({
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-shared"),
        refresh: "refresh-shared-live",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-shared");
    expect(parsed.tokens.refresh_token).toBe("refresh-shared-live");
  });

  it("ranks a profile with no `expires` BELOW a live one, even under a preferred id", () => {
    // The middle tier. An entry with no usable `expires` is not "expired" —
    // core says the same (`resolveTokenExpiryState` returns `missing`, and only
    // `expired` scores) — but it is not evidence of life either, so it must not
    // tie with a credential this box can see is still valid and then win on
    // `openai:chatgpt` heading PROFILE_KEYS. Two tiers did exactly that.
    seedAgentStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-unknown"),
        refresh: "refresh-unknown",
      },
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-live"),
        refresh: "refresh-live",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-live");
    expect(parsed.tokens.refresh_token).toBe("refresh-live");
  });

  it("ranks a profile with no `expires` ABOVE an expired one — unknown is not dead", () => {
    // The other side of the same tier, so it cannot degenerate into "treat
    // unknown as expired": expiry only ever DEMOTES here, it never drops a
    // candidate, because a dead credential still beats none and core keeps an
    // expired OAuth profile eligible and refreshes it.
    seedAgentStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-expired"),
        refresh: "refresh-expired",
        expires: Date.now() - 7_200_000,
      },
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-unknown"),
        refresh: "refresh-unknown",
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-unknown");
    expect(parsed.tokens.refresh_token).toBe("refresh-unknown");
  });

  it("leaves the state-db store unread on a legacy-main box — core does not resolve through it", () => {
    // An ABSENT `auth.sharedStore` row means `legacy-main`
    // (`parseSharedAuthStoreOwnership`), and core then resolves the shared
    // store from `<stateDir>/agents/main/agent/openclaw-agent.sqlite` — never
    // from this row (`resolveSharedAuthStorePath`). Reading it anyway mirrors a
    // credential core does not resolve. The shared entry here is the fresher of
    // the two, so only knowing which store is authoritative can pick the right
    // one.
    seedAgentStore({
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-local"),
        refresh: "refresh-local-live",
        expires: Date.now() + 3_600_000,
      },
    });
    seedSharedStore(
      {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: accessToken("acct-shared"),
          refresh: "refresh-shared",
          expires: Date.now() + 7_200_000,
        },
      },
      null,
    );

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-local");
    expect(parsed.tokens.refresh_token).toBe("refresh-local-live");
  });

  it("realigns a stale ~/.codex/auth.json when codex-home is a symlink to it and core cannot be written back", () => {
    // The precondition is load-bearing and is the 2026.8 state: `doctor --fix`
    // has emptied the per-agent table, so `writeBackToCore` cannot succeed and
    // the could-not-record branch runs. On a box whose store IS writable the
    // stale file is instead adopted as a rotation — that is the older,
    // untouched hazard recorded against this file, not what this test pins.
    // dedupePaths collapses both destinations onto the plugin's own file, and
    // that one surviving path is then also an app-server home — so a
    // divergence there put the ONLY destination in `skip` and the plugin kept
    // reading the previous account's token for the life of the box. On a box
    // where the two are one file, the plugin's need for a usable credential
    // outranks the rotation risk: abandoning it is exactly the `401 Missing
    // bearer` this script exists to prevent.
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    symlinkSync(path.dirname(homeAuthPath), path.join(agentDir, "codex-home"));
    writeFileSync(
      homeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-old"),
          refresh_token: "refresh-previous-signin",
          account_id: "acct-old",
        },
      }),
    );
    seedAgentStore({});
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-live"),
        refresh: "refresh-live",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.refresh_token).toBe("refresh-live");
    expect(parsed.tokens.account_id).toBe("acct-live");
  });

  it("writes a rotation back only into the agent it read the credential from", () => {
    // A profile id is a key inside ONE agent's store, not a fleet-wide
    // identity. A second agent can hold the same id for a different account,
    // and grafting this rotation onto it replaces a refresh token that belongs
    // to someone else — its next refresh then fails with refresh_token_reused.
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(second, { recursive: true });
    writeFileSync(
      path.join(second, "auth-profiles.json"),
      JSON.stringify({
        profiles: {
          "codex:default": {
            access: accessToken("acct-support"),
            refresh: "refresh-support-account",
            id: "id-token",
          },
        },
      }),
    );
    seedProfile(accessToken("acct-main"), "refresh-spent");
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(
      codexHomeAuthPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken("acct-main", "rotated"),
          refresh_token: "refresh-rotated-by-appserver",
          account_id: "acct-main",
        },
      }),
    );

    run();

    const supportStore = JSON.parse(
      readFileSync(path.join(second, "auth-profiles.json"), "utf-8"),
    );
    expect(supportStore.profiles["codex:default"].refresh).toBe("refresh-support-account");
    const mainStore = JSON.parse(
      readFileSync(path.join(agentDir, "auth-profiles.json"), "utf-8"),
    );
    expect(mainStore.profiles["codex:default"].refresh).toBe("refresh-rotated-by-appserver");
  });

  it("adopts NEITHER rotation when two app-server homes have rotated independently", () => {
    // Two agents run two app-servers, each rotating its own CODEX_HOME. Core's
    // store holds one refresh token per profile, so it can record one of them —
    // and adopting either discards the other, immediately (it is rewritten from
    // the adopted token) or on the next tick (it becomes the sole divergence
    // and overwrites the first). Two tokens of one family written into core ten
    // minutes apart is the `refresh_token_reused` shape #278 was. With no
    // correct single answer, both files are left exactly as they are and core
    // is not written at all.
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(path.join(second, "codex-home"), { recursive: true });
    const secondAuthPath = path.join(second, "codex-home", "auth.json");
    const mirror = (marker: string, refresh: string) => JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: accessToken("acct-1", marker),
        refresh_token: refresh,
        account_id: "acct-1",
      },
    });
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(codexHomeAuthPath, mirror("main-rotated", "refresh-rotated-by-main"));
    writeFileSync(secondAuthPath, mirror("support-rotated", "refresh-rotated-by-support"));
    seedProfile(accessToken("acct-1"), "refresh-spent");

    run();

    expect(JSON.parse(readFileSync(secondAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-support");
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-main");
    // ...and core still holds its own token; neither rotation was recorded.
    const store = JSON.parse(readFileSync(path.join(agentDir, "auth-profiles.json"), "utf-8"));
    expect(store.profiles["codex:default"].refresh).toBe("refresh-spent");
  });

  it("mirrors the owner's ChatGPT sign-in, not the older Codex CLI login beside it", () => {
    // The reported box's shared store, measured read-only: an `openai:default`
    // api_key holding a ClawBox proxy key, a `codex:default` OAuth login from a
    // Codex CLI sign-in eight days earlier, and the owner's own `openai:chatgpt`
    // OAuth sign-in — with the per-agent table emptied by `doctor --fix`. Both
    // mirror files were frozen on the codex:default credential and the script
    // logged "no codex OAuth profile yet, skipping" on every boot.
    //
    // The api_key entry must not be a candidate at all (it is not an OAuth
    // sign-in), and between the two OAuth entries the one issued most recently
    // — the owner's — is the credential to mirror.
    seedAgentStore({});
    seedSharedStore({
      "openai:default": { type: "api_key", provider: "openai", key: "proxy-key-not-an-oauth-signin" },
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-codex-cli"),
        refresh: "refresh-codex-cli",
        expires: Date.now() + 3 * 24 * 3_600_000,
      },
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-owner-signin"),
        refresh: "refresh-owner-signin",
        expires: Date.now() + 9 * 24 * 3_600_000,
      },
    });

    run();

    for (const dest of [homeAuthPath, codexHomeAuthPath]) {
      const parsed = JSON.parse(readFileSync(dest, "utf-8"));
      expect(parsed.tokens.account_id).toBe("acct-owner-signin");
      expect(parsed.tokens.refresh_token).toBe("refresh-owner-signin");
    }
  });

  it("still mirrors the sign-in when it carries the SHORTEST expiry on the box", () => {
    // `expires` is issue time PLUS that client's token lifetime, and the
    // lifetimes differ: the reported box carries +4029 min on `codex:default`
    // and +13675 min on `openai:chatgpt`, and ClawBox's own sign-in writer
    // stamps `Date.now() + expiresIn*1000`, falling back to eight hours
    // (configure/route.ts). So a brand-new ChatGPT sign-in routinely holds the
    // SMALLEST expiry on a box that has ever run `codex login` — which is why
    // this ranks by expired-or-not and then by id, never by "expires latest".
    // Ordering by expiry would run the box as the previous account for its
    // whole life while Settings showed the new sign-in as connected.
    seedAgentStore({});
    seedSharedStore({
      "codex:default": {
        type: "oauth",
        provider: "codex",
        access: accessToken("acct-old-cli"),
        refresh: "refresh-old-cli",
        expires: Date.now() + 3 * 24 * 3_600_000,
      },
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-owner-signin"),
        refresh: "refresh-owner-signin",
        expires: Date.now() + 8 * 3_600_000,
      },
    });

    run();

    const parsed = JSON.parse(readFileSync(homeAuthPath, "utf-8"));
    expect(parsed.tokens.account_id).toBe("acct-owner-signin");
    expect(parsed.tokens.refresh_token).toBe("refresh-owner-signin");
  });

  it("repairs BOTH mirrors when both are stale — the state the reported box was in", () => {
    // Measured: both files 3911 bytes, both dated 2026-08-27, both carrying the
    // Codex CLI login rather than the sign-in. Every other fixture here seeds
    // one file, which is what let a both-stale box go unnoticed.
    const stale = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: accessToken("acct-stale"),
        refresh_token: "refresh-eight-days-old",
        account_id: "acct-stale",
      },
    });
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    mkdirSync(path.dirname(codexHomeAuthPath), { recursive: true });
    writeFileSync(homeAuthPath, stale);
    writeFileSync(codexHomeAuthPath, stale);
    seedAgentStore({});
    seedSharedStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-live"),
        refresh: "refresh-live",
        expires: Date.now() + 3_600_000,
      },
    });

    run();

    // The plugin's own file is repaired. The app-server's own copy holds a
    // refresh token core does not have and core's store cannot be written on a
    // 2026.8 box, so it is left alone here and cleared by the sign-in route
    // instead — see the configure-route test.
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token).toBe("refresh-live");
  });

  it("tightens an existing world-readable mirror to 0600, not only a freshly created one", () => {
    // `writeFileSync(..., { mode })` applies the mode on CREATION only, so a
    // file left 0644 by an earlier tool stayed 0644 through every rewrite while
    // holding a refresh token.
    seedProfile(accessToken("acct-1"), "refresh-1");
    run();
    chmodSync(homeAuthPath, 0o644);
    seedProfile(accessToken("acct-1", "rotated"), "refresh-1");
    run();

    expect(statSync(homeAuthPath).mode & 0o777).toBe(0o600);
  });

  it("tightens a world-readable mirror on the IDEMPOTENT pass, without rewriting it", () => {
    // The pass that runs 144 times a day finds no drift and returns before the
    // write. Binding the permission repair to the rewrite path leaves a mirror
    // that is already current but 0644 — from an older mirror, or from a tool
    // that created it — world-readable for the life of the box while it holds
    // an OAuth refresh token, because "credential already current" is the
    // answer forever after.
    //
    // Nothing else repairs these two files: core's own permission repair
    // (`openclaw doctor --fix`, the state-integrity check) looks at the state
    // dir, the config file and the runtime dirs, and never at ~/.codex or an
    // agent's codex-home; core's Codex reader only reads them. This script is
    // the only ClawBox-owned writer — the Codex app-server rewrites its own
    // CODEX_HOME copy, so a mirror can come back with a mode nothing here
    // chose, which is the whole reason the check belongs on every pass.
    seedProfile(accessToken("acct-1"), "refresh-1");
    run();
    for (const file of [homeAuthPath, codexHomeAuthPath]) {
      chmodSync(file, 0o644);
      chmodSync(path.dirname(file), 0o755);
    }
    const mtimes = [homeAuthPath, codexHomeAuthPath].map((f) => statSync(f).mtimeMs);

    const stdout = run();

    // The chmod ran on a pass that wrote nothing...
    for (const file of [homeAuthPath, codexHomeAuthPath]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // ...and it is a chmod, not a rewrite: chmod moves ctime only, a write
    // moves mtime. Both assertions are needed — tightening the mode by
    // rewriting the credential on every tick would pass the one above while
    // reintroducing the write this branch's short-circuit exists to avoid.
    expect([homeAuthPath, codexHomeAuthPath].map((f) => statSync(f).mtimeMs)).toEqual(mtimes);
    expect(stdout).toContain("credential already current");
    expect(stdout).not.toMatch(/Codex auth\.json (created|refreshed|realigned):/);
  });

  it("leaves a mirror an operator made STRICTER alone — 0400 stays 0400", () => {
    // The other half of the trigger. Tightening on core's own criterion (any
    // group/other bit set) rather than on `mode !== 0o600` is what keeps this
    // true: an exact comparison would WIDEN a deliberate 0400 to 0600 on every
    // tick and call it a security repair.
    seedProfile(accessToken("acct-1"), "refresh-1");
    run();
    chmodSync(homeAuthPath, 0o400);

    run();

    expect(statSync(homeAuthPath).mode & 0o777).toBe(0o400);
  });

  it("still mirrors EVERY destination when the codex dir is not owner-writable", () => {
    // A directory the owner cannot write is not "stricter" — it is a mirror
    // that can never be written again. Core repairs it in two steps and this
    // must too: restore the owner's rwx first (`canWriteDir` -> `addUserRwx`),
    // then tighten. Enforcing only the tighten leaves ~/.codex at 0500, the
    // write below fails EACCES, and the throw takes out main()'s whole
    // destinations loop — losing the app-server's CODEX_HOME copy behind it,
    // which is the exact failure the guarded chmods already exist to prevent.
    seedProfile(accessToken("acct-1"), "refresh-1");
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    chmodSync(path.dirname(homeAuthPath), 0o500);

    run();

    expect(statSync(path.dirname(homeAuthPath)).mode & 0o777).toBe(0o700);
    expect(existsSync(homeAuthPath)).toBe(true);
    // The LATER destination — the one an aborted loop never reaches.
    expect(existsSync(codexHomeAuthPath)).toBe(true);
  });

  it("keeps mirroring, and never says \"already current\", when one destination cannot be written", () => {
    // The write itself, the second of the two per-destination operations that
    // can throw (the mkdir above it is the other). It is reported on the
    // channel the timer keeps, the later destination is still written, and the
    // summary line must not answer "credential already current" on stdout
    // while stderr says the write failed.
    seedProfile(accessToken("acct-1"), "refresh-1");
    mkdirSync(path.dirname(homeAuthPath), { recursive: true });
    // A directory, where the credential file has to go: the write fails with
    // EISDIR whatever the permissions are, which an unprivileged test can do
    // and a chmod-based fixture cannot (CI may run as root).
    mkdirSync(homeAuthPath, { recursive: true });

    const { stdout, stderr, status } = runCapturing();

    expect(stderr).toContain("could not write");
    expect(stderr).toContain(homeAuthPath);
    expect(stdout).not.toContain("credential already current");
    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-1");
  });

  it("keeps mirroring the LATER destinations when a codex-home cannot be created", () => {
    // Creating the directory is the other per-destination operation that can
    // throw, and it runs before the write: an `<agentDir>` the owner cannot
    // write denies the mkdir, the throw leaves main()'s destinations loop, and
    // every destination BEHIND it — the other agents' CODEX_HOME copies — is
    // silently unwritten while the top-level catch prints one raw syscall
    // message and exits 0. One unwritable agent must cost that agent only.
    seedProfile(accessToken("acct-1"), "refresh-1");
    mkdirSync(path.join(openclawHome, "agents", "spare", "agent"), { recursive: true });
    const failing = agentCodexHomes()[0];
    const survivors = allDestinations().filter((dest) => dest !== path.join(failing, "auth.json"));

    const { stderr, status } = runWithFailingMkdir(failing);

    // The lost destination, by name: on beta this list is short by every
    // destination the aborted loop never reached.
    expect(mirrored("refresh-1")).toEqual(survivors);
    // Timer conditions (CODEX_AUTH_MIRROR_QUIET=1), so this is the only channel
    // that carries it, and it names both the destination that was lost and the
    // directory that blocked it, rather than a bare syscall message.
    expect(stderr).toContain(`could not write ${path.join(failing, "auth.json")}`);
    expect(stderr).toContain(`EACCES creating ${failing}`);
    expect(status).toBe(0);
  });

  it("keeps mirroring the LATER destinations when a codex-home is a FILE", () => {
    // The same abort without any permission bits: `codex-home` present as a
    // regular file makes the recursive mkdir throw EEXIST. (A dangling symlink
    // aborts the same pass for the same reason, but with ENOENT — a different
    // errno, one catch.) Nothing filters either out earlier — readJson returns
    // null on both and fileKey swallows its realpath failure — so it reaches
    // the mkdir on a box where an operator has put a file in the way.
    seedProfile(accessToken("acct-1"), "refresh-1");
    mkdirSync(path.join(openclawHome, "agents", "spare", "agent"), { recursive: true });
    const failing = agentCodexHomes()[0];
    const survivors = allDestinations().filter((dest) => dest !== path.join(failing, "auth.json"));
    writeFileSync(failing, "not a directory");

    const { stderr, status } = runCapturing();

    expect(mirrored("refresh-1")).toEqual(survivors);
    expect(stderr).toContain(`could not write ${path.join(failing, "auth.json")}`);
    // ...and it names the path that actually blocked it, not only the
    // destination: `${dest} (EEXIST)` alone would report "file already exists"
    // about a file that does not exist.
    expect(stderr).toContain(`creating ${failing}`);
    expect(status).toBe(0);
  });

  it("fails CLOSED when another writer holds core's store — no adoption, nothing overwritten", () => {
    // The write-back is one transaction, and a rotation may only be reported as
    // recorded once it has COMMITTED. Here a second connection holds the write
    // lock for the whole pass, so `BEGIN IMMEDIATE` waits out the 5 s
    // busy_timeout and throws: `writeBackToCore` must then return false, and
    // main() must take the could-not-record branch rather than claiming the
    // adoption. Claiming it would leave the box mirroring a refresh token core
    // does not hold — one of the two tokens of a single-use family, which is
    // the `refresh_token_reused` shape this whole file exists to prevent.
    //
    // Only the sqlite store is seeded: an auth-profiles.json would make `wrote`
    // true through the untransactional legacy loop and prove nothing about this
    // one (see the note at its `wrote = true`).
    seedAgentStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: accessToken("acct-1", "old"),
        refresh: "refresh-spent",
        expires: Date.now() + 3_600_000,
      },
    });
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

    // Held across the whole child run: spawnSync blocks this process, and the
    // RESERVED lock BEGIN IMMEDIATE takes is held by the connection, not the
    // thread, so the child cannot get it and cannot be raced into getting it.
    const blocker = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    blocker.exec("BEGIN IMMEDIATE");
    let result: { stdout: string; stderr: string; status: number | null };
    try {
      result = runCapturing();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    expect(result.stdout).not.toContain("adopted app-server rotation");
    // Loud on the channel the timer keeps, and non-fatal — the next tick retries.
    expect(result.stderr).toContain("core's store could not be updated");
    expect(result.status).toBe(0);
    // Nothing was half-written: core still holds the token it held, and the
    // app-server's live rotation was left alone rather than overwritten with
    // the spent one.
    expect(readAgentStore().profiles["openai:chatgpt"].refresh).toBe("refresh-spent");
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
  }, 20_000);

  it("reports a failed chmod where the TIMER can see it, not through the quiet log", () => {
    // The timer unit runs with CODEX_AUTH_MIRROR_QUIET=1, so a failure reported
    // through log() is silent on the path that runs 144 times a day — a mirror
    // that stays world-readable while holding an OAuth refresh token would say
    // nothing at all. Both credential files are faulted, because both are
    // tightened by the same helper.
    //
    // Both mirrors are seeded 0644 first, because a chmod is only attempted on
    // a path that actually needs one: a freshly created mirror is already
    // 0600 (`writeFileSync`'s `mode` can only lose bits to the umask, never
    // gain them), so faulting the syscall there would fault a call the script
    // is right not to make. The rotated token then puts this on the REWRITE
    // path, where a failure costs the most.
    seedProfile(accessToken("acct-1"));
    run();
    chmodSync(homeAuthPath, 0o644);
    chmodSync(codexHomeAuthPath, 0o644);
    seedProfile(accessToken("acct-1", "rotated"));

    const { stdout, stderr, status } = runWithFailingChmod("auth.json");

    expect(stdout).toBe(""); // quiet mode: nothing on the channel the timer drops
    expect(stderr).toContain("could not tighten permissions");
    expect(stderr).toContain(homeAuthPath);
    expect(stderr).toContain(codexHomeAuthPath);
    // Non-fatal: the credential is still mirrored, and the gateway pre-start
    // pass must never be blocked by a permissions failure.
    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-secret");
  });

  it("keeps mirroring the REMAINING destinations when a directory chmod fails, and says so", () => {
    // The sibling of the case above, and the one that costs more: the
    // directory chmod runs first, so an EPERM there (a codex dir owned by
    // another user) threw out of writeMirror, aborted main()'s whole
    // destinations loop, and left every LATER mirror — the app-server's
    // CODEX_HOME copy, without which every Codex turn falls back to the
    // Cloudflare-challenged browser endpoint — unwritten. It reported that
    // only through the top-level log(), which CODEX_AUTH_MIRROR_QUIET=1
    // silences, so on the timer path 144 aborted passes a day were
    // indistinguishable from 144 clean ones.
    //
    // `~/.codex` is the FIRST destination, so faulting its directory is what
    // pins "the pass continued": the assertion below is about the destination
    // that came after it.
    seedProfile(accessToken("acct-1"));

    const { stdout, stderr, status } = runWithFailingChmod(".codex");

    expect(stdout).toBe("");
    expect(stderr).toContain("could not tighten permissions");
    expect(stderr).toContain(path.dirname(homeAuthPath));
    expect(stderr).toContain("EPERM");
    expect(status).toBe(0);
    // Both destinations written: the faulted one, whose file mode still makes
    // the credential owner-only, and the one that used to be skipped.
    expect(JSON.parse(readFileSync(homeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-secret");
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-secret");
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
