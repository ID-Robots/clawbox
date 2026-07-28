#!/usr/bin/env node
/**
 * Migrate legacy auth-profiles.json credentials into the sqlite auth profile
 * store that OpenClaw core reads at runtime.
 *
 * WHY THIS EXISTS
 *
 * Auth profiles used to live in <agentDir>/auth-profiles.json. On core
 * 2026.7.x they live in the auth_profile_store table of
 * openclaw-agent.sqlite, and the JSON file is treated as legacy — core's own
 * doctor offers to "Repair legacy auth-profiles.json files".
 *
 * A ClawBox that signs in through the setup wizard can still end up with the
 * credential only in the JSON file. Core then resolves no auth profile for the
 * model (`profile=-` in the gateway log), sends the request with no bearer, and
 * every turn fails with 401 — while the UI cheerfully shows the provider as
 * connected, because the JSON file is there.
 *
 * Seen on a factory-fresh box on 2026-07-28: auth-profiles.json held
 * codex:default, llamacpp:default and deepseek:default; auth_profile_store had
 * ZERO rows. Migrating the three across moved codex from 401 to a real API
 * response.
 *
 * Copy-don't-move: the JSON file is left untouched so a core downgrade still
 * finds it, and existing sqlite entries always win (they are the live ones).
 *
 * Exit code is always 0 — this must never block the gateway from starting.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const openclawHome =
  process.argv[2] || process.env.OPENCLAW_HOME_DIR || path.join(os.homedir(), ".openclaw");
const quiet = process.env.MIGRATE_AUTH_PROFILES_QUIET === "1";

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

function migrateAgent(agentDir) {
  const legacy = readJson(path.join(agentDir, "auth-profiles.json"));
  const legacyProfiles = (legacy && legacy.profiles) || null;
  if (!legacyProfiles || Object.keys(legacyProfiles).length === 0) return null;

  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return null;

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    const store = row && row.store_json ? JSON.parse(row.store_json) : {};
    store.profiles = store.profiles || {};

    const migrated = [];
    for (const [id, profile] of Object.entries(legacyProfiles)) {
      // Never clobber: whatever core already has is the live credential.
      if (store.profiles[id]) continue;
      store.profiles[id] = profile;
      migrated.push(id);
    }
    if (migrated.length === 0) return null;

    // updated_at is NOT NULL in this table.
    const now = Date.now();
    if (row) {
      db.prepare(
        "UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?",
      ).run(JSON.stringify(store), now, "primary");
    } else {
      db.prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      ).run("primary", JSON.stringify(store), now);
    }
    return migrated;
  } finally {
    db.close();
  }
}

function main() {
  const agentsRoot = path.join(openclawHome, "agents");
  if (!fs.existsSync(agentsRoot)) return;

  let total = 0;
  for (const id of fs.readdirSync(agentsRoot)) {
    const agentDir = path.join(agentsRoot, id, "agent");
    if (!fs.existsSync(agentDir)) continue;
    let migrated = null;
    try {
      migrated = migrateAgent(agentDir);
    } catch (error) {
      // DB locked mid-write, missing node:sqlite, table absent — all non-fatal.
      log(`auth profiles: ${id}: ${error.message}`);
      continue;
    }
    if (migrated) {
      total += migrated.length;
      log(`auth profiles migrated to sqlite (${id}): ${migrated.join(", ")}`);
    }
  }
  if (total === 0) log("auth profiles: sqlite store already current");
}

try {
  main();
} catch (error) {
  log("auth profiles: " + error.message);
}
