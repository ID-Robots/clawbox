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

function credentialFromProfiles(agentDir) {
  const profiles = readProfiles(agentDir);
  const profile =
    profiles && (profiles["codex:default"] || profiles["openai-codex:default"]);
  if (!profile || !profile.access) return null;
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

  // ONLY ~/.codex/auth.json. The codex plugin reads it and never writes it,
  // and nothing runs with CODEX_HOME=~/.codex, so this copy is never rotated.
  const reason = writeMirror(homeAuthPath, credential);
  if (reason) log(`Codex auth.json ${reason}: ${homeAuthPath}`);
  else log("Codex auth.json: credential already current");

  // <agentDir>/codex-home/auth.json is the file the Codex app-server rotates.
  // A credential there is a second rotator against core's single-use refresh
  // token and burns the whole family (401 refresh_token_reused). Core pushes
  // the app-server its tokens over account/login/start, so the file is not
  // needed -- remove any that 3.1.11 left behind.
  for (const dir of agentDirs) {
    const rotated = path.join(dir, "codex-home", "auth.json");
    if (!fs.existsSync(rotated)) continue;
    try {
      fs.rmSync(rotated);
      log(`Codex auth.json removed rotating copy: ${rotated}`);
    } catch (error) {
      log(`Codex auth.json: could not remove ${rotated}: ${error.message}`);
    }
  }
}

try {
  main();
} catch (error) {
  // Never block gateway start on a credential mirror.
  log("Codex auth.json: " + error.message);
}
