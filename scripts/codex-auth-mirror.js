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
 * A store whose `profiles` map is EMPTY is not an answer.
 *
 * That is the shape a migrated box leaves behind, and treating it as one is
 * what made this script skip on every 2026.8 box: the per-agent row survives
 * `doctor --fix` with zero profiles, so `{}` shadowed the shared store that
 * actually holds the login. Core inherits past exactly this state.
 */
function hasProfiles(store) {
  return Boolean(store && store.profiles && Object.keys(store.profiles).length > 0);
}

/** The agent-local credential table, core 2026.7.x's home for the profiles. */
function readAgentProfiles(agentDir) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    db.exec("PRAGMA busy_timeout = 5000");
    let row;
    try {
      row = db
        .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
        .get("primary");
    } finally {
      db.close();
    }
    const parsed = row && row.store_json ? JSON.parse(row.store_json) : null;
    return hasProfiles(parsed) ? parsed.profiles : null;
  } catch {
    return null; // no node:sqlite, no table, or locked — non-fatal
  }
}

/**
 * The state directory OpenClaw resolves the gateway-wide store from: an
 * `OPENCLAW_STATE_DIR` override is trimmed, a leading `~` is the user's home
 * and a relative path is taken from the cwd; without one it is the OpenClaw
 * home. Same rule as src/lib/openclaw-state-store.ts, so this reads the file
 * the gateway actually writes.
 */
function stateDbPath() {
  const override = (process.env.OPENCLAW_STATE_DIR || "").trim();
  const dir = override
    ? path.resolve(override.replace(/^~(?=$|[\\/])/, () => process.env.HOME || os.homedir()))
    : openclawHome;
  return path.join(dir, "state", "openclaw.sqlite");
}

const SHARED_STORE_KEY = "authProfiles.store";
const SHARED_STORE_OWNERSHIP_KEY = "auth.sharedStore";

/**
 * Does core resolve the shared store from the state DB, or from the main
 * agent's own file?
 *
 * `auth.sharedStore` is the row core keys that entire decision on:
 * `resolveSharedAuthStorePath` returns `<stateDir>/state/openclaw.sqlite` only
 * when `location === "state-db"`, and otherwise
 * `<stateDir>/agents/main/agent/openclaw-agent.sqlite` — the per-agent table
 * this script already reads. An ABSENT row means `legacy-main`
 * (`parseSharedAuthStoreOwnership`). So on a box `doctor --fix` has not
 * relocated, the `authProfiles.store` row may exist and still be something core
 * never consults; mirroring from it hands the Codex runtime a credential core
 * does not resolve.
 *
 * Core throws on an unparseable value. A credential mirror must not — anything
 * that is not an explicit `state-db` is treated as `legacy-main` and the row is
 * left unread, which is the same answer core reaches for every legal value but
 * one.
 */
function ownsSharedStore(valueJson) {
  if (typeof valueJson !== "string") return false;
  try {
    const parsed = JSON.parse(valueJson);
    return Boolean(parsed) && parsed.location === "state-db";
  } catch {
    return false;
  }
}

/**
 * The gateway-wide store, where core keeps the profiles on 2026.8:
 * `<stateDir>/state/openclaw.sqlite`, table `config_machine_state`, row
 * `authProfiles.store`. `openclaw doctor --fix` performs the relocation once
 * and every agent then resolves through it — read-through inheritance, core's
 * own `docs/auth-credential-semantics.md`. The box records the move as
 * `auth.sharedStore = {"location":"state-db"}` in the same table, and both rows
 * are read in one statement so a locked database cannot answer "profiles, but
 * no ownership" and make this store look authoritative when it is not.
 */
function readSharedProfiles() {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // The gateway's hot state database — channel pairing writes, node host
    // config — not the quiet per-agent table the old reader touched. A
    // SQLITE_BUSY here is swallowed to null and surfaces as "no codex OAuth
    // profile yet", which is the message that hid this bug in the first place.
    db.exec("PRAGMA busy_timeout = 5000");
    let rows;
    try {
      rows = db
        .prepare("SELECT state_key, value_json FROM config_machine_state WHERE state_key IN (?, ?)")
        .all(SHARED_STORE_OWNERSHIP_KEY, SHARED_STORE_KEY);
    } finally {
      db.close();
    }
    const byKey = new Map(rows.map((row) => [row.state_key, row.value_json]));
    if (!ownsSharedStore(byKey.get(SHARED_STORE_OWNERSHIP_KEY))) return null;
    const value = byKey.get(SHARED_STORE_KEY);
    const parsed = value ? JSON.parse(value) : null;
    return hasProfiles(parsed) ? parsed.profiles : null;
  } catch {
    return null; // no node:sqlite, no table, or locked — non-fatal
  }
}

