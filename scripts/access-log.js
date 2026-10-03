// scripts/access-log.js
//
// HTTP access log for the ClawBox web tier.
//
// Until this existed the device kept NO record of any HTTP request. A QA probe
// for a unique path over both the LAN and the public Cloudflare tunnel produced
// zero journal lines on the box and there was no access-log file anywhere on
// disk, so "which tunnel hostname is this request arriving on, and from where"
// was simply unanswerable — the retired-quick-tunnel investigation stalled on
// exactly that.
//
// Written as CommonJS because its only consumer, production-server.js, is CJS
// (it has to be: it monkey-patches http.Server.prototype.listen before Next's
// standalone bundle is required).
//
// The line goes to stdout, which for clawbox-setup.service is the journal — and
// the journal is persistent now (config/journald-clawbox.conf), so these
// survive a reboot. `logs_tail { unit: "clawbox-setup" }` surfaces them to the
// agent with no extra wiring.
//
// An open desktop POLLS: the notice ring every 2 s, the shelf's ClawKeep
// shield, the power prompt and the monitor layout every 5 s, the ClawBox AI
// status, Telegram pairing, the chat's run card... Logged one line each, that
// was ~110 lines a minute from one idle desktop — 97% of the unit's journal,
// ~150 MB a day of export volume written to the eMMC, and the reason real
// diagnostics fell out of the 200 MB cap within days — all of it the same 200
// every few seconds. So a REPEAT of a quiet poll is folded (see
// `quietPollKey`): the first one from a client is logged as it always was, and
// so is one every QUIET_REPEAT_LOG_MS after it, carrying `quiet=N` for the
// repeats left out in between. A count that no such line is going to carry —
// the polling stopped, the request was forgotten to make room for another, the
// server is stopping — is written on a line of its own
// (`formatQuietCountLine`), so every request is either a line or counted on
// one. Errors, aborts, slow answers and writes are never folded.
// CLAWBOX_ACCESS_LOG_POLLS=1 logs every one of them again.

/** Query parameter names whose VALUE must never reach a log line. */
const SENSITIVE_QUERY_KEY = /(token|secret|password|passwd|pwd|key|auth|code|sig)/i;

/** Hard ceiling on the logged request target. Bounds a log-flood line. */
const MAX_PATH_CHARS = 512;
const MAX_HOST_CHARS = 128;

/** Request targets skipped by default — build assets, high volume, zero signal. */
const STATIC_PREFIXES = ["/_next/static/", "/_next/image"];

/**
 * How often a repeated quiet poll still gets a line of its own. Long enough
 * that an idle desktop's dozen polls cost the journal a few lines an hour
 * instead of thousands; short enough that a client still polling over a
 * tunnel hostname shows up in any window someone would look at.
 */
const QUIET_REPEAT_LOG_MS = 10 * 60_000;
/** A poll slower than this is logged every time: a slow answer is a finding. */
const QUIET_MAX_DURATION_MS = 1_000;
/**
 * Distinct (request, client, host) repeats remembered at once. A desktop polls
 * about a dozen targets; past the cap the one whose last line is oldest is
 * forgotten — its count written first, on a line of its own — which otherwise
 * only means its next request is logged as a first sighting.
 */
const MAX_QUIET_KEYS = 256;

function isOff(value) {
  return value === "0" || value === "false" || value === "off" || value === "no";
}

/** Access logging is on unless CLAWBOX_ACCESS_LOG explicitly turns it off. */
function accessLogEnabled(env = process.env) {
  return !isOff(String(env.CLAWBOX_ACCESS_LOG || "").toLowerCase());
}

