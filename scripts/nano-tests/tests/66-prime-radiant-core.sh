#!/usr/bin/env bash
# timeout: 900
# covers: scripts/openclaw-plugins/clawbox-prime-radiant-core/* src/lib/prime-radiant/core-context*.ts src/lib/prime-radiant/reindex-hook.ts src/app/setup-api/prime-radiant/settings/*
#
# The Prime Radiant core block on the real box, as the MODEL receives it from
# the pinned gateway. The check hosts a capture model on a loopback port (an
# OpenAI-compatible endpoint that answers and keeps each request), added for
# the test as two providers with `openclaw config set` and removed after it:
# `nanoci-core` (a cloud model to the plugin) and `llamacpp-nanoci-core` (an
# on-device one). Every turn is the owner's main agent through the gateway,
# `openclaw agent --agent main --model <capture>`, and every check reads the
# system prompt the capture model was sent. (The gateway's cache trace cannot
# serve: it redacts a system prompt that size.)
#
#   1. Off by default; the owner creates 8 linked pages: 6 eligible, and one
#      confidential and one secret-ref page that every other page links to.
#   2. The owner turns `context` on with n=3: a NEW session of the main agent
#      sends ONE block, exactly the one on disk, the 3 most-linked pages by
#      the box's own graph, within maxChars, neither hidden page in it; the
#      same session's next turn still sends it once, and its history none.
#   3. The own chat of a ClawBox user (agent:main:clawbox-user-…) and a turn
#      on an on-device model send none.
#   4. n=50 lists min(50, eligible) pages; a page the owner sets to
#      confidential leaves the block at once.
#   5. A real nightly pass merges into the vault's main: the block is rebuilt
#      from the merged main and the next new session sends it, with no
#      gateway restart (the same MainPID and start time, and no new startup
#      in the gateway's own log).
#   6. Off again: no file, and a new session sends no block.
# The pages, the setting and the providers are put back whatever happens. A
# SKIP for the night when it merged nothing (or held its branch): there was no
# merge to follow. When a block is missing, the core's own view of the plugin
# (`openclaw plugins inspect --runtime`, its config entry, the gateway log)
# and the installed plugin run with that turn's context are printed.
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
const GATEWAY_LOGS = "/tmp/openclaw";
const T0 = Date.now(), BUDGET_MS = 760e3;
const left = () => BUDGET_MS - (Date.now() - T0);
const out = (s) => console.log("RESULT " + s);
const ok = (s) => out("ok - " + s);
const notOk = (s) => out("not ok - " + s);
const skip = (s) => out("ok # SKIP " + s);
const note = (s) => out("# " + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const long = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const one = (s) => long(s, 300);
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

function run(file, args, ms, env) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms, maxBuffer: 32 << 20, ...(env ? { env } : {}) }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 124) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const git = async (...a) => (await run("git", ["-C", VAULT, ...a], 30e3)).stdout.trim();
const failed = (r) => `exit ${r.code}: ${one(r.stderr || r.stdout).slice(0, 240)}`;

