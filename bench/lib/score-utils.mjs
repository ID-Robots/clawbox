// Shared helpers for bench task scorers. Deterministic on purpose: no LLM,
// no network, no clocks in the objective path. Every helper returns plain
// {name, pass, detail, weight} check objects; summarize() turns a list of
// them into the {score, max, checks} contract compare.mjs reads.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

export function check(name, pass, detail = "", weight = 1) {
  return { name, pass: Boolean(pass), detail, weight };
}

export function summarize(checks) {
  const max = checks.reduce((sum, c) => sum + c.weight, 0);
  const got = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);
  return {
    score: max === 0 ? 0 : Math.round((got / max) * 100),
    max: 100,
    points: got,
    pointsMax: max,
    checks,
  };
}

export function exists(workdir, rel) {
  return fs.existsSync(path.join(workdir, rel));
}

export function read(workdir, rel) {
  try {
    return fs.readFileSync(path.join(workdir, rel), "utf8");
  } catch {
    return null;
  }
}

export function listFiles(workdir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a workdir the run never created scores as empty, not a crash
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(workdir, full));
    }
  };
  walk(workdir);
  return out.sort();
}

/** Byte-identical to the copy shipped in the task's seed/? */
export function unchangedFromSeed(workdir, seedDir, rel) {
  const now = read(workdir, rel);
  const seed = read(seedDir, rel);
  return now !== null && seed !== null && now === seed;
}

export async function run(cmd, args, { cwd, timeoutMs = 60_000, env } = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd,
      timeout: timeoutMs,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      code: err.code ?? -1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}

/** `node --check` — does the file parse? */
export async function nodeCheck(workdir, rel) {
  const res = await run("node", ["--check", rel], { cwd: workdir });
  return check(
    `parses: ${rel}`,
    res.ok,
    res.ok ? "" : (res.stderr || "").split("\n")[0],
  );
}

/** `node --test` in the workdir; returns {passCount, failCount, check}. */
export async function nodeTest(workdir, { timeoutMs = 120_000 } = {}) {
  const res = await run("node", ["--test"], { cwd: workdir, timeoutMs });
  const tap = res.stdout + res.stderr;
  const passCount = Number(tap.match(/^# pass (\d+)/m)?.[1] ?? -1);
  const failCount = Number(tap.match(/^# fail (\d+)/m)?.[1] ?? -1);
  return {
    passCount,
    failCount,
    check: check(
      "node --test passes",
      res.ok && failCount === 0 && passCount > 0,
      `pass=${passCount} fail=${failCount}`,
      3,
    ),
  };
}

/** All href/src/action references in an HTML file, raw. */
export function htmlRefs(html) {
  const refs = [];
  const re = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  return refs;
}

/** Every internal link/asset in every given HTML file resolves to a file. */
export function internalLinksResolve(workdir, htmlFiles) {
  const broken = [];
  for (const file of htmlFiles) {
    const html = read(workdir, file);
    if (html === null) continue;
    for (const ref of htmlRefs(html)) {
      if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(ref)) continue;
      const target = ref.split("#")[0].split("?")[0];
      if (!target) continue;
      const resolved = path.join(workdir, path.dirname(file), target);
      if (!fs.existsSync(resolved)) broken.push(`${file} -> ${ref}`);
    }
  }
  return check(
    "internal links resolve",
    broken.length === 0,
    broken.slice(0, 5).join("; "),
    2,
  );
}

/** No external network references (script/img/link/fetch to http(s)). */
export function noExternalRefs(workdir, files) {
  const hits = [];
  for (const file of files) {
    const text = read(workdir, file);
    if (text === null) continue;
    const re = /https?:\/\/[^\s"'<>)]+/gi;
    let m;
    while ((m = re.exec(text))) hits.push(`${file}: ${m[0].slice(0, 60)}`);
  }
  return check(
    "no external network references",
    hits.length === 0,
    hits.slice(0, 5).join("; "),
    2,
  );
}

const ANTI_PATTERNS = [
  { name: "TODO/FIXME left behind", re: /\b(TODO|FIXME|XXX)\b/ },
  { name: "lorem ipsum", re: /lorem ipsum/i },
  { name: "placeholder text", re: /\bplaceholder\b(?![^<]*>)/i },
  { name: "truncation marker", re: /\/\/ \.\.\.|\/\* \.\.\. \*\/|<!-- \.\.\. -->/ },
];

/** The doc's anti-pattern sweep. `allow` exempts patterns a task legitimately uses. */
export function antiPatterns(workdir, files, { allow = [] } = {}) {
  const hits = [];
  for (const file of files) {
    const text = read(workdir, file);
    if (text === null) continue;
    for (const p of ANTI_PATTERNS) {
      if (allow.includes(p.name)) continue;
      if (p.re.test(text)) hits.push(`${file}: ${p.name}`);
    }
  }
  return check(
    "no anti-patterns",
    hits.length === 0,
    hits.slice(0, 6).join("; "),
    1,
  );
}

/** Count occurrences of a literal string across files. */
export function countOccurrences(workdir, files, literal) {
  let count = 0;
  for (const file of files) {
    const text = read(workdir, file);
    if (text === null) continue;
    let idx = 0;
    while ((idx = text.indexOf(literal, idx)) !== -1) {
      count++;
      idx += literal.length;
    }
  }
  return count;
}

/**
 * Honesty: every file path a run summary names must exist in the workdir.
 * Catches summaries that claim files the run never delivered.
 */
export function summaryClaimsVerifiable(workdir, summary) {
  if (!summary) return check("summary names only real files", true, "no summary to check");
  const claimed = new Set();
  const re = /`([\w./-]+\.(?:html|css|js|mjs|json|md|ts|py))`/g;
  let m;
  while ((m = re.exec(summary))) claimed.add(m[1].replace(/^\.\//, ""));
  const missing = [...claimed].filter((rel) => !exists(workdir, rel));
  return check(
    "summary names only real files",
    missing.length === 0,
    missing.slice(0, 5).join("; "),
    1,
  );
}

/** CLI shim: `node score.mjs <workdir> [record.json]` for hand runs. */
export async function cliMain(scoreFn, importMetaUrl) {
  const invoked = process.argv[1] && path.resolve(process.argv[1]);
  const self = new URL(importMetaUrl).pathname;
  if (invoked !== self) return;
  const [workdir, recordPath] = process.argv.slice(2);
  if (!workdir) {
    console.error("usage: node score.mjs <workdir> [record.json]");
    process.exit(2);
  }
  const runRecord = recordPath
    ? JSON.parse(fs.readFileSync(recordPath, "utf8"))
    : null;
  const result = await scoreFn({ workdir: path.resolve(workdir), run: runRecord });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.checks.every((c) => c.pass) ? 0 : 1);
}
