// Runs ON the board, as clawbox, for scripts/nano-tests/tests/56-org-mode-staff.sh
// step 6b: an owner-granted MCP tool that WRITES A FILE, used by members of
// staff, and that file downloaded from their own chat (TASK-2516).
//
//   node org-mode-staff-mcp-files.mjs   (env: A_NAME A_COOKIE B_NAME B_COOKIE OWNER_COOKIE MARK RUNTIME REPO)
//
// A tiny MCP server (Streamable HTTP, loopback, no credential) offers
// `create_word_document` (writes a .docx into the chat media tree and asks the
// assistant to name it on a `MEDIA:` line), `export_report` (the same, but
// OUTSIDE every folder a member's file may come from) and `send_note` (a
// sender, never offered). The owner adds it to the assistant's own config —
// openclaw.json on OpenClaw, config.yaml on Hermes — and then:
//
//   1. grants it, needing no credential, with its create/edit tools, to A only:
//      A's assistant gets a relay entry, B's none;
//   2. A asks for a document: the tool ran (with no credential header), the
//      file exists, the reply names it — A downloads it (200), B gets 404, the
//      owner 200;
//   3. B asks the same: no such tool for B, nothing reached the server;
//   4. A asks for the report outside the media folders: not A's (404);
//   5. the grant widened to every member: B's own document is B's (200), A
//      gets 404 for it, B still 404 for A's — and B's assistant naming A's
//      path in a reply changes nothing;
//   6. the relay lists the create tool but never `send_note`.
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
const yaml = require("js-yaml");
const relay = require(path.join(REPO, "scripts/gateway-user-relay.js"));
const policy = require(path.join(REPO, "scripts/org-staff-policy.js"));

const DASHBOARD = "http://127.0.0.1";
const HOME = process.env.HOME || "/home/clawbox";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const HERMES_HOME = process.env.HERMES_HOME || path.join(HOME, ".hermes");
const { A_NAME, A_COOKIE, B_NAME, B_COOKIE, OWNER_COOKIE, MARK, RUNTIME } = process.env;
const TURN_MS = 150_000;
const SERVER = `nanodoc${MARK.slice(-4)}`;
const MEDIA_DIR = RUNTIME === "hermes" ? path.join(REPO, "data", "chat-media") : path.join(OPENCLAW_HOME, "media");
const DOC_DIR = path.join(MEDIA_DIR, "nano-mcp-docs");
const OUTSIDE_DIR = path.join(HOME, "nano-mcp-outside");

