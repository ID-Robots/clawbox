/**
 * MCP servers the OWNER lets members of staff use, each call carrying THAT
 * member's own credential (TASK-2377, G2). SERVER ONLY.
 *
 * WHAT THE OWNER DECIDES (Settings → System → Users, `settings/staff-mcp`):
 *   - which of the box's OpenClaw MCP servers (`mcp.servers` in openclaw.json)
 *     members of staff may use, and the header their credential travels in
 *     (`Authorization` by default, `Bearer ` added to a bare token);
 *   - per member of staff and server, an optional credential — the bearer a
 *     document-search server filters by, a Microsoft 365 gateway's key. No
 *     credential, no tools from that server for that member.
 *
 * THE STORE is `data/staff-mcp.json`, 0600, written whole by rename. It holds
 * the credentials, so nothing of it is ever answered to anyone but the owner,
 * and to the owner only masked.
 *
 * HOW A CALL CARRIES THE MEMBER'S IDENTITY. OpenClaw 2026.10.9 sends one fixed
 * header set per `mcp.servers` entry and has no per-agent MCP config (its
 * per-requester identity is OAuth through a public gateway origin only). So
 * each member gets an entry of their OWN per granted server
 * (`cbstaff-<8 hex of the username>-<server>`), pointing at ClawBox's loopback
 * relay (`/setup-api/staff-mcp/<server>`) with a relay token that names that
 * member and nobody else. The relay (src/lib/staff-mcp-relay.ts) swaps it for
 * the member's credential — the owner's own headers never travel — and holds
 * the tools to the owner's tool filter minus anything that sends or writes.
 * The member's agent gets `<entry>__*` in its `tools.allow`
 * (src/lib/org-staff-agents.ts), every other agent of the owner's a deny of
 * `cbstaff-*`, and clawbox-staff-guard refuses a call to an entry that is not
 * granted to the calling agent (`staff-mcp-grants.json` beside the plugin).
 *
 * Hermes: a member of staff's profile gets no MCP server at all (its guard
 * refuses every tool outside the staff table), documented in multi-user.md.
 */

import crypto from "crypto";
import { promises as fsp } from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";
import { STAFF_MCP_ENTRY_PREFIX, staffAgentId } from "@/lib/org-staff-policy";
import type { ServerRead } from "@/lib/project-mcp-servers";

export const STAFF_MCP_STORE_PATH = path.join(DATA_DIR, "staff-mcp.json");

/** The relay's route; the gateway reaches it on loopback (middleware's LOOPBACK_PROXY_PREFIXES). */
export const STAFF_MCP_RELAY_PATH = "/setup-api/staff-mcp";

/** The guard's record of which entries each staff agent may call, written beside the installed plugin. */
export const STAFF_MCP_GRANTS_FILE = "staff-mcp-grants.json";

/** The header a credential travels in unless the owner names another. */
export const DEFAULT_CREDENTIAL_HEADER = "Authorization";

/** OpenClaw's longest provider-safe server prefix (agent-bundle-mcp-names TOOL_NAME_MAX_PREFIX). */
const OPENCLAW_SERVER_PREFIX_MAX = 30;

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Headers a credential may never be put in: the transport's own, the session's, the cookie. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "te", "upgrade",
  "keep-alive", "proxy-authorization", "proxy-connection", "cookie", "mcp-session-id", "mcp-protocol-version",
  "last-event-id", "origin", "referer", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
]);

/** A credential: what a header value can carry, no control character (no header injection), at most 4 KB. */
export const MAX_CREDENTIAL_CHARS = 4096;

export interface StaffMcpServerSetting {
  /** The header the member's credential is sent in. */
  header: string;
  /**
   * Does each member need a credential of their own (TASK-2377's model, the
   * default)? `false` is a server that takes none — a tool on this box such as
   * a document writer (TASK-2516): every member of staff gets it, and the
   * relay sends it no credential at all (never the owner's headers either).
   */
  needsCredential?: boolean;
  /**
   * May members use this server's tools that CREATE or EDIT something — write
   * a document, add a row (TASK-2516)? Off by default. Never a tool that
   * sends, publishes, pays, deletes or runs something (`staffToolAllowed`).
   */
  writeTools?: boolean;
  /**
   * Which members of staff get the server: `null` — every one of them; a list
   * — only these (TASK-2516). Narrows, never widens: a server that needs a
   * credential still reaches only members who have one.
   */
  members?: string[] | null;
  /**
   * The runtime the grant was made on (absent: OpenClaw, the only one before
   * TASK-2516). A grant reaches only that runtime's server of the name: after
   * the owner switches runtime, a same-named server of the other one
   * inherits nothing.
   */
  harness?: "openclaw" | "hermes";
}

