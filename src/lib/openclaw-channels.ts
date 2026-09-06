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
  OpenclawSpawnTimeoutError,
  gatewayRestartGeneration,
  openclawIsAbsent,
  readConfig,
  spawnOpenclawCli,
} from "@/lib/openclaw-config";
import { installedOpenclawRelease } from "@/lib/openclaw-deepseek-plugin";

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

/**
 * Record consent for the plugin's declared capability surface.
 *
 * OpenClaw 2 refuses both verbs without it. `resolvePluginCapabilityConsent`
 * (the core's `dist/capability-consent-*.js`) throws `Plugin "<id>" requires
 * capability consent. Use openclaw plugins install or openclaw plugins enable
 * with --accept-capabilities, then retry.` unless the install record already
 * carries an accepted surface hash for the manifest on disk — and the only
 * other way to satisfy it is an interactive consent callback, which a spawned
 * CLI does not have. So without the flag a first install cannot succeed at
 * all: the owner's Discord save answered `install_failed`, and where the
 * package landed anyway the gateway refused readiness with that same sentence
 * for as long as the entry said to load the plugin (TASK-603).
 *
 * ClawBox already passes it everywhere else it drives this CLI — codex and the
 * DeepSeek provider in `scripts/gateway-pre-start.sh`, codex again in
 * `updater.ts`, the DeepSeek provider in `openclaw-deepseek-plugin.ts`. The
 * channel plugins were the ones left out.
 *
 * WHAT THIS PATH DOES NOT COVER, deliberately. A plugin ALREADY installed and
 * already switched on in the config skips both verbs below, so a save cannot
 * re-consent a surface that widened under it — and it should not have to: a
 * surface widens when the package version changes, which happens in
 * `install.sh`'s plugin refresh (which now carries the flag) and is repaired
 * from the gateway's own refusal by `gateway-pre-start.sh` on every boot and by
 * `updater.ts` during an update. Running the CLI unconditionally here would buy
 * a ~10-12 s cold start on every channel save to cover a case those three
 * already own.
 *
 * It is not a widening of what ClawBox trusts: the specs in
 * `OFFICIAL_CHANNEL_PLUGINS` are OpenClaw's own published packages, chosen by
 * this module rather than by the caller, and installing one at all is already
 * the owner's decision — the Settings panel that asked for the channel.
 */
const ACCEPT_CAPABILITIES = "--accept-capabilities";

/**
 * `<generation>` is what decides whether the flag may be passed at all.
 *
 * Declared-capability consent arrived with OpenClaw 2; a v1 CLI rejects
 * `--accept-capabilities` as an unknown option and fails the whole command
 * before any plugin state changes. `OPENCLAW_PIN_VERSION` is a documented
 * rollback override, so that is a reachable state and not a hypothetical, and
 * a Discord save that dies on an unknown flag is the false failure this module
 * exists to remove. `scripts/gateway-pre-start.sh` builds its own
 * `CODEX_CAPABILITY_ARGS` the same way; this is that rule in TypeScript.
 *
 * Asked of the INSTALLED binary, because it is the process that will parse the
 * argv. Unknown answers v2 — the shipped pin, and the generation every box in
 * the field runs — so a probe that times out cannot turn the ordinary path
 * into the consent refusal.
 *
 * Asked ONCE PER SAVE and passed to both verbs, rather than memoised for the
 * life of the process: the generation changes when the package is reinstalled,
 * and a value cached past that is the probe-once class this codebase keeps
 * producing. One `--version` on a path that may spend three minutes on an npm
 * install is not the cost to optimise.
 */
async function capabilityArgs(): Promise<string[]> {
  const release = await installedOpenclawRelease();
  if (!release) return [ACCEPT_CAPABILITIES];
  const [major, minor] = release.split(".").map((part) => Number.parseInt(part, 10));
  const isV2 = major > 2026 || (major === 2026 && minor >= 8);
  return isV2 ? [ACCEPT_CAPABILITIES] : [];
}

/**
 * `@openclaw/discord` and `openclaw-discord` are the same plugin as `discord`.
 *
 * The registry can key a plugin under any of the three — `findChannelOwner`
 * exists precisely because it does — so anything that decides "is this one of
 * ours" has to ask about the same name every time.
 */