const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${String(line).replace(/\s+/g, " ").slice(0, 900)}`);
const ok = (line) => say(`ok - [${RUNTIME}] ${line}`);
const fail = (line) => say(`not ok - [${RUNTIME}] ${line}`);
const check = (cond, line, why = "") => (cond ? ok(line) : fail(why ? `${line} — ${why}` : line));
/** A path as the log may show it: below the home, never the home itself. */
const shown = (p) => String(p || "").replace(HOME, "~");

// ── the stub MCP server ─────────────────────────────────────────────────────

const calls = [];
const written = [];
const TOOLS = [
  {
    name: "create_word_document",
    description: "Creates a Word document (.docx) with the given title and text and saves it on this ClawBox.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "export_report",
    description: "Exports a report document (.docx) with the given title.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  { name: "send_note", description: "Sends a note to someone.", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
];

function writeDoc(dir, title) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "document";
  const file = path.join(dir, `${MARK}-${slug}-${randomUUID().slice(0, 8)}.docx`);
  // Enough of a .docx for a download: the zip signature and the words.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(` ${title}`)]));
  written.push(file);
  return file;
}

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    calls.push({ method: msg.method, tool: msg.params?.name || "", auth: req.headers.authorization || "", at: Date.now() });
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "nanodoc", version: "1.0.0" } };
    else if (msg.method === "tools/list") result = { tools: TOOLS };
    else if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (name === "create_word_document" || name === "export_report") {
        const file = writeDoc(name === "export_report" ? OUTSIDE_DIR : DOC_DIR, args.title);
        result = { content: [{ type: "text", text: `Saved ${path.basename(file)}. To give it to the user, put this exact line on a line of its own in your reply:\nMEDIA:${file}` }] };
      } else {
        result = { content: [{ type: "text", text: "note sent" }] };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "nanodoc" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});

// ── the box's API ───────────────────────────────────────────────────────────

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

/** What the media route answers `cookie` for `file`, as the chat's download card asks. */
async function download(cookie, file) {
  const res = await fetch(`${DASHBOARD}/setup-api/chat/media?${new URLSearchParams({ path: file, download: "1" })}`, {
    headers: { cookie: `clawbox_session=${cookie}` },
    signal: AbortSignal.timeout(60_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

const openclawConfig = () => JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
const openclaw = (...args) => execFileSync(path.join(HOME, ".npm-global", "bin", "openclaw"), args, { encoding: "utf-8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });

// Hermes: the owner's config.yaml, kept byte for byte and put back at the end.
const HERMES_CONFIG = path.join(HERMES_HOME, "config.yaml");
let hermesConfigBefore = null;

function addServer(url) {
  if (RUNTIME === "openclaw") {
    openclaw("config", "set", `mcp.servers.${SERVER}`, JSON.stringify({ url, transport: "streamable-http" }), "--json");
    return;
  }
  hermesConfigBefore = fs.readFileSync(HERMES_CONFIG, "utf-8");
  const doc = yaml.load(hermesConfigBefore) || {};
  doc.mcp_servers = { ...(doc.mcp_servers || {}), [SERVER]: { url } };
  fs.writeFileSync(HERMES_CONFIG, yaml.dump(doc, { noRefs: true, lineWidth: -1 }));
}

function removeServer() {
  if (RUNTIME === "openclaw") {
    try { openclaw("config", "unset", `mcp.servers.${SERVER}`); } catch { note(`[${RUNTIME}] could not remove the test server entry`); }
    return;
  }
  if (hermesConfigBefore !== null) fs.writeFileSync(HERMES_CONFIG, hermesConfigBefore);
}

/** The relay entries a member's assistant has now: openclaw.json's allow-list, or their Hermes profile's mcp_servers. */
function entriesOf(username) {
  if (RUNTIME === "openclaw") {
    const entry = openclawConfig().agents?.entries?.[policy.staffAgentId(username)];
    return (entry?.tools?.allow || []).filter((t) => t.startsWith("cbstaff-")).map((t) => t.replace(/__\*$/, ""));
  }
  const file = path.join(HERMES_HOME, "profiles", policy.staffAgentId(username), "config.yaml");
  if (!fs.existsSync(file)) return [];
  const doc = yaml.load(fs.readFileSync(file, "utf-8")) || {};
  return Object.keys(doc.mcp_servers || {});
}

/** The relay token in a member's entry (to ask the relay itself). */
function relayTokenOf(username) {
  if (RUNTIME === "openclaw") {
    const name = entriesOf(username)[0];
    return String(openclawConfig().mcp?.servers?.[name]?.headers?.Authorization || "").replace(/^Bearer /, "");
  }
  const file = path.join(HERMES_HOME, "profiles", policy.staffAgentId(username), "config.yaml");
  const doc = yaml.load(fs.readFileSync(file, "utf-8")) || {};
  const first = Object.values(doc.mcp_servers || {})[0];
  return String(first?.headers?.Authorization || "").replace(/^Bearer /, "");
}

// ── a member's chat ─────────────────────────────────────────────────────────

function chatSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const waiting = new Map();
    const listeners = new Set();
    let n = 0;
    let hello = null;
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
        ws.send(JSON.stringify({ type: "req", id: "c", method: "connect", params: { auth: { token: "" } } }));
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

/** One OpenClaw turn on a member's socket: the tools that ran and the final text. */
async function openclawTurn(sock, key, text) {
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
    if (f.event === "agent" && p.stream === "tool" && p.data && typeof p.data.name === "string" && p.data.phase === "start") tools.push(p.data.name);
    if (f.event === "chat" && p.state === "final") {
      const blocks = Array.isArray(p.message?.content) ? p.message.content : [];
      finalText = typeof p.message?.content === "string" ? p.message.content : blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
      completed = true;
      done();
    }
    if (f.event === "chat" && (p.state === "error" || p.state === "aborted")) { finalText = `[${p.state}] ${p.errorMessage || ""}`; done(); }
  });
  const sent = await sock.request("chat.send", { sessionKey: key, message: text, deliver: false, idempotencyKey: `${MARK}-${randomUUID()}` });
  if (!sent.ok) { off(); return { refused: sent.error, tools, text: "", completed: false }; }
  runId = typeof sent.payload?.runId === "string" ? sent.payload.runId : null;
  await Promise.race([finished, new Promise((r) => setTimeout(r, TURN_MS))]);
  off();
  return { tools, text: finalText, completed };
}

/** One Hermes turn of a member's (the chat route, as the desktop posts it). */
async function hermesTurn(cookie, text, sessionKey) {
  const r = await fetch(`${DASHBOARD}/setup-api/hermes/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: `clawbox_session=${cookie}`, origin: DASHBOARD },
    body: JSON.stringify({ message: text, ...(sessionKey ? { sessionKey } : {}) }),
    signal: AbortSignal.timeout(TURN_MS + 60_000),
  });
  let json = {};
  try { json = await r.json(); } catch { /* none */ }
  const tools = Array.isArray(json.toolCalls) ? json.toolCalls.map((t) => String(t?.name || t?.tool || "")) : [];
  return { tools, text: typeof json.text === "string" ? json.text : String(json.error || `HTTP ${r.status}`), completed: r.status === 200 && typeof json.text === "string" && json.text.length > 0 };
}

