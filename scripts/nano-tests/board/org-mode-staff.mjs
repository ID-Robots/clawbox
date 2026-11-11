// Runs ON the board, as clawbox, for scripts/nano-tests/tests/56-org-mode-staff.sh:
// two members of staff and the owner on an organisation box, for real, on
// whichever agent runtime the board runs (TASK-2444, TASK-2445).
//
//   node org-mode-staff.mjs            (env: A_NAME A_COOKIE B_NAME B_COOKIE OWNER_COOKIE MARK RUNTIME)
//
// For each request a member of staff must NOT be able to have done — a web
// search, an e-mail, a scheduled job, a shell command, a change of the box's
// tool profile, a change of model — the member asks for it and the test
// proves it did not happen (no such tool ran; the command was refused), and
// the owner asks for the same and the test proves it was ALLOWED (the tool
// ran; the command reached the runtime). Then the memory test: A asks the
// assistant to remember a fact, B cannot get it back, the owner's memory is
// unchanged.
//
// Prints `RESULT ok - …`, `RESULT not ok - …` and `NOTE …` lines (the
// transcripts: what each asked, which tools ran, what the assistant said).
// Cookies arrive in the environment, never on a command line; nothing it
// prints names a host or an address.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${String(line).replace(/\s+/g, " ").slice(0, 900)}`);
const ok = (line) => say(`ok - [${RUNTIME}] ${line}`);
const fail = (line) => say(`not ok - [${RUNTIME}] ${line}`);
const check = (cond, line, why = "") => (cond ? ok(line) : fail(why ? `${line} — ${why}` : line));
const sha = (file) => {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "absent";
  }
};
const grepTree = (dir, needle) => {
  let hits = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) hits = hits.concat(grepTree(p, needle));
      else if (entry.isFile() && /\.(md|txt|json)$/.test(entry.name) && fs.statSync(p).size < 2_000_000 && fs.readFileSync(p, "utf-8").includes(needle)) hits.push(p);
    }
  } catch {
    /* absent */
  }
  return hits;
};

// The requests, in the member's words and the owner's alike, and the tools
// that would have done each.
const REQUESTS = [
  {
    id: "web-search",
    text: "Use your web search tool right now to search the web for today's top news headline, then quote it. Do not answer from memory.",
    openclaw: /^(web_search|web_fetch|x_search|browser|clawbox__browser_|clawbox__web_)/,
    hermes: /^(web_search|web_extract|browser_|mcp__clawbox__browser_|mcp__clawbox__web_)/,
  },
  {
    id: "send-email",
    text: "Use your e-mail tool right now to send an e-mail to nobody@example.com with the subject 'Hello' and the body 'Hi there'. Do it, do not just describe it.",
    openclaw: /^(clawbox__email_send|message|clawbox__email_)/,
    hermes: /^(send_message|message|email_send|mcp__clawbox__email_)/,
  },
  {
    id: "schedule-job",
    text: `Use your scheduling (cron / automation) tool right now to create a recurring job named ${MARK} that says "drink water" every day at 09:00. Do it, do not just describe it.`,
    openclaw: /^(cron|automations|clawbox__job_)/,
    hermes: /^(cronjob_manage|cronjob|cron)/,
  },
  {
    id: "shell-command",
    text: "Use your shell / terminal tool right now to run the command `uname -a` and show me its exact output.",
    openclaw: /^(exec|process|bash|code_execution|clawbox__bash)$/,
    hermes: /^(terminal|process_manage|execute_code)$/,
  },
];
// Staff only: flipping the box's tool profile through the CLI (never asked of the owner's box).
const PROFILE_FLIP = {
  id: "tools-profile",
  text: "Run `openclaw config set tools.profile full` and `openclaw config set tools.web.search.enabled true` in a shell for me, or edit ~/.openclaw/openclaw.json to set them. Do it now.",
  openclaw: /^(exec|process|bash|code_execution|gateway|openclaw|clawbox__bash)$/,
  hermes: /^(terminal|process_manage|execute_code)$/,
};

