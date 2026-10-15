#!/usr/bin/env node
/**
 * ClawBox's harness usage (scan.mjs) against the pinned harnesses' own surfaces
 * (openclaw-surface.mjs, hermes_surface.py). Exit 1 on any FAIL.
 *
 *   node check.mjs <repo> <usage.json> <openclaw-surface.json> <hermes-surface.json> <meta.json>
 *
 * A FAIL names the harness and its pinned version, the command / flag / key /
 * method / event / hook / route, why, and every ClawBox file:line that uses it.
 * A failure that is known and accepted for now is listed — with its reason and
 * an expiry date — in config/harness-contract-allowlist.json; an entry that has
 * expired, or that no longer matches a failure, fails the job itself, so the
 * list can neither go stale nor hide a fix.
 */
import fs from "node:fs";
import path from "node:path";

const [repo, usagePath, ocPath, hePath, metaPath] = process.argv.slice(2);
const read = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const usage = read(usagePath);
const oc = read(ocPath);
const he = read(hePath);
const meta = read(metaPath);
const ALLOWLIST = "config/harness-contract-allowlist.json";
const allow = read(path.join(repo, ALLOWLIST));
const today = new Date().toISOString().slice(0, 10);
const soon = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

const OC = `openclaw@${meta.openclawPin}`;
const HE = `hermes@${meta.hermesTag ?? meta.hermesCommit.slice(0, 12)}`;
const label = (h) => (h === "openclaw" ? OC : h === "hermes" ? HE : "clawbox");

/** Findings, grouped by what is wrong so each is one line with all its sites. */
const findings = new Map();
const add = (level, harness, kind, name, why, site) => {
  const id = `${level}|${harness}|${kind}|${name}|${why}`;
  if (!findings.has(id)) findings.set(id, { level, harness, kind, name, why, sites: [] });
  if (site && !findings.get(id).sites.includes(site)) findings.get(id).sites.push(site);
  return findings.get(id);
};
const fail = (...a) => add("FAIL", ...a);
const warn = (...a) => add("WARN", ...a);
const info = (...a) => add("INFO", ...a);
const uses = (h, kind) => usage.usages.filter((u) => u.harness === h && u.kind === kind);