/** At most this many names in one grant's member list. */
export const MAX_GRANT_MEMBERS = 256;

/** A grant's member list from what was stored or posted: `null` for "everyone"; a bad list is null only when absent, else an empty list (nobody). */
export function grantMembers(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isStaffUsername))].sort().slice(0, MAX_GRANT_MEMBERS);
}

/** Does `setting` reach `username` at all (before any credential)? */
export function grantReaches(setting: StaffMcpServerSetting, username: string): boolean {
  // A setting built by hand (not through parseStore) may lack the list: everyone.
  return !Array.isArray(setting.members) || setting.members.includes(username);
}

export interface StaffMcpStore {
  /** The servers members of staff may use, by OpenClaw `mcp.servers` name. */
  servers: Record<string, StaffMcpServerSetting>;
  /** username → server → credential. */
  credentials: Record<string, Record<string, string>>;
  /** username → the relay token their entries carry (64 hex). */
  relayTokens: Record<string, string>;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStaffUsername(name: unknown): name is string {
  return typeof name === "string" && USERNAME_RE.test(name);
}

export function isServerName(name: unknown): name is string {
  return typeof name === "string" && SERVER_NAME_RE.test(name) && !name.includes("__") && !name.toLowerCase().startsWith(STAFF_MCP_ENTRY_PREFIX);
}

/** A header the owner may name for the credential, or null. */
export function credentialHeaderName(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CREDENTIAL_HEADER;
  if (typeof raw !== "string" || !HEADER_NAME_RE.test(raw)) return null;
  return RESERVED_HEADERS.has(raw.toLowerCase()) ? null : raw;
}

/** A credential as stored: trimmed, 1..4096 characters, no control characters. Null otherwise. */
export function normalizeCredential(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_CREDENTIAL_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** The header VALUE a credential is sent as: `Authorization` gets `Bearer ` in front of a bare token. */
export function credentialHeaderValue(header: string, credential: string): string {
  if (header.toLowerCase() === "authorization" && !/\s/.test(credential)) return `Bearer ${credential}`;
  return credential;
}

/** What the owner is shown of a credential: never the value. */
export function maskCredential(value: string): string {
  return value.length >= 16 ? `••••${value.slice(-4)}` : "••••";
}

/**
 * A grant's setting from what was stored or posted: only a literal `false`
 * drops the per-member credential and only a literal `true` lets write tools
 * through, so a missing or odd value is always the stricter reading.
 */
export function serverSetting(header: string, raw: { needsCredential?: unknown; writeTools?: unknown; members?: unknown; harness?: unknown }): StaffMcpServerSetting {
  return {
    header,
    needsCredential: raw.needsCredential !== false,
    writeTools: raw.writeTools === true,
    members: grantMembers(raw.members),
    harness: raw.harness === "hermes" ? "hermes" : "openclaw",
  };
}

/**
 * A map with no prototype: `constructor` and `__proto__` are legal usernames
 * and server names, and on a plain object `map["constructor"]` would answer
 * Object's own constructor — a grant, a credential or a relay token nobody
 * set.
 */
function bare<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Parse the stored document, dropping anything that is not in its shape. */
export function parseStore(raw: unknown): StaffMcpStore {
  const store: StaffMcpStore = { servers: bare(), credentials: bare(), relayTokens: bare() };
  if (!isRecord(raw)) return store;
  if (isRecord(raw.servers)) {
    for (const [name, setting] of Object.entries(raw.servers)) {
      if (!isServerName(name)) continue;
      const header = credentialHeaderName(isRecord(setting) ? setting.header : undefined);
      if (header) store.servers[name] = serverSetting(header, isRecord(setting) ? setting : {});
    }
  }
  if (isRecord(raw.credentials)) {
    for (const [user, byServer] of Object.entries(raw.credentials)) {
      if (!isStaffUsername(user) || !isRecord(byServer)) continue;
      const kept = bare<string>();
      for (const [server, value] of Object.entries(byServer)) {
        const credential = normalizeCredential(value);
        if (isServerName(server) && credential) kept[server] = credential;
      }
      if (Object.keys(kept).length > 0) store.credentials[user] = kept;
    }
  }
  if (isRecord(raw.relayTokens)) {
    for (const [user, token] of Object.entries(raw.relayTokens)) {
      if (isStaffUsername(user) && typeof token === "string" && /^[0-9a-f]{64}$/.test(token)) store.relayTokens[user] = token;
    }
  }
  return store;
}

export class StaffMcpStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffMcpStoreError";
  }
}

