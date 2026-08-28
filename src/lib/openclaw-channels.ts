// OpenClaw messaging channels: their plugins, and what the gateway says about
// them.
//
// WHY A CHANNEL NEEDS A PLUGIN AT ALL
//
// OpenClaw's stock extensions ship exactly two messaging channels — imessage
// and telegram. Discord, WhatsApp, Slack, Teams and the rest are OFFICIAL but
// SEPARATE npm packages (`@openclaw/discord`, `@openclaw/whatsapp`, …) whose
// `peerDependencies` pin them to the host they were built for. A device that
// has never installed one accepts `channels.discord` in its config, starts, and
// logs
//
//     channels.discord is configured but no channel plugin is installed or
//     loadable (no-channel-owner)
//
// while ClawBox's panel reports a successful save. That was the bug.
//
// WHY AT CONFIGURE TIME AND NOT IN install.sh
//
// Three reasons, and the owner's decision:
//   * a flashed image must not carry channel plugins nobody enabled;
//   * plugin versions have to track the INSTALLED openclaw (peerDependencies),
//     so baking them at flash time guarantees drift after the first update;
//   * configure time is where the honest failure path already lives — the
//     request that asks for the channel is the one that can tell the owner it
//     could not have it.
//
// Installing is first-class in the CLI and needs no custom code:
// `openclaw plugins install <npm spec>` accepts an npm package spec, links the
// `openclaw` peer dependency, writes `plugins.entries.<id>.enabled` and prints
// "Restart the gateway to load plugins."

import {
  type SpawnOpenclawOptions,
  openclawIsAbsent,
  readConfig,
  spawnOpenclawCli,
} from "@/lib/openclaw-config";

/**
 * The official channel plugins ClawBox knows how to install.
 *
 * Deliberately a short, explicit list rather than a scrape of OpenClaw's
 * `dist/channel-catalog.json`: this map is what the Settings panel can offer,
 * and a channel ClawBox has no UI for has no business being installed by it.
 * `unsupported_channel` for anything else is the honest answer.
 *
 * The specs are unpinned on purpose. npm resolves `latest`, which is published
 * in lockstep with the host, and OpenClaw's installer then checks the plugin's
 * own `compat.pluginApi` against the running host and refuses a mismatch — a
 * refusal this module reports rather than swallows. A version pinned here would
 * go stale the first time the device updates openclaw.
 */
export const OFFICIAL_CHANNEL_PLUGINS: Readonly<Record<string, string>> = Object.freeze({
  discord: "@openclaw/discord",
  whatsapp: "@openclaw/whatsapp",
});

/**
 * Install ceiling. This is an npm install of a ~15-25 MB package over whatever
 * connection the device has, on a Jetson. Generous, but bounded: a request that
 * blocks forever is the failure mode this whole change exists to remove, and
 * `install_timeout` is reported to the caller rather than dressed up as
 * success.
 */
export const PLUGIN_INSTALL_TIMEOUT_MS = 180_000;

/** Ceiling for `plugins list` / `plugins enable` — CLI cold start is ~10-12 s. */
const PLUGIN_QUERY_TIMEOUT_MS = 45_000;

/**
 * Ceiling for one `channels status` call.
 *
 * Two budgets stack: OpenClaw's CLI cold start (~10-12 s on a Jetson) and the
 * gateway round trip the command makes, which the CLI's own `--timeout` bounds.
 */
const CHANNEL_STATUS_TIMEOUT_MS = 30_000;
/** What we pass to the CLI's `--timeout` for the gateway round trip itself. */
const CHANNEL_STATUS_GATEWAY_TIMEOUT_MS = 8_000;

export type ChannelPluginFailure = "unsupported_channel" | "install_failed" | "install_timeout";

export type ChannelPluginResult =
  | { ok: true; /** True when this call is what installed it. */ installed: boolean }
  | { ok: false; reason: ChannelPluginFailure };

