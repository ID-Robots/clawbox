#!/usr/bin/env node
// The ClawBox stress run, ON THE BOARD (TASK-2500). Shipped and started by
// scripts/nano-stress/run.sh; see docs/nano-stress-test.md.
//
// It drives the box's own chat the way the desktop does — OpenClaw through the
// gateway's WebSocket (`chat.send` + its `chat`/`agent` events), Hermes
// through POST /setup-api/hermes/chat streamed — in sessions of its own, and
// samples the box while it does:
//
//   idle      30 s with nothing sent: the baseline
//   ramp-N    N chats at once (1, 2, 4, 8), each RAMP_TURNS turns in a row
//   long      ONE session, LONG_TURNS turns (30+), with recall questions
//   tool      ONE session whose every turn needs a tool (shell, file write/read)
//
// Every 2 s: MemAvailable, swap used, CPU busy %, load, the hottest thermal
// zone, and the resident memory of the runtime's unit (clawbox-gateway on
// OpenClaw, clawbox-hermes-dashboard on Hermes) and of the web server
// (clawbox-setup). At each step's edges: each unit's MainPID and NRestarts, and
// the kernel's oom_kill counter.
//
// It writes RAW records (every turn, every sample) to --out; run.sh hands them
// to report.mjs, which turns them into the JSON and markdown summary. Nothing
// here leaves the board: the owner session it signs and the gateway token it
// reads stay in this process. No reply text is kept for a turn that passed.
//
// Usage (on the board, as the box user):
//   node board-stress.mjs --out /tmp/x/raw.json [--runtime auto|openclaw|hermes]
//     [--ramp 1,2,4,8] [--ramp-turns 3] [--long-turns 32] [--tool-turns 8]
//     [--steps idle,ramp,long,tool] [--turn-timeout 240] [--settle 20]
//     [--sample-ms 2000] [--idle 30] [--work-dir /tmp/x/work]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = process.env.CLAWBOX_REPO || "/home/clawbox/clawbox";
const DASH = process.env.CLAWBOX_DASHBOARD || "http://127.0.0.1";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 18789);
const VERSION = 1;

