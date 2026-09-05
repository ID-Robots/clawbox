import { getActiveHarness, type Harness } from "@/lib/harness";
import { patchHermesConfig, readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { readConfig, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset } from "@/lib/openclaw-config";

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
  const config = await readConfig();
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
  const [review, curator] = await Promise.all([
    readHermesConfigValue(HERMES_KEYS.memoryReview as string).catch(() => null),
    readHermesConfigValue(HERMES_KEYS.skillLearning as string).catch(() => null),
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
    const present = valueAt(await readConfig(), key) !== undefined;
    if (present) await runOpenclawConfigUnset(key);
    return;
  }
  if (id === "memoryReview") {
    await runOpenclawConfigSet([key, enabled ? "true" : "false", "--strict-json"]);
    return;
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
 */
export async function applyBackgroundJobRestart(harness: Harness): Promise<boolean> {
  if (harness === "hermes") return false;
  try {
    await restartGateway();
    return true;
  } catch {
    return false;
  }
}
