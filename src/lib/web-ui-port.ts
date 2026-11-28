import { envPort } from "@/lib/port-probe";

/**
 * The port this install's web UI serves on, and the loopback URL a Cloudflare
 * tunnel has to forward to so its public address reaches that UI.
 *
 * Read from the same place the server takes it. production-server.js hands the
 * Next standalone server `process.env.PORT`, and the UI's systemd unit sets it:
 * `PORT=80` on the Jetson appliance (config/clawbox-setup.service), the
 * installer's `CLAWBOX_PORT` — 3005 unless the owner chose another — on a
 * PC/workstation install (install-x64.sh). `CLAWBOX_PORT` is the installer's
 * name for the same number, consulted only when `PORT` is absent or not a port.
 *
 * Every tunnel used to forward to a hard-coded `http://localhost:80`. That is
 * right on the appliance and nothing listens there on a PC install, so the
 * public URL answered 502 (TASK-2359). scripts/run-tunnel.sh resolves the same
 * order in bash for the systemd unit.
 */
export const APPLIANCE_WEB_UI_PORT = 80;

/** Where PORT and CLAWBOX_PORT are read — `process.env` unless a caller passes its own. */
export type WebUiPortEnv = Readonly<Record<string, string | undefined>>;

/** The port the web UI serves on: PORT, else CLAWBOX_PORT, else 80. */
export function webUiPort(env: WebUiPortEnv = process.env): number {
  return envPort(env.PORT, envPort(env.CLAWBOX_PORT, APPLIANCE_WEB_UI_PORT));
}

/** `http://localhost:<port>` — the origin cloudflared's `--url` must name. */
export function webUiLoopbackUrl(env: WebUiPortEnv = process.env): string {
  return `http://localhost:${webUiPort(env)}`;
}
