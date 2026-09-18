/**
 * The box's NAMED Cloudflare tunnel — the credential the portal hands out and
 * the files scripts/run-tunnel.sh reads.
 *
 * A quick tunnel mints a random `*.trycloudflare.com` on every start. Once the
 * portal has provisioned this box, its heartbeat answer carries
 * `boxTunnel: { hostname, token? }`: a stable `<boxHandle>.clawbox.tech` and a
 * `cloudflared tunnel run` token for it. The token is a credential — whoever
 * holds it can serve ANY content under the box's hostname — so it lives in one
 * owner-only file here, written tmp+rename like the box's other secrets, and is
 * never returned by a route, logged, or written to `tunnel.url`/`tunnel-url.log`.
 *
 * Files under data/cloudflared/:
 *   named-tunnel     `hostname=<host>\ntoken=<token>\n`, 0600. Parsed line by
 *                    line (never sourced) by run-tunnel.sh; a file missing
 *                    either line is no credential at all.
 *   tunnel.mode      `named` | `quick` — which tunnel run-tunnel.sh actually
 *                    started. Written by the script only.
 *   named-refused    sha256 of a token cloudflared refused (the script writes
 *                    it when it deletes the credential), so the heartbeat does
 *                    not store the same dead token again and bounce the tunnel
 *                    every five minutes.
 *
 * Kept free of heavy imports: src/lib/host-allowlist.ts (middleware) reads the
 * hostname through `readNamedTunnelHostnameSync`.
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/** The only zone a box hostname may live in: first-level labels of it. */
export const BOX_TUNNEL_DOMAIN = "clawbox.tech";

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Cloudflare run tokens are base64 of a small JSON document. Anything outside
 * the base64/base64url alphabet — a newline above all — is refused rather than
 * written into a line-oriented file a shell script parses.
 */
const TOKEN_RE = /^[A-Za-z0-9+/_=-]{32,4096}$/;

export type TunnelMode = "named" | "quick";

export interface NamedTunnelCredential {
  hostname: string;
  token: string;
}

function cloudflaredDir(): string {
  const root = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
  return path.join(root, "data", "cloudflared");
}

/** Resolved per call so a test (or a moved install) is followed. */
export function namedTunnelCredentialPath(): string {
  return process.env.CLAWBOX_NAMED_TUNNEL_FILE || path.join(cloudflaredDir(), "named-tunnel");
}

export function tunnelModePath(): string {
  return path.join(cloudflaredDir(), "tunnel.mode");
}

export function namedRefusedPath(): string {
  return path.join(cloudflaredDir(), "named-refused");
}

/** `<label>.clawbox.tech`, exactly one label, lower case. */
export function isBoxTunnelHostname(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const suffix = `.${BOX_TUNNEL_DOMAIN}`;
  if (!value.endsWith(suffix)) return false;
  return LABEL_RE.test(value.slice(0, -suffix.length));
}

export function isValidTunnelToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function parseCredential(raw: string): NamedTunnelCredential | null {
  let hostname: string | null = null;
  let token: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("hostname=")) hostname = line.slice("hostname=".length).trim();
    else if (line.startsWith("token=")) token = line.slice("token=".length).trim();
  }
  if (!isBoxTunnelHostname(hostname) || !isValidTunnelToken(token)) return null;
  return { hostname, token };
}

export async function readNamedTunnelCredential(): Promise<NamedTunnelCredential | null> {
  try {
    return parseCredential(await fsp.readFile(namedTunnelCredentialPath(), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The hostname alone, synchronously — for the Host allow-list, which runs in
 * front of every request. Cached by the file's identity so a request costs one
 * stat, and the token never leaves this function.
 */
let hostnameCache: { signature: string; hostname: string | null } | null = null;

export function readNamedTunnelHostnameSync(): string | null {
  const file = namedTunnelCredentialPath();
  // One descriptor for both the identity and the bytes, so what is cached is
  // what was read — never a stat of one file and the contents of its successor.
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const signature = `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (hostnameCache?.signature === signature) return hostnameCache.hostname;
    let hostname: string | null = null;
    try {
      hostname = parseCredential(fs.readFileSync(fd, "utf-8"))?.hostname ?? null;
    } catch {
      hostname = null;
    }
    hostnameCache = { signature, hostname };
    return hostname;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Store a credential: 0600 temp file in the same directory, then rename, so a
 * reader (the tunnel script, the allow-list) sees the old file or the new one
 * and never half of either. Throws on an invalid hostname or token — nothing
 * that could not be parsed back is ever written.
 */
export async function writeNamedTunnelCredential(cred: NamedTunnelCredential): Promise<void> {
  if (!isBoxTunnelHostname(cred.hostname)) throw new Error("invalid box tunnel hostname");
  if (!isValidTunnelToken(cred.token)) throw new Error("invalid box tunnel token");
  const file = namedTunnelCredentialPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(tmp, `hostname=${cred.hostname}\ntoken=${cred.token}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    // The mode argument is filtered through the umask; say it outright.
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** True when a credential was on disk and is now gone. */
export async function clearNamedTunnelCredential(): Promise<boolean> {
  try {
    await fsp.unlink(namedTunnelCredentialPath());
    return true;
  } catch {
    return false;
  }
}

export async function readTunnelMode(): Promise<TunnelMode | null> {
  try {
    const raw = (await fsp.readFile(tunnelModePath(), "utf-8")).trim();
    return raw === "named" || raw === "quick" ? raw : null;
  } catch {
    return null;
  }
}

export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Did cloudflared already refuse exactly this token? */
export async function isRefusedToken(token: string): Promise<boolean> {
  try {
    const raw = (await fsp.readFile(namedRefusedPath(), "utf-8")).trim();
    return raw.split(/\s+/)[0] === tokenFingerprint(token);
  } catch {
    return false;
  }
}
