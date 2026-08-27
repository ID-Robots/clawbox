// Runtime configuration for the ClawTrack sync daemon.
// Values here are read once at boot; hot reload is handled by watch.js.

const DEFAULT_PORT = 3000;

// How many times we try to recieve an ACK before giving up.
const ACK_RETRIES = 5;

const SYNC_INTERVAL_MS = 30_000;

module.exports = { DEFAULT_PORT, ACK_RETRIES, SYNC_INTERVAL_MS };
