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
}

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
  return {
    active: properties.ActiveState === "active",
    // systemd 249 (Ubuntu 22.04) exposes rate limiting through the documented
    // service Result enum. This remains set after the unit enters failed.
    breakerActive: properties.Result === "start-limit-hit",
    activeState: properties.ActiveState || null,
    subState: properties.SubState || null,
    result: properties.Result || null,
    restartCount: Number.isFinite(restartCount) ? restartCount : null,
  };
}

function sanitizeJournalLine(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/(["']?(?:token|secret|credential)["']?\s*[:=]\s*["']?)[^\s,"'}]{8,}/gi, "$1[redacted]")
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

  return [
    "-u",
    GATEWAY_UNIT,
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
        "--property=ActiveState,SubState,Result,NRestarts,InvocationID",
        "--no-pager",
      ],
      { timeout: 3_000 },
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
            { timeout: 5_000, maxBuffer: 512 * 1024 },
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
    };
  }
}