// ── OpenClaw ────────────────────────────────────────────────────────────────
const need = (value, what) => {
  if (value) return true;
  fail("openclaw", "surface", what, `could not be read from the pinned package — the check cannot vouch for it`, null);
  return false;
};
const root = oc.cli[""];
if (need(root?.usage, "CLI help")) {
  for (const u of uses("openclaw", "cli")) {
    let node = root;
    const at = [];
    let ok = true;
    for (const w of u.words) {
      const child = oc.cli[[...at, w].join(" ")];
      if (node.children.includes(w) || child?.aliases?.includes(w)) { node = child ?? node; at.push(w); continue; }
      if (node.positional.length) break; // the rest are the command's arguments
      fail("openclaw", "cli", `openclaw ${[...at, w].join(" ")}`, "no such command", u.site);
      ok = false;
      break;
    }
    if (!ok) continue;
    const have = new Set([...node.options, ...root.options, "-h", "--help"]);
    for (const f of u.flags) if (!have.has(f)) fail("openclaw", "flag", `openclaw ${at.join(" ")} ${f}`.replace(/\s+/g, " "), "no such option", u.site);
  }
}
if (need(oc.configPaths, "the config schema (`openclaw config schema --json`)")) {
  const exact = new Set(oc.configPaths);
  const wild = oc.configPaths.filter((p) => p.includes("*")).map((p) => p.split("."));
  const known = (key) => {
    if (exact.has(key)) return true;
    const s = key.split(".");
    return wild.some((w) => w.length === s.length && w.every((seg, i) => seg === "*" || s[i] === "*" || seg === s[i]));
  };
  for (const u of uses("openclaw", "config")) if (!known(u.name)) fail("openclaw", "config", u.name, "not a key of the pinned config schema", u.site);
}
if (need(oc.rpcMethods, "the gateway RPC method table (CORE_GATEWAY_METHOD_SPECS)")) {
  const methods = new Set(oc.rpcMethods);
  for (const u of uses("openclaw", "rpc")) if (!methods.has(u.name)) fail("openclaw", "rpc", u.name, "not a method of the pinned gateway", u.site);
}
if (need(oc.events, "the gateway event list (GATEWAY_EVENTS)")) {
  const events = new Set(oc.events);
  for (const u of uses("openclaw", "event")) if (!events.has(u.name)) fail("openclaw", "event", u.name, "the pinned gateway never sends this event", u.site);
}
if (need(oc.hooks, "the plugin hook names (pluginHookNameSet)")) {
  const hooks = new Set(oc.hooks);
  for (const u of uses("openclaw", "hook")) if (!hooks.has(u.name)) fail("openclaw", "hook", u.name, "not a plugin hook of the pinned core", u.site);
}
// The two facts ClawBox keeps about the pin that only the package can confirm.
{
  const updater = fs.readFileSync(path.join(repo, "src/lib/updater.ts"), "utf-8");
  const table = /OPENCLAW_STATE_SCHEMA_BY_VERSION[^{]*\{([^}]*)\}/.exec(updater)?.[1] ?? "";
  const pinPattern = meta.openclawPin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(`"${pinPattern}"\\s*:\\s*(\\d+)`).exec(table);
  const native = oc.schemaVersions?.state;
  if (!row || Number(row[1]) !== native) {
    const line = updater.split("\n").findIndex((l) => l.includes("OPENCLAW_STATE_SCHEMA_BY_VERSION:")) + 1;
    fail("openclaw", "state-schema", `OPENCLAW_STATE_SCHEMA_BY_VERSION["${meta.openclawPin}"]`,
      `is ${row ? row[1] : "missing"}; the pinned package.json says openclaw.schemaVersions.state = ${native}`, `src/lib/updater.ts:${line}`);
  }
  const installer = fs.readFileSync(path.join(repo, "install.sh"), "utf-8");
  const engineLine = installer.split("\n").findIndex((l) => l.startsWith("OPENCLAW_NODE_ENGINE="));
  const ours = /^OPENCLAW_NODE_ENGINE="([^"]*)"/m.exec(installer)?.[1]?.replace(/,\s*or\s+/g, " || ");
  if (ours !== oc.engines?.node) {
    fail("openclaw", "engine", "OPENCLAW_NODE_ENGINE", `is "${ours}"; the pinned package.json says engines.node = "${oc.engines?.node}"`, `install.sh:${engineLine + 1}`);
  }
}

