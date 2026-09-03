/**
 * Start a root install step and follow it to the end, line by line.
 *
 * The web server may start `install.sh --step <name>` as root only through the
 * launcher in root-step-runner.ts, and `--no-block` returns before the unit has
 * done anything. What a route that wants to SHOW the install needs is the rest:
 * poll systemd for the unit's state, tail its journal for the last line, and
 * say whether it ended well. The llama.cpp install route carries this loop
 * inline; this is the same loop for the next caller (the on-device voice).
 *
 * SERVER ONLY: runs systemctl and journalctl.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { startRootStep } from "@/lib/root-step-runner";

const execFile = promisify(execFileCb);

const SYSTEMCTL_QUERY_TIMEOUT_MS = 15_000;
const POLL_MS = 3000;
/** `systemctl start --no-block` returns before the unit leaves "inactive". */
const START_GRACE_MS = 1000;
const START_GRACE_POLLS = 2;

export interface FollowRootStepOptions {
  /** How long the whole step may take before it is reported as timed out. */
  timeoutMs: number;
  /** Every new last line of the unit's journal, as it appears. */
  onStatus: (line: string) => void;
  /** What to call the step in the messages nobody else wrote. */
  label: string;
}

export function rootStepUnit(step: string): string {
  return `clawbox-root-update@${step}.service`;
}

async function unitState(unit: string): Promise<{ active: string; result: string }> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", unit, "-p", "ActiveState", "-p", "Result"],
      { timeout: SYSTEMCTL_QUERY_TIMEOUT_MS },
    );
    return {
      active: /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
      result: /^Result=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
    };
  } catch {
    return { active: "", result: "" };
  }
}

async function lastJournalLine(unit: string, lines: number): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", unit, "-n", String(lines), "--no-pager", "-o", "cat"],
      { timeout: 10_000 },
    );
    const all = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return all.length > 0 ? all[all.length - 1] : null;
  } catch {
    return null;
  }
}

function running(active: string): boolean {
  return active === "activating" || active === "active" || active === "reloading";
}

export async function followRootStep(step: string, opts: FollowRootStepOptions): Promise<{ ok: boolean; error?: string }> {
  const unit = rootStepUnit(step);
  try {
    await startRootStep(step, { noBlock: true, timeoutMs: SYSTEMCTL_QUERY_TIMEOUT_MS });
  } catch (err) {
    const line = await lastJournalLine(unit, 40);
    return { ok: false, error: line || (err instanceof Error ? err.message : `Could not start ${opts.label}.`) };
  }

  const deadline = Date.now() + opts.timeoutMs;
  let lastLine: string | null = null;
  let sawRunning = false;
  let gracePolls = 0;

  while (Date.now() < deadline) {
    const { active, result } = await unitState(unit);
    if (running(active)) sawRunning = true;

    const line = await lastJournalLine(unit, 5);
    if (line && line !== lastLine) {
      lastLine = line;
      opts.onStatus(line);
    }

    if (active === "failed") {
      return { ok: false, error: lastLine || `${opts.label} failed (${result || "unknown"})` };
    }

    if (!running(active)) {
      if (sawRunning || gracePolls >= START_GRACE_POLLS) {
        if (result && result !== "success") {
          return { ok: false, error: lastLine || `${opts.label} failed (${result})` };
        }
        return { ok: true };
      }
      gracePolls += 1;
      await new Promise((resolve) => setTimeout(resolve, START_GRACE_MS));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return { ok: false, error: lastLine || `Timed out waiting for ${opts.label}.` };
}
