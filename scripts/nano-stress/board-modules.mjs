#!/usr/bin/env node
// What the board side of the stress run needs (TASK-2500): its entry,
// board-stress.mjs, and every local module that entry imports, followed
// through those modules' own imports. run.sh ships exactly this set, so a
// module split out of board-stress.mjs reaches the board without anyone
// remembering to list it (a run once died at start on the board with
// ERR_MODULE_NOT_FOUND for the one file run.sh did not copy).
//
//   node scripts/nano-stress/board-modules.mjs list <entry.mjs>
//       the files, one per line, relative to the folder they share
//   node scripts/nano-stress/board-modules.mjs pack <entry.mjs> <out.tgz>
//       a gzipped tar of them, relative to that folder; prints the entry's
//       path inside it
//
// The board folder has no node_modules, so an import this cannot ship — a bare
// package name, an absolute path or URL, an `import()` of a computed value, a
// file that is not there — fails here, on the host, before anything starts on
// the board. Node's own modules (`node:fs`, `fs`) need nothing shipped.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUILTINS = new Set(builtinModules);

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[\w$]/;
// After these a `/` starts a regular expression, not a division.
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * The tokens of a JavaScript source, as far as finding its imports needs:
 * identifiers (`id`), quoted strings (`str`, with their text), template
 * literals (`tpl`, whose `${…}` code is tokenised in place), numbers and
 * single punctuation characters (`p`). Comments and regular-expression
 * literals are dropped, so a commented-out import, a quote inside a regex or
 * a `//` inside "http://…" is never read as code.
 */
export function tokenize(src) {
  const n = src.length;
  const toks = [];
  let i = 0;
  let depth = 0; // brace depth in code
  const templates = []; // the brace depth at each open `${`
  const last = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.t === "p") return REGEX_AFTER.has(t.v) || t.v === "}";
    if (t.t === "id") return REGEX_AFTER_WORDS.has(t.v);
    return false;
  };
  // A template's text from `j` up to its closing backtick (open: false) or its
  // next `${` (open: true).
  const templateText = (j) => {
    while (j < n) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "`") return { end: j + 1, open: false };
      if (src[j] === "$" && src[j + 1] === "{") return { end: j + 2, open: true };
      j++;
    }
    return { end: n, open: false };
  };
  const template = (from, part) => {
    const t = templateText(from);
    i = t.end;
    if (t.open) { templates.push(depth); toks.push({ t: "tpl", part, open: true }); }
    else toks.push({ t: "tpl", part, open: false });
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && next === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; continue; }
        text += src[j++];
      }
      toks.push({ t: "str", v: text });
      i = j + 1;
      continue;
    }
    if (c === "`") { template(i + 1, "start"); continue; }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      if (src[j] === "/") {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        toks.push({ t: "re" });
        i = j;
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: "num" });
      i = j;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        template(i + 1, "rest");
        continue;
      }
      depth--;
    }
    toks.push({ t: "p", v: c });
    i++;
  }
  return toks;
}

const isP = (t, v) => t && t.t === "p" && t.v === v;
const isId = (t, v) => t && t.t === "id" && (v === undefined || t.v === v);

/**
 * Every module specifier one source file names: static imports and
 * re-exports (`export … from`), side-effect imports, and `import("literal")`.
 * An `import()` of anything but a plain quoted string is counted in
 * `computed`: what it loads cannot be known here.
 */
