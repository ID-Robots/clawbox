import fs from "fs/promises";
import yaml from "js-yaml";

import { harnessesHere } from "@/lib/clawbox-mcp-registration";
import { readClawboxMcpEnabled } from "@/lib/clawbox-mcp-switch";
import { getKnown, set } from "@/lib/config-store";
import { hermesConfigPath } from "@/lib/hermes-config-yaml";
import { isPlainObject, readConfigStrict } from "@/lib/openclaw-config";
import { MIN_SECRET_VALUE_CHARS, SECRET_SCOPE_RE } from "@/lib/project-secrets-shape";

/**
 * Which MCP servers a coding-agent run may use, project by project.
 *
 * A run starts with ONE server of its own — clawbox, in the browser profile —
 * and `--strict-mcp-config` keeps every other server out (src/lib/coding-agent.ts
 * buildRunArgs). This module is the owner's way to hand a project more:
 *
 *   - a server the box's HARNESS is configured with — OpenClaw's `mcp.servers`
 *     in openclaw.json, Hermes' `mcp_servers` in config.yaml (which
 *     `hermes mcp add|remove` own), the union of both on a dual box. Only READ
 *     here: nothing is written to either file, nothing is reloaded, no gateway
 *     is restarted. A server that exists only in Claude Code's own
 *     ~/.claude.json stays out, exactly as the strict flag means it to;
 *   - "ClawBox read-only tools" (`CLAWBOX_READ_ONLY_ENTRY`): the run's own
 *     clawbox server in the `run-read` profile, offered only while the owner's
 *     ClawBox MCP switch is on (src/lib/clawbox-mcp-switch.ts).
 *
 * EMPTY BY DEFAULT, and per project: no box type is detected and there is no
 * "allow all", so every existing project — and every customer box — keeps
 * exactly the tools it had until its owner ticks something.
 *
 * THE STORE is one key in the box's config.json, `{ [project]: string[] }`,
 * keyed by the same project scope the secret store uses (the run's
 * `projectScopeFor`). Names only — a server's credentials stay in the
 * harness's own config and are read at each spawn, copied into that run's own
 * --mcp-config file (deleted when the run settles) and scrubbed from its
 * output; a server with a credential too short to scrub is not offered. In config.json rather than
 * a file of its own because a run's file deny list names every entry of data/
 * it finds (fileDenyRules): a new file there would have changed the argv of
 * every run on the box, ticked or not, and config.json is denied already.
 */

/** The allowlist word for "ClawBox read-only tools". The harness's own `clawbox` entry is never offered as an extra, so the name cannot mean anything else. */
export const CLAWBOX_READ_ONLY_ENTRY = "clawbox";

/** The config.json key. */
export const PROJECT_MCP_SERVERS_KEY = "coding_agent_mcp_servers";

/** At most this many entries per project — a checklist, not a registry. */
export const MAX_PROJECT_MCP_SERVERS = 32;

/**
 * A server name a run's tool ids can carry: Claude Code names a server's tools
 * `mcp__<server>__<tool>`, so a name with a double underscore (or anything
 * outside this set) would be split in the wrong place. A configured server with
 * another name is listed as unusable rather than renamed.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_SERVER_NAME_CHARS = 64;
/** A tool name in a harness's include/exclude filter that can be approved by name. A glob cannot. */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isMcpServerName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_SERVER_NAME_CHARS && SERVER_NAME_RE.test(name) && !name.includes("__");
}

export type McpHarness = "openclaw" | "hermes";

/** A server entry in the shape Claude Code's `--mcp-config` takes. */
export type RunMcpServerConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** What the owner's checklist shows of a configured server: never a value. */
export interface ConfiguredMcpServer {
  name: string;
  harness: McpHarness;
  transport: "stdio" | "http" | "sse" | null;
  /** False when a run could not start it the way the harness does; `reason` says why. */
  usable: boolean;
  /** Why a run cannot use it, in the box's own English — logs and API callers. */
  reason?: string;
  /** The same, as a stable code the owner's page words in their language. */
  reasonCode?: UnusableReason;
}

/**
 * Why a configured server cannot be handed to a run, as codes the checklist
 * translates: an English sentence alone would land untranslated in every other
 * locale's line around it.
 */
export type UnusableReason = "notAServer" | "badName" | "oauth" | "tls" | "cwd" | "toolFilter" | "placeholder" | "shortSecret";