/**
 * The profiles core would resolve for this agent.
 *
 * Three stores, because the credential moved twice: legacy
 * agents/<id>/agent/auth-profiles.json, then the per-agent
 * `auth_profile_store` table on 2026.7.x, then the shared state store on
 * 2026.8. The legacy file is still first so a core downgrade keeps working;
 * the two sqlite stores are then combined the way core combines them — the
 * shared store as the read-through base with the agent's own profiles on top,
 * never one shadowing the other, because an agent that has a local profile of
 * its own still inherits the rest.
 */
function readProfiles(agentDir) {
  const fromJson = readJson(path.join(agentDir, "auth-profiles.json"));
  if (hasProfiles(fromJson)) return fromJson.profiles;
  const local = readAgentProfiles(agentDir);
  const shared = readSharedProfiles();
  if (!local && !shared) return null;
  return { ...(shared || {}), ...(local || {}) };
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
 * The most usable entry, by core's own ranking (see profileKeyIn). A canonical
 * entry left half-written by an interrupted sign-in must not hide a legacy one
 * that still works; an entry that merely EXISTS is a last resort, so a rotation
 * still lands somewhere when nothing is credentialed yet.
 *
 * One rule for both directions, deliberately. Reading by one rule and writing
 * back by another is how a box ends up reading `codex:default` and writing the
 * rotated token into `openai:chatgpt`, leaving the entry it reads next holding
 * a refresh token that has already been spent.
 */
/** An openai-provider OAuth profile is a ChatGPT sign-in, whatever it is keyed. */
function isChatgptProfile(key, entry) {
  if (!entry || typeof entry !== "object") return false;
  const provider = String(entry.provider || key.split(":")[0] || "").trim().toLowerCase();
  const mode = String(entry.type || entry.mode || "").trim().toLowerCase();
  if (mode && mode !== "oauth") return false;
  return provider === "openai" || provider === "codex" || provider === "openai-codex";
}

/**
 * `expires` as core validates it: a finite number of Unix epoch MILLISECONDS,
 * greater than 0 and no larger than the maximum JavaScript timestamp. Anything
 * else is "unknown", never "expired" — `resolveTokenExpiryState`.
 */
function expiryOf(entry) {
  const expires = entry && entry.expires;
  const valid =
    typeof expires === "number" &&
    Number.isFinite(expires) &&
    expires > 0 &&
    expires <= 864e13;
  return valid ? expires : null;
}

function profileKeyIn(profiles) {
  if (!profiles) return null;
  // Every profile that is a ChatGPT sign-in by shape, not just the three
  // literal ids: those miss the two `doctor --fix` itself allocates when it
  // migrates a legacy `openai-codex:default` (`openai:default`, or
  // `openai:chatgpt-default` when that is taken), so a doctor-migrated box
  // produced an available ChatGPT row, a runtime arm and a subscription
  // entitlement while THIS script found no credential.
  const candidates = Object.keys(profiles).filter((key) => isChatgptProfile(key, profiles[key]));
  if (candidates.length === 0) return null;

  // Rank the way core ranks, not by id. `orderProfilesByMode` sorts oauth
  // before token before api_key, then an UNEXPIRED credential ahead of an
  // expired one, and only then reaches a stable tie-break — and an expired
  // OAuth profile stays *eligible* there, because core refreshes it (the
  // `expired` reason code is scoped to `type: "token"` in
  // docs/auth-credential-semantics.md). So expiry demotes a candidate here; it
  // never drops one, and a dead credential is still better than none.
  //
  // Ranking by id alone is what broke: the read set spans the shared and the
  // per-agent store, so `openai:chatgpt` at the head of PROFILE_KEYS let a
  // shared entry that expired hours ago outrank an agent's OWN live
  // `openai:default`, and the timer rewrote the spent token over the live one
  // every ten minutes. PROFILE_KEYS is the tie-break among equally usable
  // candidates, which is all it was ever measuring.
  const now = Date.now();
  const ranked = candidates
    .map((key) => {
      const entry = profiles[key];
      const expires = expiryOf(entry);
      const preference = PROFILE_KEYS.indexOf(key);
      return {
        key,
        // A profile with no access token cannot be mirrored at all; it is only
        // a candidate so a rotation still has somewhere to land.
        uncredentialed: entry && entry.access ? 0 : 1,
        expired: expires !== null && expires <= now ? 1 : 0,
        // Later expiry means more recently issued: after a re-login the
        // freshest credential is the account the owner actually signed in to.
        staleness: -(expires ?? 0),
        preference: preference === -1 ? PROFILE_KEYS.length : preference,
      };
    })
    .sort(
      (a, b) =>
        a.uncredentialed - b.uncredentialed ||
        a.expired - b.expired ||
        a.staleness - b.staleness ||
        a.preference - b.preference ||
        a.key.localeCompare(b.key),
    );
  return ranked[0].key;
}

function credentialFromProfiles(agentDir) {
  const profiles = readProfiles(agentDir);
  const key = profileKeyIn(profiles);
  const profile = key && profiles[key] && profiles[key].access ? profiles[key] : null;
  if (!profile) return null;
  return {
    // The id this credential was READ from. A rotation is written back into
    // this exact entry and no other: the profiles are merged across the shared
    // and per-agent stores, so "some ChatGPT-shaped key in the local table" can
    // be a different entry entirely — grafting an OAuth bundle onto it leaves
    // the entry core actually resolves holding a spent refresh token, which is
    // the split PROFILE_KEYS' own comment exists to prevent.
    profileId: key,
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
 * Rewrite whenever the file drifts from core's profile. Whether a drift means
 * "stale copy" or "the app-server rotated ahead of core" depends on WHICH file
 * it is; main() decides that (see appServerHomes) and only calls this for the
 * destinations it has already ruled writable.
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
  // `mode` applies on CREATION only, so a file another tool left 0644 stayed
  // 0644 through every rewrite while holding a refresh token.
  fs.chmodSync(dest, 0o600);
  return reason;
}


/**
 * Collapse destinations that resolve to the same file. <agentDir>/codex-home
 * is sometimes a symlink to ~/.codex; without this the same file gets written
 * twice, and a previous version deleted the real credential through the link.
 */
function fileKey(file) {
  try {
    return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
  } catch {
    return file; // Directory doesn't exist yet — the raw path is unique enough.
  }
}

function dedupePaths(files) {
  const seen = new Map();
  for (const file of files) {
    const key = fileKey(file);
    if (!seen.has(key)) seen.set(key, file);
  }
  return [...seen.values()];
}

/**
 * Write an app-server rotation back into core's auth profile store, so core
 * stops handing out a refresh token that has already been spent.
 *
 * Reaches the legacy JSON file and the per-agent table only. The state DB row
 * `authProfiles.store` is deliberately never written: on a `state-db` box that
 * row is the gateway-wide store every agent resolves through, and core
 * serialises every OAuth refresh through
 * `<stateDir>/locks/oauth-refresh/lock-<digest>` precisely to stop a
 * `refresh_token_reused` storm, so an unlocked read-modify-write of it from a
 * timer could overwrite a live token with a spent one for every agent at once.
 * (On a `legacy-main` box the shared store IS the main agent's own
 * `openclaw-agent.sqlite`, which the loop below does write — unlocked, as beta
 * did; that hazard is older than this script's shared-store read and is not
 * settled here.)
 *
 * When a rotation cannot be recorded, `main()` leaves the app-server home that
 * carries it alone rather than guessing — per destination, never the whole
 * pass, and never the plugin's own file.
 *
 * ONLY the agent the credential was resolved from. A profile id is a key
 * within one agent's store, not a fleet-wide identity: a second agent may hold
 * the same id for a different account, and writing this rotation into it would
 * replace a refresh token that belongs to someone else and break its next
 * refresh.
 */
function writeBackToCore(agentDirs, tokens, profileId) {
  if (!tokens || !tokens.refresh_token || !profileId) return false;
  let wrote = false;

  // Legacy JSON store, still the source on some boxes.
  for (const agentDir of agentDirs) {
    const jsonPath = path.join(agentDir, "auth-profiles.json");
    const data = readJson(jsonPath);
    const profiles = data && data.profiles;
    if (!profiles || !profiles[profileId]) continue;
    const id = profileId;
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
      // Same timeout as both readers: without it a transient SQLITE_BUSY is
      // swallowed below, becomes `wrote = false`, and is reported to the
      // operator as an unsettleable divergence — a false failure over a lock.
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        const row = db
          .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
          .get("primary");
        if (!row || !row.store_json) continue;
        const store = JSON.parse(row.store_json);
        const profiles = store.profiles || {};
        if (!profiles[profileId]) continue;
        const id = profileId;
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
  let credentialAgentDir = null;
  for (const dir of [...agentDirs].sort(mainFirst)) {
    credential = credentialFromProfiles(dir);
    if (credential) {
      credentialAgentDir = dir;
      break;
    }
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

  /**
   * Only a file the Codex app-server owns can be AHEAD of core.
   *
   * The app-server rotates whatever sits in its CODEX_HOME; nothing rotates
   * `~/.codex/auth.json` — the codex plugin reads it and never writes it, and
   * no process runs with CODEX_HOME=~/.codex (see buildAuthFile's note). So a
   * divergence there is by definition a STALE copy and must be repaired, while
   * a divergence in a codex-home file may be a live rotation. Compared by
   * resolved path, because <agentDir>/codex-home is sometimes a symlink to
   * ~/.codex — on such a box that one file IS an app-server home.
   */
  const appServerHomes = new Set(
    agentDirs.map((dir) => fileKey(path.join(dir, "codex-home", "auth.json"))),
  );
  const homeAuthKey = fileKey(homeAuthPath);
  const isAppServerHome = (dest) => appServerHomes.has(fileKey(dest));
  // ...but the plugin's own file is never abandoned, even when it is also an
  // app-server home. On a symlinked box dedupePaths collapses both
  // destinations onto it, so skipping it leaves the box with NO usable
  // credential anywhere and every Codex turn dies on `401 Missing bearer` —
  // the failure this script exists to prevent — while the worst case of
  // writing it is one rotation lost on a configuration ClawBox never creates.
  const isPluginOwnFile = (dest) => fileKey(dest) === homeAuthKey;

  // The app-server rotates its own CODEX_HOME credential. Refresh tokens are
  // single-use, so if it has already rotated, core's stored copy is the DEAD
  // one -- overwriting the file with it would burn the family on next use.
  // Core follows the app-server, never the other way round.
  const diverged = destinations
    .map((dest) => ({ dest, data: readJson(dest) }))
    .filter(({ data }) => {
      const tokens = (data && data.tokens) || {};
      return (
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token &&
        tokens.refresh_token !== credential.refreshToken
      );
    });
  const rotated = diverged.find(({ dest }) => isAppServerHome(dest));

  // Destinations this pass must not touch. Only ever app-server homes whose
  // rotation could not be recorded in core: overwriting one could burn the
  // family (#278). NEVER the plugin's own file — abandoning that is how a box
  // ends up with no ~/.codex/auth.json at all, which is the `401 Missing
  // bearer` this script exists to prevent, and the ChatGPT sign-in route
  // deletes that file on every re-login so it has to be recreated here.
  const skip = new Set();

  if (rotated) {
    const tokens = rotated.data.tokens;
    // Every OTHER diverged app-server home owns a rotation of its own: two
    // agents run two app-servers, each rotating its own CODEX_HOME, and core
    // can record only one of them. Writing the adopted token over the rest
    // discards their live refresh tokens — the same burn the failure branch
    // below exists to prevent. (The plugin's own file is still never skipped;
    // see isPluginOwnFile.)
    for (const { dest } of diverged) {
      if (dest !== rotated.dest && isAppServerHome(dest) && !isPluginOwnFile(dest)) skip.add(dest);
    }
    if (writeBackToCore([credentialAgentDir], tokens, credential.profileId)) {
      log(`Codex auth.json: adopted app-server rotation from ${rotated.dest}`);
      credential = {
        profileId: credential.profileId,
        accessToken: tokens.access_token || credential.accessToken,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token || credential.idToken,
        accountId: tokens.account_id || credential.accountId,
      };
    } else {
      // Per destination, never the whole pass: core's own refresh moves the
      // store ahead of every mirror, and treating that as "the file is ahead"
      // would stop the mirror on a box where the files are simply old. Each
      // app-server home that still disagrees is left as it is; everything else
      // is written.
      for (const { dest } of diverged) {
        if (isAppServerHome(dest) && !isPluginOwnFile(dest)) skip.add(dest);
      }
      // Only about files actually left behind, and naming those rather than
      // whichever divergence was found first: on a symlinked box the sole
      // destination is the plugin's own file, which this pass then rewrites,
      // and warning about it would be a false failure.
      //
      // console.error, not log(): the timer unit runs with
      // CODEX_AUTH_MIRROR_QUIET=1, and this is the one state that is not
      // "normal and idempotent". A ChatGPT sign-in clears these mirrors at the
      // source (the configure route), so this survives at most until the next
      // one.
      if (skip.size > 0) {
        console.error(
          `  Codex auth.json: ${[...skip].join(", ")} holds a refresh token core does not have and core's store could not be updated; leaving that file alone. `
          + "If Codex turns keep failing, delete it and sign in to ChatGPT again.",
        );
      }
    }
  }

  let synced = 0;
  for (const dest of destinations) {
    if (skip.has(dest)) continue;
    const reason = writeMirror(dest, credential);
    if (reason) {
      synced += 1;
      log(`Codex auth.json ${reason}: ${dest}`);
    }
  }
  if (synced === 0 && skip.size === 0) log("Codex auth.json: credential already current");
}

try {
  main();
} catch (error) {
  // Never block gateway start on a credential mirror.
  log("Codex auth.json: " + error.message);
}
