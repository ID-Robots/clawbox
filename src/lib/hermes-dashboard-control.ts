import { execFile } from "child_process";
import { promisify } from "util";
import { runHermesCli } from "@/lib/hermes-cli";
import { DASHBOARD_HOST, DASHBOARD_PORT, HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";
import { waitForPortOpen } from "@/lib/port-probe";

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
 * How long the replacement dashboard has to appear, and then to start serving.
 * One budget for both halves — they are the same restart.
 *
 * Covers `RestartSec=5` plus the unit's two ExecStartPre steps (a `hermes
 * dashboard --stop` CLI cold start and the auth provisioning) plus the process
 * binding its socket. The unit allows itself `TimeoutStartSec=300` because
 * `hermes dashboard` builds its web dist on a FIRST run; a bounce is always a
 * warm start, so 45 s is several times what one needs while leaving room under
 * the ceiling. Erring long in one direction only: the callers report a `false`
 * to the owner, and a healthy-but-slow dashboard called unrecovered would be
 * the same lie the other way round. Not longer than this, though —
 * `hermes-clawai` bounces inside a request that can reach the owner through
 * cloudflared, whose edge cuts a response at 100 s.
 */
const DASHBOARD_RESPAWN_WAIT_MS = 45_000;
/** Gap between systemd queries while waiting for the replacement process. */
const RESPAWN_POLL_MS = 500;
/** How long to wait before re-asking systemd for the baseline main pid. */
const BASELINE_RETRY_DELAY_MS = 250;

/**
 * Read per call so a box that needs longer — or a test that cannot spend 45 s
 * proving a dashboard never came back — can say so without a rebuild. Same
 * shape as the gateway's `gatewayReadyWaitMs()`.
 */
function respawnWaitMs(): number {
  // Guarded exactly as `waitForPortOpen` guards its own budget, and for the
  // same reason: the value comes from the environment, and a malformed one is
  // NaN. `Date.now() + NaN` is NaN, so every `remaining <= 0` below is false,
  // `Math.min(RESPAWN_POLL_MS, NaN)` is NaN, and `setTimeout(_, NaN)` clamps to
  // 1 ms — the replacement wait would never return and would fork a `systemctl
  // show` per iteration for the life of the process.
  const override = Number(process.env.HERMES_DASHBOARD_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : DASHBOARD_RESPAWN_WAIT_MS;
}

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
 * The PID systemd currently considers the unit's main process.
 *
 * THE IDENTITY OF THE PROCESS, which a socket cannot give. `Type=simple` means
 * :9119 says only "something is listening", and between our stop and
 * `RestartSec=5` there is no instant at which that distinguishes the dashboard
 * going away from the one coming back: probe early and the process we just
 * killed answers, wait for the port to close first and a fast respawn beats the
 * first probe. `MainPID` changes exactly once, when systemd starts the
 * replacement. Read through the same by-name `systemctl show` as every other
 * property here.
 *
 * TWO NULLS, AND THEY ARE NOT THE SAME ANSWER. `MainPID=0` is systemd saying
 * "no running main process" — a fact, and the state a stopped unit is in. A
 * MISSING property is systemd not having been asked successfully at all: no
 * systemctl, a timeout, a `show` that produced nothing. Folded together, the
 * second read as a valid baseline of "nothing was running", and the very next
 * pid — the process this bounce was supposed to stop — then satisfied
 * `waitForReplacement` and the bounce reported `restarted` over a dashboard it
 * had not replaced. So `read` is carried beside the value and the caller acts
 * on the difference.
 */
export interface MainPidRead {
  /** systemd answered the question at all. */
  read: boolean;
  /** The main pid, or null for a valid `MainPID=0`. */
  pid: number | null;
}

async function mainPid(): Promise<MainPidRead> {
  const raw = (await showUnit(["MainPID"])).MainPID;
  if (raw === undefined) return { read: false, pid: null };
  const value = Number(raw);
  // A property that is present but not a whole non-negative number is not an
  // answer either — the same "could not be asked" as an absent one.
  if (!Number.isInteger(value) || value < 0) return { read: false, pid: null };
  return { read: true, pid: value > 0 ? value : null };
}

/**
 * Read the baseline pid, with one retry: this single read decides what the
 * whole bounce is measured against, and a transient `systemctl show` failure
 * must not become a baseline. A second attempt costs one local read on a path
 * that is about to spend up to 45 s.
 */
async function readBaselinePid(): Promise<MainPidRead> {
  const first = await mainPid();
  if (first.read) return first;
  await new Promise((resolve) => setTimeout(resolve, BASELINE_RETRY_DELAY_MS));
  return await mainPid();
}

async function waitForReplacement(previousPid: number | null, deadline: number): Promise<boolean> {
  for (;;) {
    const current = await mainPid();
    // A read that FAILED establishes nothing: it is neither the replacement nor
    // proof there is none, so the wait simply continues.
    if (current.read && current.pid !== null && current.pid !== previousPid) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(RESPAWN_POLL_MS, remaining)));
  }
}