/**
 * The store. A missing file is the empty store; a file that cannot be read or
 * parsed THROWS — "could not look" is never "nothing granted" for a writer,
 * which would then wipe every credential. Readers that only decide what to
 * offer (`readStaffMcpStoreOrEmpty`) fail closed instead.
 */
export async function readStaffMcpStore(file: string = STAFF_MCP_STORE_PATH): Promise<StaffMcpStore> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return parseStore(undefined);
    throw new StaffMcpStoreError("the staff MCP store could not be read");
  }
  try {
    return parseStore(JSON.parse(text));
  } catch {
    throw new StaffMcpStoreError("the staff MCP store is not valid JSON");
  }
}

/** The store, or the empty one when it cannot be read: nothing is offered from a store nobody can read. */
export async function readStaffMcpStoreOrEmpty(file: string = STAFF_MCP_STORE_PATH): Promise<StaffMcpStore> {
  try {
    return await readStaffMcpStore(file);
  } catch (err) {
    console.error("[staff-mcp]", err instanceof Error ? err.message : err);
    return parseStore(undefined);
  }
}

async function writeStore(store: StaffMcpStore, file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    // 0600 from the first byte: the file holds every member's credential.
    await fsp.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

const storeLock = createSerialLock();

/** Read, change and write the store under one lock. `change` returns the new store. */
export function updateStaffMcpStore(
  change: (store: StaffMcpStore) => StaffMcpStore | Promise<StaffMcpStore>,
  file: string = STAFF_MCP_STORE_PATH,
): Promise<StaffMcpStore> {
  return storeLock(async () => {
    const next = parseStore(await change(await readStaffMcpStore(file)));
    await writeStore(next, file);
    return next;
  });
}

/**
 * A user's credentials and relay token, taken out of the store. THROWS when
 * the store cannot be read or written — `createUser` refuses to create an
 * account of a name whose earlier owner's credentials it could not clear.
 */
export async function forgetStaffMcpUserStrict(username: string, file: string = STAFF_MCP_STORE_PATH): Promise<void> {
  if (!isStaffUsername(username)) return;
  // Always THROUGH the store's lock, whatever is in the store now: a
  // credential write that already passed its own check under the lock
  // commits before this runs, never after it. A store that cannot be read
  // (anything but a missing file) throws, so the caller fails closed.
  // Rebuilt without the name rather than `delete map[name]`: no property is
  // written or removed by a name a request supplied.
  const without = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([key]) => key !== username));
  // Their name leaves every grant's member list too: an account created
  // later under the name is a new person, granted nothing by the old one.
  await updateStaffMcpStore((store) => ({
    ...store,
    servers: Object.fromEntries(Object.entries(store.servers).map(([name, setting]) => [
      name,
      Array.isArray(setting.members) ? { ...setting, members: setting.members.filter((member) => member !== username) } : setting,
    ])),
    credentials: without(store.credentials),
    relayTokens: without(store.relayTokens),
  }), file);
}

/**
 * A removed user's credentials and relay token go with them. Never throws (a
 * removal is not undone for it); a store it could not clear is cleared again
 * before an account of that name is created (`forgetStaffMcpUserStrict`).
 */
export async function forgetStaffMcpUser(username: string, file: string = STAFF_MCP_STORE_PATH): Promise<void> {
  try {
    await forgetStaffMcpUserStrict(username, file);
  } catch (err) {
    console.error(`[staff-mcp] could not forget ${username}'s credentials:`, err instanceof Error ? err.message : err);
  }
}

/** A fresh relay token. */
export function newRelayToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** The user a relay token names, compared in constant time; null for any other value. */
export function userOfRelayToken(store: StaffMcpStore, token: string | null | undefined): string | null {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const given = Buffer.from(token, "utf-8");
  let found: string | null = null;
  for (const [user, stored] of Object.entries(store.relayTokens)) {
    const expected = Buffer.from(stored, "utf-8");
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) found = user;
  }
  return found;
}

