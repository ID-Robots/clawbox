// The rules of clawbox-staff-guard, pure enough to test: no I/O beyond reading
// the policy table once and resolving symlinks on the paths a call names.
//
// A member of staff's agent (`clawbox-staff-<name>`, src/lib/org-staff-agents.ts)
// already has the staff allow-list as its own tool policy, which the core
// applies before a model is offered a tool. This is the second lock and the
// one the core cannot express:
//
//   * ANY tool the table does not allow is refused here too — a widened entry,
//     a plugin tool the policy was not taught, a model calling a tool it was
//     never offered;
//   * the file tools are held to the member's OWN FOLDER (their workspace,
//     `<OpenClaw home>/staff/<name>`): `write`, `edit` and `apply_patch` may
//     touch nothing else, so no other member's memory, no owner's MEMORY.md,
//     no openclaw.json; `read`, `pdf` and `view_image` may also open the
//     chat's staged attachments THAT ARE THEIRS — the record ClawBox keeps of
//     whose upload each staged file is (src/lib/chat-media-owners.ts), so one
//     member who learns another's attachment path still cannot open it — and
//     nothing on the web.
//
//   * an MCP tool reaches a member's agent only through a server the owner
//     GRANTED to that member (TASK-2377, src/lib/staff-mcp.ts): ClawBox writes
//     one relay entry per member and server (`cbstaff-…`) and records which
//     entries each staff agent may call in `staff-mcp-grants.json` beside this
//     plugin. A call to any other server — `clawbox__*` above all — is
//     refused; a grants file that is missing or unreadable grants nothing.
//
// Every other agent — the owner's above all — is not this plugin's business,
// with one exception: a call to a member's relay entry (which carries THAT
// member's token) is refused to anyone but that member's agent.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

let table;
/** config/org-staff-policy.json: beside the plugin once installed, at config/ in a checkout. */
export function staffPolicyTable() {
  if (table) return table;
  for (const url of [
    new URL("./org-staff-policy.json", import.meta.url),
    new URL("../../../config/org-staff-policy.json", import.meta.url),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(url, "utf-8"));
      if (typeof parsed?.agentPrefix === "string" && Array.isArray(parsed?.openclaw?.allow)) {
        table = parsed;
        return table;
      }
    } catch {
      // the other layout
    }
  }
  throw new Error("clawbox-staff-guard: config/org-staff-policy.json is missing or unreadable");
}

/**
 * Where ClawBox keeps whose upload each staged attachment is
 * (`<CLAWBOX_ROOT>/data/chat-media-owners.json`), as gateway-pre-start.sh
 * recorded it beside the installed plugin; the gateway does not know where
 * ClawBox keeps its data. Undefined when it was not recorded: then no staged
 * file is a member's (fail closed).
 */
function mediaOwnersFile() {
  try {
    const paths = JSON.parse(readFileSync(new URL("./clawbox-paths.json", import.meta.url), "utf-8"));
    return typeof paths?.mediaOwners === "string" && paths.mediaOwners ? paths.mediaOwners : undefined;
  } catch {
    return undefined;
  }
}

let ownersCache = { file: "", ino: -1, mtimeMs: -1, size: -1, owners: {} };
/**
 * `{ realpath: username }`, re-read when the file changes; `{}` when it cannot
 * be read. ONE open: the stat and the read are both of that descriptor, so
 * what is judged is the file that was looked at, never a path read twice.
 * ClawBox replaces the record by rename (chat-media-owners.ts `writeOwners`),
 * so each write is a new inode, whatever the clock's granularity.
 */
