// production-server.js
// Entry point for production. Wraps the Next.js standalone server and adds
// WebSocket upgrade proxy so the OpenClaw gateway UI works through port 80.
/* eslint-disable @typescript-eslint/no-require-imports */
const net = require("net");
const http = require("http");

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const IS_DEV = process.env.NODE_ENV === "development";

function attachUpgradeProxy(server) {
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(GATEWAY_PORT, "127.0.0.1", () => {
      // Rewrite Origin/Host to localhost so the gateway accepts the connection.
      const localhost = `127.0.0.1:${GATEWAY_PORT}`;
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
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

// Monkey-patch http.Server.prototype.listen to capture the server instance
// and replace upgrade handlers with our WebSocket proxy.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  if (IS_DEV) {
    // In development, preserve Next.js HMR WebSocket listeners
    // and add our proxy alongside them.
    attachUpgradeProxy(this);
  } else {
    // In production, wait for Next.js to register its upgrade listeners,
    // then replace them with our proxy.
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
      }
    }, POLL_INTERVAL);
  }

  http.Server.prototype.listen = originalListen;
  return originalListen.apply(this, args);
};

require("./.next/standalone/server.js");
