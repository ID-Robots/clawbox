/**
 * The gateway's automations follow the box's Anthropic account pool
 * (TASK-2533).
 *
 * WHAT BROKE. Since OpenClaw 2026.11.3 every isolated agent-turn automation
 * holds a RECORDED INFERENCE ACCOUNT (`inferenceBinding`: the profile id and
 * that profile's authorization lifetime), captured when the job is created or
 * when it is updated with an explicit `model@profile`, and a scheduled run uses
 * that one profile and no other ("account refusals never fall back to another
 * account", docs/automation/cron-jobs/payloads.md "Inference account
 * continuity"). Core gives the lifetime a new value on any credential write
 * that is not its own refresh (`prepareAuthProfileAuthorizationWrite`:
 * "Explicit login/upsert is replacement even when the operator supplies
 * identical bytes"), and the pool's accounts are `token` profiles it writes
 * with `models auth paste-token` each time it renews one. So:
 *  - after a RENEWAL every automation bound to that account failed with
 *    "Automation inference account was replaced";
 *  - after a SWAP every automation still ran on the account it was bound to,
 *    and an account at its weekly limit answered each run with the limit text;
 *  - a job with no binding at all (made before 2026.11.3) failed with
 *    "Automation has no recorded inference account".
 *
 * HARNESS FIRST. Core has no way to renew a `token` profile in place (only
 * its own OAuth refresh continues a lifetime, and the pool must stay the one
 * holder of each refresh token), and no automatic re-binding. What it does
 * offer is its own adoption: `cron.update` with `payload.model` =
 * `<provider/model>@<profileId>` "captures a fresh authorization"
 * (`captureCronUpdatedInferenceBinding`), from the gateway's admin client —
 * the same as `openclaw automations edit <id> --model …@…`. So after every
 * move of the gateway's order and every paste, the box re-adopts, for each
 * automation that runs on Anthropic, the profile core's order leads with: the
 * account that can answer.
 *
 * MODEL-LESS JOBS keep inheriting the agent's default model. Core binds only
 * with an explicit model, so such a job is adopted in two updates: the agent
 * default `@profile` (the binding is captured), then `model: null` — core
 * deletes the model and, with no model in the patch, keeps the binding it
 * already holds. A clear that did not land is remembered and finished on the
 * next pass, so a job never stays pinned to a model it did not choose.
 *
 * WHAT IS LEFT ALONE: jobs on another provider, `main`-session jobs (they run
 * in the chat's own turn, with no binding of their own), jobs of an agent other
 * than `main` (the pool writes only `main`'s store), and a job whose model
 * names a profile that is not the pool's — the owner chose that account —
 * unless the box itself put it there while every pool account was limited and
 * the owner's own sign-in led.
 *
 * WHAT IS KNOWN. `cron.list` hides each job's binding (`toPublicCronJob`), so
 * the box keeps its own record of what it adopted, per job: the profile, that
 * profile's authorization lifetime at the time, and the job's config revision
 * after the update. A job is adopted again when the order leads with another
 * profile, when that profile's lifetime changed (a renewal's paste), when the
 * job was edited since, when the box has no record of it (a job made in the
 * chat binds to whatever that session ran on), and — whatever the record says
 * — when its last run failed on its account. Such a failed run is run once
 * more right after, when it is recent: the scheduled run it lost.
 */

/** A job's last run failed on its recorded inference account, not on the model. */
const BINDING_FAILURE_RE = /no recorded inference account|inference account was replaced|selected automation account is unavailable|requires an available stored inference account/i;

/** A run lost to its account longer ago than this is not run again: its moment has passed. */
export const BINDING_RETRY_WINDOW_MS = 2 * 60 * 60_000;

/** The profile automations should be bound to: the one core's stored order leads with. */
export interface CronBindingTarget {
  profileId: string;
  /** Its authorization lifetime (or, before core enrolled one, its credential's fingerprint). */
  authorization: string | null;
}

/** What `cron.list` says of one job, as far as the binding goes. */
export interface CronJobDefinition {
  id: string;
  agentId: string | null;
  sessionTarget: string | null;
  kind: string | null;
  /** `payload.model` as stored, or null: the job inherits its agent's default. */
  model: string | null;
  enabled: boolean;
  revision: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRunAtMs: number | null;
}

/** What the box adopted for one job. */
export interface CronBindingRecord {
  profileId: string;
  authorization: string | null;
  /** The job inherits its agent's default model: the box adopts it in two updates and leaves no model behind. */
  inherits: boolean;
  /** `payload.model` as the box left it — null once a model-less job's clear landed. */
  model: string | null;
  revision: string | null;
  at: number;
  /** The failed run (its `lastRunAtMs`) the box already ran again. */
  retriedRunAt?: number;
}