// ---- options ----------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${name} needs a value`);
  return v;
}
const intList = (s) => String(s).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
const OUT = opt("--out", "");
if (!OUT) {
  console.error("usage: node board-stress.mjs --out <raw.json> [options]");
  process.exit(2);
}
const RUN_ID = crypto.randomBytes(4).toString("hex");
const cfg = {
  runtime: opt("--runtime", "auto"),
  ramp: intList(opt("--ramp", "1,2,4,8")),
  rampTurns: Number(opt("--ramp-turns", 3)),
  longTurns: Number(opt("--long-turns", 32)),
  toolTurns: Math.min(8, Number(opt("--tool-turns", 8))),
  steps: opt("--steps", "idle,ramp,long,tool").split(",").map((s) => s.trim()).filter(Boolean),
  turnTimeoutS: Number(opt("--turn-timeout", 240)),
  settleS: Number(opt("--settle", 20)),
  sampleMs: Number(opt("--sample-ms", 2000)),
  idleS: Number(opt("--idle", 30)),
  workDir: opt("--work-dir", path.join(path.dirname(OUT), "work")),
  runId: RUN_ID,
};
for (const k of ["rampTurns", "longTurns", "toolTurns", "turnTimeoutS", "sampleMs"]) {
  if (!Number.isInteger(cfg[k]) || cfg[k] < 1) { console.error(`board-stress: ${k} must be a whole number above 0`); process.exit(2); }
}
for (const k of ["settleS", "idleS"]) {
  if (!Number.isFinite(cfg[k]) || cfg[k] < 0) { console.error(`board-stress: ${k} must be 0 or more`); process.exit(2); }
}
if (cfg.ramp.length === 0) { console.error("board-stress: --ramp wants a list like 1,2,4,8"); process.exit(2); }
const T0 = Date.now();
const rel = () => Date.now() - T0;
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`);

// ---- the owner's session, signed here (as scripts/nano-tests/lib.sh) ---------
function ownerCookie() {
  const secret = fs.readFileSync(path.join(REPO, "data/.session-secret"), "utf8").trim();
  let gen = 0;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(REPO, "data/config.json"), "utf8"));
    if (Number.isFinite(c.session_generation)) gen = c.session_generation;
  } catch { /* no config yet: generation 0 */ }
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1200, gen })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
function ownerHeaders(extra = {}) {
  return { Cookie: `clawbox_session=${ownerCookie()}`, Origin: "http://127.0.0.1", ...extra };
}
async function ownerJson(method, p, body, timeoutMs = 20_000) {
  const res = await fetch(DASH + p, {
    method,
    headers: ownerHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

// ---- box state ----------------------------------------------------------------
function readMeminfo() {
  const out = {};
  for (const line of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}
function readTemps() {
  let max = null, cpu = null, tj = null;
  let zones = [];
  try { zones = fs.readdirSync("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone")); } catch { /* none */ }
  for (const z of zones) {
    try {
      const type = fs.readFileSync(`/sys/class/thermal/${z}/type`, "utf8").trim();
      const c = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, "utf8").trim()) / 1000;
      // Some Jetson zones (cv*) answer EAGAIN while their engine is off; others
      // report a -40 / 100+ placeholder when unpowered.
      if (!Number.isFinite(c) || c < -20 || c > 150) continue;
      if (max === null || c > max) max = c;
      if (type === "cpu-thermal") cpu = c;
      if (type === "tj-thermal") tj = c;
    } catch { /* zone unreadable right now */ }
  }
  return { max, cpu, tj };
}
let prevCpu = null;
function readCpuBusy() {
  const f = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] || 0);
  const total = f.reduce((a, b) => a + b, 0);
  let busy = null;
  if (prevCpu && total > prevCpu.total) busy = 100 * (1 - (idle - prevCpu.idle) / (total - prevCpu.total));
  prevCpu = { idle, total };
  return busy;
}
const load1 = () => Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
function oomKills() {
  const m = /^oom_kill (\d+)/m.exec(fs.readFileSync("/proc/vmstat", "utf8"));
  return m ? Number(m[1]) : null;
}
function rssKbOf(pid) {
  try {
    const m = /^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
// Every process in a unit's cgroup (children included: a Hermes turn's CLI, an
// OpenClaw tool's shell), summed — what the unit holds, not just its MainPID.
function cgroupUsage(cg) {
  if (!cg) return { rssKb: null, procs: 0, memCurrentKb: null };
  const root = `/sys/fs/cgroup${cg}`;
  let rssKb = 0, procs = 0;
  const walk = (dir) => {
    let pids = [];
    try { pids = fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean); } catch { /* gone */ }
    for (const pid of pids) { rssKb += rssKbOf(pid); procs++; }
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
    for (const k of kids) walk(path.join(dir, k.name));
  };
  walk(root);
  let memCurrentKb = null;
  try { memCurrentKb = Math.round(Number(fs.readFileSync(path.join(root, "memory.current"), "utf8")) / 1024); } catch { /* no memory controller */ }
  return { rssKb, procs, memCurrentKb };
}
function systemctlShow(unit) {
  return new Promise((resolve) => {
    execFile("systemctl", ["show", unit, "-p", "MainPID", "-p", "NRestarts", "-p", "ActiveState", "-p", "ControlGroup"], { timeout: 10_000 }, (err, stdout) => {
      const out = { unit, mainPid: null, restarts: null, active: null, cgroup: null };
      if (err) return resolve(out);
      for (const line of String(stdout).split("\n")) {
        const [k, ...rest] = line.split("=");
        const v = rest.join("=");
        if (k === "MainPID") out.mainPid = Number(v) || null;
        if (k === "NRestarts") out.restarts = Number(v);
        if (k === "ActiveState") out.active = v;
        if (k === "ControlGroup") out.cgroup = v || null;
      }
      resolve(out);
    });
  });
}

// ---- the sampler ----------------------------------------------------------------
const samples = [];
const units = { gateway: null, web: "clawbox-setup" };
const cgroups = {};
async function refreshUnits() {
  const out = {};
  for (const [role, unit] of Object.entries(units)) {
    if (!unit) continue;
    out[role] = await systemctlShow(unit);
    if (out[role].cgroup) cgroups[role] = out[role].cgroup;
  }
  return out;
}
function takeSample() {
  const mi = readMeminfo();
  const t = readTemps();
  const s = {
    t: rel(),
    memAvailableKb: mi.MemAvailable ?? null,
    swapUsedKb: mi.SwapTotal != null && mi.SwapFree != null ? mi.SwapTotal - mi.SwapFree : null,
    cpuBusyPct: readCpuBusy(),
    load1: load1(),
    tempMaxC: t.max,
    tempCpuC: t.cpu,
    tempTjC: t.tj,
    selfRssKb: Math.round(process.memoryUsage().rss / 1024),
  };
  for (const role of Object.keys(units)) {
    const u = cgroupUsage(cgroups[role]);
    s[`${role}RssKb`] = u.rssKb;
    s[`${role}CgroupKb`] = u.memCurrentKb;
    s[`${role}Procs`] = u.procs;
  }
  samples.push(s);
  return s;
}
let samplerTimer = null;
let unitTimer = null;
function startSampler() {
  readCpuBusy();
  takeSample();
  samplerTimer = setInterval(() => { try { takeSample(); } catch (e) { log("sample failed:", e.message); } }, cfg.sampleMs);
  // A unit that restarted lands in a new cgroup path only in name; refresh it.
  unitTimer = setInterval(() => { refreshUnits().catch(() => {}); }, 15_000);
}
function stopSampler() {
  clearInterval(samplerTimer);
  clearInterval(unitTimer);
}

// ---- OpenClaw: the gateway's own socket ------------------------------------------
async function gatewayToken() {
  const r = await ownerJson("GET", "/setup-api/gateway/ws-config");
  const token = r.json && typeof r.json.token === "string" ? r.json.token : "";
  if (!token) throw new Error(`no gateway token from ws-config (HTTP ${r.status})`);
  return token;
}
class Gateway {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.listeners = new Set();
  }
  static open(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`);
      const g = new Gateway(ws);
      const connectId = crypto.randomUUID();
      let done = false, sent = false;
      const fail = (msg) => { if (!done) { done = true; try { ws.close(); } catch { /* closed */ } reject(new Error(msg)); } };
      const timer = setTimeout(() => fail("gateway handshake timeout"), 15_000);
      const connect = () => {
        if (sent) return;
        sent = true;
        ws.send(JSON.stringify({
          type: "req", id: connectId, method: "connect",
          params: {
            minProtocol: 4, maxProtocol: 4,
            client: { id: "cli", version: "clawbox-stress", platform: "linux", mode: "cli" },
            role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: ["tool-events"], commands: [], permissions: {}, auth: { token },
            locale: "en-US", userAgent: "clawbox-stress",
          },
        }));
      };
      ws.onopen = () => setTimeout(connect, 250);
      ws.onerror = () => fail("gateway socket error");
      ws.onclose = (e) => {
        fail(`gateway closed ${e.code}`);
        for (const [, p] of g.pending) { clearTimeout(p.t); p.reject(new Error("gateway closed")); }
        g.pending.clear();
        for (const l of [...g.listeners]) { try { l({ type: "closed" }); } catch { /* listener */ } }
      };
      ws.onmessage = (ev) => {
        let f;
        try { f = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
        if (f.type === "event" && f.event === "connect.challenge") { connect(); return; }
        if (f.type === "res" && f.id === connectId) {
          clearTimeout(timer);
          if (f.ok) { done = true; g.hello = f.payload || {}; resolve(g); } else fail(`connect refused: ${f.error?.message || ""}`);
          return;
        }
        if (f.type === "res" && g.pending.has(f.id)) {
          const p = g.pending.get(f.id);
          g.pending.delete(f.id);
          clearTimeout(p.t);
          if (f.ok) p.resolve(f.payload || {}); else p.reject(new Error(f.error?.message || "rpc error"));
          return;
        }
        if (f.type === "event") for (const l of [...g.listeners]) { try { l(f); } catch { /* listener */ } }
      };
    });
  }
  req(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) return reject(new Error("gateway socket not open"));
      const id = crypto.randomUUID();
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