// ---- the capture model ----------------------------------------------------------
const CAPTURED = [];
let capturePort = 0;
const partText = (m) => (typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n") : "");
function startCapture() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "capture", object: "model" }, { id: "capture-local", object: "model" }] }));
          return;
        }
        let j = {};
        try { j = JSON.parse(body); } catch {}
        const msgs = Array.isArray(j.messages) ? j.messages : [];
        const system = msgs.filter((m) => m && (m.role === "system" || m.role === "developer")).map(partText).join("\n");
        CAPTURED.push({ model: j.model, system, rest: msgs.filter((m) => m && m.role !== "system" && m.role !== "developer").map(partText) });
        const chunk = (o) => "data: " + JSON.stringify(o) + "\n\n";
        const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
        if (j.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(chunk({ id: "nano", object: "chat.completion.chunk", created: 0, model: j.model, choices: [{ index: 0, delta: { role: "assistant", content: "NANO-CORE-OK" }, finish_reason: null }] }));
          res.write(chunk({ id: "nano", object: "chat.completion.chunk", created: 0, model: j.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "nano", object: "chat.completion", created: 0, model: j.model, choices: [{ index: 0, message: { role: "assistant", content: "NANO-CORE-OK" }, finish_reason: "stop" }], usage }));
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { capturePort = server.address().port; server.unref(); resolve(server); });
  });
}
const CLOUD = "nanoci-core/capture", ON_DEVICE = "llamacpp-nanoci-core/capture-local";
const providerJson = (id) => JSON.stringify({
  baseUrl: `http://127.0.0.1:${capturePort}/v1`, api: "openai-completions", apiKey: "nano-ci-capture",
  models: [{ id, name: "nano-ci capture", contextWindow: 128000, maxTokens: 1024, reasoning: false, input: ["text"] }],
});

// ---- what the model was sent ----------------------------------------------------
const OPEN = "<prime_radiant_core ", CLOSE = "</prime_radiant_core>";
const count = (s, sub) => s.split(sub).length - 1;
function blockOf(s) {
  const a = s.indexOf(OPEN);
  if (a < 0) return null;
  const e = s.indexOf(CLOSE, a);
  return e < 0 ? s.slice(a) : s.slice(a, e + CLOSE.length);
}
const titlesOf = (block) => block.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(" — ")[0].trim());
function readCore() {
  try { const o = JSON.parse(fs.readFileSync(CORE, "utf8")); return o && typeof o.text === "string" ? o : null; } catch { return null; }
}
let turns = 0;
/** One turn of the main agent on `sessionKey` and `model`; answers the request the capture model got for it, or null. */
async function turn(sessionKey, model = CLOUD) {
  turns++;
  const nonce = "NANO-CORE-" + crypto.randomBytes(4).toString("hex");
  const r = await run(OPENCLAW, ["agent", "--agent", "main", "--session-key", sessionKey, "--model", model, "-m",
    "Reply with exactly this text and nothing else: " + nonce, "--json", "--timeout", "120"], 150e3);
  const mine = CAPTURED.filter((c) => c.rest.length > 0 && c.rest[c.rest.length - 1].includes(nonce));
  return { ...r, req: mine.length ? mine[mine.length - 1] : null };
}
const keyOf = (what) => `agent:main:nano-ci-core-${runTag}-${what}`;

// ---- the gateway process ------------------------------------------------------
function gatewayLogStarts() {
  try {
    return fs.readdirSync(GATEWAY_LOGS).filter((n) => /^openclaw-.*\.log$/.test(n))
      .reduce((n, f) => n + count(fs.readFileSync(path.join(GATEWAY_LOGS, f), "utf8"), "startup phase: ready"), 0);
  } catch { return null; }
}
async function gatewayIdentity() {
  const show = async (p) => (await run("systemctl", ["show", "clawbox-gateway.service", "-p", p, "--value"], 15e3)).stdout.trim();
  return { pid: await show("MainPID"), started: await show("ExecMainStartTimestampMonotonic"), starts: gatewayLogStarts() };
}

