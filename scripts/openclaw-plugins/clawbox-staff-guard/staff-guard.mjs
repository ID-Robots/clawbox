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
//     chat's staged attachments, and nothing on the web.
//
// Every other agent — the owner's above all — is not this plugin's business:
// it answers `null` ("no opinion") for them without looking further.

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
 * attachment directory hang off it.
 */
/**
 * Tool Search's controls (docs/tools/tool-search.md in the pinned core): with
 * `tools.toolSearch` on, a deferred tool — memory search among them — is
 * reached only through these. The catalog they search and describe is already
 * the agent's policy-filtered one, and the final call returns to OpenClaw's
 * normal policy and hooks; `tool_call` is judged here by the tool it names too.
 */
const TOOL_SEARCH_READS = new Set(["tool_search", "tool_describe"]);
const TOOL_SEARCH_CALL = "tool_call";

/** The tool a `tool_call` names (`openclaw:core:memory_search` → `memory_search`), or "". */
function calledTool(params) {
  const id = params && typeof params === "object" ? params.id ?? params.name ?? params.tool : undefined;
  if (typeof id !== "string" || !id.trim()) return "";
  const parts = id.trim().split(":");
  return parts[parts.length - 1];
}

export function staffToolCallDenyReason(event, ctx, opts = {}) {
  const username = staffMemberOf(ctx);
  if (!username) return null;
  const policy = staffPolicyTable().openclaw;
  let toolName = typeof event?.toolName === "string" ? event.toolName : "";
  if (TOOL_SEARCH_READS.has(toolName)) return null;
  let params = event?.params;
  if (toolName === TOOL_SEARCH_CALL) {
    const inner = calledTool(params);
    if (!inner) return `\`tool_call\` without a tool it names`;
    toolName = inner;
    const args = params && typeof params === "object" ? params.args : undefined;
    params = args && typeof args === "object" && !Array.isArray(args) ? args : {};
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
    if (reading && inside(real, attachmentsReal)) continue;
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
