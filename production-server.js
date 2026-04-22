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

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const TERMINAL_WS_PORT = parseInt(process.env.TERMINAL_WS_PORT || "3006", 10);
const IS_DEV = process.env.NODE_ENV === "development";

// Path prefixes that the production server routes to a non-gateway upstream.
// Keep entries in sync with any new WebSocket-only services added behind :80.
const UPGRADE_ROUTES = [
  { prefix: "/terminal-ws", targetPort: TERMINAL_WS_PORT, stripPrefix: true },
];

function resolveUpgradeTarget(reqUrl) {
  const path = reqUrl.split("?")[0];
  for (const r of UPGRADE_ROUTES) {
    if (path === r.prefix || path.startsWith(r.prefix + "/")) {
      const rewritten = r.stripPrefix
        ? (reqUrl.slice(r.prefix.length) || "/")
        : reqUrl;
      return { targetPort: r.targetPort, url: rewritten };
    }
  }
  return { targetPort: GATEWAY_PORT, url: reqUrl };
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

// HTTP upgrade proxy — raw TCP pipe (works fine with bun's http.Server).
// Routes by path: UPGRADE_ROUTES entries (e.g. /terminal-ws) go to their
// configured port; everything else goes to the OpenClaw gateway.
function attachUpgradeProxy(server) {
  server.on("upgrade", (req, socket, head) => {
    const { targetPort, url } = resolveUpgradeTarget(req.url);
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const localhost = `127.0.0.1:${targetPort}`;
      let raw = `${req.method} ${url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lc = name.toLowerCase();
        const value =
          lc === "origin" ? `http://${localhost}` :
          lc === "host" ? localhost :
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
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const { targetPort, url } = resolveUpgradeTarget(req.url || "/");
        const upstreamUrl = `ws://127.0.0.1:${targetPort}${url}`;
        const upstream = new WebSocket(upstreamUrl, {
          headers: {
            origin: `http://127.0.0.1:${targetPort}`,
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

require("./.next/standalone/server.js");
