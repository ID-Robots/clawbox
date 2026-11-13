/**
 * The loopback relay between a member of staff's OpenClaw agent and an MCP
 * server the owner granted to staff (TASK-2377, src/lib/staff-mcp.ts says
 * why). SERVER ONLY.
 *
 * The gateway calls `/setup-api/staff-mcp/<server>` with the relay token of
 * ONE member (their own `mcp.servers` entry carries it). The relay:
 *
 *   1. names the member by that token (constant-time) — no token, no member,
 *      401; the owner's agent and every other caller have none;
 *   2. serves only while organisation mode is on, the member is still a
 *      registered user, the owner still grants the server (to every member,
 *      or to this one by name), the server is still a Streamable HTTP server
 *      in the assistant's config (openclaw.json, or Hermes' config.yaml), and
 *      the member has a credential for it unless the owner marked it as one
 *      that takes none (TASK-2516) — otherwise 403/404, and their agent gets
 *      no tools;
 *   3. sends the request on to the owner's configured URL with exactly the
 *      member's credential in the owner's chosen header (or no credential at
 *      all for a server that takes none). Nothing of the owner's entry's
 *      headers, and nothing of the relay token, travels;
 *   4. holds the tools to the owner's tool filter minus anything that sends or
 *      writes — where the owner ticked it, minus anything that does more than
 *      create or edit (`staffToolAllowed`): `tools/list` answers are filtered (JSON or
 *      an SSE stream), and a `tools/call` of anything else is answered with a
 *      JSON-RPC error without reaching the server.
 *
 * Redirects are not followed (a credential never goes to a second origin).
 */

import { readOrgModeStrict } from "@/lib/org-mode-server";
import { stringsIn } from "../../scripts/chat-reply-media.js";
import {
  credentialHeaderValue,
  grantReaches,
  readStaffMcpStoreOrEmpty,
  staffServerVerdict,
  staffToolAllowed,
  userOfRelayToken,
  type ToolAnnotations,
  type ToolFilter,
} from "@/lib/staff-mcp";

/** A JSON-RPC request body is small; a tool's arguments are not a file upload. */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** A `tools/list` answer is buffered to be filtered; beyond this it is refused rather than passed whole. */
const MAX_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
/** A POST (a tool call answered by a stream included) may run this long. */
const POST_TIMEOUT_MS = 5 * 60_000;

/** Headers passed on to the server: the transport's own. Never Authorization, never a cookie. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Headers passed back to the gateway. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

/** What each member's servers said about their tools at the last listing: `${user}\0${server}` → tool → annotations. */
const annotationCache = new Map<string, Map<string, ToolAnnotations | null>>();

