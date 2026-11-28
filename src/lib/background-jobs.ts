import { getActiveHarness, type Harness } from "@/lib/harness";
import { patchHermesConfig, readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { callGatewayRpc, readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset } from "@/lib/openclaw-config";
import { coreVersionAtLeast, installedOpenclawCoreVersion } from "@/lib/openclaw-core-generation";

// The three things the box does on its OWN initiative, and the switches for them.
//
// WHY THIS EXISTS. OpenClaw 2 arrives with heartbeat DMs, memory dreaming and
// self-learning all ON: measured on a box, `state/openclaw.sqlite` `cron_jobs`
// held `heartbeat-main`, `skill-collection-review-main` and "Memory Dreaming
// Promotion" all enabled, the journal logged "[heartbeat] started" twice in an
// evening, and the alerts go to `commands.ownerAllowFrom` — one Telegram user.
// All of it spends the owner's subscription or his ClawBox AI credits, and
// ClawBox wrote none of the keys — so TASK-609 (owner ruling 2026-09-03) seeded
// OPT-OUTS once per box, and this panel was how the owner switched them back.
//
// THE DEFAULT IS ON (owner ruling 2026-09-15, reversing that): "Working on its
// own" is what the box does unless the owner says otherwise. The boot script
// that owns each harness's config — `scripts/gateway-pre-start.sh` on
// OpenClaw, `scripts/register-mcp.sh` on Hermes, where the same shared config
// lock is already held — brings a box the previous build seeded off back to
// the harness defaults ONCE (generation 2 of `data/background-optouts.json`,
// which only flips a key still AT the old opt-out literal), and from then on
// the keys are the owner's for ever. This module is the switches themselves,
// in both directions; nothing at boot seeds a value into a key any more —
// except, once per box, `off` / `false` into an ABSENT self-learning or dreaming
// key on a single-engine box (TASK-2387, `isSingleEngineBox`) — and nothing ever
// writes `0m` but the owner's own OFF here.
//
// HARNESS FIRST — every one of these is the harness's own documented key, read
// and written through the harness's own writer. Nothing here invents a store.
//
//   OpenClaw 2026.8.1
//     agents.defaults.heartbeat.every                            docs/gateway/heartbeat.md
//     plugins.entries.memory-core.config.dreaming.enabled        docs/concepts/dreaming.md
//     skills.workshop.autonomous.mode                            docs/tools/self-learning.md
//       ("auto also enables weekly collection review" — that IS the
//        skill-collection-review cron the incident found enabled; 2026.10.6
//        retired that cron: `auto` there is background review plus archiving
//        learned skills unused for 30 days, `off` disables both)
//
//   OpenClaw 2026.11.5 — THE HEARTBEAT IS AN AUTOMATION JOB NOW. The core
//     retired `agents.defaults.heartbeat` (and the per-agent copy): a config
//     that still holds one is invalid until `openclaw doctor --fix` has turned
//     the monitor into an ordinary job and removed the key, and `config set` /
//     `config unset` of it are refused (docs/gateway/heartbeat.md in the
//     package, "Heartbeat migration"). Doctor keeps the owner's choice: a
//     monitor that was OFF (`every: "0m"`) becomes a DISABLED job, one that ran
//     becomes an enabled job, both under the monitor's own name (`heartbeat-
//     main`); a box the core provisions through its own `setup` gets "Proactive
//     check (<agent>)". The row therefore reads and writes THOSE JOBS through
//     the gateway's `cron.list` / `cron.update`, the same RPCs the Anthropic
//     account binding uses, and says `supported: false` where the box has none
//     (ClawBox never runs the core's setup, so a box installed on 2026.11.5 has
//     no such job until the owner creates one: the panel does not invent it).
//     Switching it needs no gateway restart: the job change is live.
//
//   Hermes 0.20.5 (read off the installed package on the box)
//     auxiliary.background_review.enabled   "Master switch for automatic
//       post-turn memory/skill review forks" — the one fork that captures BOTH
//       memory and skills there, so it stands in for dreaming.
//     curator.enabled                       "Curator — background skill
//       maintenance… periodically reviews AGENT-CREATED skills", the closest
//       thing to the weekly collection review.
//     There is NO heartbeat. The only `heartbeat` keys in Hermes' defaults are
//     `compute_host_heartbeat_secs` and `websocket_heartbeat_ack_max_age_seconds`,
//     both transport-level: nothing in Hermes wakes itself to message the owner.
//     That row is reported `supported: false` rather than drawn as an off
//     switch, because a switch for something that cannot happen is a lie in the
//     shape of a control.

export type BackgroundJobId = "checkIns" | "memoryReview" | "skillLearning";

export interface BackgroundJobRow {
  id: BackgroundJobId;
  /** Whether the job runs on this box today. */
  enabled: boolean;
  /**
   * False where this harness has no such job. The panel says so instead of
   * drawing a switch: "off" and "impossible" are different facts.
   */
  supported: boolean;
  /** The harness key behind the row, so the panel can name it. Null when none. */
  key: string | null;
}

export interface BackgroundJobsStatus {
  harness: Harness;
  jobs: BackgroundJobRow[];
  /**
   * True when the answer came from a fallback rather than from the box — an
   * unreadable config. The panel says so rather than painting a guess as fact.
   */
  degraded: boolean;
  /**
   * Set (with `degraded: true`) when only SOME rows are guesses: the check-ins
   * row on a core where it is an automation job the gateway could not be asked
   * about, or whose version could not be read. The rows not named here were
   * read from the config as ever and stay switchable. Absent when every row of
   * a degraded status is a guess (a config nobody could read).
   */
  unreadable?: BackgroundJobId[];
  /**
   * TASK-2387: an OpenClaw box whose chats all share one AI engine
   * (`CLAWBOX_SINGLE_ENGINE`), where `gateway-pre-start.sh` keeps memory
   * dreaming and self-learning's background review off by default. Always
   * false on Hermes, whose keys that flag does not touch.
   */
  singleEngine: boolean;
}

/**
 * `CLAWBOX_SINGLE_ENGINE` the way `gateway-pre-start.sh` reads it: 1, true, yes
 * or on, any case. The web server gets it from `.env` (clawbox-setup loads that
 * file); the gateway unit does not, which is why the boot script reads the file
 * itself.
 */
export function isSingleEngineBox(env: NodeJS.ProcessEnv = process.env): boolean {
  let raw = (env.CLAWBOX_SINGLE_ENGINE ?? "").trim();
  // One pair of matching quotes, as the boot script strips them: whatever
  // loaded `.env` into this process may have left a hand-written `"1"` quoted.
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")) {
    raw = raw.slice(1, -1).trim();
  }
  const value = raw.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const OPENCLAW_KEYS: Record<BackgroundJobId, string> = {
  checkIns: "agents.defaults.heartbeat.every",
  memoryReview: "plugins.entries.memory-core.config.dreaming.enabled",
  skillLearning: "skills.workshop.autonomous.mode",
};

const HERMES_KEYS: Partial<Record<BackgroundJobId, string>> = {
  memoryReview: "auxiliary.background_review.enabled",
  skillLearning: "curator.enabled",
};

function valueAt(config: unknown, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * How the heartbeat is kept on the installed core: `job` from OpenClaw 2026.11.5
 * (an automation job, see the header), `key` before it
 * (`agents.defaults.heartbeat.every`), `unknown` when the core's version cannot
 * be read. NOT folded into a yes/no: on a core that retired the key an absent
 * key reads as the core's default, ON, which is the very lie this module's
 * switch must not tell over a disabled job, so "cannot tell" is refused rather
 * than answered as the older core.
 */
type HeartbeatKeeping = "job" | "key" | "unknown";

async function heartbeatKeeping(): Promise<HeartbeatKeeping> {
  const retired = coreVersionAtLeast(await installedOpenclawCoreVersion(), 2026, 11, 5);
  return retired === null ? "unknown" : retired ? "job" : "key";
}

/** One automation job the check-ins switch drives. */
interface CheckInJob {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * The heartbeat monitor's job, or null for any other row. The core keeps no
 * marker on a converted job (its declaration key is dropped and the ownership
 * lives in a receipt the gateway does not publish), so three things together
 * say it is one:
 *   - it is an ordinary agent-turn automation (what Doctor converts a monitor
 *     into and what the core's setup creates),
 *   - it belongs to an agent, and
 *   - its name is one the core gives a monitor FOR THAT AGENT: `heartbeat-<agent>`
 *     (what a 2026.11.3 box named its monitor, kept by the conversion),
 *     `Heartbeat (<agent>)` (the 2026.11.3 documentation's wording) or
 *     `Proactive check (<agent>)` (the job the core's own setup creates).
 * A job an owner called `heartbeat-report` for an agent that is not `report` is
 * therefore not taken for the monitor and never switched by this row; one the
 * owner renamed is not found, and the row says there is none rather than
 * guessing.
 */
export function checkInJobOf(raw: unknown): CheckInJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = raw as Record<string, unknown>;
  if (typeof job.id !== "string" || typeof job.enabled !== "boolean") return null;
  const name = typeof job.name === "string" ? job.name.trim() : "";
  const agent = typeof job.agentId === "string" ? job.agentId.trim().toLowerCase() : "";
  const payload = job.payload && typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : null;
  if (!name || !agent || payload?.kind !== "agentTurn") return null;
  const own = [`heartbeat-${agent}`, `heartbeat (${agent})`, `proactive check (${agent})`];
  return own.includes(name.toLowerCase()) ? { id: job.id, name, enabled: job.enabled } : null;
}

/** `cron.list` answers at most this many jobs a page. */
const CRON_LIST_PAGE = 200;

/**
 * How long a READ of the job list may wait for the gateway. The Settings panel
 * asks on every open, and a gateway that is restarting (the other two switches
 * restart it) answers the call's own 20 s late: the row says it could not be
 * read instead.
 */
const CRON_LIST_READ_TIMEOUT_MS = 8_000;

/**
 * Every check-in job the box has, disabled ones included. Throws when the
 * gateway cannot answer or a page said there was more and could not be read:
 * a partial list is not the box's state.
 */
async function listCheckInJobs(): Promise<CheckInJob[]> {
  const found: CheckInJob[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const reply = await callGatewayRpc(
      "cron.list",
      { includeDisabled: true, includeDeliveryPreviews: false, limit: CRON_LIST_PAGE, offset },
      { timeoutMs: CRON_LIST_READ_TIMEOUT_MS },
    );
    const jobs = reply.jobs;
    if (!Array.isArray(jobs)) throw new Error("cron.list answered no job list");
    for (const raw of jobs) {
      const job = checkInJobOf(raw);
      if (job) found.push(job);
    }
    if (reply.hasMore !== true) return found;
    const next = typeof reply.nextOffset === "number" ? reply.nextOffset : null;
    if (next === null || next <= offset || jobs.length === 0) {
      throw new Error("cron.list has more jobs and did not say where they continue");
    }
    offset = next;
  }
  throw new Error("cron.list has more pages than this reads");
}

/**
 * The row for the jobs found. ON when any of them is enabled (switching OFF
 * disables every enabled one, switching ON enables every disabled one, so the
 * two directions meet). No job means the box does no check-ins, and nothing to
 * switch: `supported: false`, as for Hermes, rather than a switch for a job
 * that is not there.
 */
function checkInRowFromJobs(jobs: CheckInJob[]): BackgroundJobRow {
  if (jobs.length === 0) return { id: "checkIns", enabled: false, supported: false, key: null };
  return {
    id: "checkIns",
    enabled: jobs.some((job) => job.enabled),
    supported: true,
    key: `automation: ${jobs.map((job) => job.name).join(", ")}`,
  };
}

/**
 * Every row ABSENT means the core's own default, and every one of those
 * defaults is ON. Reading an absent key as "off" would show a box that has
 * never been seeded as already quiet, which is exactly the state this task
 * exists because nobody could see.
 */
async function readOpenclawJobs(): Promise<BackgroundJobsStatus> {
  // STRICT, never `readConfig`. That one answers `{}` for every read failure
  // alike — EACCES, a file caught half-written by a concurrent `config set` —
  // and an absent key here means "the core's own default, which is ON". So an
  // unreadable config would report all three jobs running AND satisfy the
  // write-verification below in the ON direction, which is the false success
  // `readConfigStrict`'s own doc was written about.
  const config = await readConfigStrict();
  const every = valueAt(config, OPENCLAW_KEYS.checkIns);
  const dreaming = valueAt(config, OPENCLAW_KEYS.memoryReview);
  const mode = valueAt(config, OPENCLAW_KEYS.skillLearning);
  // A core that retired the heartbeat key is asked about the job instead. When
  // that cannot be done (the gateway does not answer, or the core's version is
  // not readable) the check-ins row alone is a guess, and says so: the other
  // two rows come from the config as ever, and a gateway that is down must not
  // stop them being switched. The guess is ON, like every degraded row — never
  // a reading of an absent key, which on that core means nothing.
  const keeping = await heartbeatKeeping();
  let checkIns: BackgroundJobRow;
  let unreadable = false;
  if (keeping === "key") {
    checkIns = {
      id: "checkIns",
      // "0m" disables the recurring cadence; anything else, including an
      // absent key, is a cadence the core will run.
      enabled: typeof every === "string" ? every.trim() !== "0m" : true,
      supported: true,
      key: OPENCLAW_KEYS.checkIns,
    };
  } else {
    try {
      if (keeping === "unknown") throw new Error("the installed OpenClaw's version could not be read");
      checkIns = checkInRowFromJobs(await listCheckInJobs());
    } catch {
      unreadable = true;
      checkIns = { id: "checkIns", enabled: true, supported: true, key: null };
    }
  }
  return {
    harness: "openclaw",
    degraded: unreadable,
    ...(unreadable ? { unreadable: ["checkIns" as const] } : {}),
    singleEngine: isSingleEngineBox(),
    jobs: [
      checkIns,
      {
        id: "memoryReview",
        enabled: dreaming !== false,
        supported: true,
        key: OPENCLAW_KEYS.memoryReview,
      },
      {
        id: "skillLearning",
        enabled: typeof mode === "string" ? mode.trim().toLowerCase() !== "off" : true,
        supported: true,
        key: OPENCLAW_KEYS.skillLearning,
      },
    ],
  };
}

/** Hermes' own booleans, absent meaning the documented default of `true`. */
async function readHermesJobs(): Promise<BackgroundJobsStatus> {
  // NOT `.catch(() => null)`: `null` is what an UNSET key answers, and both of
  // Hermes' defaults are `true`, so swallowing a read failure here would report
  // both jobs running and then verify an "on" write against a file nobody could
  // open. A throw reaches `readBackgroundJobs`, which says `degraded`.
  const [review, curator] = await Promise.all([
    readHermesConfigValue(HERMES_KEYS.memoryReview as string),
    readHermesConfigValue(HERMES_KEYS.skillLearning as string),
  ]);
  const on = (raw: string | null) => (raw === null ? true : raw.trim().toLowerCase() !== "false");
  return {
    harness: "hermes",
    degraded: false,
    singleEngine: false,
    jobs: [
      { id: "checkIns", enabled: false, supported: false, key: null },
      { id: "memoryReview", enabled: on(review), supported: true, key: HERMES_KEYS.memoryReview ?? null },
      { id: "skillLearning", enabled: on(curator), supported: true, key: HERMES_KEYS.skillLearning ?? null },
    ],
  };
}

/** Never throws: a box that cannot answer says `degraded` rather than guessing. */
export async function readBackgroundJobs(): Promise<BackgroundJobsStatus> {
  const harness = await getActiveHarness().catch(() => "openclaw" as Harness);
  try {
    return harness === "hermes" ? await readHermesJobs() : await readOpenclawJobs();
  } catch {
    return {
      harness,
      degraded: true,
      singleEngine: harness !== "hermes" && isSingleEngineBox(),
      jobs: (["checkIns", "memoryReview", "skillLearning"] as BackgroundJobId[]).map((id) => ({
        id,
        enabled: true,
        supported: harness !== "hermes" || id !== "checkIns",
        key: null,
      })),
    };
  }
}

export class BackgroundJobError extends Error {
  constructor(readonly code: "unsupported" | "write_failed", message: string) {
    super(message);
  }
}

/**
 * Switching a job ON means REMOVING the key, not pinning a value of our own:
 * `config unset` puts it back where the core's own default decides it, which
 * for the heartbeat is 30 m — or an hour on Anthropic OAuth, a distinction
 * ClawBox has no business freezing. The two boolean/enum rows have no such
 * default to defer to, so they are written explicitly. The boot-time flip in
 * `gateway-pre-start.sh` removes the key the same way, so the panel's ON and
 * the migration cannot leave the cadence in two different shapes.
 *
 * The unset is only attempted where the key is actually present: the CLI exits
 * 1 with "Config path not found" otherwise, and that is not a failure.
 */
async function writeOpenclawJob(id: BackgroundJobId, enabled: boolean): Promise<void> {
  const key = OPENCLAW_KEYS[id];
  const keeping = id === "checkIns" ? await heartbeatKeeping() : "key";
  if (keeping !== "key") {
    // The job, not a key (see the header). A core whose version cannot be read
    // is not written to at all: the key may not exist there. Only the jobs that
    // are not already in the wanted state are touched, so a second click on a
    // half-switched box leaves what is right alone. `cron.update` is the
    // ordinary automation edit, live without a gateway restart.
    if (keeping === "unknown") throw new Error("the installed OpenClaw's version could not be read");
    for (const job of await listCheckInJobs()) {
      if (job.enabled === enabled) continue;
      await callGatewayRpc("cron.update", { id: job.id, patch: { enabled } });
    }
    // EVERY job, not "any": the row reads ON when any job is on, so one job the
    // core accepted and did not change would still read back as the wanted
    // state after a switch ON.
    if ((await listCheckInJobs()).some((job) => job.enabled !== enabled)) {
      throw new Error("the core did not take the change on every check-in job");
    }
    return;
  }
  if (id === "checkIns") {
    if (!enabled) {
      await runOpenclawConfigSet([key, "0m"]);
      return;
    }
    const present = valueAt(await readConfigStrict(), key) !== undefined;
    if (present) await runOpenclawConfigUnset(key);
    return;
  }
  if (id === "memoryReview") {
    await runOpenclawConfigSet([key, enabled ? "true" : "false", "--strict-json"]);
    return;
  }
  // TERNARY, not boolean, up to 2026.10.3: that core's values are
  // `off | propose | auto`, and `propose` means "capture, but let me review
  // every one before it applies". Switching OFF writes `off` and switching ON
  // writes `auto`, which is the core's own default — so a box the owner had put
  // on `propose` and then switched off here comes back as `auto`, a wider
  // setting than they chose. That is stated rather than hidden: the row's own
  // text says what ON means, and restoring `propose` would need ClawBox to
  // remember a value the switch has no way to show. `propose` reads as ON while
  // it is set, and this never rewrites it — a box already on `propose` is left
  // exactly there. 2026.10.6 retired proposals (`off | auto`), and its own
  // `doctor --fix` moves `propose` to `off`, which then reads as OFF here.
  if (enabled) {
    const current = valueAt(await readConfigStrict(), key);
    const mode = typeof current === "string" ? current.trim().toLowerCase() : "";
    if (mode && mode !== "off") return;
  }
  await runOpenclawConfigSet([key, enabled ? "auto" : "off"]);
}

async function writeHermesJob(id: BackgroundJobId, enabled: boolean): Promise<void> {
  const key = HERMES_KEYS[id];
  if (!key) {
    throw new BackgroundJobError("unsupported", "This edition has no such background job.");
  }
  await patchHermesConfig({ set: { [key]: enabled ? "true" : "false" } });
}

/**
 * Whether `id`'s row in `status` is a guess. A wholly degraded status (the
 * config could not be read) is a guess in every row; one that names its
 * `unreadable` rows is a guess in those alone, so a gateway that cannot be asked
 * about the check-ins does not stop dreaming or self-learning being switched.
 */
function cannotTrust(status: BackgroundJobsStatus, id: BackgroundJobId): boolean {
  if (!status.degraded) return false;
  return status.unreadable === undefined || status.unreadable.includes(id);
}

/**
 * Write one switch and read it back off the box.
 *
 * READ BACK, not exit-code: `runOpenclawConfigSet` already verifies its own
 * write against the file, and `patchHermesConfig` verifies its patched text
 * before it renames it — but the two answer different questions from ours, and
 * this is the one a panel repeats to the owner. A switch that reports success
 * over a config that did not change is the false success this codebase keeps
 * producing.
 */
export async function setBackgroundJob(
  id: BackgroundJobId,
  enabled: boolean,
): Promise<BackgroundJobsStatus> {
  const before = await readBackgroundJobs();
  // A DEGRADED read before the write, not only after it. The fallback rows a
  // degraded status carries are shaped like a working box — every job ON, every
  // one supported — so `row.supported` would wave through a write for a job
  // this edition may not even have, against a config nobody could read.
  if (cannotTrust(before, id)) {
    throw new BackgroundJobError("write_failed", "The device could not be read.");
  }
  const row = before.jobs.find((job) => job.id === id);
  if (!row?.supported) {
    throw new BackgroundJobError("unsupported", "This edition has no such background job.");
  }
  try {
    if (before.harness === "hermes") await writeHermesJob(id, enabled);
    else await writeOpenclawJob(id, enabled);
  } catch (err) {
    throw new BackgroundJobError(
      "write_failed",
      err instanceof Error ? err.message : "The setting could not be written.",
    );
  }

  const after = await readBackgroundJobs();
  // A DEGRADED read is not a verification. It is the box saying it could not
  // look, and every row in it is a fallback that happens to read as ON — which
  // would wave an "on" write straight through over a config that still says
  // otherwise.
  if (cannotTrust(after, id)) {
    throw new BackgroundJobError("write_failed", "The device could not confirm the change.");
  }
  if (after.jobs.find((job) => job.id === id)?.enabled !== enabled) {
    throw new BackgroundJobError("write_failed", "The setting did not change on the device.");
  }
  return after;
}

/**
 * The gateway holds the heartbeat schedule and the plugin's managed cron jobs
 * in memory, so a config change reaches them at the next start. Best-effort and
 * AFTER the write has been read back: a restart that fails leaves a box whose
 * config already says the right thing, and the panel says the change takes
 * effect when the gateway next starts rather than claiming it already has.
 * `null` is the third answer: no restart was needed at all (Hermes, and the
 * check-ins job of an OpenClaw that keeps the heartbeat as an automation).
 */
export async function applyBackgroundJobRestart(harness: Harness, id?: BackgroundJobId): Promise<boolean | null> {
  // RESTARTING THE OPENCLAW GATEWAY WOULD NOT CARRY A HERMES WRITE.
  // `restartGateway` restarts `clawbox-gateway.service`, which runs the OpenClaw
  // half — and these rows were written into the Hermes config, which that
  // service does not read. On a DUAL box that service may well be running, so
  // "there is nothing to restart" would be wrong; what is true on every SKU is
  // that no restart this function can perform would apply the write. Hence
  // `null` — "no restart was applicable" — rather than `false`.
  //
  // `null`, NOT `false`: "none was needed" and "it was tried and did not
  // happen" are different facts, and the panel renders the second as "it takes
  // effect when the assistant next restarts". Reporting `false` here put that
  // sentence under every successful Hermes write.
  //
  // WHAT WAS ACTUALLY VERIFIED, read-only off the installed 0.20.5 package:
  // the config cache is keyed on the file's own `(mtime_ns, size)`
  // (`hermes_cli/config.py`), and `is_background_review_enabled()` is asked at
  // each spawn (`agent/background_review.py`) — so the `background_review` row
  // is in force on the next turn with no restart at all. The `curator` row was
  // NOT traced that far: its `enabled` flag is read from the same cached config,
  // but whether the curator's own scheduler re-reads it between runs is
  // unconfirmed. If it does not, that row takes effect at the next Hermes start
  // and the owner is told nothing — a residual worth a device check rather than
  // a guess, and it is the one thing this function's answer does not cover.
  if (harness === "hermes") return null;
  // A check-in job edited through `cron.update` is in force in the running
  // gateway already: nothing was written to the config and nothing is held in
  // memory that a start would refresh. `null`, as for Hermes: none was needed.
  if (id === "checkIns" && (await heartbeatKeeping()) === "job") return null;
  try {
    await restartGateway();
    return true;
  } catch {
    return false;
  }
}
