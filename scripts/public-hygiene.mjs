#!/usr/bin/env node
// public-hygiene — keeps internal details out of this PUBLIC repository
// (TASK-1366).
//
// Everything here is public: the files, the pull requests and their comments,
// and every Actions log, job summary and artifact. None of them may carry
//
//   private-ip     an address in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
//                  fc00::/7 or fe80::/10 — the lab network, someone's LAN
//   home-path      /home/<name> or /Users/<name>: it names an account
//   internal-name  the lab host, a station user, a runner host or an internal
//                  server (INTERNAL_NAME_SHA256 below)
//   staff-email    an address at idrobots.com or clawbox.com other than the
//                  published support contact
//   token          a credential: GitHub, AWS, Slack, OpenAI/Anthropic, Google,
//                  GitLab, npm, Hugging Face, a Telegram bot, a private key
//
// Not findings: the RFC 5737 documentation ranges (192.0.2.0/24,
// 198.51.100.0/24, 203.0.113.0/24), 127.0.0.0/8 and 0.0.0.0, none of which is
// private; the product's own setup hotspot, 10.42.0.0/24 and the 10.43.0.0/24
// it falls back to, which is the same on every box; a private range written
// as its own base address (10.0.0.0/8, fc00::/7, fe80::); /home/clawbox, the
// product's user on every box; and the support contact.
//
// Usage:
//   node scripts/public-hygiene.mjs scan-diff <base> [<head>]
//       The lines a pull request ADDS — `git diff <base>...<head>`, head
//       defaulting to HEAD — lockfiles skipped. The `public-hygiene` check.
//   node scripts/public-hygiene.mjs scan-files <file|dir>...
//       Every line of these files.
//   node scripts/public-hygiene.mjs redact [--mask-env VAR[=PLACEHOLDER]]...
//       Copies stdin to stdout, every finding replaced by a placeholder.
//   node scripts/public-hygiene.mjs redact-files [--mask-env ...] <file|dir>...
//       The same, in place, for every file under them. A file that is not
//       text cannot be redacted and is deleted.
//
// A scan prints `file:line: category` per finding and NEVER what matched: the
// check's log is as public as the line it found. Exit 0 clean, 1 on a finding,
// 2 on a usage or git error.
//
// A line that must keep what it names carries the marker
// `public-hygiene: allow <reason>`, in a comment, and a scan skips it. The
// reason is required: a bare marker does not count. Redaction honours no
// marker — what gets published is redacted whole.
//
// --mask-env VAR=PLACEHOLDER replaces the value of the environment variable
// VAR, first and wherever it appears: the nano workflow hides its board's
// address that way even when the lab is not on a private range.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPPORT_CONTACT = "yanko@idrobots.com";
const STAFF_DOMAINS = ["idrobots.com", "clawbox.com"];
const PRODUCT_USER = "clawbox";

// The internal names, as the SHA-256 of the lower-case name, so that this
// public file does not spell them out. Hashing keeps them out of plain sight;
// it is no secret — a short name can be guessed back from its hash. A line is
// split into words and their dotted or dashed compounds (`a-b.c`), and every
// run of them is looked up here. To add a name:
//   printf '%s' '<name>' | sha256sum
export const INTERNAL_NAME_SHA256 = new Set([
  "2f4a5519f8e79f66620d7d45ba1a852517b16639e8d95e793a0128dc183a1d31", // the lab host, and its station user
  "9b6b95a584b5c38e26616a4588a1f54b0e74eba7d859db14b5dfabc0ba7f75d4", // the flash station, and its user
  "5ec4b6589c000ed3ec8ebac8524cd9c71981578a8740e1c70f7e178d89d99026", // the team's lab dashboard
]);

export const CATEGORIES = ["private-ip", "home-path", "internal-name", "staff-email", "token"];

// Lockfiles hold registry URLs and integrity hashes, never anything of ours.
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"]);
export const isLockfile = (file) => {
  const base = path.posix.basename(file);
  return LOCKFILES.has(base) || base.endsWith(".lock");
};

