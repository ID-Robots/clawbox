/**
 * A coding run's share of the CPU — what keeps the desktop and the box's own
 * web server answering while a run builds and tests.
 *
 * WHY. A team of three workers once pushed the load average to 27 on a
 * 4-core/8-thread laptop: every worker ran `vitest` (which starts one worker
 * per logical CPU), `tsc` and a dev server at once, each sized for a machine it
 * had to itself. The desktop stopped repainting and the web server stopped
 * answering its own polls, which is what the owner sees as "the box hung".
 *
 * Two halves, because neither alone is enough:
 *
 *  - THE SCOPE asks the kernel to prefer everything else (`coding-run-unit.ts`:
 *    `CPUWeight`, `IOWeight`, `--nice`). A weight only matters under contention,
 *    so an idle box still gives a lone run every core it has.
 *  - THE BUDGET asks the run to start fewer processes in the first place: a
 *    number of parallel jobs, in the run's environment as
 *    `CLAWBOX_RUN_CPU_BUDGET` and in its brief, which tells it to pass the number
 *    to `--maxWorkers`, `-j` and the like. A weight cannot stop eight vitest
 *    workers per run from being runnable; this can.
 *
 * And on BATTERY a team runs one worker at a time (`teamWorkerCap`): three
 * builds at once is what drains a laptop in an hour and spins its fan for all
 * of it, and the owner who unplugged it did not ask for that.
 *
 * Pure apart from `onBatteryPower` and `hostCpuCount`, which read the box and
 * never throw.
 */
import os from "os";
import { readBattery, type BatteryStatus } from "./battery";

/** The environment variable every run is given its budget in. */
export const RUN_CPU_BUDGET_ENV = "CLAWBOX_RUN_CPU_BUDGET";

/** The largest budget a record may carry: a bound on a hand-edited file, not a figure any box reaches. */
export const MAX_CPU_BUDGET = 256;

/** The logical CPUs this box has, never below one. */
export function hostCpuCount(): number {
  try {
    const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Number.isInteger(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

export interface RunCpuBudgetInput {
  /** Logical CPUs on the box (`hostCpuCount()`). */
  cpus: number;
  /** How many runs share the budget at once: a team's parallel workers, 1 for a lone run. */
  concurrent?: number;
  /** Whether the box is running on its battery. */
  onBattery?: boolean;
}

/**
 * How many parallel jobs one run's builds and tests may use.
 *
 * HALF the logical CPUs, shared between the runs going at once, never below
 * one. Half, because the other half is the desktop's, the web server's and the
 * harness's own (Claude Code is a Node process with its own appetite), and
 * because on the SMT laptops this box runs on half the threads is the physical
 * cores — the parallelism a build actually gains from. A quarter on battery.
 */
export function runCpuBudget({ cpus, concurrent = 1, onBattery = false }: RunCpuBudgetInput): number {
  const total = Number.isFinite(cpus) && cpus >= 1 ? Math.floor(cpus) : 1;
  const share = Number.isFinite(concurrent) && concurrent >= 1 ? Math.floor(concurrent) : 1;
  const pool = Math.max(1, Math.floor(total / (onBattery ? 4 : 2)));
  return Math.min(MAX_CPU_BUDGET, Math.max(1, Math.floor(pool / share)));
}

/**
 * Is the box running on its battery?
 *
 * The laptop's charger as sysfs reports it (`battery.ts`, the tray indicator's
 * reader): a Mains or USB supply whose `online` is 0. When no supply reports
 * `online` at all, a discharging battery decides. A box with no battery —
 * every Jetson, every desktop PC — is never on battery, and neither is one this
 * cannot read: the cost of a wrong "yes" is a team that runs slower, the cost
 * of a throw is a team that does not run.
 */
export function isOnBattery(status: BatteryStatus): boolean {
  if (!status.available) return false;
  if (status.acOnline !== null) return !status.acOnline;
  return status.state === "discharging";
}

/** `isOnBattery` over the live sysfs reading. Never throws. */
export async function onBatteryPower(read: () => Promise<BatteryStatus> = readBattery): Promise<boolean> {
  try {
    return isOnBattery(await read());
  } catch {
    return false;
  }
}

/** How many of a team's workers may run at once: the team's own limit, or one on battery. */
export function teamWorkerCap(maxParallel: number, onBattery: boolean): number {
  const cap = Number.isFinite(maxParallel) && maxParallel >= 1 ? Math.floor(maxParallel) : 1;
  return onBattery ? 1 : cap;
}

/**
 * The paragraph of a run's brief that hands it the budget.
 *
 * Names the commonest runners by their own flag, because "cap your
 * parallelism" alone is advice a model nods at and then runs `vitest` bare.
 */
export function cpuBudgetBrief(budget: number): string {
  const n = Math.max(1, Math.floor(budget));
  return [
    `CPU budget: ${n} parallel job${n === 1 ? "" : "s"} (also in $${RUN_CPU_BUDGET_ENV}).`,
    "This box shares its CPU with the owner's desktop and its own web server, and other runs may be working beside you.",
    `Cap every test runner and build to the budget: vitest \`--maxWorkers=${n}\`, jest \`--maxWorkers=${n}\`, \`make -j${n}\`, \`cargo build -j ${n}\`, pytest-xdist \`-n ${n}\`, \`go test -p ${n}\`.`,
    "Run one heavy command at a time — never a build, a test suite and a type check in parallel — and stop any dev server or watcher you started once you are done with it.",
  ].join(" ");
}
