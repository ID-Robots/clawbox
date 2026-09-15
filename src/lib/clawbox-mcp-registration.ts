import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

import { resolveConfigRoot } from "@/lib/config-store";
import { readEdition } from "@/lib/edition-source";
import { patchHermesConfig, resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { MCP_RELOAD_ASKED, reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";
import { ensureHermesGateway, readHermesGatewayStatus } from "@/lib/hermes-telegram";
import { isPlainObject, readConfigStrict, restartGateway, writeConfig } from "@/lib/openclaw-config";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";

const execFileAsync = promisify(execFile);

/**
 * The ClawBox MCP server's REGISTRATION with each harness — the config entry
 * that makes the harness spawn it — read and changed from the web server.
 *
 * The switch itself is one key in the config store (`clawbox-mcp-switch.ts`);
 * this module is what makes the key TRUE ON THE BOX right now rather than at
 * the next boot. Two harnesses, two files, two mechanisms:
 *
 *   OpenClaw — `mcp.servers.clawbox` in openclaw.json. OFF removes the entry
 *   with the module's own read-strict/write pattern (`clearSkillEntry`'s), and
 *   ON writes nothing here at all: `scripts/gateway-pre-start.sh` is the
 *   gateway's ExecStartPre and reconciles the entry from the switch, so a
 *   restart IS the registration. Either way the gateway is restarted, because
 *   it spawns the MCP server per session from the config it started with.
 *
 *   Hermes — `mcp_servers.clawbox` in `~/.hermes/config.yaml`. OFF removes it
 *   through the comment-preserving writer every Settings toggle uses; ON runs
 *   `scripts/register-mcp.sh` the way `production-server.js` does at boot,
 *   which reads the switch and writes the entry. Then Hermes' own `reload.mcp`
 *   makes the dashboard's agent respawn its MCP children from the file — the
 *   mechanism `harness/select` and the other refresh families use — and a
 *   messaging gateway that is up is restarted so a Telegram turn loses (or
 *   gains) the tools too; one that is not up is left down.
 *
 * Every half is attempted even when the other failed: the store already says
 * what the owner wants, both boot scripts honour it, and a harness that could
 * be told now should be. The FIRST failure is what the route reports.
 */

export interface McpRegistrationState {
  /** Whether openclaw.json lists the server; null = no OpenClaw on this edition, or the file could not be read. */
  openclaw: boolean | null;
  /** Whether config.yaml lists the server; null = no Hermes on this edition, or the file could not be read. */
  hermes: boolean | null;
}

export interface McpSwitchFailure {
  code:
    | "openclaw_config_unreadable"
    | "openclaw_unregister_failed"
    | "gateway_restart_failed"
    | "hermes_unregister_failed"
    | "hermes_register_failed";
  message: string;
}

export interface McpSwitchApplyResult {
  /** null when this edition does not run OpenClaw. */
  openclaw: { restarted: boolean } | null;
  /**
   * null when this edition does not run Hermes. `reloaded` is the dashboard's
   * answer to `reload.mcp`; `gatewayRestarted` is the messaging gateway's —
   * null when none was running, so there was nothing to restart.
   */
  hermes: { reloaded: boolean; gatewayRestarted: boolean | null } | null;
  /** The first thing that went wrong, or null when every half landed. */
  error: McpSwitchFailure | null;
}

const OPENCLAW_SERVER_ID = "clawbox";
const HERMES_SERVER_KEY = "mcp_servers.clawbox";
const REGISTER_SCRIPT = path.join("scripts", "register-mcp.sh");
/**
 * The script runs `hermes plugins doctor` and two `hermes` CLI calls, each with
 * a 45 s ceiling of its own, so the whole run can honestly take a couple of
 * minutes on a loaded Orin. Bounded all the same: a route handler must not hold
 * a child for as long as the box is up.
 */
const REGISTER_SCRIPT_TIMEOUT_MS = 180_000;

/** Which harnesses THIS edition runs, from one read of the lock. */
function harnessesHere(): { openclaw: boolean; hermes: boolean } {
  const edition = readEdition();
  return { openclaw: edition !== "hermes", hermes: edition === "hermes" || edition === "dual" };
}

function openclawEntryPresent(config: Record<string, unknown>): boolean {
  const mcp = config.mcp;
  const servers = isPlainObject(mcp) ? mcp.servers : undefined;
  return isPlainObject(servers) && Object.prototype.hasOwnProperty.call(servers, OPENCLAW_SERVER_ID);
}

/** What each harness's config says right now. Never throws. */
export async function readClawboxMcpRegistration(): Promise<McpRegistrationState> {
  const here = harnessesHere();
  const [openclaw, hermes] = await Promise.all([
    here.openclaw ? readOpenclawRegistered() : Promise.resolve(null),
    here.hermes ? readHermesRegistered() : Promise.resolve(null),
  ]);
  return { openclaw, hermes };
}

async function readOpenclawRegistered(): Promise<boolean | null> {
  try {
    // STRICT: an EACCES or a half-written file is "could not look", never "not
    // registered" — the panel would otherwise draw a box that has lost its
    // tools over one that merely could not be read.
    return openclawEntryPresent(await readConfigStrict());
  } catch (err) {
    console.error("[clawbox-mcp] openclaw.json could not be read:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function readHermesRegistered(): Promise<boolean | null> {
  const read = await resolveHermesConfigValue(HERMES_SERVER_KEY);
  // A registered entry is a nested block, which the line reader reports as
  // "present"; a scalar there would be a hand-edit and is still a key.
  if (read.state === "present" || read.state === "value") return true;
  if (read.state === "absent") return false;
  return null;
}

/**
 * Make the switch true on every harness this edition runs, and say what
 * happened. Never throws: the failure travels on the result.
 */
export async function applyClawboxMcpSwitch(enabled: boolean): Promise<McpSwitchApplyResult> {
  const here = harnessesHere();
  const result: McpSwitchApplyResult = { openclaw: null, hermes: null, error: null };
  const fail = (code: McpSwitchFailure["code"], message: string) => {
    if (!result.error) result.error = { code, message };
  };

  if (here.openclaw) {
    result.openclaw = await applyOpenclaw(enabled, fail);
  }
  if (here.hermes) {
    result.hermes = await applyHermes(enabled, fail);
  }
  return result;
}

async function applyOpenclaw(
  enabled: boolean,
  fail: (code: McpSwitchFailure["code"], message: string) => void,
): Promise<{ restarted: boolean }> {
  if (!enabled) {
    let config: Record<string, unknown>;
    try {
      config = await readConfigStrict();
    } catch (err) {
      // Nothing touched: a read that failed must not become a write over a
      // config this process never saw.
      console.error("[clawbox-mcp] openclaw.json could not be read for the unregister:", err instanceof Error ? err.message : err);
      fail("openclaw_config_unreadable", "OpenClaw's config could not be read, so the tools were not removed from it. The switch is saved and the next gateway start honours it.");
      return { restarted: false };
    }
    if (openclawEntryPresent(config)) {
      try {
        delete (config.mcp as Record<string, unknown> & { servers: Record<string, unknown> }).servers[OPENCLAW_SERVER_ID];
        await writeConfig(config);
      } catch (err) {
        console.error("[clawbox-mcp] openclaw.json could not be written:", err instanceof Error ? err.message : err);
        fail("openclaw_unregister_failed", "OpenClaw's config could not be written, so the tools were not removed from it. The switch is saved and the next gateway start honours it.");
        return { restarted: false };
      }
    }
  }
  // ON writes nothing: the gateway's own pre-start reconciles the entry from
  // the switch, so the restart is the registration. OFF restarts too, because
  // a running gateway spawns the MCP server from the config it started with.
  try {
    await restartGateway();
    return { restarted: true };
  } catch (err) {
    console.error("[clawbox-mcp] gateway restart failed:", err instanceof Error ? err.message : err);
    fail("gateway_restart_failed", "The switch is saved, but the assistant's gateway did not come back after the restart. Check the ClawBox service log.");
    return { restarted: false };
  }
}

async function applyHermes(
  enabled: boolean,
  fail: (code: McpSwitchFailure["code"], message: string) => void,
): Promise<{ reloaded: boolean; gatewayRestarted: boolean | null }> {
  if (enabled) {
    const root = resolveConfigRoot();
    try {
      // The same script, the same way `production-server.js` runs it at boot;
      // it reads the switch itself and writes the entry. `CLAWBOX_ROOT` named
      // explicitly, because the script defaults it to the installed checkout
      // and this process may be running from another.
      const { stdout, stderr } = await execFileAsync("/bin/bash", [path.join(root, REGISTER_SCRIPT)], {
        env: { ...process.env, CLAWBOX_ROOT: root, HOME: process.env.HOME || "/home/clawbox" },
        timeout: REGISTER_SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      for (const line of `${stdout}${stderr}`.split("\n")) {
        if (line.trim()) console.log(`[clawbox-mcp] ${line}`);
      }
    } catch (err) {
      console.error("[clawbox-mcp] register-mcp.sh failed:", err instanceof Error ? err.message : err);
      fail(
        "hermes_register_failed",
        sanitizeErrorMessage(err instanceof Error ? err.message : "")
          || "The switch is saved, but Hermes' config could not be written. Check the ClawBox service log.",
      );
      return { reloaded: false, gatewayRestarted: null };
    }
  } else {
    try {
      await patchHermesConfig({ unset: [HERMES_SERVER_KEY] });
    } catch (err) {
      console.error("[clawbox-mcp] config.yaml could not be written:", err instanceof Error ? err.message : err);
      fail(
        "hermes_unregister_failed",
        sanitizeErrorMessage(err instanceof Error ? err.message : "")
          || "The switch is saved, but Hermes' config could not be written. Check the ClawBox service log.",
      );
      return { reloaded: false, gatewayRestarted: null };
    }
  }

  const what = `the ClawBox MCP server was switched ${enabled ? "on" : "off"}`;
  // Best-effort, like every refresh family: the file already says what the
  // owner wants, and a dashboard that cannot be asked catches up at its next
  // start. `.catch` because the promise here is to the OWNER'S SWITCH, which is
  // already on disk.
  const reloaded = await reloadMcpServers().catch(() => false);
  if (reloaded) console.log(`[clawbox-mcp] ${what}; ${MCP_RELOAD_ASKED}`);
  else await reportMcpReloadRefused("clawbox-mcp", what, "the dashboard's agent re-reads the config when it next starts");

  return { reloaded, gatewayRestarted: await restartHermesGatewayIfRunning() };
}

/**
 * Restart Hermes' messaging gateway ONLY if one is already up, so a Telegram
 * turn follows the switch too. Never installs one — a box that never had a
 * gateway must not get one started because a switch was flipped — and leaves
 * a foreground `hermes gateway run` alone, the way `stopHermesEmailPolling`
 * does and for its reasons. Best-effort: null when nothing was running.
 */
async function restartHermesGatewayIfRunning(): Promise<boolean | null> {
  try {
    const { value: before, answered } = await readHermesGatewayStatus();
    if (!answered) return false;
    if (!before.running) return null;
    if (!before.installed) return false;
    const after = await ensureHermesGateway();
    return after.applied;
  } catch (err) {
    console.error("[clawbox-mcp] Hermes gateway restart failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
