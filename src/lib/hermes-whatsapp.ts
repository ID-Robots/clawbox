// WhatsApp on a Hermes device.
//
// WHAT HERMES ACTUALLY SUPPORTS, AND WHAT THAT MEANS FOR CLAWBOX
//
// Hermes ships a first-class WhatsApp platform adapter
// (plugins/platforms/whatsapp/) that talks to WhatsApp Web through a bundled
// Node bridge (Baileys). It is NOT the official Business API: there is no
// token to paste. Authentication is a QR code scanned from the owner's phone,
// and the resulting session lands on disk as creds.json.
//
// The only supported way to produce that session is `hermes whatsapp`, whose
// full --help is:
//
//     usage: hermes whatsapp [-h]
//     Configure WhatsApp and pair via QR code
//
// Zero flags, no --json, no --non-interactive. It is a TTY wizard that renders
// a live QR and waits for a scan — exactly the same shape as `hermes gateway
// setup`, which src/lib/hermes-telegram.ts already documents as impossible to
// drive from a route handler. `hermes whatsapp-cloud` (the official Meta Cloud
// API adapter) is the same: a zero-flag TTY wizard, and it additionally needs a
// Meta Business account and a PUBLIC webhook URL, which a box behind a home
// router or serving its own AP cannot receive.
//
// So ClawBox does NOT try to reimplement pairing. What it does own is
// everything around it, which is the part that actually needs a UI:
//
//   * report the real state (Hermes' own three-way verdict, gateway.py:6280 —
//     "not configured" / "enabled, not paired" / "configured + paired")
//   * write the access allowlist, which is the security-critical bit and is
//     otherwise only reachable by re-running the whole wizard
//   * turn the channel off (and back on once paired) without a terminal
//
// WHY NOT `hermes config set`
//
// No WHATSAPP_* key passes hermes_cli/config.py `_is_env_config_key`, so
// `hermes config set WHATSAPP_ENABLED true` writes into config.yaml instead of
// .env. See src/lib/hermes-env.ts for the full explanation; that module is the
// writer used here, matching the adapter's own `save_env_value` calls.

