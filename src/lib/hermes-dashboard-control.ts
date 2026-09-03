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
 * WHAT SYSTEMD ACTUALLY CONTRIBUTES HERE, measured against the shipped unit
 * rather than assumed. `config/clawbox-hermes-dashboard.service` is
 * `Type=simple`, so systemd marks the service `active/running` the instant
 * `ExecStart` is FORKED — not when it binds :9119. The ~11-12 s the panel
 * actually waits on is therefore spent in `running`, and only the caller's
 * clock can bound that. What systemd adds are the two edges a clock gets wrong:
 *   - the unit is still in `ExecStartPre` (two of them here, one of which
 *     re-provisions dashboard auth), which can outlast any wall-clock grace on a
 *     loaded box and is bounded by the unit's own `TimeoutStartSec`;
 *   - the unit has already died — `failed`, masked, stopped, or crash-looping —
 *     and must not be called "still starting" for one more second.
 *
 * `systemctl show` is a READ and needs no privilege — the same call, on the
 * same unit, that {@link restartsItself} above already makes.
 *
 * NEVER THROWS, and "unknown" is a real answer meaning THIS CANNOT BE ASKED:
 * no systemd, a query that failed, a unit systemd has never heard of, or a unit
 * caught mid-transition. The caller falls back to its own clock rather than
 * being handed a guess dressed as a fact.
 */
export type HermesDashboardUnitState = "starting" | "running" | "down" | "unknown";

/** The properties this module reads, asked for by name and parsed by name. */
const UNIT_PROPERTIES = ["LoadState", "ActiveState", "SubState"] as const;

/**
 * Deliberately NOT memoised HERE. The one caller memoises instead
 * (`probeStillOwed` in `hermes-model-options`), because it is the caller that
 * knows how stale an answer may be for its own question — and it is the caller
 * whose two panels poll it several times a second while a box is booting.
 */
export async function hermesDashboardUnitState(): Promise<HermesDashboardUnitState> {
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", HERMES_DASHBOARD_UNIT, `--property=${UNIT_PROPERTIES.join(",")}`],
    { timeout: SYSTEMCTL_TIMEOUT_MS },
  ).catch(() => ({ stdout: "" }));
  // Parsed BY NAME. `systemctl show` prints properties in systemd's own order,
  // not the order they were asked for (reproduced: `-p SubState -p ActiveState
  // --value` prints ActiveState first), so a positional read of `--value` output
  // is correct only by luck and misassigns every field the moment a property is
  // added. `Key=Value` costs one split and cannot be got wrong.
  const props: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return classifyUnitState({
    loadState: props.LoadState ?? "",
    activeState: props.ActiveState ?? "",
    subState: props.SubState ?? "",
  });
}

/** Exported for the test that pins the systemd vocabulary; not a caller's API. */
export function classifyUnitState(unit: {
  loadState: string;
  activeState: string;
  subState: string;
}): HermesDashboardUnitState {
  // A unit systemd has never heard of answers `inactive`/`dead` with exit 0 —
  // reproduced, and indistinguishable on those two properties from a unit that
  // is installed and stopped. `LoadState` is the one that tells them apart, and
  // the difference matters most exactly where it is easiest to hit: a box
  // mid-update, between the unit-file replace and `daemon-reload`. "We cannot
  // ask" is not "nothing is coming".
  if (unit.loadState === "not-found") return "unknown";
  if (unit.activeState === "activating") {
    // `auto-restart` is the gap between crashes of a `Restart=always` unit — a
    // process that has already run and DIED, not one on its way up. The shipped
    // unit restarts every 5 s with no StartLimitBurst that can ever trip, so
    // calling this "starting" is a promise that nothing will keep: a dashboard
    // crash-looping since boot would read as "Checking..." for as long as anyone
    // watches it.
    if (unit.subState === "auto-restart") return "down";
    // `start-pre`, `start`, `start-post`: genuinely on its way, and bounded by
    // the unit's own TimeoutStartSec — which the caller's budget is tied to.
    return "starting";
  }
  if (unit.activeState === "reloading") return "starting";
  // `Type=simple`: `active` the instant ExecStart forks, socket or no socket.
  // The bind window is the caller's clock, not systemd's fact.
  if (unit.activeState === "active") return "running";
  // Mid-transition, and the transition this app itself causes: `bounceHermesDashboard`
  // stops the unit so `Restart=always` brings it back, and every poll landing in
  // the SIGTERM grace used to read `down` and flash the degraded banner over a
  // restart we asked for. We cannot tell yet — which is what `unknown` means.
  if (unit.activeState === "deactivating") return "unknown";
  // `failed`, `inactive` (stopped, disabled or masked): nothing is going to
  // answer. Note this is NOT "the box is broken" — an OpenClaw box stops and
  // disables this unit on purpose.
  if (unit.activeState) return "down";
  // No systemd, or the query produced nothing.
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