function messageText(m) {
  if (!m) return "";
  const c = m.content;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
  return String(m.text || (typeof c === "string" ? c : "") || "");
}

async function openclawTurn(sess, message, timeoutMs) {
  const r = { ackMs: null, firstTokenMs: null, latencyMs: null, toolCalls: 0, text: "", error: null, model: null };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let runId = null;
  let resolveFinal;
  const final = new Promise((res) => { resolveFinal = res; });
  const toolIds = new Set();
  const l = (f) => {
    if (f.type === "closed") { r.error = r.error || { kind: "connection", message: "gateway socket closed mid-turn" }; resolveFinal(); return; }
    const p = f.payload || {};
    if (f.event === "chat") {
      if (p.sessionKey !== sess.key) return;
      if (runId && p.runId && p.runId !== runId) return;
      if (p.state === "delta") { if (r.firstTokenMs === null) r.firstTokenMs = ms(); }
      else if (p.state === "final" || p.state === "error" || p.state === "aborted") {
        r.latencyMs = ms();
        r.text = messageText(p.message);
        r.model = typeof p.message?.model === "string" ? p.message.model : null;
        if (p.state !== "final") r.error = { kind: p.state === "error" ? "agent-error" : "aborted", message: String(p.errorMessage || p.error || p.state).slice(0, 200) };
        resolveFinal();
      }
    } else if (f.event === "agent") {
      if (p.sessionKey && p.sessionKey !== sess.key) return;
      if (runId && p.runId && p.runId !== runId) return;
      const d = p.data || {};
      if (p.stream === "tool" && d.name) toolIds.add(d.toolCallId || d.id || `${d.name}:${toolIds.size}`);
    }
  };
  sess.gw.listeners.add(l);
  let timer;
  try {
    const ack = await sess.gw.req("chat.send", { sessionKey: sess.key, message, deliver: false, idempotencyKey: crypto.randomUUID() }, 60_000);
    r.ackMs = ms();
    runId = ack?.runId || null;
    const timedOut = await Promise.race([
      final.then(() => false),
      new Promise((res) => { timer = setTimeout(() => res(true), timeoutMs); }),
    ]);
    if (timedOut) {
      r.error = { kind: "timeout", message: `no final within ${Math.round(timeoutMs / 1000)} s` };
      await sess.gw.req("chat.abort", { sessionKey: sess.key, ...(runId ? { runId } : {}) }, 10_000).catch(() => {});
    }
  } catch (e) {
    r.error = r.error || { kind: /timeout/.test(e.message) ? "timeout" : "rpc", message: e.message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    sess.gw.listeners.delete(l);
  }
  r.toolCalls = toolIds.size;
  return r;
}

// ---- Hermes: the desktop chat's own route, streamed ---------------------------
async function hermesTurn(sess, message, timeoutMs) {
  const r = { ackMs: null, firstTokenMs: null, latencyMs: null, toolCalls: 0, text: "", error: null, model: null };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const turnId = crypto.randomBytes(8).toString("hex");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let toolEvents = 0;
  try {
    const res = await fetch(`${DASH}/setup-api/hermes/chat`, {
      method: "POST",
      headers: ownerHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify({ message, sessionKey: sess.key, turnId, ...(sess.sessionId ? { sessionId: sess.sessionId } : {}) }),
      signal: ac.signal,
    });
    r.ackMs = ms();
    const type = res.headers.get("content-type") || "";
    let done = null, error = null;
    if (!type.includes("text/event-stream")) {
      const json = await res.json().catch(() => null);
      if (res.ok && json && typeof json.text === "string") done = json;
      else error = { kind: "http", message: `HTTP ${res.status}: ${String(json?.error || "").slice(0, 160)}` };
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      outer: for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let event = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          let payload = null;
          try { payload = data ? JSON.parse(data) : null; } catch { /* keep null */ }
          if (event === "delta" && r.firstTokenMs === null) r.firstTokenMs = ms();
          if (event === "tool") toolEvents++;
          if (event === "done") { done = payload || {}; break outer; }
          if (event === "error" || event === "stopped") {
            error = { kind: event === "error" ? "agent-error" : "aborted", message: String(payload?.error || payload?.message || event).slice(0, 200) };
            break outer;
          }
        }
      }
      try { await reader.cancel(); } catch { /* ended */ }
      if (!done && !error) error = { kind: "connection", message: "stream ended without an answer" };
    }
    r.latencyMs = ms();
    if (done) {
      r.text = String(done.text || "");
      r.model = typeof done.model === "string" ? done.model : null;
      if (typeof done.sessionId === "string" && done.sessionId) sess.sessionId = done.sessionId;
      const calls = Array.isArray(done.toolCalls) ? done.toolCalls.length : 0;
      r.toolCalls = Math.max(calls, toolEvents);
      if (/^Error:/.test(r.text.trim())) r.error = { kind: "agent-error", message: r.text.trim().slice(0, 200) };
    }
    if (error) r.error = error;
  } catch (e) {
    r.latencyMs = ms();
    const aborted = ac.signal.aborted;
    r.error = { kind: aborted ? "timeout" : "connection", message: aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(e.message || e).slice(0, 200) };
    if (aborted) {
      await fetch(`${DASH}/setup-api/hermes/chat`, {
        method: "DELETE", headers: ownerHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionKey: sess.key, turnId }), signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
  return r;
}

// ---- sessions --------------------------------------------------------------------
let RUNTIME = null;
let GW_TOKEN = null;
const opened = [];
async function openSession(label) {
  const sess = { label, key: null, sessionId: null, gw: null };
  if (RUNTIME === "openclaw") {
    sess.key = `agent:main:clawbox-stress-${RUN_ID}-${label}`.toLowerCase();
    sess.gw = await Gateway.open(GW_TOKEN);
  } else {
    sess.key = `stress-${RUN_ID}-${label}`;
  }
  opened.push(sess);
  return sess;
}
function closeSession(sess) {
  if (sess.gw) sess.gw.close();
  sess.gw = null;
}
async function cleanupSessions() {
  if (RUNTIME === "openclaw") {
    let gw = null;
    try {
      gw = await Gateway.open(GW_TOKEN);
      for (const s of opened) {
        await gw.req("sessions.delete", { key: s.key, deleteTranscript: true }, 15_000).catch((e) => log("sessions.delete", s.key, e.message));
      }
    } catch (e) { log("cleanup: gateway", e.message); } finally { gw?.close(); }
  } else {
    // The route's own transcripts (data/chat-transcripts/<key>.jsonl). The Hermes
    // sessions those turns opened stay in Hermes' own store, like any chat's.
    for (const s of opened) {
      try { fs.rmSync(path.join(REPO, "data/chat-transcripts", `${s.key}.jsonl`), { force: true }); } catch { /* kept */ }
    }
  }
}
const turn = (sess, message, timeoutMs) => (RUNTIME === "openclaw" ? openclawTurn(sess, message, timeoutMs) : hermesTurn(sess, message, timeoutMs));

// ---- the steps ------------------------------------------------------------------------
const turns = [];
const steps = [];
const TURN_MS = () => cfg.turnTimeoutS * 1000;
const token = () => crypto.randomBytes(3).toString("hex").toUpperCase();

/** One turn, checked and recorded. `expect()` runs after the turn and answers
 *  the string the reply must hold, or null when there is nothing to check. */
async function checkedTurn(step, sess, idx, kind, message, expect) {
  const startedAt = rel();
  const r = await turn(sess, message, TURN_MS());
  let ok = !r.error;
  let error = r.error;
  if (ok && expect) {
    let want = null;
    try { want = expect(r); } catch (e) { want = { failed: e.message }; }
    if (want && typeof want === "object" && want.failed) { ok = false; error = { kind: "check", message: want.failed.slice(0, 200) }; }
    else if (typeof want === "string" && !r.text.includes(want)) { ok = false; error = { kind: "wrong-answer", message: `reply lacks the expected "${want.slice(0, 40)}"` }; }
  }
  const rec = {
    step, chat: sess.label, idx, kind, startedAt, ok,
    latencyMs: r.latencyMs, firstTokenMs: r.firstTokenMs, ackMs: r.ackMs, toolCalls: r.toolCalls,
    replyChars: r.text.length,
    ...(r.model ? { model: r.model } : {}),
    ...(error ? { error: { kind: error.kind, message: error.message } } : {}),
    // Only for a turn that went wrong, and only its head: enough to see why.
    ...(!ok && r.text ? { replyHead: r.text.replace(/\s+/g, " ").slice(0, 120) } : {}),
  };
  turns.push(rec);
  log(`${step} ${sess.label}#${idx} ${kind}: ${ok ? "ok" : "FAIL " + (error?.kind || "")} ${r.latencyMs ?? "-"} ms${r.toolCalls ? `, ${r.toolCalls} tool call(s)` : ""}${error ? " — " + error.message : ""}`);
  return rec;
}

async function healthy() {
  try {
    if (RUNTIME === "openclaw") {
      const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    }
    const r = await ownerJson("GET", "/setup-api/harness/status");
    const h = (r.json?.harnesses || []).find((x) => x && x.id === "hermes");
    return r.status === 200 && h?.healthy === true;
  } catch { return false; }
}
async function waitHealthy(budgetS) {
  const until = Date.now() + budgetS * 1000;
  for (;;) {
    if (await healthy()) return true;
    if (Date.now() > until) return false;
    await sleep(3000);
  }
}

// The gateway's own account of slow turns (OpenClaw logs "slow chat send
// <ms>ms … preparation=<ms>ms" for a send over its threshold): read from the
// unit's journal for the step's window.
function slowChatSends(fromMs, toMs) {
  if (RUNTIME !== "openclaw") return null;
  let text = "";
  try {
    text = execFileSync("journalctl", ["-u", units.gateway, "--since", `@${Math.floor(fromMs / 1000)}`, "--until", `@${Math.ceil(toMs / 1000) + 1}`, "-o", "cat", "--no-pager"], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  } catch { return null; }
  let count = 0, maxMs = null, maxPreparationMs = null;
  for (const line of text.split("\n")) {
    const m = /slow chat send (\d+)ms/.exec(line);
    if (!m) continue;
    count++;
    maxMs = Math.max(maxMs ?? 0, Number(m[1]));
    const p = /preparation=(\d+)ms/.exec(line);
    if (p) maxPreparationMs = Math.max(maxPreparationMs ?? 0, Number(p[1]));
  }
  return { count, maxMs, maxPreparationMs };
}

async function runStep(id, kind, concurrency, body) {
  log(`step ${id}: start`);
  const unitsBefore = await refreshUnits();
  const oomBefore = oomKills();
  const startedAt = rel();
  let failure = null;
  try { await body(id); } catch (e) { failure = String(e.message || e).slice(0, 200); log(`step ${id} aborted: ${failure}`); }
  const endedAt = rel();
  const unitsAfter = await refreshUnits();
  const oomAfter = oomKills();
  const healthyAfter = await waitHealthy(120);
  const slow = slowChatSends(T0 + startedAt, T0 + endedAt);
  steps.push({ id, kind, concurrency, startedAt, endedAt, unitsBefore, unitsAfter, oomKillsBefore: oomBefore, oomKillsAfter: oomAfter, healthyAfter, ...(slow ? { slowChatSends: slow } : {}), ...(failure ? { failure } : {}) });
  log(`step ${id}: done in ${Math.round((endedAt - startedAt) / 1000)} s, healthy after: ${healthyAfter}`);
  writeOut(false);
  if (cfg.settleS > 0) await sleep(cfg.settleS * 1000);
}

async function stepIdle(id) {
  await sleep(cfg.idleS * 1000);
  return id;
}

async function stepRamp(id, n) {
  const chats = [];
  try {
    for (let c = 0; c < n; c++) chats.push(await openSession(`${id}-c${c + 1}`));
    await Promise.all(chats.map(async (sess) => {
      for (let k = 1; k <= cfg.rampTurns; k++) {
        const tag = `STRESS-${token()}`;
        await checkedTurn(id, sess, k, "echo", `Reply with exactly this text and nothing else: ${tag}`, () => tag);
      }
    }));
  } finally { chats.forEach(closeSession); }
}

// Plain, deterministic filler so each turn adds context the way a real
// conversation does; ~PAD characters per turn.
const FILLER = "The quick brown fox jumps over the lazy dog while the clock on the wall keeps ticking and the kettle hums. ";
function filler(k, chars = 360) {
  let s = `Background note ${k}: `;
  while (s.length < chars) s += FILLER;
  return s.slice(0, chars);
}

async function stepLong(id) {
  const sess = await openSession(id);
  const word = `ORCHID-${token()}`;
  try {
    await checkedTurn(id, sess, 1, "remember", `Remember this code word for later in our conversation: ${word}. Reply with only OK.`, () => "OK");
    for (let k = 2; k <= cfg.longTurns; k++) {
      if (k % 8 === 0 || k === cfg.longTurns) {
        await checkedTurn(id, sess, k, "recall", `What is the code word I asked you to remember at the start of our conversation? Reply with only the code word.`, () => word);
      } else {
        const n = k * 3;
        await checkedTurn(id, sess, k, "chat", `${filler(k)}\nIgnore the note above. This is turn ${k}: reply with only the number ${n}.`, () => String(n));
      }
    }
  } finally { closeSession(sess); }
}

function sh(cmd) {
  return execFileSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 15_000 }).trim();
}
async function stepTool(id) {
  const dir = path.join(cfg.workDir, `tool-${RUN_ID}`);
  fs.mkdirSync(dir, { recursive: true });
  const notes = path.join(dir, "notes.txt");
  const sess = await openSession(id);
  const t2 = `QUARTZ-${token()}`, t5 = `MAPLE-${token()}`, t8 = `CEDAR-${token()}`;
  const fileHas = (want) => () => {
    const body = fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : "";
    return body.includes(want) ? null : { failed: `${notes} does not hold ${want}` };
  };
  const plan = [
    ["shell", "Run the shell command `cat /proc/sys/kernel/random/boot_id` and reply with only its output.",
      () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().slice(0, 8)],
    ["write", `Use a tool to create the file ${notes} containing exactly one line: ${t2}. Then reply with only DONE.`, fileHas(t2)],
    ["hash", `Run \`sha256sum ${notes}\` and reply with only the first 16 characters of the hash it prints.`,
      () => crypto.createHash("sha256").update(fs.readFileSync(notes)).digest("hex").slice(0, 16)],
    ["read", `Read the file ${notes} with a tool and reply with only its contents.`, () => t2],
    ["append", `Append a new line containing ${t5} to ${notes} with a shell command, then run \`wc -l < ${notes}\` and reply with only that number.`,
      () => { const miss = fileHas(t5)(); return miss || sh(`wc -l < ${JSON.stringify(notes)}`); }],
    ["count", "Run `ls -1 /usr/bin | wc -l` and reply with only the number it prints.", () => sh("ls -1 /usr/bin | wc -l")],
    ["stat", `Run \`stat -c %s ${notes}\` and reply with only the number it prints.`, () => String(fs.statSync(notes).size)],
    ["multi", `Create the directory ${dir}/sub, write the text ${t8} into the file ${dir}/sub/a.txt, then run \`grep -rl ${t8} ${dir}\` and reply with only the path(s) it printed.`, () => "sub/a.txt"],
  ].slice(0, cfg.toolTurns);
  try {
    let k = 0;
    for (const [kind, message, expect] of plan) await checkedTurn(id, sess, ++k, kind, message, expect);
  } finally { closeSession(sess); }
}

