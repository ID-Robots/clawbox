#!/usr/bin/env node
/**
 * Mirror the ChatGPT/Codex OAuth credential from OpenClaw core's auth profile
 * store into the Codex CLI-style auth.json files the Codex runtime reads.
 *
 * WHY THIS EXISTS
 *
 * On a ChatGPT-subscription box the Codex runtime needs a Codex CLI-style
 * auth.json or it falls back to api.openai.com with no bearer and every turn
 * dies with `401 Missing bearer or basic authentication in header`. Two
 * locations matter:
 *
 *   ~/.codex/auth.json                  - read by the codex plugin
 *   <agentDir>/codex-home/auth.json     - CODEX_HOME the gateway passes to the
 *                                         Codex app-server on core 2026.7.x
 *
 * THE RULE: EXACTLY ONE HOLDER MAY CARRY refresh_token.
 *
 * ChatGPT OAuth refresh tokens are single-use and rotating. Every holder that
 * *uses* one rotates the family server-side, so a second holder presenting the
 * old value gets `401 refresh_token_reused` and the family is burnt. Core owns
 * the OAuth flow and persists rotations to openclaw-agent.sqlite, so core is
 * the single rotator. These mirrors are access-token-only, read-only copies.
 *
 * 3.1.11 shipped mirrors that DID carry refresh_token, giving the box two
 * rotators (core + the Codex app-server binary, which rotates whatever sits in
 * its CODEX_HOME). Boxes worked for a few hours and then died. See #278.
 *
 * Access tokens live about an hour, so this runs at boot from
 * gateway-pre-start.sh and periodically from clawbox-codex-auth-sync.timer.
 *
 * Exit code is always 0: a missing credential is a normal pre-login state, and
 * this must never be able to block the gateway from starting.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const openclawHome =
  process.argv[2] || process.env.OPENCLAW_HOME_DIR || path.join(os.homedir(), ".openclaw");
const homeAuthPath =
  process.argv[3] || path.join(os.homedir(), ".codex", "auth.json");
const quiet = process.env.CODEX_AUTH_MIRROR_QUIET === "1";

function log(message) {
  if (!quiet) console.log("  " + message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Auth profiles moved from agents/<id>/agent/auth-profiles.json into the
 * auth_profile_store table of openclaw-agent.sqlite on core 2026.7.x. Read
 * both so the mirror keeps working across a core downgrade.
 */
function readProfiles(agentDir) {
  const fromJson = readJson(path.join(agentDir, "auth-profiles.json"));
  if (fromJson && fromJson.profiles) return fromJson.profiles;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    db.close();
    const parsed = row && row.store_json ? JSON.parse(row.store_json) : null;
    return (parsed && parsed.profiles) || null;
  } catch {
    return null; // no node:sqlite, no table, or locked — non-fatal
  }
}

/** chatgpt_account_id lives in the access token's claims, not the profile. */
function accountIdFromAccessToken(accessToken) {
  try {
    const claims = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString(),
    );
    const auth = claims["https://api.openai.com/auth"] || {};
    return (
      auth.chatgpt_account_id || auth.account_id || auth.user_id || claims.sub || null
    );
  } catch {
    return null; // opaque token — leave accountId null
  }
}

// `openai:chatgpt` is where ClawBox files the sign-in on OpenClaw 2 (an
// openai-provider OAuth profile — src/lib/chatgpt-subscription.ts); the two
// older keys are what boxes signed in before the core upgrade still hold. One
// list for reading AND writing back: a rotation adopted from the app-server
// that cannot find the profile to write it into leaves core holding the spent
// refresh token, and the next mirror pass writes that dead token over the
// live file.
const PROFILE_KEYS = ["openai:chatgpt", "codex:default", "openai-codex:default"];

/**
 * The ONE profile this box's ChatGPT credential lives in — for reading it and
 * for writing a rotation back.
 *
 * The first entry that actually carries `access`, because a canonical entry
 * left half-written by an interrupted sign-in must not hide a legacy one that
 * still works; the first entry that merely EXISTS only as a last resort, so a
 * rotation still lands somewhere when nothing is credentialed yet.
 *
 * One rule for both directions, deliberately. Reading by "has a credential"
 * while writing back by "exists" is how a box ends up reading `codex:default`
 * and writing the rotated token into `openai:chatgpt`, leaving the entry it
 * reads next holding a refresh token that has already been spent — the exact
 * split this list exists to prevent.
 */
