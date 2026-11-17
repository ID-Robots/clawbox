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
//     [--sample-ms 2000] [--idle 30]
//
// Imported (as the unit tests do), it only exports its pure helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHermesDriver, takeSseFrames } from "./hermes-chat.mjs";

// The Hermes half (its chat route, frame names, Stop) lives in a hermes-named
// file of its own: those frame names are ClawBox's, not OpenClaw gateway events
// (scripts/harness-contract/scan.mjs). Re-exported: the unit tests use it here.
export { takeSseFrames };

const REPO = process.env.CLAWBOX_REPO || "/home/clawbox/clawbox";
const DASH = process.env.CLAWBOX_DASHBOARD || "http://127.0.0.1";
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 18789);
const HERMES_BIN = process.env.HERMES_BIN || path.join(os.homedir(), ".local/bin/hermes");
const VERSION = 1;

// ---- options ----------------------------------------------------------------
const RUN_ID = crypto.randomBytes(4).toString("hex");
const intList = (v) => String(v).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
/** The steps a run can take, in the order the doc names them. */
export const STEP_NAMES = ["idle", "ramp", "long", "tool"];

/** The run's options; throws on a missing or bad one. */
export function parseOptions(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  const out = opt("--out", "");
  if (!out) throw new Error("usage: node board-stress.mjs --out <raw.json> [options]");
  const c = {
    runtime: opt("--runtime", "auto"),
    ramp: intList(opt("--ramp", "1,2,4,8")),
    rampTurns: Number(opt("--ramp-turns", 3)),
    longTurns: Number(opt("--long-turns", 32)),
    toolTurns: Math.min(8, Number(opt("--tool-turns", 8))),
    steps: opt("--steps", "idle,ramp,long,tool").split(",").map((x) => x.trim()).filter(Boolean),
    turnTimeoutS: Number(opt("--turn-timeout", 240)),
    settleS: Number(opt("--settle", 20)),
    sampleMs: Number(opt("--sample-ms", 2000)),
    idleS: Number(opt("--idle", 30)),
    // A folder of this run's own beside the record: the only one it deletes.
    workDir: path.join(path.dirname(path.resolve(out)), `stress-work-${RUN_ID}`),
    runId: RUN_ID,
  };
  if (!["auto", "openclaw", "hermes"].includes(c.runtime)) throw new Error("--runtime is auto, openclaw or hermes");
  for (const k of ["rampTurns", "longTurns", "toolTurns", "turnTimeoutS", "sampleMs"]) {
    if (!Number.isInteger(c[k]) || c[k] < 1) throw new Error(`${k} must be a whole number above 0`);
  }
  for (const k of ["settleS", "idleS"]) {
    if (!Number.isFinite(c[k]) || c[k] < 0) throw new Error(`${k} must be 0 or more`);
  }
  if (c.ramp.length === 0) throw new Error("--ramp wants a list like 1,2,4,8");
  // A misspelt step must not leave a run of no steps that reports no findings.
  if (c.steps.length === 0) throw new Error(`--steps wants one or more of ${STEP_NAMES.join(",")}`);
  const unknown = c.steps.filter((s) => !STEP_NAMES.includes(s));
  if (unknown.length) throw new Error(`--steps: no step called ${unknown.join(",")}; the steps are ${STEP_NAMES.join(",")}`);
  // A step's id names its turns and sessions: one step, one id.
  const twice = (xs) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  if (twice(c.steps).length) throw new Error(`--steps names ${twice(c.steps).join(",")} more than once`);
  if (twice(c.ramp).length) throw new Error(`--ramp names ${twice(c.ramp).join(",")} more than once`);
  return { out, cfg: c };
}
let OUT = "";
let cfg = null;
const T0 = Date.now();
const rel = () => Date.now() - T0;
// One line per call: a reply or an error text carrying a newline must not
// forge a line of its own in the run's log.
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${a.join(" ").replace(/[\r\n]+/g, " ")}`);

// ---- stopping ---------------------------------------------------------------------
// SIGTERM/SIGINT (run.sh's stop, the budget running out) set `stopping` and
// abort this signal: the turn in flight ends early (and is stopped on the
// runtime), and no workload starts another turn.
let stopping = false;
let stopReason = null;
const stopCtl = new AbortController();
/** A wait that a stopping run cuts short. */
const pause = (ms) => sleep(ms, undefined, { signal: stopCtl.signal }).catch(() => {});
const stoppedError = () => ({ kind: "stopped", message: `the run was stopped (${stopReason || "signal"})` });

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

// ---- checking a reply ---------------------------------------------------------------
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `reply` hold `want`, once every echo of the prompt is taken out of it?
 * A string must stand as a whole token ("9" is not in "19"); a RegExp is
 * tested as it is. The prompt names what it asks for, so an echo of it must
 * not pass (scripts/nano-tests/lib.sh guards its chat turn the same way).
 */
export function replyHolds(reply, want, prompt = "") {
  let text = String(reply || "");
  if (prompt) text = text.split(prompt).join(" ");
  if (want instanceof RegExp) return want.test(text);
  return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(String(want))}(?![A-Za-z0-9])`).test(text);
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

