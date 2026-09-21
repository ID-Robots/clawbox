/**
 * Is the Hermes agent's pre-exec shell scanner installed and switched on?
 *
 * The agent runs every shell command past `tirith` first (upstream's
 * `tools/tirith_security.py`). That scanner is not shipped with the box: the
 * agent downloads it from a GitHub release into `$HERMES_HOME/bin/tirith` in a
 * background thread the first time it is needed. Until that finishes the agent
 * runs commands UNSCANNED — upstream's default is fail-OPEN — and the only
 * trace is one `logger.warning` per process ("tirith path resolved to None;
 * scanning disabled"). No error, no non-zero exit, nothing a health check sees.
 *
 * That is a security control that can be off while the product reports nothing,
 * which is the failure this module exists to end.
 *
 * WHAT IT CAN AND CANNOT ASSERT. This is a report on the box's CONFIGURED
 * state, read from disk. It is not a promise about the running agent, and the
 * wording everywhere — here, in the route and in the card — is chosen to say
 * only the first:
 *
 *   * upstream opens a circuit breaker after three consecutive scanner failures
 *     (`tirith_security.py:748-754`) that returns `allow` unconditionally, ABOVE
 *     both the path resolution and the `fail_open` check, and nothing resets it
 *     for the life of the process. A box whose scanner timed out three times is
 *     not scanning, and no file on disk says so;
 *   * a settings change reaches the agent when the agent next reads it, not when
 *     ClawBox writes it;
 *   * nothing on the device can tell a genuine release binary from a
 *     replacement — that needs a trusted checksum an offline box does not have.
 *
 * So `"on"` means "installed and enabled", never "your commands are being
 * checked". Upstream exposes no CLI verb or endpoint for the live answer;
 * `ensure_installed()` (`:633`) is a caching library call, not a probe.
 *
 * HARNESS FIRST — every setting here is Hermes' own, not invented:
 *
 *   * `security.tirith_enabled` / `tirith_path` / `tirith_fail_open` in
 *     `~/.hermes/config.yaml`, with the `TIRITH_ENABLED` / `TIRITH_BIN` /
 *     `TIRITH_FAIL_OPEN` env overrides and the same defaults upstream applies in
 *     `_load_security_config()` (`tirith_security.py:68-87`);
 *   * the resolution order and the install location of `_resolve_tirith_path()`
 *     (`:493-598`);
 *   * the 24 h retry suppression of upstream's `.tirith-install-failed` marker,
 *     including the one reason it clears early (`:175-199`).
 *
 * ClawBox deliberately does NOT gate exec itself. Upstream already owns that
 * decision through `security.tirith_fail_open`: `false` turns a missing or
 * unspawnable scanner into `{"action": "block"}`. Re-implementing a gate here
 * would be a second, divergent policy over the same commands. `failOpen` is
 * reported so the card can say which of the two the box is configured for.
 *
 * NOT probe-once, and no interpreter: the scanner appears on disk the moment the
 * background download finishes, so every call re-reads. `config.yaml` is read
 * directly rather than through `hermes config get` — it is the file
 * `load_config_readonly()` reads, ClawBox is already its own reader and writer
 * for it (`src/lib/hermes-config-yaml.ts`), and three Python interpreter starts
 * do not belong behind a Settings panel.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";

import { hermesConfigPath } from "@/lib/hermes-config-yaml";
import { hermesHome, readHermesEnv } from "@/lib/hermes-env";
import { getYamlPath, hasYamlPath } from "@/lib/yaml-block-edit";

/** Hermes' own config keys, and the env var that overrides each of them. */
const KEYS = {
  // Upstream's env var for the path is TIRITH_BIN while the config key is
  // tirith_path — deliberately not the same name. Do not "fix" this.
  enabled: { yaml: ["security", "tirith_enabled"], env: "TIRITH_ENABLED" },
  path: { yaml: ["security", "tirith_path"], env: "TIRITH_BIN" },
  failOpen: { yaml: ["security", "tirith_fail_open"], env: "TIRITH_FAIL_OPEN" },
} as const;