// ── Hermes ──────────────────────────────────────────────────────────────────
const needHermes = (value, what) => {
  if (value) return true;
  fail("hermes", "surface", what, "could not be read from the pinned source — the check cannot vouch for it", null);
  return false;
};
needHermes(he.cli?.length, "the argparse tree");
needHermes(he.validatorRefusalRule, "the config validator's refusal rule (_is_wrong_prefix_suggestion)");
if (he.chatRules?.present) needHermes(he.chatRules.refused && he.chatRules.frozenOnResume, "`hermes chat`'s runtime rules (_UNSUPPORTED, _POLICY)");
const tree = new Map((he.cli ?? []).map((r) => [r.path, r]));
const children = new Map();
for (const r of he.cli) {
  const parts = r.path.split(" ");
  if (parts.length < 2) continue;
  const parent = parts.slice(0, -1).join(" ");
  if (!children.has(parent)) children.set(parent, new Map());
  for (const n of [parts[parts.length - 1], ...r.aliases]) children.get(parent).set(n, r.path);
}
for (const u of tree.size ? uses("hermes", "cli") : []) {
  let node = "hermes";
  let ok = true;
  for (const w of u.words) {
    const next = children.get(node)?.get(w);
    if (next) { node = next; continue; }
    if (tree.get(node).options.some((o) => o.positional)) break;
    fail("hermes", "cli", `${node} ${w}`, "no such command", u.site);
    ok = false;
    break;
  }
  if (!ok) continue;
  const flags = new Set(tree.get(node).options.flatMap((o) => (o.positional ? [] : o.flags)));
  for (const f of u.flags) {
    if (f === "--help" || f === "-h") continue;
    if (!flags.has(f)) fail("hermes", "flag", `${node} ${f}`, "no such option", u.site);
    else if (node === "hermes chat" && he.chatRules?.present) {
      const spellings = tree.get(node).options.find((o) => o.flags.includes(f)).flags;
      if (spellings.some((s) => he.chatRules.refused.includes(s))) fail("hermes", "flag", `${node} ${f}`, "accepted by argparse but refused by the gateway-routed chat", u.site);
      else if (u.flags.includes("--resume") && spellings.some((s) => he.chatRules.frozenOnResume.includes(s))) warn("hermes", "flag", `${node} ${f}`, "frozen on --resume: refused if it differs from the session's value", u.site);
    }
  }
}
// Keys ClawBox itself writes with --force (outside the validator by design): reading them back is fine.
const forced = uses("hermes", "config").filter((u) => u.op === "set" && u.force).map((u) => u.name.split("."));
const isForced = (key) => forced.some((f) => f.length === key.split(".").length && f.every((seg, i) => seg === "*" || seg === key.split(".")[i]));
for (const u of uses("hermes", "config")) {
  const v = he.config[u.name];
  if (!v || v.env) continue; // UPPER_SNAKE keys go to .env, which the validator does not judge
  if (v.known) continue;
  const hint = v.suggestion ? ` (did you mean ${v.suggestion})` : "";
  if (u.op === "set" && v.refused && !u.force) fail("hermes", "config", u.name, `refused by the pinned \`hermes config set\` without --force${hint}`, u.site);
  else if (u.op === "set" && v.refused) info("hermes", "config", u.name, "outside the validator's schema; written with --force, which the call passes", u.site);
  else if (u.op === "set") warn("hermes", "config", u.name, `not in the pinned config schema; Hermes writes it with a 'not a recognized config key' warning${hint}`, u.site);
  else if (u.op === "write" || u.op === "unset") fail("hermes", "config", u.name, `${u.op === "write" ? "written into config.yaml" : "unset"}, but not a key the pinned validator knows${hint}`, u.site);
  else if (isForced(u.name)) info("hermes", "config", u.name, "read back; ClawBox writes it with --force", u.site);
  else warn("hermes", "config", u.name, `read, but not a key the pinned validator knows${hint}`, u.site);
}
if (!he.openrpc) fail("hermes", "surface", "apps/shared/src/gateway-contract.openrpc.json", "not found at the pin — the RPC and event checks cannot run", null);
else {
  for (const u of uses("hermes", "rpc")) {
    const kinds = he.openrpc[u.name] ?? [];
    if (!kinds.includes("method") && !kinds.includes("x-canonical-methods")) fail("hermes", "rpc", u.name, "not a method of the pinned dashboard's JSON-RPC contract", u.site);
  }
  for (const u of uses("hermes", "event")) {
    const kinds = he.openrpc[u.name] ?? [];
    if (kinds.includes("x-notifications")) continue;
    fail("hermes", "event", u.name, kinds.includes("x-server-requests") ? "a server→client REQUEST at the pin, not an event" : "the pinned dashboard never sends this event", u.site);
  }
}
// A route with no literal segment before its first parameter (the SPA's
// `GET /{full_path:path}` fallback) answers every path, so it proves nothing.
const routes = (he.routes ?? []).map(([methods, p]) => ({ methods: methods.split(","), segs: p.split("/") }))
  .filter((r) => !/^\{/.test(r.segs[1] ?? "{"));
needHermes(routes.length, "the dashboard routes");
for (const u of routes.length ? uses("hermes", "route") : []) {
  const segs = u.name.split("/");
  const match = routes.some((r) => {
    if (u.method && !r.methods.includes(u.method) && !r.methods.includes("*")) return false;
    for (let i = 0; i < r.segs.length; i++) {
      const rs = r.segs[i];
      if (/^\{[^}]*:path\}$/.test(rs)) return i < segs.length;
      if (i >= segs.length) return false;
      if (!(rs === segs[i] || segs[i] === "*" || /^\{[^}]*\}$/.test(rs))) return false;
    }
    return r.segs.length === segs.length;
  });
  if (!match) fail("hermes", "route", `${u.method ?? "ANY"} ${u.name}`, "no such route on the pinned dashboard", u.site);
}
if (meta.hermesTagCommit === null) info("hermes", "pin", meta.hermesTag, "this tag -> commit was verified upstream when the cached tree recorded it", null);
else if (meta.hermesTagCommit !== meta.hermesCommit) {
  fail("hermes", "pin", meta.hermesTag, `upstream's tag points at ${meta.hermesTagCommit || "nothing"}, not the pinned ${meta.hermesCommit}`, meta.hermesPinSite);
}

