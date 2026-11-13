// Runs ON the board, as clawbox, for scripts/nano-tests/tests/56-org-mode-staff.sh:
// the MCP servers the owner grants to members of staff, each call carrying
// THAT member's own credential (TASK-2377, src/lib/staff-mcp.ts).
//
//   node org-mode-staff-mcp.mjs   (env: A_NAME A_COOKIE B_NAME B_COOKIE OWNER_COOKIE MARK RUNTIME REPO)
//
// A tiny MCP server (Streamable HTTP, on loopback) answers `whoami` with the
// Authorization header it was called with, `search` with a fixed line, and
// offers `send_note`, which must never reach a member. On OpenClaw:
//
//   1. the owner adds it to OpenClaw as their own server (with their own
//      header), grants it to staff and gives A a credential — B none;
//   2. A's assistant calls `whoami` and the server saw A's credential; B's
//      assistant has no such tool and the server saw nothing of B's;
//   3. B is given a credential: B's call carries B's, never A's;
//   4. the owner's assistant calls the server through the owner's OWN entry,
//      with the owner's header — never a member's — and has none of the
//      members' relay entries;
//   5. the relay itself: no token 401, `send_note` refused before the server,
//      the tool list filtered; the credentials stored 0600, never in
//      openclaw.json, answered to the owner masked and to A refused.
//
// On Hermes (TASK-2516) the same grant reaches each member through their own
// profile: the owner's server in config.yaml, A's call with A's credential, B
// without one gets no entry and no tool.
//
// Prints `RESULT ok - …`, `RESULT not ok - …` and `NOTE …` lines. Nothing it
// prints names a host, an address or a credential.

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const REPO = process.env.REPO || "/home/clawbox/clawbox";
const require = createRequire(path.join(REPO, "package.json"));
const WebSocket = require("ws");
const relay = require(path.join(REPO, "scripts/gateway-user-relay.js"));
const policy = require(path.join(REPO, "scripts/org-staff-policy.js"));

const DASHBOARD = "http://127.0.0.1";
const HOME = process.env.HOME || "/home/clawbox";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const HERMES_HOME = process.env.HERMES_HOME || path.join(HOME, ".hermes");
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 18789);
const { A_NAME, A_COOKIE, B_NAME, B_COOKIE, OWNER_COOKIE, MARK, RUNTIME } = process.env;
const TURN_MS = 300_000;
const SERVER = `nanoecho${MARK.slice(-4)}`;
const CRED_A = `cred-a-${MARK}-${randomUUID()}`;
const CRED_B = `cred-b-${MARK}-${randomUUID()}`;
const OWNER_TOKEN = `owner-${MARK}-${randomUUID()}`;