// ---- when the model got no block: where the chain broke ------------------------
const PLUGIN_ID = "clawbox-prime-radiant-core";
/** The installed plugin, run with one turn context: each of its decisions, and its answer. */
const PROBE = [
  "const [dir, key, provider, model, agentsJson] = process.argv.slice(1);",
  "const m = await import(dir + \"/prime-radiant-core.mjs\");",
  "const plugin = (await import(dir + \"/index.mjs\")).default;",
  "let agents; try { agents = JSON.parse(agentsJson); } catch {}",
  "const cfg = { agents: agents || undefined };",
  "const ctx = { sessionKey: key, agentId: \"main\", modelProviderId: provider, modelId: model };",
  "const main = m.mainAgentId(cfg), turn = m.turnModel(ctx, cfg, main), file = m.coreContextFile();",
  "const text = await m.createBlockReader(file)();",
  "let handler; plugin.register({ on: (name, fn) => { if (name === \"before_prompt_build\") handler = fn; }, config: cfg, runtime: { config: { current: () => cfg } } });",
  "const answer = handler ? await handler({ prompt: \"\", messages: [] }, ctx) : undefined;",
  "console.log(JSON.stringify({ file, blockOnDisk: text ? text.length : null, userKey: m.isUserChatKey(key), keyAgent: m.agentIdOfKey(key), main, turnModel: turn, onDevice: m.runsOnDevice(turn), hook: !!handler, answered: !!(answer && answer.appendSystemContext) }));",
].join("\n");
async function diagnose(key, model) {
  note("diagnosis: the model was sent no block, so what the core and the installed plugin say:");
  const dir = path.join(process.env.HOME, ".openclaw", "extensions", PLUGIN_ID);
  let files;
  try { files = fs.readdirSync(dir).join(", "); } catch (e) { files = "none (" + e.code + ")"; }
  note("installed files: " + files);
  const ent = await run(OPENCLAW, ["config", "get", "plugins.entries." + PLUGIN_ID, "--json"], 90e3);
  note("plugins.entries." + PLUGIN_ID + ": " + long(ent.stdout || ent.stderr, 400));
  const ag = await run(OPENCLAW, ["config", "get", "agents", "--json"], 90e3);
  let agents = null;
  try { agents = JSON.parse(ag.stdout); } catch {}
  const roster = agents ? {
    entries: agents.entries && Object.fromEntries(Object.entries(agents.entries).map(([k, v]) => [k, { default: !!(v && v.default), model: v && v.model }])),
    list: Array.isArray(agents.list) ? agents.list.map((a) => ({ id: a && a.id, default: !!(a && a.default), model: a && a.model })) : undefined,
    defaultModel: agents.defaults && agents.defaults.model,
  } : null;
  note("agents: " + long(roster ? JSON.stringify(roster) : ag.stderr, 600));
  const insp = await run(OPENCLAW, ["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"], 180e3);
  let o = null;
  try { o = JSON.parse(insp.stdout.slice(insp.stdout.indexOf("{"))); } catch {}
  if (o) {
    const p = o.plugin || {};
    note("plugins inspect --runtime: " + long(JSON.stringify({
      status: p.status, enabled: p.enabled, activated: p.activated, origin: p.origin, error: p.error,
      typedHooks: (o.typedHooks || []).map((h) => h.name),
      diagnostics: (o.diagnostics || []).map((d) => d.level + ": " + d.message),
    }), 1500));
  } else note("plugins inspect --runtime gave no JSON: " + failed(insp));
  let logged = [];
  try {
    for (const f of fs.readdirSync(GATEWAY_LOGS).filter((n) => /^openclaw-.*\.log$/.test(n))) {
      const full = path.join(GATEWAY_LOGS, f);
      if (Date.now() - fs.statSync(full).mtimeMs > 6 * 3600e3) continue;
      logged = logged.concat(fs.readFileSync(full, "utf8").split("\n").filter((l) => l.includes(PLUGIN_ID) || l.includes("before_prompt_build") || l.includes("appendSystemContext")));
    }
  } catch (e) { logged.push("(the gateway log could not be read: " + e.code + ")"); }
  note(`the gateway log names the plugin or the hook on ${logged.length} line(s)` + (logged.length ? ", the last ones:" : ""));
  for (const l of logged.slice(-10)) note("  " + long(l, 400));
  const env = { ...process.env };
  for (const k of ["CLAWBOX_ROOT", "PRIME_RADIANT_DIR", "CLAWBOX_HOME_DIR"]) delete env[k];
  const [provider, id] = [model.split("/")[0], model.split("/").slice(1).join("/")];
  const pr = await run(process.execPath, ["--input-type=module", "-e", PROBE, dir, key, provider, id, JSON.stringify(agents)], 60e3, env);
  note("the installed plugin with this turn context, in the gateway environment: " + long(pr.stdout || pr.stderr, 900));
}

