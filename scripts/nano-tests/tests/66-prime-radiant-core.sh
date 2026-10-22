#!/usr/bin/env bash
# timeout: 900
# covers: scripts/openclaw-plugins/clawbox-prime-radiant-core/* src/lib/prime-radiant/core-context*.ts src/lib/prime-radiant/reindex-hook.ts src/app/setup-api/prime-radiant/settings/*
#
# The Prime Radiant core block on the real box, as the pinned gateway sends
# it to the model. The gateway's own cache trace (`diagnostics.cacheTrace`,
# switched on for the test with `openclaw config set` and put back after it)
# writes every model request of an embedded run, the system prompt included,
# to ~/.openclaw/logs/cache-trace.jsonl; every check below reads that record,
# never the plugin's own file alone.
#
#   1. Off by default; the owner creates 8 linked pages: 6 eligible, and one
#      confidential and one secret-ref page that every other page links to.
#   2. The owner turns `context` on with n=3: a NEW session of the main agent
#      carries ONE block, exactly the one on disk, the 3 most-linked pages by
#      the box's own graph, within maxChars, neither hidden page in it; the
#      same session's next turn still carries it once and its history none.
#   3. A ClawBox user's own chat (agent:main:clawbox-user-…) gets none, nor a
#      turn on the board's on-device model (a SKIP when none is set up).
#   4. n=50 lists min(50, eligible) pages; a page the owner sets to
#      confidential leaves the block at once.
#   5. A real nightly pass merges into the vault's main: the block is rebuilt
#      from the merged main and the next new session carries it, with the
#      same gateway process (MainPID) and its uptime still counting.
#   6. Off again: no file, and a new session carries no block.
# The pages, the setting and the trace switch are put back whatever happens.
# A SKIP for the night when it merged nothing (or held its branch): there was
# no merge to follow.
#
# One script ON the board: the owner's cookie is minted there from
# data/.session-secret (as 55-multi-user does) and never leaves it.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # JavaScript, run on the board
FLOW='
const fs = require("fs"), crypto = require("crypto"), http = require("http"), path = require("path");
const { execFile } = require("child_process");
const [OPENCLAW, RUN_ID] = process.argv.slice(1);
const REPO = process.cwd(), DATA = path.join(REPO, "data"), PR = path.join(DATA, "prime-radiant");
const VAULT = path.join(PR, "vault"), CORE = path.join(PR, "core-context.json");
const TRACE = path.join(process.env.HOME, ".openclaw", "logs", "cache-trace.jsonl");
const T0 = Date.now(), BUDGET_MS = 760e3;
const left = () => BUDGET_MS - (Date.now() - T0);
const out = (s) => console.log("RESULT " + s);
const ok = (s) => out("ok - " + s);
const notOk = (s) => out("not ok - " + s);
const skip = (s) => out("ok # SKIP " + s);
const note = (s) => out("# " + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 300);
const secs = (ms) => Math.round(ms / 1000) + " s";
const runTag = String(RUN_ID || "local").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);

let COOKIE = "";
function ownerCookie() {
  const secret = fs.readFileSync(path.join(DATA, ".session-secret"), "utf8").trim();
  let gen = 0;
  try { const c = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800, gen })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** The owner, from the desktop: cookie and same origin. */
