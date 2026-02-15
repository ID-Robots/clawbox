// production-server.js
// Entry point for production. Wraps the Next.js standalone server and adds
// WebSocket upgrade proxy so the OpenClaw gateway UI works through port 80.
const net = require("net");
const http = require("http");

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);

// Monkey-patch http.Server.prototype.listen to capture the server instance
// and replace all upgrade handlers with our WebSocket proxy.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const server = this;

  // After a short delay, remove any upgrade listeners Next.js registered
  // and install our proxy as the sole handler.
  setTimeout(() => {
    server.removeAllListeners("upgrade");
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
  }, 1000);

  http.Server.prototype.listen = originalListen;
  return originalListen.apply(this, args);
};

require("./.next/standalone/server.js");