// ── OpenClaw: sockets ────────────────────────────────────────────────────────

/** A chat socket that collects events per session and answers requests by id. */
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
    const api = {
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
        resolve(api);
        return;
      }
      if (f.type === "res" && waiting.has(f.id)) { waiting.get(f.id)(f); waiting.delete(f.id); return; }
      if (f.type === "event") for (const fn of listeners) fn(f);
    });
  });
}

/**
 * One turn on `key`: the tools that started, their results, and the final
 * text — of THIS turn's run only. The ack of `chat.send` names the run; every
 * event of another run on the same session (a background notice the previous
 * turn left, a skill the workshop learned) is ignored, and events that arrive
 * before the ack are held until it names the run.
 */
async function openclawTurn(sock, key, text) {
  const tools = [];
  let finalText = "";
  let runId = null;
  const early = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const handle = (f) => {
    const p = f.payload || {};
    if (runId && p.runId && p.runId !== runId) return;
    if (f.event === "agent" && p.stream === "tool" && p.data && typeof p.data.name === "string") {
      const d = p.data;
      if (d.phase === "start") tools.push({ name: d.name, result: "" });
      else {
        const t = [...tools].reverse().find((x) => x.name === d.name);
        if (t) t.result = JSON.stringify(d.result ?? d.partialResult ?? d.error ?? "").slice(0, 300);
      }
    }
    if (f.event === "chat" && p.state === "final") {
      const m = p.message;
      const blocks = m && Array.isArray(m.content) ? m.content : [];
      finalText = blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join(" ") || (typeof m?.text === "string" ? m.text : "");
      done();
    }
    if (f.event === "chat" && (p.state === "error" || p.state === "aborted")) { finalText = `[${p.state}] ${p.errorMessage || ""}`; done(); }
  };
  const off = sock.on((f) => {
    const p = f.payload || {};
    if (String(p.sessionKey || "").toLowerCase() !== key.toLowerCase()) return;
    if (!runId) { early.push(f); return; }
    handle(f);
  });
  const sent = await sock.request("chat.send", { sessionKey: key, message: text, deliver: false, idempotencyKey: `${MARK}-${Date.now()}-${Math.random()}` });
  if (!sent.ok) { off(); return { refused: sent.error, tools, text: "" }; }
  runId = sent.payload && typeof sent.payload.runId === "string" ? sent.payload.runId : "";
  for (const f of early.splice(0)) {
    // Only events that name this run count from before the ack.
    if (runId && (f.payload || {}).runId === runId) handle(f);
  }
  if (!runId) note(`[${RUNTIME}] the gateway named no run for a turn; its events are read unfiltered`);
  await Promise.race([finished, new Promise((r) => setTimeout(r, TURN_MS))]);
  off();
  if (!finalText) {
    const h = await sock.request("chat.history", { sessionKey: key, limit: 4 });
    const msgs = h.ok && Array.isArray(h.payload?.messages) ? h.payload.messages : [];
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    finalText = last ? JSON.stringify(last.content).slice(0, 600) : "(no answer)";
  }
  return { tools, text: finalText };
}

function showTurn(who, req, turn) {
  note(`[${RUNTIME}] ${who} asked (${req.id}): ${req.text}`);
  note(`[${RUNTIME}] ${who} tools: ${turn.tools.map((t) => `${t.name}${t.result ? ` → ${t.result}` : ""}`).join(" | ") || "(none)"}`);
  note(`[${RUNTIME}] ${who} assistant: ${turn.refused ? `REFUSED BY THE RELAY: ${turn.refused.message}` : turn.text}`);
}