export type CronBindingRecords = Record<string, CronBindingRecord>;

export interface CronBindingPlan {
  job: CronJobDefinition;
  /** The `payload.model` values to set, in order; null clears it. */
  steps: (string | null)[];
  inherits: boolean;
  /** Run the job once more after it is adopted: its last run was lost to its account. */
  retry: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `cron.list`'s jobs with what the binding needs, read defensively. */
export function parseCronDefinitions(payload: unknown): CronJobDefinition[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(root.jobs) ? root.jobs : Array.isArray(payload) ? payload : [];
  const jobs: CronJobDefinition[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const job = raw as Record<string, unknown>;
    const id = str(job.id) ?? str(job.jobId);
    if (!id) continue;
    const payloadOf = job.payload && typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : {};
    const state = (job.state && typeof job.state === "object" ? job.state : job) as Record<string, unknown>;
    jobs.push({
      id,
      agentId: str(job.agentId),
      sessionTarget: str(job.sessionTarget),
      kind: str(payloadOf.kind),
      model: str(payloadOf.model),
      enabled: job.enabled !== false,
      revision: str(job.configRevision),
      lastStatus: str(state.lastStatus ?? state.lastRunStatus),
      lastError: str(state.lastError),
      lastRunAtMs: num(state.lastRunAtMs ?? state.lastRunAt),
    });
  }
  return jobs;
}

/** A model reference and the profile it names after its last `@`, if any. */
export function splitModelRef(ref: string): { base: string; profileId: string | null } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { base: ref.trim(), profileId: null };
  return { base: ref.slice(0, at).trim(), profileId: ref.slice(at + 1).trim() || null };
}

/** A model reference core resolves to Anthropic: `anthropic/…`, or a bare Claude model id. */
export function isAnthropicModel(base: string): boolean {
  const lower = base.trim().toLowerCase();
  return lower.startsWith("anthropic/") || (!lower.includes("/") && lower.startsWith("claude"));
}

/**
 * Which jobs to adopt onto `target`, and how. Pure: the box's records and
 * `cron.list` in, the updates out.
 *
 * `defaultModel`: the `main` agent's default model without any `@profile` — what
 * a model-less job runs on — or null when it could not be read.
 */
export function planCronBindings(input: {
  jobs: readonly CronJobDefinition[];
  target: CronBindingTarget;
  records: CronBindingRecords;
  defaultModel: string | null;
  isPoolProfile: (profileId: string) => boolean;
  now: number;
}): CronBindingPlan[] {
  const { target, records, defaultModel, isPoolProfile, now } = input;
  const plans: CronBindingPlan[] = [];
  for (const job of input.jobs) {
    if (job.kind !== "agentTurn" || job.sessionTarget === "main") continue;
    if (job.agentId !== null && job.agentId !== "main") continue;
    const record: CronBindingRecord | undefined = records[job.id];
    // The model is the one the box left: what it adopted is still its to move.
    const ours = !!record && record.model === job.model;
    const inherits = job.model === null || (ours && record.inherits);
    let adopt: string;
    if (inherits) {
      if (defaultModel === null || !isAnthropicModel(defaultModel)) continue;
      adopt = `${defaultModel}@${target.profileId}`;
    } else {
      const { base, profileId } = splitModelRef(job.model as string);
      if (!isAnthropicModel(base)) continue;
      // An account the owner chose for this job, not one of the pool's.
      if (profileId !== null && !isPoolProfile(profileId) && !ours) continue;
      adopt = `${base}@${target.profileId}`;
    }
    const lastRun = job.lastRunAtMs ?? 0;
    const failed = job.lastStatus === "error" && !!job.lastError && BINDING_FAILURE_RE.test(job.lastError) && lastRun > (record?.at ?? 0);
    const current = !!record && ours
      && record.profileId === target.profileId
      && record.authorization === target.authorization
      && (record.revision === null || job.revision === null || record.revision === job.revision);
    const retry = failed && job.enabled && record?.retriedRunAt !== job.lastRunAtMs && now - lastRun <= BINDING_RETRY_WINDOW_MS;
    if (current && !failed) {
      // Bound, but a model-less job's clear is still owed.
      if (inherits && job.model !== null) plans.push({ job, steps: [null], inherits, retry: false });
      continue;
    }
    plans.push({ job, steps: inherits ? [adopt, null] : [adopt], inherits, retry });
  }
  return plans;
}

