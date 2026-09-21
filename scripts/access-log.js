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

/** Query parameter names whose VALUE must never reach a log line. */
const SENSITIVE_QUERY_KEY = /(token|secret|password|passwd|pwd|key|auth|code|sig)/i;

/** Hard ceiling on the logged request target. Bounds a log-flood line. */
const MAX_PATH_CHARS = 512;
const MAX_HOST_CHARS = 128;

/** Request targets skipped by default — build assets, high volume, zero signal. */
const STATIC_PREFIXES = ["/_next/static/", "/_next/image"];

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
  // ::ffff:192.168.1.5 is how a v4 client shows up on a dual-stack listener.
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
 *   [access] 200 GET /setup-api/system/stats 9ms ip=192.168.50.10 host=clawbox.local
 *   [access] 404 GET /probe 1ms ip=203.0.113.7 host=abc.trycloudflare.com aborted
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
  return parts.join(" ");
}

function shouldSkip(rawUrl, env) {
  if (logsStaticAssets(env)) return false;
  const target = typeof rawUrl === "string" ? rawUrl : "";
  return STATIC_PREFIXES.some((p) => target.startsWith(p));
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
 * Returns true when logging was attached, false when it is disabled.
 */
function attachAccessLog(server, options = {}) {
  const env = options.env || process.env;
  if (!accessLogEnabled(env)) return false;
  const write = options.write || ((line) => console.log(line));
  const now = options.now || (() => Number(process.hrtime.bigint() / 1000000n));

  server.on("request", (req, res) => {
    if (shouldSkip(req.url, env)) return;
    const startedAt = now();
    const ip = clientIp(req);
    const host = requestHost(req);
    const method = req.method;
    const path = sanitizePath(req.url);

    res.on("close", () => {
      try {
        write(
          formatAccessLine({
            status: res.statusCode,
            method,
            path,
            durationMs: now() - startedAt,
            ip,
            host,
            aborted: res.writableEnded === false,
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
  accessLogEnabled,
  attachAccessLog,
  clientIp,
  formatAccessLine,
  logsStaticAssets,
  requestHost,
  sanitizePath,
  shouldSkip,
};