/** Test seam. */
export function resetRelayCachesForTests(): void {
  annotationCache.clear();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function refuse(status: number, code: string, error: string): Response {
  return json(status, { error, code });
}

function bearerOf(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** The relayed request's caller and target, or the refusal. */
type Admission =
  | { ok: true; username: string; harness: "openclaw" | "hermes"; url: string; header: string; credential: string | null; filter: ToolFilter; cacheKey: string }
  | { ok: false; response: Response };

/**
 * Who is calling and where to. Everything is re-read per request: a grant
 * the owner withdrew, a credential cleared, a user removed or the switch
 * turned off stops the next call, not the next restart.
 */
export async function admitRelayRequest(req: Request, server: string): Promise<Admission> {
  const store = await readStaffMcpStoreOrEmpty();
  const username = userOfRelayToken(store, bearerOf(req));
  if (!username) return { ok: false, response: refuse(401, "unauthorized", "Unknown relay token.") };
  if ((await readOrgModeStrict()) !== true) {
    return { ok: false, response: refuse(403, "org_mode_off", "Members of staff have no MCP tools while organisation mode is off.") };
  }
  const { listUsers } = await import("@/lib/clawbox-users");
  if (!(await listUsers()).some((user) => user.username === username)) {
    return { ok: false, response: refuse(403, "not_a_user", "This member of staff is no longer a user of this box.") };
  }
  const setting = Object.hasOwn(store.servers, server) ? store.servers[server] : undefined;
  if (!setting) return { ok: false, response: refuse(404, "not_granted", "The owner has not granted this server to members of staff.") };
  if (!grantReaches(setting, username)) return { ok: false, response: refuse(403, "not_granted", "The owner has not granted this server to this member of staff.") };
  const mine = Object.hasOwn(store.credentials, username) ? store.credentials[username] : undefined;
  // A server that takes no credential (a tool on this box, TASK-2516) is
  // called with none: never the owner's headers in its place.
  const credential = setting.needsCredential !== false && mine && Object.hasOwn(mine, server) ? mine[server] : undefined;
  if (setting.needsCredential !== false && !credential) {
    return { ok: false, response: refuse(403, "no_credential", "No credential is set for this member of staff on this server.") };
  }

  // The server as the box's assistant defines it now: openclaw.json's
  // `mcp.servers` on OpenClaw, config.yaml's `mcp_servers` on Hermes.
  const [{ readServersOf }, { getActiveHarness }] = await Promise.all([import("@/lib/project-mcp-servers"), import("@/lib/harness")]);
  const harness: "openclaw" | "hermes" = (await getActiveHarness()) === "hermes" ? "hermes" : "openclaw";
  // A grant is for the runtime it was made on: after the owner switches
  // runtime, a same-named server of the other one inherits nothing.
  if ((setting.harness ?? "openclaw") !== harness) {
    return { ok: false, response: refuse(404, "not_granted", "The owner has not granted this server to members of staff on this assistant.") };
  }
  let read;
  try {
    read = (await readServersOf(harness)).find((entry) => entry.name === server);
  } catch {
    return { ok: false, response: refuse(503, "config_unreadable", "The assistant's configuration could not be read.") };
  }
  if (!read || staffServerVerdict(read) !== null || !read.config || !("url" in read.config)) {
    return { ok: false, response: refuse(404, "server_unavailable", "This server is not one members of staff can use.") };
  }
  return {
    ok: true,
    username,
    harness,
    url: read.config.url,
    header: setting.header,
    credential: credential ?? null,
    filter: { include: read.include ?? null, exclude: read.exclude ?? [], writeTools: setting.writeTools === true },
    // Keyed by the runtime and the server's URL too: what one server said
    // about a tool is never used to judge another's.
    cacheKey: `${username}\0${server}\0${harness}\0${read.config.url}`,
  };
}

function upstreamHeaders(req: Request, admission: Extract<Admission, { ok: true }>): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (admission.credential !== null) headers.set(admission.header, credentialHeaderValue(admission.header, admission.credential));
  return headers;
}

function downstreamHeaders(res: Response): Headers {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A `tools/list` result with every tool a member may not reach taken out, and what the server said of each kept. */
function filterToolsResult(message: JsonRpcMessage, filter: ToolFilter, cache: Map<string, ToolAnnotations | null>): JsonRpcMessage {
  if (!isObject(message.result) || !Array.isArray(message.result.tools)) return message;
  const tools = message.result.tools.filter((tool: unknown) => {
    if (!isObject(tool)) return false;
    const annotations = isObject(tool.annotations) ? (tool.annotations as ToolAnnotations) : null;
    // EVERY listed tool is remembered with what the server said of it — the
    // refused ones too, so a call naming one is judged by its annotations
    // rather than waved through for want of them.
    if (typeof tool.name === "string") cache.set(tool.name, annotations);
    return staffToolAllowed(tool.name, filter, annotations);
  });
  return { ...message, result: { ...message.result, tools } };
}

/** Rewrite each `tools/list` answer in a JSON body. */
function filterJsonBody(text: string, listIds: Set<string>, filter: ToolFilter, cache: Map<string, ToolAnnotations | null>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A tool list that cannot be read is not passed unfiltered.
    if (listIds.size === 0) return text;
    return JSON.stringify([...listIds].map((id) => ({ jsonrpc: "2.0", id: JSON.parse(id), error: { code: -32603, message: "The tool list could not be read." } })));
  }
  const one = (m: unknown) => (isObject(m) && listIds.has(JSON.stringify(m.id)) ? filterToolsResult(m as JsonRpcMessage, filter, cache) : m);
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed));
}

/** Rewrite each `tools/list` answer in an SSE body, event by event; other events pass as they are. */
function filterSseBody(text: string, listIds: Set<string>, filter: ToolFilter, cache: Map<string, ToolAnnotations | null>): string {
  // Every SSE line ending (CRLF, LF, a lone CR) read as one.
  const events = text.replace(/\r\n?/g, "\n").split("\n\n");
  return events
    .map((event) => {
      const lines = event.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length === 0) return event;
      const rewritten = filterJsonBody(data.join("\n"), listIds, filter, cache);
      if (rewritten === data.join("\n")) return event;
      const others = lines.filter((line) => !line.startsWith("data:"));
      return [...others, ...rewritten.split("\n").map((line) => `data: ${line}`)].join("\n");
    })
    .join("\n\n");
}

