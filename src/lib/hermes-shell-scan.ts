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
import { constants as fsConstants } from "fs";
import path from "path";

import { hermesConfigPath } from "@/lib/hermes-config-yaml";
import { hermesHome, readHermesEnv } from "@/lib/hermes-env";
import { getYamlPath } from "@/lib/yaml-block-edit";

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

/** Upstream writes this beside config.yaml and skips retries while it is fresh. */
const INSTALL_FAILED_MARKER = ".tirith-install-failed";
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/** The one marker reason upstream clears early, so the 24 h claim is wrong for it. */
const RETRYABLE_MARKER_REASON = "cosign_missing";

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

/** A YAML scalar as a boolean, or null when the key is unset or unrecognised. */
function yamlBool(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
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

async function onlyIfExecutable(p: string): Promise<string | null> {
  return (await isExecutableFile(p)) ? p : null;
}

/**
 * When upstream will next allow a download retry, or null if it will retry now.
 *
 * `cosign_missing` is excluded on purpose: upstream clears that marker as soon
 * as `cosign` is on PATH (`:189-199`), so claiming a 24 h wait for it would be a
 * false failure.
 */
async function readRetrySuppressedUntil(): Promise<string | null> {
  const marker = path.join(hermesHome(), INSTALL_FAILED_MARKER);
  try {
    const [stat, reason] = await Promise.all([
      fs.stat(marker),
      fs.readFile(marker, "utf-8").catch(() => ""),
    ]);
    if (reason.trim() === RETRYABLE_MARKER_REASON) return null;
    const until = stat.mtimeMs + MARKER_TTL_MS;
    return until > Date.now() ? new Date(until).toISOString() : null;
  } catch {
    return null;
  }
}

/** The `security:` block as raw scalars, or null when the file is unreadable. */
async function readSecurityConfig(): Promise<Record<keyof typeof KEYS, string | null> | null> {
  let text: string;
  try {
    text = await fs.readFile(hermesConfigPath(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // No config.yaml is an ordinary state — a box before its first boot. Upstream
    // swallows that and applies its defaults (`:79-80`), so it is not "unknown".
    if (code === "ENOENT" || code === "ENOTDIR") text = "";
    else return null;
  }
  try {
    return {
      enabled: getYamlPath(text, [...KEYS.enabled.yaml]),
      path: getYamlPath(text, [...KEYS.path.yaml]),
      failOpen: getYamlPath(text, [...KEYS.failOpen.yaml]),
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
    yamlBool(config?.failOpen ?? null) ??
    DEFAULT_FAIL_OPEN;

  // An override in .env settles the question on its own, so an unreadable
  // config.yaml must not turn a definitively-off box into "unknown".
  const enabled = enabledOverride ?? (config ? yamlBool(config.enabled) ?? DEFAULT_ENABLED : null);
  if (enabled === null) return unknown();
  if (!enabled) {
    return { state: "off", reason: "disabled-by-config", failOpen, scannerPath: null, retrySuppressedUntil: null };
  }

  // Which binary the agent would look for. Only the config can answer that, so
  // an unreadable one is unknown even when we know scanning is enabled.
  const pathOverride = (env[KEYS.path.env] ?? "").trim();
  if (!pathOverride && !config) return unknown();
  const configuredPath = pathOverride || (config?.path ?? "").trim() || DEFAULT_PATH;

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
