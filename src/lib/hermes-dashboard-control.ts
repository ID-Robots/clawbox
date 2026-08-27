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