const hashCache = new Map();
export function sha256(text) {
  let hash = hashCache.get(text);
  if (hash === undefined) {
    if (hashCache.size > 200_000) hashCache.clear();
    hash = createHash("sha256").update(text).digest("hex");
    hashCache.set(text, hash);
  }
  return hash;
}

// The shapes real credentials have, long enough that the short made-up keys
// the tests use (`sk-ant-api03-abc…`, `xoxb-1111-2222`) are not taken for one.
const TOKEN_RES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g, // GitHub fine-grained
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abposr]-(?:\d+-){2,3}[A-Za-z0-9]{20,}/g, // Slack
  /\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{80,}/g, // Anthropic, OpenAI
  /\bsk-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/g, // OpenAI, the older shape
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bhf_[A-Za-z0-9]{34,}/g, // Hugging Face
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g, // Telegram bot
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, // a private key block
];

const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])/g;
// The account name ends before a trailing dot: `/home/clawbox.` ends a sentence.
const HOME_RE = /(?<![\w.~$-])\/(home|Users)\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g;
const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d)/g;
// Redaction also takes an address glued to a word (`host_10.1.2.3`): what is
// published may lose a version string, but never keeps an address.
const IPV4_LOOSE_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
const IPV6_RE = /(?<![\w:.])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*/gi;
const WORDS_RE = /[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*/g;
// A private range named by its base address, e.g. in a firewall rule.
const IPV4_BLOCKS = new Set(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
const IPV6_BLOCK_BASES = new Set(["fc00::", "fd00::", "fe80::"]);

const isPrivateV4 = ([a, b]) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
const isProductHotspot = ([a, b, c]) => a === 10 && (b === 42 || b === 43) && c === 0;

// The longest runs of a word compound's parts (`x-y.z` -> x, x-y, x-y.z, y, …)
// that are internal names, replaced; a compound of more than 12 parts is
// looked at part by part.
function redactCompound(compound, names, hit) {
  const pieces = compound.split(/([.-])/);
  const parts = pieces.filter((_, i) => i % 2 === 0);
  const seps = pieces.filter((_, i) => i % 2 === 1);
  const join = (i, j) => {
    let s = parts[i];
    for (let k = i + 1; k <= j; k++) s += seps[k - 1] + parts[k];
    return s;
  };
  const out = [];
  let i = 0;
  while (i < parts.length) {
    let end = -1;
    for (let j = parts.length > 12 ? i : parts.length - 1; j >= i; j--) {
      const run = join(i, j);
      if (run.length >= 3 && names.has(sha256(run.toLowerCase()))) {
        end = j;
        break;
      }
    }
    if (end >= 0) {
      out.push(hit("internal-name", "<internal-name>"));
      i = end + 1;
    } else {
      out.push(parts[i]);
      i += 1;
    }
    if (i < parts.length) out.push(seps[i - 1]);
  }
  return out.join("");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A masked address is replaced wherever it is not part of a longer one, even
// glued to a word: `known_hosts_<it>`.
function maskPattern(value) {
  if (/^[0-9.]+$/.test(value)) return new RegExp(`(?<![0-9.])${escapeRe(value)}(?![0-9]|\\.[0-9])`, "g");
  if (/^[0-9A-Fa-f.:]+$/.test(value)) return new RegExp(`(?<![0-9A-Fa-f:.])${escapeRe(value)}(?![0-9A-Fa-f:]|\\.[0-9])`, "g");
  return null;
}

/**
 * Every finding in `text` replaced by its placeholder. `hit(category,
 * placeholder)` is called once per finding and returns what replaces it.
 * Options: `names` (a Set of SHA-256 hex, default INTERNAL_NAME_SHA256) and
 * `masks` ([{ value, placeholder }], replaced first).
 */
function rewrite(text, hit, { names = INTERNAL_NAME_SHA256, masks = [], loose = false } = {}) {
  let out = text;
  for (const { value, placeholder } of masks) {
    if (!value || value.length < 3) continue;
    const pattern = maskPattern(value);
    out = pattern ? out.replace(pattern, () => hit("masked", placeholder)) : out.split(value).join(placeholder);
  }
  for (const re of TOKEN_RES) out = out.replace(re, () => hit("token", "<token>"));
  out = out.replace(EMAIL_RE, (match, domain) => {
    const address = match.toLowerCase();
    if (address === SUPPORT_CONTACT) return match;
    const host = domain.toLowerCase();
    const staff = STAFF_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    return staff || names.has(sha256(address)) ? hit("staff-email", "<email>") : match;
  });
  out = out.replace(HOME_RE, (match, dir, user) => {
    if (dir === "home" && user === PRODUCT_USER) return match;
    if (dir === "Users" && user === "Shared") return match;
    return hit("home-path", `/${dir}/<user>`);
  });
  out = out.replace(loose ? IPV4_LOOSE_RE : IPV4_RE, (match, a, b, c, d, offset, whole) => {
    const octets = [a, b, c, d].map(Number);
    if (octets.some((o) => o > 255) || !isPrivateV4(octets) || isProductHotspot(octets)) return match;
    const prefix = /^\/\d{1,2}(?!\d)/.exec(whole.slice(offset + match.length));
    if (prefix && IPV4_BLOCKS.has(match + prefix[0])) return match;
    return hit("private-ip", "<private-ip>");
  });
  out = out.replace(IPV6_RE, (match) => {
    if ((match.match(/:/g) || []).length < 2 || IPV6_BLOCK_BASES.has(match.toLowerCase())) return match;
    return hit("private-ip", "<private-ip>");
  });
  if (names.size > 0) out = out.replace(WORDS_RE, (compound) => redactCompound(compound, names, hit));
  return out;
}

/** `text` with every finding replaced by a placeholder; `counts` collects them per category. */
export function redactText(text, options = {}, counts = {}) {
  return rewrite(
    text,
    (category, placeholder) => {
      counts[category] = (counts[category] || 0) + 1;
      return placeholder;
    },
    { ...options, loose: true },
  );
}

const MARKER_RE = /public-hygiene:\s*allow\b(.*)$/;

/** The reason a line's allow marker gives: null without a marker, "" when it gives none. */
export function allowReason(line) {
  const m = MARKER_RE.exec(line);
  if (!m) return null;
  return m[1]
    .replace(/\s*(?:--!?>|\*\/|%>|#\}|\}\})\s*$/, "")
    .replace(/^[\s:=,;()—–-]+/, "")
    .trim();
}

/**
 * The categories a line holds — sorted, each once — and whether an allow
 * marker with a reason exempts it. `markerWithoutReason` flags a bare marker.
 */
export function inspectLine(line, options = {}) {
  const reason = allowReason(line);
  if (reason !== null && /[A-Za-z]{3,}/.test(reason)) return { categories: [], allowed: true, markerWithoutReason: false };
  const found = new Set();
  rewrite(line, (category, placeholder) => (found.add(category), placeholder), options);
  return {
    categories: CATEGORIES.filter((c) => found.has(c)),
    allowed: false,
    markerWithoutReason: reason !== null,
  };
}

// `"b/a\tb"` -> `b/a<TAB>b`: git quotes a path with unusual characters.
function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const bytes = [];
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next || "")) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Reads a unified diff (`git diff --unified=0 --src-prefix=a/ --dst-prefix=b/`)
 * line by line; `feed` returns { file, line, text } for an added line.
 */
export class DiffReader {
  constructor() {
    this.file = null;
    this.inHunk = false;
    this.next = 0;
  }

  feed(raw) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      this.file = null;
      this.inHunk = false;
      return null;
    }
    if (!this.inHunk) {
      if (line.startsWith("+++ ")) {
        const target = unquotePath(line.slice(4));
        this.file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      } else if (line.startsWith("@@")) {
        this.startHunk(line);
      }
      return null;
    }
    if (line.startsWith("@@")) {
      this.startHunk(line);
      return null;
    }
    if (line.startsWith("+")) {
      const added = { file: this.file, line: this.next, text: raw.slice(1) };
      this.next += 1;
      return added;
    }
    if (line.startsWith(" ")) this.next += 1;
    return null;
  }

  startHunk(line) {
    const m = /^@@+ (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @@/.exec(line);
    this.inHunk = Boolean(m);
    this.next = m ? Number(m[1]) : 0;
  }
}

// Lines of a stream split on "\n" alone (a lone "\r" is content), decoded as
// UTF-8 across chunk boundaries. The last line comes with `last: true` and no
// newline after it when the input ended without one.
async function* lines(stream) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      yield { text: pending.slice(0, nl), newline: true };
      pending = pending.slice(nl + 1);
    }
  }
  pending += decoder.end();
  if (pending !== "") yield { text: pending, newline: false };
}