/**
 * Stop a turn of `sess` on the gateway (`chat.abort`), through the session's
 * own socket while it is open, else through a short-lived one: a send or turn
 * whose end the gateway never reported may still be running there.
 */
async function abortTurn(sess, runId) {
  const params = { sessionKey: sess.key, ...(runId ? { runId } : {}) };
  if (sess.gw && sess.gw.ws.readyState === 1) {
    await sess.gw.req("chat.abort", params, 10_000).catch((e) => log(`chat.abort ${sess.key}: ${e.message}`));
    return;
  }
  let gw = null;
  try {
    gw = await Gateway.open(GW_TOKEN);
    await gw.req("chat.abort", params, 10_000);
  } catch (e) {
    log(`chat.abort ${sess.key}: ${e.message}`);
  } finally {
    gw?.close();
  }
}

async function openclawTurn(sess, message, timeoutMs, stopSignal) {
  const r = { ackMs: null, firstTokenMs: null, latencyMs: null, toolCalls: 0, text: "", error: null, model: null };
  if (stopSignal?.aborted) { r.error = stoppedError(); return r; }
  // A socket the gateway closed (a restart, a dropped connection) is opened
  // again for the next turn, and counted, rather than failing every turn after.
  if (!sess.gw || sess.gw.ws.readyState !== 1) {
    sess.gw?.close();
    try {
      sess.gw = await Gateway.open(GW_TOKEN);
      sess.reconnects = (sess.reconnects || 0) + 1;
    } catch (e) {
      r.error = { kind: "connection", message: `gateway reconnect: ${e.message}`.slice(0, 200) };
      return r;
    }
    // The reconnect took a while: a stop that came meanwhile sends nothing.
    if (stopSignal?.aborted) { r.error = stoppedError(); return r; }
  }
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let runId = null;
  let settled = false;
  // The gateway reported this turn's end (final, error or aborted).
  let ended = false;
  let resolveFinal;
  const final = new Promise((res) => { resolveFinal = res; });
  const STOPPED = Symbol("stopped");
  let onStop = null;
  const stopped = new Promise((res) => {
    onStop = () => res(STOPPED);
    stopSignal?.addEventListener("abort", onStop, { once: true });
  });
  const toolIds = new Set();
  // Events that come before the ack wait for it: only the ack's runId tells
  // this turn's events from a late end of an earlier run in the session.
  let acked = false;
  const early = [];
  const handle = (f, at) => {
    const p = f.payload || {};
    if (f.event === "chat") {
      if (p.sessionKey !== sess.key) return;
      if (runId && p.runId && p.runId !== runId) return;
      if (p.state === "delta") { if (r.firstTokenMs === null) r.firstTokenMs = at; }
      else if (p.state === "final" || p.state === "error" || p.state === "aborted") {
        ended = true;
        r.latencyMs = at;
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
  const l = (f) => {
    // A turn given up on stays given up on: the abort's own "aborted" event
    // must not turn a timeout into an answer.
    if (settled) return;
    if (f.type === "closed") { r.error = r.error || { kind: "connection", message: "gateway socket closed mid-turn" }; resolveFinal(); return; }
    if (!acked) { early.push([f, ms()]); return; }
    handle(f, ms());
  };
  sess.gw.listeners.add(l);
  let timer;
  try {
    const ack = await Promise.race([
      sess.gw.req("chat.send", { sessionKey: sess.key, message, deliver: false, idempotencyKey: crypto.randomUUID() }, 60_000),
      stopped,
    ]);
    if (ack === STOPPED) {
      r.error = stoppedError();
    } else {
      r.ackMs = ms();
      runId = ack?.runId || null;
      acked = true;
      for (const [f, at] of early.splice(0)) handle(f, at);
      const end = await Promise.race([
        final.then(() => "final"),
        stopped,
        new Promise((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); }),
      ]);
      if (end !== "final") {
        r.latencyMs = null;
        r.error = end === STOPPED ? stoppedError() : { kind: "timeout", message: `no final within ${Math.round(timeoutMs / 1000)} s` };
      }
    }
  } catch (e) {
    // "timeout chat.send": sent, never acknowledged; "gateway closed": the
    // socket went with the send in flight. Either may have started a turn.
    const kind = /timeout/.test(e.message) ? "timeout" : /gateway closed/.test(e.message) ? "connection" : "rpc";
    r.error = r.error || { kind, message: e.message.slice(0, 200) };
  } finally {
    settled = true;
    clearTimeout(timer);
    sess.gw?.listeners.delete(l);
    stopSignal?.removeEventListener("abort", onStop);
  }
  // No end reported for a send that may have started a turn (a send not
  // acknowledged in time, no final in time, the socket gone, the run
  // stopping): stop it before the session's next turn, or its deletion, can
  // overlap it. A send the gateway refused ("rpc") started nothing.
  if (!ended && r.error && r.error.kind !== "rpc") await abortTurn(sess, runId);
  r.toolCalls = toolIds.size;
  return r;
}

// ---- Hermes: the desktop chat's own route, streamed (scripts/nano-stress/hermes-chat.mjs)
const hermes = createHermesDriver({ dash: DASH, headers: ownerHeaders, log });

// ---- sessions --------------------------------------------------------------------
let RUNTIME = null;
let GW_TOKEN = null;
const opened = [];
async function openSession(label) {
  const sess = { label, key: null, sessionId: null, hermesIds: new Set(), gw: null, reconnects: 0 };
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
// Hermes' own session ids, as its chat route and CLI write them.
const HERMES_SESSION_ID_RE = /^(?:[0-9]{8}_[0-9]{6}_[0-9a-f]{6}|local-[0-9a-f]{64})$/;
// What the cleanup did, for the record (filled in as it goes)...
let cleanup = null;
// ...and the cleanup itself: main() and shutdown() both await this one.
let cleanupRun = null;
function cleanupSessions() {
  if (!cleanupRun) cleanupRun = deleteSessions();
  return cleanupRun;
}
async function deleteSessions() {
  const result = { sessions: opened.length, deleted: 0, left: [] };
  cleanup = result;
  if (RUNTIME === "openclaw") {
    let gw = null;
    for (let attempt = 1; attempt <= 3 && !gw; attempt++) {
      try { gw = await Gateway.open(GW_TOKEN); } catch (e) { log(`cleanup: gateway (attempt ${attempt})`, e.message); await sleep(3000); }
    }
    for (const s of opened) {
      if (!gw) { result.left.push(s.key); continue; }
      // A turn still running (a stop mid-turn) ends first, then the session goes.
      await gw.req("chat.abort", { sessionKey: s.key }, 10_000).catch(() => {});
      try {
        await gw.req("sessions.delete", { key: s.key, deleteTranscript: true }, 15_000);
        result.deleted++;
      } catch (e) {
        log("sessions.delete", s.key, e.message);
        result.left.push(s.key);
      }
    }
    gw?.close();
  } else {
    for (const s of opened) {
      await hermes.stop(s.key);
      let ok = true;
      // The route's own transcript (data/chat-transcripts/<key>.jsonl) and the
      // Hermes sessions its turns opened.
      try { fs.rmSync(path.join(REPO, "data/chat-transcripts", `${s.key}.jsonl`), { force: true }); } catch { ok = false; }
      for (const id of s.hermesIds) {
        if (!HERMES_SESSION_ID_RE.test(id)) continue;
        try {
          execFileSync(HERMES_BIN, ["sessions", "delete", "--yes", id], { stdio: "ignore", timeout: 60_000 });
        } catch (e) {
          ok = false;
          log(`hermes sessions delete ${id}: ${String(e.message).split("\n")[0]}`);
        }
      }
      if (ok) result.deleted++; else result.left.push(s.key);
    }
  }
  log(`cleanup: ${result.deleted}/${result.sessions} sessions deleted${result.left.length ? `, left: ${result.left.join(" ")}` : ""}`);
  return result;
}
const turn = (sess, message, timeoutMs) => (RUNTIME === "openclaw"
  ? openclawTurn(sess, message, timeoutMs, stopCtl.signal)
  : hermes.turn(sess, message, timeoutMs, stopCtl.signal));

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
    if (want && typeof want === "object" && !(want instanceof RegExp) && want.failed) { ok = false; error = { kind: "check", message: want.failed.slice(0, 200) }; }
    else if ((typeof want === "string" || want instanceof RegExp) && !replyHolds(r.text, want, message)) {
      ok = false;
      error = { kind: "wrong-answer", message: `reply lacks the expected ${String(want).slice(0, 40)}` };
    }
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
/** true once healthy, false when the budget ran out, null when the run is
 *  stopping (it looks once, then moves on: not known, not a finding). */
async function waitHealthy(budgetS) {
  const until = Date.now() + budgetS * 1000;
  for (;;) {
    if (await healthy()) return true;
    if (stopping) return null;
    if (Date.now() > until) return false;
    await pause(3000);
  }
}

// The gateway's own account of slow turns (OpenClaw logs "slow chat send
// <ms>ms … preparation=<ms>ms" for a send over its threshold): read from the
// unit's journal for the step's window.
function slowChatSends(fromMs, toMs) {
  if (RUNTIME !== "openclaw") return null;
  let text = "";
  // journalctl answers an unreadable journal with nothing and exit 0: that is
  // "unknown", not "no slow sends".
  try {
    if (!execFileSync("journalctl", ["-u", units.gateway, "-n", "1", "-o", "cat", "--no-pager"], { encoding: "utf8", timeout: 10_000 }).trim()) return null;
  } catch { return null; }
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

// The step running now (runStep's promise): shutdown() waits for it, so its
// turns have ended before their sessions are deleted.
let currentStep = null;
const runStep = (id, kind, concurrency, body) => (currentStep = stepRecorded(id, kind, concurrency, body));

async function stepRecorded(id, kind, concurrency, body) {
  log(`step ${id}: start`);
  const unitsBefore = await refreshUnits();
  const oomBefore = oomKills();
  // In the record before its body starts: a run stopped mid-step still
  // reports the step, its turns and its samples (updated in place below).
  const rec = { id, kind, concurrency, startedAt: rel(), endedAt: null, unitsBefore, oomKillsBefore: oomBefore };
  steps.push(rec);
  try { await body(id); } catch (e) { rec.failure = String(e.message || e).slice(0, 200); log(`step ${id} aborted: ${rec.failure}`); }
  rec.endedAt = rel();
  if (stopping && !rec.failure) rec.failure = `the run was stopped (${stopReason}) during the step`;
  // Restarts and OOM kills are read after the recovery wait and the settle, so
  // a crash at the tail of the load is this step's, not nobody's. A stopping
  // run skips both waits.
  rec.healthyAfter = await waitHealthy(120);
  if (cfg.settleS > 0) await pause(cfg.settleS * 1000);
  rec.unitsAfter = await refreshUnits();
  rec.oomKillsAfter = oomKills();
  rec.reconnects = opened.reduce((n, x) => n + (x.label === id || x.label.startsWith(`${id}-`) ? x.reconnects || 0 : 0), 0);
  const slow = slowChatSends(T0 + rec.startedAt, Date.now());
  if (slow) rec.slowChatSends = slow;
  log(`step ${id}: done in ${Math.round((rec.endedAt - rec.startedAt) / 1000)} s, healthy after: ${rec.healthyAfter}`);
  writeOut(false);
}

async function stepIdle(id) {
  await pause(cfg.idleS * 1000);
  return id;
}

async function stepRamp(id, n) {
  const chats = [];
  try {
    for (let c = 0; c < n && !stopping; c++) chats.push(await openSession(`${id}-c${c + 1}`));
    await Promise.all(chats.map(async (sess) => {
      for (let k = 1; k <= cfg.rampTurns && !stopping; k++) {
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
    // A stop while the session opened: no turn to record.
    if (stopping) return;
    await checkedTurn(id, sess, 1, "remember", `Remember this code word for later in our conversation: ${word}. Reply with only OK.`, () => "OK");
    for (let k = 2; k <= cfg.longTurns && !stopping; k++) {
      if (k % 8 === 0 || k === cfg.longTurns) {
        await checkedTurn(id, sess, k, "recall", `What is the code word I asked you to remember at the start of our conversation? Reply with only the code word.`, () => word);
      } else {
        const n = k * 3;
        await checkedTurn(id, sess, k, "chat", `${filler(k)}\nIgnore the note above. This is turn ${k}: reply with only the number ${n}.`, () => String(n));
      }
    }
  } finally { closeSession(sess); }
}

// What the tool turns' commands print, worked out here without a shell.
/** `wc -l < file`: the number of newline characters in it. */
const lineCount = (file) => String((fs.readFileSync(file, "utf8").match(/\n/g) || []).length);
/** `ls -1 dir | wc -l`: the entries `ls` lists, dot-files left out. */
const visibleEntries = (dir) => String(fs.readdirSync(dir).filter((name) => !name.startsWith(".")).length);
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
      () => new RegExp(`(?:^|[^0-9a-f])${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().slice(0, 8)}`)],
    ["write", `Use a tool to create the file ${notes} containing exactly one line: ${t2}. Then reply with only DONE.`, fileHas(t2)],
    ["hash", `Run \`sha256sum ${notes}\` and reply with only the first 16 characters of the hash it prints.`,
      () => new RegExp(`(?:^|[^0-9a-f])${crypto.createHash("sha256").update(fs.readFileSync(notes)).digest("hex").slice(0, 16)}`)],
    ["read", `Read the file ${notes} with a tool and reply with only its contents.`, () => t2],
    ["append", `Append a new line containing ${t5} to ${notes} with a shell command, then run \`wc -l < ${notes}\` and reply with only that number.`,
      () => { const miss = fileHas(t5)(); return miss || lineCount(notes); }],
    ["count", "Run `ls -1 /usr/bin | wc -l` and reply with only the number it prints.", () => visibleEntries("/usr/bin")],
    ["stat", `Run \`stat -c %s ${notes}\` and reply with only the number it prints.`, () => String(fs.statSync(notes).size)],
    ["multi", `Create the directory ${dir}/sub, write the text ${t8} into the file ${dir}/sub/a.txt, then run \`grep -rl ${t8} ${dir}\` and reply with only the path(s) it printed.`,
      () => {
        const a = path.join(dir, "sub", "a.txt");
        const body = fs.existsSync(a) ? fs.readFileSync(a, "utf8") : "";
        return body.includes(t8) ? a : { failed: `${a} does not hold ${t8}` };
      }],
  ].slice(0, cfg.toolTurns);
  try {
    let k = 0;
    for (const [kind, message, expect] of plan) {
      if (stopping) break;
      await checkedTurn(id, sess, ++k, kind, message, expect);
    }
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
    cpus: os.availableParallelism?.() ?? os.cpus().length,
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
    runtime: RUNTIME, units: { ...units }, board, config: cfg, cleanup, steps, turns, samples,
  };
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, final ? OUT : `${OUT}.partial`);
}

// How long a stop waits for the step in flight to end its turns (each one
// stops its own turn on the runtime first) and close its record; run.sh
// waits 150 s for the whole stop, session deletion included.
const STEP_WIND_DOWN_MS = 60_000;
let shutdownRun = null;
/** The one stop: a second signal waits for the first. */
function shutdown(signal) {
  if (!shutdownRun) shutdownRun = stopRun(signal);
  return shutdownRun;
}
async function stopRun(signal) {
  stopping = true;
  stopReason = signal;
  log(`stopping on ${signal}: ending the turns in flight, then cleaning up`);
  stopCtl.abort();
  try {
    if (currentStep) {
      let timer;
      const wound = await Promise.race([
        currentStep.then(() => true, () => true),
        new Promise((res) => { timer = setTimeout(() => res(false), STEP_WIND_DOWN_MS); }),
      ]);
      clearTimeout(timer);
      if (!wound) log(`the step in flight did not end within ${STEP_WIND_DOWN_MS / 1000} s: deleting its sessions anyway`);
    }
    stopSampler();
    const open = steps.at(-1);
    if (open && open.endedAt === null) {
      open.endedAt = rel();
      open.failure = open.failure || `the run was stopped (${signal}) during the step`;
    }
    await cleanupSessions().catch(() => {});
    try { fs.rmSync(cfg.workDir, { recursive: true, force: true }); } catch { /* kept */ }
    writeOut(false);
  } catch (e) {
    log(`stop: ${e.message}`);
  } finally {
    process.exit(130);
  }
}

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
      else if (s === "ramp") {
        for (const n of cfg.ramp) if (!stopping) await runStep(`ramp-${n}`, "ramp", n, (id) => stepRamp(id, n));
      } else if (s === "long") await runStep("long", "long", 1, stepLong);
      else if (s === "tool") await runStep("tool", "tool", 1, stepTool);
    }
  } finally {
    // A stopping run is shutdown()'s to clean up and record.
    if (!stopping) {
      stopSampler();
      await cleanupSessions();
      try { fs.rmSync(cfg.workDir, { recursive: true, force: true }); } catch { /* kept */ }
    }
  }
  // Stopped (now or during the cleanup): shutdown() writes the partial record
  // and exits; this never writes a final one.
  if (stopping) return shutdownRun;
  writeOut(true);
  try { fs.rmSync(`${OUT}.partial`, { force: true }); } catch { /* none */ }
  log(`done: ${turns.filter((t) => t.ok).length}/${turns.length} turns ok`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  try {
    ({ out: OUT, cfg } = parseOptions(process.argv.slice(2)));
  } catch (e) {
    console.error(`board-stress: ${e.message}`);
    process.exit(2);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  main().then(() => process.exit(0), (e) => {
    // A failure of a stopping run is shutdown()'s to record and exit on.
    if (stopping) { log(`stopping: ${e.message}`); return; }
    log(`failed: ${e.message}`);
    try {
      stopSampler();
      writeOut(false);
      fs.writeFileSync(`${OUT}.error`, String(e.message || e));
    } catch { /* nothing more to do */ }
    process.exit(1);
  });
}
