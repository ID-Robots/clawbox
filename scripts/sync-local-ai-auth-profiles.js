#!/usr/bin/env node
/**
 * Keep the `llamacpp:default` / `ollama:default` auth profiles on this box's
 * local-AI bearer, `data/.local-ai-token`.
 *
 *   node sync-local-ai-auth-profiles.js <openclaw home> <openclaw bin>
 *
 * Run by gateway-pre-start.sh on every gateway start, AFTER its Python pass has
 * reconciled `models.providers.<provider>.apiKey` with the same file.
 *
 * WHY THIS EXISTS
 *
 * The local-AI proxy (/setup-api/local-ai/<provider>) answers 401 to every
 * bearer but the one in `data/.local-ai-token` (verifyLocalAiBearer,
 * src/lib/local-ai-token.ts). Setup stores that token twice: as the provider
 * entry's `apiKey` in openclaw.json, and as the `<provider>:default` auth
 * profile in core's credential store (`models auth paste-api-key`, see
 * `pasteAuthApiKey` in src/app/setup-api/ai-models/configure/route.ts). The boot
 * reconciliation only ever repaired the first. On an updated box the second
 * still held whatever an older build or the image it was built from had
 * written — a `llamacpp-local` sentinel, or a previous token — and core tries
 * the profile FIRST: every local-model turn opened with a 401 from the proxy,
 * put the profile on cooldown and was retried on another credential, and the
 * next turn did the same.
 *
 * WHAT IT DOES
 *
 * Reads, never writes, core's stores to learn what each agent would resolve
 * for `<provider>:default` — the legacy auth-profiles.json on a v1 box, else the
 * shared store (`state/openclaw.sqlite`, or the main agent's table before
 * `doctor --fix` relocated it) with the agent's own `auth_profile_store` on
 * top, the same read-through codex-auth-mirror.js models. The stored key and
 * the token are compared by SHA-256 fingerprint. On a mismatch the profile is
 * re-saved exactly the way setup saves it — `openclaw models auth paste-api-key`
 * with the token on stdin, never in argv — because that command owns the
 * store's schema on every core generation; a hand-written row is what the
 * legacy-auth-profiles migration in gateway-pre-start.sh exists to undo. Then
 * the stores are read again, and an agent that still resolves a stale key is
 * named in a warning rather than reported as fixed.
 *
 * Bounded like the Python pass it follows:
 *
 *   * ONLY a provider whose openclaw.json entry already carries this token as
 *     its `apiKey`. That is the evidence the provider is on this box's proxy;
 *     an operator's own llama-server keeps the key they gave it, and a
 *     `${LOCAL_AI_TOKEN}` reference (the web server may be running on that
 *     variable instead of the file) is never flattened into the file's value.
 *   * NEVER over a missing, undecodable or too-short token file.
 *   * NEVER over a sign-in, a SecretRef or a `${VAR}` credential: a key that
 *     resolves elsewhere cannot be judged stale from here.
 *   * An agent is checked only when the config's roster names it (the implicit
 *     `main` when there is no roster): a stray directory left by a removed
 *     agent routes no turn, and "fixing" it on every boot would be a CLI cold
 *     start (~10 s on a Jetson) spent on nothing.
 *
 * Neither the token nor any stored key is ever printed. Fingerprints are
 * compared, not logged, and whatever the CLI prints is redacted and bounded.
 *
 * Exit code is always 0: this must never keep the gateway from starting.
 */

"use strict";
// A CommonJS script node runs directly, like migrate-auth-profiles.js beside it;
// `node:sqlite` is required lazily so a box with nothing to check never loads it.
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const PROVIDERS = ["llamacpp", "ollama"];
/** Same floor as getLocalAiToken() and the Python pass: shorter is not a token this box wrote. */
const MIN_TOKEN_LENGTH = 16;
/** The configure route gives the same paste the same budget. */
const PASTE_TIMEOUT_MS = 60_000;
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
const SHARED_STORE_KEY = "authProfiles.store";
const SHARED_STORE_OWNERSHIP_KEY = "auth.sharedStore";

const openclawHome =
  process.argv[2] || process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
const openclawBin =
  process.argv[3] || process.env.OPENCLAW_BIN || path.join(os.homedir(), ".npm-global", "bin", "openclaw");
const clawboxRoot = process.env.CLAWBOX_ROOT || path.join(os.homedir(), "clawbox");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(openclawHome, "openclaw.json");
const tokenPath = path.join(clawboxRoot, "data", ".local-ai-token");
/**
 * OpenClaw 2 never reads a legacy auth-profiles.json (it refuses to start
 * beside one), so on that generation the file is not what an agent resolves.
 * gateway-pre-start.sh passes the generation it already worked out.
 */
const openclawV2 = process.env.CLAWBOX_OPENCLAW_V2 === "1";
/** Every credential this run has seen, so no message it prints can carry one. */
const knownSecrets = [];

function info(message) {
  console.log("  " + message);
}

function warn(message) {
  console.error("  WARN: " + message);
}