const printable = (file) => {
  const safe = String(file).replace(/[\x00-\x1f\x7f]/g, "?");
  return safe.startsWith(":") ? `./${safe}` : safe;
};
const commandProperty = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");

function report(findings, checked, what) {
  for (const f of findings) {
    const note = f.markerWithoutReason ? " (its allow marker gives no reason, so it does not count)" : "";
    console.log(`${printable(f.file)}:${f.line}: ${f.categories.join(", ")}${note}`);
  }
  const files = new Set(findings.map((f) => f.file)).size;
  console.log(
    findings.length === 0
      ? `public-hygiene: ${checked} ${what} checked, nothing to report`
      : `public-hygiene: ${findings.length} of ${checked} ${what} (in ${files} file${files === 1 ? "" : "s"}) name what this public repository must not`,
  );
  if (findings.length === 0) return;
  console.log(
    "Replace it with a placeholder — <lab-host>, <board-ip>, ~ or $HOME, an address from 192.0.2.0/24 —\n" +
      "or, where a line must keep it, end the line with a comment `public-hygiene: allow <why>`.",
  );
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const f of findings.slice(0, 50)) {
      console.log(`::error file=${commandProperty(f.file)},line=${f.line},title=public-hygiene::${f.categories.join(", ")}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cell = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, "?").replace(/[|`<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    const rows = findings.slice(0, 500).map((f) => `| <code>${cell(f.file)}</code> | ${f.line} | ${f.categories.join(", ")} |`);
    const more = findings.length > 500 ? [`| … | | ${findings.length - 500} more in the log |`] : [];
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`## public-hygiene: ${findings.length} line${findings.length === 1 ? "" : "s"} to fix`, "", "| File | Line | Category |", "|---|---|---|", ...rows, ...more, ""].join("\n") + "\n",
    );
  }
}

