// production-server.js
// Entry point for production (run via bun). Wraps the Next.js standalone server
// and adds WebSocket upgrade proxy so the OpenClaw gateway UI works through port 80.
// Also serves HTTPS on port 443 with self-signed certs when available.
// Uses a ws-based WSS proxy on the HTTPS server since bun's TLS upgrade piping is broken.
/* eslint-disable @typescript-eslint/no-require-imports */
const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { attachAccessLog } = require("./scripts/access-log.js");

// Same rule as envPort() in src/lib/port-probe.ts, written out because this
// entry point is standalone CommonJS and cannot import the TypeScript helper:
// an integer in 1-65535, or the default. `parseInt` alone yields NaN on a typo
// and lets `-1` / `70000` through, and every one of those makes `net.connect`
// throw ERR_SOCKET_BAD_PORT on the first proxied request rather than falling
// back to the default the `||` promises.
function envPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);
const TERMINAL_WS_PORT = envPort(process.env.TERMINAL_WS_PORT, 3006);
const NOVNC_WS_PORT = envPort(process.env.NOVNC_WS_PORT, 6080);
const IS_DEV = process.env.NODE_ENV === "development";

// Path prefixes that the production server routes to a non-gateway upstream.
// Keep entries in sync with any new WebSocket-only services added behind :80.
//
//   /terminal-ws  → xterm/PTY WebSocket (scripts/terminal-server.mjs)
//   /novnc-ws     → noVNC / websockify for the remote desktop app
// `requireAuth` gates the raw single-service sockets (terminal PTY, noVNC) on a
// valid ClawBox session cookie. WebSocket upgrades never pass through Next.js
// middleware, so without this check any LAN client could reach the unauth PTY /
// VNC services straight through the port-80 proxy (SEC-1). The gateway route
// (default) is intentionally NOT gated here — it enforces its own auth token.
const UPGRADE_ROUTES = [
  { prefix: "/terminal-ws", targetPort: TERMINAL_WS_PORT, stripPrefix: true, requireAuth: true },
  { prefix: "/novnc-ws", targetPort: NOVNC_WS_PORT, stripPrefix: true, requireAuth: true },
];

function resolveUpgradeTarget(reqUrl) {
  const path = reqUrl.split("?")[0];
  for (const r of UPGRADE_ROUTES) {
    if (path === r.prefix || path.startsWith(r.prefix + "/")) {
      const stripped = reqUrl.slice(r.prefix.length);
      const rewritten = r.stripPrefix
        ? (!stripped || stripped.startsWith("?") ? `/${stripped}` : stripped)
        : reqUrl;
      return { targetPort: r.targetPort, url: rewritten, requireAuth: !!r.requireAuth };
    }
  }
  return { targetPort: GATEWAY_PORT, url: reqUrl, requireAuth: false };
}

// Current session generation, read from data/config.json (mtime-cached), so WS
// upgrades honor the same password-change revocation the Next.js middleware
// enforces (src/middleware.ts). Without this, a cookie revoked by a password
// change would still be accepted at the /terminal-ws (root shell) and /novnc-ws
// gates until natural expiry. Defaults to 0 on any read error / missing field.
const CONFIG_JSON_PATH = path.join(process.env.CLAWBOX_ROOT || __dirname, "data", "config.json");
let sessionGenCache = null;
function readSessionGeneration() {
  try {
    const stat = fs.statSync(CONFIG_JSON_PATH);
    if (sessionGenCache && sessionGenCache.mtimeMs === stat.mtimeMs) return sessionGenCache.value;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, "utf-8"));
    const value = typeof parsed.session_generation === "number" && Number.isFinite(parsed.session_generation)
      ? parsed.session_generation
      : 0;
    sessionGenCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    sessionGenCache = { mtimeMs: -1, value: 0 };
    return 0;
  }
}

