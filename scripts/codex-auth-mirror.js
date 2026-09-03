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

/**
 * node:sqlite, resolved lazily at every call site that needs it. One `require`
 * for the whole file, and still lazy: a core old enough to lack the builtin
 * must fall through to the caller's catch, not fail at module load — this
 * script runs from gateway-pre-start.sh and may never block a gateway start.
 */
function sqliteDatabase() {
  return require("node:sqlite").DatabaseSync;
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
    const DatabaseSync = sqliteDatabase();
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
 * Core throws `InvalidSharedAuthStoreOwnershipError` on a value that is not
 * exactly `{location: "legacy-main"|"state-db"}` — one key, nothing else. A
 * credential mirror must not throw, so the same shape test answers `false`
 * instead: anything that is not an explicit, well-formed `state-db` is treated
 * as `legacy-main` and the row is left unread. That is core's answer for every
 * value it accepts but one, and for the values it rejects it refuses to boot at
 * all — so mirroring from such a row could only ever be wrong.
 */
function ownsSharedStore(valueJson) {
  if (typeof valueJson !== "string") return false;
  try {
    const parsed = JSON.parse(valueJson);
    return (
      Boolean(parsed) &&
      typeof parsed === "object" &&
      Object.keys(parsed).length === 1 &&
      parsed.location === "state-db"
    );
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
    const DatabaseSync = sqliteDatabase();
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
 * that still works, so an entry with no access token sorts LAST rather than
 * being dropped. It is never a fallback: when such an entry ranks first there
 * is no credential on the box at all, `credentialFromProfiles` returns null and
 * `main()` stops before any mirror or write-back.
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

  // Ranking by id ALONE is what broke: the read set now spans the shared and
  // the per-agent store, so `openai:chatgpt` at the head of PROFILE_KEYS let a
  // shared entry that expired hours ago outrank an agent's OWN live
  // `openai:default`, and the timer rewrote the spent token over the live one
  // every ten minutes.
  //
  // So one step goes in front of the id preference, and only one: whether the
  // credential is expired. That mirrors the single step of core's own
  // comparator this script can evaluate — `orderProfilesByMode` scores an
  // expired OAuth credential below an unexpired one
  // (`resolveTokenExpiryState`, openclaw dist/order-*.js). Expiry DEMOTES a
  // candidate here, it never drops one, because core keeps an expired OAuth
  // profile eligible and refreshes it (the `expired` reason code is scoped to
  // `type: "token"` — docs/auth-credential-semantics.md); a dead credential
  // still beats none.
  //
  // Three tiers, not two: live, then UNKNOWN, then expired. A missing or
  // unusable `expires` is never "expired" — that is core's answer too
  // (`resolveTokenExpiryState` returns `missing`/`invalid_expires`, and only
  // `expired` scores) — but it is not evidence of life either, so it must not
  // tie with a credential this box can see is still valid. Defensive only:
  // neither this repo's sign-in writer nor the Codex CLI omits `expires`, so no
  // shipped writer produces the shape. Ranking such an entry level with a live
  // one let a PROFILE_KEYS-preferred profile carrying no `expires` outrank an
  // agent's own demonstrably live login.
  //
  // LIMIT, stated rather than papered over: the only expiry signal here is the
  // box's wall clock. On a Jetson carrier board with no battery-backed RTC the
  // clock can be hours behind at boot — which is exactly when
  // gateway-pre-start.sh runs this — and a genuinely expired credential then
  // reads as live, every candidate ties, and the rank falls back to
  // PROFILE_KEYS, i.e. to beta's ordering. No local check closes that: a grace
  // period only forgives a clock running AHEAD, and the access token's own JWT
  // `exp` claim is evaluated against the same wrong clock. It self-heals on the
  // next ten-minute timer tick once NTP lands, and the degraded state is what
  // beta always did, so it is left as a known bound.
  //
  // NOT ranked by `expires` descending, however tempting: `expires` is issue
  // time PLUS that client's token lifetime, and the lifetimes differ. ClawBox's
  // own sign-in writer stamps `Date.now() + expiresIn*1000` and falls back to
  // eight hours, so a fresh ChatGPT sign-in routinely carries the SMALLEST
  // `expires` on a box that has ever run `codex login` — ordering by it would
  // mirror the older account.
  //
  // PROFILE_KEYS then decides, exactly as it did before this PR: it is the id
  // ClawBox files the sign-in under, and the only signal here that tracks which
  // profile core resolves for an `openai/*` route.
  const now = Date.now();
  const ranked = candidates
    .map((key) => {
      const entry = profiles[key];
      const expires = expiryOf(entry);
      const preference = PROFILE_KEYS.indexOf(key);
      return {
        key,
        // A profile with no access token cannot be mirrored at all. It stays a
        // candidate only so a half-written canonical entry cannot HIDE a legacy
        // one that still works; ranked last, it is never selected over a
        // credentialed entry, and when it wins the pass has no credential.
        uncredentialed: entry && entry.access ? 0 : 1,
        // 0 live, 1 unknown, 2 expired.
        expiry: expires === null ? 1 : expires <= now ? 2 : 0,
        preference: preference === -1 ? PROFILE_KEYS.length : preference,
      };
    })
    .sort(
      (a, b) =>
        a.uncredentialed - b.uncredentialed ||
        a.expiry - b.expiry ||
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
 * ~/.codex/auth.json gets a credential, and on a ClawBox nothing rotates that
 * file. The codex plugin reads it and never writes it, and the app-server's
 * CODEX_HOME is <agentDir>/codex-home -- the file it *does* rotate, see the
 * destination list in main(). Core has one documented opt-in that would point
 * the app-server at ~/.codex instead, `appServer.homeScope: "user"`
 * (docs/plugins/codex-harness-reference.md); ClawBox never sets it and nothing
 * in this repo writes it, so that shape is out of scope here.
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
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  // Holds an OAuth token — owner-only dir, not just the 0600 file.
  //
  // Guarded for the same reason the file chmod below is, and it costs more
  // when it is not: this runs BEFORE the write, so an EPERM here (a codex dir
  // owned by another user) threw out of writeMirror and aborted main()'s whole
  // destinations loop — losing this mirror AND every later one, including the
  // app-server's CODEX_HOME copy without which every Codex turn falls back to
  // the Cloudflare-challenged browser endpoint. One un-tightenable directory
  // must cost that directory's permissions, not the pass. The credential is
  // still written 0600, so the file itself stays owner-only either way.
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    console.error(
      `  Codex auth.json: could not tighten permissions on ${dir} — it may be readable by other users (${error.code || error.message}).`,
    );
  }
  fs.writeFileSync(
    dest,
    JSON.stringify(buildAuthFile(credential, existing), null, 2),
    { mode: 0o600 },
  );
  // `mode` applies on CREATION only, so a file another tool left 0644 stayed
  // 0644 through every rewrite while holding a refresh token. Non-fatal: the
  // credential is written either way, and an EPERM here (a file owned by
  // another user) must not abort the rest of the pass.
  //
  // console.error, not log(): the timer unit runs with
  // CODEX_AUTH_MIRROR_QUIET=1, so a log() line here is silent on the path that
  // runs 144 times a day — a mirror left world-readable while holding an OAuth
  // refresh token would say nothing at all. The rule this file keeps is that a
  // state which is not "normal and idempotent" goes to stderr, and failing to
  // tighten permissions on a credential file is that state.
  try {
    fs.chmodSync(dest, 0o600);
  } catch (error) {
    console.error(
      `  Codex auth.json: could not tighten permissions on ${dest} — it may be readable by other users (${error.code || error.message}).`,
    );
  }
  return reason;
}


/**
 * Collapse destinations that resolve to the same file. Nothing in this repo
 * creates it, but <agentDir>/codex-home CAN be a symlink to ~/.codex on a box
 * an operator has linked by hand; without this the same file gets written
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
 * When a rotation cannot be recorded — and when two app-server homes have
 * rotated independently, where there is no single right answer — `main()`
 * leaves those homes alone rather than guessing: per destination, never the
 * whole pass, and never the plugin's own file.
 *
 * ONLY the agent the credential was resolved from. A profile id is a key
 * within one agent's store, not a fleet-wide identity: a second agent may hold
 * the same id for a different account, and writing this rotation into it would
 * replace a refresh token that belongs to someone else and break its next
 * refresh. Note the consequence when the rotation came from agent B's
 * codex-home while the credential resolved from agent A: it is recorded in A's
 * store, the one core will resolve next. That is deliberate — A is the store
 * that hands out the token, and on the two shapes that ship it is either
 * unwritable (`state-db`) or A is `main`, whose store IS the shared store.
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
      const DatabaseSync = sqliteDatabase();
      const db = new DatabaseSync(dbPath);
      // Same timeout as both readers: without it a transient SQLITE_BUSY is
      // swallowed below, becomes `wrote = false`, and is reported to the
      // operator as an unsettleable divergence — a false failure over a lock.
      db.exec("PRAGMA busy_timeout = 5000");
      let open = false;
      try {
        // BEGIN IMMEDIATE, because busy_timeout serialises each statement's
        // lock acquisition and nothing more: the SELECT and the UPDATE below
        // are a read-modify-write of ONE json blob holding every profile, so a
        // writer landing between them is silently overwritten — and not only
        // for this profile id, for all of them. That writer exists: on a
        // `legacy-main` box this table IS the store core reads and writes when
        // it refreshes an OAuth credential itself, and two mirror passes can
        // overlap too (the boot pass from gateway-pre-start.sh and a timer
        // tick). Losing core's freshly rotated refresh token to the one this
        // pass read is precisely the `refresh_token_reused` shape the rest of
        // this file exists to prevent. IMMEDIATE takes the write lock before
        // the read, so a concurrent writer waits out the busy_timeout instead;
        // if it cannot, this pass fails into the catch below and the next tick
        // retries, which is the existing non-fatal contract.
        db.exec("BEGIN IMMEDIATE");
        open = true;
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
        db.exec("COMMIT");
        open = false;
        // Only after the COMMIT, and the guarantee is THIS loop's alone: a
        // rotation reported as recorded but rolled back would leave main()
        // adopting a token core does not hold. `wrote` is an OR across both
        // stores, and the legacy auth-profiles.json loop above sets it with no
        // transaction and no relation to this outcome — so on a box holding
        // both stores a successful JSON write still reports true when the
        // sqlite write is rolled back. Bounded rather than closed here: the
        // divergence persists, the next tick retries, and readProfiles prefers
        // that JSON file on exactly the boxes that have one.
        wrote = true;
      } finally {
        if (open) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Closing the handle rolls it back anyway; never mask the original.
          }
        }
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
   * no ClawBox process runs with CODEX_HOME=~/.codex (see buildAuthFile's note
   * for the one core opt-in that would, which ClawBox never sets). So a
   * divergence there is by definition a STALE copy and must be repaired, while
   * a divergence in a codex-home file may be a live rotation. Compared by
   * resolved path, because <agentDir>/codex-home CAN be a symlink to ~/.codex —
   * on such a box that one file IS an app-server home.
   */
  const appServerHomes = new Set(
    agentDirs.map((dir) => fileKey(path.join(dir, "codex-home", "auth.json"))),
  );
  const homeAuthKey = fileKey(homeAuthPath);
  const isAppServerHome = (dest) => appServerHomes.has(fileKey(dest));
  // ...but the plugin's own file is never abandoned, even when it is also an
  // app-server home. On a hand-symlinked box dedupePaths collapses both
  // destinations onto it, so skipping it leaves the box with NO usable
  // credential anywhere and every Codex turn dies on `401 Missing bearer` —
  // the failure this script exists to prevent — while the worst case of
  // writing it is one rotation lost on a shape nothing in this repo creates.
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
  const divergedAppServerHomes = diverged.filter(({ dest }) => isAppServerHome(dest));
  // Core's store holds ONE refresh token per profile, so it can record one
  // rotation. Adopting one of several means the rest are overwritten with it —
  // and skipping them only postpones that: on the next tick the skipped file is
  // the sole divergence, becomes the adopted one, and the first agent's live
  // token is discarded instead. Two tokens of one family, written into core ten
  // minutes apart, is the `refresh_token_reused` shape this file exists to
  // prevent. With more than one there is no correct single answer, so nothing
  // is adopted and every one of them is left alone for a person to settle.
  const rotated = divergedAppServerHomes.length === 1 ? divergedAppServerHomes[0] : undefined;

  // Destinations this pass must not touch. Only ever app-server homes whose
  // rotation could not be recorded in core: overwriting one could burn the
  // family (#278). NEVER the plugin's own file — abandoning that is how a box
  // ends up with no ~/.codex/auth.json at all, which is the `401 Missing
  // bearer` this script exists to prevent, and the ChatGPT sign-in route
  // deletes that file on every re-login so it has to be recreated here.
  const skip = new Set();

  // The plugin's own file is never skipped even when it is also an app-server
  // home (see isPluginOwnFile), so a symlinked box still gets a credential.
  const leaveAlone = (dest) => isAppServerHome(dest) && !isPluginOwnFile(dest);

  if (!rotated && divergedAppServerHomes.length > 1) {
    for (const { dest } of divergedAppServerHomes) {
      if (leaveAlone(dest)) skip.add(dest);
    }
  } else if (rotated) {
    const tokens = rotated.data.tokens;
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
        if (leaveAlone(dest)) skip.add(dest);
      }
    }
  }

  // One message for every state that leaves a file behind, naming the files
  // actually skipped rather than whichever divergence was found first: on a
  // symlinked box the sole destination is the plugin's own file, which this
  // pass then rewrites, and warning about it would be a false failure.
  //
  // console.error, not log(): the timer unit runs with
  // CODEX_AUTH_MIRROR_QUIET=1, and this is the one state that is not "normal
  // and idempotent". A ChatGPT sign-in clears these mirrors at the source (the
  // configure route), so it survives at most until the next one.
  if (skip.size > 0) {
    console.error(
      `  Codex auth.json: ${[...skip].join(", ")} holds a refresh token core does not have and core's store could not be updated; leaving that file alone. `
      + "If Codex turns keep failing, delete it and sign in to ChatGPT again.",
    );
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
  // Skipped destinations are already reported above; this line is about the
  // ones this pass owns, so a single left-behind file must not silence it —
  // and must not let it read as "every mirror is current" either, which is the
  // opposite of the warning printed a few lines up.
  if (synced === 0 && skip.size < destinations.length) {
    log(
      "Codex auth.json: credential already current" +
        (skip.size > 0 ? " on the files this pass owns" : ""),
    );
  }
}

try {
  main();
} catch (error) {
  // Never block gateway start on a credential mirror: this stays exit 0.
  //
  // console.error, not log(): anything landing here ended the pass early, with
  // some or all of the mirrors unwritten and no other line saying so — and
  // log() is silenced by CODEX_AUTH_MIRROR_QUIET=1, the timer unit's own
  // setting, whose SuccessExitStatus=0 1 then shows the unit green. A failure
  // that leaves the credential unmirrored is not "normal and idempotent", so
  // it goes to the channel the timer path can actually see.
  console.error("  Codex auth.json: " + error.message);
}