function check(file, line, text, findings) {
  const result = inspectLine(text);
  if (result.categories.length > 0) findings.push({ file, line, categories: result.categories, markerWithoutReason: result.markerWithoutReason });
}

async function scanDiff(base, head) {
  const ref = /^[A-Za-z0-9._/@^~{}-]+$/;
  if (!ref.test(base) || !ref.test(head) || base.startsWith("-") || head.startsWith("-")) {
    console.error("public-hygiene: scan-diff takes two commits or refs");
    return 2;
  }
  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--unified=0", `${base}...${head}`, "--"];
  const git = spawn("git", args, { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => {
    git.on("error", (err) => resolve({ code: null, err }));
    git.on("close", (code) => resolve({ code }));
  });
  const reader = new DiffReader();
  const findings = [];
  let checked = 0;
  for await (const { text } of lines(git.stdout)) {
    const added = reader.feed(text);
    if (!added || added.file === null || isLockfile(added.file)) continue;
    checked += 1;
    check(added.file, added.line, added.text, findings);
  }
  const { code, err } = await exited;
  if (err || code !== 0) {
    console.error(`public-hygiene: git diff ${base}...${head} failed${err ? `: ${err.message}` : ` (exit ${code})`}`);
    return 2;
  }
  report(findings, checked, "added lines");
  return findings.length === 0 ? 0 : 1;
}

// Every entry under `target`, with whether it is a regular file. A symlink
// below the top is reported as one, not followed.
function* walk(target, top = true) {
  const stat = top ? fs.statSync(target) : fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target).sort()) {
      if (entry === ".git" || entry === "node_modules") continue;
      yield* walk(path.join(target, entry), false);
    }
  } else {
    yield { file: target, regular: stat.isFile() };
  }
}

const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