import fs from "fs/promises";
import path from "path";
import { hermesHome, readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";

export const WHATSAPP_ENV_ENABLED = "WHATSAPP_ENABLED";
export const WHATSAPP_ENV_MODE = "WHATSAPP_MODE";
export const WHATSAPP_ENV_ALLOWED_USERS = "WHATSAPP_ALLOWED_USERS";
export const WHATSAPP_ENV_ALLOW_ALL_USERS = "WHATSAPP_ALLOW_ALL_USERS";

export type WhatsappMode = "bot" | "self-chat";

export function isWhatsappMode(value: unknown): value is WhatsappMode {
  return value === "bot" || value === "self-chat";
}

/**
 * Where the bridge keeps its session.
 *
 * Two locations, and they genuinely disagree upstream: the adapter resolves
 * `get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")` (new path,
 * legacy fallback) while the CLI's status helper only ever stats the legacy
 * `~/.hermes/whatsapp/session/creds.json`. Checking both is the only way to be
 * right on an install of either vintage.
 */
export function whatsappSessionDirs(): string[] {
  const home = hermesHome();
  return [path.join(home, "platforms", "whatsapp", "session"), path.join(home, "whatsapp", "session")];
}

/** The Baileys bridge as it ships inside the Hermes checkout. May be read-only. */
export function whatsappBridgeInstallDir(): string {
  const agent =
    process.env.HERMES_AGENT_DIR || path.join(hermesHome(), "hermes-agent");
  return path.join(agent, "scripts", "whatsapp-bridge");
}

/** Where upstream mirrors the bridge when the install tree cannot be written. */
export function whatsappBridgeMirrorDir(): string {
  return path.join(hermesHome(), "scripts", "whatsapp-bridge");
}

let resolvedBridgeDir: string | null = null;

/**
 * Give the owner write access to every entry under `root`, `root` included.
 *
 * `fs.cp` copies modes verbatim, so a mirror taken from a read-only install
 * tree is read-only all the way down. `npm install` writes into nested
 * directories (node_modules/, and package-lock.json beside it), so adding u+w
 * to the top directory alone is not enough to make the copy usable.
 *
 * Best-effort per entry: a mirror we cannot fully relax is still worth
 * returning, and the install that follows reports its own failure.
 */
async function makeTreeWritable(root: string): Promise<void> {
  // `string[]`, spelled out. Deriving it from `typeof fs.readdir` resolves to
  // the wrong one of that function's overloads — the `Dirent[]` one — so the
  // assignment below and the `path.join` at the end both failed to compile.
  let entries: string[] = [];
  try {
    const stat = await fs.lstat(root);
    // Symlinks carry no meaningful mode of their own and chmod follows them,
    // which would reach back out of the mirror into the source tree.
    if (stat.isSymbolicLink()) return;
    // Mask to the permission bits — stat.mode also carries the file type, and
    // 0o700 on a directory is what makes the readdir below possible at all.
    const perms = stat.mode & 0o777;
    await fs.chmod(root, perms | (stat.isDirectory() ? 0o700 : 0o200));
    if (!stat.isDirectory()) return;
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    await makeTreeWritable(path.join(root, entry));
  }
}

/**
 * The bridge directory to actually work in.
 *
 * A straight `$HERMES_AGENT_DIR/scripts/whatsapp-bridge` is only right where
 * that tree is writable, and upstream knows it is not always: gateway/platforms/
 * whatsapp_common.py `resolve_whatsapp_bridge_dir()` probes the install tree
 * with a touch, and on failure (Docker's read-only /opt/hermes) mirrors the
 * bridge into HERMES_HOME and uses that copy instead. Every upstream caller —
 * the CLI wizard, the adapter, doctor, the web server — goes through it.
 *
 * That distinction did not matter while pairing was a terminal-only affair.
 * It matters now, because enabling the channel from the panel runs `npm
 * install` in this directory, and running it inside a read-only install tree
 * fails with nothing an owner could act on. So mirror upstream's resolution,
 * including the copy, and cache the answer: spawnBridge() needs it
 * synchronously, and start() always resolves before anything else touches
 * the directory.
 */
export async function resolveWhatsappBridgeDir(): Promise<string> {
  const install = whatsappBridgeInstallDir();
  const mirror = whatsappBridgeMirrorDir();

  // Upstream's own probe: writability is the only property the caller cares
  // about, and stat() cannot tell you about a read-only mount.
  const probe = path.join(install, ".write_test");
  try {
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
    resolvedBridgeDir = install;
    return install;
  } catch {
    // read-only (or absent) — fall through to the mirror
  }

  if (await exists(mirror)) {
    resolvedBridgeDir = mirror;
    return mirror;
  }

  try {
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await fs.cp(install, mirror, { recursive: true, errorOnExist: true, force: false });
    // The copy inherits the source's mode for EVERY entry, not just the top
    // one, and a bridge mirrored out of a tree that was read-only by permission
    // would arrive read-only too — which defeats the whole point, since the
    // next thing to run in here is `npm install`. chmod'ing only `mirror` left
    // every nested directory unwritable, so the install still failed the moment
    // npm tried to write inside one.
    await makeTreeWritable(mirror);
    resolvedBridgeDir = mirror;
    return mirror;
  } catch {
    // Nothing writable anywhere, or no install tree to copy. Returning the
    // install path keeps every read-only check honest and lets the install
    // fail as install_failed rather than against a directory we invented.
    resolvedBridgeDir = install;
    return install;
  }
}

/**
 * The resolved bridge directory, synchronously. Falls back to the install tree
 * until resolveWhatsappBridgeDir() has run at least once in this process.
 */
export function whatsappBridgeDir(): string {
  return resolvedBridgeDir ?? whatsappBridgeInstallDir();
}

/** Tests only: forget the cached resolution. */
export function resetWhatsappBridgeDirForTests(): void {
  resolvedBridgeDir = null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** True once a QR scan has produced a linked session. */
export async function whatsappPaired(): Promise<boolean> {
  for (const dir of whatsappSessionDirs()) {
    if (await exists(path.join(dir, "creds.json"))) return true;
  }
  return false;
}

/**
 * Whether the bundled Node bridge has its dependencies installed.
 *
 * Tri-state: `null` means we could not find the bridge directory at all (a
 * non-Hermes box, or a checkout laid out differently), which must not be shown
 * as "your bridge is broken".
 */
export async function whatsappBridgeReady(): Promise<boolean | null> {
  const dir = whatsappBridgeDir();
  if (!(await exists(dir))) return null;
  return exists(path.join(dir, "node_modules"));
}

// ── Phone numbers ───────────────────────────────────────────────────────────

/**
 * Normalise a phone number to the form Hermes expects: country code first,
 * digits only, NO leading "+".
 *
 * OpenClaw's WhatsApp channel wants the opposite (`+15551234567`), which is a
 * quiet way to get an allowlist that silently denies everyone. Keeping the
 * normalisation in one named function means the difference is testable rather
 * than implied by whatever the user happened to paste.
 *
 * Returns null for anything that cannot be a phone number. E.164 allows at most
 * 15 digits; a country code plus a subscriber number is never shorter than 7.
 */
export function normalizeWhatsappNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Parse a stored WHATSAPP_ALLOWED_USERS value into normalised numbers. */
export function parseAllowedUsers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // "*" is upstream's allow-everyone marker; it is not a user and ClawBox
    // never writes it, but an env edited by hand can contain it.
    if (trimmed === "*") continue;
    const normalized = normalizeWhatsappNumber(trimmed);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Serialise for WHATSAPP_ALLOWED_USERS (the adapter strips spaces itself). */
export function formatAllowedUsers(numbers: string[]): string {
  return numbers.join(",");
}

// -- Sender identity: JIDs, LIDs and the gateway allowlist ------------------
//
// THE SECOND AUTHORIZATION LAYER
//
// Pairing a box is not the same as authorizing anyone on it. The bridge's
// self-chat filter decides which *chats* are forwarded; the gateway then runs a
// separate check on the *sender* before the agent ever sees the message --
// gateway/authz_mixin.py `_is_user_authorized`, which reads
// WHATSAPP_ALLOWED_USERS (and WHATSAPP_ALLOW_ALL_USERS) out of the environment.
// With neither set, and no pairing-store grant, that function falls through to
// `GATEWAY_ALLOW_ALL_USERS` -- unset on a ClawBox -- and returns False. The
// gateway logs "Unauthorized user: <id> on whatsapp" and drops the message.
//
// So a box can pair perfectly and then answer nobody, including its owner.
// Making that state unreachable is what this section is for.
//
// HOW THE GATEWAY ACTUALLY COMPARES IDS (read on a live device, in
// gateway/whatsapp_identity.py and authz_mixin.py `_is_user_authorized`)
//
//   * `normalize_whatsapp_identifier` reduces an id to its bare numeric core:
//     trim, drop the FIRST "+", cut at the first ":" (device suffix), then cut
//     at the first "@" (domain). So "100000000000001:7@lid" and
//     "100000000000001" are the same principal.
//   * for WhatsApp every allowlist entry is run through
//     `expand_whatsapp_aliases` and the result REPLACES the allowlist, so the
//     comparison happens on bare numeric ids -- never on the "@lid" spelling.
//   * that expansion also walks the bridge's `lid-mapping-*.json` files, which
//     is how a phone id and a LID resolve to each other. Those files are
//     written by the bridge as it learns mappings; on a freshly paired box the
//     owner's own pair need not be there yet.
//
// That last point is the one that matters here. The bridge's pair-json
// `connected` event reports `sock.user.id`, which is the PHONE jid
// ("359...:7@s.whatsapp.net"), while a self-chat message from the same human
// can arrive under the LID ("200...@lid") -- the exact mismatch behind the live
// failure. Writing only the connected id would authorize the owner only where a
// lid-mapping file happened to exist already. So the allowlist is built from
// BOTH `me.id` and `me.lid` in creds.json, and never from the event alone.
//
// Each id is written in two spellings (qualified and bare). On this gateway the
// bare form is the one that matches; the qualified form is kept because it is
// what an operator reading .env recognises, and because a gateway without
// whatsapp_identity.py compares the raw strings instead.

/**
 * Hermes' `normalize_whatsapp_identifier`, character for character.
 *
 * Note what it does NOT do: internal whitespace survives. An allowlist entry
 * like "+359 879 691 194" normalises to "359 879 691 194", which then fails
 * upstream's `_SAFE_IDENTIFIER_RE` and expands to nothing -- a silently denied
 * user. Everything written from here is therefore whitespace-free by
 * construction (normalizeWhatsappNumber covers the panel's input path).
 */
export function normalizeWhatsappIdentifier(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace("+", "")
    .split(":", 1)[0]
    .split("@", 1)[0];
}

/**
 * The allowlist spellings to write for one raw sender id.
 *
 * "100000000000001:7@lid" produces ["100000000000001@lid", "100000000000001"],
 * which is exactly the value proven to work on the bench box. A bare number
 * yields just itself; anything that normalises to nothing yields nothing.
 */
export function whatsappAllowlistForms(raw: string | null | undefined): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];
  const bare = normalizeWhatsappIdentifier(value);
  if (!bare) return [];
  const forms: string[] = [];
  const at = value.indexOf("@");
  if (at >= 0) {
    // Re-attach the domain to the NORMALISED id, so a device suffix never
    // reaches .env: "200...:7@lid" is stored as "200...@lid".
    const domain = value.slice(at + 1).trim();
    if (domain && !/[\s,]/.test(domain)) forms.push(`${bare}@${domain}`);
  }
  forms.push(bare);
  return [...new Set(forms)];
}

