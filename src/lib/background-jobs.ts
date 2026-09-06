import { getActiveHarness, type Harness } from "@/lib/harness";
import { patchHermesConfig, readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset } from "@/lib/openclaw-config";

// The three things the box does on its OWN initiative, and the switches for them.
//
// WHY THIS EXISTS (TASK-609, owner ruling 2026-09-03). OpenClaw 2 arrives with
// heartbeat DMs, memory dreaming and self-learning all ON: measured on a box,
// `state/openclaw.sqlite` `cron_jobs` held `heartbeat-main`,
// `skill-collection-review-main` and "Memory Dreaming Promotion" all enabled,
// the journal logged "[heartbeat] started" twice in an evening, and the alerts
// go to `commands.ownerAllowFrom` — one Telegram user. None of it was asked
// for, all of it spends the owner's subscription or his ClawBox AI credits, and
// ClawBox wrote none of the keys. `scripts/gateway-pre-start.sh` seeds the
// opt-outs once; this module is how the owner changes his mind.
//
// HARNESS FIRST — every one of these is the harness's own documented key, read
// and written through the harness's own writer. Nothing here invents a store.
//
//   OpenClaw 2026.8.1
//     agents.defaults.heartbeat.every                            docs/gateway/heartbeat.md
//     plugins.entries.memory-core.config.dreaming.enabled        docs/concepts/dreaming.md
//     skills.workshop.autonomous.mode                            docs/tools/self-learning.md
//       ("auto also enables weekly collection review" — that IS the
//        skill-collection-review cron the incident found enabled)
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
  return {
    harness: "openclaw",
    degraded: false,
    jobs: [
      {
        id: "checkIns",
        // "0m" disables the recurring cadence; anything else, including an
        // absent key, is a cadence the core will run.
        enabled: typeof every === "string" ? every.trim() !== "0m" : true,
        supported: true,
        key: OPENCLAW_KEYS.checkIns,
      },
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
 * Switching a job ON means REMOVING ClawBox's opt-out, not pinning a value of
 * our own: `config unset` puts the key back where the core's own default
 * decides it, which for the heartbeat is 30 m — or an hour on Anthropic OAuth,
 * a distinction ClawBox has no business freezing. The two boolean/enum rows
 * have no such default to defer to, so they are written explicitly.
 *
 * The unset is only attempted where the key is actually present: the CLI exits
 * 1 with "Config path not found" otherwise, and that is not a failure.
 */
async function writeOpenclawJob(id: BackgroundJobId, enabled: boolean): Promise<void> {
  const key = OPENCLAW_KEYS[id];
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
  // TERNARY, not boolean: the core's own values are `off | propose | auto`, and
  // `propose` means "capture, but let me review every one before it applies".
  // Switching OFF writes `off` and switching ON writes `auto`, which is the
  // core's own default — so a box the owner had put on `propose` and then
  // switched off here comes back as `auto`, a wider setting than he chose. That
  // is stated rather than hidden: the row's own text says what ON means, and
  // restoring `propose` would need ClawBox to remember a value the switch has
  // no way to show. `propose` reads as ON while it is set, and this never
  // rewrites it — a box already on `propose` is left exactly there.
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
  if (before.degraded) {
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
  if (after.degraded) {
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
 * `null` is the third answer: no restart was needed at all.
 */
export async function applyBackgroundJobRestart(harness: Harness): Promise<boolean | null> {
  // THERE IS NO GATEWAY TO RESTART ON HERMES. `restartGateway` restarts
  // `clawbox-gateway.service`, which is the OpenClaw half; on a Hermes box this
  // function has nothing to act on, so `null` — "no restart was applicable" —
  // is the only true answer it can give.
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
  try {
    await restartGateway();
    return true;
  } catch {
    return false;
  }
}