function readMediaOwners(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const { ino, mtimeMs, size } = fstatSync(fd);
    if (ownersCache.file === file && ownersCache.ino === ino && ownersCache.mtimeMs === mtimeMs && ownersCache.size === size) return ownersCache.owners;
    const parsed = JSON.parse(readFileSync(fd, "utf-8"));
    const owners = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    ownersCache = { file, ino, mtimeMs, size, owners };
    return owners;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Is `real`, a resolved path below the staging root `rootReal`, recorded as
 * `username`'s upload? The file itself or a folder it sits in below the root
 * (a dropped folder is recorded once, by its root) — the rule of
 * src/lib/chat-media-owners.ts `isMediaOwnedBy`. A file with no record is
 * nobody's to a member.
 */
export function stagedFileOwnedBy(username, real, rootReal, ownersFile) {
  if (!ownersFile) return false;
  const owners = readMediaOwners(ownersFile);
  let current = real;
  for (;;) {
    const rel = path.relative(rootReal, current);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const owner = owners[current];
    if (typeof owner === "string") return owner === username;
    current = path.dirname(current);
  }
}

let grantsCache = { file: "", ino: -1, mtimeMs: -1, size: -1, agents: null };
/**
 * `{ agentId: [entry, …] }` from the grants file, re-read when it changes; null
 * when it cannot be read (then nothing is granted). The same one-descriptor
 * read as the media owners.
 */
export function readStaffMcpGrants(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const { ino, mtimeMs, size } = fstatSync(fd);
    if (grantsCache.file === file && grantsCache.ino === ino && grantsCache.mtimeMs === mtimeMs && grantsCache.size === size) return grantsCache.agents;
    const parsed = JSON.parse(readFileSync(fd, "utf-8"));
    const agents = parsed && typeof parsed.agents === "object" && !Array.isArray(parsed.agents) ? parsed.agents : null;
    grantsCache = { file, ino, mtimeMs, size, agents };
    return agents;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Where the grants file may be, in order: in the installed plugin's folder
 * under OpenClaw's state directory — where ClawBox writes it — and beside
 * this module. The state directory comes first because the gateway may load
 * a plugin from a snapshot of its folder taken at start (its plugin
 * "generations"), which a file ClawBox writes later never reaches.
 */
function defaultGrantsFiles(opts) {
  const home = opts.home ?? os.homedir();
  const stateDir = opts.openclawHome ?? process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
  const files = [path.join(stateDir, "extensions", "clawbox-staff-guard", "staff-mcp-grants.json")];
  try {
    files.push(fileURLToPath(new URL("./staff-mcp-grants.json", import.meta.url)));
  } catch {
    // not a file URL
  }
  return [...new Set(files)];
}

/**
 * The MCP server a tool id names, or "" for a tool that is not an MCP tool:
 * `<server>__<tool>` (OpenClaw's own name), or Tool Search's `mcp:<server>:<tool>`.
 */
export function mcpServerOf(toolId) {
  if (typeof toolId !== "string") return "";
  const id = toolId.trim();
  const colon = /^mcp:([^:]+):(.+)$/.exec(id);
  if (colon) return colon[1];
  const at = id.indexOf("__");
  return at > 0 ? id.slice(0, at) : "";
}

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** The agent a session key names (`agent:<id>:…`), lower-cased, or "". */
function agentOfKey(key) {
  const m = typeof key === "string" ? /^agent:([^:]+):/.exec(key.trim()) : null;
  return m ? m[1].toLowerCase() : "";
}

/**
 * The member of staff whose agent is making this call, or null for every
 * other agent. The context's `agentId` first; the session key when the host
 * did not fill it in.
 */
export function staffMemberOf(ctx) {
  const prefix = staffPolicyTable().agentPrefix;
  const agentId = typeof ctx?.agentId === "string" && ctx.agentId ? ctx.agentId.toLowerCase() : agentOfKey(ctx?.sessionKey);
  if (!agentId.startsWith(prefix)) return null;
  const name = agentId.slice(prefix.length);
  return USERNAME_RE.test(name) ? name : null;
}

/** The real path of `p`, or of its nearest existing ancestor with the rest re-attached. */
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    if (existsSync(head)) {
      try {
        return path.join(realpathSync(head), ...tail.reverse());
      } catch {
        return path.join(head, ...tail.reverse());
      }
    }
    const parent = path.dirname(head);
    if (parent === head) return path.join(head, ...tail.reverse());
    tail.push(path.basename(head));
    head = parent;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A path a tool was handed, as an absolute path — or `{ url }` when it is not a local file. */
function resolveCandidate(raw, folder, home) {
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return { url: raw };
    }
  } else if (/^data:/i.test(value)) {
    // Inline content (a pasted picture): nothing is fetched and no file is named.
    return { inline: true };
  } else if (URL_RE.test(value)) {
    return { url: raw };
  }
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = path.join(home, value.slice(2));
  return { path: path.isAbsolute(value) ? value : path.join(folder, value) };
}

