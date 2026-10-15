#!/usr/bin/env node
/**
 * What an installed OpenClaw package offers, in its own words.
 *
 *   node openclaw-surface.mjs <node_modules/openclaw> <usage.json> > openclaw-surface.json
 *
 * The CLI is RUN for its `--help` pages (only the command paths ClawBox's
 * usage names, and the groups above them) and for `config schema --json`;
 * everything else is read from the package itself: the gateway's RPC method
 * table and event list and the plugin hook names out of `dist/` (found by
 * content — the bundle file names are hashed), and `package.json`'s own
 * `openclaw.schemaVersions` and `engines`.
 *
 * Every run gets an environment built from nothing, with HOME, OPENCLAW_HOME,
 * OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH in a fresh temporary directory:
 * the CLI migrates the state it finds on first touch, so it must never be
 * pointed at a real ~/.openclaw.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const [pkgDir, usagePath] = process.argv.slice(2);
if (!pkgDir || !usagePath) {
  console.error("usage: openclaw-surface.mjs <node_modules/openclaw> <usage.json>");
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
const usage = JSON.parse(fs.readFileSync(usagePath, "utf-8"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-surface-"));
for (const d of [".openclaw", ".config", ".cache", ".local/share", "tmp"]) fs.mkdirSync(path.join(home, d), { recursive: true });

const ENV = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home, USERPROFILE: home, OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: path.join(home, ".openclaw"), OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
  OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_SKIP_CHANNELS: "1",
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_DATA_HOME: path.join(home, ".local/share"), XDG_RUNTIME_DIR: path.join(home, "tmp"), TMPDIR: path.join(home, "tmp"),
  NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", COLUMNS: "200", CI: "1", LANG: "C.UTF-8",
};
const cli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(pkgDir, "openclaw.mjs"), ...args], { env: ENV, cwd: home, timeout: 120_000, maxBuffer: 64 << 20 },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
});

// ── the help tree, for the paths ClawBox uses ───────────────────────────────
let running = 0;
const queue = [];
const limited = async (fn) => {
  while (running >= 6) await new Promise((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
};
const helpCache = new Map();
const help = (words) => {
  const key = words.join(" ");
  if (!helpCache.has(key)) helpCache.set(key, limited(() => cli([...words, "--help"])).then(({ stdout, stderr }) => parseHelp(stdout || stderr)));
  return helpCache.get(key);
};

function parseHelp(text) {
  const lines = text.split("\n");
  const usageLine = lines.find((l) => l.startsWith("Usage: openclaw")) ?? "";
  const tokens = usageLine.replace(/^Usage: openclaw\s*/, "").split(/\s+/).filter(Boolean);
  const pathTokens = tokens.filter((t) => !/^[[<]/.test(t));
  const slots = tokens.filter((t) => /^[[<]/.test(t) && !/^\[(options|command)\]$/.test(t));
  const last = pathTokens[pathTokens.length - 1] ?? "";
  const section = (name) => {
    const at = lines.findIndex((l) => l === `${name}:`);
    if (at < 0) return [];
    const out = [];
    for (let i = at + 1; i < lines.length && (lines[i].startsWith(" ") || lines[i] === ""); i++) if (lines[i].trim()) out.push(lines[i]);
    return out;
  };
  const children = section("Commands").filter((l) => /^ {2}[a-z]/.test(l)).map((l) => l.trim().split(/\s+/)[0])
    .flatMap((n) => n.split("|")).filter((n) => n !== "help");
  const options = new Set();
  for (const l of section("Options").filter((x) => /^ {2}-/.test(x))) {
    const spec = l.trim().split(/ {2,}/)[0];
    for (const m of spec.matchAll(/(?:^|[\s,])(--?[A-Za-z0-9][A-Za-z0-9-]*)/g)) {
      options.add(m[1]);
      if (m[1].startsWith("--no-")) options.add(`--${m[1].slice(5)}`);
    }
  }
  return {
    usage: usageLine,
    canonical: pathTokens.map((t) => t.split("|")[0]),
    aliases: last.includes("|") ? last.split("|").slice(1) : [],
    positional: slots,
    children,
    options: [...options].sort(),
  };
}

const cliTree = {};
const wanted = new Set(usage.usages.filter((u) => u.harness === "openclaw" && u.kind === "cli").map((u) => JSON.stringify([...u.words, ...u.rest.filter((r) => typeof r === "string" && /^[a-z][a-z0-9-]*$/.test(r))])));
await Promise.all([...wanted].map(async (json) => {
  const words = JSON.parse(json);
  const at = [];
  cliTree[""] = await help([]);
  for (const w of words) {
    const node = await help(at);
    if (!node.children.length) break;
    const child = await help([...at, w]);
    cliTree[[...at, w].join(" ")] = child;
    if (!node.children.includes(w) && !child.aliases.includes(w)) break;
    at.push(w);
  }
}));

// ── the config schema ───────────────────────────────────────────────────────
const schemaRun = await cli(["config", "schema", "--json"]);
let configPaths = null;
try {
  const schema = JSON.parse(schemaRun.stdout.slice(schemaRun.stdout.indexOf("{")));
  const rows = new Set();
  const walk = (s, p, depth) => {
    if (!s || typeof s !== "object" || depth > 16) return;
    if (p) rows.add(p);
    for (const [k, c] of Object.entries(s.properties || {})) walk(c, p ? `${p}.${k}` : k, depth + 1);
    if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, `${p}.*`, depth + 1);
    if (s.patternProperties) for (const c of Object.values(s.patternProperties)) walk(c, `${p}.*`, depth + 1);
    if (s.items && typeof s.items === "object") walk(s.items, `${p}.*`, depth + 1);
    for (const alt of [...(s.anyOf || []), ...(s.oneOf || []), ...(s.allOf || [])]) walk(alt, p, depth + 1);
  };
  walk(schema, "", 0);
  configPaths = [...rows].sort();
} catch {
  configPaths = null;
}

