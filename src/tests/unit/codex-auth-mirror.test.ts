import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

    run();

    // The app-server's file is untouched...
    expect(JSON.parse(readFileSync(codexHomeAuthPath, "utf-8")).tokens.refresh_token)
      .toBe("refresh-rotated-by-appserver");
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

  it("realigns a stale ~/.codex/auth.json when codex-home is a symlink to it", () => {
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

  it("leaves a SECOND diverged app-server home alone after adopting the first rotation", () => {
    // Two agents run two app-servers, each rotating its own CODEX_HOME. Core
    // can record only one of those rotations, so writing the adopted token over
    // the other file discards a live refresh token — exactly the burn the
    // could-not-record branch already prevents.
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