/** The keys a file tool names its target under in the pinned core, plus the media tools' own. */
const PATH_KEYS = new Set(["path", "paths", "file_path", "filePath", "file", "files", "target", "destination", "pdf", "pdfs", "image", "images", "url", "urls", "src", "source"]);

function pathParams(params) {
  const out = [];
  if (!params || typeof params !== "object") return out;
  for (const [key, value] of Object.entries(params)) {
    if (!PATH_KEYS.has(key)) continue;
    if (typeof value === "string" && value.trim()) out.push(value);
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item.trim()) out.push(item);
  }
  return out;
}

/** The files an `apply_patch` envelope names, read from its own headers. */
function patchPaths(params) {
  const out = [];
  if (!params || typeof params !== "object") return out;
  for (const value of Object.values(params)) {
    if (typeof value !== "string") continue;
    for (const line of value.split("\n")) {
      const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim()) || /^\*\*\* Move to: (.+)$/.exec(line.trim());
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

/**
 * Why a member of staff's tool call is refused, or null to let it run (and
 * null for any agent that is not a member of staff's).
 *
 * `opts.openclawHome` is OpenClaw's state directory; the folder and the
 * attachment directory hang off it. `opts.mediaOwners` is the attachment
 * owner record (default: the one recorded beside the installed plugin).
 */
/**
 * Tool Search's controls (docs/tools/tool-search.md in the pinned core): with
 * `tools.toolSearch` on, a deferred tool — memory search among them — is
 * reached only through these. The catalog they search and describe is already
 * the agent's policy-filtered one, and the final call returns to OpenClaw's
 * normal policy and hooks; the dispatcher is judged here by the tool it names
 * too. OpenClaw 2026.11.3 named the dispatcher `dispatch_action` (its hook sees
 * that name; `tool_call` is its old name, kept for an older core), and the
 * dispatcher itself is force-allowed past an agent's `tools.allow`, so this
 * guard is the only place a member of staff's dispatch is judged.
 */
const TOOL_SEARCH_READS = new Set(["tool_search", "tool_describe"]);
const TOOL_SEARCH_CALLS = new Set(["dispatch_action", "tool_call"]);
/** The dispatcher's own keys: what it names and where the target's arguments sit. */
const DISPATCH_KEYS = new Set(["id", "toolId", "name", "args", "input"]);

/**
 * The id a dispatch names, as given (`openclaw:core:memory_search`,
 * `mcp:docs:search`), or "". Read in the core's own order (`id`, then
 * `toolId`, then `name`) so the guard judges the tool the core will run.
 */
function calledToolId(params) {
  const id = params && typeof params === "object" ? params.id ?? params.toolId ?? params.name : undefined;
  return typeof id === "string" ? id.trim() : "";
}

/**
 * The arguments a dispatch hands its target, as the core reads them: `args`,
 * else `input`, else the keys flattened beside the id (the core repairs those
 * from small models); dotted `args.<key>` entries land on top.
 */
function dispatchedArgs(params) {
  const outer = params && typeof params === "object" ? params : {};
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  const base = isObject(outer.args) ? { ...outer.args }
    : isObject(outer.input) ? { ...outer.input }
    : Object.fromEntries(Object.entries(outer).filter(([k]) => !DISPATCH_KEYS.has(k) && !k.startsWith("args.")));
  for (const [k, v] of Object.entries(outer)) if (k.startsWith("args.") && k.length > 5) base[k.slice(5)] = v;
  return base;
}

/** The tool a dispatch names (`openclaw:core:memory_search` → `memory_search`), or "". */
function calledTool(params) {
  const id = calledToolId(params);
  if (!id) return "";
  const parts = id.split(":");
  return parts[parts.length - 1];
}

/**
 * The verdict on an MCP tool call (TASK-2377): undefined when the call is not
 * an MCP tool's, null to let it run, a reason to refuse it. `username` is the
 * calling member of staff, or null for any other agent.
 */
function staffMcpVerdict(toolId, username, ctx, opts) {
  const server = mcpServerOf(toolId);
  if (!server) return undefined;
  const prefix = staffPolicyTable().mcpEntryPrefix || "cbstaff-";
  const isRelayEntry = server.toLowerCase().startsWith(prefix);
  if (!username) {
    // The owner's agents: a member's relay entry carries that member's token.
    return isRelayEntry ? `\`${toolId}\` belongs to a member of staff's own assistant` : undefined;
  }
  if (server.toLowerCase() === "clawbox" || !isRelayEntry) return `\`${toolId}\` is not available to members of staff`;
  const files = "mcpGrants" in opts ? [opts.mcpGrants].filter(Boolean) : defaultGrantsFiles(opts);
  let agents = null;
  for (const file of files) {
    agents = readStaffMcpGrants(file);
    if (agents) break;
  }
  const agentId = `${staffPolicyTable().agentPrefix}${username}`;
  const granted = agents && Array.isArray(agents[agentId]) ? agents[agentId] : [];
  return granted.includes(server) ? null : `\`${toolId}\` is not granted to this member of staff`;
}

export function staffToolCallDenyReason(event, ctx, opts = {}) {
  const username = staffMemberOf(ctx);
  const outerName = typeof event?.toolName === "string" ? event.toolName : "";
  const dispatching = TOOL_SEARCH_CALLS.has(outerName);
  const outerMcp = staffMcpVerdict(dispatching ? calledToolId(event?.params) : outerName, username, ctx, opts);
  if (!username) return outerMcp ?? null;
  if (outerMcp !== undefined) return outerMcp;
  const policy = staffPolicyTable().openclaw;
  let toolName = outerName;
  if (TOOL_SEARCH_READS.has(toolName)) return null;
  let params = event?.params;
  if (dispatching) {
    const inner = calledTool(params);
    if (!inner) return `\`${outerName}\` without a tool it names`;
    toolName = inner;
    params = dispatchedArgs(params);
    event = { ...event, toolName, params, derivedPaths: undefined };
  }
  if (!policy.allow.includes(toolName)) return `\`${toolName || "this tool"}\` is not available to members of staff`;

  const home = opts.home ?? os.homedir();
  const openclawHome = opts.openclawHome ?? path.join(home, ".openclaw");
  const folder = path.join(openclawHome, "staff", username);
  const folderReal = realish(folder);
  const attachmentsReal = realish(path.join(openclawHome, "media", "chat-attachments"));

  const writing = policy.writeTools.includes(toolName);
  const reading = policy.readTools.includes(toolName);
  if (!writing && !reading) return null;

  let candidates;
  if (writing) {
    const derived = Array.isArray(event?.derivedPaths) ? event.derivedPaths.filter((p) => typeof p === "string" && p.trim()) : [];
    candidates = derived.length > 0 ? derived : toolName === "apply_patch" ? patchPaths(params) : pathParams(params);
    // A write whose target cannot be read off the call is not one this guard
    // can vouch for.
    if (candidates.length === 0) return `\`${toolName}\` without a file it names`;
  } else {
    candidates = pathParams(params);
    // A read whose source cannot be read off the call is not one this guard
    // can vouch for either.
    if (candidates.length === 0) return `\`${toolName}\` without a file it names`;
  }

  for (const raw of candidates) {
    const resolved = resolveCandidate(raw, folder, home);
    if (resolved.inline) continue;
    if (resolved.url !== undefined) return `\`${toolName}\` on ${resolved.url.slice(0, 120)} (nothing on the web)`;
    const real = realish(resolved.path);
    if (inside(real, folderReal)) continue;
    if (reading && inside(real, attachmentsReal)) {
      const ownersFile = "mediaOwners" in opts ? opts.mediaOwners : mediaOwnersFile();
      if (stagedFileOwnedBy(username, real, attachmentsReal, ownersFile)) continue;
      return `\`${toolName}\` on ${raw.slice(0, 200)}, a chat attachment that is not theirs`;
    }
    return `\`${toolName}\` on ${raw.slice(0, 200)}, outside their own folder (${folder})`;
  }
  return null;
}

/** The refusal the agent is handed: what to tell the member of staff. */
export function staffDenyMessage(reason) {
  return (
    `Blocked by ClawBox: ${reason}. On this organisation's ClawBox a member of staff's assistant `
    + `answers questions, reads the files they attach, keeps their own memory and writes files only `
    + `into their own folder; it has no web, browser, shell, messages, automations, sub-agents or `
    + `system settings. Do not retry or look for another way; tell the user plainly that this is not `
    + `available to them here and that their administrator can do it.`
  );
}
