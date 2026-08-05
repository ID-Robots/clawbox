import fs from "fs";
import net from "net";

// Strict validation/loading of operator-supplied trusted control UI origins.
//
// Narrow escape hatch for genuinely cross-origin/custom-origin Control UI
// deployments (for example, a reverse proxy on a different hostname or
// port). Same-origin access via `<hostname>.local`,
// Tailscale `.ts.net` names, or a private LAN IP already works without any
// entry here — see gateway-proxy.ts's isReflectableHost().
//
// Contract: a JSON array of strings at CLAWBOX_CONTROL_UI_ORIGINS_FILE (or
// the default path below) is read and validated. A missing file is normal
// (no extras, no warning). Anything malformed is dropped with a warning —
// this module never throws, since a malformed file must not break the proxy.
// Mirrors scripts/gateway_origins.py; keep the two in sync.

const DEFAULT_ORIGINS_PATH = "/home/clawbox/clawbox/data/control-ui-origins.json";
const ORIGINS_PATH_ENV_VAR = "CLAWBOX_CONTROL_UI_ORIGINS_FILE";

// DNS-style hostname: dot-separated labels, each starting/ending with an
// alphanumeric, letters/digits/hyphens in between. Dotted-decimal input is
// validated separately as IPv4 so this loader stays aligned with the Python
// pre-start loader.
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FORBIDDEN_RAW_ORIGIN_RE = /[\\%]|[^\x20-\x7e]/;

export interface NormalizedOrigin {
  origin: string | null;
  warning: string | null;
}

export interface ConfiguredOrigins {
  origins: string[];
  warnings: string[];
}

export function resolveOriginsPath(): string {
  return process.env[ORIGINS_PATH_ENV_VAR] || DEFAULT_ORIGINS_PATH;
}

/**
 * Validate and normalize a single origin.
 *
 * Accepts exact http/https origins only — no wildcard, no credentials, no
 * path beyond "/", no query, no fragment, and a resolvable host[:port].
 * Normalizes scheme/host to lowercase, keeps IPv6 hosts in bracket form,
 * and drops the port when it's the scheme's default.
 */
export function normalizeOrigin(raw: unknown): NormalizedOrigin {
  if (typeof raw !== "string") {
    return {
      origin: null,
      warning: `origin must be a string, got ${typeof raw}: ${JSON.stringify(raw)}`,
    };
  }

  // Keep this in lockstep with scripts/gateway_origins.py. The WHATWG URL
  // parser silently discards some controls and treats backslashes specially,
  // while Python's urlsplit behaves differently.
  if (FORBIDDEN_RAW_ORIGIN_RE.test(raw)) {
    return {
      origin: null,
      warning: `origin contains a forbidden raw character: ${JSON.stringify(raw)}`,
    };
  }

  const value = raw.trim();
  if (!value) {
    return { origin: null, warning: "origin is empty" };
  }
  if (value.includes("*")) {
    return { origin: null, warning: `wildcard origins are not allowed: ${JSON.stringify(raw)}` };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, warning: `origin is not a valid URL: ${JSON.stringify(raw)}` };
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { origin: null, warning: `origin scheme must be http or https: ${JSON.stringify(raw)}` };
  }

  if (url.username || url.password) {
    return { origin: null, warning: `origin must not contain credentials: ${JSON.stringify(raw)}` };
  }

  if (url.pathname !== "" && url.pathname !== "/") {
    return { origin: null, warning: `origin must not contain a path: ${JSON.stringify(raw)}` };
  }
  if (url.search) {
    return { origin: null, warning: `origin must not contain a query string: ${JSON.stringify(raw)}` };
  }
  if (url.hash) {
    return { origin: null, warning: `origin must not contain a fragment: ${JSON.stringify(raw)}` };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    return { origin: null, warning: `origin is missing a host: ${JSON.stringify(raw)}` };
  }

  let hostPart: string;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bare = hostname.slice(1, -1);
    if (!net.isIPv6(bare)) {
      return { origin: null, warning: `origin has an invalid IPv6 host: ${JSON.stringify(raw)}` };
    }
    hostPart = `[${bare}]`;
  } else {
    if (!HOSTNAME_RE.test(hostname)) {
      return { origin: null, warning: `origin has an invalid host: ${JSON.stringify(raw)}` };
    }
    if (/^[0-9.]+$/.test(hostname) && !net.isIPv4(hostname)) {
      return { origin: null, warning: `origin has an invalid IPv4 host: ${JSON.stringify(raw)}` };
    }
    hostPart = hostname;
  }

  const defaultPort = scheme === "https" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? url.port : "";
  const portPart = port ? `:${port}` : "";

  return { origin: `${scheme}://${hostPart}${portPart}`, warning: null };
}

/**
 * Load, validate, and de-duplicate the JSON array of extra origins at `path`.
 *
 * A missing file returns `{ origins: [], warnings: [] }` — no extras, no
 * warning. Any other failure (unreadable file, invalid JSON, non-array top
 * level, invalid entries) is reported as a warning and excluded from the
 * result; this function never throws.
 */
export function loadConfiguredOrigins(path: string): ConfiguredOrigins {
  if (!path || !fs.existsSync(path)) {
    return { origins: [], warnings: [] };
  }

  let rawText: string;
  try {
    rawText = fs.readFileSync(path, "utf-8");
  } catch (err) {
    return {
      origins: [],
      warnings: [`could not read control UI origins file ${path}: ${errorMessage(err)}`],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return {
      origins: [],
      warnings: [`control UI origins file ${path} is not valid JSON: ${errorMessage(err)}`],
    };
  }

  if (!Array.isArray(data)) {
    return {
      origins: [],
      warnings: [
        `control UI origins file ${path} must contain a JSON array, got ${typeof data}`,
      ],
    };
  }

  const warnings: string[] = [];
  const origins: string[] = [];
  const seen = new Set<string>();
  data.forEach((entry, index) => {
    const { origin, warning } = normalizeOrigin(entry);
    if (warning) {
      warnings.push(`control UI origins file ${path} entry ${index}: ${warning}`);
      return;
    }
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  });

  return { origins, warnings };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Merge `extras` into `defaults`: defaults first, de-duplicated, order preserved. */
export function mergeOrigins(defaults: string[], extras: string[]): string[] {
  const merged = [...defaults];
  const seen = new Set(merged);
  for (const origin of extras) {
    if (!seen.has(origin)) {
      seen.add(origin);
      merged.push(origin);
    }
  }
  return merged;
}

/** Load configured extra origins from the resolved path (env override or default). */
export function loadConfiguredOriginsFromEnv(): ConfiguredOrigins {
  return loadConfiguredOrigins(resolveOriginsPath());
}
