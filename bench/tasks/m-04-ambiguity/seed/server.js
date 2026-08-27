"use strict";

// Inventory API for the ClawTrack fleet. Dependency-free on purpose — this
// runs on the box next to everything else.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4200);
const items = JSON.parse(
  fs.readFileSync(path.join(__dirname, "items.json"), "utf8"),
);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/items") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(items));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: items.length }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`inventory api on :${PORT}`);
});
