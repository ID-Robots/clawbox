#!/usr/bin/env node
/**
 * What ClawBox uses of the two harnesses it drives, read from ClawBox's own
 * source every time it is asked — so the list cannot fall behind the code.
 *
 * It is SYNTACTIC on purpose: it finds the calls through which ClawBox reaches
 * a harness (the CLI wrappers, the config writers, the gateway and dashboard
 * RPC clients, the shell functions that forward to a harness binary) and reads
 * what is literally there. It knows nothing about either harness, so it cannot
 * mistake "absent from the harness" for "not a usage"; deciding what exists is
 * check.mjs's job, against the pinned harness itself.
 *
 * A call whose command, key or method is computed at runtime is not guessed
 * at: it is reported under `unchecked` with its file:line, and the
 * harness-contract job prints that list. Constants are followed when they are
 * plain string literals (same file first, then a name defined exactly once in
 * the tree), and a local argv array is followed back to its definition.
 *
 *   node scripts/harness-contract/scan.mjs [repoDir] > usage.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── which files ─────────────────────────────────────────────────────────────
const SKIP = [
  /^src\/tests\//, /(^|\/)tests?\//, /__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)test_[^/]*\.py$/,
  /^(e2e|e2e-install|docs|docs-site|bench|reports|public|node_modules)\//, /^scripts\/nano-tests\//, /\.d\.ts$/,
];
const JS_EXT = /\.(ts|tsx|js|mjs|cjs)$/;

function listFiles(root) {
  let files;
  try {
    files = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean);
  } catch {
    files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.name === ".git" || e.name === "node_modules") continue;
        if (e.isDirectory()) walk(rel);
        else files.push(rel);
      }
    })("");
  }
  return files.filter((f) => !SKIP.some((re) => re.test(f))).filter((f) => {
    if (JS_EXT.test(f) || f.endsWith(".py") || f.endsWith(".sh") || /^config\/[^/]+\.service$/.test(f)) return true;
    if (f.startsWith("scripts/") && !path.basename(f).includes(".")) {
      try {
        return /^#!.*\b(ba)?sh\b/.test(fs.readFileSync(path.join(root, f), "utf-8").split("\n", 1)[0]);
      } catch {
        return false;
      }
    }
    return false;
  });
}

// ── text helpers ────────────────────────────────────────────────────────────
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** JS/TS with every comment blanked (same length, newlines kept), strings left alone. */
function maskJs(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = ""; // last significant character outside strings/comments
  const tpl = []; // brace depth for each open template `${`
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const regexAllowed = () => prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(src.slice(Math.max(0, i - 7), i));
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      blank(i, e < 0 ? n : e + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      prev = "a";
      continue;
    }
    if (c === "`" || (c === "}" && tpl.length && tpl[tpl.length - 1] === 0)) {
      if (c === "}") tpl.pop();
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") { tpl.push(0); i += 2; break; }
        i++;
      }
      if (src[i] === "`") { i++; prev = "a"; }
      continue;
    }
    if (c === "/" && regexAllowed()) {
      i++;
      let cls = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] ?? "")) i++;
      prev = "a";
      continue;
    }
    if (tpl.length) {
      if (c === "{") tpl[tpl.length - 1]++;
      else if (c === "}") tpl[tpl.length - 1]--;
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? "a" : c;
    i++;
  }
  return out.join("");
}

/** Index of the bracket that closes the one at `open` (masked text), or -1. */
function closing(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[text[open]]];
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      let depth = 0;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (depth === 0 && text[i] === "`") break;
        if (text[i] === "$" && text[i + 1] === "{") { depth++; i++; } else if (text[i] === "}" && depth) depth--;
      }
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    } else if (c === ")" || c === "]" || c === "}") return -1;
  }
  return -1;
}

/** Top-level comma split of a bracket's inside: [{text, offset}]. */
function splitTop(text, base = 0) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = c === "`" ? closingTemplate(text, i) : closingQuote(text, i);
      i = end;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push({ text: text.slice(start, i), offset: base + start });
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) parts.push({ text: text.slice(start), offset: base + start });
  return parts;
}
function closingQuote(text, i) {
  const q = text[i];
  for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++;
  return i;
}
function closingTemplate(text, i) {
  let depth = 0;
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (depth === 0 && text[i] === "`") return i;
    if (text[i] === "$" && text[i + 1] === "{") { depth++; i++; } else if (text[i] === "}" && depth) depth--;
  }
  return i;
}

const unescape = (s) => s.replace(/\\(["'`\\])/g, "$1");

/**
 * One expression, as far as a literal reading goes:
 * {str} | {tpl} (each `${…}` read as `*`) | {ident} | {member} | {spread} | {alt} | {dyn}.
 */
function literal(raw) {
  const t = raw.trim().replace(/\s+as\s+(const|[A-Z][\w<>[\], ]*)$/, "").replace(/!$/, "").trim();
  let m;
  if ((m = /^"((?:[^"\\]|\\.)*)"$/.exec(t)) || (m = /^'((?:[^'\\]|\\.)*)'$/.exec(t))) return { str: unescape(m[1]) };
  if ((m = /^`((?:[^`\\]|\\.)*)`$/s.exec(t))) {
    if (!m[1].includes("${")) return { str: unescape(m[1]) };
    return { tpl: m[1] }; // raw: the scan finishes it with the constants it names
  }
  if ((m = /^\.\.\.([\s\S]+)$/.exec(t))) return { spread: m[1].trim() };
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return { ident: t };
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(t)) return { member: t };
  const q = topTernary(t);
  if (q) return { alt: [literal(q[0]), literal(q[1])] };
  return { dyn: t };
}
function topTernary(t) {
  let depth = 0;
  let qpos = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'" || c === '"') i = closingQuote(t, i);
    else if (c === "`") i = closingTemplate(t, i);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?" && t[i + 1] !== "." && t[i + 1] !== "?" && qpos < 0) qpos = i;
    else if (depth === 0 && c === ":" && qpos >= 0) return [t.slice(qpos + 1, i), t.slice(i + 1)];
  }
  return null;
}

// ── the tree's constants ────────────────────────────────────────────────────
// `const NAME = "…"` (or a template), and the string members of
// `const NAME = { key: "…" }`, kept raw so a template can be finished with the
// constants it names.
const STR_LIT = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`";
const CONST_RE = new RegExp(String.raw`(?:^|[\n;])\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(${STR_LIT})\s*(?:as\s+const\s*)?[;\n]`, "g");
const OBJ_RE = /(?:^|[\n;])\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*\{/g;
const MEMBER_RE = new RegExp(String.raw`^\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')\s*:\s*(${STR_LIT})\s*$`);

