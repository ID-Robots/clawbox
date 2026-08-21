// Discord on a Hermes device.
//
// Hermes ships Discord as a first-class gateway platform
// (plugins/platforms/discord/plugin.yaml: `requires_env: DISCORD_BOT_TOKEN`),
// wired exactly the way Telegram is — which is why this file is thin:
//
//   * `hermes config set DISCORD_BOT_TOKEN <token>` routes to ~/.hermes/.env.
//     DISCORD_BOT_TOKEN is in the CLI's own env-key allowlist (hermes_cli/
//     config.py `_is_env_config_key`), so it lands in .env like the Telegram
//     token and NOT as a plaintext scalar in config.yaml. A token present there
//     is what enables the platform.
//   * The messaging gateway is shared — one process serves every platform — so
//     Discord reuses `ensureHermesGateway` rather than installing anything of
//     its own.
//
// The other DISCORD_* variables (allowed users, home channel) are deliberately
// not exposed: they are NOT in the CLI's env-key allowlist, so `hermes config
// set` would write them into config.yaml instead, and Hermes' own dashboard
// catalog exposes only the token as the required field.

import { runHermesCli } from "@/lib/hermes-cli";
import { ensureHermesGateway, hermesGatewayStatus } from "@/lib/hermes-telegram";

const PLATFORM = "discord";
export const DISCORD_TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";

// Same ceilings as the Telegram path — these bound a wedged CLI on a loaded
// Jetson, they are not expectations (`config set` is ~1 s, `send --list` ~2 s).
const CONFIG_TIMEOUT_MS = 90_000;
const SEND_TIMEOUT_MS = 90_000;

// One gateway serves every Hermes platform, so Discord installs/restarts the
// same service Telegram does. Re-exported so a route only has to know about the
// platform module it is actually configuring.
export { ensureHermesGateway, hermesGatewayStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Store the bot token where Hermes reads it (~/.hermes/.env) via
 * `hermes config set`, which also clears a stale config.yaml mirror that would
 * otherwise outrank it.
 *
 * The token is passed as a single argv element (runHermesCli never uses a
 * shell) and the caller has already rejected anything outside the safe charset,
 * so it cannot be read as a flag.
 */
export async function setHermesDiscordToken(
  botToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await runHermesCli(["config", "set", DISCORD_TOKEN_ENV_VAR, botToken], {
    timeoutMs: CONFIG_TIMEOUT_MS,
    signal,
  });
  if (res.code !== 0) {
    // Never echo the CLI's stderr — it can quote the value it was handed.
    throw new Error("Hermes rejected the bot token");
  }
}

/**
 * Whether Hermes itself considers Discord a configured platform.
 *
 * Tri-state, for the same reason as the Telegram probe: `false` means Hermes
 * answered and reported no Discord, `null` means we could not ask it (CLI
 * missing, timed out, unparseable output). Collapsing the two would flash "not
 * configured" at someone whose bot is working fine.
 */
export async function hermesDiscordRegistered(signal?: AbortSignal): Promise<boolean | null> {
  let res;
  try {
    res = await runHermesCli(["send", "--list", PLATFORM, "--json"], {
      timeoutMs: SEND_TIMEOUT_MS,
      signal,
    });
  } catch {
    return null;
  }
  // Exit 1 with the "no targets found for platform" notice is a real "no".
  if (res.code !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!isRecord(parsed) || !isRecord(parsed.platforms)) return null;
    return PLATFORM in parsed.platforms;
  } catch {
    return null;
  }
}