const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${String(line).replace(/\s+/g, " ").slice(0, 900)}`);
const ok = (line) => say(`ok - [${RUNTIME}] ${line}`);
const fail = (line) => say(`not ok - [${RUNTIME}] ${line}`);
const check = (cond, line, why = "") => (cond ? ok(line) : fail(why ? `${line} — ${why}` : line));
/** What a header said, with the credential itself replaced by whose it is. */
const whose = (auth) => (auth === `Bearer ${CRED_A}` ? "A's credential" : auth === `Bearer ${CRED_B}` ? "B's credential" : auth === `Bearer ${OWNER_TOKEN}` ? "the owner's header" : auth ? "another value" : "no header");

// ── the stub MCP server ─────────────────────────────────────────────────────

const calls = [];
const TOOLS = [
  { name: "whoami", description: "Says which credential this call carried.", inputSchema: { type: "object", properties: {} } },
  { name: "search", description: "Searches the test documents.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "send_note", description: "Sends a note to someone.", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const auth = req.headers.authorization || "";
    calls.push({ method: msg.method, tool: msg.params?.name || "", auth });
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "nanoecho", version: "1.0.0" } };
    else if (msg.method === "tools/list") result = { tools: TOOLS };
    else if (msg.method === "tools/call") {
      const text = msg.params?.name === "whoami" ? `caller: ${whose(auth)}` : msg.params?.name === "search" ? "nano-search-result" : "note sent";
      result = { content: [{ type: "text", text }] };
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "nano" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});

// ── the owner's API ─────────────────────────────────────────────────────────

async function api(method, p, cookie, body) {
  const res = await fetch(`${DASHBOARD}${p}`, {
    method,
    headers: { ...(cookie ? { cookie: `clawbox_session=${cookie}` } : {}), origin: DASHBOARD, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const openclawConfig = () => JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
const openclaw = (...args) => execFileSync(path.join(HOME, ".npm-global", "bin", "openclaw"), args, { encoding: "utf-8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });

/** The relay entry names of one member's agent, from its allow-list. */
function grantedEntries(config, username) {
  const entry = config.agents?.entries?.[policy.staffAgentId(username)];
  return (entry?.tools?.allow || []).filter((t) => t.startsWith("cbstaff-")).map((t) => t.replace(/__\*$/, ""));
}

// ── OpenClaw chat (the same socket the desktop opens) ───────────────────────

function chatSocket(url, headers, { owner = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const waiting = new Map();
    const listeners = new Set();
    let n = 0;
    let hello = null;
    const state = relay.createRelayState("");
    const token = owner ? relay.readGatewayToken(path.join(OPENCLAW_HOME, "openclaw.json")) : "";
    const identity = owner ? relay.loadOrCreateRelayIdentity(path.join(REPO, "data", ".gateway-user-relay-device.json")) : null;
    const timer = setTimeout(() => reject(new Error("no hello within 30 s")), 30_000);
    const sock = {
      hello: () => hello,
      request(method, params, timeoutMs = 60_000) {
        const id = `r${++n}`;
        return new Promise((res) => {
          const t = setTimeout(() => { waiting.delete(id); res({ ok: false, error: { message: "timeout" } }); }, timeoutMs);
          waiting.set(id, (frame) => { clearTimeout(t); res(frame); });
          ws.send(JSON.stringify({ type: "req", id, method, params }));
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { try { ws.close(); } catch { /* gone */ } },
    };
    ws.on("error", (err) => reject(err));
    ws.on("message", (raw) => {
      let f;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.type === "event" && f.event === "connect.challenge") {
        state.challenge = f.payload;
        const frame = owner
          ? relay.buildRelayConnect(state, { id: "c", params: {} }, { token, identity, scopes: relay.RESET_SCOPES })
          : { type: "req", id: "c", method: "connect", params: { auth: { token: "" } } };
        ws.send(JSON.stringify(frame));
        return;
      }
      if (f.type === "res" && f.id === "c") {
        clearTimeout(timer);
        if (!f.ok) { reject(new Error(`connect refused: ${JSON.stringify(f.error)}`)); return; }
        hello = f.payload;
        resolve(sock);
        return;
      }
      if (f.type === "res" && waiting.has(f.id)) { waiting.get(f.id)(f); waiting.delete(f.id); return; }
      if (f.type === "event") for (const fn of listeners) fn(f);
    });
  });
}

/** One turn: the tools that ran (with their results) and the final text. */
async function turn(sock, key, text) {
  const tools = [];
  let finalText = "";
  let completed = false;
  let runId = null;
  let done;
  const finished = new Promise((r) => { done = r; });
  const off = sock.on((f) => {
    const p = f.payload || {};
    if (String(p.sessionKey || "").toLowerCase() !== key.toLowerCase()) return;
    if (runId && p.runId && p.runId !== runId) return;
    if (f.event === "agent" && p.stream === "tool" && p.data && typeof p.data.name === "string") {
      if (p.data.phase === "start") tools.push({ name: p.data.name, result: "" });
      else {
        const t = [...tools].reverse().find((x) => x.name === p.data.name);
        if (t) t.result = JSON.stringify(p.data.result ?? p.data.partialResult ?? p.data.error ?? "").slice(0, 300);
      }
    }
    if (f.event === "chat" && p.state === "final") {
      const blocks = Array.isArray(p.message?.content) ? p.message.content : [];
      finalText = blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join(" ");
      completed = true;
      done();
    }
    if (f.event === "chat" && (p.state === "error" || p.state === "aborted")) { finalText = `[${p.state}] ${p.errorMessage || ""}`; done(); }
  });
  const sent = await sock.request("chat.send", { sessionKey: key, message: text, deliver: false, idempotencyKey: `${MARK}-${randomUUID()}` });
  if (!sent.ok) { off(); return { refused: sent.error, tools, text: "" }; }
  runId = typeof sent.payload?.runId === "string" ? sent.payload.runId : null;
  await Promise.race([finished, new Promise((r) => setTimeout(r, TURN_MS))]);
  off();
  // `completed`: the turn ended with a final answer — not an error, an abort
  // or the deadline, after which "no tool ran" would prove nothing.
  return { tools, text: finalText, completed };
}

const ASK = `Call the ${SERVER} whoami tool right now (it is one of your tools; use tool search if you need to find it) and tell me exactly what it returned. If you have no such tool, say so.`;

function show(who, t) {
  note(`[${RUNTIME}] ${who} tools: ${t.tools.map((x) => `${x.name}${x.result ? ` → ${x.result}` : ""}`).join(" | ") || "(none)"}`);
  note(`[${RUNTIME}] ${who} assistant: ${t.refused ? `REFUSED: ${t.refused.message}` : String(t.text).replace(new RegExp(`${CRED_A}|${CRED_B}|${OWNER_TOKEN}`, "g"), "<credential>")}`);
}

const whoamiCalls = (since) => calls.slice(since).filter((c) => c.method === "tools/call" && c.tool === "whoami");

async function relayCall(token, message) {
  const res = await fetch(`${DASHBOARD}/setup-api/staff-mcp/${SERVER}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(message),
  });
  let json = {};
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