export interface CronBindingDeps {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readRecords: () => Promise<CronBindingRecords>;
  writeRecords: (records: CronBindingRecords) => Promise<void>;
}

export interface CronBindingResult {
  /** Jobs adopted onto the target (their binding update landed). */
  bound: number;
  /** Jobs whose update core refused or that could not be asked: tried again on the next pass. */
  owed: number;
  /** Lost runs started again. */
  rerun: number;
  /** `cron.list` could not be read: nothing was looked at. */
  unread: boolean;
}

/** The config revision an update answered with, flat or under `job`. */
function revisionOf(reply: Record<string, unknown> | null): string | null {
  if (!reply) return null;
  const job = reply.job && typeof reply.job === "object" ? (reply.job as Record<string, unknown>) : reply;
  return str(job.configRevision);
}

/**
 * Adopt every job that needs it onto `target`. Never throws: what could not
 * be done is counted as owed and planned again on the next pass.
 */
export async function bindCronsToTarget(
  deps: CronBindingDeps,
  input: { target: CronBindingTarget; defaultModel: string | null; isPoolProfile: (profileId: string) => boolean; now?: number },
): Promise<CronBindingResult> {
  const now = input.now ?? Date.now();
  const result: CronBindingResult = { bound: 0, owed: 0, rerun: 0, unread: false };
  let jobs: CronJobDefinition[];
  try {
    jobs = parseCronDefinitions(await deps.call("cron.list", { includeDisabled: true }));
  } catch {
    return { ...result, unread: true };
  }
  let records: CronBindingRecords;
  try {
    records = { ...(await deps.readRecords()) };
  } catch {
    records = {};
  }
  let dirty = false;
  // Records of jobs that are gone.
  for (const id of Object.keys(records)) {
    if (!jobs.some((j) => j.id === id)) {
      delete records[id];
      dirty = true;
    }
  }
  const plans = planCronBindings({ jobs, target: input.target, records, defaultModel: input.defaultModel, isPoolProfile: input.isPoolProfile, now });
  for (const plan of plans) {
    const { job } = plan;
    let model: string | null = job.model;
    let revision: string | null = null;
    let landed = 0;
    for (const step of plan.steps) {
      try {
        const reply = await deps.call("cron.update", { id: job.id, patch: { payload: { kind: "agentTurn", model: step } } });
        model = step;
        revision = revisionOf(reply);
        landed += 1;
      } catch (err) {
        console.error(`[anthropic-cron-binding] core did not take automation ${job.id}'s account (${step === null ? "clearing the model it inherits" : step}):`, err instanceof Error ? err.message : err);
        break;
      }
    }
    // The adoption is the first step of a binding plan; a clear-only plan was already bound.
    const adopted = plan.steps[0] !== null ? landed > 0 : true;
    if (landed < plan.steps.length) result.owed += 1;
    if (!adopted) continue;
    if (plan.steps[0] !== null) result.bound += 1;
    const before = records[job.id];
    records[job.id] = {
      profileId: plan.steps[0] !== null ? input.target.profileId : (before?.profileId ?? input.target.profileId),
      authorization: plan.steps[0] !== null ? input.target.authorization : (before?.authorization ?? input.target.authorization),
      inherits: plan.inherits,
      model,
      revision,
      at: plan.steps[0] !== null ? now : (before?.at ?? now),
      ...(before?.retriedRunAt !== undefined ? { retriedRunAt: before.retriedRunAt } : {}),
    };
    dirty = true;
    if (plan.retry && job.lastRunAtMs !== null) {
      // Once per lost run, whether or not core starts it: a run that cannot be
      // started now is not worth a second try at a later, wrong moment.
      records[job.id].retriedRunAt = job.lastRunAtMs;
      try {
        await deps.call("cron.run", { id: job.id, mode: "force" });
        result.rerun += 1;
      } catch (err) {
        console.error(`[anthropic-cron-binding] could not run automation ${job.id} again after adopting its account:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (dirty) {
    try {
      await deps.writeRecords(records);
    } catch (err) {
      console.error("[anthropic-cron-binding] could not record which accounts the automations were given:", err instanceof Error ? err.message : err);
    }
  }
  if (result.bound > 0 || result.owed > 0) {
    console.error(`[anthropic-cron-binding] ${result.bound} automation(s) on ${input.target.profileId}${result.owed > 0 ? `, ${result.owed} still owed` : ""}${result.rerun > 0 ? `, ${result.rerun} lost run(s) started again` : ""}`);
  }
  return result;
}