/** One entry of `openclaw plugins list --json`, narrowed to what we read. */
interface PluginRow {
  id?: unknown;
  enabled?: unknown;
  status?: unknown;
  channelIds?: unknown;
}

function asRows(parsed: unknown): PluginRow[] {
  if (Array.isArray(parsed)) return parsed as PluginRow[];
  if (parsed && typeof parsed === "object") {
    const plugins = (parsed as { plugins?: unknown }).plugins;
    if (Array.isArray(plugins)) return plugins as PluginRow[];
  }
  return [];
}

/** The installed plugin that OWNS `channelId`, if any. */
function findChannelOwner(rows: PluginRow[], channelId: string): PluginRow | null {
  for (const row of rows) {
    // `channelIds` is authoritative — the registry keys plugins by their own id
    // (which may or may not equal the channel's), and the channel they provide
    // is listed separately. Matching on the plugin id alone would reinstall a
    // present plugin on every save.
    const ids = Array.isArray(row.channelIds) ? row.channelIds : [];
    if (ids.includes(channelId)) return row;
    if (row.id === channelId) return row;
  }
  return null;
}

/**
 * Is the plugin switched on in the config THE GATEWAY READS?
 *
 * Not the same question as `plugins list --json`'s `enabled` field, and the
 * difference is a live bug this caught. On a box where the package was already
 * installed but `plugins.entries.discord` had gone missing, the CLI reported
 *
 *     {"id":"discord","enabled":true,"status":"loaded","origin":"global"}
 *
 * — that is the plugin's DISCOVERY state, the default for a globally installed
 * package — while the gateway brought up no Discord channel at all. Running
 * `plugins enable discord` wrote `plugins.entries.discord = {enabled:true}`,
 * and after a restart the bot connected. So the config entry is what decides,
 * and it is what we check.
 *
 * This only ever bit the SECOND save: the first one installs the plugin, and
 * `plugins install` writes the entry itself.
 */
async function pluginEnabledInConfig(pluginId: string): Promise<boolean> {
  try {
    const config = await readConfig();
    const entries = (config.plugins as { entries?: Record<string, { enabled?: unknown }> } | undefined)
      ?.entries;
    return entries?.[pluginId]?.enabled === true;
  } catch {
    // readConfig already swallows its own errors; this is belt-and-braces.
    // Unknown reads as "not enabled", so we run the idempotent enable rather
    // than skip it.
    return false;
  }
}

/** A timeout from spawnOpenclawCli names itself; nothing else does. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out after \d+ms/.test(err.message);
}

/**
 * OpenClaw refusing to install a plugin it already has.
 *
 * `plugins list` reads a PERSISTED registry snapshot, so a plugin that is in
 * OpenClaw's own store but missing from that snapshot is invisible to the
 * pre-check and we go on to install it. The CLI then exits 1 with
 *
 *     plugin already exists: ~/.openclaw/npm/projects/openclaw-discord-…/
 *     node_modules/@openclaw/discord (delete it first)
 *
 * That is not a failure — the package being on disk is the outcome we asked
 * for. Reporting it as install_failed blocked a save whose plugin was present
 * and working, which is this module's own dishonesty inverted. Whether the
 * plugin actually serves the channel is settled afterwards by the live
 * connectivity probe, never guessed here.
 *
 * Deliberately NOT retried with `--force`: that would delete and re-download a
 * working plugin over the network to fix a stale index.
 */
function isAlreadyInstalled(err: unknown): boolean {
  return err instanceof Error && /plugin already exists/i.test(err.message);
}

/**
 * Make sure the plugin that owns `channelId` is installed and enabled.
 *
 * Idempotent: a device that already has it pays one `plugins list` and writes
 * nothing. Never throws — the caller has to be able to tell the owner WHICH
 * step failed, and an exception carries an npm error whose text is not fit for
 * a settings panel.
 *
 * Loading the plugin is the gateway's job: `plugins install` prints "Restart
 * the gateway to load plugins", so the restart the caller already performs
 * after writing the channel config is what puts it in service. That ordering
 * matters the other way too — install first, THEN write the channel config,
 * because the installer writes `plugins.entries.<id>` into the same
 * openclaw.json that a read-modify-write of the channel block would clobber.
 */