export function importSpecifiers(source) {
  const toks = tokenize(source);
  const specifiers = new Set();
  let computed = 0;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (!isId(tok) || (tok.v !== "import" && tok.v !== "export") || isP(toks[k - 1], ".")) continue;
    const nx = toks[k + 1];
    if (tok.v === "import") {
      if (isP(nx, ".")) continue; // import.meta
      if (isP(nx, "(")) {
        const arg = toks[k + 2];
        if (arg && arg.t === "str" && (isP(toks[k + 3], ")") || isP(toks[k + 3], ","))) specifiers.add(arg.v);
        else computed++;
        continue;
      }
      if (nx && nx.t === "str") { specifiers.add(nx.v); continue; } // import "./side-effect.mjs"
      // import a, { b as c } from "…" / import * as ns from "…"
      for (let j = k + 1; j < toks.length; j++) {
        const t = toks[j];
        if (isId(t, "from") && toks[j + 1]?.t === "str") { specifiers.add(toks[j + 1].v); break; }
        if (!(isId(t) || isP(t, ",") || isP(t, "{") || isP(t, "}") || isP(t, "*"))) break;
      }
      continue;
    }
    // export * from "…" / export * as ns from "…" / export { a, b as c } from "…"
    let j = k + 1;
    if (isP(nx, "*")) {
      j = k + 2;
      if (isId(toks[j], "as")) j += 2;
    } else if (isP(nx, "{")) {
      while (j < toks.length && !isP(toks[j], "}")) j++;
      j++;
    } else continue;
    if (isId(toks[j], "from") && toks[j + 1]?.t === "str") specifiers.add(toks[j + 1].v);
  }
  return { specifiers: [...specifiers], computed };
}

/** "builtin", "local" (./ or ../), or why it cannot be shipped. */
export function classify(specifier) {
  if (specifier.startsWith("node:") || BUILTINS.has(specifier)) return { kind: "builtin" };
  if (specifier.startsWith("./") || specifier.startsWith("../")) return { kind: "local" };
  if (specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return { kind: "refused", why: `${specifier} is an absolute path or URL, which does not exist in the board folder` };
  }
  return { kind: "refused", why: `${specifier} is a package, and the board folder has no node_modules` };
}

/**
 * The entry and every local module it reaches, as absolute paths (entry
 * first). Throws, naming the importing file, on anything it cannot ship.
 */
export function moduleClosure(entry) {
  const first = path.resolve(entry);
  if (!fs.statSync(first, { throwIfNoEntry: false })?.isFile()) throw new Error(`${entry} does not exist`);
  const seen = new Set([first]);
  const queue = [first];
  while (queue.length) {
    const file = queue.shift();
    const { specifiers, computed } = importSpecifiers(fs.readFileSync(file, "utf8"));
    if (computed) throw new Error(`${file}: ${computed} import() of a computed value; ship only literal imports`);
    for (const spec of specifiers) {
      const c = classify(spec);
      if (c.kind === "builtin") continue;
      if (c.kind === "refused") throw new Error(`${file}: ${c.why}`);
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw new Error(`${file}: imports ${spec}, which is not a file`);
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return [...seen];
}

/** The folder every file sits under, and each file relative to it. */
export function shipPlan(entry) {
  const files = moduleClosure(entry);
  let root = path.dirname(files[0]);
  for (const f of files) {
    while (path.relative(root, f).startsWith("..")) root = path.dirname(root);
  }
  const rel = files.map((f) => path.relative(root, f));
  return { root, files: rel, entry: rel[0] };
}

function main(argv) {
  const [cmd, entry, out] = argv;
  if (!entry || (cmd === "pack" && !out) || !["list", "pack"].includes(cmd)) {
    console.error("usage: board-modules.mjs list <entry.mjs> | pack <entry.mjs> <out.tgz>");
    return 2;
  }
  let plan;
  try {
    plan = shipPlan(entry);
  } catch (e) {
    console.error(`board-modules: ${e.message}`);
    return 1;
  }
  if (cmd === "list") {
    process.stdout.write(plan.files.join("\n") + "\n");
    return 0;
  }
  const tar = spawnSync("tar", ["-czf", out, "-C", plan.root, ...plan.files], { encoding: "utf8" });
  if (tar.status !== 0) {
    console.error(`board-modules: tar failed: ${(tar.stderr || tar.error?.message || "").trim()}`);
    return 1;
  }
  process.stdout.write(plan.entry + "\n");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