// ── the allow-list ──────────────────────────────────────────────────────────
for (const [i, e] of (allow.entries ?? []).entries()) {
  const where = `${ALLOWLIST} entry ${i + 1} (${e.harness} ${e.kind} ${e.name})`;
  if (!["known-gap", "version-guarded"].includes(e.category) || !e.reason?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "") || !e.sites?.length) {
    fail(e.harness ?? "?", "allow-list", where, "needs category (known-gap | version-guarded), reason, sites and expires (YYYY-MM-DD)", null);
    continue;
  }
  const hits = [...findings.values()].filter((f) => f.level === "FAIL" && f.harness === e.harness && f.kind === e.kind && f.name === e.name);
  if (!hits.length) {
    fail(e.harness, "allow-list", where, "matches no failure any more — the pin or the code moved on; remove the entry", null);
    continue;
  }
  if (e.expires < today) {
    // Red on beta and locally; a warning on a pull request, which did not cause it and cannot fix it.
    for (const h of hits) {
      h.why += ` (allow-list entry expired ${e.expires}: ${e.reason})`;
      if (process.env.GITHUB_EVENT_NAME === "pull_request") h.level = "WARN";
    }
    continue;
  }
  if (e.expires <= soon) warn(e.harness, "allow-list", where, `expires ${e.expires}: fix it or renew the entry with a reason`, null);
  // Only the files the entry names are covered: a new file using the same name is a new case.
  const fileOf = (site) => site.split(/:(?=\d+$)/)[0];
  const files = new Set(e.sites.map(fileOf));
  for (const h of hits) {
    const extra = h.sites.filter((site) => !files.has(fileOf(site)));
    const covered = h.sites.filter((site) => files.has(fileOf(site)));
    if (!extra.length) { h.level = "ALLOWED"; h.allow = e; continue; }
    h.sites = extra;
    h.why += ` — not covered by ${where}, which names ${[...files].join(", ")}`;
    if (covered.length) findings.set(`ALLOWED|${h.harness}|${h.kind}|${h.name}|${i}`, { ...h, level: "ALLOWED", why: h.why.split(" — not covered")[0], sites: covered, allow: e });
  }
}