// ── which servers a member may be handed ───────────────────────────────────

/**
 * Why an OpenClaw server cannot be offered to members of staff, or null when
 * it can. Only a Streamable HTTP server can carry a per-member header through
 * the relay; a stdio server runs as the owner with the owner's environment,
 * and an SSE one speaks a second endpoint the relay does not rewrite. A URL
 * with userinfo or a query string may hold the OWNER's credential, which must
 * never travel with a member's call.
 */
export type StaffUnusableReason = "unusable" | "transport" | "urlCredential" | "insecure";

/** A host that never leaves the box: plain HTTP to it carries a credential nowhere. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Literal addresses only: a NAME (`localhost` included) is whatever the
  // resolver says, and a credential must not ride on that.
  return h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function staffServerVerdict(server: ServerRead): StaffUnusableReason | null {
  if (!server.usable || !server.config) return "unusable";
  if (server.transport !== "http" || !("url" in server.config)) return "transport";
  const url = server.config.url;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url) || url.includes("?") || url.includes("#")) return "urlCredential";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "transport";
    // A member's credential travels in a header: over the network only
    // encrypted, in clear only to a server on this box.
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return "insecure";
  } catch {
    return "unusable";
  }
  return null;
}

/** 8 hex of a username: the part of an entry's name that says whose it is, at a fixed width. */
export function userTag(username: string): string {
  return crypto.createHash("sha256").update(`clawbox-staff-mcp:${username}`).digest("hex").slice(0, 8);
}

/**
 * The OpenClaw entry name of one member's grant of one server: within
 * OpenClaw's 30-character provider-safe prefix, so the tools are named exactly
 * `<entry>__<tool>` and the agent's `<entry>__*` allow matches them. A server
 * name too long (or clashing, case-insensitively, with another of theirs) is
 * replaced by 8 hex of itself.
 */