function fileConstants(masked) {
  const raw = new Map();
  const objects = new Map();
  for (const m of masked.matchAll(CONST_RE)) raw.set(m[1], m[2]);
  for (const m of masked.matchAll(OBJ_RE)) {
    const open = m.index + m[0].length - 1;
    const close = closing(masked, open);
    if (close < 0) continue;
    const members = [];
    for (const part of splitTop(masked.slice(open + 1, close))) {
      const kv = MEMBER_RE.exec(part.text);
      if (!kv) continue;
      const key = `${m[1]}.${kv[1] ?? kv[2] ?? kv[3]}`;
      raw.set(key, kv[4]);
      members.push(key);
    }
    if (members.length) objects.set(m[1], members);
  }
  return { raw, objects };
}

// ── the scan ────────────────────────────────────────────────────────────────
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
const DOTTED = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const FILE_LIKE = /\.(json|jsonl|ts|tsx|js|mjs|md|sh|py|txt|yaml|yml|log|html|png|wav|sqlite|db)$/i;
// Names too generic to learn as wrappers: a member of that name elsewhere is
// most likely something else.
const GENERIC = new Set(["call", "request", "run", "exec", "send", "get", "set", "fetch", "spawn", "main", "handler", "fn", "cb"]);
const LAUNCHERS = /^(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|execa|runCommand|exec|execAsync)$/;

/** The invokers ClawBox reaches a harness through; wrappers are learned on top. */
function baseRegistry() {
  const r = new Map();
  const add = (names, entry) => { for (const n of names) r.set(n, [entry]); };
  add(["spawnOpenclaw", "spawnOpenclawCli"], { kind: "argv", harness: "openclaw", index: 0 });
  add(["runHermesCli"], { kind: "argv", harness: "hermes", index: 0 });
  add(["runOpenclawConfigSet"], { kind: "setargs", harness: "openclaw", index: 0 });
  add(["runOpenclawConfigSetBatch"], { kind: "batch", harness: "openclaw", index: 0 });
  add(["runOpenclawConfigUnset"], { kind: "key", harness: "openclaw", index: 0, op: "unset" });
  add(["hermesConfigGet"], { kind: "key", harness: "hermes", index: 0, op: "get" });
  add(["resolveHermesConfigValue", "readHermesConfigValue"], { kind: "key", harness: "hermes", index: 0, op: "read" });
  add(["hermesConfigGetMany"], { kind: "keylist", harness: "hermes", index: 0, op: "get" });
  add(["patchHermesConfig"], { kind: "hpatch", harness: "hermes", index: 0 });
  add(["gatewayWsCall", "callGatewayRpc", "wsRequest", "gatewayCall", "gatewayRpc"], { kind: "rpc", harness: "openclaw", index: 0 });
  add(["dashboardRpc"], { kind: "rpc", harness: "hermes", index: 0 });
  return r;
}

export function scanTree(root) {
  const files = listFiles(root);
  const sources = new Map();
  for (const f of files) {
    try {
      sources.set(f, fs.readFileSync(path.join(root, f), "utf-8"));
    } catch {
      /* unreadable files are not usages */
    }
  }
  const out = { generatedFrom: root, usages: [], unchecked: [] };
  const seen = new Set();
  const record = (u) => {
    const key = JSON.stringify(u);
    if (!seen.has(key)) { seen.add(key); out.usages.push(u); }
  };
  const skips = new Set();
  const skip = (harness, kind, site, why) => {
    const key = `${harness}|${kind}|${site}|${why}`;
    if (!skips.has(key)) { skips.add(key); out.unchecked.push({ harness, kind, site, why }); }
  };

  // Constants across the JS tree: the file's own first, then a name the tree
  // defines exactly once (what an import of it resolves to).
  const files_ = new Map();
  const globalRaw = new Map();
  const globalObjects = new Map();
  for (const [f, src] of sources) {
    if (!JS_EXT.test(f)) continue;
    const masked = maskJs(src);
    const { raw, objects } = fileConstants(masked);
    files_.set(f, { masked, raw, objects });
    for (const [k, v] of raw) globalRaw.set(k, globalRaw.has(k) && globalRaw.get(k) !== v ? null : v);
    for (const [k, v] of objects) globalObjects.set(k, globalObjects.has(k) ? null : v);
  }
  const consts = { files: files_, globalRaw, globalObjects };

  // Wrappers are learned to a fixed point: a function that hands one of its
  // own parameters to an invoker is an invoker of its own.
  const registry = baseRegistry();
  for (let pass = 0; pass < 6; pass++) {
    const before = registrySignature(registry);
    for (const [f, info] of files_) scanJs(f, info, consts, registry, null, null);
    if (registrySignature(registry) === before) break;
  }
  for (const [f, info] of files_) scanJs(f, info, consts, registry, record, skip);
  for (const [f, src] of sources) {
    if (JS_EXT.test(f)) continue;
    if (f.endsWith(".py")) scanPython(f, src, record, skip);
    else scanShell(f, src, record, skip);
  }
  out.usages.sort((a, b) => (a.harness + a.kind + a.name + a.site).localeCompare(b.harness + b.kind + b.name + b.site));
  out.unchecked.sort((a, b) => (a.harness + a.kind + a.site).localeCompare(b.harness + b.kind + b.site));
  return out;
}

const registrySignature = (r) => JSON.stringify([...r].sort());