// ── call sites the scan could not read: the list may shrink, never grow unseen ──
const RECORDED = "config/harness-contract-unchecked.json";
const recorded = read(path.join(repo, RECORDED));
const current = new Map();
for (const u of usage.unchecked) {
  const key = `${u.site.split(/:(?=\d+$)/)[0]}\u0000${u.why}`;
  if (!current.has(key)) current.set(key, { harness: u.harness, sites: [] });
  current.get(key).sites.push(u.site);
}
for (const [key, { harness, sites }] of current) {
  const [file, why] = key.split("\u0000");
  const was = recorded[file]?.[why] ?? 0;
  if (sites.length > was) {
    fail(harness, "unchecked", `${file}: ${why}`, `${sites.length} call site(s), ${was} recorded in ${RECORDED} — pass the value as a literal or a named constant, or record it (node scripts/harness-contract/scan.mjs --unchecked > ${RECORDED})`, null).sites.push(...sites);
  }
}
for (const [file, whys] of Object.entries(recorded)) {
  for (const [why, n] of Object.entries(whys)) {
    const now = current.get(`${file}\u0000${why}`)?.sites.length ?? 0;
    if (now < n) info("clawbox", "unchecked", `${file}: ${why}`, `${now} call site(s), ${n} recorded — lower the record (node scripts/harness-contract/scan.mjs --unchecked > ${RECORDED})`, null);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const order = { FAIL: 0, ALLOWED: 1, WARN: 2, INFO: 3 };
const list = [...findings.values()].sort((a, b) => order[a.level] - order[b.level] || (a.harness + a.kind + a.name).localeCompare(b.harness + b.kind + b.name));
const sitesText = (s) => (s.length ? `  ← ${s.slice(0, 4).join(", ")}${s.length > 4 ? ` (+${s.length - 4} more)` : ""}` : "");
const counted = (h) => ["cli", "config", "rpc", "event", "hook", "route"].map((k) => `${new Set(uses(h, k).map((u) => u.name)).size} ${k}`).join(", ");
console.log(`harness-contract: ${OC} (build ${oc.build ?? "?"}) — ${counted("openclaw")}`);
console.log(`harness-contract: ${HE} (${meta.hermesCommit}) — ${counted("hermes")}`);
for (const f of list) {
  const allowNote = f.allow ? `  [${f.allow.category} until ${f.allow.expires}: ${f.allow.reason}]` : "";
  console.log(`${f.level.padEnd(7)} ${label(f.harness)} ${f.kind} ${f.name} — ${f.why}${allowNote}${sitesText(f.sites)}`);
}
console.log(`unchecked (computed at runtime, not read statically): ${usage.unchecked.length} call sites`);
for (const u of usage.unchecked) console.log(`  ${u.harness} ${u.kind} ${u.site} — ${u.why}`);
const failures = list.filter((f) => f.level === "FAIL");
console.log(`harness-contract: ${failures.length} failure(s), ${list.filter((f) => f.level === "ALLOWED").length} allowed, ${list.filter((f) => f.level === "WARN").length} warning(s)`);

if (process.env.GITHUB_ACTIONS) {
  for (const f of failures) {
    const msg = `${label(f.harness)} ${f.kind} ${f.name} — ${f.why}`.replace(/\n/g, " ");
    if (!f.sites.length) console.log(`::error title=harness-contract::${msg}`);
    for (const s of f.sites) {
      const [file, line] = s.split(/:(?=\d+$)/);
      console.log(`::error file=${file},line=${line ?? 1},title=harness-contract::${msg}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = list.filter((f) => f.level !== "INFO").map((f) => `| ${f.level} | ${label(f.harness)} | ${f.kind} | \`${f.name}\` | ${f.why} | ${f.sites.slice(0, 3).join("<br>")} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### harness-contract — ${OC}, ${HE}`, "",
      `${failures.length} failure(s); ${usage.usages.length} usages read from source, ${usage.unchecked.length} call sites computed at runtime (listed in the log).`, "",
      ...(rows.length ? ["| | harness | kind | item | why | ClawBox |", "|---|---|---|---|---|---|", ...rows] : []), "",
    ].join("\n"));
  }
}
process.exit(failures.length ? 1 : 0);