/** The linked account, as the bridge wrote it into creds.json. */
export interface PairedWhatsappIdentity {
  /** Phone-format JID, e.g. "359...:7@s.whatsapp.net". */
  id: string | null;
  /** LID, e.g. "200...:7@lid". Absent on older bridge versions. */
  lid: string | null;
  name: string | null;
}

/**
 * Read the paired account out of the bridge session.
 *
 * creds.json is the only durable record of who this box is linked as: the
 * pairing manager's snapshot lives in one Next process and is gone after a
 * restart, and it carries `id` but never `lid`.
 */
export async function readPairedWhatsappIdentity(): Promise<PairedWhatsappIdentity | null> {
  for (const dir of whatsappSessionDirs()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, "creds.json"), "utf-8"));
    } catch {
      // Absent, unreadable or half-written -- try the other location.
      continue;
    }
    const me = (parsed as { me?: unknown } | null)?.me;
    if (!me || typeof me !== "object") continue;
    const record = me as Record<string, unknown>;
    const str = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    const identity: PairedWhatsappIdentity = {
      id: str(record.id),
      lid: str(record.lid),
      name: str(record.name),
    };
    if (identity.id || identity.lid) return identity;
  }
  return null;
}

/**
 * Every allowlist entry that authorizes the paired owner.
 *
 * `extraIds` carries ids known outside creds.json -- in practice the id from
 * the bridge's `connected` event, which is available a moment before the file
 * on disk is guaranteed to be complete.
 */