export function normalizeChannelPluginId(id: string): string {
  return id.replace(/^@openclaw\//, "").replace(/^openclaw-/, "");
}

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

// Answering FALSE to everything it cannot read is load-bearing in BOTH uses of
// the function above, and neither tolerates the opposite: as the precondition
// it means an unreadable config runs the idempotent enable instead of skipping
// it, and as the read-back after a killed enable it means only an entry this
// process can SEE forgives the kill.

/** A spawn killed at its deadline, by type — the message is not the contract. */
function isTimeout(err: unknown): boolean {
  return err instanceof OpenclawSpawnTimeoutError;
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

  const capArgs = await capabilityArgs();

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
      await spawnOpenclawCli(["plugins", "install", spec, ...capArgs], {
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
      await spawnOpenclawCli(["plugins", "enable", pluginId, ...capArgs], {
        timeoutMs: PLUGIN_QUERY_TIMEOUT_MS,
      });
    } catch (err) {
      // A SIGKILL at the deadline is the one failure that says nothing about
      // whether the write happened. `plugins enable` writes
      // `plugins.entries.<id>.enabled` and THEN spends seconds loading the
      // gateway SDK, so on a Jetson the entry lands inside the 45 s window we
      // kill in — and this used to answer `install_failed`, which reaches the
      // owner as "the plugin could not be installed" over a channel that is
      // enabled on disk. The same read-back the precondition just used settles
      // it, and it fails closed, so an unreadable config keeps the failure.
      //
      // Only the ENABLE. A killed `plugins install` is not settled by this
      // entry: the npm package landing on disk is the other half of that verb,
      // and the config entry alone would bless an install that never finished.
      if (isTimeout(err) && (await pluginEnabledInConfig(pluginId))) {
        console.warn(
          `[openclaw-channels] enabling ${spec} was killed at its deadline, but the entry is in openclaw.json — the enable landed`,
        );
      } else {
        console.error(`[openclaw-channels] enabling the ${channelId} plugin failed:`, err);
        return { ok: false, reason: "install_failed" };
      }
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
  options: Omit<SpawnOpenclawOptions, "captureStdout"> = {},
): Promise<ChannelStatus | null> {
  const row = await readChannelRow(channelId, options);
  return row ? parseChannelRow(row) : null;
}

/**
 * The gateway's row for `channelId`, unparsed.
 *
 * {@link readChannelStatus} narrows this to the fields every channel shares.
 * Channels that publish more than that read the row directly instead of having
 * their extra fields flattened away — WhatsApp's `linked` is the case that
 * forced this: it is the only honest answer to "is a device paired", and
 * `configured` (which the common shape does carry) means merely "there is an
 * account entry". Reading `configured` as paired reported a linked phone on a
 * box where no QR had ever been shown.
 */
export async function readChannelRow(
  channelId: string,
  options: Omit<SpawnOpenclawOptions, "captureStdout"> = {},
): Promise<Record<string, unknown> | null> {
  return (await readChannelRowResult(channelId, options)).row;
}

/**
 * What {@link readChannelRow} learned, with "could not ask the gateway" kept
 * apart from "asked, and there is no row".
 *
 * Both are a `null` row, and to every caller that only wants the row they are
 * the same thing. The memo is the one place they are NOT: an absent channel is
 * a real, stable answer that stands for a full window, while an unreachable
 * gateway must be re-asked soon. Collapsing them made a box whose WhatsApp was
 * never set up — the common case — re-spawn the CLI five times as often as one
 * where it is configured, which is the opposite of the point.
 */
export interface ChannelRowResult {
  /** False only when the gateway could not be asked, or its output not read. */
  answered: boolean;
  row: Record<string, unknown> | null;
}

/** One `channels status --json` payload, as much of it as this module reads. */
interface ChannelStatusPayload {
  channelAccounts?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  /** The CLI's own word for "I could not reach the gateway". */
  gatewayReachable?: unknown;
  /** Set when the answer was assembled from the config file alone. */
  configOnly?: unknown;
}

/**
 * Run `channels status` and parse what came back.
 *
 * `channelId` narrows the read to ONE channel; `null` asks about every channel,
 * which is what the memo below does. `--channel` is optional on this command —
 * checked against the installed CLI, openclaw 2026.8.1 — and the un-filtered
 * payload is keyed by channel id, so one process start answers about all of
 * them. Measured on the OpenClaw box, three runs each: un-filtered 3.72/3.25/
 * 3.19 s against 3.17/3.15/3.10 s for a filtered read. The whole cost is the
 * CLI cold start; walking every channel adds about a quarter of a second, so
 * one un-filtered read is far cheaper than two filtered ones.
 *
 * `null` back means "could not read the gateway" — a spawn failure, or output
 * that is not a payload — and is deliberately kept apart from an EMPTY payload,
 * which is a gateway answering about a box with nothing configured.
 */
async function readChannelStatusPayload(
  channelId: string | null,
  // `captureStdout` is deliberately not offerable: this function's whole job is
  // to parse the CLI's `--json`, and a caller that turned stdout off would get
  // an empty string and a silent `null` — "the gateway said nothing" — for a
  // channel that is perfectly healthy.
  options: Omit<SpawnOpenclawOptions, "captureStdout"> = {},
): Promise<ChannelStatusPayload | null> {
  // No CLI to ask on a Hermes box. Not an answer: the edition is read per call,
  // so this must not be remembered as one.
  if (openclawIsAbsent()) return null;
  let parsed: unknown;
  try {
    const out = await spawnOpenclawCli(
      [
        "channels",
        "status",
        ...(channelId === null ? [] : ["--channel", channelId]),
        "--json",
        // Bounds the gateway round trip the command makes. Without it a wedged
        // gateway is only stopped by the spawn timeout, which is much longer.
        // It bounds the un-filtered read too, which is what keeps one wedged
        // channel from making the shared read slower than the per-channel ones
        // it replaced.
        "--timeout",
        String(CHANNEL_STATUS_GATEWAY_TIMEOUT_MS),
      ],
      { timeoutMs: CHANNEL_STATUS_TIMEOUT_MS, ...options, captureStdout: true },
    );
    parsed = JSON.parse(out);
  } catch (err) {
    console.warn(
      `[openclaw-channels] could not read ${channelId ?? "channel"} status:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  // The CLI exited fine but what came back is not a payload — the same class of
  // "could not read the gateway" as a spawn failure, not an answer about the
  // channel. `Array.isArray` is not redundant: `typeof [] === "object"`, so a
  // JSON array would otherwise walk on, find no channel in it, and be filed as
  // the gateway ANSWERING that this channel does not exist — for 15 s.
  //
  // The check stops here on purpose. Demanding a `channelAccounts` or
  // `channels` key would be the same mistake inverted: a gateway with nothing
  // configured is entitled to answer `{}`, and calling that a failed read would
  // put exactly the box this change is for back on the 3 s window.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as ChannelStatusPayload;
  // The CLI SAYS when it could not reach the gateway, and that is not an
  // answer about any channel. Measured on the OpenClaw box with the unit
  // stopped: `channels status --json` exits 0 and prints a perfectly valid
  // object — `{ gatewayReachable: false, configOnly: true, error: "Gateway not
  // reachable at ws://127.0.0.1:18789 (ECONNREFUSED)…", configuredChannels:
  // [...] }` — with no `channelAccounts` and no `channels` key at all. Read as
  // a payload it says "every channel was never set up", and that answer stood
  // for the full 15 s window instead of the 3 s a failed read gets. A gateway
  // restart is the commonest thing on this box, so the panel reported a paired,
  // connected WhatsApp as "Not configured" for a quarter of a minute after
  // every one of them. Ask the harness's own field rather than guessing from
  // the absence of keys, which a box with nothing configured is entitled to.
  if (payload.gatewayReachable === false || payload.configOnly === true) return null;
  return payload;
}

/**
 * One channel's row out of a payload, or `null` when the payload does not
 * mention it — which, for a payload the gateway actually answered, means that
 * channel was never set up.
 *
 * Prefer the per-ACCOUNT row: it is the only one that carries `connected` and
 * `tokenStatus`. The channel-level row — which has neither — is the fallback
 * for a payload that has no accounts yet.
 *
 * The un-filtered read does NOT change what this means. Captured on the
 * OpenClaw box, gateway up, WhatsApp never linked and Discord never
 * configured: `channels status --json` and `channels status --channel whatsapp
 * --json` carry the SAME `channelAccounts.whatsapp[0]` and the SAME
 * `channels.whatsapp` object, field for field. Only the SET of channels
 * listed differs — the un-filtered form lists every channel the gateway knows,
 * the filtered form lists the one it was asked about. So a channel absent from
 * an un-filtered payload is one that would have been absent from its own
 * filtered read too, and every memoised caller reads exactly the row it read
 * before. Pinned from those captures in
 * `src/tests/routes/channels/status-payload-shapes.test.ts`.
 */
function rowFromPayload(
  payload: ChannelStatusPayload,
  channelId: string,
): Record<string, unknown> | null {
  const accounts = payload.channelAccounts?.[channelId];
  if (Array.isArray(accounts) && accounts.length > 0) {
    const first = accounts[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }

  const channel = payload.channels?.[channelId];
  if (channel && typeof channel === "object") return channel as Record<string, unknown>;

  return null;
}

/** {@link ChannelRowResult} for one channel out of one payload read. */
function resultFor(payload: ChannelStatusPayload | null, channelId: string): ChannelRowResult {
  if (!payload) return { answered: false, row: null };
  return { answered: true, row: rowFromPayload(payload, channelId) };
}

async function readChannelRowResult(
  channelId: string,
  options: Omit<SpawnOpenclawOptions, "captureStdout"> = {},
): Promise<ChannelRowResult> {
  return resultFor(await readChannelStatusPayload(channelId, options), channelId);
}

// ── One memo for `channels status`, shared by every channel ─────────────────
//
// A status read is a full CLI cold start plus a gateway round trip — 3.2-3.6 s
// on a Jetson — and the status routes are re-read on every entry into a
// Settings section, after every save and unpair, and at pairing success; on a
// phone, where the panel's `!isMobile` escapes never return early, ONE section
// change re-reads every channel. OpenClaw has nowhere cheaper to ask:
// `channels status` IS the gateway's own status surface, `openclaw gateway
// call` pays the identical CLI start-up, and the gateway's only non-WebSocket
// endpoints are the `/healthz`, `/readyz` and `/startupz` liveness probes, none
// of which carries a channel row. So the memo belongs on this side of the CLI —
// and there is exactly ONE of it, here, rather than a private copy per route:
// /discord/status grew the first one and /whatsapp/status never got it, which
// is why one panel answered in 20 ms and the other in three and a half seconds
// from the same command.
//
// One memo AND one CLI start (TASK-671). The first shape of this cache still
// filled it one channel per start, so a cold Channels hub — or Settings on a
// phone, which reads every channel on one mount — paid the cold start twice
// over. `--channel` is optional and the un-filtered payload is keyed by channel
// id, so one process start answers about all of them; measured on the box,
// three runs each, 3.72/3.25/3.19 s un-filtered against 3.17/3.15/3.10 s
// filtered. The whole cost is the CLI start, and one read now serves what two
// used to.

/**
 * How long one gateway ANSWER about a channel stands — including the answer
 * "there is no such channel here", which is what an un-set-up channel gets.
 */
const CHANNEL_STATUS_TTL_MS = 15_000;
/**
 * How long a FAILED read stands — "the gateway could not be asked".
 *
 * Short, and much shorter than an answer, because the two are not equally true:
 * `readOpenclawWhatsappStatus` turns a `null` row into `state:"not_configured"`,
 * which the panel draws as an actionable "Not configured" card with a pairing
 * CTA. Pinning that for 15 s after a gateway restart would report a paired,
 * connected box as unconfigured for a quarter of a minute — a false failure.
 * A few seconds is still enough to stop a wedged CLI being re-entered per poll,
 * which is the only thing negative caching is for. The same success/failure
 * split the Discord and Telegram bot-info caches use.
 *
 * This is keyed on {@link ChannelRowResult.answered}, NOT on the row being
 * `null`: the two produce the same `null` row and only one of them is a failure.
 */
const CHANNEL_STATUS_FAILURE_TTL_MS = 3_000;

interface CachedRow {
  row: Record<string, unknown> | null;
  /** See {@link ChannelRowResult} — picks which of the two TTLs applies. */
  answered: boolean;
  at: number;
  /** When the read that produced this row STARTED. Two shared reads can be out
   *  at once, and the one that started first is free to finish last; without
   *  this the older answer overwrites the newer one and is stamped fresh. */
  startedAt: number;
  /** {@link gatewayRestartGeneration} when that read started. */
  restarts: number;
}
interface InFlightPayload {
  /**
   * Every channel's invalidation count when this read started — the whole map,
   * not one channel's, because one read now answers about all of them and each
   * has to be judged on its own.
   */
  epochs: Map<string, number>;
  /** Wall clock when the spawn began; see {@link CachedRow.startedAt}. */
  startedAt: number;
  /** {@link gatewayRestartGeneration} when the spawn began. */
  restarts: number;
  promise: Promise<ChannelStatusPayload | null>;
}

const cachedRows = new Map<string, CachedRow>();
/**
 * The ONE read in flight. There is no per-channel variant: a read without
 * `--channel` answers about every channel, so two of them would be the same
 * CLI start twice.
 */
let inFlightPayload: InFlightPayload | null = null;
/** Per channel, so one channel's mutation never discards another's fresh read. */
const epochs = new Map<string, number>();
/**
 * The channels ClawBox has a status panel for.
 *
 * A payload the gateway answered lists the channels it knows; a channel it does
 * NOT list was never set up, and a read that failed says nothing about any of
 * them. Both are answers that have to be stored for every channel a panel will
 * ask about, or the un-configured box — the common one — pays a CLI start per
 * channel on the first cold open instead of one for all of them.
 *
 * Deliberately a short, explicit list rather than a scrape of the CLI's own
 * `--channel` enumeration, for the same reason {@link OFFICIAL_CHANNEL_PLUGINS}
 * is one: this is what the Settings panel can show, and a channel ClawBox has
 * no UI for has no business occupying a memo slot. {@link askedChannelIds}
 * covers anything asked for beyond it.
 */
const MEMOISED_CHANNEL_IDS = ["telegram", "whatsapp", "discord"] as const;

/**
 * Channel ids some caller has asked the memo about, beyond the list above.
 *
 * Kept so a channel ClawBox learns about later still gets its negative answer
 * stored rather than re-asked on every poll, without that list having to be
 * edited in two places.
 */
const askedChannelIds = new Set<string>(MEMOISED_CHANNEL_IDS);

/**
 * Store one payload read against every channel it can speak for.
 *
 * `startedEpochs` is the snapshot taken when the read began: a channel whose
 * epoch moved since then had a change land mid-flight, so this answer predates
 * it and is dropped — for THAT channel only, which is the whole reason the
 * epochs are per channel rather than one counter.
 */
function storeChannelPayload(payload: ChannelStatusPayload | null, read: InFlightPayload): void {
  const at = Date.now();
  const answered = payload !== null;
  const restarts = read.restarts;
  const ids = new Set<string>(read.epochs.keys());
  for (const id of askedChannelIds) ids.add(id);
  if (payload) {
    // `payload` is an unchecked cast of whatever the CLI printed, and
    // `Object.keys("abc")` is `["0","1","2"]` — junk ids in the memo for a
    // malformed answer. The same plain-object test `rowFromPayload` applies per
    // value, applied once to the container.
    for (const group of [payload.channelAccounts, payload.channels]) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      for (const id of Object.keys(group)) ids.add(id);
    }
  }
  for (const id of ids) {
    // An invalidation that landed while this was in flight means the answer
    // predates the change that caused it — for THAT channel only, which is the
    // whole reason the epochs are per channel rather than one counter.
    if ((epochs.get(id) ?? 0) !== (read.epochs.get(id) ?? 0)) continue;
    const held = cachedRows.get(id);
    if (held) {
      // Two shared reads can overlap: whichever STARTED last owns the entry,
      // whatever order they finish in. Without this the slower, older read
      // lands second and its stale rows are stamped with a fresh `at`.
      if (held.startedAt > read.startedAt) continue;
      // A read that could not reach the gateway says nothing about a channel
      // some other read has just answered for. Downgrading a live answer to a
      // failure because a DIFFERENT channel's poll happened to fail is a false
      // failure this memo did not have while each channel had its own read.
      if (!answered && held.answered && held.restarts === restarts
          && Date.now() - held.at < CHANNEL_STATUS_TTL_MS) continue;
    }
    cachedRows.set(id, {
      row: payload ? rowFromPayload(payload, id) : null,
      answered,
      at,
      startedAt: read.startedAt,
      restarts,
    });
  }
}

/**
 * {@link readChannelRow}, but at most one CLI start per WINDOW — for every
 * channel at once, not one channel per start — with concurrent callers sharing
 * the one in flight. This is what a status route should call;
 * {@link readChannelRow} stays the uncached "ask right now" read that
 * {@link waitForChannelConnected} polls a transition with, where filtering to
 * one channel is right because that is what the caller is watching.
 *
 * The returned row is SHARED with every other caller in the window — read it,
 * never mutate it.
 *
 * Every path that CHANGES a channel must call {@link invalidateChannelStatus},
 * or a poll can keep serving a "not paired" that the owner's scan has already
 * disproved.
 */
export function readCachedChannelRowResult(channelId: string): Promise<ChannelRowResult> {
  askedChannelIds.add(channelId);
  const epoch = epochs.get(channelId) ?? 0;
  const restarts = gatewayRestartGeneration();
  const cached = cachedRows.get(channelId);
  // A row from before a gateway restart is not an answer about the gateway that
  // is up now. `restartGateway()` has ~14 callers — a model save, an STT
  // change, a browser install, the updater, boot — and none of them knows what
  // a channel is, so none can be taught to invalidate this. One poll of ANY
  // channel now seeds every channel's entry, so without this the exposure
  // covers channels the owner never even opened: the Telegram card would report
  // a receiving bot from a row read before the restart that stopped it, which
  // is the very thing that route says it exists to prevent.
  if (cached && cached.restarts === restarts) {
    const age = Date.now() - cached.at;
    const ttl = cached.answered ? CHANNEL_STATUS_TTL_MS : CHANNEL_STATUS_FAILURE_TTL_MS;
    // `age >= 0` because the clock is wall-clock: a Jetson whose RTC is corrected
    // BACKWARDS by NTP would otherwise pin the entry until the clock caught up.
    if (age >= 0 && age < ttl) {
      return Promise.resolve({ answered: cached.answered, row: cached.row });
    }
  }
  // Join a read in flight — but only one started since THIS channel's last
  // invalidation. An older one is answering a question the owner has already
  // changed the answer to: it is what would hand a poll made AFTER the QR was
  // scanned the "not linked" row that a read started before it is about to
  // return. Judged per channel, because the shared read is still perfectly
  // current for every other channel in it.
  const existing = inFlightPayload;
  if (existing && (existing.epochs.get(channelId) ?? 0) === epoch
      && existing.restarts === restarts) {
    return existing.promise.then((payload) => resultFor(payload, channelId));
  }

  // Snapshot BOTH sets: a channel that has been invalidated but never read
  // through this memo has an epoch and no entry in `askedChannelIds`, and
  // missing it would make this read's own fresh answer look stale.
  const startedEpochs = new Map<string, number>(epochs);
  for (const id of askedChannelIds) {
    if (!startedEpochs.has(id)) startedEpochs.set(id, 0);
  }
  const read: InFlightPayload = {
    epochs: startedEpochs,
    startedAt: Date.now(),
    restarts,
    // Assigned on the next line; the callbacks below cannot run before it is.
    promise: null as unknown as Promise<ChannelStatusPayload | null>,
  };
  read.promise = readChannelStatusPayload(null)
    .then((payload) => {
      storeChannelPayload(payload, read);
      return payload;
    })
    .finally(() => {
      // Only ever clear our OWN entry: an abandoned read must not evict the
      // replacement that an invalidation started, or the next caller pays for a
      // third CLI start.
      if (inFlightPayload === read) inFlightPayload = null;
    });
  inFlightPayload = read;
  return read.promise.then((payload) => resultFor(payload, channelId));
}

/**
 * {@link readCachedChannelRowResult} for callers that only need the row.
 *
 * A `null` row here means BOTH "the gateway said there is no such channel" and
 * "the gateway could not be asked" — two different facts. Anything that has to
 * tell them apart (the Settings list, which must not draw "Not configured" over
 * a channel nobody managed to read) needs the result form above.
 */
export function readCachedChannelRow(channelId: string): Promise<Record<string, unknown> | null> {
  return readCachedChannelRowResult(channelId).then(({ row }) => row);
}

/** {@link readChannelStatus} over {@link readCachedChannelRow}. */
export async function readCachedChannelStatus(channelId: string): Promise<ChannelStatus | null> {
  const row = await readCachedChannelRow(channelId);
  return row ? parseChannelRow(row) : null;
}

/**
 * Forget what the gateway said about `channelId`, including a read still in
 * flight.
 *
 * Called from every path that CHANGES a channel: enabling or disabling it,
 * dropping its session, completing a pairing, and the gateway restart at the end
 * of a save. Without this the memo is a probe-once answer with a 15 s fuse, and
 * the owner watches the panel insist the phone is unpaired for a quarter of a
 * minute after the scan that paired it.
 */
export function invalidateChannelStatus(channelId: string): void {
  epochs.set(channelId, (epochs.get(channelId) ?? 0) + 1);
  cachedRows.delete(channelId);
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
