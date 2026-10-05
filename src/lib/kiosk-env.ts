import fs from "fs";

/**
 * Whether this box has a kiosk at all — the one fact about the kiosk that the
 * MCP server needs too (the Web app is offered only where it exists). Kept
 * apart from `kiosk-tabs.ts` so that process reads one file and imports
 * nothing but `fs`, as `mcp/tsconfig.json` requires of every src/lib module
 * it includes.
 */

/** Where the launcher reads its URL from (`CLAWBOX_KIOSK_URL`). Root-owned; may be absent. */
export const KIOSK_ENV_FILE = "/etc/clawbox/kiosk.env";

export type EnvLike = Record<string, string | undefined>;

/**
 * Does this box have a kiosk at all? Only the x64 laptop's migration writes
 * `/etc/clawbox/kiosk.env` (its launcher sources it); a Jetson never has one.
 * `CLAWBOX_KIOSK_URL` in the environment counts too (the tests, a hand run).
 *
 * Without one the CDP port is never dialled. OpenClaw's own managed browser
 * profiles take CDP ports from 18800 up, so on a box with no kiosk 18801 can
 * be one of THEM — and a desktop that took that browser for the kiosk would
 * list its tabs and send the owner's sign-in pages to a screen nobody sees.
 */
export function kioskConfigured(env: EnvLike = process.env): boolean {
  return !!env.CLAWBOX_KIOSK_URL || fs.existsSync(/* turbopackIgnore: true */ kioskEnvFile(env));
}

/**
 * `KIOSK_ENV_FILE`, unless `CLAWBOX_KIOSK_ENV_FILE` points elsewhere — the
 * suite points it at nowhere (vitest.config.ts, the CLAWBOX_EDITION_FILE
 * way), or a run on the kiosk laptop itself would see that box's kiosk.
 */
export function kioskEnvFile(env: EnvLike = process.env): string {
  return env.CLAWBOX_KIOSK_ENV_FILE || KIOSK_ENV_FILE;
}