export async function ensureChannelPlugin(
  channelId: string,
  options: { timeoutMs?: number } = {},
): Promise<ChannelPluginResult> {
  const spec = OFFICIAL_CHANNEL_PLUGINS[channelId];
  if (!spec) return { ok: false, reason: "unsupported_channel" };

  let owner: PluginRow | null = null;
  try {
    const out = await spawnOpenclawCli(["plugins", "list", "--json"], {
      captureStdout: true,
      timeoutMs: PLUGIN_QUERY_TIMEOUT_MS,
    });
    owner = findChannelOwner(asRows(JSON.parse(out)), channelId);
  } catch {
    // An unreadable registry (bad JSON, a CLI that failed) must not be read as
    // "installed". Fall through to the install, which is idempotent enough:
    // the CLI refuses to overwrite an existing plugin without --force, and that
    // refusal surfaces as install_failed rather than as a silent success.
    owner = null;
  }

  let installed = false;
  if (!owner) {
    try {
      await spawnOpenclawCli(["plugins", "install", spec], {
        timeoutMs: options.timeoutMs ?? PLUGIN_INSTALL_TIMEOUT_MS,
      });
      installed = true;
    } catch (err) {
      if (!isAlreadyInstalled(err)) {
        // npm's output can be long and is not phrased for a settings panel, so
        // the caller gets a code and the log gets the cause.
        console.error(`[openclaw-channels] installing ${spec} failed:`, err);
        return { ok: false, reason: isTimeout(err) ? "install_timeout" : "install_failed" };
      }
      // Present already; fall through to the enable step, which is the half
      // that actually decides whether the gateway loads it.
      console.info(`[openclaw-channels] ${spec} was already installed; continuing`);
    }
  }

  // Installed is not the same as LOADED. The gateway brings a channel up only
  // when openclaw.json carries `plugins.entries.<id>.enabled`, and that entry
  // can be absent while the package sits on disk and `plugins list` calls it
  // enabled — see pluginEnabledInConfig. `plugins enable` is idempotent and is
  // skipped when the entry is already there, so the common path pays a file
  // read rather than a CLI cold start.
  const pluginId = typeof owner?.id === "string" ? owner.id : channelId;
  if (!(await pluginEnabledInConfig(pluginId))) {
    try {
      await spawnOpenclawCli(["plugins", "enable", pluginId], {
        timeoutMs: PLUGIN_QUERY_TIMEOUT_MS,
      });
    } catch (err) {
      console.error(`[openclaw-channels] enabling the ${channelId} plugin failed:`, err);
      return { ok: false, reason: "install_failed" };
    }
  }

  return { ok: true, installed };
}

/**
 * How the gateway describes a channel account's credential.
 *
 * `configured_unavailable` is the one that used to be invisible: the reference
 * is in the config and cannot be resolved. See `envSecretRef` in
 * openclaw-config.ts for what causes it.
 */
export type ChannelTokenStatus = "available" | "configured_unavailable" | "missing";

