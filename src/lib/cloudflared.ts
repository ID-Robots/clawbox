import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { DATA_DIR } from "./config-store";

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || "/usr/local/bin/cloudflared";
export const CLOUDFLARED_DIR = path.join(DATA_DIR, "cloudflared");
export const TUNNEL_URL_FILE = path.join(CLOUDFLARED_DIR, "tunnel.url");
/**
 * Append-only record of every URL the tunnel has published, written by
 * scripts/run-tunnel.sh as `<iso8601> <url>` lines, newest last.
 *
 * `tunnel.url` is erased on every stop, so it can only ever answer "what is the
 * URL right now". When a retired *.trycloudflare.com hostname was still serving
 * this box, nobody could say which URLs it had ever published — the journal was
 * volatile and there was no HTTP access log. This file is that record.
 */
export const TUNNEL_URL_LOG_FILE = path.join(CLOUDFLARED_DIR, "tunnel-url.log");
export const TUNNEL_SERVICE = "clawbox-tunnel.service";

/** Shape of a Cloudflare Quick Tunnel hostname — nothing else is ever returned. */
const TUNNEL_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i;

export async function isInstalled(): Promise<boolean> {
  try {
    await fs.access(CLOUDFLARED_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the currently-published *.trycloudflare.com URL, if any. */
export async function readTunnelUrl(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(TUNNEL_URL_FILE, "utf-8")).trim();
    if (!raw) return null;
    // Sanity-check the shape so we never return garbage.
    if (!TUNNEL_URL_PATTERN.test(raw)) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export interface TunnelUrlRecord {
  /** ISO-8601 UTC timestamp of when the URL was published. */
  at: string;
  url: string;
}

/**
 * Recent tunnel URLs, newest first. Missing or unparsable lines are skipped
 * rather than thrown — this is a diagnostic, and a half-written line must never
 * take the status endpoint down.
 */
export async function readTunnelUrlHistory(limit = 10): Promise<TunnelUrlRecord[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  let raw: string;
  try {
    raw = await fs.readFile(TUNNEL_URL_LOG_FILE, "utf-8");
  } catch {
    return [];
  }

  const records: TunnelUrlRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [at, url] = trimmed.split(/\s+/, 2);
    if (!at || !url) continue;
    if (!TUNNEL_URL_PATTERN.test(url)) continue;
    if (Number.isNaN(Date.parse(at))) continue;
    records.push({ at, url: url.replace(/\/+$/, "") });
  }

  return records.reverse().slice(0, limit);
}

/**
 * The URL the running tunnel published, recovered from the unit's journal.
 *
 * LAST RESORT, behind `tunnel.url` and `tunnel-url.log`. cloudflared announces
 * its quick-tunnel hostname once, on startup ("Your quick Tunnel has been
 * created! Visit it at ... https://<x>.trycloudflare.com"), and
 * scripts/run-tunnel.sh copies that into `tunnel.url`. If that file was never
 * written, or was truncated, or the unit was started by hand outside the
 * script, the journal is the only remaining record of a hostname that is at
 * that moment serving the whole device to the public internet — and answering
 * "remote access is off" in that state is the worst thing this API can do.
 *
 * Newest line wins: the unit restarts on failure and every restart publishes a
 * new hostname.
 */
export async function readTunnelUrlFromJournal(lines = 200): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "journalctl",
      ["-u", TUNNEL_SERVICE, "-n", String(lines), "--no-pager", "-o", "cat"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const found = stdout.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return found?.length ? found[found.length - 1].replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * What a start/stop actually achieved.
 *
 * Turning Remote Access on or off is TWO facts, not one: the unit's state right
 * now (`restart`/`stop`) and the same intent recorded for the next boot
 * (`enable`/`disable`). They are two systemctl calls because
 * config/clawbox-sudoers grants the plain verbs and no `--now` variant, so they
 * can and do fail independently.
 *
 * The second one used to be swallowed into a `console.warn` behind a `void`
 * return, which made "stopped" and "stopped until the next reboot puts it back"
 * the same answer to the caller — and the second is the one where the box keeps
 * serving itself to the public internet after the owner switched it off. The
 * first call still throws (nothing happened at all); the second is reported.
 */
export interface TunnelServiceResult {
  /** True when the change was also recorded for the next boot. */
  bootPersisted: boolean;
  /** Why it was not, in the owner's words — null when it was. */
  bootPersistWarning: string | null;
}

const START_PERSIST_WARNING =
  "Remote access is running, but this ClawBox could not be told to start it "
  + "again automatically — it will be off after the next reboot.";

const STOP_PERSIST_WARNING =
  "Remote access is stopped, but this ClawBox could not be told to keep it off "
  + "— it will start serving a public address again after the next reboot.";

/**
 * Run the boot-persistence call and say whether it worked.
 *
 * Never throws: the unit is already in the state the caller asked for by the
 * time this runs, and the caller decides what a failed persist means. It
 * REPORTS, though — that is the whole difference from the `.catch(warn)` this
 * replaces.
 *
 * Takes a THUNK rather than the verb, so the argv stays a literal at the call
 * site. sudo matches the argument list exactly and
 * scripts/check-sudoers-coverage.sh reads these statically; a `verb` parameter
 * makes both the grant and the check unresolvable.
 */
async function persistTunnelIntent(
  label: "enable" | "disable",
  run: () => Promise<unknown>,
  warning: string,
): Promise<TunnelServiceResult> {
  try {
    await run();
    return { bootPersisted: true, bootPersistWarning: null };
  } catch (err) {
    console.warn(`[cloudflared] ${label} failed:`, err instanceof Error ? err.message : err);
    return { bootPersisted: false, bootPersistWarning: warning };
  }
}

export async function startTunnelService(): Promise<TunnelServiceResult> {
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "restart", TUNNEL_SERVICE]);
  // Persist the user's intent across reboots — without `enable`, the next
  // power cycle would leave the box unreachable until they SSH in again,
  // which defeats the whole point of Remote Access.
  return persistTunnelIntent(
    "enable",
    () => execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "enable", TUNNEL_SERVICE]),
    START_PERSIST_WARNING,
  );
}

export async function stopTunnelService(): Promise<TunnelServiceResult> {
  await execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "stop", TUNNEL_SERVICE]);
  // Mirror image of startTunnelService — without `disable` the unit comes
  // back on the next reboot, silently overriding the user's stop intent.
  return persistTunnelIntent(
    "disable",
    () => execFileAsync("sudo", ["-n", "/usr/bin/systemctl", "disable", TUNNEL_SERVICE]),
    STOP_PERSIST_WARNING,
  );
}

export type TunnelUnitState = "active" | "inactive" | "failed" | "activating" | "unknown";

export async function getTunnelServiceState(): Promise<TunnelUnitState> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", TUNNEL_SERVICE]);
    const state = stdout.trim();
    if (state === "active" || state === "inactive" || state === "failed" || state === "activating") {
      return state;
    }
    return "unknown";
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout?.trim();
    if (stdout === "inactive" || stdout === "failed" || stdout === "activating") {
      return stdout;
    }
    return "unknown";
  }
}