/** Static assets are skipped unless CLAWBOX_ACCESS_LOG_STATIC asks for them. */
function logsStaticAssets(env = process.env) {
  const raw = String(env.CLAWBOX_ACCESS_LOG_STATIC || "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Every poll is logged, one line each, when CLAWBOX_ACCESS_LOG_POLLS asks for it. */
function logsEveryPoll(env = process.env) {
  const raw = String(env.CLAWBOX_ACCESS_LOG_POLLS || "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Strip anything that could forge a second log line or a terminal escape. */
function stripControl(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? "?" : ch;
  }
  return out;
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The request target with sensitive query VALUES replaced by `REDACTED`.
 * Parameter names are kept — knowing a request carried `?token=` is the useful
 * half, and the value is the half that must not be written down.
 */
function sanitizePath(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return "-";
  const clean = stripControl(rawUrl);
  const q = clean.indexOf("?");
  if (q < 0) return truncate(clean, MAX_PATH_CHARS);

  const pathname = clean.slice(0, q);
  const redacted = clean
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      return SENSITIVE_QUERY_KEY.test(safeDecode(name)) ? `${name}=REDACTED` : pair;
    })
    .join("&");

  return truncate(`${pathname}?${redacted}`, MAX_PATH_CHARS);
}

/** First entry of a possibly comma-joined forwarding header, if it looks like an IP. */
function firstForwardedIp(headerValue) {
  if (!headerValue) return null;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const first = String(raw).split(",")[0].trim();
  // Deliberately loose (v4, v6, v6-with-zone) but closed: a client controls
  // these headers, so anything that is not IP-shaped is dropped rather than
  // echoed into the log.
  if (!first || first.length > 45 || !/^[0-9a-fA-F.:%]+$/.test(first)) return null;
  return normalizeIp(first);
}

function normalizeIp(value) {
  if (!value) return null;
  // ::ffff:192.0.2.5 is how a v4 client shows up on a dual-stack listener.
  return String(value).replace(/^::ffff:/i, "");
}

/**
 * Client IP, Cloudflare-aware.
 *
 * Remote access runs through a Cloudflare Quick Tunnel, so for every request
 * that matters `req.socket.remoteAddress` is 127.0.0.1 and the only real client
 * address is in `cf-connecting-ip`. Order: cf-connecting-ip, x-forwarded-for,
 * x-real-ip, socket.
 *
 * Note these headers are client-settable on a direct LAN request — the value is
 * a diagnostic, not an authentication input, and nothing here consumes it as one.
 */
function clientIp(req) {
  const headers = (req && req.headers) || {};
  return (
    firstForwardedIp(headers["cf-connecting-ip"]) ||
    firstForwardedIp(headers["x-forwarded-for"]) ||
    firstForwardedIp(headers["x-real-ip"]) ||
    normalizeIp(req && req.socket && req.socket.remoteAddress) ||
    "-"
  );
}

/**
 * The Host header the request arrived on. This is what makes a stray tunnel
 * hostname traceable: the same box answers on clawbox.local, an IP, and every
 * *.trycloudflare.com URL it has ever published, and the access line is the only
 * place that distinction is recorded.
 */
function requestHost(req) {
  const headers = (req && req.headers) || {};
  const raw = headers["host"];
  if (!raw) return "-";
  const host = stripControl(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!host || !/^[A-Za-z0-9._:\-[\]]+$/.test(host)) return "-";
  return truncate(host, MAX_HOST_CHARS);
}

/**
 * One access line. Stable, greppable, fixed field order:
 *
 *   [access] 200 GET /setup-api/system/stats 9ms ip=192.0.2.10 host=clawbox.local
 *   [access] 404 GET /probe 1ms ip=203.0.113.7 host=abc.trycloudflare.com aborted
 *   [access] 200 GET /setup-api/clawkeep 14ms ip=192.0.2.10 host=clawbox.local quiet=119
 *
 * `quiet=N` — N quiet requests from this client, to the same route with the
 * same query parameter names, were left out since the previous line for it
 * (see `quietPollKey`). The line itself is one request more, with its own full
 * target.
 */
function formatAccessLine(entry) {
  const parts = [
    "[access]",
    String(entry.status == null ? "-" : entry.status),
    stripControl(entry.method || "-"),
    entry.path || "-",
    `${Math.max(0, Math.round(entry.durationMs || 0))}ms`,
    `ip=${entry.ip || "-"}`,
    `host=${entry.host || "-"}`,
  ];
  if (entry.aborted) parts.push("aborted");
  if (entry.quiet > 0) parts.push(`quiet=${Math.floor(entry.quiet)}`);
  return parts.join(" ");
}

/**
 * The line for a count no request line is going to carry: nobody has asked for
 * the request in a whole window, or it was forgotten to make room, or the
 * server is going away. It is NOT a request — it has no status and no duration, which
 * is how it reads apart from one — and it names the request the way it was
 * counted, the route with its parameter names and no values:
 *
 *   [access] - GET /setup-api/kv?key - ip=192.0.2.10 host=clawbox.local quiet=299
 *
 * Without it a desktop that polled for nine minutes and was then closed showed
 * ONE request where there had been hundreds, and so did every poll a restart
 * or a full table cut short.
 */
function formatQuietCountLine(entry) {
  return [
    "[access]",
    "-",
    stripControl(entry.method || "-"),
    entry.target || "-",
    "-",
    `ip=${entry.ip || "-"}`,
    `host=${entry.host || "-"}`,
    `quiet=${Math.floor(entry.quiet || 0)}`,
  ].join(" ");
}

function shouldSkip(rawUrl, env) {
  if (logsStaticAssets(env)) return false;
  const target = typeof rawUrl === "string" ? rawUrl : "";
  return STATIC_PREFIXES.some((p) => target.startsWith(p));
}

/**
 * A sanitised target as its repeats are counted: the path, and the NAMES of its
 * query parameters — sorted, each once — without their values.
 *
 * Keyed on the whole target, every distinct value was a request of its own:
 * browsing folders (`files?path=…`) or a run's evidence (`artifacts?runId=…`)
 * filled the table with one-off reads and pushed the desktop's steady polls
 * out of it, so each of those started over as a first sighting. The names stay
 * in the key because they tell one call from another on the same route — the
 * whole store (`kv`), one key (`kv?key`), an app's keys (`kv?prefix`).
 */
function quietTarget(path) {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const names = new Set();
  for (const pair of path.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    if (name) names.add(name);
  }
  const route = path.slice(0, q);
  return names.size > 0 ? `${route}?${[...names].sort().join("&")}` : route;
}

/**
 * The request as its repeats are folded — `{ method, target }` — or null for a
 * request that is logged every time.
 *
 * A poll is a GET (or HEAD) of the box's own API: a read, answered the same
 * way however often it is asked. A page, the gateway's paths and every write
 * are not polls.
 *
 * No write is folded. `POST /setup-api/kv` was, for the mascot's clocked
 * position save, but the same POST is how the agent's `ui_notify` and
 * `clawbox notify` reach the desktop and how a web app saves through the KV
 * bridge, so folding it hid agent actions behind a count. Only the BODY tells
 * them apart — the bridge's save and the mascot's are the same browser request
 * with the same headers — and this logger never reads a body: it observes, and
 * reading the stream would compete with Next for it. A KV save costs a line,
 * which for the mascot is one per settled move.
 */
function quietPoll(method, path) {
  const m = String(method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return null;
  const target = quietTarget(path);
  return target.startsWith("/setup-api/") ? { method: m, target } : null;
}

/**
 * The key a request's repeats are folded under, or null for a request that is
 * logged every time (see `quietPoll`). The key is the request as it is counted
 * (`quietTarget`, taken from the sanitised target, so nothing longer than a
 * line is kept) and the client and host it came from, so a second desktop, a
 * phone, or the same desktop over the tunnel is a first sighting of its own.
 */
function quietPollKey(method, path, ip, host) {
  const poll = quietPoll(method, path);
  return poll ? pollKey(poll, ip, host) : null;
}

function pollKey(poll, ip, host) {
  return `${poll.method} ${poll.target} ${ip} ${host}`;
}

/** An answer that says nothing a previous one to the same request did not: no error, not cut off, not slow. */
function isQuietAnswer(status, aborted, durationMs) {
  return typeof status === "number" && status < 400 && !aborted && durationMs < QUIET_MAX_DURATION_MS;
}

/**
 * The last flush of every attached logger, run by ONE 'exit' listener however
 * many servers are attached — a listener each would trip Node's
 * too-many-listeners warning in anything that attaches more than ten.
 *
 * 'exit' and nothing earlier, because production-server.js owns the shutdown:
 * its SIGTERM handler closes the listeners and calls process.exit. A SIGTERM
 * or 'beforeExit' handler here would be a second say in that (a signal
 * handler replaces the default kill, and 'beforeExit' can keep the loop
 * alive); an 'exit' listener runs after the decision, synchronously, and can
 * neither delay nor cancel it. What it writes is a handful of short lines,
 * which a stdout pipe or the journal's socket takes into its buffer at once
 * unless that buffer is already full. A process killed outright (SIGKILL, the
 * OOM killer) runs no listener and loses them with everything else.
 */
const exitFlushes = new Set();
let exitListening = false;

function flushAtExit(flush) {
  exitFlushes.add(flush);
  if (exitListening) return;
  exitListening = true;
  process.on("exit", () => {
    for (const run of exitFlushes) {
      try {
        run();
      } catch {
        // The process is leaving either way; the next flush still gets its turn.
      }
    }
  });
}

/**
 * Attach the request logger to an http/https server.
 *
 * Adding a second 'request' listener does not displace Next's handler — Node
 * calls every registered listener — so this observes without intercepting. The
 * timer stops on 'close' rather than 'finish' because an aborted response never
 * fires 'finish', and a request that died halfway is exactly the one worth
 * having in the log.
 *
 * Counts of folded repeats that no later line will carry are written on lines
 * of their own (`formatQuietCountLine`) when the request is forgotten to make
 * room, on a sweep every QUIET_REPEAT_LOG_MS for requests that stopped, and
 * when the server closes or the process exits. `options.atExit` stands in for
 * the process-wide exit hook (tests).
 *
 * Returns true when logging was attached, false when it is disabled.
 */
function attachAccessLog(server, options = {}) {
  const env = options.env || process.env;
  if (!accessLogEnabled(env)) return false;
  const write = options.write || ((line) => console.log(line));
  const now = options.now || (() => Number(process.hrtime.bigint() / 1000000n));
  const foldPolls = !logsEveryPoll(env);
  /**
   * key → the request as it is counted (method, target, ip, host), when its
   * last line was written (`loggedAt`), when it was last asked (`lastAt`), and
   * the quiet repeats left out since that line. Oldest line first: a key is
   * deleted and set again with every line it gets.
   */
  const repeats = new Map();
  /** The sweep's timer, armed only while `repeats` holds something. */
  let sweepTimer = null;

  /** Write the count an entry still holds, which no later line is going to carry. */
  const writeCount = (entry) => {
    if (entry.quiet > 0) write(formatQuietCountLine(entry));
  };

  const stopSweep = () => {
    if (sweepTimer === null) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  };

  /**
   * Forget every request nobody has asked for in a whole window — its last
   * line is older still — writing what it counted. Judged on the last ASK, not
   * the last line: a poll still going gets its count onto its own next line,
   * and a sweep landing between its window and that repeat would split it in
   * two. A poll that stopped is written here one to two windows after its
   * last request.
   */
  const sweep = () => {
    try {
      const at = now();
      for (const [key, entry] of repeats) {
        if (at - entry.lastAt < QUIET_REPEAT_LOG_MS) continue;
        repeats.delete(key);
        writeCount(entry);
      }
    } catch {
      // A throw out of a timer would take the whole server down; a lost count would not.
    }
    // Nothing left to count: no wake-ups on a box nobody is polling.
    if (repeats.size === 0) stopSweep();
  };

  const armSweep = () => {
    if (sweepTimer !== null) return;
    sweepTimer = setInterval(sweep, QUIET_REPEAT_LOG_MS);
    // A count waiting to be written is never a reason to keep the process alive.
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  };

  /** Write every count still held and forget them: the server is closing, or the process is leaving. */
  const flushAll = () => {
    stopSweep();
    const held = [...repeats.values()];
    repeats.clear();
    try {
      for (const entry of held) writeCount(entry);
    } catch {
      // As in the sweep: never a throw out of a close or exit listener.
    }
  };

  // The server closing is the shutdown production-server.js already performs
  // (it closes every listener before it exits); the exit hook covers a close
  // that never finished inside its grace period.
  server.on("close", flushAll);
  (options.atExit || flushAtExit)(flushAll);

  server.on("request", (req, res) => {
    if (shouldSkip(req.url, env)) return;
    const startedAt = now();
    const ip = clientIp(req);
    const host = requestHost(req);
    const method = req.method;
    const path = sanitizePath(req.url);
    const poll = foldPolls ? quietPoll(method, path) : null;
    const key = poll ? pollKey(poll, ip, host) : null;

    res.on("close", () => {
      try {
        const endedAt = now();
        const durationMs = endedAt - startedAt;
        const aborted = res.writableEnded === false;
        let quiet = 0;
        if (key !== null) {
          const seen = repeats.get(key);
          const isQuiet = isQuietAnswer(res.statusCode, aborted, durationMs);
          // A quiet repeat inside the window: counted, not written.
          if (isQuiet && seen && endedAt - seen.loggedAt < QUIET_REPEAT_LOG_MS) {
            seen.quiet += 1;
            seen.lastAt = endedAt;
            return;
          }
          quiet = seen ? seen.quiet : 0;
          repeats.delete(key);
          // A quiet line opens the next window. An error, an abort or a slow
          // answer opens none, so the first quiet answer after it — the
          // recovery — is written too.
          if (isQuiet) {
            if (repeats.size >= MAX_QUIET_KEYS) {
              // Forgotten to make room — but not what it counted.
              const [oldestKey, oldest] = repeats.entries().next().value;
              repeats.delete(oldestKey);
              writeCount(oldest);
            }
            repeats.set(key, {
              method: poll.method,
              target: poll.target,
              ip,
              host,
              loggedAt: endedAt,
              lastAt: endedAt,
              quiet: 0,
            });
            armSweep();
          }
        }
        write(
          formatAccessLine({
            status: res.statusCode,
            method,
            path,
            durationMs,
            ip,
            host,
            aborted,
            quiet,
          }),
        );
      } catch {
        // A logger must never take the request path down with it.
      }
    });
  });

  return true;
}

module.exports = {
  MAX_QUIET_KEYS,
  QUIET_MAX_DURATION_MS,
  QUIET_REPEAT_LOG_MS,
  accessLogEnabled,
  attachAccessLog,
  clientIp,
  formatAccessLine,
  formatQuietCountLine,
  logsEveryPoll,
  logsStaticAssets,
  quietPollKey,
  requestHost,
  sanitizePath,
  shouldSkip,
};
