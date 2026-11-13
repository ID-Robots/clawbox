// Runs ON the board, for scripts/nano-tests/tests/73-local-coding-provider.sh:
// watches where a coding run's processes connect while it works, without root.
//
//   node run-egress-sampler.mjs --out PATH --stop-file PATH [--max-seconds N] [--every-ms N]
//
// Every --every-ms (default 150) it reads `ss -tnpH` (TCP sockets in any
// state, with their owning processes — the box's own user's are visible
// without privileges) and keeps each socket whose process is Claude Code or
// runs under it: a process whose own command line, or an ancestor's, names
// `claude`. The web server is never one of them, so its own traffic (a
// heartbeat, an update check) is not counted against the run.
//
// What it writes to --out, once it stops (the stop file appears, or
// --max-seconds pass): one JSON object —
//   { samples, processes, endpoints: { "<ip>:<port>": count }, external: [...] }
// where `external` is every endpoint that is not loopback. A sampler misses a
// connection that opens and closes between two samples; a request to a model
// is a TLS handshake and a streamed answer, far longer than a sample.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = arg("out");
const STOP = arg("stop-file");
const MAX_MS = Number(arg("max-seconds", "1800")) * 1000;
const EVERY = Number(arg("every-ms", "150"));

const verdict = new Map();
function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}
function parent(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  } catch {
    return 0;
  }
}
/** Is this process Claude Code, or under it? Cached per pid for the sampler's life. */
function inRun(pid) {
  if (verdict.has(pid)) return verdict.get(pid);
  let p = pid;
  let yes = false;
  for (let depth = 0; p > 1 && depth < 40; depth += 1) {
    const cmd = cmdline(p);
    if (/(^|\/|\s)claude(\s|$)/.test(cmd) || /\/claude(\.exe)?\s/.test(cmd) || /claude-ds/.test(cmd)) {
      yes = true;
      break;
    }
    p = parent(p);
  }
  verdict.set(pid, yes);
  return yes;
}
const loopback = (ip) => ip.startsWith("127.") || ip === "::1" || ip === "[::1]" || ip.startsWith("::ffff:127.");

const endpoints = {};
const processes = new Set();
let samples = 0;
const started = Date.now();
function sample() {
  let text = "";
  try {
    text = execFileSync("ss", ["-tnpH"], { encoding: "utf8", timeout: 2000 });
  } catch {
    return;
  }
  samples += 1;
  for (const line of text.split("\n")) {
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (!pids.some(inRun)) continue;
    const cols = line.trim().split(/\s+/);
    // State Recv-Q Send-Q Local Peer [Process]
    const peer = cols[4];
    if (!peer) continue;
    const ip = peer.slice(0, peer.lastIndexOf(":")).replace(/^\[|\]$/g, "");
    const port = peer.slice(peer.lastIndexOf(":") + 1);
    const key = `${ip}:${port}`;
    endpoints[key] = (endpoints[key] ?? 0) + 1;
    for (const pid of pids) processes.add(cmdline(pid).split(" ")[0].split("/").pop());
  }
}
function finish() {
  const external = Object.keys(endpoints).filter((k) => !loopback(k.slice(0, k.lastIndexOf(":"))));
  fs.writeFileSync(OUT, JSON.stringify({ samples, processes: [...processes].filter(Boolean), endpoints, external }));
  process.exit(0);
}
const timer = setInterval(() => {
  sample();
  if ((STOP && fs.existsSync(STOP)) || Date.now() - started > MAX_MS) {
    clearInterval(timer);
    finish();
  }
}, EVERY);
console.log("SAMPLING");