// ---- output -----------------------------------------------------------------------------
let board = null;
function boardFacts() {
  const read = (f) => { try { return fs.readFileSync(f, "utf8").replace(/\0/g, "").trim(); } catch { return null; } };
  const mi = readMeminfo();
  let sha = null, branch = null;
  try { sha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* no git */ }
  try { branch = execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* no git */ }
  let l4t = read("/etc/nv_tegra_release");
  if (l4t) l4t = l4t.split("\n")[0].replace(/^#\s*/, "").replace(/,\s*GCID.*$/, "").slice(0, 80);
  return {
    model: read("/proc/device-tree/model"),
    l4t,
    kernel: read("/proc/sys/kernel/osrelease"),
    cpus: Number(sh("nproc")) || null,
    memTotalMb: mi.MemTotal ? Math.round(mi.MemTotal / 1024) : null,
    swapTotalMb: mi.SwapTotal != null ? Math.round(mi.SwapTotal / 1024) : null,
    node: process.version,
    clawboxSha: sha,
    clawboxBranch: branch,
  };
}
function writeOut(final) {
  const doc = {
    version: VERSION, tool: "clawbox-nano-stress", runId: RUN_ID, final,
    startedAt: new Date(T0).toISOString(), endedAt: new Date().toISOString(),
    runtime: RUNTIME, units: { ...units }, board, config: cfg, steps, turns, samples,
  };
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, final ? OUT : `${OUT}.partial`);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`stopping on ${signal}: cleaning up`);
  stopSampler();
  await cleanupSessions().catch(() => {});
  try { fs.rmSync(cfg.workDir, { recursive: true, force: true }); } catch { /* kept */ }
  writeOut(false);
  process.exit(130);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(`${OUT}.pid`, String(process.pid));
  board = boardFacts();
  if (cfg.runtime === "auto") {
    const r = await ownerJson("GET", "/setup-api/harness/active");
    RUNTIME = r.json?.active === "hermes" ? "hermes" : "openclaw";
  } else RUNTIME = cfg.runtime;
  units.gateway = RUNTIME === "openclaw" ? "clawbox-gateway" : "clawbox-hermes-dashboard";
  log(`runtime ${RUNTIME}, run ${RUN_ID}, steps ${cfg.steps.join(",")}`);
  if (RUNTIME === "openclaw") GW_TOKEN = await gatewayToken();
  if (!(await waitHealthy(180))) throw new Error(`${RUNTIME} is not healthy before the run`);
  await refreshUnits();
  startSampler();
  try {
    for (const s of cfg.steps) {
      if (stopping) break;
      if (s === "idle") await runStep("idle", "idle", 0, stepIdle);
      else if (s === "ramp") for (const n of cfg.ramp) await runStep(`ramp-${n}`, "ramp", n, (id) => stepRamp(id, n));
      else if (s === "long") await runStep("long", "long", 1, stepLong);
      else if (s === "tool") await runStep("tool", "tool", 1, stepTool);
      else log(`unknown step ${s}: skipped`);
    }
  } finally {
    stopSampler();
    await cleanupSessions();
    try { fs.rmSync(cfg.workDir, { recursive: true, force: true }); } catch { /* kept */ }
  }
  writeOut(true);
  try { fs.rmSync(`${OUT}.partial`, { force: true }); } catch { /* none */ }
  log(`done: ${turns.filter((t) => t.ok).length}/${turns.length} turns ok`);
}

main().then(() => process.exit(0), (e) => {
  log(`failed: ${e.message}`);
  try {
    stopSampler();
    writeOut(false);
    fs.writeFileSync(`${OUT}.error`, String(e.message || e));
  } catch { /* nothing more to do */ }
  process.exit(1);
});