/** SHA-256 of a credential: what is compared, so neither side is held in a message. */
function fingerprint(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The token, or "" when there is none this script may write. STRICT utf-8: a
 * decoder that replaced a bad byte would hand back a different string, and
 * this script would then paste it into the store as the credential.
 */
function readToken() {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(tokenPath));
    const token = raw.trim();
    return token.length >= MIN_TOKEN_LENGTH ? token : "";
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasProfiles(store) {
  return isObject(store) && isObject(store.profiles) && Object.keys(store.profiles).length > 0;
}

let DatabaseSync = null;
function sqlite() {
  if (!DatabaseSync) DatabaseSync = require("node:sqlite").DatabaseSync;
  return DatabaseSync;
}

/**
 * Stores that exist but could not be read. A store this script cannot read is
 * one it cannot judge, so nothing is pasted on its account — and it is said.
 */
const unreadable = new Set();

function openReadOnly(dbPath) {
  const Db = sqlite();
  const db = new Db(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** An agent's own table, core 2026.7.x's home for the profiles. Null when absent or empty. */
function readAgentTable(agentDir) {
  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  let row;
  try {
    const db = openReadOnly(dbPath);
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_profile_store'")
        .get();
      // No table is an answer (a store that keeps no profiles here), not a fault.
      if (!table) return null;
      row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");
    } finally {
      db.close();
    }
  } catch {
    unreadable.add(dbPath);
    return null;
  }
  const parsed = row && row.store_json ? safeParse(row.store_json) : null;
  return hasProfiles(parsed) ? parsed.profiles : null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stateDbPath() {
  const override = (process.env.OPENCLAW_STATE_DIR || "").trim();
  const dir = override
    ? path.resolve(override.replace(/^~(?=$|[\\/])/, () => process.env.HOME || os.homedir()))
    : openclawHome;
  return path.join(dir, "state", "openclaw.sqlite");
}

/**
 * `{location: "state-db"}` and nothing else — core's own test for whether the
 * shared store has been relocated (see codex-auth-mirror.js `ownsSharedStore`).
 */
function ownsSharedStore(valueJson) {
  const parsed = typeof valueJson === "string" ? safeParse(valueJson) : null;
  return isObject(parsed) && Object.keys(parsed).length === 1 && parsed.location === "state-db";
}

/**
 * The shared store every agent inherits from: the state database once
 * `doctor --fix` relocated it there, otherwise (`legacy-main`) the main
 * agent's own table.
 */
function readSharedProfiles(agentsRoot) {
  const dbPath = stateDbPath();
  if (fs.existsSync(dbPath)) {
    let rows = null;
    try {
      const db = openReadOnly(dbPath);
      try {
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'")
          .get();
        rows = table
          ? db
              .prepare("SELECT state_key, value_json FROM config_machine_state WHERE state_key IN (?, ?)")
              .all(SHARED_STORE_OWNERSHIP_KEY, SHARED_STORE_KEY)
          : [];
      } finally {
        db.close();
      }
    } catch {
      // Which store every agent inherits from is recorded IN this database, so
      // one that cannot be read leaves that open: main's table below would be
      // a guess, and a paste on a guess is what the unreadable rule forbids.
      unreadable.add(dbPath);
      return null;
    }
    if (rows) {
      const byKey = new Map(rows.map((row) => [row.state_key, row.value_json]));
      if (ownsSharedStore(byKey.get(SHARED_STORE_OWNERSHIP_KEY))) {
        const parsed = safeParse(byKey.get(SHARED_STORE_KEY) || "");
        return hasProfiles(parsed) ? parsed.profiles : null;
      }
    }
  }
  return readAgentTable(path.join(agentsRoot, "main", "agent"));
}

/**
 * The agents core routes turns through: the roster's ids, or the implicit
 * `main` when the config has none. Each id is rebuilt into a single safe path
 * segment before it reaches a path.
 */
function rosterAgentIds(cfg) {
  const list = isObject(cfg) && isObject(cfg.agents) && Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const ids = [];
  for (const entry of list) {
    const id = isObject(entry) && typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id === "." || id === ".." || !SAFE_AGENT_ID.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : ["main"];
}

function agentDirFor(agentsRoot, id) {
  const exact = path.join(agentsRoot, id, "agent");
  if (fs.existsSync(exact)) return exact;
  // Core normalises agent ids to lower case for their directories.
  return path.join(agentsRoot, id.toLowerCase(), "agent");
}

/** What each roster agent would resolve, keyed by agent id. */
function readViews(agentIds) {
  const agentsRoot = path.join(openclawHome, "agents");
  const shared = readSharedProfiles(agentsRoot);
  const views = new Map();
  for (const id of agentIds) {
    const agentDir = agentDirFor(agentsRoot, id);
    const legacy = openclawV2 ? null : readJson(path.join(agentDir, "auth-profiles.json"));
    if (hasProfiles(legacy)) {
      views.set(id, legacy.profiles);
      continue;
    }
    views.set(id, { ...(shared || {}), ...(readAgentTable(agentDir) || {}) });
  }
  return views;
}

/**
 * The literal credential a profile holds, or null when there is nothing this
 * script may judge: no profile, a sign-in, a SecretRef, a `${VAR}`, no key.
 */
function literalCredential(profile) {
  if (!isObject(profile)) return null;
  const type = String(profile.type || profile.mode || "").trim().toLowerCase();
  if (type === "oauth") return null;
  if (profile.keyRef !== undefined || profile.tokenRef !== undefined) return null;
  const value = typeof profile.key === "string"
    ? profile.key
    : typeof profile.token === "string"
      ? profile.token
      : null;
  if (value === null) return null;
  if (value.length > 3 && value.startsWith("${") && value.endsWith("}")) return null;
  return value;
}

/** Agents whose `<provider>:default` holds a literal key that is not the token, with those keys. */
function staleAgents(views, profileId, tokenFingerprint) {
  const agents = [];
  const keys = [];
  for (const [id, profiles] of views) {
    const value = literalCredential(profiles[profileId]);
    if (value === null || fingerprint(value) === tokenFingerprint) continue;
    agents.push(id);
    keys.push(value);
  }
  return { agents, keys };
}

/** CLI output fit for the journal: every secret this run knows of removed, one line, bounded. */
function redact(text, secrets) {
  let out = String(text || "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 240 ? out.slice(0, 237) + "..." : out;
}

/** `models auth paste-api-key`, exactly as setup runs it. Returns null on success, else a cause. */
function pasteProfile(provider, profileId, token, secrets) {
  const result = spawnSync(
    openclawBin,
    ["models", "auth", "paste-api-key", "--provider", provider, "--profile-id", profileId],
    {
      input: token + "\n",
      encoding: "utf8",
      timeout: PASTE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error) {
    const code = result.error.code === "ETIMEDOUT"
      ? `timed out after ${PASTE_TIMEOUT_MS / 1000} s`
      : result.error.code || result.error.message;
    return redact(code, secrets);
  }
  if (result.status !== 0) {
    const said = redact(result.stderr || result.stdout, secrets);
    return `exit ${result.status === null ? result.signal : result.status}${said ? `: ${said}` : ""}`;
  }
  return null;
}

function main() {
  const cfg = readJson(configPath);
  if (!isObject(cfg)) return;
  const providers = isObject(cfg.models) && isObject(cfg.models.providers) ? cfg.models.providers : null;
  if (!providers) return;

  const token = readToken();
  // No usable token: the Python pass has already said so for any entry on the
  // proxy, and without one there is nothing to compare a profile against.
  if (!token) return;
  knownSecrets.push(token);
  const tokenFingerprint = fingerprint(token);

  const candidates = PROVIDERS.filter((provider) => {
    const entry = providers[provider];
    return isObject(entry) && typeof entry.apiKey === "string" && fingerprint(entry.apiKey) === tokenFingerprint;
  });
  if (candidates.length === 0) return;

  const agentIds = rosterAgentIds(cfg);
  let views = readViews(agentIds);

  for (const provider of candidates) {
    const profileId = `${provider}:default`;
    const before = staleAgents(views, profileId, tokenFingerprint);
    if (before.agents.length === 0) continue;

    knownSecrets.push(...before.keys);
    const secrets = knownSecrets;
    info(
      `Auth profile ${profileId} holds a key that is not data/.local-ai-token`
      + ` (agent ${before.agents.join(", ")}); re-saving it the way setup does`,
    );
    const failure = pasteProfile(provider, profileId, token, secrets);
    if (failure) {
      warn(
        `could not re-save auth profile ${profileId} (${failure}); every ${provider} turn will`
        + ` keep opening with a 401 from the local-AI proxy until AI Models → ${provider} is saved again`,
      );
      continue;
    }

    views = readViews(agentIds);
    const after = staleAgents(views, profileId, tokenFingerprint);
    if (after.agents.length === 0) {
      info(
        `Re-synced auth profile ${profileId} with data/.local-ai-token: the local-AI proxy accepts`
        + " only the current bearer, so the stale key cost every local turn a 401 and a switch to"
        + " another profile",
      );
    } else {
      warn(
        `auth profile ${profileId} still resolves a stale key for agent ${after.agents.join(", ")}`
        + " after the re-save; run `openclaw models auth paste-api-key --agent <id> --provider "
        + `${provider} --profile-id ${profileId} < data/.local-ai-token\` for each of them`,
      );
    }
  }

  if (unreadable.size > 0) {
    warn(
      `could not read ${[...unreadable].join(", ")}; the local-AI auth profiles held there were not`
      + " checked against data/.local-ai-token",
    );
  }
}

try {
  main();
} catch (error) {
  // Redacted all the same: nothing above means to put a credential in an Error,
  // and this line is the one place an unexpected one could reach the journal.
  warn(`local-AI auth profile check failed: ${redact(error && error.message ? error.message : error, knownSecrets)}`);
}