/** An openai-provider OAuth profile is a ChatGPT sign-in, whatever it is keyed. */
function isChatgptProfile(key, entry) {
  if (!entry || typeof entry !== "object") return false;
  const provider = String(entry.provider || key.split(":")[0] || "").trim().toLowerCase();
  const mode = String(entry.type || entry.mode || "").trim().toLowerCase();
  if (mode && mode !== "oauth") return false;
  return provider === "openai" || provider === "codex" || provider === "openai-codex";
}

function profileKeyIn(profiles) {
  if (!profiles) return null;
  // PROFILE_KEYS first, as the preference order, then ANY profile that is a
  // ChatGPT sign-in by shape. The three literal ids miss the two `doctor --fix`
  // itself allocates when it migrates a legacy `openai-codex:default`:
  // `openai:default`, or `openai:chatgpt-default` when that is taken. The rest
  // of this PR already treats "provider openai + oauth" as the sign-in — so a
  // doctor-migrated box produced an available ChatGPT row, a runtime arm and a
  // subscription entitlement while THIS script found no credential, never
  // synthesized ~/.codex/auth.json and never wrote a rotation back.
  const keys = [
    ...PROFILE_KEYS.filter((key) => profiles[key]),
    ...Object.keys(profiles).filter(
      (key) => !PROFILE_KEYS.includes(key) && isChatgptProfile(key, profiles[key]),
    ).sort(),
  ];
  return keys.find((key) => profiles[key] && profiles[key].access) || keys[0] || null;
}

function credentialFromProfiles(agentDir) {
  const profiles = readProfiles(agentDir);
  const key = profileKeyIn(profiles);
  const profile = key && profiles[key] && profiles[key].access ? profiles[key] : null;
  if (!profile) return null;
  return {
    accessToken: profile.access,
    refreshToken: profile.refresh,
    idToken: profile.id || profile.access,
    accountId: accountIdFromAccessToken(profile.access),
  };
}

/**
 * Build the file contents.
 *
 * refresh_token IS included, and it has to be: core's readCodexCliCredentials()
 * hard-rejects a credential without one --
 *
 *   if (typeof refreshToken !== "string" || !refreshToken) return null;
 *
 * -- and a null credential means the codex plugin attaches no auth at all
 * (`profile=-` in the gateway log) and every turn dies on 401. An earlier
 * attempt at this fix stripped the field and broke Codex exactly that way.
 *
 * Safety comes from WHERE it is written, not from omitting it: only
 * ~/.codex/auth.json gets a credential, and nothing rotates that file. The
 * codex plugin reads it and never writes it, and no process runs with
 * CODEX_HOME=~/.codex. The file the Codex app-server *does* rotate is
 * <agentDir>/codex-home/auth.json -- see the destination list in main().
 */
