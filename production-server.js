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
const CODE_SERVER_PORT = parseInt(process.env.CODE_SERVER_PORT || "8080", 10);
const IS_DEV = process.env.NODE_ENV === "development";

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

// HTTP upgrade proxy — raw TCP pipe (works fine with bun's http.Server)
function attachUpgradeProxy(server) {
  server.on("upgrade", (req, socket, head) => {
    // Route code-server WebSocket to code-server port
    const isCodeServer = req.url && req.url.startsWith("/code-server/");
    const targetPort = isCodeServer ? CODE_SERVER_PORT : GATEWAY_PORT;
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const localhost = `127.0.0.1:${targetPort}`;
      // Strip /code-server prefix for code-server requests
      const url = isCodeServer ? req.url.replace("/code-server", "") || "/" : req.url;
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
        // Connect to the gateway as a plain WS client
        const gatewayUrl = `ws://127.0.0.1:${GATEWAY_PORT}${req.url || "/"}`;
        const upstream = new WebSocket(gatewayUrl, {
          headers: {
            origin: `http://127.0.0.1:${GATEWAY_PORT}`,
            host: `127.0.0.1:${GATEWAY_PORT}`,
          },
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
        upstream.on("close", () => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });

        clientWs.on("error", () => upstream.close());
        upstream.on("error", () => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });
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
  const server = this;

  if (IS_DEV) {
    attachUpgradeProxy(server);
  } else {
    const MAX_WAIT = 10000;
    const POLL_INTERVAL = 50;
    let elapsed = 0;

    const poll = setInterval(() => {
      elapsed += POLL_INTERVAL;
      if (server.listenerCount("upgrade") > 0 || elapsed >= MAX_WAIT) {
        clearInterval(poll);
        server.removeAllListeners("upgrade");
        attachUpgradeProxy(server);
        if (elapsed >= MAX_WAIT) {
          console.warn("[production-server] Timed out waiting for Next.js upgrade listeners; proxy attached anyway.");
        }
        // Start HTTPS server after HTTP is ready
        startHttpsServer(server);
      }
    }, POLL_INTERVAL);
  }

  http.Server.prototype.listen = originalListen;
  return originalListen.apply(server, args);
};

require("./.next/standalone/server.js");