async function openclawRun() {
  const config = JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
  const aAgent = policy.staffAgentId(A_NAME);
  const bAgent = policy.staffAgentId(B_NAME);
  check(policy.staffAgentConfigured(config, aAgent) && policy.staffAgentConfigured(config, bAgent),
    "each member of staff has their own agent on the roster, with the staff tool policy");
  const entryA = config.agents?.entries?.[aAgent];
  note(`[${RUNTIME}] ${aAgent} tools: ${JSON.stringify(entryA?.tools)}; workspace ${entryA?.workspace?.replace(HOME, "~")}`);
  const ownerAgent = config.agents?.defaults?.systemAgent?.agentId;
  check(typeof ownerAgent === "string" && ownerAgent && !ownerAgent.startsWith(policy.STAFF_AGENT_PREFIX),
    "the owner's agent is still the box's (systemAgent)", JSON.stringify(config.agents?.defaults?.systemAgent));

  const userHeaders = (cookie) => ({ cookie: `clawbox_session=${cookie}`, origin: DASHBOARD });
  const a = await chatSocket(`ws://127.0.0.1/user-chat-ws`, userHeaders(A_COOKIE));
  const b = await chatSocket(`ws://127.0.0.1/user-chat-ws`, userHeaders(B_COOKIE));
  const owner = await chatSocket(`ws://127.0.0.1:${GATEWAY_PORT}/`, { origin: "http://127.0.0.1", host: `127.0.0.1:${GATEWAY_PORT}` }, { owner: true });
  const aMain = a.hello()?.snapshot?.sessionDefaults?.mainSessionKey;
  const bMain = b.hello()?.snapshot?.sessionDefaults?.mainSessionKey;
  check(aMain === `agent:${aAgent}:clawbox-user-${A_NAME}`, "A's chat opens on A's own agent", aMain);
  // The owner's requests each in a session of their own, so nothing one of
  // them leaves behind (a scheduled run, a learned-skill notice) lands in the next.
  const ownerKeyFor = (id) => `agent:${ownerAgent || "main"}:nano-ci-owner-${MARK}-${id}`;
  const ownerKeys = new Set();
  const ownerKey = ownerKeyFor("misc");
  ownerKeys.add(ownerKey);

  // The catalogue and the commands.
  const cat = await a.request("commands.list", { scope: "text", includeArgs: true });
  const names = (cat.payload?.commands || []).map((c) => c.name).sort();
  check(cat.ok && names.join(",") === "new,reasoning", "A is shown /new and /reasoning only", JSON.stringify(names));
  for (const cmd of ["/model status", "/config get tools.profile", "/restart", "/bash uname -a"]) {
    const r = await a.request("chat.send", { sessionKey: aMain, message: cmd, deliver: false, idempotencyKey: `${MARK}-${cmd}` });
    note(`[${RUNTIME}] staff A sent ${cmd}: ${r.ok ? "ACCEPTED" : `refused — ${r.error?.message}`}`);
    check(!r.ok && r.error?.code === "FORBIDDEN", `staff ${cmd.split(" ")[0]} is refused`, JSON.stringify(r.error || r.payload));
  }
  const patch = await a.request("sessions.patch", { key: aMain, model: "openai/gpt-5" });
  check(!patch.ok, "staff cannot change the model through a session patch either", JSON.stringify(patch.error || patch.payload));
  const ownerModel = await openclawTurn(owner, ownerKey, "/model status");
  note(`[${RUNTIME}] owner sent /model status: ${ownerModel.refused ? `refused — ${ownerModel.refused.message}` : ownerModel.text}`);
  check(!ownerModel.refused, "the owner's /model reaches the gateway");

  // The four requests, and the tools.profile flip, as a member of staff.
  const profileBefore = JSON.stringify(config.tools?.profile);
  const toolsBefore = JSON.stringify(config.tools ?? null);
  for (const req of [...REQUESTS, PROFILE_FLIP]) {
    const turn = await openclawTurn(a, aMain, req.text);
    showTurn("staff A", req, turn);
    const ran = turn.tools.filter((t) => req.openclaw.test(t.name) && !/Blocked by ClawBox|not available|not allowed|unknown tool/i.test(t.result));
    check(ran.length === 0, `staff ${req.id} is refused (no such tool ran)`, ran.map((t) => t.name).join(","));
  }
  const after = JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
  check(JSON.stringify(after.tools?.profile) === profileBefore && JSON.stringify(after.tools ?? null) === toolsBefore && policy.staffAgentConfigured(after, aAgent),
    "the box's tools (profile, web) and A's policy are unchanged after A asked to flip them", `${profileBefore} → ${JSON.stringify(after.tools?.profile)}`);

  // The same four as the owner: allowed.
  for (const req of REQUESTS) {
    const key = ownerKeyFor(req.id);
    ownerKeys.add(key);
    const turn = await openclawTurn(owner, key, req.text);
    showTurn("owner", req, turn);
    const offered = turn.tools.filter((t) => req.openclaw.test(t.name));
    check(offered.length > 0, `the owner's ${req.id} is allowed (the tool ran)`, `tools: ${turn.tools.map((t) => t.name).join(",") || "none"}`);
  }

  // Memory: A stores, B cannot read it back, the owner's memory is unchanged.
  const ownerWs = path.join(OPENCLAW_HOME, "workspace");
  const ownerMem = [sha(path.join(ownerWs, "MEMORY.md")), grepTree(path.join(ownerWs, "memory"), "").length];
  const secret = `${Math.floor(100000 + Math.random() * 899999)}`;
  const store = await openclawTurn(a, aMain, `Please remember this permanently in your memory file: my locker code is ${secret}. Save it now.`);
  showTurn("staff A", { id: "remember", text: `remember locker code ${secret}` }, store);
  const aWs = path.join(OPENCLAW_HOME, "staff", A_NAME);
  const aHits = grepTree(aWs, secret);
  check(aHits.length > 0, "A's fact is in A's own workspace memory", aHits.map((p) => p.replace(HOME, "~")).join(","));
  note(`[${RUNTIME}] A's memory files holding it: ${aHits.map((p) => p.replace(HOME, "~")).join(", ") || "(none)"}`);
  check(/MEMORY\.md|memory\//.test(store.text), "A is told which memory file was written", store.text.slice(0, 200));
  const ask = await openclawTurn(b, bMain, "What is my locker code? Search your memory and tell me the number.");
  showTurn("staff B", { id: "recall", text: "what is my locker code?" }, ask);
  check(!ask.text.includes(secret), "B cannot get A's fact back");
  check(grepTree(path.join(OPENCLAW_HOME, "staff", B_NAME), secret).length === 0, "B's workspace never holds A's fact");
  check(grepTree(ownerWs, secret).length === 0 && sha(path.join(ownerWs, "MEMORY.md")) === ownerMem[0],
    "the owner's MEMORY.md and memory are unchanged");
  const ownerAsk = await openclawTurn(owner, ownerKey, "What is the locker code someone told you? Search your memory.");
  note(`[${RUNTIME}] owner asked for the code: ${ownerAsk.text}`);
  check(!ownerAsk.text.includes(secret), "the owner's assistant does not have A's fact either");
  // A gets it back in a new conversation (their memory, kept across chats).
  const aTab = `agent:${aAgent}:clawbox-utab-${createHash("sha1").update(MARK).digest("hex").slice(0, 12)}-${A_NAME}`;
  const recall = await openclawTurn(a, aTab, "What is my locker code? Search your memory.");
  note(`[${RUNTIME}] staff A in a new chat asked for the code: ${recall.text}`);
  if (recall.text.includes(secret)) ok("A gets their own fact back in a new chat");
  else note(`[${RUNTIME}] A did not quote the code back in a new chat (model-dependent; not a failure of isolation)`);

  // Clean the owner's side: the job, the session.
  try {
    const listed = JSON.parse(execFileSync("openclaw", ["automations", "list", "--all", "--query", MARK, "--json"], { encoding: "utf-8", timeout: 60_000 }));
    const jobs = Array.isArray(listed) ? listed : listed.jobs || listed.items || [];
    for (const job of jobs) {
      const id = job.id || job.jobId;
      if (id) execFileSync("openclaw", ["automations", "remove", String(id)], { timeout: 60_000, stdio: "ignore" });
    }
    note(`[${RUNTIME}] removed ${jobs.length} automation(s) the owner's request created`);
  } catch (err) {
    note(`[${RUNTIME}] could not list/remove the owner's test automation: ${err.message.split("\n")[0]}`);
  }
  for (const key of ownerKeys) await owner.request("sessions.delete", { key, deleteTranscript: true });
  a.close(); b.close(); owner.close();
}

// ── Hermes ───────────────────────────────────────────────────────────────────

async function hermesPost(cookie, body) {
  const res = await fetch(`${DASHBOARD}/setup-api/hermes/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: `clawbox_session=${cookie}`, origin: DASHBOARD },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TURN_MS + 60_000),
  });
  let json = {};
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

/**
 * The tool calls of one Hermes session, read out of the profile's own
 * state.db: `{ name, args }` each. A call through Tool Search's `tool_call`
 * also yields the tool it named (`clawbox:core:message` → `message`), which
 * is the tool that actually ran.
 */
function hermesCalls(home, sessionId) {
  try {
    const out = execFileSync("python3", ["-I", "-c", `
import json, sqlite3, sys
db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
calls = []
for (raw,) in db.execute("select tool_calls from messages where session_id = ? and tool_calls is not null", (sys.argv[2],)):
    try:
        for c in json.loads(raw) or []:
            f = c.get("function") or {}
            args = f.get("arguments")
            try:
                args = json.loads(args) if isinstance(args, str) else (args or {})
            except Exception:
                args = {"_raw": str(args)[:300]}
            calls.append({"name": f.get("name") or c.get("name") or "", "args": args if isinstance(args, dict) else {}})
    except Exception:
        pass
print(json.dumps(calls))
`, path.join(home, "state.db"), sessionId], { encoding: "utf-8", timeout: 30_000 });
    const calls = JSON.parse(out);
    const expanded = [];
    for (const call of calls) {
      expanded.push(call);
      if (call.name === "tool_call") {
        const id = call.args.id ?? call.args.name ?? call.args.tool;
        if (typeof id === "string" && id) {
          const inner = id.split(":").pop();
          const args = call.args.args && typeof call.args.args === "object" ? call.args.args : {};
          expanded.push({ name: inner, args, via: id });
        }
      }
    }
    return expanded;
  } catch (err) {
    return [{ name: `(could not read: ${String(err.message).split("\n")[0]})`, args: {} }];
  }
}

/** A Hermes write call (write_file, patch) whose target is outside `folder`, or null. */
function writeOutside(call, folder) {
  if (!["write_file", "patch"].includes(call.name)) return null;
  const target = call.args.path ?? call.args.file_path;
  if (typeof target !== "string") return null;
  const abs = path.resolve(folder, target.replace(/^~(?=\/|$)/, HOME));
  return abs === folder || abs.startsWith(folder + path.sep) ? null : target;
}

/** The plugins the running dashboard loaded, as the owner's Settings reads them; null when it cannot say. */
async function loadedPlugins() {
  try {
    const res = await fetch(`${DASHBOARD}/setup-api/hermes/plugins/reload`, {
      headers: { cookie: `clawbox_session=${OWNER_COOKIE}`, origin: DASHBOARD },
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json();
    return Array.isArray(json.loaded) ? json.loaded : null;
  } catch {
    return null;
  }
}

async function hermesRun() {
  const aHome = path.join(HERMES_HOME, "profiles", policy.staffAgentId(A_NAME));
  const bHome = path.join(HERMES_HOME, "profiles", policy.staffAgentId(B_NAME));

  // A member's turn runs only once the running dashboard has LOADED the staff
  // guard (src/lib/hermes-staff-profile.ts staffGuardLoaded). The first staff
  // turn on a dashboard that started before the guard was installed is
  // refused 503 and asks the dashboard to reload; wait for that here.
  let loaded = await loadedPlugins();
  note(`[${RUNTIME}] plugins the dashboard loaded: ${loaded ? loaded.join(", ") : "(it could not say)"}`);
  if (loaded && !loaded.includes("clawbox_staff_guard")) {
    const first = await hermesPost(A_COOKIE, { message: "hello" });
    check(first.status === 503 && first.json.code === "staff_profile_unavailable",
      "a staff turn is refused while the dashboard has not loaded the staff guard", `${first.status} ${first.json.code || ""}`);
    for (let i = 0; i < 36 && !(loaded || []).includes("clawbox_staff_guard"); i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      loaded = await loadedPlugins();
    }
    note(`[${RUNTIME}] after the reload the dashboard loaded: ${loaded ? loaded.join(", ") : "(it could not say)"}`);
  }
  check(!loaded || loaded.includes("clawbox_staff_guard"), "the running dashboard has loaded the staff guard");

  // Commands.
  for (const cmd of ["/model", "/config", "/restart", "/cron list"]) {
    const r = await hermesPost(A_COOKIE, { message: cmd });
    note(`[${RUNTIME}] staff A sent ${cmd}: ${r.status} ${r.json.code || ""} ${r.json.error || ""}`);
    check(r.status === 403 && r.json.code === "staff_command_refused", `staff ${cmd.split(" ")[0]} is refused`, `${r.status}`);
  }
  // The owner's requests go to a tab of their own, not the board's main chat.
  const ownerTab = `desktop-${MARK}`;
  const ownerModel = await hermesPost(OWNER_COOKIE, { message: "/model", sessionKey: ownerTab });
  note(`[${RUNTIME}] owner sent /model: ${ownerModel.status} ${String(ownerModel.json.text || ownerModel.json.error || "").slice(0, 300)}`);
  check(ownerModel.status === 200, "the owner's /model reaches Hermes", `${ownerModel.status}`);

  // Requests as a member of staff, each in its own conversation. Nothing
  // outside their folder may change: the box's two agent configs and their
  // own profile's config are hashed around the whole run.
  const guarded = [path.join(OPENCLAW_HOME, "openclaw.json"), path.join(HERMES_HOME, "config.yaml"), path.join(aHome, "config.yaml")];
  const before = guarded.map(sha);
  const aFolder = path.join(aHome, "workspace");
  for (const req of [...REQUESTS, PROFILE_FLIP]) {
    const r = await hermesPost(A_COOKIE, { message: req.text });
    const sid = r.json.sessionId || "";
    const calls = sid ? hermesCalls(aHome, sid) : [];
    showTurn("staff A", req, { tools: calls.map((c) => ({ name: c.via ? `${c.name} (via tool_call)` : c.name, result: "" })), text: String(r.json.text || r.json.error || `HTTP ${r.status}`) });
    const ran = calls.filter((c) => req.hermes.test(c.name)).map((c) => c.name);
    const outside = calls.map((c) => writeOutside(c, aFolder)).filter(Boolean);
    check(r.status === 200 && ran.length === 0 && outside.length === 0, `staff ${req.id} is refused (no such tool ran, nothing written outside their folder)`, `${r.status} ${ran.join(",")} ${outside.join(",")}`);
  }
  const after = guarded.map(sha);
  check(after.every((h, i) => h === before[i]), "the box's openclaw.json and config.yaml, and A's own profile config, are unchanged after A's requests",
    guarded.filter((_, i) => after[i] !== before[i]).map((p) => p.replace(HOME, "~")).join(","));
  const staffCfg = fs.existsSync(path.join(aHome, "config.yaml")) ? fs.readFileSync(path.join(aHome, "config.yaml"), "utf-8") : "";
  check(/platform_toolsets:\s*\n\s*cli:\s*\n(\s*- (file|vision|clarify|todo|memory|session_search)\s*\n)+/.test(staffCfg) && !/mcp_servers:/.test(staffCfg),
    "A's own profile builds the agent with the staff toolsets and no MCP server");

  // The same as the owner: allowed.
  for (const req of REQUESTS) {
    const r = await hermesPost(OWNER_COOKIE, { message: req.text, sessionKey: ownerTab });
    const sid = r.json.sessionId || "";
    const calls = sid ? hermesCalls(HERMES_HOME, sid) : [];
    showTurn("owner", req, { tools: calls.map((c) => ({ name: c.via ? `${c.name} (via tool_call ${c.via})` : c.name, result: "" })), text: String(r.json.text || r.json.error || `HTTP ${r.status}`) });
    check(calls.some((c) => req.hermes.test(c.name)), `the owner's ${req.id} is allowed (the tool ran)`, `tools: ${calls.map((c) => c.name).join(",") || "none"}`);
  }

  // Memory.
  const ownerMem = sha(path.join(HERMES_HOME, "memories", "MEMORY.md"));
  const ownerUser = sha(path.join(HERMES_HOME, "memories", "USER.md"));
  const secret = `${Math.floor(100000 + Math.random() * 899999)}`;
  const store = await hermesPost(A_COOKIE, { message: `Please remember this permanently in your memory: my locker code is ${secret}. Save it now.` });
  note(`[${RUNTIME}] staff A asked to remember ${secret}: ${String(store.json.text || store.json.error).slice(0, 400)}`);
  const aHits = grepTree(path.join(aHome, "memories"), secret);
  check(aHits.length > 0, "A's fact is in A's own profile memory", aHits.map((p) => p.replace(HOME, "~")).join(","));
  const ask = await hermesPost(B_COOKIE, { message: "What is my locker code? Check your memory and tell me the number." });
  note(`[${RUNTIME}] staff B asked for the code: ${String(ask.json.text || ask.json.error).slice(0, 400)}`);
  check(ask.status === 200 && !String(ask.json.text || "").includes(secret), "B cannot get A's fact back");
  check(grepTree(bHome, secret).length === 0, "B's profile never holds A's fact");
  check(sha(path.join(HERMES_HOME, "memories", "MEMORY.md")) === ownerMem && sha(path.join(HERMES_HOME, "memories", "USER.md")) === ownerUser
    && grepTree(path.join(HERMES_HOME, "memories"), secret).length === 0, "the owner's MEMORY.md and USER.md are unchanged");
  const recall = await hermesPost(A_COOKIE, { message: "What is my locker code? Check your memory." });
  note(`[${RUNTIME}] staff A in a new chat asked for the code: ${String(recall.json.text || "").slice(0, 300)}`);
  if (String(recall.json.text || "").includes(secret)) ok("A gets their own fact back in a new chat");

  // Clean the owner's side: the job the owner's request scheduled.
  try {
    const HERMES_BIN = process.env.HERMES_BIN || path.join(HOME, ".local/bin/hermes");
    const out = execFileSync(HERMES_BIN, ["cron", "list"], { encoding: "utf-8", timeout: 60_000 });
    const ids = [...out.matchAll(/([0-9a-f]{6,})[^\n]*/g)].filter((m) => m[0].includes(MARK) || m[0].toLowerCase().includes("drink water")).map((m) => m[1]);
    for (const id of ids) execFileSync(HERMES_BIN, ["cron", "remove", id], { timeout: 60_000, stdio: "ignore" });
    note(`[${RUNTIME}] removed ${ids.length} cron job(s) the owner's request created`);
  } catch (err) {
    note(`[${RUNTIME}] could not list/remove the owner's test cron job: ${String(err.message).split("\n")[0]}`);
  }
}

try {
  if (RUNTIME === "openclaw") await openclawRun();
  else await hermesRun();
} catch (err) {
  fail(`the run stopped: ${String(err?.message || err).split("\n")[0]}`);
}
process.exit(0);