function call(method, url, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { cookie: "clawbox_session=" + COOKIE, origin: "http://127.0.0.1" };
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port: 80, path: url, method, headers, timeout: 120e3 }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (s += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    req.on("timeout", () => req.destroy(new Error("no answer in 120 s")));
    req.on("error", (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const why = (r) => `HTTP ${r.status}: ${one((r.json && (r.json.error || r.json.message)) || r.text).slice(0, 200)}`;

function run(file, args, ms) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms, maxBuffer: 32 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 124) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const git = async (...a) => (await run("git", ["-C", VAULT, ...a], 30e3)).stdout.trim();

// ---- what the gateway sent ----------------------------------------------------
const OPEN = "<prime_radiant_core ", CLOSE = "</prime_radiant_core>";
const count = (s, sub) => s.split(sub).length - 1;
const sysText = (r) => typeof r.system === "string" ? r.system
  : Array.isArray(r.system) ? r.system.map((b) => (typeof b === "string" ? b : b && typeof b.text === "string" ? b.text : "")).join("\n") : "";
function blockOf(s) {
  const a = s.indexOf(OPEN);
  if (a < 0) return null;
  const e = s.indexOf(CLOSE, a);
  return e < 0 ? s.slice(a) : s.slice(a, e + CLOSE.length);
}
const titlesOf = (block) => block.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(" — ")[0].trim());
const modelOf = (r) => `${r.provider || (r.model && r.model.provider) || "?"}/${r.modelId || (r.model && r.model.id) || "?"}`;
function readCore() {
  try { const o = JSON.parse(fs.readFileSync(CORE, "utf8")); return o && typeof o.text === "string" ? o : null; } catch { return null; }
}
/** The model requests the cache trace holds for one session, oldest first. */
function requests(sessionKey) {
  let text = "";
  try { text = fs.readFileSync(TRACE, "utf8"); } catch { return []; }
  const k = sessionKey.toLowerCase();
  return text.split("\n").filter((l) => l.toLowerCase().includes(k)).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && typeof r.sessionKey === "string" && r.sessionKey.toLowerCase() === k && r.stage === "stream:context");
}
let turns = 0;
/** One turn of the main agent on `sessionKey`; answers the requests the trace recorded for it. */
async function turn(sessionKey, extra = []) {
  turns++;
  const had = requests(sessionKey).length;
  const r = await run(OPENCLAW, ["agent", "--agent", "main", "--session-key", sessionKey, "-m",
    "Reply with exactly this text and nothing else: NANO-CORE-OK", "--json", "--timeout", "120", ...extra], 150e3);
  // The trace is written through a queue: give it a moment to land.
  for (let i = 0; i < 6 && requests(sessionKey).length <= had; i++) await sleep(1000);
  return { ...r, requests: requests(sessionKey) };
}
const keyOf = (what) => `agent:main:nano-ci-core-${runTag}-${what}`;
const failedTurn = (t) => `exit ${t.code}: ${one(t.stderr || t.stdout).slice(0, 200)}`;

// ---- the gateway process -----------------------------------------------------
async function gatewayPid() { return (await run("systemctl", ["show", "clawbox-gateway.service", "-p", "MainPID", "--value"], 15e3)).stdout.trim(); }
/** The gateway uptime its hello snapshot reports through the desktop relay, or null. */
function gatewayUptime() {
  return new Promise((resolve) => {
    let WebSocket;
    try { WebSocket = require("ws"); } catch { resolve(null); return; }
    const ws = new WebSocket("ws://127.0.0.1/", { headers: { cookie: "clawbox_session=" + COOKIE, origin: "http://127.0.0.1" } });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), 20e3);
    ws.on("error", () => done(null));
    ws.on("message", (raw) => {
      let f;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.type === "event" && f.event === "connect.challenge") {
        ws.send(JSON.stringify({ type: "req", id: "c", method: "connect", params: { auth: { token: "" } } }));
      } else if (f.id === "c") {
        const u = f.ok && f.payload && f.payload.snapshot && f.payload.snapshot.uptimeMs;
        done(typeof u === "number" ? { uptimeMs: u, at: Date.now() } : null);
      }
    });
  });
}

// ---- put back whatever happens ------------------------------------------------
const MADE = [];
let PRIOR = null, TRACE_SET = false, TRACE_PRIOR = null, TRACE_EXISTED = true, cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (PRIOR) {
    const r = await call("PUT", "/setup-api/prime-radiant/settings", { context: { enabled: PRIOR.enabled, n: PRIOR.n, maxChars: PRIOR.maxChars } });
    if (r.status !== 200) notOk("the context setting could not be put back: " + why(r));
  }
  let gone = 0;
  for (const p of MADE) if ((await call("DELETE", "/setup-api/prime-radiant/pages/" + p)).status === 200) gone++;
  if (MADE.length) note(`removed ${gone} of the ${MADE.length} pages this test made`);
  if (TRACE_SET) {
    const r = TRACE_PRIOR === null
      ? await run(OPENCLAW, ["config", "unset", "diagnostics.cacheTrace"], 90e3)
      : await run(OPENCLAW, ["config", "set", "diagnostics.cacheTrace.enabled", TRACE_PRIOR, "--strict-json"], 90e3);
    if (r.code !== 0) notOk("the cache trace switch could not be put back: " + failedTurn(r));
    if (!TRACE_EXISTED) fs.rmSync(TRACE, { force: true });
  }
}
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => { cleanup().finally(() => process.exit(1)); });