// Verify the HMAC-SHA256 `clawbox_session` cookie — the same scheme
// src/middleware.ts uses (payload.sig; sig = HMAC-SHA256(payload, SESSION_SECRET);
// base64url payload carries { exp, gen }). Mirrored here in CJS because upgrades
// bypass Next.js. Fails closed when the secret is absent.
function hasValidSession(req) {
  // Fails closed on ANY error. This runs inside the 'upgrade' listener, so an
  // uncaught throw here (e.g. `decodeURIComponent` on a malformed `%` cookie)
  // would crash the whole server — hence the single all-encompassing try.
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return false;
    const m = /(?:^|;\s*)clawbox_session=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return false;
    const cookie = decodeURIComponent(m[1]);
    const dot = cookie.indexOf(".");
    if (dot < 0) return false;
    const payload = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    if (!payload || !sig) return false;
    const expected = require("crypto").createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    if (!require("crypto").timingSafeEqual(sigBuf, expBuf)) return false;
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const data = JSON.parse(decoded);
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return false;
    // Reject cookies from before the last password change (session revocation).
    if ((typeof data.gen === "number" ? data.gen : 0) !== readSessionGeneration()) return false;
    return true;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket) {
  try {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  } catch {
    // socket already gone
  }
  socket.destroy();
}