async function openclawRun(port) {
  const url = `http://127.0.0.1:${port}/mcp`;
  // 1. The owner's own server, with the owner's own header.
  openclaw("config", "set", `mcp.servers.${SERVER}`, JSON.stringify({ url, transport: "streamable-http", headers: { Authorization: `Bearer ${OWNER_TOKEN}` } }), "--json");
  const grant = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: { [SERVER]: {} } });
  check(grant.status === 200, "the owner grants the MCP server to members of staff", `${grant.status} ${grant.json.code || ""}`);
  const denied = await api("POST", "/setup-api/settings/staff-mcp", A_COOKIE, { servers: { [SERVER]: {} } });
  check(denied.status === 403, "a member of staff cannot change the grants (403)", `${denied.status}`);
  const unknown = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: { "no-such-server": {} } });
  check(unknown.status === 400, "an unknown server name is refused (400)", `${unknown.status} ${unknown.json.code || ""}`);
  const setA = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { username: A_NAME, server: SERVER, credential: CRED_A });
  const aRow = (setA.json.users || []).find((u) => u.username === A_NAME);
  check(setA.status === 200 && !setA.text.includes(CRED_A) && /^••••/.test(aRow?.credentials?.[SERVER] || ""),
    "the owner sets A's credential and is answered it masked only", `${setA.status}`);
  const storeFile = path.join(REPO, "data", "staff-mcp.json");
  check(fs.existsSync(storeFile) && (fs.statSync(storeFile).mode & 0o777) === 0o600, "the credentials are stored 0600");
  // Let the members' chats re-read their agents (the desktop asks ws-config first).
  for (const c of [A_COOKIE, B_COOKIE]) await api("GET", "/setup-api/gateway/ws-config", c);

  let config = openclawConfig();
  const aEntries = grantedEntries(config, A_NAME);
  check(aEntries.length === 1 && config.mcp?.servers?.[aEntries[0]], "A's agent gets a relay entry of its own", JSON.stringify(aEntries));
  check(grantedEntries(config, B_NAME).length === 0, "B (no credential) gets no entry for the server");
  check(!JSON.stringify(config).includes(CRED_A), "A's credential is nowhere in openclaw.json");
  const ownerAgent = config.agents?.defaults?.systemAgent?.agentId || "main";
  check((config.agents?.entries?.[ownerAgent]?.tools?.deny || []).includes("cbstaff-*"), "the owner's agent is denied the members' relay entries");
  const grantsFile = path.join(OPENCLAW_HOME, "extensions", "clawbox-staff-guard", "staff-mcp-grants.json");
  const grants = fs.existsSync(grantsFile) ? JSON.parse(fs.readFileSync(grantsFile, "utf-8")) : {};
  check(JSON.stringify(grants.agents?.[policy.staffAgentId(A_NAME)] || []) === JSON.stringify(aEntries), "the staff guard's grants name A's entry for A's agent only");

  // 5. The relay itself.
  const aToken = String(config.mcp?.servers?.[aEntries[0]]?.headers?.Authorization || "").replace(/^Bearer /, "");
  const before = calls.length;
  check((await relayCall(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status === 401, "the relay answers 401 without a member's token");
  const listed = await relayCall(aToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (listed.json.result?.tools || []).map((t) => t.name).sort();
  check(listed.status === 200 && names.join(",") === "search,whoami", "the relay hands A the tool list without the sender", names.join(","));
  const send = await relayCall(aToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_note", arguments: { to: "x" } } });
  check(send.json.error && !calls.slice(before).some((c) => c.tool === "send_note"), "send_note is refused before it reaches the server");

  const userHeaders = (cookie) => ({ cookie: `clawbox_session=${cookie}`, origin: DASHBOARD });
  // 2. A and B ask.
  const a = await chatSocket("ws://127.0.0.1/user-chat-ws", userHeaders(A_COOKIE));
  let b = await chatSocket("ws://127.0.0.1/user-chat-ws", userHeaders(B_COOKIE));
  const aMain = a.hello()?.snapshot?.sessionDefaults?.mainSessionKey;
  const bMain = b.hello()?.snapshot?.sessionDefaults?.mainSessionKey;
  let since = calls.length;
  const ta = await turn(a, aMain, ASK);
  show("staff A", ta);
  const aCalls = whoamiCalls(since);
  note(`[${RUNTIME}] the server saw for A's turn: ${aCalls.map((c) => whose(c.auth)).join(", ") || "(nothing)"}`);
  check(ta.completed === true && aCalls.length > 0 && aCalls.every((c) => c.auth === `Bearer ${CRED_A}`), "A's assistant calls the server with A's own credential (and the turn completed)");
  since = calls.length;
  const tb = await turn(b, bMain, ASK);
  show("staff B (no credential)", tb);
  check(tb.completed === true, "B's turn without a credential completed (so the next check means something)", tb.refused ? tb.refused.message : tb.text.slice(0, 200));
  check(tb.completed === true && whoamiCalls(since).length === 0 && !tb.tools.some((t) => t.name.startsWith("cbstaff-")), "B, without a credential, gets no tool from the server");

  // 3. B gets a credential of their own.
  const setB = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { username: B_NAME, server: SERVER, credential: CRED_B });
  check(setB.status === 200 && !setB.text.includes(CRED_B), "the owner sets B's credential", `${setB.status}`);
  await api("GET", "/setup-api/gateway/ws-config", B_COOKIE);
  b.close();
  b = await chatSocket("ws://127.0.0.1/user-chat-ws", userHeaders(B_COOKIE));
  config = openclawConfig();
  const bEntries = grantedEntries(config, B_NAME);
  check(bEntries.length === 1 && bEntries[0] !== aEntries[0], "B gets an entry of their own, not A's", JSON.stringify(bEntries));
  // The gateway hot-reloads openclaw.json on its own clock; give it a moment,
  // then ask in a fresh conversation of B's (a tab), as a member would.
  await new Promise((r) => setTimeout(r, 20_000));
  const bTab = `agent:${policy.staffAgentId(B_NAME)}:clawbox-utab-${randomUUID().replace(/-/g, "").slice(0, 12)}-${B_NAME}`;
  since = calls.length;
  const tb2 = await turn(b, bTab, ASK);
  show("staff B (credential set)", tb2);
  const bCalls = whoamiCalls(since);
  note(`[${RUNTIME}] the server saw for B's turn: ${bCalls.map((c) => whose(c.auth)).join(", ") || "(nothing)"}`);
  check(tb2.completed === true && bCalls.length > 0 && bCalls.every((c) => c.auth === `Bearer ${CRED_B}`), "B's assistant calls the server with B's own credential, never A's (and the turn completed)");

  // 4. The owner.
  const owner = await chatSocket(`ws://127.0.0.1:${GATEWAY_PORT}/`, { origin: "http://127.0.0.1", host: `127.0.0.1:${GATEWAY_PORT}` }, { owner: true });
  const ownerKey = `agent:${ownerAgent}:nano-ci-owner-${MARK}-mcp`;
  since = calls.length;
  const to = await turn(owner, ownerKey, ASK);
  show("owner", to);
  const oCalls = whoamiCalls(since);
  note(`[${RUNTIME}] the server saw for the owner's turn: ${oCalls.map((c) => whose(c.auth)).join(", ") || "(nothing)"}`);
  check(to.completed === true && oCalls.length > 0 && oCalls.every((c) => c.auth === `Bearer ${OWNER_TOKEN}`) && !to.tools.some((t) => t.name.startsWith("cbstaff-")),
    "the owner's assistant uses its own server entry with the owner's header — never a member's");
  await owner.request("sessions.delete", { key: ownerKey, deleteTranscript: true });
  a.close(); b.close(); owner.close();

  // A cannot read the grants.
  const peek = await api("GET", "/setup-api/settings/staff-mcp", A_COOKIE);
  check(peek.status === 403 && !peek.text.includes(CRED_A), "a member of staff cannot read the grants or any credential");
}

/** One Hermes turn of a member's (the chat route, as the desktop posts it). */
async function hermesTurn(cookie, text) {
  const r = await fetch(`${DASHBOARD}/setup-api/hermes/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: `clawbox_session=${cookie}`, origin: DASHBOARD },
    body: JSON.stringify({ message: text }),
    signal: AbortSignal.timeout(TURN_MS + 60_000),
  });
  let json = {};
  try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, text: typeof json.text === "string" ? json.text : "", code: json.code || "" };
}

/** A member's Hermes profile's mcp_servers (TASK-2516: only their granted relay entries). */
function hermesEntries(username) {
  const file = path.join(HERMES_HOME, "profiles", policy.staffAgentId(username), "config.yaml");
  if (!fs.existsSync(file)) return {};
  const yaml = require("js-yaml");
  return (yaml.load(fs.readFileSync(file, "utf-8")) || {}).mcp_servers || {};
}

// Since TASK-2516 Hermes carries the same grant through each member's own
// profile: the owner's server in config.yaml (with the owner's header), A's
// credential travels for A, B without one gets nothing.
let hermesConfigBefore = null;
async function hermesRun(port) {
  const yaml = require("js-yaml");
  const configFile = path.join(HERMES_HOME, "config.yaml");
  hermesConfigBefore = fs.readFileSync(configFile, "utf-8");
  const doc = yaml.load(hermesConfigBefore) || {};
  doc.mcp_servers = { ...(doc.mcp_servers || {}), [SERVER]: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${OWNER_TOKEN}` } } };
  fs.writeFileSync(configFile, yaml.dump(doc, { noRefs: true, lineWidth: -1 }));
  const grant = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: { [SERVER]: {} } });
  check(grant.status === 200, "on Hermes the owner grants the MCP server to members of staff", `${grant.status} ${grant.json.code || ""}`);
  const setA = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { username: A_NAME, server: SERVER, credential: CRED_A });
  check(setA.status === 200 && !setA.text.includes(CRED_A), "the owner sets A's credential and is answered it masked only", `${setA.status}`);
  let since = calls.length;
  const ta = await hermesTurn(A_COOKIE, ASK);
  note(`[${RUNTIME}] staff A assistant: ${ta.text.replace(new RegExp(`${CRED_A}|${CRED_B}|${OWNER_TOKEN}`, "g"), "<credential>").slice(0, 400) || `HTTP ${ta.status} ${ta.code}`}`);
  const aCalls = whoamiCalls(since);
  note(`[${RUNTIME}] the server saw for A's turn: ${aCalls.map((c) => whose(c.auth)).join(", ") || "(nothing)"}`);
  const aEntries = Object.keys(hermesEntries(A_NAME));
  check(aEntries.length === 1 && aEntries[0].startsWith("cbstaff-") && !JSON.stringify(hermesEntries(A_NAME)).includes(CRED_A),
    "A's Hermes profile carries one relay entry of its own (and never A's credential)", aEntries.join(","));
  check(ta.status === 200 && aCalls.length > 0 && aCalls.every((c) => c.auth === `Bearer ${CRED_A}`), "A's assistant calls the server with A's own credential (and the turn completed)");
  since = calls.length;
  const tb = await hermesTurn(B_COOKIE, ASK);
  note(`[${RUNTIME}] staff B assistant: ${tb.text.slice(0, 300) || `HTTP ${tb.status} ${tb.code}`}`);
  check(tb.status === 200 && whoamiCalls(since).length === 0 && Object.keys(hermesEntries(B_NAME)).length === 0,
    "B, without a credential, gets no entry and no tool from the server");
}

async function main() {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = stub.address().port;
  try {
    if (RUNTIME === "openclaw") await openclawRun(port);
    else await hermesRun(port);
  } catch (err) {
    fail(`the staff MCP driver stopped: ${String(err?.message || err).split("\n")[0].slice(0, 300)}`);
  } finally {
    // The grant and the owner's test server go again.
    await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: {} }).catch(() => undefined);
    if (RUNTIME === "hermes" && hermesConfigBefore !== null) fs.writeFileSync(path.join(HERMES_HOME, "config.yaml"), hermesConfigBefore);
    if (RUNTIME === "openclaw") {
      try { openclaw("config", "unset", `mcp.servers.${SERVER}`); } catch { note(`[${RUNTIME}] could not remove the test server entry`); }
      const left = Object.keys(openclawConfig().mcp?.servers || {}).filter((n) => n.startsWith("cbstaff-") || n === SERVER);
      check(left.length === 0, "the grant withdrawn, no relay entry and no test server is left", left.join(","));
    }
    stub.close();
  }
}

await main();
process.exit(0);