/**
 * What a bounce ended as.
 *
 * `"failed"` and `"pending"` are both "not serving yet", and they were one
 * answer until TASK-608 — which is how a ClawKeep restore came to tell the
 * owner a dashboard that is mid-restart could not be restarted, and to run
 * `systemctl restart` over it by hand. They are opposite instructions:
 *
 * - `"failed"` — nothing is coming back on its own and the owner has to act:
 *   either the restart was not taken, or systemd has stopped retrying it.
 * - `"pending"` — the stop took and `Restart=always` owns the unit, it has just
 *   not finished inside the budget. Nothing to do; acting makes it worse.
 */
export type HermesBounceOutcome = "restarted" | "pending" | "failed";

/**
 * Is the dashboard SERVING right now? One probe, no stop, no waiting.
 *
 * The question a caller has after a bounce came back `pending`: the stop took
 * and systemd owns the unit, so the thing to do is find out whether it has
 * finished coming up — never to stop it again, which would turn one outage into
 * two. `Type=simple` means the unit reads `active` the instant ExecStart forks,
 * so the SOCKET is the fact and the unit state is only good for telling "still
 * on its way" from "nothing is coming" (`hermesDashboardUnitState`).
 */
export async function hermesDashboardServing(): Promise<boolean> {
  // A non-positive budget is "one probe, then give up" — see `waitForPortOpen`.
  return await waitForPortOpen(DASHBOARD_PORT, DASHBOARD_HOST, { timeoutMs: 0 });
}

/**
 * WHICH PROCESS is serving the dashboard right now, for a caller that has to
 * tell a replacement from the process a bounce tried to stop.
 *
 * The same two nulls {@link MainPidRead} keeps apart, and for the same reason:
 * `pid: null` with `read: true` is systemd saying "no running main process",
 * while `read: false` is systemd not having been asked successfully at all.
 * A caller that folded them would read a failed `systemctl show` as proof the
 * old process had gone.
 */
export async function hermesDashboardMainPid(): Promise<MainPidRead> {
  return await mainPid();
}

/**
 * Stop the dashboard, wait for systemd to bring it back, and say which of the
 * three things happened.
 *
 * NEVER THROWS. `"restarted"` means the dashboard is SERVING again — not merely
 * that it was stopped. `Restart=always` is a promise that systemd will start
 * it, not that it came back, and both callers act on the answer: a ClawKeep
 * restore reports the restored state.db is being served, and the image refresh
 * reports the box can draw. Neither was true while the dashboard was still
 * down, and the old `true` was issued the moment the stop returned.
 *
 * Two questions, in order, because they answer different things: systemd says a
 * DIFFERENT process is now the unit's main one, and the socket says that
 * process is serving. Neither alone is the bounce.
 */
