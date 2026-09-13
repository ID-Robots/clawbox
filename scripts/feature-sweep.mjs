#!/usr/bin/env node
// Walk a RUNNING, already-installed ClawBox and say, feature by feature,
// whether it actually answers.
//
// WHY THIS EXISTS. CI proves the code builds and the unit/route suites pass;
// `e2e-install/` proves a fresh install comes up inside a container. Nothing
// walked a live box, so a regression that only shows on a device was found by
// a person noticing. This is that walk: one Node script, no dependency, no
// test runner.
//
// THREE RULES, and they are what make the answer worth reading:
//
//   1. SAFE BY DEFAULT. Read-mostly, against a box someone may be using. It
//      restarts nothing, changes no device setting, flips no consent, starts
//      no coding run, deletes nothing, writes nothing into the owner's
//      projects and calls nothing that spends money at a provider. The one
//      write is a KV key this sweep owns and deletes again.
//   2. `unproven` IS NOT `fail`. Several routes refuse the MCP bearer BY
//      DESIGN — that refusal is a PASS here, because it is the fence working,
//      and the sweep asserts it rather than reporting the 403 as breakage.
//      Anything the sweep genuinely could not check is `unproven`, counted
//      separately and ignored by the exit code. Counting "could not check" as
//      "fine" would make the whole sweep worse than nothing.
//   3. IT AUTHENTICATES THE WAY THE DEVICE INTENDS. The MCP bearer from
//      `data/.mcp-token` for what the bearer may reach; for owner-only routes,
//      the refusal is the assertion. The token is never printed, no value from
//      a secrets route is ever printed, and everything on its way to stdout
//      goes through redact().
//
// Usage: node scripts/feature-sweep.mjs --host <ip-or-host> [--json]
//                                       [--only <area>] [--timeout <ms>]

import fs from "fs";
import path from "path";
import process from "process";

// ─── pure helpers (unit-tested; keep them side-effect free) ──────────────────

const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\bclaw_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/**
 * Everything printed goes through here. The literal secrets the sweep itself
 * holds (the bearer) are passed in as `literals` and matched FIRST — that is
 * the only rule that covers a credential shape nobody thought of — then the
 * shapes above, then the owner's home directory.
 */