/** Upstream's defaults when neither the config key nor the env var is set. */
const DEFAULT_ENABLED = true;
const DEFAULT_PATH = "tirith";
const DEFAULT_FAIL_OPEN = true;

/**
 * A config.yaml this large is not a config file. Same guard, and the same
 * reason, as `MAX_ENV_BYTES` next door in hermes-env: this read happens behind a
 * Settings panel and must not be able to pull an arbitrary amount of a planted
 * file into memory.
 */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Upstream writes this beside config.yaml and skips retries while it is fresh. */
const INSTALL_FAILED_MARKER = ".tirith-install-failed";
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The one marker reason upstream drops early — and only when `cosign` is on the
 * agent's PATH (`tirith_security.py:200-205`); without it the 24 h suppression
 * stands like any other. Nothing upstream writes this reason today (a missing
 * cosign downgrades to SHA-256 only, `:451`), so this is a guard against a
 * future bump, not a live case.
 */
const RETRYABLE_MARKER_REASON = "cosign_missing";

/** One key out of config.yaml: whether it is there at all, and its raw scalar. */
interface ConfigValue {
  present: boolean;
  raw: string | null;
}

export type ShellScanState = "on" | "off" | "unknown";

export type ShellScanReason =
  /** Installed and enabled — everything the device itself can establish. */
  | "ok"
  /** Not on the box (yet) — the usual case after a factory reset or a fresh flash. */
  | "not-installed"
  /** Somebody set `security.tirith_enabled: false` (or `TIRITH_ENABLED=0`). */
  | "disabled-by-config"
  /** The agent's own settings could not be read, so nothing here is asserted. */
  | "config-unreadable";

export interface ShellScanStatus {
  state: ShellScanState;
  reason: ShellScanReason;
  /**
   * Upstream's `security.tirith_fail_open`. `true` (upstream's default) means a
   * missing scanner lets commands through unscanned; `false` means the agent is
   * configured to block them instead. Decides which sentence the card shows.
   */
  failOpen: boolean;
  /** Where the scanner was found. Null whenever `state` is not `"on"`. */
  scannerPath: string | null;
  /**
   * ISO timestamp until which upstream is suppressing download retries after a
   * failed install, or null. This is why a box that is back online can still be
   * unscanned: the marker survives going online, only its 24 h age clears it.
   */
  retrySuppressedUntil: string | null;
}

/** Upstream's `_env_bool`: only these count as true; anything else is false. */
function envBool(raw: string): boolean {
  return ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}

/**
 * Values PyYAML resolves to something Python calls false. `no`/`off`/`n` are in
 * the list because the config is YAML 1.1, where they are booleans; `[]`/`{}`
 * because an empty collection is falsy; `0`/`0.0` because zero is.
 */
const FALSY_YAML = new Set(["false", "no", "off", "n", "null", "~", "0", "0.0", "[]", "{}", ""]);

/**
 * A configured Hermes flag, as UPSTREAM reads it.
 *
 * Upstream does not parse these as booleans at all — `_load_security_config`
 * hands the YAML value through untouched and the call sites apply plain Python
 * truthiness (`if not cfg["tirith_enabled"]`, `if fail_open`). So anything
 * present that is not falsy is TRUE, including a word like `maybe`; and a key
 * written with no value at all is `None`, which is FALSE, not "unset".
 *
 * Returns null only for a key that is genuinely absent — the one case where the
 * caller's default applies.
 *
 * KNOWN LIMIT: `getYamlPath` unquotes, so `tirith_enabled: "false"` (a truthy
 * Python string) is indistinguishable here from `tirith_enabled: false`. It is
 * read as false, i.e. as "scanning off" — the direction that warns rather than
 * the one that stays quiet.
 */
function configuredFlag(value: ConfigValue): boolean | null {
  if (!value.present) return null;
  if (value.raw === null) return false; // `key:` with nothing after it → None
  return !FALSY_YAML.has(value.raw.trim().toLowerCase());
}

