import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const GATEWAY_UNIT = "clawbox-gateway.service";

export interface GatewayServiceHealth {
  active: boolean;
  breakerActive: boolean;
  activeState: string | null;
  subState: string | null;
  result: string | null;
  restartCount: number | null;
  finalStartupError: string | null;
  /**
   * systemd's own `LoadState` for the unit — "loaded" when there is a unit file
   * to start, "masked"/"not-found" when there is not.
   *
   * `null` means systemctl did not answer, which is not evidence either way.
   */
  loadState: string | null;
  /**
   * Whether systemd has a unit to start at all: `false` for masked and
   * not-found, `null` when the question could not be asked.
   *
   * Read off the DEVICE rather than inferred from the edition. The Hermes SKU
   * masks the unit to /dev/null (install.sh step_edition_gateway_state) and an
   * update or factory reset masks it on any SKU while it holds the lock — and
   * `systemctl restart` refuses a masked unit in both cases, so advice built on
   * a guessed edition would be wrong on the box whose lock file cannot be read.
   */
  unitLoaded: boolean | null;
}

/**
 * The properties `systemctl show` is asked for.
 *
 * Exported so the query and the parser cannot drift: a parser that reads a
 * property this list omits answers `undefined` forever, silently, and the
 * branch that depends on it never runs.
 */
export const GATEWAY_SHOW_PROPERTIES = [
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "NRestarts",
  "InvocationID",
] as const;

export function parseGatewaySystemctlProperties(output: string): Omit<GatewayServiceHealth, "finalStartupError"> {
  const properties: Record<string, string> = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf("=");
        return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  const restartCount = Number.parseInt(properties.NRestarts ?? "", 10);
  const loadState = properties.LoadState || null;
  return {
    active: properties.ActiveState === "active",
    // systemd 249 (Ubuntu 22.04) exposes rate limiting through the documented
    // service Result enum. This remains set after the unit enters failed.
    breakerActive: properties.Result === "start-limit-hit",
    activeState: properties.ActiveState || null,
    subState: properties.SubState || null,
    result: properties.Result || null,
    restartCount: Number.isFinite(restartCount) ? restartCount : null,
    loadState,
    // Only "loaded" is a unit systemd can act on. "masked" and "not-found" are
    // the two this device produces; every other LoadState ("error",
    // "bad-setting", "stub") is also a unit that will not start, so the test is
    // written as "loaded or nothing" rather than as a list of bad values.
    unitLoaded: loadState === null ? null : loadState === "loaded",
  };
}

function sanitizeJournalLine(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/(["']?(?:token|secret|credential|password|passwd|pwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]{6,}/gi, "$1[redacted]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9._-]{16,}\b/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

export function lastUsefulJournalLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^clawbox-gateway\.service: (Scheduled restart job|Main process exited|Failed with result|Start request repeated too quickly)/i.test(line))
    .filter((line) => !/^(Stopped|Started|Failed to start) ClawBox OpenClaw Gateway/i.test(line));
  const finalLine = lines.at(-1);
  return finalLine ? sanitizeJournalLine(finalLine) || null : null;
}

export function gatewayJournalArgs(systemctlOutput: string): string[] | null {
  const invocationId = /^InvocationID=([0-9a-f]{32})$/im.exec(systemctlOutput)?.[1];
  if (!invocationId) return null;

  // Scope strictly to the current failed activation. Combining `-u UNIT` with a
  // field match doesn't AND as intended (`-u` expands to OR match-groups), so
  // match on the invocation id alone — it's globally unique to this activation.
  return [
    `_SYSTEMD_INVOCATION_ID=${invocationId}`,
    "-n",
    "40",
    "--no-pager",
    "-o",
    "cat",
  ];
}

export async function getGatewayServiceHealth(): Promise<GatewayServiceHealth> {
  try {
    const { stdout } = await exec(
      "/usr/bin/systemctl",
      [
        "show",
        GATEWAY_UNIT,
        `--property=${GATEWAY_SHOW_PROPERTIES.join(",")}`,
        "--no-pager",
      ],
      { timeout: 2_000 },
    );
    const parsed = parseGatewaySystemctlProperties(stdout);
    const breakerActive = parsed.breakerActive;
    let finalStartupError: string | null = null;

    if (parsed.activeState === "failed" || breakerActive) {
      const journalArgs = gatewayJournalArgs(stdout);
      if (journalArgs) {
        try {
          const journal = await exec(
            "/usr/bin/journalctl",
            journalArgs,
            { timeout: 2_500, maxBuffer: 512 * 1024 },
          );
          finalStartupError = lastUsefulJournalLine(journal.stdout);
        } catch {
          // The state itself is still useful on restricted/container installs.
        }
      }
    }

    return {
      ...parsed,
      finalStartupError,
    };
  } catch {
    return {
      active: false,
      breakerActive: false,
      activeState: null,
      subState: null,
      result: null,
      restartCount: null,
      finalStartupError: null,
      loadState: null,
      // systemctl itself did not answer. Not knowing whether the unit exists is
      // not the same as knowing it does not, so the caller keeps its ordinary
      // "offline" page rather than claiming the gateway is not installed.
      unitLoaded: null,
    };
  }
}