// ---- put back whatever happens ------------------------------------------------
const MADE = [];
/** The test providers actually added: `config unset` of one that is not there exits 1. */
const ADDED = [];
let PRIOR = null, cleaned = false;
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
  for (const id of ADDED) {
    const r = await run(OPENCLAW, ["config", "unset", "models.providers." + id], 90e3);
    if (r.code !== 0) notOk(`the test provider ${id} could not be removed: ` + failed(r));
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

  // The capture model, as two providers of the gateway.
  await startCapture();
  for (const [id, model] of [["nanoci-core", "capture"], ["llamacpp-nanoci-core", "capture-local"]]) {
    const r = await run(OPENCLAW, ["config", "set", "models.providers." + id, providerJson(model), "--strict-json"], 90e3);
    if (r.code !== 0) return notOk(`adding the capture model as provider ${id} failed: ` + failed(r));
    ADDED.push(id);
  }
  await sleep(5000);

  // 2. On, n=3, and a new session of the main agent.
  let p = await call("PUT", "/setup-api/prime-radiant/settings", { context: { enabled: true, n: 3 } });
  const maxChars = p.json && p.json.settings && p.json.settings.context && p.json.settings.context.maxChars;
  const cb = p.json && p.json.contextBlock;
  if (p.status !== 200 || !cb) return notOk("turning the core block on answered " + why(p) + " (contextBlock " + one(JSON.stringify(cb)) + ")");
  const disk1 = readCore();
  if (!disk1) return notOk("the core block is on, yet no block is on disk");
  ok(`the owner turned it on with n=3: ${cb.pages} pages, ${cb.chars} chars (~${cb.estTokens} tokens a turn) on disk`);

  let k1 = keyOf("main"), t1 = await turn(k1);
  if (!t1.req) {
    note(`the first turn never reached the capture model (${failed(t1)}): the providers may not be applied yet, once more in 10 s`);
    await sleep(10e3);
    k1 = keyOf("main-again");
    t1 = await turn(k1);
  }
  if (!t1.req) return notOk("a main-agent turn on the capture model never reached it: " + failed(t1));
  const sys1 = t1.req.system, b1 = blockOf(sys1) || "", n1 = count(sys1, OPEN);
  if (n1 === 1) ok(`a new session of the main agent sent the model ONE Prime Radiant core block in its system prompt (${b1.length} of ${sys1.length} chars)`);
  else notOk(`a new session of the main agent sent the model ${n1} Prime Radiant core blocks (system prompt ${sys1.length} chars)`);
  if (n1 === 0) await diagnose(k1, CLOUD);
  if (b1 && b1.trim() === disk1.text.trim()) ok("it is exactly the block ClawBox wrote, marked \"Prime Radiant core\"" + (b1.includes("Prime Radiant core:") ? "" : " (no marker!)"));
  else if (b1) notOk("the block the model got is not the one on disk");
  if (b1 && (typeof maxChars !== "number" || b1.length <= maxChars)) ok(`it is within maxChars (${b1.length} <= ${maxChars})`);
  else if (b1) notOk(`it is ${b1.length} chars, over maxChars ${maxChars}`);
  if (b1) {
    const listed = titlesOf(b1), order = await ranked(b1);
    const want = [T("alpha"), T("beta"), T("gamma")];
    if (order) notOk("it is not ranked by links: " + order);
    else if (exact && listed.join("|") !== want.join("|")) notOk(`it lists ${listed.join(", ")}; the 3 most-linked eligible pages are ${want.join(", ")}`);
    else ok(`it lists min(3, 6) = ${listed.length} pages with their summaries, most linked first by the box graph: ${listed.map((t) => t.split(" ")[2]).join(", ")}`);
    const leak = leaks(b1);
    if (leak.length) notOk("a hidden page is in it: " + leak.join(", "));
    else ok("neither the confidential nor the secret-ref page is in it, though both have the most links");
  }

  const t1b = await turn(k1);
  if (!t1b.req) notOk("the next turn of the session never reached the capture model: " + failed(t1b));
  else {
    const n = count(t1b.req.system, OPEN), hist = t1b.req.rest.some((t) => t.includes("prime_radiant_core"));
    if (t1b.req.rest.length < 3) notOk(`the next turn of the session sent ${t1b.req.rest.length} message(s): no history to look in`);
    else if (n === 1 && !hist) ok(`the next turn of the same session still sends it once, and none of its ${t1b.req.rest.length} history messages does`);
    else notOk(`the next turn of the same session sends ${n} block(s) in its system prompt and ${hist ? "one in its history" : "none in its history"}`);
  }

  // 3. The own chat of a ClawBox user, and an on-device model.
  const tu = await turn(`agent:main:clawbox-user-nanoci${tag}`);
  if (!tu.req) notOk("the user-chat turn never reached the capture model: " + failed(tu));
  else if (tu.req.system.includes(OPEN)) notOk("the own chat of a ClawBox user was sent the core block");
  else ok("the own chat of a ClawBox user (agent:main:clawbox-user-…) is sent no block");
  const tl = await turn(keyOf("on-device"), ON_DEVICE);
  if (!tl.req) notOk(`the turn on the on-device model ${ON_DEVICE} never reached the capture model: ` + failed(tl));
  else if (tl.req.system.includes(OPEN)) notOk(`a turn on the on-device model ${ON_DEVICE} was sent the core block`);
  else ok(`a turn of the main agent on an on-device model (${ON_DEVICE}) is sent no block`);

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
    const id0 = await gatewayIdentity();
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
        if (!tn.req) notOk("the turn after the night never reached the capture model: " + failed(tn));
        else {
          const sys = tn.req.system, b = blockOf(sys) || "";
          if (count(sys, OPEN) === 1 && d && b.trim() === d.text.trim() && b.includes(`revision="${head.slice(0, 12)}"`)) {
            ok(`the next new session sends the rebuilt block (revision ${head.slice(0, 12)}), ${titlesOf(b).length} pages`);
          } else notOk(`the next new session sends ${count(sys, OPEN)} block(s), ${b && d && b.trim() === d.text.trim() ? "the rebuilt one" : "not the rebuilt one"}`);
          const leak = leaks(b).concat(b.includes(T("alpha")) ? [T("alpha") + " (set to confidential)"] : []);
          if (leak.length) notOk("a hidden page is in the rebuilt block: " + leak.join(", "));
          else ok("no confidential or secret-ref page is in the rebuilt block");
        }
        const id1 = await gatewayIdentity();
        if (!id0.pid || id0.pid === "0" || id1.pid !== id0.pid || id1.started !== id0.started) notOk(`the gateway process changed across the night (MainPID ${id0.pid} -> ${id1.pid})`);
        // Only a NEW startup line is a restart: the core prunes day-old logs and old archives, so the count may drop.
        else if (id0.starts !== null && id1.starts !== null && id1.starts > id0.starts) notOk(`the gateway started again in its process across the night (${id1.starts - id0.starts} new startup(s) in its log)`);
        else ok(`with no gateway restart: the same MainPID ${id1.pid} and start time` + (id1.starts !== null ? ", and no new startup in the gateway log" : " (its log was not readable)"));
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
    if (!t0.req) notOk("the turn with the setting off never reached the capture model: " + failed(t0));
    else if (t0.req.system.includes(OPEN)) notOk("with the setting off, a new session was sent the core block");
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