/** Function definitions: {name, namePos, params, start, end} (body range). */
function functionsOf(masked) {
  const fns = [];
  const paramNames = (open, close) => splitTop(masked.slice(open + 1, close)).map((p) => {
    const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p.text);
    return m ? m[1] : null;
  });
  const bodyAfter = (close, arrow) => {
    let i = close + 1;
    while (/\s/.test(masked[i] ?? "")) i++;
    if (masked[i] === ":") {
      // A return type: skip it, generics and nested braces included.
      let depth = 0;
      for (i++; i < masked.length; i++) {
        const c = masked[i];
        if (depth === 0 && (c === "{" || (c === "=" && masked[i + 1] === ">") || c === ";")) break;
        if (c === "{") { const e = closing(masked, i); if (e < 0) return null; i = e; continue; }
        if ("<([".includes(c)) depth++;
        else if (">)]".includes(c) && !(c === ">" && masked[i - 1] === "=")) depth--;
      }
    }
    const head = /^\s*(=>)?\s*/.exec(masked.slice(i, i + 40));
    if (arrow && !head[1]) return null;
    i += head[0].length;
    if (masked[i] === "{") {
      const end = closing(masked, i);
      return end > 0 ? [i, end] : null;
    }
    if (!head[1]) return null;
    const call = /^[\w$.]+\s*\(/.exec(masked.slice(i, i + 200));
    if (!call) return null;
    const end = closing(masked, i + call[0].length - 1);
    return end > 0 ? [i, end] : null;
  };
  const forms = [
    { re: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g, arrow: false },
    { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?\(/g, arrow: true },
    { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?function\s*\*?\s*\(/g, arrow: false },
    { re: /(?:^|\n)[ \t]*(?:(?:export|public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g, arrow: false, method: true },
    { re: /[{,]\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?\(/g, arrow: true },
  ];
  for (const { re, arrow, method } of forms) {
    for (const m of masked.matchAll(re)) {
      if (method && /^(if|for|while|switch|catch|return|function|await|new|typeof)$/.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close < 0) continue;
      const body = bodyAfter(close, arrow);
      if (!body) continue;
      fns.push({ name: m[1], namePos: m.index + m[0].lastIndexOf(m[1]), params: paramNames(open, close), start: body[0], end: body[1] });
    }
  }
  return fns;
}

function scanJs(file, info, consts, registry, record, skip) {
  const { masked, raw } = info;
  const learnOnly = !record;
  const lineOf = info.lineOf ?? (info.lineOf = lineIndex(masked));
  const fns = info.fns ?? (info.fns = functionsOf(masked));
  const defPositions = info.defPositions ?? (info.defPositions = new Set(fns.map((f) => f.namePos)));
  const isHermesFile = /hermes/i.test(file);
  const site = (pos) => `${file}:${lineOf(pos)}`;
  const emit = (u) => { if (!learnOnly) record(u); };
  const unchecked = (h, kind, pos, why) => { if (!learnOnly) skip(h, kind, site(pos), why); };

  // ── values
  const rawOf = (name) => raw.get(name) ?? consts.globalRaw.get(name) ?? null;
  const evalRaw = (r, depth) => {
    if (r === null || r === undefined) return null;
    if (r[0] === '"' || r[0] === "'") return { str: unescape(r.slice(1, -1)) };
    return evalTemplate(r.slice(1, -1), depth);
  };
  const evalTemplate = (t, depth = 0) => {
    let open = false;
    const s = unescape(t).replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, expr) => {
      const name = expr.trim();
      const v = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) && depth < 4 ? evalRaw(rawOf(name), depth + 1) : null;
      if (v && v.str !== undefined) return v.str;
      open = true;
      return "*";
    });
    return open ? { tpl: s } : { str: s };
  };
  const resolve = (v) => {
    if (!v) return v;
    if (v.ident !== undefined || v.member !== undefined) return evalRaw(rawOf(v.ident ?? v.member), 0) ?? v;
    if (v.tpl !== undefined) return evalTemplate(v.tpl);
    return v;
  };
  const textValue = (v) => {
    const r = resolve(v);
    if (r?.str !== undefined) return r.str;
    if (r?.tpl !== undefined) return r.tpl;
    return null;
  };
  const keyOf = (part) => (part ? textValue(literal(part.text)) : null);

  // ── scopes
  const enclosing = (pos) => {
    let best = null;
    for (const f of fns) if (f.start <= pos && pos < f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
    return best;
  };
  /** If `expr` is a plain parameter of the function the call sits in, learn that function. */
  const learn = (pos, expr, entry) => {
    const t = expr?.text?.trim();
    if (!t || !/^[A-Za-z_$][\w$]*$/.test(t)) return false;
    const f = enclosing(pos);
    const index = f ? f.params.indexOf(t) : -1;
    if (index < 0) return false;
    if (GENERIC.has(f.name)) return true; // a parameter, but of something too generic to follow
    const learned = { ...entry, index };
    const list = registry.get(f.name) ?? [];
    if (!list.some((e) => JSON.stringify(e) === JSON.stringify(learned))) registry.set(f.name, [...list, learned]);
    return true;
  };

  // ── arrays
  const arrays = info.arrays ?? (info.arrays = (() => {
    const list = [];
    for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*/g)) {
      const at = m.index + m[0].length;
      if (masked[at] === "[") {
        const close = closing(masked, at);
        if (close > 0) list.push({ name: m[1], pos: m.index, alts: [[at, close]] });
        continue;
      }
      // `cond ? [ … ] : [ … ]`
      const q = /^[^;?=]{1,200}\?\s*\[/.exec(masked.slice(at, at + 260));
      if (!q) continue;
      const a1 = at + q[0].length - 1;
      const c1 = closing(masked, a1);
      const colon = c1 > 0 ? /^\s*:\s*\[/.exec(masked.slice(c1 + 1, c1 + 40)) : null;
      if (!colon) continue;
      const a2 = c1 + 1 + colon[0].length - 1;
      const c2 = closing(masked, a2);
      if (c2 > 0) list.push({ name: m[1], pos: m.index, alts: [[a1, c1], [a2, c2]] });
    }
    return list;
  })());
  /** The alternatives a local array name may hold at `before`: lists of elements. */
  const localArray = (name, before) => {
    let best = null;
    for (const a of arrays) if (a.name === name && a.pos < before && (!best || a.pos > best.pos)) best = a;
    if (!best || lineOf(before) - lineOf(best.pos) > 120) return null;
    const lastClose = best.alts[best.alts.length - 1][1];
    const pushed = [];
    const between = masked.slice(lastClose, before);
    for (const p of between.matchAll(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\.push\\(`, "g"))) {
      const o = lastClose + p.index + p[0].length - 1;
      const c = closing(masked, o);
      if (c > 0) pushed.push(...splitTop(masked.slice(o + 1, c), o + 1));
    }
    return best.alts.map(([o, c]) => [...splitTop(masked.slice(o + 1, c), o + 1), ...pushed]);
  };
  const elementsOf = (expr, pos) => {
    const t = expr.text.trim();
    if (t.startsWith("[")) {
      const o = expr.offset + expr.text.indexOf("[");
      const c = closing(masked, o);
      return c > 0 ? [splitTop(masked.slice(o + 1, c), o + 1)] : null;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(t)) return localArray(t, pos);
    return null;
  };
  const dashed = (text) => [...text.matchAll(/["'`](--?[a-z][a-z0-9-]*)(?:=[^"'`]*)?["'`]/g)].map((m) => m[1]);

  /** Every alternative of an argv once spreads of local arrays (and their ternaries) are spelled out. */
  const expand = (elems, pos, depth = 0) => {
    let out = [[]];
    for (const e of elems) {
      const v = literal(e.text);
      const inner = depth < 2 && /^[A-Za-z_$][\w$]*$/.test(v.spread ?? "") ? localArray(v.spread, pos) : null;
      if (inner) {
        const subs = inner.flatMap((alt) => expand(alt, pos, depth + 1));
        out = out.flatMap((o) => subs.map((sub) => [...o, ...sub])).slice(0, 16);
      } else out = out.map((o) => [...o, e]);
    }
    return out;
  };
  /**
   * One argv alternative → {words, flags, restRaw, dynamicHead, paramSpread, optionsFirst}.
   * `paramSpread` is a spread of a parameter of the enclosing function in
   * command position: the words come from that function's callers.
   */
  const readArgv = (elems, pos) => {
    const words = [];
    const flags = [];
    const restRaw = [];
    let head = true;
    let dynamicHead = false;
    let paramSpread = null;
    let optionsFirst = false;
    let computedFlag = false;
    for (const e of elems) {
      const v = literal(e.text);
      if (v.spread !== undefined) {
        const name = /^[A-Za-z_$][\w$]*$/.test(v.spread) ? v.spread : null;
        if (head && name && enclosing(pos)?.params.includes(name)) paramSpread = { name, words: [...words], flags: [...flags] };
        flags.push(...dashed(v.spread));
        if (head) { head = false; dynamicHead = true; }
        continue;
      }
      const s = textValue(v);
      if (s !== null && s.startsWith("-")) {
        // `--name=${value}` is still the literal option `--name`; a computed name is not read.
        const flag = s.split("=")[0];
        if (flag.includes("*")) computedFlag = true;
        else if (s !== "-" && s !== "--") flags.push(flag);
        if (head && !words.length) optionsFirst = true;
        head = false;
        continue;
      }
      if (head && s !== null && resolve(v).str !== undefined && COMMAND_WORD.test(s)) {
        words.push(s);
        continue;
      }
      if (head && s === null && words.length === 0) dynamicHead = true;
      head = false;
      restRaw.push(e);
    }
    return { words, flags: [...new Set(flags)], restRaw, dynamicHead, paramSpread, optionsFirst, computedFlag };
  };

  const cliUse = (entry, expr, pos, how) => {
    const { harness } = entry;
    const alts = expr ? elementsOf(expr, pos) : null;
    if (!alts) {
      if (expr && learn(pos, expr, { kind: "argv", harness, prefix: entry.prefix })) return;
      return unchecked(harness, "cli", pos, `${how}: argv is computed at runtime`);
    }
    for (const elems of alts.flatMap((alt) => expand(alt, pos))) {
      const a = readArgv(elems, pos);
      if (entry.prefix) {
        a.words = [...entry.prefix.words, ...a.words];
        a.flags = [...new Set([...entry.prefix.flags, ...a.flags])];
      }
      if (a.paramSpread) {
        learn(pos, { text: a.paramSpread.name }, { kind: "argv", harness, prefix: { words: [...(entry.prefix?.words ?? []), ...a.paramSpread.words], flags: [...new Set([...(entry.prefix?.flags ?? []), ...a.paramSpread.flags])] } });
        continue;
      }
      if (a.dynamicHead && !a.words.length) { unchecked(harness, "cli", pos, `${how}: the command is computed at runtime`); continue; }
      const rest = a.restRaw.map((e) => textValue(literal(e.text)));
      if (a.optionsFirst && rest.some((r) => typeof r === "string" && COMMAND_WORD.test(r))) unchecked(harness, "cli", pos, `${how}: options before the command — the command after them is not read`);
      if (a.computedFlag) unchecked(harness, "cli", pos, `${how}: an option name is computed at runtime`);
      emit({ harness, kind: "cli", name: a.words.join(" "), words: a.words, flags: a.flags, rest: rest.slice(0, 3), partial: a.dynamicHead || undefined, site: site(pos) });
      const [w0, w1] = a.words;
      if (w0 === "config" && ["set", "get", "unset"].includes(w1)) {
        const force = a.flags.includes("--force");
        if (a.flags.includes("--batch-json") || a.flags.includes("--batch-file")) unchecked(harness, "config", pos, "config set --batch-json: the paths are in a JSON payload built at runtime");
        else if (typeof rest[0] === "string" && rest[0]) configUse(harness, rest[0], w1, pos, force);
        else if (!(a.restRaw[0] && learn(pos, a.restRaw[0], { kind: "key", harness, op: w1, force: force || undefined }))) unchecked(harness, "config", pos, `config ${w1}: the key is computed at runtime`);
      }
      if (harness === "openclaw" && w0 === "gateway" && w1 === "call") {
        if (typeof rest[0] === "string" && rest[0]) emit({ harness, kind: "rpc", name: rest[0], site: site(pos) });
        else if (!(a.restRaw[0] && learn(pos, a.restRaw[0], { kind: "rpc", harness }))) unchecked(harness, "rpc", pos, "gateway call: the method is computed at runtime");
      }
    }
  };
  const configUse = (harness, key, op, pos, force = false) => {
    const k = key.replace(/\["([^"]+)"\]|\['([^']+)'\]/g, ".$1$2").replace(/\[(\d+|\*)\]/g, ".*");
    if (!k || k.startsWith("*")) return unchecked(harness, "config", pos, `config ${op}: the key's first segment is computed at runtime`);
    emit({ harness, kind: "config", name: k, op, force: force || undefined, site: site(pos) });
  };
  const keyUse = (entry, expr, pos, how) => {
    const k = keyOf(expr);
    if (k) return configUse(entry.harness, k, entry.op, pos, entry.force);
    if (expr && learn(pos, expr, { kind: "key", harness: entry.harness, op: entry.op, force: entry.force })) return;
    unchecked(entry.harness, "config", pos, `${how}: the key is computed at runtime`);
  };
  const rpcNames = (v, strict) => {
    const r = resolve(v);
    if (r?.alt) return r.alt.flatMap((x) => rpcNames(x, strict));
    const s = r?.str;
    if (s === undefined) return [];
    if (s === "connect" || DOTTED.test(s)) return strict && FILE_LIKE.test(s) ? [] : [s];
    return [];
  };

  // ── the registry's calls
  const names = [...registry.keys()].map((n) => n.replace(/\$/g, "\\$")).join("|");
  const callRe = new RegExp(`(?<![\\w$])((?:[\\w$]+\\.)*)(${names})\\s*\\(`, "g");
  for (const m of masked.matchAll(callRe)) {
    const namePos = m.index + m[1].length;
    if (defPositions.has(namePos) || /\bfunction\s*\*?\s*$/.test(masked.slice(Math.max(0, namePos - 12), namePos))) continue;
    const open = m.index + m[0].length - 1;
    const close = closing(masked, open);
    if (close < 0) continue;
    const args = splitTop(masked.slice(open + 1, close), open + 1);
    const pos = m.index;
    for (const entry of registry.get(m[2]) ?? []) {
      const expr = args[entry.index];
      const how = m[2];
      if (entry.kind === "argv") cliUse(entry, expr, pos, how);
      else if (entry.kind === "key") keyUse(entry, expr, pos, how);
      else if (entry.kind === "rpc") {
        const v = expr && literal(expr.text);
        const found = v ? rpcNames(v, false) : [];
        for (const n of found) emit({ harness: entry.harness, kind: "rpc", name: n, site: site(pos) });
        if (!found.length && !(expr && learn(pos, expr, { kind: "rpc", harness: entry.harness }))) unchecked(entry.harness, "rpc", pos, `${how}: the method is computed at runtime`);
      } else if (entry.kind === "setargs") {
        const alts = expr ? elementsOf(expr, pos) : null;
        if (!alts) {
          if (!(expr && learn(pos, expr, { kind: "setargs", harness: entry.harness }))) unchecked(entry.harness, "config", pos, `${how}: the key is computed at runtime`);
          continue;
        }
        for (const elems of alts) keyUse({ harness: entry.harness, op: "set" }, elems[0], pos, how);
      } else if (entry.kind === "batch") {
        const alts = expr ? elementsOf(expr, pos) : null;
        if (!alts) {
          if (!(expr && learn(pos, expr, { kind: "batch", harness: entry.harness }))) unchecked(entry.harness, "config", pos, `${how}: the operations are built at runtime`);
          continue;
        }
        for (const op of alts.flat()) {
          const o = op.text.trim();
          if (o.startsWith("[")) keyUse({ harness: entry.harness, op: "set" }, splitTop(o.slice(1, -1), op.offset + op.text.indexOf("[") + 1)[0], pos, how);
          else unchecked(entry.harness, "config", pos, `${how}: operations from ${o.slice(0, 60)}`);
        }
      } else if (entry.kind === "keylist") {
        const t = expr?.text.trim() ?? "";
        const objs = /^Object\.values\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(t);
        const members = objs ? info.objects.get(objs[1]) ?? consts.globalObjects.get(objs[1]) : null;
        if (members) for (const k of members) keyUse({ harness: entry.harness, op: entry.op }, { text: k }, pos, how);
        else if (t.startsWith("[")) for (const p of splitTop(t.slice(1, -1))) keyUse({ harness: entry.harness, op: entry.op }, p, pos, how);
        else if (!(expr && learn(pos, expr, { kind: "keylist", harness: entry.harness, op: entry.op }))) unchecked(entry.harness, "config", pos, `${how}: the keys are computed at runtime`);
      } else if (entry.kind === "hpatch") {
        const t = expr?.text.trim() ?? "";
        if (!t.startsWith("{")) { unchecked(entry.harness, "config", pos, `${how}: the patch is built at runtime`); continue; }
        for (const p of splitTop(t.slice(1, -1))) {
          const kv = /^\s*(set|unset)\s*(?::\s*([\s\S]+))?$/.exec(p.text);
          if (!kv) continue;
          const body = (kv[2] ?? kv[1]).trim();
          const parts = body.startsWith("{") || body.startsWith("[") ? splitTop(body.slice(1, -1)) : null;
          if (!parts) { unchecked(entry.harness, "config", pos, `${how}: ${kv[1]} is built at runtime`); continue; }
          for (const e of parts) {
            const km = kv[1] === "set" ? /^\s*(?:\[([^\]]+)\]|"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(e.text) : null;
            const k = kv[1] === "set" ? km && (km[1] ? keyOf({ text: km[1] }) : km[2] ?? km[3] ?? km[4]) : keyOf(e);
            if (k) configUse(entry.harness, k, "write", pos);
            else unchecked(entry.harness, "config", pos, `${how}: a key is computed at runtime`);
          }
        }
      }
    }
  }

  // ── a harness binary handed to a process launcher: `spawn(bin, argv)`.
  const bins = info.bins ?? (info.bins = (() => {
    const oc = new Set(["openclawBin()", "findOpenclawBin()", "openclawBin"]);
    if (/\b(?:findOpenclawBin|openclawBin)\b/.test(masked)) oc.add("OPENCLAW_BIN");
    const he = new Set(["HERMES_BIN", "hermesBin()"]);
    for (const m of masked.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w.]+\s*(?:\|\||\?\?)\s*)?(findOpenclawBin|openclawBin|hermesBin)\(\)/g)) (m[2] === "hermesBin" ? he : oc).add(m[1]);
    return { openclaw: oc, hermes: he };
  })());
  const binAlt = [...bins.openclaw, ...bins.hermes].map((b) => b.replace(/[()$]/g, "\\$&")).join("|");
  for (const m of masked.matchAll(new RegExp(`(?<![\\w$])((?:[\\w$]+\\.)*)([A-Za-z_$][\\w$]*)\\s*\\((?=\\s*(?:${binAlt})\\s*,)`, "g"))) {
    if (!LAUNCHERS.test(m[2])) continue;
    const open = m.index + m[0].length - 1;
    const close = closing(masked, open);
    if (close < 0) continue;
    const args = splitTop(masked.slice(open + 1, close), open + 1);
    const harness = bins.hermes.has(args[0].text.trim()) ? "hermes" : "openclaw";
    if (args[1]) cliUse({ harness }, args[1], m.index, `${m[1]}${m[2]}`);
  }
  // `[…, openclawBin(), ...args]` — a wrapper such as flock in front of the CLI.
  for (const m of masked.matchAll(/,\s*(?:openclawBin|findOpenclawBin)\(\)\s*,\s*\.\.\.([A-Za-z_$][\w$]*)/g)) {
    cliUse({ harness: "openclaw" }, { text: m[1], offset: m.index }, m.index, "argv after the binary");
  }
  // `{ bin: () => HERMES_BIN, args: [ … ] }` — a driver table.
  for (const m of masked.matchAll(/\bbin\s*:\s*\(\)\s*=>\s*(HERMES_BIN|hermesBin\(\)|OPENCLAW_BIN|openclawBin\(\)|findOpenclawBin\(\))/g)) {
    const ahead = masked.slice(m.index, m.index + 800);
    const a = /\bargs\s*:\s*\[/.exec(ahead);
    if (!a || /\bbin\s*:/.test(ahead.slice(5, a.index))) continue;
    const o = m.index + a.index + a[0].length - 1;
    cliUse({ harness: /HERMES|hermes/.test(m[1]) ? "hermes" : "openclaw" }, { text: masked.slice(o, closing(masked, o) + 1), offset: o }, m.index, "driver table");
  }
  if (learnOnly) return;

  // ── OpenClaw gateway RPC, and the events it pushes (never in a Hermes file).
  if (!isHermesFile) {
    for (const m of masked.matchAll(/(?<![\w$])(?:[\w$]+\.)*(?:request|call)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close < 0) continue;
      const v = literal(splitTop(masked.slice(open + 1, close))[0]?.text ?? "");
      for (const n of rpcNames(v, true)) emit({ harness: "openclaw", kind: "rpc", name: n, site: site(m.index) });
    }
    for (const m of masked.matchAll(/\bmethod\s*:\s*("[^"\n]*"|'[^'\n]*')/g)) {
      for (const n of rpcNames(literal(m[1]), true)) emit({ harness: "openclaw", kind: "rpc", name: n, site: site(m.index) });
    }
    for (const m of masked.matchAll(/(?:\b(?:eventName|event)|\.event)\s*===?\s*("[^"\n]*"|'[^'\n]*')/g)) {
      const s = literal(m[1]).str;
      if (s && /^[a-z][A-Za-z]*(?:\.[A-Za-z]+)*$/.test(s)) emit({ harness: "openclaw", kind: "event", name: s, site: site(m.index) });
    }
    for (const m of masked.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*_EVENT\s*=\s*("[^"\n]*"|'[^'\n]*')/g)) {
      const s = literal(m[1]).str;
      if (s && /^[a-z][A-Za-z]*\.[a-z][A-Za-z.]*$/.test(s)) emit({ harness: "openclaw", kind: "event", name: s, site: site(m.index) });
    }
  }
  // OpenClaw plugin hooks, in ClawBox's own OpenClaw plugins.
  if (file.startsWith("scripts/openclaw-plugins/")) {
    for (const m of masked.matchAll(/\bapi\.on\(\s*("[^"\n]*"|'[^'\n]*')/g)) {
      const s = literal(m[1]).str;
      if (s) emit({ harness: "openclaw", kind: "hook", name: s, site: site(m.index) });
    }
  }

  // ── Hermes dashboard: JSON-RPC methods sent, events waited for, REST routes.
  if (isHermesFile) {
    const firstNonSpace = (p) => p.offset + (p.text.length - p.text.trimStart().length);
    for (const m of masked.matchAll(/(?<![\w$.])call\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close < 0) continue;
      const v = literal(splitTop(masked.slice(open + 1, close))[0]?.text ?? "");
      for (const n of rpcNames(v, true).filter((x) => x !== "connect")) emit({ harness: "hermes", kind: "rpc", name: n, site: site(m.index) });
    }
    for (const m of masked.matchAll(/\bmethod\s*:\s*/g)) {
      const startAt = m.index + m[0].length;
      const end = masked.slice(startAt).search(/[,\n}]/);
      for (const n of rpcNames(literal(masked.slice(startAt, startAt + end)), true).filter((x) => x !== "connect")) emit({ harness: "hermes", kind: "rpc", name: n, site: site(m.index) });
    }
    for (const m of masked.matchAll(/\bconst\s+EVENTS?\s*=\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      for (const p of close > 0 ? splitTop(masked.slice(open + 1, close), open + 1) : []) {
        const s = literal(p.text.replace(/^\s*[\w$]+\s*:/, "")).str;
        if (s && DOTTED.test(s)) emit({ harness: "hermes", kind: "event", name: s, site: site(firstNonSpace(p)) });
      }
    }
    for (const m of masked.matchAll(/\btype\s*===?\s*("[^"\n]*"|'[^'\n]*')/g)) {
      const s = literal(m[1]).str;
      if (s && DOTTED.test(s)) emit({ harness: "hermes", kind: "event", name: s, site: site(m.index) });
    }
    // A string or template that starts (after an origin) with /api/… or /auth/….
    for (const m of masked.matchAll(/(["'`])(?:\$\{[A-Za-z_$][\w$.]*\})?(\/(?:api|auth)\/[^"'`\s?#]+)/g)) {
      const routePath = m[2].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "*").replace(/([^/])\*$/, "$1").replace(/\/+$/, "");
      const ahead = masked.slice(m.index, m.index + 400).split(/\n\s*\n/)[0];
      const before = masked.slice(Math.max(0, m.index - 60), m.index);
      const method = /new\s+WebSocket\s*\(\s*$/.test(before) ? "WS"
        : (/\bmethod\s*:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/.exec(ahead) ?? /\bmethod\s*:\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*$/.exec(before))?.[1];
      emit({ harness: "hermes", kind: "route", name: routePath, method, site: site(m.index) });
    }
  }
}

// ── Python (ClawKeep drives the OpenClaw CLI) ───────────────────────────────
function scanPython(file, src, record, skip) {
  if (!/openclaw/i.test(path.basename(file))) return;
  const lines = src.split("\n");
  const lists = new Map(); // name -> {line, items}
  const listItems = (text) => splitTop(text).map((p) => {
    const t = p.text.trim();
    if (t.startsWith("*")) return { spread: t.slice(1).trim() };
    const m = /^(['"])(.*)\1$/.exec(t);
    return m ? { str: m[2] } : { dyn: t };
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*$/, "");
    let m;
    if ((m = /^\s*([a-z_][\w]*)\s*=\s*\[(.*)\]\s*$/.exec(l))) lists.set(m[1], { line: i + 1, items: listItems(m[2]) });
    if ((m = /^\s*([a-z_][\w]*)\.append\((['"])(--?[\w-]+)\2\)/.exec(l)) && lists.has(m[1])) lists.get(m[1]).items.push({ str: m[3] });
    if ((m = /\b_run\(\s*binary\s*,\s*(\[[^\]]*\]|[a-z_]\w*)/.exec(l))) {
      let items = m[1].startsWith("[") ? listItems(m[1].slice(1, -1)) : lists.get(m[1])?.items;
      if (items) items = items.flatMap((x) => (x.spread && lists.has(x.spread) ? lists.get(x.spread).items : [x]));
      if (!items) { skip("openclaw", "cli", `${file}:${i + 1}`, "_run: argv is computed at runtime"); continue; }
      const words = [];
      for (const x of items) { if (x.str !== undefined && COMMAND_WORD.test(x.str)) words.push(x.str); else break; }
      const flags = [...new Set(items.filter((x) => x.str?.startsWith("-")).map((x) => x.str.split("=")[0]))];
      record({ harness: "openclaw", kind: "cli", name: words.join(" "), words, flags, rest: [], site: `${file}:${i + 1}` });
    }
  }
}

// ── shell (install.sh, the scripts, systemd units) ──────────────────────────
const SHELL_STOP = new Set(["|", "||", "&&", ";", "&", ")", "|&", ";;", "then", "do", "fi", "done", "else", "{", "}"]);
// Commands that run the next word as a command (their own options skipped).
const SHELL_WRAPPERS = /^(timeout|sudo|env|runuser|exec|command|nohup|as_clawbox|as_user|as_user_runtime|as_owner|flock|setsid|nice|ionice|stdbuf|time|then|do|else|if|while|until|!)$/;

/** Shell words of one logical line: {text, quoted, dynamic, op}. A redirection and its target are dropped. */
function shellWords(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) { i++; continue; }
    const op = /^(\|\||&&|\|&|;;|[|;&()<>])/.exec(line.slice(i));
    if (op && !(op[1] === "(" && line[i - 1] === "$")) {
      if (op[1] === ">" || op[1] === "<") {
        i++;
        while (line[i] === ">" || line[i] === "&" || line[i] === "<" || line[i] === "-") i++;
        while (/\s/.test(line[i] ?? "")) i++;
        while (i < line.length && !/[\s|;&()]/.test(line[i])) {
          if (line[i] === '"' || line[i] === "'") i = closingQuote(line, i);
          i++;
        }
        continue;
      }
      words.push({ text: op[1], op: true });
      i += op[1].length;
      continue;
    }
    let text = "";
    let quoted = false;
    let dynamic = false;
    const start = i;
    while (i < line.length && !/[\s|;&()<>]/.test(line[i])) {
      const ch = line[i];
      if (ch === "'") {
        const e = line.indexOf("'", i + 1);
        text += line.slice(i + 1, e < 0 ? line.length : e);
        quoted = true;
        i = e < 0 ? line.length : e + 1;
      } else if (ch === '"') {
        let e = i + 1;
        while (e < line.length && line[e] !== '"') { if (line[e] === "\\") e++; e++; }
        const inner = line.slice(i + 1, e);
        if (/\$|`/.test(inner)) dynamic = true;
        text += inner;
        quoted = true;
        i = e + 1;
      } else if (ch === "$" && line[i + 1] === "(") {
        const e = substitutionEnd(line, i + 1);
        text += line.slice(i, e + 1);
        dynamic = true;
        i = e + 1;
      } else if (ch === "\\") {
        text += line[i + 1] ?? "";
        i += 2;
      } else {
        if (ch === "$" || ch === "`") dynamic = true;
        text += ch;
        i++;
      }
    }
    if (i === start) { i++; continue; }
    words.push({ text, quoted, dynamic });
  }
  return words;
}

/** Index of the `)` closing the `(` at `open`, quotes respected. */
function substitutionEnd(line, open) {
  let depth = 0;
  for (let e = open; e < line.length; e++) {
    const c = line[e];
    if (c === "'" ) { const q = line.indexOf("'", e + 1); e = q < 0 ? line.length : q; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return e;
  }
  return line.length - 1;
}

/** The commands inside `$( … )`, at any depth and inside double quotes too. */
function substitutions(line) {
  const out = [];
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" && q === null) { q = "'"; continue; }
    if (c === '"') { q = q === '"' ? null : '"'; continue; }
    if (c === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
      const e = substitutionEnd(line, i + 1);
      const inner = line.slice(i + 2, e);
      out.push(inner, ...substitutions(inner));
      i = e;
    }
  }
  return out;
}

/** `tts.providers.$NAME.command` → `tts.providers.*.command`. */
const shellTemplate = (s) => s.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\([^)]*\)/g, "*");
const BIN_PATH = /(?:^|\/)bin\/(openclaw|hermes)$/;
const isArgsForward = (w) => !w.op && /^\$(?:@|\{@\}|\*)$/.test(w.text);

function scanShell(file, src, record, skip) {
  const isUnit = file.endsWith(".service");
  const raw = src.split("\n");
  const logical = [];
  for (let i = 0; i < raw.length; i++) {
    let text = raw[i];
    const line = i + 1;
    while (/\\$/.test(text) && i + 1 < raw.length) text = text.slice(0, -1) + " " + raw[++i];
    text = stripShellComment(text);
    if (isUnit) {
      const m = /^\s*Exec[A-Za-z]*=[-@+!:]*(.*)$/.exec(text);
      if (!m) continue;
      text = m[1];
    }
    logical.push({ line, text });
    for (const sub of substitutions(text)) logical.push({ line, text: sub });
  }
  // Binaries: a variable assigned a path ending in /openclaw or /hermes.
  const bins = new Map([["OPENCLAW_BIN", "openclaw"], ["HERMES_BIN", "hermes"]]);
  for (const { text } of logical) {
    const m = /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(text);
    const h = m && /\/(openclaw|hermes)["'}]*\s*$/.exec(m[2]);
    if (h && /bin\/|BIN/.test(m[2])) bins.set(m[1], h[1]);
  }
  /** The invocations on one line: {harness, args, at} — `args` the words after the invoker. */
  const invocations = (text, forwarders) => {
    const words = shellWords(text);
    const found = [];
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      if (word.op) continue;
      let harness = null;
      let fwd = null;
      const ref = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/.exec(word.text);
      if (ref && bins.has(ref[1])) harness = bins.get(ref[1]);
      else if (BIN_PATH.test(word.text)) harness = BIN_PATH.exec(word.text)[1];
      else if (!word.quoted && (word.text === "openclaw" || word.text === "hermes")) harness = word.text;
      else if (!word.quoted && forwarders?.has(word.text) && words[w + 1]?.text !== "(") ({ harness } = fwd = forwarders.get(word.text));
      if (!harness) continue;
      // Only in command position: after an operator, or after a wrapper such as
      // `timeout -k 5 60`, `env HOME=…`, `as_clawbox -H` — never `dirname "$BIN"`.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) continue; // `X=…/bin/openclaw` names it, runs nothing
      let k = w - 1;
      while (k >= 0 && !words[k].op && !SHELL_WRAPPERS.test(words[k].text)
        && (/^-[-A-Za-z]*$/.test(words[k].text) || /^\d+$/.test(words[k].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text) || words[k].dynamic
          || /^-(u|g|-user|-group)$/.test(words[k - 1]?.text ?? ""))) k--;
      if (k >= 0 && !(words[k].op && SHELL_STOP.has(words[k].text)) && !SHELL_WRAPPERS.test(words[k].text)) continue;
      if (k >= 0 && words[k].op && !SHELL_STOP.has(words[k].text)) continue;
      if (k >= 0 && words[k].text === "!" && /^(\[|\[\[|test)$/.test(words[k - 1]?.text ?? "")) continue; // `[ ! -x "$BIN" ]`
      const args = [];
      for (let a = w + 1; a < words.length && !(words[a].op && SHELL_STOP.has(words[a].text)); a++) if (!words[a].op) args.push(words[a]);
      found.push({ harness, args: fwd ? [...fwd.prefix.map((t) => ({ text: t })), ...args.slice(fwd.shifts)] : args });
    }
    return found;
  };
  // Functions that forward their arguments to a harness:
  // `name() { … <invoker> [fixed words] "$@" … }`, after any `shift`s.
  const forwarders = new Map();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < logical.length; i++) {
      const head = /^(\s*)(?:function\s+)?([a-z_][a-z0-9_]*)\s*\(\)\s*\{(.*)$/.exec(logical[i].text);
      if (!head) continue;
      const body = [head[3]];
      if (!/\}\s*$/.test(head[3])) {
        let nested = null; // a function defined inside this one forwards for itself, not for this one
        for (let j = i + 1; j < logical.length && j < i + 80; j++) {
          const t = logical[j].text;
          if (new RegExp(`^${head[1]}\\}\\s*$`).test(t)) break;
          if (nested !== null) { if (new RegExp(`^${nested}\\}\\s*$`).test(t)) nested = null; continue; }
          const inner = /^(\s*)(?:function\s+)?[a-z_][a-z0-9_]*\s*\(\)\s*\{(.*)$/.exec(t);
          if (inner) { if (!/\}\s*$/.test(inner[2])) nested = inner[1]; continue; }
          body.push(t);
        }
      }
      const shifts = (body.join("\n").match(/\bshift\b/g) ?? []).length;
      for (const text of body) {
        for (const inv of invocations(text, forwarders)) {
          const at = inv.args.findIndex(isArgsForward);
          if (at < 0 || !inv.args.slice(0, at).every((a) => !a.dynamic && COMMAND_WORD.test(a.text))) continue;
          forwarders.set(head[2], { harness: inv.harness, prefix: inv.args.slice(0, at).map((a) => a.text), shifts });
        }
      }
    }
  }
  for (const { line, text } of logical) {
    const at = `${file}:${line}`;
    for (const { harness, args } of invocations(text, forwarders)) {
      if (args.some(isArgsForward)) continue; // a forwarder's own body; its callers are read instead
      const cmdWords = [];
      let k = 0;
      for (; k < args.length && !args[k].dynamic && COMMAND_WORD.test(args[k].text); k++) cmdWords.push(args[k].text);
      if (k === 0 && args[0]?.dynamic) { skip(harness, "cli", at, "the command is computed at runtime"); continue; }
      // `--name="$X"` is still the literal option `--name`; a computed name is not read.
      const optionWords = args.filter((a) => /^--?[a-z]/i.test(a.text));
      const flags = [...new Set(optionWords.map((a) => a.text.split("=")[0]).filter((f) => !f.includes("$")))];
      if (optionWords.some((a) => a.text.split("=")[0].includes("$"))) skip(harness, "cli", at, "an option name is computed at runtime");
      const after = args.slice(k).filter((a) => !/^--?[a-z]/i.test(a.text));
      if (k === 0 && /^--?[a-z]/i.test(args[0]?.text ?? "") && after.some((a) => !a.dynamic && COMMAND_WORD.test(a.text))) skip(harness, "cli", at, "options before the command — the command after them is not read");
      if (!cmdWords.length && !flags.length && !after.length) continue; // names the binary, runs nothing checkable
      record({ harness, kind: "cli", name: cmdWords.join(" "), words: cmdWords, flags, rest: after.slice(0, 3).map((a) => (a.dynamic ? null : a.text)), site: at });
      if (cmdWords[0] === "config" && ["set", "get", "unset"].includes(cmdWords[1])) {
        const key = after[0];
        if (flags.includes("--batch-json") || flags.includes("--batch-file")) skip(harness, "config", at, "config set --batch-json: the paths are in a JSON payload built at runtime");
        else if (!key) skip(harness, "config", at, `config ${cmdWords[1]}: no key on the line`);
        else {
          const k2 = key.dynamic ? shellTemplate(key.text) : key.text;
          if (!k2 || k2.startsWith("*")) skip(harness, "config", at, `config ${cmdWords[1]}: the key is computed at runtime`);
          else record({ harness, kind: "config", name: k2, op: cmdWords[1], force: flags.includes("--force") || undefined, site: at });
        }
      }
      if (harness === "openclaw" && cmdWords[0] === "gateway" && cmdWords[1] === "call") {
        const m = after[0];
        if (m && !m.dynamic) record({ harness, kind: "rpc", name: m.text, site: at });
        else skip(harness, "rpc", at, "gateway call: the method is computed at runtime");
      }
    }
  }
}

function stripShellComment(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1])) && text[i - 1] !== "$") return text.slice(0, i);
  }
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `scan.mjs [repo]` → usage JSON; `scan.mjs --unchecked [repo]` → the record
  // config/harness-contract-unchecked.json keeps (call sites per file and reason).
  const args = process.argv.slice(2);
  const snapshot = args[0] === "--unchecked" ? args.shift() : null;
  const root = path.resolve(args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const scan = scanTree(root);
  if (!snapshot) process.stdout.write(`${JSON.stringify(scan, null, 1)}\n`);
  else {
    const counts = {};
    for (const u of scan.unchecked) {
      const file = u.site.split(/:(?=\d+$)/)[0];
      counts[file] ??= {};
      counts[file][u.why] = (counts[file][u.why] ?? 0) + 1;
    }
    const sorted = Object.fromEntries(Object.keys(counts).sort().map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort())]));
    process.stdout.write(`${JSON.stringify(sorted, null, 1)}\n`);
  }
}
