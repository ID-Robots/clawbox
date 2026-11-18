/**
 * The hotspot switch, in one place (GitHub #1517).
 *
 * Two files used to answer "is the hotspot on?", and two routes wrote them
 * apart:
 *
 *  * `data/hotspot.env` — `HOTSPOT_SSID`, `HOTSPOT_PASSWORD`, and
 *    `HOTSPOT_DISABLED=1` when the owner switched the hotspot off. This is the
 *    file the radio obeys: start-ap.sh, ap-watchdog.sh and wifi-failover.sh
 *    parse it (as root, never `source`) and nothing else.
 *  * `data/config.json` — `hotspot_enabled`, `hotspot_ssid`,
 *    `hotspot_password`, which Settings showed.
 *
 * POST /setup-api/system/hotspot wrote both; POST /setup-api/wifi/connect
 * wrote only `hotspot_enabled: false`. A box that joined WiFi from Settings
 * therefore showed the switch OFF while every script read it as ON, and the AP
 * came back at the next boot on Ethernet, or as the failover's recovery.
 *
 * Now every write of the switch goes through {@link writeHotspotSettings} or
 * {@link setHotspotEnabled}, which write the env file first and then mirror
 * the same value into config. Once setup is complete, {@link readHotspotSettings}
 * reads the switch from the env file, the same source the scripts use. A box
 * that drifted before this fix shows the truth ("on") until its owner turns
 * the switch off, and that now sticks.
 *
 * Before setup the scripts ignore the flag at boot, and the wizard's own
 * hotspot step (CredentialsStep) writes both files when it is submitted. The
 * value the wizard shows before that is the default the WiFi step proposed in
 * config. So before setup the switch reads from config, exactly as it did:
 * first-boot setup is unchanged.
 */
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { get, getAll, setMany } from "@/lib/config-store";

export const DEFAULT_HOTSPOT_SSID = "ClawBox-Setup";

/** Where the scripts read it: `$CLAWBOX_ROOT/data/hotspot.env` (start-ap.sh's `$ROOT`). */
export function hotspotEnvPath(): string {
  return path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "hotspot.env");
}

export interface HotspotEnv {
  ssid: string | null;
  password: string | null;
  /** `HOTSPOT_DISABLED=1`: the switch is off, and start-ap.sh skips the AP after setup. */
  disabled: boolean;
}

/**
 * One `KEY=value` out of the file, read the way start-ap.sh's
 * `read_env_value` reads it: the first `KEY=` line (an optional `export`
 * prefix), a trailing CR dropped, one layer of matching quotes stripped.
 * Reading it any other way could disagree with the radio.
 */
function envValue(text: string, key: string): string | null {
  const line = text
    .split("\n")
    .find((l) => new RegExp(`^\\s*(export\\s+)?${key}=`).test(l));
  if (line === undefined) return null;
  let value = line.slice(line.indexOf("=") + 1).replace(/\r$/, "");
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value;
}

export function parseHotspotEnv(text: string): HotspotEnv {
  return {
    ssid: envValue(text, "HOTSPOT_SSID") || null,
    password: envValue(text, "HOTSPOT_PASSWORD") || null,
    disabled: envValue(text, "HOTSPOT_DISABLED") === "1",
  };
}

/**
 * The env file as the scripts see it, or `null` when they would see none: no
 * file, a symlink (the scripts refuse one), or unreadable. All of those mean
 * "not disabled" to the scripts, the direction that keeps a box reachable.
 */
export async function readHotspotEnv(): Promise<HotspotEnv | null> {
  const file = hotspotEnvPath();
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return null;
    return parseHotspotEnv(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Safely quote a value for a shell-style assignment. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function renderHotspotEnv(env: HotspotEnv): string {
  const lines: string[] = [];
  if (env.ssid) lines.push(`HOTSPOT_SSID=${shellQuote(env.ssid)}`);
  if (env.password) lines.push(`HOTSPOT_PASSWORD=${shellQuote(env.password)}`);
  if (env.disabled) lines.push("HOTSPOT_DISABLED=1");
  return lines.join("\n") + "\n";
}

/**
 * Temp file and rename, mode 0600 (it holds the WPA key). A reader never sees
 * a half-written file, and a symlink planted at the path is replaced, not
 * written through.
 */
async function writeHotspotEnv(env: HotspotEnv): Promise<void> {
  const file = hotspotEnvPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, renderHotspotEnv(env), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function setupComplete(): Promise<boolean> {
  return (await get("setup_complete")) === true;
}

export interface HotspotSettings {
  ssid: string;
  hasPassword: boolean;
  /** The switch: after setup, what the AP scripts obey. */
  enabled: boolean;
}

export async function readHotspotSettings(): Promise<HotspotSettings> {
  const config = await getAll();
  const env = await readHotspotEnv();
  const ssid = (typeof config.hotspot_ssid === "string" && config.hotspot_ssid) || env?.ssid || DEFAULT_HOTSPOT_SSID;
  const hasPassword = !!config.hotspot_password || !!env?.password;
  const enabled = config.setup_complete === true
    ? !env?.disabled
    : config.hotspot_enabled !== false;
  return { ssid, hasPassword, enabled };
}

/**
 * Save the whole hotspot (POST /setup-api/system/hotspot). `password`
 * undefined means "no password", so an open AP; the route resolves "keep the
 * stored one" before it calls this.
 */
export async function writeHotspotSettings(settings: {
  ssid: string;
  password: string | undefined;
  enabled: boolean;
}): Promise<void> {
  await writeHotspotEnv({
    ssid: settings.ssid,
    password: settings.password ?? null,
    disabled: !settings.enabled,
  });
  await setMany({
    hotspot_ssid: settings.ssid,
    hotspot_password: settings.password,
    hotspot_enabled: settings.enabled,
  });
}

/**
 * Flip the switch only, keeping the name and key the box already uses (the
 * env file's, which the radio uses; config's when the file has none).
 */
export async function setHotspotEnabled(enabled: boolean): Promise<void> {
  const config = await getAll();
  const env = await readHotspotEnv();
  const ssid = env?.ssid ?? (typeof config.hotspot_ssid === "string" && config.hotspot_ssid ? config.hotspot_ssid : null);
  const password = env?.password ?? (typeof config.hotspot_password === "string" && config.hotspot_password ? config.hotspot_password : null);
  await writeHotspotEnv({ ssid, password, disabled: !enabled });
  await setMany({ hotspot_enabled: enabled });
}

/**
 * The box has just joined a WiFi network as a client (POST
 * /setup-api/wifi/connect). On one radio that took the AP down, and the
 * hotspot is now switched off.
 *
 *  * After setup it is switched off for real ({@link setHotspotEnabled}). It
 *    stays off across a reboot on Ethernet and is not raised by the failover.
 *    Before #1517 only config said so, and start-ap.sh brought the AP back.
 *  * Before setup this only proposes "off" as the wizard hotspot step's
 *    default (config). That step writes the switch when it is submitted. An
 *    env-file flag here would stop ap-watchdog.sh and wifi-failover.sh from
 *    restoring the setup hotspot if this WiFi drops mid-wizard.
 *
 * Returns which of the two it did.
 */
export async function switchHotspotOffAfterWifiJoin(): Promise<"switched-off" | "proposed-off"> {
  if (await setupComplete()) {
    await setHotspotEnabled(false);
    return "switched-off";
  }
  await setMany({ hotspot_enabled: false });
  return "proposed-off";
}