/** True when `p` is a regular file this process may execute. */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return false;
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's home, working directory and PATH — copied from
 * `config/clawbox-hermes-dashboard.service:9-11`, NOT taken from this process.
 * The web server's unit sets no PATH and inherits systemd's default, which has
 * no `~/.local/bin`; reading `process.env.PATH` here would miss a scanner the
 * agent resolves perfectly well and paint a warning on a box that is scanning.
 */
function agentHome(): string {
  return process.env.HOME || "/home/clawbox";
}
function agentPathDirs(): string[] {
  return [path.join(agentHome(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
}

/** `os.path.expanduser`, for the one form a config file ever uses. */
function expandUser(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return path.join(agentHome(), p.slice(1));
}

/** `shutil.which` for a bare name, over the agent's PATH. */
async function which(name: string): Promise<string | null> {
  for (const dir of agentPathDirs()) {
    const candidate = path.join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Where the scanner is, mirroring `_resolve_tirith_path()` (`:493-598`) without
 * its side-effects — this reports, it must never trigger a download.
 *
 * Upstream's split is on the VALUE, not the shape: anything other than the bare
 * `"tirith"` is "explicit" (`_is_explicit_path`, `:488-490`) and authoritative —
 * the literal path, then a PATH lookup, and never `$HERMES_HOME/bin`, so a
 * configured `tirith-v2` must not be satisfied by a leftover binary of that name
 * in the agent's own download directory.
 */
async function resolveScanner(configuredPath: string): Promise<string | null> {
  if (configuredPath !== DEFAULT_PATH) {
    // A relative path resolves against the agent's WorkingDirectory, not the
    // web server's cwd (which is the ClawBox checkout, a different directory).
    const literal = path.resolve(agentHome(), expandUser(configuredPath));
    if (await isExecutableFile(literal)) return literal;
    return which(expandUser(configuredPath));
  }
  return (await which(DEFAULT_PATH)) ?? (await onlyIfExecutable(path.join(hermesHome(), "bin", DEFAULT_PATH)));
}

/** `p` when it is an executable regular file, otherwise null. */
async function onlyIfExecutable(p: string): Promise<string | null> {
  return (await isExecutableFile(p)) ? p : null;
}

/**
 * When upstream will next allow a download retry, or null if it will retry now.
 *
 * A `cosign_missing` marker is excluded ONLY when cosign is actually installed:
 * that is the condition on which upstream clears it and retries (`:189-205`).
 * Excluding it unconditionally would tell the owner to connect the box to the
 * internet on a box that will not retry for another day.
 */
async function readRetrySuppressedUntil(): Promise<string | null> {
  const marker = path.join(hermesHome(), INSTALL_FAILED_MARKER);
  // ONE descriptor for both the age and the reason. Reading the mtime by name
  // and then the contents by name lets the path mean two different files
  // between the calls (CWE-367), and those two answers together decide what the
  // owner is told about a security control. O_NONBLOCK because the regular-file
  // check happens after the open: a fifo dropped here would otherwise park this
  // request until someone opened the write end. Same open, for the same two
  // reasons, as `readEnvText` in hermes-env.ts.
  let handle: FileHandle;
  try {
    handle = await fs.open(marker, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return null; // No marker — upstream retries on the next command.
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const reason = await handle.readFile("utf-8");
    if (reason.trim() === RETRYABLE_MARKER_REASON && (await which("cosign"))) return null;
    const until = stat.mtimeMs + MARKER_TTL_MS;
    return until > Date.now() ? new Date(until).toISOString() : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * config.yaml's text, "" when the box has none yet, or null when it could not be
 * read.
 *
 * Hardened the same way, and for the same two reasons, as `readEnvText` in
 * hermes-env and the marker read above. The agent runs as the same user and can
 * write `~/.hermes`: a plain `fs.readFile` on a FIFO planted there parks in
 * `open(2)` with no writer, and this read sits inside the status route's
 * `Promise.all`, so that request would never settle and each one would hold a
 * libuv threadpool thread. `O_NONBLOCK` returns immediately (it has no effect on
 * a regular file, the only case that goes on to read), the regular-file check
 * happens on the descriptor that was opened, and the size is capped.
 */
async function readConfigText(): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(hermesConfigPath(), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // No config.yaml is an ordinary state — a box before its first boot. Upstream
    // swallows that and applies its defaults (`:79-80`), so it is not "unknown".
    return code === "ENOENT" || code === "ENOTDIR" ? "" : null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return await handle.readFile("utf-8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The `security:` block, or null when the file could not be read or parsed. */
async function readSecurityConfig(): Promise<Record<keyof typeof KEYS, ConfigValue> | null> {
  const text = await readConfigText();
  if (text === null) return null;
  try {
    const read = (yaml: readonly string[]): ConfigValue => ({
      present: hasYamlPath(text, [...yaml]),
      raw: getYamlPath(text, [...yaml]),
    });
    return {
      enabled: read(KEYS.enabled.yaml),
      path: read(KEYS.path.yaml),
      failOpen: read(KEYS.failOpen.yaml),
    };
  } catch {
    // A shape the line reader does not understand. Reporting the defaults here
    // would assert a setting nobody read; say so instead.
    return null;
  }
}

/**
 * Report whether the Hermes agent's shell scanner is installed and enabled.
 * Callers must only ask this for the Hermes harness — the OpenClaw harness has
 * no tirith and must not be told it is missing one.
 */
export async function readShellScanStatus(): Promise<ShellScanStatus> {
  let env: Record<string, string>;
  try {
    env = await readHermesEnv();
  } catch {
    // An unreadable ~/.hermes/.env could be hiding a TIRITH_* override, so no
    // claim about the scanner can be made. Saying "on" here would be exactly
    // the false success this module exists to prevent.
    return unknown();
  }
  const config = await readSecurityConfig();

  const enabledOverride = KEYS.enabled.env in env ? envBool(env[KEYS.enabled.env]) : null;
  const failOpen =
    (KEYS.failOpen.env in env ? envBool(env[KEYS.failOpen.env]) : null) ??
    (config ? configuredFlag(config.failOpen) : null) ??
    DEFAULT_FAIL_OPEN;

  // An override in .env settles the question on its own, so an unreadable
  // config.yaml must not turn a definitively-off box into "unknown".
  const enabled = enabledOverride ?? (config ? configuredFlag(config.enabled) ?? DEFAULT_ENABLED : null);
  if (enabled === null) return unknown();
  if (!enabled) {
    return { state: "off", reason: "disabled-by-config", failOpen, scannerPath: null, retrySuppressedUntil: null };
  }

  // Which binary the agent would look for. Only the config can answer that, so
  // an unreadable one is unknown even when we know scanning is enabled.
  const pathOverride = (env[KEYS.path.env] ?? "").trim();
  if (!pathOverride && !config) return unknown();
  const configuredPath = pathOverride || (config?.path.raw ?? "").trim() || DEFAULT_PATH;

  const scannerPath = await resolveScanner(configuredPath);
  if (scannerPath) {
    return { state: "on", reason: "ok", failOpen, scannerPath, retrySuppressedUntil: null };
  }
  return {
    state: "off",
    reason: "not-installed",
    failOpen,
    scannerPath: null,
    // Only the bare default is ever auto-downloaded. On an explicitly configured
    // path upstream stops at "not found" and never fetches anything (`:536-541`),
    // so promising a retry after the marker expires would be a false failure.
    retrySuppressedUntil: configuredPath === DEFAULT_PATH ? await readRetrySuppressedUntil() : null,
  };
}

/** "We could not read the agent's own settings" — never dressed up as "on". */
function unknown(): ShellScanStatus {
  return {
    state: "unknown",
    reason: "config-unreadable",
    failOpen: DEFAULT_FAIL_OPEN,
    scannerPath: null,
    retrySuppressedUntil: null,
  };
}