/** The run half: the entry itself, the tool filter, and every value to redact. */
interface UsableServer extends ConfiguredMcpServer {
  config: RunMcpServerConfig;
  /** The harness's include filter, by name; null = the whole server. */
  include: string[] | null;
  exclude: string[];
  secrets: Array<{ name: string; value: string }>;
}

type ServerRead = ConfiguredMcpServer & Partial<Pick<UsableServer, "config" | "include" | "exclude" | "secrets">>;

function unusable(name: string, harness: McpHarness, transport: ConfiguredMcpServer["transport"], reasonCode: UnusableReason, reason: string): ServerRead {
  return { name, harness, transport, usable: false, reason, reasonCode };
}

/** A string map whose values are what the harness would hand the server. Null = a value a run cannot reproduce. */
function stringMap(raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Both harnesses resolve `${…}` from their own environment or secret
    // stores at connect time; a run has neither, so the entry is not carried
    // with a placeholder that would reach the server literally.
    if (typeof value === "string") {
      if (value.includes("${")) return null;
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * An env or header NAME that holds a credential, whatever its value looks
 * like: the credential word ENDS the name (`GITHUB_TOKEN`, `X-Api-Key`), so a
 * setting about auth (`AUTH_MODE=none`, `TOKEN_TTL=60`) is not one.
 */
const CREDENTIAL_NAME_RE = /(?:^|[_-])(?:token|secret|password|passwd|pwd|pat|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|cookie|authorization)$/i;
/** A header VALUE in an auth scheme's syntax: `Bearer <token>`, `Basic <b64>`, `Token <t>`. */
const AUTH_SCHEME_RE = /^\s*(bearer|basic|token|apikey)\s+(\S+)\s*$/i;

/**
 * True when a credential is too short for the run's redactor to scrub
 * (MIN_SECRET_VALUE_CHARS, the redaction floor): such a value would reach a
 * run's output verbatim, so the server is not offered rather than leaked.
 * Only credentials are measured — a short ordinary setting (`PORT=80`) is fine.
 */
function tooShortCredential(value: string): boolean {
  return value.trim().length > 0 && value.trim().length < MIN_SECRET_VALUE_CHARS;
}

function toolList(raw: unknown): string[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  if (!raw.every((tool) => typeof tool === "string" && TOOL_NAME_RE.test(tool))) return null;
  return [...new Set(raw as string[])];
}

/**
 * One harness entry, translated. The two harnesses spell the same things
 * apart (OpenClaw `toolFilter`/`transport`, Hermes `tools`/`client_cert`), and
 * anything a run cannot reproduce faithfully — OAuth, mTLS, a working folder,
 * a placeholder, a glob in a tool filter — makes the entry unusable rather
 * than carried half-way: a server started differently from the harness's is a
 * server the owner did not configure.
 */
function translate(name: string, harness: McpHarness, raw: unknown): ServerRead | null {
  if (!isPlainObject(raw)) return unusable(name, harness, null, "notAServer", "its entry is not a server definition");
  // Switched off in the harness: not a server this box runs, so not offered.
  if (raw.enabled === false) return null;
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command : null;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url : null;
  const transportField = typeof raw.transport === "string" ? raw.transport.toLowerCase() : typeof raw.type === "string" ? raw.type.toLowerCase() : null;
  const transport: ConfiguredMcpServer["transport"] = command
    ? "stdio"
    : url
      ? (harness === "openclaw"
        // OpenClaw: an HTTP server without a transport is SSE (docs/cli/mcp/transports).
        ? (transportField === "streamable-http" || transportField === "http" ? "http" : "sse")
        // Hermes: an HTTP endpoint, unless the entry says SSE.
        : (transportField === "sse" ? "sse" : "http"))
      : null;
  if (!isMcpServerName(name)) return unusable(name, harness, transport, "badName", "its name cannot be used in a run's tool names");
  if (!transport) return unusable(name, harness, null, "notAServer", "it names neither a command nor a URL");
  if (raw.auth !== undefined || raw.oauth !== undefined) return unusable(name, harness, transport, "oauth", "it signs in through the harness (OAuth)");
  if (raw.clientCert !== undefined || raw.clientKey !== undefined || raw.client_cert !== undefined || raw.client_key !== undefined || raw.identity_header !== undefined || raw.sslVerify === false) {
    return unusable(name, harness, transport, "tls", "it needs a client certificate or TLS setting a run cannot carry");
  }
  if (raw.cwd !== undefined) return unusable(name, harness, transport, "cwd", "it names a working folder a run cannot carry");
  const filter = harness === "openclaw" ? raw.toolFilter : raw.tools;
  const include = isPlainObject(filter) ? toolList(filter.include) : undefined;
  const exclude = isPlainObject(filter) ? toolList(filter.exclude) : undefined;
  if (include === null || exclude === null) return unusable(name, harness, transport, "toolFilter", "its tool filter uses a pattern a run cannot reproduce");
  const secrets: Array<{ name: string; value: string }> = [];
  let config: RunMcpServerConfig;
  if (transport === "stdio") {
    const rawArgs = raw.args === undefined ? [] : raw.args;
    // A YAML list item such as `- 8080` or `- true` parses as a number or a
    // boolean, and the harness starts the server with it as a word; so does a
    // run. Only an object or a null is no argument (as stringMap reads env).
    if (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean")) {
      return unusable(name, harness, transport, "notAServer", "its arguments are not a list of words");
    }
    const args = rawArgs.map(String);
    if (args.some((arg) => arg.includes("${")) || command!.includes("${")) return unusable(name, harness, transport, "placeholder", "it uses a ${…} placeholder only the harness can fill in");
    const env = stringMap(raw.env);
    if (env === null) return unusable(name, harness, transport, "placeholder", "its environment uses a value only the harness can fill in");
    if (Object.entries(env ?? {}).some(([key, value]) => CREDENTIAL_NAME_RE.test(key) && tooShortCredential(value))) {
      return unusable(name, harness, transport, "shortSecret", "one of its credentials is too short to be hidden from a run's output");
    }
    config = { command: command!, args: args as string[], ...(env && Object.keys(env).length > 0 ? { env } : {}) };
    for (const [key, value] of Object.entries(env ?? {})) secrets.push({ name: `${name}.${key}`, value });
  } else {
    if (url!.includes("${")) return unusable(name, harness, transport, "placeholder", "it uses a ${…} placeholder only the harness can fill in");
    const headers = stringMap(raw.headers);
    if (headers === null) return unusable(name, harness, transport, "placeholder", "its headers use a value only the harness can fill in");
    const shortHeader = Object.entries(headers ?? {}).some(([key, value]) => {
      const scheme = AUTH_SCHEME_RE.exec(value);
      if (scheme) return tooShortCredential(scheme[2]);
      return CREDENTIAL_NAME_RE.test(key) && tooShortCredential(value);
    });
    if (shortHeader) return unusable(name, harness, transport, "shortSecret", "one of its credentials is too short to be hidden from a run's output");
    config = { type: transport, url: url!, ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) };
    for (const [key, value] of Object.entries(headers ?? {})) {
      secrets.push({ name: `${name}.${key}`, value });
      // `Bearer <token>`: a run that prints the token alone is caught too.
      const credential = value.trim().split(/\s+/).at(-1);
      if (credential && credential !== value) secrets.push({ name: `${name}.${key}`, value: credential });
    }
    // A credential in the URL itself — userinfo, or a token in the query.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url!) || url!.includes("?")) secrets.push({ name: `${name}.url`, value: url! });
  }
  return { name, harness, transport, usable: true, config, include: include ?? null, exclude: exclude ?? [], secrets };
}

function entriesOf(servers: unknown, harness: McpHarness): ServerRead[] {
  if (!isPlainObject(servers)) return [];
  const out: ServerRead[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    // The box's own server is the run's already, in the run's own profile.
    if (name === CLAWBOX_READ_ONLY_ENTRY) continue;
    const read = translate(name, harness, raw);
    if (read) out.push(read);
  }
  return out;
}

async function readOpenclawServers(): Promise<ServerRead[]> {
  // STRICT, like readClawboxMcpRegistration: a file this process could not read
  // is "could not look", never "no servers".
  const config = await readConfigStrict();
  const mcp = config.mcp;
  return entriesOf(isPlainObject(mcp) ? mcp.servers : undefined, "openclaw");
}

async function readHermesServers(): Promise<ServerRead[]> {
  let text: string;
  try {
    text = await fs.readFile(hermesConfigPath(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No config.yaml: a box with nothing configured, as readConfigText reads it.
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  // Parsed in full: the line reader (hermes-config-yaml.ts) answers "present"
  // for a nested block and never what is inside it. JSON_SCHEMA — no tags, no
  // dates — because nothing in an MCP entry needs more and this file holds the
  // box's credentials.
  const doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  return entriesOf(isPlainObject(doc) ? doc.mcp_servers : undefined, "hermes");
}

export interface HarnessMcpServers {
  servers: ServerRead[];
  /** The harnesses whose config could not be read — so "none configured" is never a guess. */
  unreadable: McpHarness[];
}

/**
 * Every MCP server this box's harnesses are configured with, but clawbox.
 * Never throws. A dual box is the union; a name both define is OpenClaw's,
 * the harness the box's own server is registered with first.
 */
export async function readHarnessMcpServers(): Promise<HarnessMcpServers> {
  const here = harnessesHere();
  const unreadable: McpHarness[] = [];
  const read = async (harness: McpHarness, reader: () => Promise<ServerRead[]>): Promise<ServerRead[]> => {
    try {
      return await reader();
    } catch (err) {
      // The message only: both files hold credentials, and a parser quotes
      // the line it stopped at.
      console.error(`[project-mcp-servers] the ${harness} config could not be read:`, err instanceof Error ? err.name : "unknown error");
      unreadable.push(harness);
      return [];
    }
  };
  const [openclaw, hermes] = await Promise.all([
    here.openclaw ? read("openclaw", readOpenclawServers) : Promise.resolve([]),
    here.hermes ? read("hermes", readHermesServers) : Promise.resolve([]),
  ]);
  const seen = new Set(openclaw.map((server) => server.name));
  const servers = [...openclaw, ...hermes.filter((server) => !seen.has(server.name))];
  return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)), unreadable: unreadable.sort() };
}

/** The listing the owner's checklist draws: names, transports, usability — no value. */
export function listingOf(server: ServerRead): ConfiguredMcpServer {
  return { name: server.name, harness: server.harness, transport: server.transport, usable: server.usable, ...(server.reason ? { reason: server.reason } : {}), ...(server.reasonCode ? { reasonCode: server.reasonCode } : {}) };
}

// ── the allowlist ───────────────────────────────────────────────────────────

/** A project scope: a project id or a project folder's name, the secret store's rule. */
export function isProjectScope(project: unknown): project is string {
  return typeof project === "string" && SECRET_SCOPE_RE.test(project);
}

function isAllowlistEntry(name: unknown): name is string {
  return name === CLAWBOX_READ_ONLY_ENTRY || isMcpServerName(name);
}

/**
 * The stored map, as far as it is one: a value that is not, or a row that is not, is no entry.
 * With no prototype, and read through {@link listOf}: a project folder may be called
 * `__proto__` or `constructor`, and on a plain object the one would set the prototype
 * instead of a key and the other read back a function.
 */
function storedMap(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  if (!isPlainObject(value)) return out;
  for (const [project, names] of Object.entries(value)) {
    if (!isProjectScope(project) || !Array.isArray(names)) continue;
    const kept = [...new Set(names.filter(isAllowlistEntry))].sort();
    if (kept.length > 0) out[project] = kept;
  }
  return out;
}

/** One project's list out of a stored map: its own key only, never an inherited one. */
function listOf(map: Record<string, string[]>, project: string): string[] {
  return Object.hasOwn(map, project) ? map[project] : [];
}

/** A project's allowlist. Empty for an unknown project, a store that cannot be read, or a value that is not a list — a run then gets today's tools. */
export async function readProjectMcpAllowlist(project: string | null): Promise<string[]> {
  if (!isProjectScope(project)) return [];
  const { value, known } = await getKnown(PROJECT_MCP_SERVERS_KEY);
  if (!known) return [];
  return listOf(storedMap(value), project);
}

export class ProjectMcpServersError extends Error {
  constructor(public readonly code: "invalid_project" | "invalid_servers" | "too_many" | "store_unreadable", message: string) {
    super(message);
  }
}

/** Every change after the previous one: a read-modify-write of one key, from two tabs. */
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

async function mutate(change: (map: Record<string, string[]>) => void): Promise<Record<string, string[]>> {
  return serialised(async () => {
    const { value, known } = await getKnown(PROJECT_MCP_SERVERS_KEY);
    // Never written over a store nobody can read: `set` would throw anyway,
    // and the owner hears why.
    if (!known) throw new ProjectMcpServersError("store_unreadable", "This ClawBox could not read its settings file, so nothing was changed.");
    const map = storedMap(value);
    const before = JSON.stringify(map);
    change(map);
    // Nothing to write is no write: a project deleted with nothing ticked
    // leaves the box's settings file as it was.
    if (JSON.stringify(map) !== before || (value !== undefined && Object.keys(map).length === 0)) {
      await set(PROJECT_MCP_SERVERS_KEY, Object.keys(map).length > 0 ? map : undefined);
    }
    return map;
  });
}

/** Replace a project's allowlist; answers what is stored now. An empty list removes the project's entry. */
export async function setProjectMcpAllowlist(project: unknown, servers: unknown): Promise<string[]> {
  if (!isProjectScope(project)) throw new ProjectMcpServersError("invalid_project", "A project is named by its id or its folder's name.");
  if (!Array.isArray(servers) || !servers.every(isAllowlistEntry)) {
    throw new ProjectMcpServersError("invalid_servers", "servers must be a list of MCP server names.");
  }
  const names = [...new Set(servers as string[])].sort();
  if (names.length > MAX_PROJECT_MCP_SERVERS) throw new ProjectMcpServersError("too_many", `A project may use at most ${MAX_PROJECT_MCP_SERVERS} MCP servers.`);
  const map = await mutate((current) => {
    if (names.length > 0) current[project] = names;
    else delete current[project];
  });
  return listOf(map, project);
}

/** A deleted project's entry goes with it, the way its secrets do. Never throws. */
export async function deleteProjectMcpAllowlist(project: string): Promise<void> {
  if (!isProjectScope(project)) return;
  await mutate((current) => {
    delete current[project];
  }).catch((err) => {
    console.error("[project-mcp-servers] a deleted project's MCP servers could not be removed:", err instanceof Error ? err.message : err);
  });
}

// ── what a run gets ─────────────────────────────────────────────────────────

/**
 * What a run in this project starts with beyond today's tools. Null for an
 * empty allowlist; `names` empty when nothing ticked is available — both mean
 * the run starts with exactly today's argv.
 */
export interface RunMcpPlan {
  /** The harness servers, by name, as they go into the run's --mcp-config file. */
  servers: Record<string, RunMcpServerConfig>;
  /** `mcp__<server>` for a whole server, `mcp__<server>__<tool>` under an include filter. */
  allowedTools: string[];
  /** `mcp__<server>__<tool>` for each tool the harness's exclude filter names. */
  disallowedTools: string[];
  /** The run's own clawbox server in the `run-read` profile. */
  readOnlyTools: boolean;
  /** Every env/header value the file carries, for the run's redaction table. Never on the record. */
  secrets: Array<{ name: string; value: string }>;
  /** What the run was given, for its feed: server names and the read-only label's id. */
  names: string[];
  /** Ticked, and not available to this run: not configured, unusable, or the switch is off. */
  missing: string[];
}

export async function resolveRunMcpPlan(project: string | null): Promise<RunMcpPlan | null> {
  const allowlist = await readProjectMcpAllowlist(project);
  if (allowlist.length === 0) return null;
  const wantsReadOnly = allowlist.includes(CLAWBOX_READ_ONLY_ENTRY);
  const wanted = allowlist.filter((name) => name !== CLAWBOX_READ_ONLY_ENTRY);
  const [readOnlyTools, harness] = await Promise.all([
    wantsReadOnly ? readClawboxMcpEnabled() : Promise.resolve(false),
    wanted.length > 0 ? readHarnessMcpServers() : Promise.resolve({ servers: [], unreadable: [] } as HarnessMcpServers),
  ]);
  const byName = new Map(harness.servers.map((server) => [server.name, server]));
  const plan: RunMcpPlan = { servers: {}, allowedTools: [], disallowedTools: [], readOnlyTools, secrets: [], names: [], missing: [] };
  if (wantsReadOnly) (readOnlyTools ? plan.names : plan.missing).push(CLAWBOX_READ_ONLY_ENTRY);
  for (const name of wanted) {
    const server = byName.get(name);
    if (!server?.usable || !server.config) {
      plan.missing.push(name);
      continue;
    }
    plan.servers[name] = server.config;
    plan.names.push(name);
    plan.secrets.push(...(server.secrets ?? []));
    // The harness's own narrowing holds in the run: an include filter is the
    // tools by name, and nothing else of the server is approved.
    if (server.include) plan.allowedTools.push(...server.include.map((tool) => `mcp__${name}__${tool}`));
    else plan.allowedTools.push(`mcp__${name}`);
    plan.disallowedTools.push(...(server.exclude ?? []).map((tool) => `mcp__${name}__${tool}`));
  }
  return plan;
}
