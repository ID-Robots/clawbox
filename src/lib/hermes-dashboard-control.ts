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
 * One `systemctl show`, parsed BY NAME.
 *
 * `systemctl show` prints the properties it was asked for in SYSTEMD's own
 * order, not the order of the request (reproduced: `-p SubState -p ActiveState
 * --value` prints ActiveState first), so reading `--value` output by position is
 * correct only by luck and misassigns every field the moment a property is added
 * or the list is reordered. `Key=Value` costs one split and cannot be got wrong.
 *
 * NEVER THROWS: a missing systemctl, a timeout, anything — the callers below
 * both have a safe answer for "no properties at all", and neither may be handed
 * a guess dressed as a fact.
 *
 * It is a READ, so it needs no privilege — which is the whole point of this
 * module.
 */
async function showUnit(properties: readonly string[]): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", HERMES_DASHBOARD_UNIT, `--property=${properties.join(",")}`],
    { timeout: SYSTEMCTL_TIMEOUT_MS },
  ).catch(() => ({ stdout: "" }));
  const props: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return props;
}

/**
 * Will systemd bring the dashboard back by itself?
 *
 * ASKED, NEVER ASSUMED, because the answer decides whether stopping the box's
 * chat backend is a bounce or an outage. The shipped unit is `Restart=always`;
 * on a box where it is not (a dev checkout running the dashboard by hand, an
 * older unit file) the same call would leave the owner with no chat at all. No
 * systemd, no unit, and a failed query all answer the same way, and that answer
 * is the one that keeps the dashboard up.
 */
async function restartsItself(): Promise<boolean> {
  const props = await showUnit(["Restart"]);
  return props.Restart === "always";
}

/**
 * Is the dashboard coming up, up, or not coming at all — asked of systemd,
 * which is the thing that actually knows.
 *
 * WHAT SYSTEMD ACTUALLY CONTRIBUTES HERE, measured against the shipped unit
 * rather than assumed. `config/clawbox-hermes-dashboard.service` is
 * `Type=simple`, so systemd marks the service `active/running` the instant
 * `ExecStart` is FORKED — not when it binds :9119. The ~11-12 s the panel
 * actually waits on is therefore spent in `running`, and only a clock beside it
 * can bound that. What systemd adds are the states a clock cannot tell apart:
 *   - `starting` — the unit is in `ExecStartPre` (two of them here, one of which
 *     re-provisions dashboard auth), which can outlast any wall-clock grace on a
 *     loaded box and is bounded by the unit's own `TimeoutStartSec`;
 *   - `restarting` — it has already run and DIED, and `Restart=always` will try
 *     again in `RestartSec`. That is both this app's own dashboard bounce and a
 *     crash loop; one sample cannot tell them apart, so the caller gives it the
 *     short clock rather than either lie;
 *   - `down` — `failed`, masked, or stopped and disabled, where nothing is
 *     coming and saying "still starting" for one more second is a lie.
 *
 * NEVER THROWS, and "unknown" is a real answer meaning THIS CANNOT BE ASKED:
 * no systemd, a query that failed, a unit systemd has never heard of, or a unit
 * caught mid-transition. The caller falls back to its own clock rather than
 * being handed a guess.
 */
export type HermesDashboardUnitState =
  | "starting"
  | "restarting"
  | "running"
  | "down"
  | "unknown";

/** The properties the state read needs, asked for by name and parsed by name. */
const UNIT_PROPERTIES = ["LoadState", "ActiveState", "SubState"] as const;

/**
 * Deliberately NOT memoised HERE. The one caller memoises instead
 * (`probeStillOwed` in `hermes-model-options`), because it is the caller that
 * knows how stale an answer may be for its own question — and it is the caller
 * whose two panels poll it several times a second while a box is booting.
 */
export async function hermesDashboardUnitState(): Promise<HermesDashboardUnitState> {
  const props = await showUnit(UNIT_PROPERTIES);
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
    // `auto-restart` is the gap between runs of a `Restart=always` unit — the
    // process has already died and systemd is waiting out `RestartSec` before
    // trying again. It is NOT a start (calling it one is how a dashboard
    // crash-looping since boot read as "Checking..." for as long as anyone
    // watched it), and it is NOT "nothing is coming" either: it is where this
    // app's own `bounceHermesDashboard` parks for the whole RestartSec=5, and
    // degrading there flashes the red banner over a restart the owner asked for.
    if (unit.subState === "auto-restart") return "restarting";
    // `start-pre`, `start`, `start-post`: genuinely on its way, and bounded by
    // the unit's own TimeoutStartSec — which the caller's budget is tied to.
    return "starting";
  }
  if (unit.activeState === "reloading") return "starting";
  // `Type=simple`: `active` the instant ExecStart forks, socket or no socket.
  // The bind window is the caller's clock, not systemd's fact.
  if (unit.activeState === "active") return "running";
  // Mid-transition — including the SIGTERM grace of the bounce above. We cannot
  // tell yet, which is what `unknown` means.
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