export function pairedIdentityAllowlistEntries(
  identity: PairedWhatsappIdentity | null,
  extraIds: (string | null | undefined)[] = [],
): string[] {
  const out: string[] = [];
  for (const raw of [identity?.id, identity?.lid, ...extraIds]) {
    out.push(...whatsappAllowlistForms(raw));
  }
  return [...new Set(out)];
}

/**
 * Union `additions` into an existing WHATSAPP_ALLOWED_USERS value.
 *
 * A box may already carry entries this panel never wrote -- a hand-edited .env,
 * or an earlier release. Auto-authorizing the owner must add to that list, not
 * replace it, and must be idempotent: running it twice changes nothing.
 *
 * De-duplication is on (normalised id, domain), which is what lets the two
 * spellings of one id survive as the deliberate pair they are while a genuine
 * repeat -- including one differing only by device suffix -- is dropped.
 */
export function mergeAllowlistEntries(
  existingRaw: string | null | undefined,
  additions: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (entry: string): void => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const at = trimmed.indexOf("@");
    const key =
      trimmed === "*"
        ? "*"
        : `${normalizeWhatsappIdentifier(trimmed)}@${at >= 0 ? trimmed.slice(at + 1) : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  for (const part of String(existingRaw ?? "").split(",")) push(part);
  for (const entry of additions) push(entry);
  return out;
}

/**
 * Does this allowlist authorize the paired owner?
 *
 * Deliberately CONSERVATIVE: it compares normalised ids only and does not walk
 * the bridge's lid-mapping files the way `expand_whatsapp_aliases` does. It can
 * therefore say "not authorized" where the gateway would in fact allow the
 * sender through a learned alias. That is the safe direction for a warning --
 * the opposite error would reassure an owner whose box answers nobody.
 */
export function allowlistAuthorizes(
  rawAllowlist: string | null | undefined,
  identity: PairedWhatsappIdentity | null,
): boolean {
  if (!identity) return false;
  const allowed = new Set<string>();
  for (const part of String(rawAllowlist ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Upstream's allow-everyone marker, checked before normalisation because
    // "*" is not an identifier.
    if (trimmed === "*") return true;
    const normalized = normalizeWhatsappIdentifier(trimmed);
    if (normalized) allowed.add(normalized);
  }
  if (allowed.size === 0) return false;
  for (const raw of [identity.id, identity.lid]) {
    const normalized = normalizeWhatsappIdentifier(raw);
    if (normalized && allowed.has(normalized)) return true;
  }
  return false;
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Hermes' own three-way verdict, kept verbatim so ClawBox and `hermes gateway
 * status` can never disagree about the same box.
 */
export type WhatsappState = "not_configured" | "enabled_not_paired" | "paired";

export interface HermesWhatsappStatus {
  state: WhatsappState;
  enabled: boolean;
  paired: boolean;
  mode: WhatsappMode | null;
  allowedUsers: string[];
  /** WHATSAPP_ALLOW_ALL_USERS — upstream calls this dev-only; ClawBox surfaces
   *  it as a warning and never sets it. */
  allowAllUsers: boolean;
  /** null = bridge directory not found, not "bridge broken". */
  bridgeReady: boolean | null;
  /**
   * Does the gateway's sender allowlist cover the account this box is paired
   * as? Pairing and authorization are two different gates (see the identity
   * section above), and a box that passes the first and fails the second looks
   * perfectly healthy while answering nobody. Surfacing it is what lets the
   * panel warn instead of leaving the owner to discover the silence.
   *
   * False whenever nothing is paired -- there is no owner to authorize yet.
   */
  authorized: boolean;
}

function envIsTrue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export async function readHermesWhatsappStatus(): Promise<HermesWhatsappStatus> {
  const [env, paired, bridgeReady] = await Promise.all([
    readHermesEnv(),
    whatsappPaired(),
    whatsappBridgeReady(),
  ]);

  const enabled = envIsTrue(env[WHATSAPP_ENV_ENABLED]);
  const rawMode = (env[WHATSAPP_ENV_MODE] || "").trim();
  const allowedUsers = parseAllowedUsers(env[WHATSAPP_ENV_ALLOWED_USERS]);
  const allowAllUsers =
    envIsTrue(env[WHATSAPP_ENV_ALLOW_ALL_USERS]) ||
    (env[WHATSAPP_ENV_ALLOWED_USERS] || "").trim() === "*";

  const state: WhatsappState = !enabled ? "not_configured" : paired ? "paired" : "enabled_not_paired";

  // Only worth a file read when there is a link to check.
  const identity = paired ? await readPairedWhatsappIdentity() : null;

  return {
    state,
    enabled,
    paired,
    mode: isWhatsappMode(rawMode) ? rawMode : null,
    allowedUsers,
    allowAllUsers,
    bridgeReady,
    authorized: allowAllUsers || allowlistAuthorizes(env[WHATSAPP_ENV_ALLOWED_USERS], identity),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface WhatsappConfigUpdate {
  /** Replaces the allowlist wholesale. An empty array clears the key. */
  allowedUsers?: string[];
  mode?: WhatsappMode;
  enabled?: boolean;
}

export class WhatsappNotPairedError extends Error {
  constructor() {
    super("WhatsApp is not paired yet");
    this.name = "WhatsappNotPairedError";
  }
}

export interface WhatsappConfigResult {
  /** Env keys written, for the caller's audit line. Never the values. */
  changedKeys: string[];
  /** Is there a linked session on disk? */
  paired: boolean;
  /** Does the configuration now on disk let the paired owner through? */
  authorized: boolean;
}

/**
 * Apply an access-control / enablement change to ~/.hermes/.env.
 *
 * ENABLING IS GATED ON PAIRING, on purpose. Upstream's wizard deliberately
 * writes WHATSAPP_ENABLED=true only after a successful scan (hermes_cli
 * main.py: "an aborted setup leaves WHATSAPP_ENABLED unset -> gateway skips
 * it"), because an enabled-but-unpaired adapter starts the bridge, fails to
 * find creds.json, and logs an error on every gateway boot. ClawBox must not
 * be the thing that puts a box into that state, so `enabled: true` without a
 * session is refused rather than written.
 *
 * Disabling is always allowed -- turning a channel off must never depend on the
 * channel being healthy.
 *
 * THE INVARIANT: no change made here may leave a paired box that authorizes
 * nobody. WHATSAPP_MODE decides which chats reach the gateway, but the gateway
 * still checks the sender, so the two have to be configured together:
 *
 *   * self-chat -- the only sender that can ever be right is the owner, so the
 *     owner's own ids ARE the allowlist.
 *   * bot -- the panel's numbers are the allowlist, plus the owner, who must
 *     not lose access to his own box by adding somebody else to it.
 *
 * Both cases reduce to the same rule, applied on every write: union the paired
 * owner's identifiers into whatever the allowlist is about to become. The one
 * exception is WHATSAPP_ALLOW_ALL_USERS, which authorizes everyone already.
 *
 * There is deliberately no "allow all" mode here. It is upstream's dev-only
 * escape hatch, this panel has never offered it, and adding a control that
 * opens a box to every sender on WhatsApp is not a fix for an allowlist bug.
 * A value set by hand is still honoured -- and still reported as a warning.
 */
export async function setHermesWhatsappConfig(
  update: WhatsappConfigUpdate,
): Promise<WhatsappConfigResult> {
  const entries: Record<string, string | null> = {};
  const [env, paired] = await Promise.all([readHermesEnv(), whatsappPaired()]);
  const identity = paired ? await readPairedWhatsappIdentity() : null;

  if (update.enabled === true) {
    if (!paired) throw new WhatsappNotPairedError();
    entries[WHATSAPP_ENV_ENABLED] = "true";
  } else if (update.enabled === false) {
    entries[WHATSAPP_ENV_ENABLED] = "false";
  }

  if (update.mode !== undefined) {
    entries[WHATSAPP_ENV_MODE] = update.mode;
  }

  const currentRaw = env[WHATSAPP_ENV_ALLOWED_USERS] ?? null;
  let allowAll = envIsTrue(env[WHATSAPP_ENV_ALLOW_ALL_USERS]);

  // A list from the panel replaces the numbers the panel manages -- removing a
  // number there has to actually remove it. The owner's own ids are re-added
  // below, so "replace" never means "lock yourself out".
  let base = currentRaw;
  if (update.allowedUsers !== undefined) {
    const numbers = update.allowedUsers
      .map((n) => normalizeWhatsappNumber(n))
      .filter((n): n is string => n !== null);
    base = formatAllowedUsers([...new Set(numbers)]);
    // Writing an explicit allowlist and leaving a stale ALLOW_ALL_USERS=true in
    // place would keep the channel wide open while the UI showed a short list.
    // Clear it whenever we take ownership of access control.
    if (allowAll) {
      entries[WHATSAPP_ENV_ALLOW_ALL_USERS] = "false";
      allowAll = false;
    }
  }

  const merged = mergeAllowlistEntries(
    base,
    allowAll ? [] : pairedIdentityAllowlistEntries(identity),
  );
  const nextFormatted = formatAllowedUsers(merged);
  // Compare against the CURRENT value put through the same normalisation, so a
  // save that changes nothing but the spacing is not reported as a change.
  if (nextFormatted !== formatAllowedUsers(mergeAllowlistEntries(currentRaw, []))) {
    entries[WHATSAPP_ENV_ALLOWED_USERS] = nextFormatted === "" ? null : nextFormatted;
  }

  const changedKeys = Object.keys(entries);
  if (changedKeys.length > 0) await setHermesEnvValues(entries);

  return {
    changedKeys,
    paired,
    authorized: allowAll || allowlistAuthorizes(nextFormatted, identity),
  };
}

/**
 * The success path of a QR pairing: record the link AND authorize the human who
 * just scanned it, in one .env write.
 *
 * Upstream's `cmd_whatsapp` step 7 writes WHATSAPP_ENABLED=true here and stops,
 * which is how a freshly paired box ends up enabled, linked, and refusing its
 * own owner -- the gateway's sender check is a separate gate that nothing had
 * ever filled in. `connectedUserId` is the id from the bridge's `connected`
 * event; it is the PHONE jid, so it is a supplement to creds.json (which also
 * carries the LID), never a replacement for it.
 *
 * Idempotent by construction: the allowlist is a union, so re-pairing, or
 * pairing onto a box whose .env was fixed by hand, adds nothing and removes
 * nothing.
 *
 * Returns the key names written, for the caller's audit line.
 */
export async function markWhatsappPaired(connectedUserId?: string | null): Promise<string[]> {
  const env = await readHermesEnv();
  const identity = await readPairedWhatsappIdentity();
  const entries: Record<string, string | null> = { [WHATSAPP_ENV_ENABLED]: "true" };

  // Allow-all already authorizes this sender; adding ids under it is noise.
  if (!envIsTrue(env[WHATSAPP_ENV_ALLOW_ALL_USERS])) {
    const currentRaw = env[WHATSAPP_ENV_ALLOWED_USERS] ?? null;
    const merged = mergeAllowlistEntries(
      currentRaw,
      pairedIdentityAllowlistEntries(identity, [connectedUserId]),
    );
    const nextFormatted = formatAllowedUsers(merged);
    if (nextFormatted !== formatAllowedUsers(mergeAllowlistEntries(currentRaw, []))) {
      entries[WHATSAPP_ENV_ALLOWED_USERS] = nextFormatted === "" ? null : nextFormatted;
    }
  }

  await setHermesEnvValues(entries);
  return Object.keys(entries);
}