async function main() {
  if (!fs.existsSync(path.join(DATA, ".session-secret"))) return notOk("data/.session-secret is not readable as the box account");
  COOKIE = ownerCookie();

  // 1. The box as it is, and the pages.
  let st = await call("GET", "/setup-api/prime-radiant/status");
  if (st.status !== 200 || !st.json) return notOk("Prime Radiant status answered " + why(st));
  if (!st.json.initialised) {
    const init = await call("POST", "/setup-api/prime-radiant/init", {});
    if (init.status !== 200) return notOk("setting up the vault answered " + why(init));
    note("the vault was not set up yet: the owner set it up");
    st = await call("GET", "/setup-api/prime-radiant/status");
  }
  const before = Number(st.json && st.json.pages) || 0;
  const exact = before === 0;
  if (!exact) note(`the vault already had ${before} page(s): the lists are checked for order and exclusions, not page for page`);
  const s0 = await call("GET", "/setup-api/prime-radiant/settings");
  const ctx0 = s0.json && s0.json.settings && s0.json.settings.context;
  if (s0.status !== 200 || !ctx0) return notOk("the settings answer has no context setting: " + why(s0));
  PRIOR = ctx0;
  const def = s0.json.defaults && s0.json.defaults.context;
  if (def && def.enabled === false) ok(`the core block is off by default (n ${def.n}, maxChars ${def.maxChars})`);
  else notOk("the default context setting is not off: " + one(JSON.stringify(def)));
  if (ctx0.enabled) note("the owner had the core block on before this test: it is put back on after it");
  else if (fs.existsSync(CORE)) notOk("the setting is off, yet a core block is on disk");

  const tag = "nci" + crypto.randomBytes(3).toString("hex");
  const T = (w) => `Nano core ${w} ${tag}`;
  const SEEDS = [
    ["guarded", "confidential", []],
    ["sealed", "secret-ref", []],
    ["alpha", "internal", ["guarded", "sealed"]],
    ["beta", "internal", ["alpha", "guarded", "sealed"]],
    ["gamma", "internal", ["alpha", "beta", "guarded", "sealed"]],
    ["delta", "internal", ["alpha", "beta", "gamma", "guarded", "sealed"]],
    ["epsilon", "internal", ["alpha", "beta", "gamma", "delta", "guarded", "sealed"]],
    ["zeta", "public", ["alpha", "beta", "guarded", "sealed"]],
  ];
  const PATH = {};
  for (const [w, privacy, to] of SEEDS) {
    const r = await call("POST", "/setup-api/prime-radiant/pages", {
      type: "concept", title: T(w), domain: "nano-ci", status: "stable", privacy, sources: ["nano-ci seed"],
      summary: `The ${w} page of a nano-ci run.`,
      body: to.length ? "Related: " + to.map((x) => `[[${T(x)}]]`).join(", ") + ".\n" : "No links out.\n",
    });
    if (r.status !== 201 || !r.json || !r.json.path) return notOk(`creating the ${w} page answered ${why(r)}`);
    MADE.push(r.json.path);
    PATH[w] = r.json.path;
  }
  ok(`the owner made 8 linked pages (${tag}): 6 eligible, and a confidential and a secret-ref page that all of them link to`);
  const HIDDEN = [T("guarded"), T("sealed"), "The guarded page", "The sealed page"];
  const leaks = (b) => HIDDEN.filter((h) => b.includes(h));
  const ranked = async (block) => {
    const g = await call("GET", "/setup-api/prime-radiant/graph");
    const nodes = new Map(((g.json && g.json.nodes) || []).map((n) => [String(n.title).trim().toLowerCase(), n]));
    const rows = titlesOf(block).map((t) => [t, nodes.get(t.toLowerCase())]);
    const missing = rows.filter(([, n]) => !n).map(([t]) => t);
    if (missing.length) return `not in the box graph: ${missing.join(", ")}`;
    for (let i = 1; i < rows.length; i++) {
      const [ta, a] = rows[i - 1], [tb, b] = rows[i];
      if (a.links < b.links || (a.links === b.links && a.inbound < b.inbound)) return `${ta} (${a.links} links) is listed before ${tb} (${b.links} links)`;
    }
    return null;
  };

  // 2. On, n=3, and a new session of the main agent.
  let p = await call("PUT", "/setup-api/prime-radiant/settings", { context: { enabled: true, n: 3 } });
  const maxChars = p.json && p.json.settings && p.json.settings.context && p.json.settings.context.maxChars;
  const cb = p.json && p.json.contextBlock;
  if (p.status !== 200 || !cb) return notOk("turning the core block on answered " + why(p) + " (contextBlock " + one(JSON.stringify(cb)) + ")");
  const disk1 = readCore();
  if (!disk1) return notOk("the core block is on, yet no block is on disk");
  ok(`the owner turned it on with n=3: ${cb.pages} pages, ${cb.chars} chars (~${cb.estTokens} tokens a turn) on disk`);

  const got = await run(OPENCLAW, ["config", "get", "diagnostics.cacheTrace.enabled", "--json"], 90e3);
  TRACE_PRIOR = got.code === 0 && /^(true|false)$/.test(got.stdout.trim()) ? got.stdout.trim() : null;
  TRACE_EXISTED = fs.existsSync(TRACE);
  TRACE_SET = true;
  const set = await run(OPENCLAW, ["config", "set", "diagnostics.cacheTrace.enabled", "true", "--strict-json"], 90e3);
  if (set.code !== 0) return notOk("switching the gateway cache trace on failed: " + failedTurn(set));
  await sleep(5000);

  let k1 = keyOf("main"), t1 = await turn(k1);
  if (t1.requests.length === 0) {
    note(`the first turn left no trace record (${failedTurn(t1)}): the config may not have been applied yet, once more in 10 s`);
    await sleep(10e3);
    k1 = keyOf("main-again");
    t1 = await turn(k1);
  }
  if (t1.requests.length === 0) return notOk("the gateway cache trace recorded no model request for a main-agent turn: " + failedTurn(t1));
  const r1 = t1.requests[t1.requests.length - 1], sys1 = sysText(r1), b1 = blockOf(sys1) || "";
  const n1 = count(sys1, OPEN);
  if (n1 === 1) ok(`a new session of the main agent (${modelOf(r1)}) sent ONE Prime Radiant core block in its system prompt (${b1.length} chars)`);
  else notOk(`a new session of the main agent sent ${n1} Prime Radiant core blocks (${modelOf(r1)})`);
  if (b1 && b1.trim() === disk1.text.trim()) ok("it is exactly the block ClawBox wrote, marked \"Prime Radiant core\"" + (b1.includes("Prime Radiant core:") ? "" : " (no marker!)"));
  else if (b1) notOk("the block the gateway sent is not the one on disk");
  if (b1 && (typeof maxChars !== "number" || b1.length <= maxChars)) ok(`it is within maxChars (${b1.length} <= ${maxChars})`);
  else if (b1) notOk(`it is ${b1.length} chars, over maxChars ${maxChars}`);
  if (b1) {
    const listed = titlesOf(b1), order = await ranked(b1);
    const want = [T("alpha"), T("beta"), T("gamma")];
    if (order) notOk("it is not ranked by links: " + order);
    else if (exact && listed.join("|") !== want.join("|")) notOk(`it lists ${listed.join(", ")}; the 3 most-linked eligible pages are ${want.join(", ")}`);
    else ok(`it lists min(3, 6) = ${listed.length} pages, most linked first by the box graph: ${listed.map((t) => t.split(" ")[2]).join(", ")}`);
    const leak = leaks(b1);
    if (leak.length) notOk("a hidden page is in it: " + leak.join(", "));
    else ok("neither the confidential nor the secret-ref page is in it, though both have the most links");
  }

  const t1b = await turn(k1);
  const r1b = t1b.requests[t1b.requests.length - 1];
  if (t1b.requests.length <= t1.requests.length) notOk("the second turn of the session left no new trace record: " + failedTurn(t1b));
  else {
    const n = count(sysText(r1b), OPEN), hist = JSON.stringify(r1b.messages || []).includes("prime_radiant_core");
    if (n === 1 && !hist) ok(`the next turn of the same session still carries it once, and none of its ${r1b.messageCount ?? "?"} history messages does`);
    else notOk(`the next turn of the same session carries ${n} block(s) in its system prompt and ${hist ? "one in its history" : "none in its history"}`);
  }

  // 3. The own chat of a ClawBox user, and the on-device model.
  const ku = `agent:main:clawbox-user-nanoci${tag}`;
  const tu = await turn(ku);
  if (tu.requests.length === 0) notOk("the user-chat turn left no trace record: " + failedTurn(tu));
  else if (tu.requests.some((r) => sysText(r).includes(OPEN))) notOk("the own chat of a ClawBox user was sent the core block");
  else ok(`the own chat of a ClawBox user (agent:main:clawbox-user-…, ${modelOf(tu.requests[0])}) is sent no block`);

  const prov = await run(OPENCLAW, ["config", "get", "models.providers", "--json"], 90e3);
  let local = null;
  try {
    const o = JSON.parse(prov.stdout);
    for (const [id, v] of Object.entries(o || {})) {
      const m = v && Array.isArray(v.models) && v.models.find((x) => x && typeof x.id === "string");
      if (/^(llamacpp|ollama)/i.test(id) && m) { local = `${id}/${m.id}`; break; }
    }
  } catch {}
  if (!local) skip("no on-device model is set up on this board: a turn on one is the plugin unit test (the core names the turn model in the hook context)");
  else if (left() < 300e3) skip("out of time for the on-device model turn");
  else {
    const tl = await turn(keyOf("local"), ["--model", local]);
    const onDevice = tl.requests.filter((r) => /^(llamacpp|ollama)/i.test(modelOf(r)));
    if (onDevice.length === 0) skip(`the turn on ${local} never reached the model (${failedTurn(tl)})`);
    else if (onDevice.some((r) => sysText(r).includes(OPEN))) notOk(`a turn on the on-device model ${local} was sent the core block`);
    else ok(`a turn on the on-device model ${local} is sent no block`);
  }

  // 4. n=50, and a page set to confidential.
  p = await call("PUT", "/setup-api/prime-radiant/settings", { context: { n: 50 } });
  const cb50 = p.json && p.json.contextBlock;
  if (p.status !== 200 || !cb50) notOk("n=50 answered " + why(p));
  else if (exact && cb50.pages !== 6) notOk(`with n=50 the block lists ${cb50.pages} pages, not min(50, 6) = 6`);
  else ok(`with n=50 it lists min(50, eligible) = ${cb50.pages} pages`);
  const e = await call("PATCH", "/setup-api/prime-radiant/pages/" + PATH.alpha, { privacy: "confidential" });
  if (e.status !== 200) notOk("setting a page to confidential answered " + why(e));
  else {
    const t = Date.now();
    let d = readCore();
    while (d && d.text.includes(T("alpha")) && Date.now() - t < 30e3) { await sleep(1000); d = readCore(); }
    if (d && !d.text.includes(T("alpha"))) ok(`a page the owner sets to confidential leaves the block in ${secs(Date.now() - t)}, with no night`);
    else notOk("a page set to confidential is still in the block after 30 s");
  }

  // 5. A real nightly pass.
  const nightly0 = await call("GET", "/setup-api/prime-radiant/nightly");
  if (nightly0.json && nightly0.json.running) skip("a nightly pass was already running: there is no merge of ours to follow");
  else if (left() < 330e3) skip("out of time for a nightly pass");
  else {
    const pre = await git("rev-parse", "refs/heads/main");
    const pid0 = await gatewayPid(), up0 = await gatewayUptime();
    const start = await call("POST", "/setup-api/prime-radiant/nightly/run", {});
    const runId = start.json && start.json.run && start.json.run.id;
    if (start.status !== 202) notOk("starting a nightly pass answered " + why(start));
    else {
      const t = Date.now(), budget = Math.min(480e3, left() - 220e3);
      let head = pre, movedAt = 0, outcome = null, merged = false;
      while (Date.now() - t < budget) {
        await sleep(5000);
        head = await git("rev-parse", "refs/heads/main");
        const d = readCore();
        if (head && head !== pre) {
          if (!movedAt) movedAt = Date.now();
          if (d && d.revision === head) { merged = true; break; }
          if (Date.now() - movedAt > 60e3) break;
          continue;
        }
        const n = await call("GET", "/setup-api/prime-radiant/nightly");
        if (n.json && !n.json.running && Date.now() - t > 10e3) {
          const rec = (n.json.runs || []).find((x) => x && x.id === runId);
          outcome = rec ? `${rec.status}${rec.outcome ? " (" + rec.outcome + ")" : ""}` : "ended";
          break;
        }
      }
      if (merged) {
        const commits = (await git("rev-list", "--count", `${pre}..${head}`)) || "?";
        ok(`a real nightly pass moved main ${pre.slice(0, 8)}..${head.slice(0, 8)} (${commits} commit(s)) and the block was rebuilt from the merged main within ${secs(Date.now() - t)}`);
        const d = readCore();
        const tn = await turn(keyOf("after-night"));
        const rn = tn.requests[tn.requests.length - 1];
        if (!rn) notOk("the turn after the night left no trace record: " + failedTurn(tn));
        else {
          const sys = sysText(rn), b = blockOf(sys) || "";
          if (count(sys, OPEN) === 1 && d && b.trim() === d.text.trim() && b.includes(`revision="${head.slice(0, 12)}"`)) {
            ok(`the next new session carries the rebuilt block (revision ${head.slice(0, 12)}), ${titlesOf(b).length} pages`);
          } else notOk(`the next new session carries ${count(sys, OPEN)} block(s), ${b && d && b.trim() === d.text.trim() ? "the rebuilt one" : "not the rebuilt one"}`);
          const leak = leaks(b).concat(b.includes(T("alpha")) ? [T("alpha") + " (set to confidential)"] : []);
          if (leak.length) notOk("a hidden page is in the rebuilt block: " + leak.join(", "));
          else ok("no confidential or secret-ref page is in the rebuilt block");
        }
        const pid1 = await gatewayPid(), up1 = await gatewayUptime();
        if (!pid0 || pid0 === "0" || pid1 !== pid0) notOk(`the gateway process changed across the night (MainPID ${pid0} -> ${pid1})`);
        else if (up0 && up1 && up1.uptimeMs < up0.uptimeMs + (up1.at - up0.at) - 30e3) notOk(`the gateway restarted in its process across the night (uptime ${secs(up0.uptimeMs)} -> ${secs(up1.uptimeMs)})`);
        else ok(`with no gateway restart: the same MainPID ${pid1}` + (up0 && up1 ? `, its uptime ${secs(up0.uptimeMs)} -> ${secs(up1.uptimeMs)}` : " (the hello snapshot gave no uptime)"));
      } else if (movedAt) {
        notOk(`main moved (${pre.slice(0, 8)}..${head.slice(0, 8)}) but the block on disk did not follow within 60 s`);
      } else if (outcome) {
        skip(`the nightly pass merged nothing into main (${outcome}): no merge to follow`);
      } else {
        skip(`the nightly pass had not merged within ${secs(budget)}: no merge to follow`);
      }
    }
  }

  // 6. Off.
  p = await call("PUT", "/setup-api/prime-radiant/settings", { context: { enabled: false } });
  if (p.status !== 200 || p.json.contextBlock !== null || fs.existsSync(CORE)) notOk("turning it off left a block: " + why(p));
  else {
    const t0 = await turn(keyOf("off"));
    if (t0.requests.length === 0) notOk("the turn with the setting off left no trace record: " + failedTurn(t0));
    else if (t0.requests.some((r) => sysText(r).includes(OPEN))) notOk("with the setting off, a new session was sent the core block");
    else ok("off again: no block on disk, and a new main-agent session is sent none");
  }
  note(`${turns} agent turns in ${secs(Date.now() - T0)}`);
}

main()
  .catch((err) => notOk("the check failed: " + one(err && err.stack || err)))
  .finally(() => cleanup().catch((err) => notOk("cleanup failed: " + one(err && err.message || err))).finally(() => process.exit(0)));
'

# shellcheck disable=SC2016  # expanded on the board
out=$(board 'cd "$REPO" && exec timeout 860 node -e "$1" "$2" "$3"' "$FLOW" "$OPENCLAW_BIN" "$NANO_RUN_ID")
results=$(printf '%s\n' "$out" | grep '^RESULT ' | sed 's/^RESULT //')
if [ -z "$results" ]; then
  not_ok "the core block check printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  printf '%s\n' "$results" | while IFS= read -r line; do
    case "$line" in
      "ok - "*) ok "${line#ok - }" ;;
      "ok # SKIP "*) skip "${line#ok # SKIP }" ;;
      "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
      "# "*) note "${line#\# }" ;;
      *) note "$line" ;;
    esac
  done
  printf '%s\n' "$results" | grep -q '^not ok - ' && NANO_TEST_FAILED=1
fi
finish