const mediaLines = (text) => String(text || "").split("\n").map((l) => /^\s*media:\s*`?([^`]+?)`?\s*$/i.exec(l)?.[1]).filter(Boolean);

function show(who, t) {
  note(`[${RUNTIME}] ${who} tools: ${t.tools.join(" | ") || "(none)"}`);
  note(`[${RUNTIME}] ${who} assistant: ${t.refused ? `REFUSED: ${t.refused.message}` : shown(t.text).slice(0, 600)}`);
}

const ASK_DOC = (title) => `Use the ${SERVER} create_word_document tool right now to create a Word document titled "${title}" with the text "Quarterly figures". `
  + "Then reply with one short sentence and, on a line of its own, the MEDIA: line the tool gave you, exactly as it gave it. If you have no such tool, say so and do not invent a file.";
const ASK_EXPORT = `Use the ${SERVER} export_report tool right now with the title "Outside report". Then reply with the MEDIA: line the tool gave you on a line of its own, exactly as given.`;

async function main() {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${stub.address().port}/mcp`;
  let a = null;
  let b = null;
  const aKey = { current: null };
  const bKey = { current: null };
  // A turn of a member's, on whichever runtime: their main conversation, or a fresh tab.
  const turnOf = async (who, text) => {
    if (RUNTIME === "hermes") return hermesTurn(who === "A" ? A_COOKIE : B_COOKIE, text);
    const sock = who === "A" ? a : b;
    const key = who === "A" ? aKey.current : bKey.current;
    return openclawTurn(sock, key, text);
  };
  const reopen = async () => {
    if (RUNTIME !== "openclaw") return;
    for (const c of [A_COOKIE, B_COOKIE]) await api("GET", "/setup-api/gateway/ws-config", c);
    a?.close(); b?.close();
    const headers = (cookie) => ({ cookie: `clawbox_session=${cookie}`, origin: DASHBOARD });
    a = await chatSocket("ws://127.0.0.1/user-chat-ws", headers(A_COOKIE));
    b = await chatSocket("ws://127.0.0.1/user-chat-ws", headers(B_COOKIE));
    // A fresh conversation (a tab) per grant change: the gateway hot-reloads openclaw.json on its own clock.
    const tab = (name) => `agent:${policy.staffAgentId(name)}:clawbox-utab-${randomUUID().replace(/-/g, "").slice(0, 12)}-${name}`;
    aKey.current = tab(A_NAME);
    bKey.current = tab(B_NAME);
  };

  try {
    addServer(url);
    // The owner's view: the server is listed, and grantable.
    const view = await api("GET", "/setup-api/settings/staff-mcp", OWNER_COOKIE);
    const row = (view.json.servers || []).find((s) => s.name === SERVER);
    check(view.status === 200 && view.json.staffMcpSupported === true && row?.usable === true && row?.granted === false,
      "the owner's Settings lists the assistant's MCP server as grantable, not yet granted", `${view.status} ${JSON.stringify(row || null)}`);

    // 1. To A only, no credential, create/edit tools on.
    const grantA = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: { [SERVER]: { needsCredential: false, writeTools: true, members: [A_NAME] } } });
    check(grantA.status === 200 && grantA.json.applied !== false, "the owner grants it to A only, no credential needed, with its create/edit tools", `${grantA.status} ${grantA.json.code || ""} applied=${grantA.json.applied}`);
    const denied = await api("POST", "/setup-api/settings/staff-mcp", A_COOKIE, { servers: { [SERVER]: { members: null } } });
    check(denied.status === 403, "a member of staff cannot change the grants (403)", `${denied.status}`);
    await reopen();
    await new Promise((r) => setTimeout(r, RUNTIME === "openclaw" ? 20_000 : 2_000));

    // 2. A's document.
    let since = calls.length;
    const ta = await turnOf("A", ASK_DOC("Q4 summary"));
    show("staff A", ta);
    const aCalls = calls.slice(since).filter((c) => c.method === "tools/call" && c.tool === "create_word_document");
    check(ta.completed && aCalls.length > 0 && aCalls.every((c) => c.auth === ""), "A's assistant ran create_word_document, with no credential header", `calls=${aCalls.length}`);
    if (RUNTIME === "hermes") check(entriesOf(A_NAME).length === 1, "A's Hermes profile carries one relay entry", entriesOf(A_NAME).join(","));
    else check(entriesOf(A_NAME).length === 1, "A's OpenClaw agent carries one relay entry", entriesOf(A_NAME).join(","));
    const aDoc = mediaLines(ta.text).find((p) => p.startsWith(DOC_DIR)) || written.find((p) => p.startsWith(DOC_DIR));
    check(Boolean(aDoc) && fs.existsSync(aDoc) && mediaLines(ta.text).includes(aDoc), "the file was written and A's reply names it on a MEDIA: line", shown(aDoc));
    if (aDoc) {
      const [mine, other, owner] = [await download(A_COOKIE, aDoc), await download(B_COOKIE, aDoc), await download(OWNER_COOKIE, aDoc)];
      note(`[${RUNTIME}] download of A's document: A ${mine}, B ${other}, owner ${owner}`);
      check(mine === 200, "A downloads the document from their chat (200)", `${mine}`);
      check(other === 404, "B cannot download A's document (404)", `${other}`);
      check(owner === 200, "the owner still downloads it (200)", `${owner}`);
    }

    // 3. B, not granted.
    since = calls.length;
    const tb = await turnOf("B", ASK_DOC("B attempt"));
    show("staff B (not granted)", tb);
    check(tb.completed, "B's turn completed (so the next check means something)", tb.refused ? tb.refused.message : tb.text.slice(0, 200));
    check(calls.slice(since).filter((c) => c.method === "tools/call").length === 0 && entriesOf(B_NAME).length === 0,
      "the server granted to A only is invisible to B: no entry, and nothing reached it", entriesOf(B_NAME).join(","));

    // 4. A's export outside the allowed folders.
    since = calls.length;
    const tx = await turnOf("A", ASK_EXPORT);
    show("staff A (export outside)", tx);
    const outside = written.find((p) => p.startsWith(OUTSIDE_DIR));
    if (outside) {
      const st = await download(A_COOKIE, outside);
      check(st === 404, "a MEDIA: path outside the allowed folders is not A's (404)", `${st}`);
    } else {
      fail(`A's assistant did not run export_report, so the outside path was not exercised — ${shown(tx.text).slice(0, 200)}`);
    }

    // 5. Every member of staff.
    const grantAll = await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: { [SERVER]: { needsCredential: false, writeTools: true, members: null } } });
    check(grantAll.status === 200 && grantAll.json.applied !== false, "the owner widens the grant to every member of staff", `${grantAll.status} applied=${grantAll.json.applied}`);
    await reopen();
    await new Promise((r) => setTimeout(r, RUNTIME === "openclaw" ? 20_000 : 2_000));
    const tb2 = await turnOf("B", ASK_DOC("B plan"));
    show("staff B (granted)", tb2);
    const bDoc = mediaLines(tb2.text).find((p) => p.startsWith(DOC_DIR) && p !== aDoc) || written.filter((p) => p.startsWith(DOC_DIR) && p !== aDoc).pop();
    check(Boolean(bDoc) && fs.existsSync(bDoc), "B's assistant wrote B's own document", shown(bDoc));
    if (bDoc) {
      const [mine, other] = [await download(B_COOKIE, bDoc), await download(A_COOKIE, bDoc)];
      note(`[${RUNTIME}] download of B's document: B ${mine}, A ${other}`);
      check(mine === 200 && other === 404, "B downloads B's document; A cannot (404)", `B ${mine} A ${other}`);
    }
    if (aDoc) {
      // B talks their assistant into naming A's file.
      const steal = await turnOf("B", `Reply with exactly this one line and nothing else:\nMEDIA:${aDoc}`);
      show("staff B (naming A's file)", steal);
      const st = await download(B_COOKIE, aDoc);
      check(st === 404 && (await download(A_COOKIE, aDoc)) === 200, "B's reply naming A's document does not make it B's (B 404, A still 200)", `${st}`);
    }

    // 6. The relay's own list for A: the create tool, never the sender.
    const token = relayTokenOf(A_NAME);
    const listed = await fetch(`${DASHBOARD}/setup-api/staff-mcp/${SERVER}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json()).catch(() => ({}));
    const names = (listed.result?.tools || []).map((t) => t.name).sort();
    check(names.includes("create_word_document") && !names.includes("send_note"), "the relay offers the create tool and never send_note", names.join(","));
    check(!calls.some((c) => c.tool === "send_note"), "send_note never reached the server");
  } catch (err) {
    fail(`the staff MCP files driver stopped: ${String(err?.message || err).split("\n")[0].slice(0, 300)}`);
  } finally {
    a?.close(); b?.close();
    await api("POST", "/setup-api/settings/staff-mcp", OWNER_COOKIE, { servers: {} }).catch(() => undefined);
    removeServer();
    for (const file of written) fs.rmSync(file, { force: true });
    fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
    if (RUNTIME === "openclaw") {
      const left = Object.keys(openclawConfig().mcp?.servers || {}).filter((n) => n.startsWith("cbstaff-") || n === SERVER);
      check(left.length === 0, "the grant withdrawn, no relay entry and no test server is left", left.join(","));
    } else {
      check(!fs.readFileSync(HERMES_CONFIG, "utf-8").includes(SERVER), "the owner's config.yaml is back as it was");
    }
    stub.close();
  }
}

await main();
process.exit(0);