function scanFiles(targets) {
  const findings = [];
  let checked = 0;
  for (const target of targets) {
    for (const { file, regular } of walk(target)) {
      if (!regular || isLockfile(file)) continue;
      const buffer = fs.readFileSync(file);
      if (isBinary(buffer)) continue;
      buffer
        .toString("utf8")
        .split("\n")
        .forEach((text, i) => {
          checked += 1;
          check(file, i + 1, text, findings);
        });
    }
  }
  report(findings, checked, "lines");
  return findings.length === 0 ? 0 : 1;
}

function parseMasks(args) {
  const masks = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--mask-env") {
      rest.push(args[i]);
      continue;
    }
    const spec = args[i + 1] || "";
    i += 1;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.+))?$/.exec(spec);
    if (!m) throw new Error("--mask-env takes VAR or VAR=PLACEHOLDER");
    masks.push({ value: process.env[m[1]] || "", placeholder: m[2] || "<masked>" });
  }
  return { masks, rest };
}

const summarize = (counts) =>
  ["masked", ...CATEGORIES]
    .filter((category) => counts[category])
    .map((category) => `${counts[category]} ${category}`)
    .join(", ") || "nothing";

async function redactStream(options) {
  // Downstream of a command that is being cancelled: keep passing its last
  // words through until it closes the pipe, rather than die first and leave
  // it writing into nothing.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const write = (s) => (process.stdout.write(s) ? null : new Promise((resolve) => process.stdout.once("drain", resolve)));
  for await (const { text, newline } of lines(process.stdin)) {
    const waiting = write(redactText(text, options) + (newline ? "\n" : ""));
    if (waiting) await waiting;
  }
  return 0;
}

function redactFiles(targets, options) {
  const counts = {};
  let changed = 0;
  for (const target of targets) {
    for (const { file, regular } of walk(target)) {
      // A link or a device would be published as whatever it points at.
      if (!regular) {
        fs.rmSync(file, { force: true });
        console.error(`public-hygiene: removed ${printable(path.basename(file))}: not a regular file, so it cannot be redacted`);
        continue;
      }
      const buffer = fs.readFileSync(file);
      if (isBinary(buffer)) {
        fs.rmSync(file);
        console.error(`public-hygiene: removed ${printable(path.basename(file))}: not text, so it cannot be redacted`);
        continue;
      }
      const text = buffer.toString("utf8");
      const out = redactText(text, options, counts);
      if (out !== text) {
        fs.writeFileSync(file, out);
        changed += 1;
      }
    }
  }
  console.error(`public-hygiene: redacted ${summarize(counts)} in ${changed} file${changed === 1 ? "" : "s"}`);
  return 0;
}

const USAGE = `Usage:
  node scripts/public-hygiene.mjs scan-diff <base> [<head>]
  node scripts/public-hygiene.mjs scan-files <file|dir>...
  node scripts/public-hygiene.mjs redact [--mask-env VAR[=PLACEHOLDER]]...
  node scripts/public-hygiene.mjs redact-files [--mask-env VAR[=PLACEHOLDER]]... <file|dir>...`;

export async function main(argv) {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "scan-diff":
        if (args.length < 1 || args.length > 2) break;
        return await scanDiff(args[0], args[1] || "HEAD");
      case "scan-files":
        if (args.length === 0) break;
        return scanFiles(args);
      case "redact": {
        const { masks, rest } = parseMasks(args);
        if (rest.length > 0) break;
        return await redactStream({ masks });
      }
      case "redact-files": {
        const { masks, rest } = parseMasks(args);
        if (rest.length === 0) break;
        return redactFiles(rest, { masks });
      }
      case "-h":
      case "--help":
        console.log(USAGE);
        return 0;
    }
  } catch (err) {
    console.error(`public-hygiene: ${err.message}`);
    return 2;
  }
  console.error(USAGE);
  return 2;
}

// Run as a command, not imported. Both sides with symlinks resolved: Node
// resolves them for the module's own URL, and a path through a linked folder
// must not turn the scanner into a silent no-op.
const invokedAs = (arg) => {
  try {
    return pathToFileURL(fs.realpathSync(path.resolve(arg))).href;
  } catch {
    return null;
  }
};
if (process.argv[1] && invokedAs(process.argv[1]) === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href) {
  process.exitCode = await main(process.argv.slice(2));
}