export async function bounceHermesDashboard(): Promise<HermesBounceOutcome> {
  if (!(await restartsItself())) return "failed";
  // Read BEFORE the stop: this is the process the answer is measured against.
  // NOTHING IS STOPPED UNTIL IT IS READ. Without a baseline this function
  // cannot tell the replacement from the process it killed, so it would stop
  // the owner's chat backend and then report `restarted` on the first pid it
  // saw — which is the outgoing one. Refusing before the stop leaves a working
  // dashboard working, and "failed" is the honest answer: nothing was done.
  const baseline = await readBaselinePid();
  if (!baseline.read) {
    console.error(
      `[hermes] ${HERMES_DASHBOARD_UNIT} was not stopped — systemd could not be asked which process is serving it`,
    );
    return "failed";
  }
  const outgoing = baseline.pid;
  await runHermesCli(["dashboard", "--stop"], { timeoutMs: STOP_TIMEOUT_MS }).catch(() => null);

  // THE STOP'S EXIT CODE IS NOT THE OUTCOME, and reading it as one was a false
  // failure on every bounce this box performs.
  //
  // MEASURED on the owner's Hermes device (2026-09-18): `hermes dashboard
  // --stop` exits **143** — SIGTERM, 128+15 — after 764 ms, printing
  // "Terminated", while stopping the dashboard perfectly well; the unit's
  // MainPID went 17768 → 17877 across that call. The CLI signals the process
  // group it is itself in, so it kills its own process on the way out. The old
  // `if (result?.code !== 0) return "failed"` therefore reported a failure over
  // a restart that had just happened, on EVERY caller of this helper: a ClawKeep
  // restore told the owner its restored state.db was not being served, the image
  // refresh told them the box could not draw, and the plugin watcher sent no
  // "open a new chat" notice for a chat window it had just dropped — then armed
  // a retry to do it again.
  //
  // So the stop is VERIFIED rather than believed, which this function already
  // knew how to do: the answer is systemd's NEW MainPID and a socket that
  // answers, and neither of those can be faked by an exit code. That is also why
  // no branch is lost — a stop that genuinely did not take is still caught, by
  // the `outgoing` comparison below rather than by the CLI's word for it.
  //
  // ONE deadline across both halves — the doc block above budgets them together
  // because they are the same restart, and spending it twice would put the
  // ceiling at 90 s inside a request cloudflared cuts at 100 s.
  // `waitForPortOpen` reads a non-positive budget as "one probe, then give up",
  // so the leftover needs no clamp here.
  const deadline = Date.now() + respawnWaitMs();
  if (!(await waitForReplacement(outgoing, deadline))) {
    // NO new main process at all, against `RestartSec=5`. The ordinary cause is
    // not slowness, it is that systemd has GIVEN UP: a unit that crash-looped
    // through `StartLimitBurst` refuses every restart for the rest of the
    // interval, and this module is unprivileged — it has no `reset-failed` to
    // clear that, unlike the OpenClaw path. So ask the one thing that tells the
    // two apart, using the state read this module already has: `down` is
    // `failed`, masked, or stopped, and none of them is coming back on its own.
    // Anything else — still activating, in the RestartSec gap, or a state that
    // cannot be read — keeps the answer that tells the owner to leave it alone.
    // One local read, bounded by SYSTEMCTL_TIMEOUT_MS, on the path that has
    // already spent the whole budget: the ceiling moves 45 s → 50 s, still far
    // inside the 100 s edge cut the budget above is sized against.
    const state = await hermesDashboardUnitState();
    // THE STOP NEVER TOOK — the branch the exit-code check used to cover, now
    // asked of the thing that knows. The very same process is still the unit's
    // main one and systemd calls the unit running, so nothing was stopped and
    // nothing is on its way back. `pending` here would be the worst of the three
    // answers: it means "leave it alone", over a dashboard that will stay stale
    // until somebody acts.
    const current = await mainPid();
    if (current.read && current.pid !== null && current.pid === outgoing && state === "running") {
      console.error(
        `[hermes] ${HERMES_DASHBOARD_UNIT} was not stopped — the same process is still serving`,
      );
      return "failed";
    }
    console.error(
      `[hermes] ${HERMES_DASHBOARD_UNIT} did not come back after its stop (unit is ${state})`,
    );
    return state === "down" ? "failed" : "pending";
  }
  if (await waitForPortOpen(DASHBOARD_PORT, DASHBOARD_HOST, { timeoutMs: deadline - Date.now() })) {
    return "restarted";
  }
  console.error(
    `[hermes] ${HERMES_DASHBOARD_UNIT} restarted but is not listening on ${DASHBOARD_HOST}:${DASHBOARD_PORT} again`,
  );
  return "pending";
}
