import { execFile } from "child_process";
import { promisify } from "util";
import { runHermesCli } from "@/lib/hermes-cli";
import { HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";

const execFileAsync = promisify(execFile);

/**
 * Restarting the Hermes dashboard WITHOUT root.
 *
 * WHY THIS IS NOT `sudo systemctl restart`. There is deliberately no sudoers
 * grant over any Hermes unit, and the reason is not caution about restarts:
 * `systemctl restart` STARTS a stopped unit, so such a grant would let a
 * customer on an OPENCLAW box resurrect the Hermes dashboard that the
 * foreign-edition teardown had just stopped and disabled.
 * `install-foreign-edition-teardown.test.ts` guards that invariant.
 *
 * So this asks for the one thing that is not privileged and not a resurrection:
 * STOP the process. `hermes dashboard --stop` is upstream's own
 * SIGTERM-grace-SIGKILL path — the unit runs it as its own `ExecStartPre` — and
 * the unit's `Restart=always` turns the stop into a restart. A unit that is
 * stopped and disabled stays that way, because there is no running process to
 * stop and nothing to trigger. The capability and the invariant are both kept.
 *
 * WHY ANYONE WANTS IT. The dashboard is the process that serves chat, and it
 * reads several things exactly once, when it starts: `~/.hermes/.env`, the
 * plugin directories, and the state database. A change made underneath it —
 * a restored backup, an image backend installed by linking ClawBox AI — is
 * invisible to it until it comes back.
 */

/** How long the systemd query and the stop may take. Both are local. */
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;

/**
 * Will systemd bring the dashboard back by itself?
 *
 * ASKED, NEVER ASSUMED, because the answer decides whether stopping the box's
 * chat backend is a bounce or an outage. The shipped unit is `Restart=always`;
 * on a box where it is not (a dev checkout running the dashboard by hand, an
 * older unit file) the same call would leave the owner with no chat at all. No
 * systemd, no unit, and a failed query all answer the same way, and that answer
 * is the one that keeps the dashboard up.
 *
 * `systemctl show` is a READ, so it needs no privilege — which is the whole
 * point of this module.
 */
async function restartsItself(): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", HERMES_DASHBOARD_UNIT, "--property=Restart", "--value"],
    { timeout: SYSTEMCTL_TIMEOUT_MS },
  ).catch(() => ({ stdout: "" }));
  return stdout.trim() === "always";
}

/**
 * Is the dashboard coming up, up, or not coming at all — asked of systemd,
 * which is the thing that actually knows.
 *
 * The unit is what starts the process, so its own state is the native answer to
 * "is this still booting?" — better than any clock we could run beside it. It
 * separates the two cases a wall-clock grace gets wrong in opposite directions:
 * a dashboard that legitimately takes longer than the usual ~11-12 s (a loaded
 * Jetson after a big update) is still `activating` and must not be called
 * broken, and a `failed` or masked unit is never coming back and must not be
 * called "still starting" for one more second.
 *
 * `systemctl show` is a READ and needs no privilege — the same call, on the
 * same unit, that {@link restartsItself} above already makes.
 *
 * NEVER THROWS, and "unknown" is a real answer: a dev checkout with no systemd,
 * no such unit, or a query that failed. The caller decides what to do without
 * it rather than being handed a guess dressed as a fact.
 */
export type HermesDashboardUnitState = "starting" | "running" | "down" | "unknown";

/**
 * Deliberately NOT memoised. The spawn is a local read of a few milliseconds
 * and its only caller asks solely while the dashboard is FAILING to answer —
 * never on a healthy box — so a cache would buy nothing and would hold a fact
 * whose whole value is being current.
 */
export async function hermesDashboardUnitState(): Promise<HermesDashboardUnitState> {
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", HERMES_DASHBOARD_UNIT, "--property=ActiveState", "--property=SubState", "--value"],
    { timeout: SYSTEMCTL_TIMEOUT_MS },
  ).catch(() => ({ stdout: "" }));
  // `--value` prints one line per requested property, in the order asked.
  const [activeState = "", subState = ""] = stdout.trim().split(/\r?\n/).map((line) => line.trim());
  return classifyUnitState(activeState, subState);
}

/** Exported for the test that pins the systemd vocabulary; not a caller's API. */
export function classifyUnitState(
  activeState: string,
  subState: string,
): HermesDashboardUnitState {
  // `activating` covers both the first start and `auto-restart`, the state a
  // `Restart=always` unit sits in between crashes — in both the process is on
  // its way, so an answer is genuinely still owed.
  if (activeState === "activating" || activeState === "reloading") return "starting";
  // A unit can be `active` while its ExecStartPre is still running.
  if (activeState === "active") return subState === "start-pre" ? "starting" : "running";
  // `failed`, `inactive` (stopped, disabled or masked), `deactivating`: nothing
  // is going to answer. Note this is NOT "the box is broken" — an OpenClaw box
  // stops and disables this unit on purpose.
  if (activeState) return "down";
  // No systemd, no such unit, or the query failed.
  return "unknown";
}

/**
 * Stop the dashboard so systemd starts it again, or answer false without
 * touching it.
 *
 * NEVER THROWS. False means "this box was left exactly as it was" — either
 * because nothing promised to restart it, or because the stop did not take —
 * and every caller so far is in a position to say so and carry on.
 */
export async function bounceHermesDashboard(): Promise<boolean> {
  if (!(await restartsItself())) return false;
  const result = await runHermesCli(["dashboard", "--stop"], { timeoutMs: STOP_TIMEOUT_MS }).catch(
    () => null,
  );
  return result?.code === 0;
}