async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const NOT_FOR_STAFF = -32601;

function toolRefusal(id: unknown, name: unknown): Record<string, unknown> {
  const tool = typeof name === "string" && name ? `The tool \`${name.slice(0, 80)}\`` : "This tool";
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: NOT_FOR_STAFF,
      message: `${tool} is not available to members of staff on this ClawBox: it is outside the owner's grant, or it sends or changes something.`,
    },
  };
}

/** The JSON-RPC messages of a response body, JSON or SSE. */
function messagesOf(text: string, contentType: string): unknown[] {
  const parse = (raw: string): unknown[] => {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  };
  if (!contentType.toLowerCase().includes("text/event-stream")) return parse(text);
  return text.replace(/\r\n?/g, "\n").split("\n\n").flatMap((event) => {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    return data.length > 0 ? parse(data.join("\n")) : [];
  });
}

/**
 * Ask the server for its tool list on the member's behalf (their credential,
 * the gateway's MCP session) and remember every tool and its annotations. At
 * most a few pages; anything that fails leaves the cache as it was, and the
 * call it was for is then refused.
 */
async function learnToolList(req: Request, admission: Extract<Admission, { ok: true }>, cache: Map<string, ToolAnnotations | null>): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let res: Response;
    try {
      const headers = upstreamHeaders(req, admission);
      headers.set("content-type", "application/json");
      if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
      res = await fetch(admission.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: `clawbox-relay-list-${page}`, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }),
        redirect: "manual",
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      return;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    const body = await readBounded(res.body, MAX_LIST_RESPONSE_BYTES);
    if (body === null) return;
    const answer = messagesOf(body, res.headers.get("content-type") ?? "").find(
      (m): m is JsonRpcMessage => isObject(m) && m.id === `clawbox-relay-list-${page}`,
    );
    if (!answer || !isObject(answer.result) || !Array.isArray(answer.result.tools)) return;
    for (const tool of answer.result.tools) {
      if (isObject(tool) && typeof tool.name === "string") cache.set(tool.name, isObject(tool.annotations) ? (tool.annotations as ToolAnnotations) : null);
    }
    cursor = typeof answer.result.nextCursor === "string" && answer.result.nextCursor ? answer.result.nextCursor : undefined;
    if (!cursor) return;
  }
}

/** POST: one JSON-RPC message (or a batch) from the gateway. */
async function relayPost(req: Request, admission: Extract<Admission, { ok: true }>): Promise<Response> {
  const text = await readBounded(req.body, MAX_REQUEST_BYTES);
  if (text === null) return refuse(413, "body_too_large", "That request is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const messages: JsonRpcMessage[] = (Array.isArray(parsed) ? parsed : [parsed]).filter(isObject) as JsonRpcMessage[];
  const cache = annotationCache.get(admission.cacheKey) ?? new Map<string, ToolAnnotations | null>();
  annotationCache.set(admission.cacheKey, cache);

  // A call is judged by what the server LISTED: a tool this relay has not
  // seen listed (a restart, a session the gateway opened before) is looked up
  // first, and one the server does not list at all is refused.
  const calledNames = messages
    .filter((m) => m.method === "tools/call")
    .map((m) => (isObject(m.params) ? m.params.name : undefined));
  if (calledNames.some((name) => typeof name === "string" && !cache.has(name))) {
    await learnToolList(req, admission, cache);
  }
  const refused = messages.filter((m) => {
    if (m.method !== "tools/call") return false;
    const name = isObject(m.params) ? m.params.name : undefined;
    if (typeof name !== "string" || !cache.has(name)) return true;
    return !staffToolAllowed(name, admission.filter, cache.get(name));
  });
  if (refused.length > 0) {
    // Nothing of a batch that names a refused tool reaches the server.
    const answers = messages
      .filter((m) => m.id !== undefined)
      .map((m) => (refused.includes(m) ? toolRefusal(m.id, isObject(m.params) ? m.params.name : undefined) : { jsonrpc: "2.0", id: m.id, error: { code: NOT_FOR_STAFF, message: "Refused with the rest of its batch." } }));
    return json(200, Array.isArray(parsed) ? answers : answers[0] ?? {});
  }

  const listIds = new Set(messages.filter((m) => m.method === "tools/list" && m.id !== undefined).map((m) => JSON.stringify(m.id)));
  const callIds = new Set(messages.filter((m) => m.method === "tools/call" && m.id !== undefined).map((m) => JSON.stringify(m.id)));
  // The files a call's result names are the member's — provenance, TASK-2516.
  const recordOutputs = callIds.size > 0 ? await toolOutputRecorder(admission, Date.now()) : null;
  let upstream: Response;
  try {
    upstream = await fetch(admission.url, {
      method: "POST",
      headers: upstreamHeaders(req, admission),
      body: text,
      redirect: "manual",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(POST_TIMEOUT_MS)]),
    });
  } catch {
    return refuse(502, "upstream_unreachable", "The MCP server could not be reached.");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    return refuse(502, "upstream_redirect", "The MCP server answered with a redirect, which is not followed.");
  }
  const headers = downstreamHeaders(upstream);
  if (listIds.size === 0 || !upstream.ok) {
    const sse = (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
    let body: ReadableStream<Uint8Array> | null = upstream.body as ReadableStream<Uint8Array> | null;
    // A streamed answer is still read event by event: any tool list in it
    // (whatever asked for it) reaches the member filtered.
    if (body && sse) body = filteredSse(body, admission.filter, cache);
    if (body && upstream.ok && recordOutputs) body = recordingToolResults(body, sse, callIds, recordOutputs);
    return new Response(body as BodyInit | null, { status: upstream.status, headers });
  }
  const body = await readBounded(upstream.body, MAX_LIST_RESPONSE_BYTES);
  if (body === null) return refuse(502, "upstream_too_large", "The MCP server's tool list is too large to check.");
  const type = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const filtered = type.includes("text/event-stream")
    ? filterSseBody(body, listIds, admission.filter, cache)
    : filterJsonBody(body, listIds, admission.filter, cache);
  return new Response(filtered, { status: upstream.status, headers });
}

