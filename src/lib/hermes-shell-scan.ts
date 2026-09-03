/**
 * Is the Hermes agent scanning shell commands BEFORE it runs them?
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
 * which is the failure this module exists to end. It answers one question for
 * the dashboard: is pre-exec scanning on right now, and if not, why.
 *
 * HARNESS FIRST — everything here is read from the harness's own contract, not
 * invented:
 *
 *   * the settings are Hermes' own `security.tirith_*` keys in config.yaml,
 *     read through the `hermes` CLI (`hermes-config-cache`), with the same
 *     `TIRITH_ENABLED` / `TIRITH_BIN` / `TIRITH_FAIL_OPEN` env overrides and the
 *     same defaults (enabled, path `"tirith"`, fail-open) upstream applies in
 *     `_load_security_config()`;
 *   * the install location is upstream's `$HERMES_HOME/bin/tirith`;
 *   * the 24 h retry suppression is upstream's `.tirith-install-failed` marker.
 *
 * ClawBox deliberately does NOT gate exec itself. Upstream already owns that
 * decision through `security.tirith_fail_open`: `false` turns a missing or
 * unspawnable scanner into `{"action": "block"}`. Re-implementing a gate here
 * would be a second, divergent policy over the same commands. `failOpen` is
 * reported so the UI can say which of the two the box is doing.
 *
 * KNOWN LIMIT, upstream's not ours: after three consecutive scanner failures
 * upstream opens a circuit breaker that returns `allow` unconditionally, ABOVE
 * the `fail_open` check. So `failOpen: false` is not an absolute guarantee, and
 * this module reports the configured intent, not a promise.
 *
 * NOT probe-once: the scanner appears on disk the moment the background
 * download finishes, so the filesystem checks run per call. Only the config
 * keys are cached, and that cache is invalidated by config.yaml's mtime.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";

import { hermesConfigGetMany, hermesConfigReadPending } from "@/lib/hermes-config-cache";
import { hermesHome, readHermesEnv } from "@/lib/hermes-env";

/** Hermes' own config keys, and the env vars that override each of them. */
const KEYS = {
  enabled: { config: "security.tirith_enabled", env: "TIRITH_ENABLED" },
  // Upstream's env var is TIRITH_BIN while the config key is tirith_path —
  // deliberately not the same name. Do not "fix" this to TIRITH_PATH.
  path: { config: "security.tirith_path", env: "TIRITH_BIN" },
  failOpen: { config: "security.tirith_fail_open", env: "TIRITH_FAIL_OPEN" },
} as const;

/** Upstream's defaults when neither the config key nor the env var is set. */
const DEFAULT_ENABLED = true;
const DEFAULT_PATH = "tirith";
const DEFAULT_FAIL_OPEN = true;

/** Upstream writes this beside config.yaml and skips retries while it is fresh. */
const INSTALL_FAILED_MARKER = ".tirith-install-failed";
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

export type ShellScanState = "on" | "off" | "unknown";

export type ShellScanReason =
  /** The scanner resolved and is executable. */
  | "ok"
  /** Not on the box (yet) — the usual case after a factory reset or a fresh flash. */
  | "not-installed"
  /** Somebody set `security.tirith_enabled: false` (or `TIRITH_ENABLED=0`). */
  | "disabled-by-config"
  /** The agent's own config could not be read, so nothing here is asserted. */
  | "config-unreadable";

export interface ShellScanStatus {
  state: ShellScanState;
  reason: ShellScanReason;
  /**
   * Upstream's `security.tirith_fail_open`. `true` (upstream's default) means a
   * missing scanner lets commands through unscanned; `false` means the agent
   * blocks them instead. Decides which sentence the dashboard shows.
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
 * A boolean out of `hermes config get`. "" is "the key is not set" — the CLI
 * exits non-zero for an unset key and the cache turns that into an empty
 * string — so the caller's default applies. An unrecognised value is treated
 * the same way rather than guessed at.
 */
function configBool(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
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

/** `os.path.expanduser`, for the one form a config file ever uses. */
function expandUser(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return path.join(process.env.HOME || "/home/clawbox", p.slice(1));
}

/**
 * Where the scanner is, mirroring `_resolve_tirith_path()` without its
 * side-effects — this must never trigger a download, only report.
 *
 * Upstream looks on PATH and then in `$HERMES_HOME/bin`. Both are checked here,
 * with one caveat worth stating: PATH here is the web server's, not the agent's,
 * so a bare name that only the agent can resolve would read as missing. It does
 * not matter in practice — the only thing that ever puts tirith on a ClawBox is
 * the agent's own installer, into `$HERMES_HOME/bin`, which is checked directly.
 */
async function resolveScanner(configuredPath: string): Promise<string | null> {
  const expanded = expandUser(configuredPath);
  const candidates = expanded.includes(path.sep)
    ? [expanded]
    : [...searchPath(expanded), path.join(hermesHome(), "bin", expanded)];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** `shutil.which`'s candidate list for a bare name. */
function searchPath(name: string): string[] {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
}

/** When upstream will next allow a download retry, or null if it will now. */
async function readRetrySuppressedUntil(): Promise<string | null> {
  try {
    const marker = path.join(hermesHome(), INSTALL_FAILED_MARKER);
    const until = (await fs.stat(marker)).mtimeMs + MARKER_TTL_MS;
    return until > Date.now() ? new Date(until).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Report whether the Hermes agent is scanning shell commands before running
 * them. Callers must only ask this for the Hermes harness — the OpenClaw
 * harness has no tirith and must not be told it is missing one.
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

  const config = await hermesConfigGetMany([KEYS.enabled.config, KEYS.path.config, KEYS.failOpen.config]);
  // Checked AFTER the reads have settled: an answer is cached against
  // config.yaml's mtime and never expires, so anything still "pending" here is
  // a read that failed (a wedged or missing `hermes`), not one in flight.
  if (Object.values(KEYS).some(({ config: key }) => hermesConfigReadPending(key))) return unknown();

  const failOpen = KEYS.failOpen.env in env
    ? envBool(env[KEYS.failOpen.env])
    : configBool(config[KEYS.failOpen.config] ?? "", DEFAULT_FAIL_OPEN);

  const enabled = KEYS.enabled.env in env
    ? envBool(env[KEYS.enabled.env])
    : configBool(config[KEYS.enabled.config] ?? "", DEFAULT_ENABLED);
  if (!enabled) {
    return { state: "off", reason: "disabled-by-config", failOpen, scannerPath: null, retrySuppressedUntil: null };
  }

  const configuredPath = (env[KEYS.path.env] || config[KEYS.path.config] || "").trim() || DEFAULT_PATH;
  const scannerPath = await resolveScanner(configuredPath);
  if (scannerPath) {
    return { state: "on", reason: "ok", failOpen, scannerPath, retrySuppressedUntil: null };
  }
  return {
    state: "off",
    reason: "not-installed",
    failOpen,
    scannerPath: null,
    retrySuppressedUntil: await readRetrySuppressedUntil(),
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