function buildAuthFile(credential, existing) {
  return {
    OPENAI_API_KEY: (existing && existing.OPENAI_API_KEY) || null,
    tokens: {
      id_token: credential.idToken,
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken,
      account_id: credential.accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

/**
 * Rewrite whenever the file drifts from core's profile. Core is the only
 * rotator, so "different from core" always means "stale copy", never "newer".
 */
function syncReason(existing, credential) {
  if (!existing) return "created";
  const tokens = existing.tokens || {};
  if (tokens.access_token !== credential.accessToken) return "refreshed";
  if (tokens.refresh_token !== credential.refreshToken) return "realigned";
  return null;
}

function writeMirror(dest, credential) {
  const existing = readJson(dest);
  const reason = syncReason(existing, credential);
  if (!reason) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Holds an OAuth token — owner-only dir, not just the 0600 file.
  fs.chmodSync(path.dirname(dest), 0o700);
  fs.writeFileSync(
    dest,
    JSON.stringify(buildAuthFile(credential, existing), null, 2),
    { mode: 0o600 },
  );
  return reason;
}


/**
 * Collapse destinations that resolve to the same file. <agentDir>/codex-home
 * is sometimes a symlink to ~/.codex; without this the same file gets written
 * twice, and a previous version deleted the real credential through the link.
 */
function dedupePaths(files) {
  const seen = new Map();
  for (const file of files) {
    let key = file;
    try {
      key = path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    } catch {
      // Directory doesn't exist yet — the raw path is unique enough.
    }
    if (!seen.has(key)) seen.set(key, file);
  }
  return [...seen.values()];
}

/**
 * Write an app-server rotation back into core's auth profile store, so core
 * stops handing out a refresh token that has already been spent.
 */
function writeBackToCore(agentDirs, tokens) {
  if (!tokens || !tokens.refresh_token) return false;
  let wrote = false;

  // Legacy JSON store, still the source on some boxes.
  for (const agentDir of agentDirs) {
    const jsonPath = path.join(agentDir, "auth-profiles.json");
    const data = readJson(jsonPath);
    const profiles = data && data.profiles;
    if (!profiles) continue;
    const id = profileKeyIn(profiles);
    if (!id) continue;
    profiles[id].access = tokens.access_token || profiles[id].access;
    profiles[id].refresh = tokens.refresh_token;
    if (tokens.id_token) profiles[id].id = tokens.id_token;
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      wrote = true;
    } catch {
      // Non-fatal; the sqlite store below is the one core reads.
    }
  }

  for (const agentDir of agentDirs) {
    const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
          .get("primary");
        if (!row || !row.store_json) continue;
        const store = JSON.parse(row.store_json);
        const profiles = store.profiles || {};
        const id = profileKeyIn(profiles);
        if (!id) continue;
        profiles[id].access = tokens.access_token || profiles[id].access;
        profiles[id].refresh = tokens.refresh_token;
        if (tokens.id_token) profiles[id].id = tokens.id_token;
        store.profiles = profiles;
        db.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?")
          .run(JSON.stringify(store), Date.now(), "primary");
        wrote = true;
      } finally {
        db.close();
      }
    } catch {
      // Locked or unavailable — the next timer tick retries.
    }
  }
  return wrote;
}

function main() {
  const agentsRoot = path.join(openclawHome, "agents");
  const agentDirs = fs.existsSync(agentsRoot)
    ? fs
        .readdirSync(agentsRoot)
        .map((id) => path.join(agentsRoot, id, "agent"))
        .filter((dir) => fs.existsSync(dir))
    : [];

  // Core's store is the source of truth; the main agent holds the real login.
  const mainFirst = (a, b) =>
    Number(b.includes(`${path.sep}main${path.sep}`)) -
    Number(a.includes(`${path.sep}main${path.sep}`));
  let credential = null;
  for (const dir of [...agentDirs].sort(mainFirst)) {
    credential = credentialFromProfiles(dir);
    if (credential) break;
  }

  if (!credential) {
    log("Codex auth.json: no codex OAuth profile yet, skipping");
    return;
  }

  // Both locations are required:
  //   ~/.codex/auth.json              - read by the codex plugin
  //   <agentDir>/codex-home/auth.json - CODEX_HOME for the Codex app-server,
  //                                     the only path that addresses the real
  //                                     Codex API correctly
  // An earlier attempt deleted the second one; the app-server then had no
  // credential, codex fell back to core's HTTP transport, and every turn hit a
  // Cloudflare-challenged browser endpoint. See #280.
  const destinations = dedupePaths([
    homeAuthPath,
    ...agentDirs.map((dir) => path.join(dir, "codex-home", "auth.json")),
  ]);

  // The app-server rotates its own CODEX_HOME credential. Refresh tokens are
  // single-use, so if it has already rotated, core's stored copy is the DEAD
  // one -- overwriting the file with it would burn the family on next use.
  // Core follows the app-server, never the other way round.
  const rotated = destinations
    .map((dest) => ({ dest, data: readJson(dest) }))
    .find(({ data }) => {
      const tokens = (data && data.tokens) || {};
      return (
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token &&
        tokens.refresh_token !== credential.refreshToken
      );
    });

  if (rotated) {
    const tokens = rotated.data.tokens;
    if (writeBackToCore(agentDirs, tokens)) {
      log(`Codex auth.json: adopted app-server rotation from ${rotated.dest}`);
      credential = {
        accessToken: tokens.access_token || credential.accessToken,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token || credential.idToken,
        accountId: tokens.account_id || credential.accountId,
      };
    }
  }

  let synced = 0;
  for (const dest of destinations) {
    const reason = writeMirror(dest, credential);
    if (reason) {
      synced += 1;
      log(`Codex auth.json ${reason}: ${dest}`);
    }
  }
  if (synced === 0) log("Codex auth.json: credential already current");
}

try {
  main();
} catch (error) {
  // Never block gateway start on a credential mirror.
  log("Codex auth.json: " + error.message);
}