/** A tool result is read for the files it names up to this size; a larger one passes unread (its files stay nobody's). */
const MAX_TOOL_RESULT_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Records, as the calling member's, the files a tool result names in the chat
 * media tree or their own assistant folder and that were written since the
 * call began (src/lib/chat-reply-media.ts `recordToolOutputFiles`). The roots
 * are the active runtime's.
 */
async function toolOutputRecorder(admission: Extract<Admission, { ok: true }>, since: number): Promise<((strings: unknown[]) => void) | null> {
  try {
    const [{ chatMediaRoot }, { recordToolOutputFiles }] = await Promise.all([import("@/lib/harness/media-root"), import("@/lib/chat-reply-media")]);
    const mediaRoot = await chatMediaRoot().catch(() => null);
    let ownFolder: string | null = null;
    if (admission.harness === "hermes") {
      const { staffHermesProfilePaths } = await import("@/lib/hermes-staff-profile");
      ownFolder = staffHermesProfilePaths(admission.username)?.folder ?? null;
    } else {
      const [{ staffWorkspaceDir }, { OPENCLAW_HOME }] = await Promise.all([import("@/lib/org-staff-agents"), import("@/lib/openclaw-config")]);
      ownFolder = staffWorkspaceDir(OPENCLAW_HOME, admission.username);
    }
    return (strings) => {
      const { recorded, refused } = recordToolOutputFiles({ username: admission.username, strings, mediaRoot, ownFolder, since });
      if (recorded.length > 0) console.log(`[staff-mcp] a tool result named ${recorded.length} file(s), recorded as the member's${refused.length ? ` (${refused.length} not)` : ""}`);
    };
  } catch (err) {
    // Nothing recorded: the member's files stay nobody's (fail closed); the call itself goes on.
    console.error("[staff-mcp] a tool result's files could not be recorded:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The `result` strings of the answers to `callIds` in one JSON-RPC text (a message or a batch). */
function callResultStrings(text: string, callIds: Set<string>): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (isObject(m) && callIds.has(JSON.stringify(m.id)) && m.result !== undefined) out.push(...stringsIn(m.result));
  }
  return out;
}

/**
 * Pass a tool call's answer through unchanged, recording the files its
 * result names before the gateway can act on it: an SSE answer event by
 * event (each event's text goes on only after it was read), a JSON one when
 * it ends.
 */
function recordingToolResults(body: ReadableStream<Uint8Array>, sse: boolean, callIds: Set<string>, record: (strings: unknown[]) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let seen = 0;
  const readEvent = (event: string) => {
    const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) {
      const strings = callResultStrings(data, callIds);
      if (strings.length > 0) record(strings);
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_TOOL_RESULT_SCAN_BYTES) {
        if (pending) controller.enqueue(encoder.encode(pending));
        pending = "";
        controller.enqueue(chunk);
        return;
      }
      const text = decoder.decode(chunk, { stream: true });
      if (!sse) {
        pending += text;
        controller.enqueue(chunk);
        return;
      }
      pending += text.replace(/\r\n?/g, "\n");
      for (;;) {
        const m = /\n\n/.exec(pending);
        if (!m) break;
        const event = pending.slice(0, m.index);
        readEvent(event);
        controller.enqueue(encoder.encode(`${event}\n\n`));
        pending = pending.slice(m.index + 2);
      }
    },
    flush(controller) {
      if (seen > MAX_TOOL_RESULT_SCAN_BYTES) return;
      pending += decoder.decode();
      if (!sse) {
        const strings = callResultStrings(pending, callIds);
        if (strings.length > 0) record(strings);
        return;
      }
      if (pending.trim()) {
        readEvent(pending);
        controller.enqueue(encoder.encode(pending));
      }
    },
  }));
}