// ── dist: RPC methods, events, plugin hooks (located by content) ────────────
const dist = path.join(pkgDir, "dist");
const distFiles = fs.readdirSync(dist).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(dist, f));
const holding = (needle) => distFiles.filter((f) => fs.readFileSync(f, "utf-8").includes(needle));
const literalAfter = (file, marker, closer) => {
  const src = fs.readFileSync(file, "utf-8");
  const start = src.indexOf(marker);
  const end = src.indexOf(closer, start);
  return start >= 0 && end > start ? src.slice(start + marker.length, end + closer.length) : null;
};

let rpcMethods = null;
const specFiles = holding("const CORE_GATEWAY_METHOD_SPECS = [");
if (specFiles.length === 1) {
  const literal = literalAfter(specFiles[0], "const CORE_GATEWAY_METHOD_SPECS = ", "\n];");
  // Free identifiers in the table evaluate to a stand-in that prints its own name.
  const standIn = (name) => { const f = function () { return name; }; f.toString = () => name; f[Symbol.iterator] = function* () {}; return f; };
  const builtins = new Set(["Object", "Array", "Set", "Map", "Symbol", "JSON", "String", "Number", "Boolean", "undefined"]);
  const scope = new Proxy({}, { has: (_t, k) => typeof k === "string" && !builtins.has(k), get: (_t, k) => (k === Symbol.unscopables ? undefined : standIn(String(k))) });
  try {
    const rows = vm.runInNewContext(`(function (scope) { with (scope) { return ${literal}; } })`)(scope);
    rpcMethods = rows.map((r) => String(r[0])).sort();
  } catch {
    rpcMethods = null;
  }
}
const stringsIn = (text) => (text ? [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null);
const eventFiles = holding("const GATEWAY_EVENTS = [");
const events = eventFiles.length === 1 ? stringsIn(literalAfter(eventFiles[0], "const GATEWAY_EVENTS = [", "]")) : null;
const hookFiles = holding("const pluginHookNameSet = ");
const hooks = hookFiles.length === 1 ? stringsIn(literalAfter(hookFiles[0], "const pluginHookNameSet = ", "]);")) : null;

const version = await cli(["--version"]);
fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({
  version: pkg.version,
  build: /\(([0-9a-f]+)\)/.exec(version.stdout)?.[1] ?? null,
  schemaVersions: pkg.openclaw?.schemaVersions ?? null,
  engines: pkg.engines ?? null,
  cli: cliTree,
  configPaths,
  rpcMethods,
  events: events?.sort() ?? null,
  hooks: hooks?.sort() ?? null,
}, null, 1)}\n`);