// ─── Session secret ───
// Generate or load a persistent secret for signing session cookies.
// Must be set before Next.js server starts so middleware can access it.
const SESSION_SECRET_PATH = path.join(__dirname, "data", ".session-secret");
try {
  let sessionSecret;
  try {
    sessionSecret = fs.readFileSync(SESSION_SECRET_PATH, "utf-8").trim();
  } catch {}
  if (!sessionSecret || sessionSecret.length < 32) {
    sessionSecret = require("crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(SESSION_SECRET_PATH), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_PATH, sessionSecret, { mode: 0o600 });
  }
  process.env.SESSION_SECRET = sessionSecret;
} catch (err) {
  console.warn("[production-server] Failed to set up session secret:", err.message);
}

// ─── MCP bearer token ───
// Per-install token the ClawBox MCP server (mcp/clawbox-mcp.ts) uses to
// authenticate back to /setup-api/* — see src/lib/mcp-token.ts. The MCP
// runs as a stdio subprocess of openclaw and has no session cookie, so
// without this every tool call from a Codex / Claude agent gets 307'd
// to /login (POSTs surface as 405, GETs receive the login HTML page).
// Seeded here so middleware.ts can resolve the same value via env on
// the very first request, before src/lib/mcp-token.ts would lazily mint
// one. gateway-pre-start.sh reads the same file to inject the value
// into the MCP server's env when registering it with openclaw.
const MCP_TOKEN_PATH = path.join(__dirname, "data", ".mcp-token");
try {
  let mcpToken;
  try {
    mcpToken = fs.readFileSync(MCP_TOKEN_PATH, "utf-8").trim();
  } catch {}
  if (!mcpToken || mcpToken.length < 32) {
    mcpToken = require("crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(MCP_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(MCP_TOKEN_PATH, mcpToken, { mode: 0o600 });
  }
  // Publish the value FIRST. The re-harden below is a separate concern and it
  // can fail on its own (a root-owned token, a read-only data/); with it inside
  // this try and above this line, an EPERM threw past the assignment and
  // CLAWBOX_MCP_TOKEN was never set — so a permissions hiccup discarded a token
  // that had just been read successfully, and middleware.ts lost the very
  // first-request resolution this block exists to provide. On the Hermes SKU
  // clawbox-gateway.service is masked, so gateway-pre-start.sh's replacement
  // never runs and nothing else repairs it. TASK-657.
  process.env.CLAWBOX_MCP_TOKEN = mcpToken;
  // Re-harden mode on every boot. fs.writeFileSync only applies mode
  // when creating; an existing file from an older install (or one
  // that drifted to broader perms via manual edit) would otherwise
  // stay readable to other local users. The bearer is the sole
  // /setup-api/* credential, so don't trust a reused file's perms.
  // In its own try, because it is the one step here that may fail
  // without costing anything already achieved. The message states the
  // STATE and never a cause: chmod fails with EPERM (another uid owns
  // it), EROFS or EACCES (data/ read-only, or a path component), and
  // no code here can tell which — the same correction the shell copy
  // in scripts/gateway-pre-start.sh got.
  try {
    fs.chmodSync(MCP_TOKEN_PATH, 0o600);
  } catch (err) {
    console.warn(
      `[production-server] Could not re-harden ${MCP_TOKEN_PATH} (${err.code || err.message}); `
        + "if other local users can read it, the MCP bearer for /setup-api/* is exposed on this box.",
    );
  }
} catch (err) {
  console.warn("[production-server] Failed to set up MCP token:", err.message);
}

// ─── Register the MCP server with the agent harness ───
// Having the token is not the same as the agent HAVING the tools: the harness
// only spawns the MCP server if its own config lists it.
//
// On OpenClaw that registration is written by scripts/gateway-pre-start.sh, an
// ExecStartPre of clawbox-gateway.service. On the Hermes SKU that unit is
// masked, so nothing wrote it and `hermes mcp list` answered "No MCP servers
// configured" — the agent had no device tools at all. scripts/register-mcp.sh
// is the Hermes counterpart, and this is where it runs: clawbox-setup.service
// is the one unit active on every edition, and both a deploy and an in-app
// update finish by restarting it.
//
// Fire-and-forget on purpose, and that matters more since TASK-697: the
// reconcile is idempotent, but it is no longer ~200ms. It now also runs
// `hermes plugins doctor`, which imports the plugin in a sandboxed temporary
// HERMES_HOME — seconds on an Orin — on every web-server boot, with no stamp
// and no backoff. The OpenClaw twin (scripts/gateway-pre-start.sh) was given
// both because it runs in an ExecStartPre that the gateway waits on; this one
// blocks nothing, so it pays the cost every time and reports every time.
// It must never delay or block the web server coming up — a device whose UI
// does not start is worse than one whose agent has to wait for the next boot.
try {
  const registerMcp = require("child_process").spawn(
    "/bin/bash",
    [path.join(__dirname, "scripts", "register-mcp.sh")],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const note = (buf) => {
    const line = buf.toString().trim();
    if (line) console.log(`[production-server] ${line}`);
  };
  registerMcp.stdout.on("data", note);
  registerMcp.stderr.on("data", note);
  registerMcp.on("error", (err) => {
    console.warn("[production-server] MCP registration could not run:", err.message);
  });
} catch (err) {
  console.warn("[production-server] MCP registration could not run:", err.message);
}

// ─── Local-AI bearer token ───
// Per-install token openclaw uses to call our /setup-api/local-ai/* proxy.
// Mirrors the session secret bootstrap so middleware + the proxy route can
// rely on `process.env.LOCAL_AI_TOKEN` being set before any request lands.
// See src/lib/local-ai-token.ts for the verification path.
const LOCAL_AI_TOKEN_PATH = path.join(__dirname, "data", ".local-ai-token");
try {
  let localAiToken;
  try {
    localAiToken = fs.readFileSync(LOCAL_AI_TOKEN_PATH, "utf-8").trim();
  } catch {}
  if (!localAiToken || localAiToken.length < 32) {
    localAiToken = require("crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(LOCAL_AI_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_AI_TOKEN_PATH, localAiToken, { mode: 0o600 });
  }
  process.env.LOCAL_AI_TOKEN = localAiToken;
} catch (err) {
  console.warn("[production-server] Failed to set up local-ai token:", err.message);
}

// ─── Internal-unit token ───
// Per-install credential ClawBox's own systemd units present when they call
// back into this server. clawbox-heartbeat.timer is the first user: its tick
// endpoint is pre-auth (nobody may be logged in) and restarts clawbox-tunnel
// when the advertised hostname has died, so leaving it anonymous handed anyone
// on the LAN — or anyone holding the box's public tunnel URL — a systemd
// restart four times an hour. See src/lib/internal-token.ts.
//
// Written as KEY=value rather than a bare token so systemd can read it with
// `EnvironmentFile=`: PID 1 parses that as root before the unit's ProtectHome
// sandbox applies, which is how a sandboxed unit can present a secret that
// lives under /home.
const INTERNAL_TOKEN_PATH = path.join(__dirname, "data", "internal-token.env");
try {
  let internalToken;
  try {
    const raw = fs.readFileSync(INTERNAL_TOKEN_PATH, "utf-8");
    const match = /^\s*(?:export\s+)?CLAWBOX_INTERNAL_TOKEN=(.*)$/m.exec(raw);
    if (match) internalToken = match[1].trim().replace(/^"(.*)"$/, "$1");
  } catch {}
  if (!internalToken || internalToken.length < 32) {
    internalToken = require("crypto").randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(INTERNAL_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(INTERNAL_TOKEN_PATH, `CLAWBOX_INTERNAL_TOKEN=${internalToken}\n`, { mode: 0o600 });
  }
  // Re-harden on every boot: writeFileSync only applies `mode` when creating.
  fs.chmodSync(INTERNAL_TOKEN_PATH, 0o600);
  process.env.CLAWBOX_INTERNAL_TOKEN = internalToken;
} catch (err) {
  console.warn("[production-server] Failed to set up internal token:", err.message);
}

// ─── Honest shutdown ───
// systemd stops this unit with SIGTERM. With no handler the process died on the
// default disposition and systemd recorded
//   `Main process exited, code=exited, status=143/n/a` + `Failed with result 'exit-code'`
// for EVERY clean stop or restart — so `systemctl status clawbox-setup` showed
// red for the rest of the session and the Remote Access panel rendered a
// "failed" alert after a perfectly normal restart. A support engineer cannot
// tell that state apart from a real crash.
//
// Belt and braces with `SuccessExitStatus=143 SIGTERM` in the unit file: this
// makes the exit genuinely 0, the unit line covers the window before this
// handler is installed and any child that still exits 143.
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || "5000", 10);
const managedServers = new Set();
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[production-server] ${signal} received — closing listeners`);

  // Backstop: a socket that refuses to drain must not turn a clean stop into a
  // SIGKILL (which systemd DOES report as a failure, and rightly).
  const force = setTimeout(() => {
    console.log("[production-server] shutdown grace elapsed — exiting");
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);

  let pending = managedServers.size;
  if (pending === 0) {
    clearTimeout(force);
    process.exit(0);
    return;
  }
  const done = () => {
    if (--pending === 0) {
      clearTimeout(force);
      process.exit(0);
    }
  };
  for (const server of managedServers) {
    try {
      server.close(done);
    } catch {
      done();
    }
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// HTTP upgrade proxy — raw TCP pipe (works fine with bun's http.Server).
// Routes by path: UPGRADE_ROUTES entries (e.g. /terminal-ws) go to their
// configured port; everything else goes to the OpenClaw gateway.
//
// We rewrite Origin to `http://127.0.0.1` (no port) so the gateway's
// controlUi.allowedOrigins check passes — the allowlist uses port-less
// entries and a port-suffixed origin would be rejected. Host is rewritten
// to 127.0.0.1:<port> since upstream does need the port for Host routing.
// Forwarded-client headers are DROPPED, not piped through: a request that
// arrives via the Cloudflare tunnel carries the CF forwarded-client set
// (X-Forwarded-For, CF-Connecting-IP, ...), and OpenClaw 2 refuses an
// upgrade that presents proxy attribution from a proxy it has not been
// told to trust - 403 "Proxy client attribution is required. Configure
// gateway.trustedProxies narrowly and make the proxy overwrite or safely
// rebuild forwarded client headers." (reproduced over a live quick tunnel
// on 2026.8.1; this strip is that overwrite). Every proxied upgrade then
// looks like the clean loopback client it is - exactly what LAN requests
// already look like - which also keeps the gateway loopback device-pairing
// auto-approval working for tunnel browsers.
// The x-forwarded-* FAMILY is matched by prefix at the call site — OpenClaw 2
// treats any of them (x-forwarded-user included) as forwarded-client
// evidence; this set carries the attribution headers that do not share the
// prefix.
const FORWARDED_CLIENT_HEADERS = new Set([
  "x-real-ip", "forwarded", "true-client-ip", "cdn-loop",
  "cf-connecting-ip", "cf-connecting-ipv6", "cf-ipcountry", "cf-visitor", "cf-ray", "cf-warp-tag-id",
]);
function attachUpgradeProxy(server) {
  server.on("upgrade", (req, socket, head) => {
    const { targetPort, url, requireAuth } = resolveUpgradeTarget(req.url);
    if (requireAuth && !hasValidSession(req)) {
      return rejectUpgrade(socket);
    }
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const hostHeader = `127.0.0.1:${targetPort}`;
      const originHeader = "http://127.0.0.1";
      let raw = `${req.method} ${url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lc = name.toLowerCase();
        if (lc.startsWith("x-forwarded-") || FORWARDED_CLIENT_HEADERS.has(lc)) continue;
        const value =
          lc === "origin" ? originHeader :
          lc === "host" ? hostHeader :
          req.rawHeaders[i + 1];
        raw += `${name}: ${value}\r\n`;
      }
      raw += "\r\n";
      upstream.write(raw);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
}

// ─── HTTPS + WSS server ───
const CERT_DIR = path.join(__dirname, "data", "certs");
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "443", 10);

function startHttpsServer(httpServer) {
  const certPath = path.join(CERT_DIR, "cert.pem");
  const keyPath = path.join(CERT_DIR, "key.pem");

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.log("[production-server] No SSL certs found at", CERT_DIR, "— HTTPS disabled.");
    return;
  }

  try {
    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    // HTTPS server for regular requests — proxy to the HTTP server's handler
    const httpsServer = https.createServer(tlsOptions, (req, res) => {
      httpServer.emit("request", req, res);
    });

    // WSS proxy using the ws library — handles WebSocket upgrades on HTTPS
    const wss = new WebSocket.Server({ noServer: true });

    httpsServer.on("upgrade", (req, socket, head) => {
      const gate = resolveUpgradeTarget(req.url || "/");
      if (gate.requireAuth && !hasValidSession(req)) {
        return rejectUpgrade(socket);
      }
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const { targetPort, url } = gate;
        const upstreamUrl = `ws://127.0.0.1:${targetPort}${url}`;
        const upstream = new WebSocket(upstreamUrl, {
          headers: {
            // Port-less to satisfy the gateway's strict origin allowlist.
            origin: "http://127.0.0.1",
            host: `127.0.0.1:${targetPort}`,
          },
        });

        // Close clientWs if upstream fails before "open" — without these the
        // client would hang forever waiting for a relay that will never start.
        upstream.on("error", (err) => {
          console.warn("[wss-proxy] upstream error:", err.message);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });
        upstream.on("close", () => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });

        upstream.on("open", () => {
          // Relay messages bidirectionally
          clientWs.on("message", (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data, { binary: isBinary });
            }
          });

          upstream.on("message", (data, isBinary) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data, { binary: isBinary });
            }
          });
        });

        clientWs.on("close", () => upstream.close());
        clientWs.on("error", () => upstream.close());
      });
    });

    managedServers.add(httpsServer);
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`[production-server] HTTPS server listening on port ${HTTPS_PORT}`);
    });

    httpsServer.on("error", (err) => {
      if (err.code === "EACCES") {
        console.warn(`[production-server] Cannot bind HTTPS to port ${HTTPS_PORT} (permission denied). HTTPS disabled.`);
      } else {
        console.warn("[production-server] HTTPS server error:", err.message);
      }
    });
  } catch (err) {
    console.warn("[production-server] Failed to start HTTPS:", err.message);
  }
}