export interface ChannelStatus {
  configured: boolean;
  running: boolean;
  /** The transport is actually up. Absent in older payloads — never assumed. */
  connected: boolean;
  tokenStatus: ChannelTokenStatus | null;
  restartPending: boolean;
  /** The gateway's own last error for this account, verbatim, or null. */
  lastError: string | null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readTokenStatus(value: unknown): ChannelTokenStatus | null {
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : null;
}

function readLastError(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}

/**
 * Turn one gateway row into a {@link ChannelStatus}.
 *
 * Exported for the tests that pin the mapping, and because "absent reads as
 * false" is the rule that keeps an older gateway payload — which has no
 * `connected` key at all — from being reported as connected.
 */
export function parseChannelRow(row: Record<string, unknown>): ChannelStatus {
  return {
    configured: readBoolean(row.configured),
    running: readBoolean(row.running),
    connected: readBoolean(row.connected),
    tokenStatus: readTokenStatus(row.tokenStatus),
    restartPending: readBoolean(row.restartPending),
    lastError: readLastError(row.lastError),
  };
}

/**
 * What the gateway says about `channelId` right now, or `null` when it could
 * not be asked.
 *
 * `null` means UNKNOWN and must never be flattened into "offline" by a caller
 * that then reports it as a verdict — a wedged CLI, a gateway still booting and
 * a genuinely dead channel are three different things to tell the owner.
 *
 * Deliberately WITHOUT `--probe`. The probe is what adds `bot`/`application` to
 * the account row, and it is tempting for a display name — but it makes the
 * gateway call Discord, so it answers only when the caller could have asked
 * Discord itself, and it triples the CLI's own gateway timeout (10 s -> 30 s),
 * which is well past the budget below. Everything this function maps —
 * `connected`, `running`, `tokenStatus`, `lastError` — is present without it.
 */
export async function readChannelStatus(
  channelId: string,
  // `captureStdout` is deliberately not offerable: this function's whole job is
  // to parse the CLI's `--json`, and a caller that turned stdout off would get
  // an empty string and a silent `null` — "the gateway said nothing" — for a
  // channel that is perfectly healthy.
  options: Omit<SpawnOpenclawOptions, "captureStdout"> = {},
): Promise<ChannelStatus | null> {
  if (openclawIsAbsent()) return null;
  let parsed: unknown;
  try {
    const out = await spawnOpenclawCli(
      [
        "channels",
        "status",
        "--channel",
        channelId,
        "--json",
        // Bounds the gateway round trip the command makes. Without it a wedged
        // gateway is only stopped by the spawn timeout, which is much longer.
        "--timeout",
        String(CHANNEL_STATUS_GATEWAY_TIMEOUT_MS),
      ],
      { timeoutMs: CHANNEL_STATUS_TIMEOUT_MS, ...options, captureStdout: true },
    );
    parsed = JSON.parse(out);
  } catch (err) {
    console.warn(
      `[openclaw-channels] could not read ${channelId} status:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as {
    channelAccounts?: Record<string, unknown>;
    channels?: Record<string, unknown>;
  };

  // Prefer the per-ACCOUNT row: it is the only one that carries `connected`
  // and `tokenStatus`. The channel-level row — which has neither — is the
  // fallback for a payload that has no accounts yet.
  const accounts = payload.channelAccounts?.[channelId];
  if (Array.isArray(accounts) && accounts.length > 0) {
    const first = accounts[0];
    if (first && typeof first === "object") return parseChannelRow(first as Record<string, unknown>);
  }

  const channel = payload.channels?.[channelId];
  if (channel && typeof channel === "object") return parseChannelRow(channel as Record<string, unknown>);

  return null;
}

export interface WaitForChannelOptions {
  /** Status probes to make. Each one costs a full CLI cold start. */
  attempts?: number;
  /** Pause between probes. */
  delayMs?: number;
}

/**
 * Poll until `channelId` reports connected, or the attempts run out.
 *
 * Returns the LAST observation, so a caller can say *why* it is not connected
 * rather than only that it is not. `null` means the gateway could not be asked
 * at all on the final attempt.
 *
 * The attempt budget is small and the delay short because each probe pays
 * OpenClaw's CLI cold start (~10-12 s on a Jetson) — the wall-clock budget is
 * mostly made of those, not of the sleeps.
 */
export async function waitForChannelConnected(
  channelId: string,
  options: WaitForChannelOptions = {},
): Promise<ChannelStatus | null> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = options.delayMs ?? 2_000;

  let last: ChannelStatus | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await readChannelStatus(channelId);
    if (last?.connected) return last;
    // Waiting cannot conjure a secret that does not resolve, and the message is
    // the same on attempt four as on attempt one. Stop and let the caller say
    // so while the owner is still looking at the panel.
    if (last?.tokenStatus === "configured_unavailable") return last;
    if (attempt < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}