export function redact(text, literals = []) {
  let out = String(text ?? "");
  for (const literal of literals) {
    if (typeof literal === "string" && literal.length >= 8) {
      out = out.split(literal).join("<redacted>");
    }
  }
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, "<redacted>");
  return out.replace(/\/home\/[^/\s"']+/g, "~");
}

/** Count a finished result list by verdict, per area and overall. */
export function tally(results) {
  const totals = { passed: 0, failed: 0, unproven: 0 };
  const areas = new Map();
  for (const r of results) {
    const key = r.verdict === "pass" ? "passed" : r.verdict === "fail" ? "failed" : "unproven";
    totals[key] += 1;
    if (!areas.has(r.area)) areas.set(r.area, { area: r.area, passed: 0, failed: 0, unproven: 0, checks: [] });
    const area = areas.get(r.area);
    area[key] += 1;
    area.checks.push(r);
  }
  return {
    ...totals,
    total: results.length,
    // An area is only as good as its worst check: one failure makes it fail.
    areas: [...areas.values()].map((a) => ({
      ...a,
      verdict: a.failed > 0 ? "fail" : a.passed > 0 ? "pass" : "unproven",
    })),
  };
}

// ─── expectations ────────────────────────────────────────────────────────────
//
// An expectation returns `true` for a pass, a STRING for a failure (the
// string says what was wrong), or `{ unproven: reason }`.

const truncate = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 200 with a JSON body every named field is present and non-null in. */
function ok(...fields) {
  return (res) => {
    if (res.status !== 200) return `expected 200, got ${res.status} ${truncate(res.text)}`;
    if (res.json === null) return `expected JSON, got ${truncate(res.text)}`;
    for (const field of fields) {
      const value = field.split(".").reduce((o, k) => (o == null ? o : o[k]), res.json);
      if (value === undefined || value === null) return `missing field \`${field}\` in ${truncate(res.text)}`;
    }
    return true;
  };
}

/** A specific refusal: the status, and the stable code the route promises. */
function refuses(status, code) {
  return (res) => {
    if (res.status !== status) return `expected ${status} ${code ?? ""}, got ${res.status} ${truncate(res.text)}`;
    if (!code) return true;
    const got = res.json?.code ?? res.json?.kind;
    return got === code ? true : `expected code \`${code}\`, got \`${got ?? "none"}\` in ${truncate(res.text)}`;
  };
}

/** The fence assertion: an owner-only route must turn the MCP bearer away. */
const ownerOnly = () => refuses(403, "owner_only");

/** A refusal of some allowed shape — used where the device has several. */
function refusesOneOf(statuses) {
  return (res) => (statuses.includes(res.status)
    ? true
    : `expected one of ${statuses.join("/")}, got ${res.status} ${truncate(res.text)}`);
}

/** Chain: all of them must pass. */
function all(...expectations) {
  return (res, ctx) => {
    for (const e of expectations) {
      const verdict = e(res, ctx);
      if (verdict !== true) return verdict;
    }
    return true;
  };
}

// ─── the areas ───────────────────────────────────────────────────────────────
//
// A check is { name, path, method?, body?, expect, needs? }. `needs` runs
// before the request and returns a reason string to skip the check as
// `unproven` — which is how a check that would cost money, or that depends on
// hardware this box has not got, is left unasked rather than guessed at.

const NO_LIVE_RUN = (ctx) => (ctx.liveRun ? "a coding run is live; asking would spend the box's picture allowance" : null);
const ONLINE = (ctx) => (ctx.online === false ? "the box reports it is offline" : null);

const AREAS = [
  ["identity", [
    { name: "system/info reports the machine", path: "/setup-api/system/info", expect: ok("hostname", "platform", "memoryTotal") },
    { name: "system/stats reports live figures", path: "/setup-api/system/stats", expect: ok("cpu.usage", "memory.total") },
    { name: "system/build-identity names the build", path: "/setup-api/system/build-identity", expect: ok("build.commit", "build.branch") },
    { name: "setup/status says setup finished", path: "/setup-api/setup/status", expect: (res) => {
      const base = ok("setup_complete")(res);
      if (base !== true) return base;
      return res.json.setup_complete === true ? true : { unproven: "this box has not finished its setup wizard" };
    } },
  ]],
  ["auth", [
    { name: "a request with no credential is refused", path: "/setup-api/system/info", anonymous: true, expect: refusesOneOf([307, 401, 403]) },
    { name: "a forged bearer is refused", path: "/setup-api/system/info", bearer: "not-this-box's-token-0000000000", expect: refusesOneOf([307, 401, 403]) },
    { name: "the device's own bearer is accepted", path: "/setup-api/system/info", expect: ok("hostname") },
  ]],
  ["preferences", [
    { name: "the UI language reads back", path: "/setup-api/preferences?keys=ui_language", expect: ok("ui_language") },
    { name: "the agent cannot write installed_apps", path: "/setup-api/preferences", method: "POST", body: { installed_apps: "[]" }, expect: ownerOnly() },
  ]],
  ["kv", [
    { name: "a value writes", path: "/setup-api/kv", method: "POST", body: (ctx) => ({ key: ctx.scratchKey, value: ctx.scratchValue }), expect: (res) => (res.status === 200 ? true : `expected 200, got ${res.status} ${truncate(res.text)}`) },
    { name: "the value reads back", path: (ctx) => `/setup-api/kv?key=${ctx.scratchKey}`, expect: (res, ctx) => (res.json?.value === ctx.scratchValue ? true : `read back ${truncate(res.text)}`) },
    { name: "the value deletes", path: "/setup-api/kv", method: "POST", body: (ctx) => ({ delete: ctx.scratchKey }), expect: (res) => (res.status === 200 ? true : `expected 200, got ${res.status} ${truncate(res.text)}`) },
    { name: "a reserved key is refused", path: "/setup-api/kv?key=__proto__", expect: refusesOneOf([400]) },
  ]],
  ["files", [
    { name: "the browse root lists", path: "/setup-api/files", expect: ok("files") },
    { name: "resolve answers both paths", path: "/setup-api/files", method: "POST", body: { action: "resolve", filePath: "." }, expect: ok("absPath") },
    { name: "a traversal out of the root is refused", path: "/setup-api/files?dir=..%2F..%2F..%2Fetc", expect: refusesOneOf([400, 403, 404]) },
  ]],
  ["code", [
    { name: "code projects list", path: "/setup-api/code", method: "POST", body: { action: "list-projects" }, expect: ok("projects") },
  ]],
  ["chat", [
    { name: "chat capabilities name the harness", path: "/setup-api/chat/capabilities", expect: ok("harness") },
    { name: "a chat model is resolved", path: "/setup-api/chat/model", expect: all(ok("options"), (res) => (res.json.options.length > 0 ? true : "no chat model options at all")) },
  ]],
  ["browser", [
    { name: "the device browser reports itself", path: "/setup-api/browser/manage", expect: ok("chromium", "browser") },
    { name: "the agent cannot change the browser's settings", path: "/setup-api/browser/setup", method: "POST", body: { autoOpen: true }, expect: ownerOnly() },
  ]],
  ["vision", [
    { name: "a file outside the allowed roots is refused", path: "/setup-api/vision/describe", method: "POST", body: { path: "/etc/hostname" }, expect: refusesOneOf([403]) },
  ]],
  ["media", [
    { name: "a bodyless picture request is refused", path: "/setup-api/coding-agent/media/image", method: "POST", body: {}, expect: refuses(400, "bad_request") },
    { name: "no run means no picture", path: "/setup-api/coding-agent/media/image", method: "POST", body: { prompt: "a feature sweep never gets this far" }, needs: NO_LIVE_RUN, expect: refuses(403, "no_run") },
  ]],
  ["local-model", [
    { name: "the local model inventory answers", path: "/setup-api/local-models", expect: ok("models") },
    { name: "ollama reports itself", path: "/setup-api/ollama/status", expect: ok("running") },
    { name: "llama.cpp reports itself", path: "/setup-api/llamacpp/status", expect: ok("installed") },
    { name: "the memory embedder reports itself", path: "/setup-api/embed/status", expect: ok("supported") },
  ]],
  ["mcp", [
    { name: "the agent's secret door lists names", path: "/setup-api/coding-agent/secrets/names", expect: ok("names") },
    { name: "…and never a value", path: "/setup-api/coding-agent/secrets/names", expect: (res) => {
      if (res.status !== 200) return `expected 200, got ${res.status}`;
      const leaked = (res.json.names ?? []).some((n) => Object.hasOwn(n ?? {}, "value"));
      return leaked ? "a secret VALUE came back on the names route" : true;
    } },
  ]],
  ["vnc", [
    { name: "the screen reports itself", path: "/setup-api/vnc", expect: ok("available") },
    { name: "the clipboard reads", path: "/setup-api/vnc/clipboard", expect: ok("text") },
  ]],
  ["apps", [
    { name: "the app store lists", path: "/setup-api/apps/store", needs: ONLINE, expect: ok("total", "categories") },
    { name: "an unknown webapp id is refused", path: "/setup-api/webapps?app=__sweep_no_such_app__", expect: refusesOneOf([400, 404]) },
    { name: "an uninstalled skill is not found", path: "/setup-api/apps/skill-info?appId=__sweep_no_such_skill__", expect: refuses(404, "not_installed") },
  ]],
  ["clawkeep", [
    { name: "backup reports itself", path: "/setup-api/clawkeep", expect: ok("paired", "setupComplete") },
    { name: "cloud snapshots list", path: "/setup-api/clawkeep/snapshots", needs: (ctx) => (ctx.clawkeepPaired ? ONLINE(ctx) : "this box is not paired with ClawKeep"), expect: ok("snapshots") },
    { name: "the last backup did not end in an error", path: "/setup-api/clawkeep", needs: (ctx) => (ctx.clawkeepPaired ? null : "this box is not paired with ClawKeep"), expect: (res) => {
      const status = res.json?.lastHeartbeatStatus ?? "";
      if (status === "") return { unproven: "this box has never run a backup" };
      return ["error", "needs-passphrase"].includes(status) ? `the last backup run ended \`${status}\`` : true;
    } },
    { name: "the memory index reports itself", path: "/setup-api/clawkeep/memory", expect: ok("available") },
  ]],
  ["update", [
    { name: "the updater reports a phase", path: "/setup-api/update/status", expect: ok("phase", "steps") },
    { name: "versions resolve", path: "/setup-api/update/versions", needs: ONLINE, expect: ok("clawbox.current", "edition") },
  ]],
  ["tunnel", [
    { name: "remote control reports itself", path: "/setup-api/tunnel/status", expect: ok("enabled", "cloudflaredInstalled") },
  ]],
  ["improvement-program", [
    { name: "the mode reads back", path: "/setup-api/improvement-program", expect: all(ok("mode"), (res) => (["off", "ask", "auto"].includes(res.json.mode) ? true : `mode is \`${res.json.mode}\``)) },
    { name: "the agent cannot opt the box in", path: "/setup-api/improvement-program", method: "POST", body: { mode: "off" }, expect: ownerOnly() },
  ]],
  ["coding-agent", [
    { name: "the switch and readiness report", path: "/setup-api/coding-agent/status", expect: ok("enabled", "readiness") },
    { name: "the owner's projects list", path: "/setup-api/coding-agent/projects", expect: ok("projects") },
    { name: "runs list", path: "/setup-api/coding-agent/runs", expect: ok("runs") },
    { name: "an unknown artifact is not found", path: "/setup-api/coding-agent/artifacts?runId=run-00000000&file=nope.txt", expect: refuses(404, "not_found") },
    { name: "an unknown project's tree is not found", path: "/setup-api/coding-agent/tree?projectId=__sweep_no_such_project__", expect: refuses(404, "not_found") },
    { name: "the agent cannot read its own permission rules", path: "/setup-api/coding-agent/permissions", expect: ownerOnly() },
    { name: "the agent cannot open the secret store", path: "/setup-api/coding-agent/secrets", expect: ownerOnly() },
  ]],
  ["network", [
    { name: "the box knows whether it is online", path: "/setup-api/network/internet", expect: ok("online") },
    { name: "wifi reports itself", path: "/setup-api/wifi/status", expect: (res) => {
      if (res.status === 200) return true;
      if (/interface not available/i.test(res.text)) {
        return { unproven: `this box has no WiFi interface, and the route says so as ${res.status} rather than a structured answer` };
      }
      return `expected 200, got ${res.status} ${truncate(res.text)}`;
    } },
  ]],
  ["harness", [
    { name: "the active harness reports itself", path: "/setup-api/harness/status", expect: ok("active", "edition") },
    { name: "the edition swap reports itself", path: "/setup-api/harness/swap", expect: ok("edition", "swappable") },
    { name: "the agent gateway is healthy", path: "/setup-api/gateway/health", expect: all(ok("available"), (res) => (res.json.available === true ? true : "the gateway is not answering")) },
  ]],
  ["voice", [
    { name: "speech output reports its engines", path: "/setup-api/tts", expect: ok("engines", "activeEngine") },
    { name: "speech input reports its chain", path: "/setup-api/stt", expect: ok("primary", "chain") },
  ]],
  ["channels", [
    { name: "telegram reports itself", path: "/setup-api/telegram/status", expect: ok("configured") },
    { name: "email reports itself", path: "/setup-api/email/status", expect: ok("mode") },
    { name: "discord reports itself", path: "/setup-api/discord/status", expect: ok("configured") },
  ]],
  ["providers", [
    { name: "every provider reports a state", path: "/setup-api/providers/status", expect: all(ok("providers"), (res) => (res.json.providers.every((p) => typeof p.state === "string") ? true : "a provider came back with no state")) },
    { name: "the configured model reports itself", path: "/setup-api/ai-models/status", expect: ok("connected") },
  ]],
];

// ─── the runner ──────────────────────────────────────────────────────────────

const HELP = `ClawBox feature sweep — walk a live box and say what actually works.

  node scripts/feature-sweep.mjs [--host <ip-or-host>] [--json]
                                 [--only <area>] [--timeout <ms>]

  --host <h>      the box to sweep; host, host:port or a full URL
                  (default 127.0.0.1, port 80)
  --only <area>   sweep one area only: ${AREAS.map(([a]) => a).join(", ")}
  --timeout <ms>  per-request timeout (default 15000)
  --json          machine-readable results on stdout
  --help          this

Read-mostly and safe against a box in use: it starts nothing, changes no
setting, deletes nothing and spends nothing at a provider. Authenticates with
the MCP bearer from data/.mcp-token (override with CLAWBOX_MCP_TOKEN, or point
CLAWBOX_ROOT at the install); owner-only routes are checked by asserting they
REFUSE that bearer. Exit 0 when everything it could check passed, 1 otherwise;
\`unproven\` never fails the run.`;

function parseArgs(argv) {
  const args = { host: "127.0.0.1", json: false, only: null, timeout: 15000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--host") args.host = argv[++i];
    else if (arg === "--only") args.only = argv[++i];
    else if (arg === "--timeout") args.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.host) throw new Error("--host needs a value");
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout needs a positive number of milliseconds");
  return args;
}

function baseUrl(host) {
  if (/^https?:\/\//.test(host)) return host.replace(/\/$/, "");
  return `http://${host}`;
}

/** The bearer, resolved the way the device itself resolves it. */
function readToken() {
  if (process.env.CLAWBOX_MCP_TOKEN) return process.env.CLAWBOX_MCP_TOKEN.trim();
  const root = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
  try {
    const raw = fs.readFileSync(path.join(root, "data", ".mcp-token"), "utf-8").trim();
    if (raw.length >= 16) return raw;
  } catch { /* no token here — every check needing one becomes unproven */ }
  return null;
}

async function request(ctx, check) {
  const rel = typeof check.path === "function" ? check.path(ctx) : check.path;
  const headers = { accept: "application/json" };
  const token = check.anonymous ? null : (check.bearer ?? ctx.token);
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method: check.method ?? "GET", headers, redirect: "manual" };
  if (check.body !== undefined) {
    init.body = JSON.stringify(typeof check.body === "function" ? check.body(ctx) : check.body);
    headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeout);
  try {
    const res = await fetch(`${ctx.base}${rel}`, { ...init, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every answer is JSON */ }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(ctx, area, check) {
  const base = { area, name: check.name };
  const skip = check.needs?.(ctx);
  if (skip) return { ...base, verdict: "unproven", detail: skip };
  if (!ctx.token && !check.anonymous && !check.bearer) {
    return { ...base, verdict: "unproven", detail: "no MCP bearer available to authenticate with" };
  }
  let res;
  try {
    res = await request(ctx, check);
  } catch (err) {
    const why = err?.name === "AbortError" ? `no answer within ${ctx.timeout} ms` : `request failed: ${err?.message ?? err}`;
    return { ...base, verdict: "fail", detail: ctx.clean(why) };
  }
  let verdict;
  try {
    verdict = check.expect(res, ctx);
  } catch (err) {
    verdict = `the check itself threw: ${err?.message ?? err}`;
  }
  if (verdict === true) return { ...base, verdict: "pass", status: res.status };
  if (verdict && typeof verdict === "object" && verdict.unproven) {
    return { ...base, verdict: "unproven", status: res.status, detail: ctx.clean(verdict.unproven) };
  }
  return { ...base, verdict: "fail", status: res.status, detail: ctx.clean(String(verdict)) };
}

/**
 * The facts the checks branch on, read before the sweep so nothing has to be
 * guessed at: is the box online (an off-box service that cannot be reached is
 * unproven, not broken), is a coding run live (then the media fence must not
 * be poked), is ClawKeep paired.
 */
async function readContext(ctx) {
  const probe = async (rel) => {
    try {
      const res = await request(ctx, { path: rel });
      return res.status === 200 ? res.json : null;
    } catch { return null; }
  };
  const [internet, runs, clawkeep] = await Promise.all([
    probe("/setup-api/network/internet"),
    probe("/setup-api/coding-agent/runs"),
    probe("/setup-api/clawkeep"),
  ]);
  ctx.online = internet ? internet.online === true : null;
  ctx.liveRun = Array.isArray(runs?.runs)
    && runs.runs.some((r) => r.status === "running" || r.status === "starting");
  ctx.clawkeepPaired = clawkeep?.paired === true;
}

function print(summary, ctx) {
  const mark = { pass: "ok  ", fail: "FAIL", unproven: "??  " };
  const width = Math.max(...summary.areas.map((a) => a.area.length), 4);
  console.log(`ClawBox feature sweep — ${ctx.base}${ctx.buildLine ? ` — ${ctx.buildLine}` : ""}`);
  console.log("");
  for (const area of summary.areas) {
    console.log(`${mark[area.verdict]} ${area.area.padEnd(width)}  ${area.passed} passed, ${area.failed} failed, ${area.unproven} unproven`);
    for (const check of area.checks) {
      const detail = check.detail ? ` — ${check.detail}` : "";
      console.log(`       ${check.verdict === "pass" ? "·" : check.verdict === "fail" ? "✗" : "?"} ${check.name}${detail}`);
    }
  }
  console.log("");
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.unproven} unproven, of ${summary.total} checks`);
  if (summary.unproven > 0) console.log("`unproven` means the sweep could not check it — not that it is fine.");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const areas = args.only ? AREAS.filter(([name]) => name === args.only) : AREAS;
  if (areas.length === 0) {
    console.error(`no such area: ${args.only}\n\n${HELP}`);
    return 2;
  }

  const token = readToken();
  const ctx = {
    base: baseUrl(args.host),
    token,
    timeout: args.timeout,
    // The sweep's own KV key, deleted again whatever happens below.
    scratchKey: `clawbox:feature-sweep:${process.pid}`,
    scratchValue: `sweep-${Date.now()}`,
    clean: (text) => redact(text, token ? [token] : []),
  };

  try {
    const reach = await request(ctx, { path: "/setup-api/system/build-identity" });
    if (reach.status === 200 && reach.json?.build) {
      ctx.buildLine = `${reach.json.build.branch}@${reach.json.build.shortCommit}${reach.json.build.dirty ? " (dirty)" : ""}`;
    }
  } catch (err) {
    console.error(`${ctx.base} did not answer: ${ctx.clean(err?.message ?? String(err))}`);
    return 1;
  }
  if (!token) console.error("No MCP bearer found (data/.mcp-token, CLAWBOX_ROOT or CLAWBOX_MCP_TOKEN) — most checks will be unproven.\n");

  await readContext(ctx);

  const results = [];
  try {
    for (const [area, checks] of areas) {
      for (const check of checks) results.push(await runCheck(ctx, area, check));
    }
  } finally {
    // The one write this sweep makes, taken back even when it went wrong
    // half-way: a box someone is using must not keep the sweep's scratch key.
    try {
      await request(ctx, { path: "/setup-api/kv", method: "POST", body: { delete: ctx.scratchKey } });
    } catch { /* the KV area's own checks already report a store that will not answer */ }
  }

  const summary = tally(results);
  if (args.json) {
    console.log(JSON.stringify({ host: ctx.base, build: ctx.buildLine ?? null, online: ctx.online, ...summary }, null, 2));
  } else {
    print(summary, ctx);
  }
  return summary.failed > 0 ? 1 : 0;
}

// Nothing above runs on import: the pure helpers are unit-tested from
// src/tests/unit/feature-sweep.test.ts, which must not sweep anything.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().then(
    (code) => { process.exitCode = code; },
    // A throw here is the sweep itself breaking, not the box: say so plainly
    // rather than exiting 0 on an unhandled rejection, which would read as a
    // clean sweep.
    (err) => {
      console.error(`the sweep itself failed: ${redact(err?.stack ?? String(err))}`);
      process.exitCode = 2;
    },
  );
}