// Monkey-patch http.Server.prototype.listen to capture the server instance
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  managedServers.add(this);
  // Attached here, on the ONE server Next actually creates, before it starts
  // accepting. HTTPS requests are re-emitted onto this same server (see
  // startHttpsServer), so this single call covers :80 and :443 both.
  if (attachAccessLog(this)) {
    console.log("[production-server] HTTP access log enabled");
  }
  if (IS_DEV) {
    attachUpgradeProxy(this);
  } else {
    const MAX_WAIT = 10000;
    const POLL_INTERVAL = 50;
    let elapsed = 0;

    const poll = setInterval(() => {
      elapsed += POLL_INTERVAL;
      if (this.listenerCount("upgrade") > 0 || elapsed >= MAX_WAIT) {
        clearInterval(poll);
        this.removeAllListeners("upgrade");
        attachUpgradeProxy(this);
        if (elapsed >= MAX_WAIT) {
          console.warn("[production-server] Timed out waiting for Next.js upgrade listeners; proxy attached anyway.");
        }
        // Start HTTPS server after HTTP is ready
        startHttpsServer(this);
      }
    }, POLL_INTERVAL);
  }

  http.Server.prototype.listen = originalListen;
  return originalListen.apply(this, args);
};

// A build parked by an update that was killed OUTRIGHT is the box's only build,
// and until here nothing ever looked for it.
//
// install.sh's do_rebuild renames the serving build to `.next-old` before it
// builds and renames it back when the build fails — but only if that shell
// survives to do it. An OOM kill that picks the shell (TASK-709: three in one
// night, `next-build` at 2.1 GB against ollama's 2.3 GB), a power cut or a
// Ctrl-C leaves no `.next` at all and a perfectly good build under a gitignored
// directory. install.sh's own `promote_parked_build` cannot help: it runs
// inside an update, and an update needs THIS server to be up. So the box
// crash-looped on the missing entry with its build sitting on disk, and every
// recovery was by hand.
//
// Deliberately the last thing before the require, and deliberately narrow: it
// does nothing at all unless the entry is already missing — i.e. unless this
// process is about to throw anyway. Everything is best-effort; a failure here
// must never be the reason the server does not start, and the throw below stays
// the real error. clawbox-setup runs as the `clawbox` user, which owns both
// directories (the rename in do_rebuild preserves the inode), and its
// `Restart=always` means a lost race just tries again in three seconds.
try {
  const buildEntry = path.join(__dirname, ".next", "standalone", "server.js");
  const parkedEntry = path.join(__dirname, ".next-old", "standalone", "server.js");
  // `lstatSync`, not `existsSync`: for the nested standalone layout `postbuild`
  // supports, this path is a symlink into `.next` that DANGLES while the tree is
  // parked, and `existsSync` would call the box's only build absent.
  const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  if (!present(buildEntry) && present(parkedEntry)) {
    console.warn("[production-server] No .next build, but .next-old holds one — an update was killed mid-rebuild. Putting it back.");
    fs.rmSync(path.join(__dirname, ".next"), { recursive: true, force: true });
    fs.renameSync(path.join(__dirname, ".next-old"), path.join(__dirname, ".next"));
    console.warn("[production-server] Restored the parked build. Run the update again to get the new one.");
  }
} catch (err) {
  console.warn("[production-server] Could not reclaim a parked build:", err.message);
}

require("./.next/standalone/server.js");

// After Next has started: the title Next gave this process is ours again
// (scripts/process-title.js says why — a run's `pkill -f next-server` took
// the box down on 2026-09-05).
require("./scripts/process-title.js").guardProcessTitle();