export function staffEntryName(username: string, server: string, taken: ReadonlySet<string> = new Set()): string {
  const head = `${STAFF_MCP_ENTRY_PREFIX}${userTag(username)}-`;
  const readable = `${head}${server.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
  if (readable.length <= OPENCLAW_SERVER_PREFIX_MAX && !taken.has(readable)) return readable;
  return `${head}${crypto.createHash("sha256").update(server).digest("hex").slice(0, 8)}`;
}

export interface StaffMcpEntry {
  /** The OpenClaw `mcp.servers` key. */
  name: string;
  /** The owner's server it relays. */
  server: string;
  /** The entry itself, as written into openclaw.json. */
  config: Record<string, unknown>;
}

/**
 * Every member's entries: for each member of staff (the registry's users,
 * only while org mode is on — the caller passes none otherwise), each server
 * the owner granted that is usable for staff and for which the member has a
 * credential. Pure. Members without a relay token yet are skipped (the caller
 * mints them first, `ensureRelayTokens`).
 */
export function planStaffMcpEntries(input: {
  staff: readonly string[];
  store: StaffMcpStore;
  servers: readonly ServerRead[];
  relayBase: string;
  /** The runtime the entries are for: only its grants count (default OpenClaw). */
  harness?: "openclaw" | "hermes";
}): Map<string, StaffMcpEntry[]> {
  const byName = new Map(input.servers.map((server) => [server.name, server]));
  const out = new Map<string, StaffMcpEntry[]>();
  for (const username of input.staff) {
    if (!isStaffUsername(username)) continue;
    const token = input.store.relayTokens[username];
    const credentials = input.store.credentials[username] ?? {};
    const entries: StaffMcpEntry[] = [];
    const taken = new Set<string>();
    for (const server of Object.keys(input.store.servers).sort()) {
      const read = byName.get(server);
      if (!read || staffServerVerdict(read) !== null) continue;
      // A server that takes no credential is every member's; any other only
      // theirs who have one. Either way the entry carries THEIR relay token.
      const setting = input.store.servers[server];
      if ((setting.harness ?? "openclaw") !== (input.harness ?? "openclaw")) continue;
      if (!token || !grantReaches(setting, username) || (setting.needsCredential !== false && !(Object.hasOwn(credentials, server) && credentials[server]))) continue;
      const name = staffEntryName(username, server, taken);
      taken.add(name);
      const config: Record<string, unknown> = {
        url: `${input.relayBase.replace(/\/+$/, "")}${STAFF_MCP_RELAY_PATH}/${encodeURIComponent(server)}`,
        transport: "streamable-http",
        headers: { Authorization: `Bearer ${token}` },
      };
      const toolFilter: Record<string, string[]> = {};
      if (read.include) toolFilter.include = [...read.include];
      if (read.exclude && read.exclude.length > 0) toolFilter.exclude = [...read.exclude];
      if (Object.keys(toolFilter).length > 0) config.toolFilter = toolFilter;
      entries.push({ name, server, config });
    }
    if (entries.length > 0) out.set(username, entries);
  }
  return out;
}

/** The guard's grants file: agent id → the entries it may call. */
export function grantsDocument(entries: ReadonlyMap<string, readonly StaffMcpEntry[]>): { agents: Record<string, string[]> } {
  const agents: Record<string, string[]> = {};
  for (const [username, list] of entries) {
    const id = staffAgentId(username);
    if (id) agents[id] = list.map((entry) => entry.name).sort();
  }
  return { agents };
}

/**
 * Mint a relay token for every member of staff that will get an entry and has
 * none yet: one with a credential, or everyone while a server that takes no
 * credential is granted.
 */
export async function ensureRelayTokens(staff: readonly string[], file: string = STAFF_MCP_STORE_PATH): Promise<StaffMcpStore> {
  const current = await readStaffMcpStore(file);
  const openTo = (user: string) => Object.values(current.servers).some((setting) => setting.needsCredential === false && grantReaches(setting, user));
  const missing = staff.filter((user) => isStaffUsername(user) && (openTo(user) || current.credentials[user]) && !current.relayTokens[user]);
  if (missing.length === 0) return current;
  return updateStaffMcpStore((store) => {
    const relayTokens = { ...store.relayTokens };
    for (const user of missing) if (!Object.hasOwn(relayTokens, user)) relayTokens[user] = newRelayToken();
    return { ...store, relayTokens };
  }, file);
}

// ── which tools a member's call may reach ──────────────────────────────────

/**
 * The verbs of a tool that sends, writes or changes something. A member of
 * staff's grant is for reading and searching with their own identity; a tool
 * whose name carries one of these words is never offered, whatever the
 * owner's tool filter says — the owner can narrow a grant, never widen it to
 * a sender or a writer.
 */
const WRITE_VERBS = new Set([
  "send", "write", "create", "update", "delete", "remove", "post", "put", "patch", "upload", "move", "rename",
  "reply", "forward", "share", "edit", "insert", "modify", "set", "add", "append", "publish", "invite",
  "schedule", "cancel", "approve", "submit", "archive", "drop", "execute", "exec", "run", "mark", "assign",
  "transfer", "pay", "book", "accept", "decline", "copy", "save", "register", "revoke", "grant",
  "reset", "restore", "purge", "trash", "flag", "replace", "merge", "commit", "push", "deploy",
  "install", "uninstall", "enable", "disable", "start", "stop", "kill", "rsvp", "compose", "notify", "react",
  "wipe", "destroy", "erase", "clear", "refund", "charge", "buy", "order", "overwrite", "unlink", "close",
  "terminate", "shutdown", "reboot", "format", "truncate", "approve", "reject", "sign", "unsubscribe", "subscribe",
]);

/**
 * A name run together without separators (`sendmail`, `deletefile`): a word
 * that BEGINS with one of the longer verbs is that verb. Four letters and up
 * only, so `settings`, `address` and `running` are not read as `set`, `add`
 * and `run`.
 */
const LONG_WRITE_VERBS = [...WRITE_VERBS].filter((verb) => verb.length >= 4);

/**
 * The verbs of a tool that only CREATES or EDITS something — a document
 * writer's `create_document`, `append_rows`, `save_file` (TASK-2516). Offered
 * to members of staff only where the owner ticked "tools that create or edit"
 * for the server (`writeTools`). Everything else in WRITE_VERBS — sending,
 * publishing, paying, deleting, moving, running, changing who may do what —
 * stays refused whatever the owner ticks.
 */
export const CREATE_EDIT_VERBS: ReadonlySet<string> = new Set([
  "create", "write", "update", "edit", "insert", "modify", "set", "add", "append", "save", "copy", "replace",
  "put", "patch", "compose",
]);

const REFUSED_WITH_WRITES = new Set([...WRITE_VERBS].filter((verb) => !CREATE_EDIT_VERBS.has(verb)));
const LONG_REFUSED_WITH_WRITES = [...REFUSED_WITH_WRITES].filter((verb) => verb.length >= 4);

function isWriteWord(word: string): boolean {
  // A run-together name reads either way round: `sendmail` and `mailsend`.
  return WRITE_VERBS.has(word) || LONG_WRITE_VERBS.some((verb) => word.startsWith(verb) || word.endsWith(verb));
}

/**
 * Who-may-do-what nouns: with the owner's create/edit tick, `set`, `add` and
 * `update` would otherwise let `set_permissions`, `add_member` or
 * `update_acl` through. A tool naming one of these stays refused.
 */
const PRIVILEGE_NOUNS = ["permission", "acl", "role", "member", "access", "owner", "admin", "sharing", "privilege", "policy", "grant", "group", "user"];

function isPrivilegeWord(word: string): boolean {
  return PRIVILEGE_NOUNS.some((noun) => word.startsWith(noun));
}

/** A word that sends, deletes, runs or otherwise does more than create or edit. */
function isRefusedEvenWithWrites(word: string): boolean {
  return REFUSED_WITH_WRITES.has(word) || isPrivilegeWord(word) || LONG_REFUSED_WITH_WRITES.some((verb) => word.startsWith(verb) || word.endsWith(verb));
}

/** The words of a tool name: split on `_`, `-`, `.`, `/`, spaces and camelCase. */
export function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-./:]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

export interface ToolFilter {
  include: readonly string[] | null;
  exclude: readonly string[];
  /** The owner let this server's create/edit tools through (`StaffMcpServerSetting.writeTools`). */
  writeTools?: boolean;
}

/** The MCP `annotations` a server declared for a tool, when it did. */
export interface ToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

/**
 * May a member of staff's call reach this tool? The owner's filter first
 * (an include list is the whole selection, an exclude takes away), then no
 * word that sends or writes, then the server's own annotations: a tool it
 * calls destructive, or explicitly not read-only, is not offered either.
 *
 * Where the owner let the server's create/edit tools through
 * (`filter.writeTools`), a word of CREATE_EDIT_VERBS and `readOnlyHint: false`
 * no longer refuse — every other write verb and `destructiveHint: true` still
 * do.
 */
export function staffToolAllowed(name: unknown, filter: ToolFilter, annotations?: ToolAnnotations | null): boolean {
  if (typeof name !== "string" || !name || name.length > 128) return false;
  if (filter.include && !filter.include.includes(name)) return false;
  if (filter.exclude.includes(name)) return false;
  const writes = filter.writeTools === true;
  if (toolNameWords(name).some(writes ? isRefusedEvenWithWrites : isWriteWord)) return false;
  if (annotations && annotations.destructiveHint === true) return false;
  if (annotations && !writes && annotations.readOnlyHint === false) return false;
  return true;
}

// ── Hermes: each member's own profile carries their entries (TASK-2516) ────

/**
 * A member's planned entries as Hermes' `mcp_servers` in THEIR profile's
 * config.yaml (src/lib/hermes-staff-profile.ts): the same relay URL and relay
 * token, the owner's tool filter as Hermes spells it (`tools.include` /
 * `tools.exclude`). Hermes keys a profile's MCP connections by that profile
 * when one process serves several, so another profile never holds them; the
 * staff guard refuses a call to an entry that is not granted to the calling
 * profile all the same (`staff-mcp-grants.json` beside the installed plugin).
 */
export function hermesStaffMcpServers(entries: readonly StaffMcpEntry[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const config = entry.config;
    const server: Record<string, unknown> = { url: config.url, headers: { ...(config.headers as Record<string, string>) } };
    const filter = isRecord(config.toolFilter) ? config.toolFilter : null;
    if (filter) {
      const tools: Record<string, unknown> = {};
      if (Array.isArray(filter.include)) tools.include = [...filter.include];
      if (Array.isArray(filter.exclude)) tools.exclude = [...filter.exclude];
      server.tools = tools;
    }
    out[entry.name] = server;
  }
  return out;
}
