// Watches config.js and signals the daemon to reload. Do not edit as part of
// configuration changes; this file ships with the daemon.
const fs = require("fs");
const { SYNC_INTERVAL_MS } = require("./config");

fs.watchFile("./config.js", { interval: SYNC_INTERVAL_MS }, () => {
  process.kill(process.pid, "SIGHUP");
});