/** Any message in `text` that carries a tool list, filtered (whatever request it answers). */
function filterAnyToolList(text: string, filter: ToolFilter, cache: Map<string, ToolAnnotations | null>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const one = (m: unknown) => (isObject(m) && isObject(m.result) && Array.isArray(m.result.tools) ? filterToolsResult(m as JsonRpcMessage, filter, cache) : m);
  const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
  return JSON.stringify(out) === JSON.stringify(parsed) ? text : JSON.stringify(out);
}

/**
 * An SSE stream, event by event, with every tool list in it filtered: a
 * server may close a POST's stream early and deliver the answer — a
 * `tools/list` result included — on a resumed GET (`Last-Event-ID`), which
 * must not hand a member a tool the POST path would have removed. Events are
 * passed on as they complete; an event larger than the list cap ends the
 * stream rather than going through unread.
 */
function filteredSse(body: ReadableStream<Uint8Array>, filter: ToolFilter, cache: Map<string, ToolAnnotations | null>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  // Every SSE line ending (CRLF, LF, a lone CR) becomes LF before events are
  // cut; a CR at the end of a chunk waits to see whether an LF follows it.
  let heldCR = false;
  const normalize = (text: string): string => {
    let t = heldCR ? `\r${text}` : text;
    heldCR = t.endsWith("\r");
    if (heldCR) t = t.slice(0, -1);
    return t.replace(/\r\n?/g, "\n");
  };
  const emit = (event: string) => {
    const lines = event.split(/\r?\n/);
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length === 0) return `${event}\n\n`;
    const rewritten = filterAnyToolList(data.join("\n"), filter, cache);
    if (rewritten === data.join("\n")) return `${event}\n\n`;
    const others = lines.filter((l) => !l.startsWith("data:"));
    return `${[...others, ...rewritten.split("\n").map((l) => `data: ${l}`)].join("\n")}\n\n`;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += normalize(decoder.decode(chunk, { stream: true }));
      for (;;) {
        const m = /\n\n/.exec(pending);
        if (!m) break;
        controller.enqueue(encoder.encode(emit(pending.slice(0, m.index))));
        pending = pending.slice(m.index + m[0].length);
      }
      if (pending.length > MAX_LIST_RESPONSE_BYTES) controller.error(new Error("an SSE event too large to check"));
    },
    flush(controller) {
      pending += normalize(decoder.decode());
      if (heldCR) pending += "\n";
      if (pending.trim()) controller.enqueue(encoder.encode(emit(pending)));
    },
  }));
}

/** GET (the server's own stream, a resumed one included) and DELETE (end the session). */
async function relayOther(req: Request, admission: Extract<Admission, { ok: true }>): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(admission.url, {
      method: req.method,
      headers: upstreamHeaders(req, admission),
      redirect: "manual",
      signal: req.signal,
    });
  } catch {
    return refuse(502, "upstream_unreachable", "The MCP server could not be reached.");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    return refuse(502, "upstream_redirect", "The MCP server answered with a redirect, which is not followed.");
  }
  const headers = downstreamHeaders(upstream);
  if (upstream.body && (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    const cache = annotationCache.get(admission.cacheKey) ?? new Map<string, ToolAnnotations | null>();
    annotationCache.set(admission.cacheKey, cache);
    return new Response(filteredSse(upstream.body, admission.filter, cache), { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function relayStaffMcp(req: Request, server: string): Promise<Response> {
  const admission = await admitRelayRequest(req, server);
  if (!admission.ok) return admission.response;
  if (req.method === "POST") return relayPost(req, admission);
  if (req.method === "GET" || req.method === "DELETE") return relayOther(req, admission);
  return refuse(405, "method_not_allowed", "Method not allowed.");
}
