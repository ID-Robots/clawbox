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
 * more right after, when it is recent: the scheduled run it lost — once in
 * BINDING_RETRY_WINDOW_MS, however often it fails again.
 *
 * WHEN THE POOL LEAVES. With none of the pool's accounts in the gateway any
 * more, only the jobs the box adopted are touched: onto the Anthropic profile
 * still leading (the owner's own sign-in), or — with none, the chat off
 * Claude — given back the model they had before the box touched them.
 *
 * NEVER OVER AN EDIT. Each update carries the job's config revision
 * (`expectedConfigRevision`), so an owner's edit made while the box was
 * planning wins; the job is planned again from what it now is.
 */

/** A job's last run failed on its recorded inference account, not on the model. */
const BINDING_FAILURE_RE = /no recorded inference account|inference account was replaced|selected automation account is unavailable|requires an available stored inference account/i;

/** A run lost to its account is run again once in this long, and only when it is this recent: its moment has passed. */
export const BINDING_RETRY_WINDOW_MS = 2 * 60 * 60_000;

/**
 * A job whose update core refused TWICE in a row is not asked again for this
 * long (an agent core resolves otherwise, a job core will not take). One
 * refusal is asked again on the next pass: right after a stop and start the
 * scheduler may still be loading, and the job is bound to an account that may
 * have just left the gateway.
 */
export const REFUSED_BACKOFF_MS = 10 * 60_000;

/** Per job: when core last refused its update, and how many times in a row. */
export type CronRefusals = Map<string, { at: number; count: number }>;

/** `cron.list` answers at most this many jobs a page. */
const LIST_PAGE = 200;

/** The profile automations should be bound to: the one core's order leads with. */
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
  /** `payload.model` before the box first touched the job: what it is given back when the pool leaves. */
  original?: string | null;
  revision: string | null;
  at: number;
  /** When the box last ran a lost run of this job again. */
  retriedAt?: number;
}

export type CronBindingRecords = Record<string, CronBindingRecord>;

export interface CronBindingPlan {
  job: CronJobDefinition;
  /** The `payload.model` values to set, in order; null clears it. */
  steps: (string | null)[];
  inherits: boolean;
  /** `payload.model` before the box first touched the job. */
  original: string | null;
  /** Run the job once more after it is adopted: its last run was lost to its account. */
  retry: boolean;
  /** The pool left: the job is given back, and its record dropped. */
  release?: boolean;
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

export interface CronPlanInput {
  jobs: readonly CronJobDefinition[];
  /** Null: the pool left and no Anthropic profile leads — the jobs the box adopted are given back. */
  target: CronBindingTarget | null;
  records: CronBindingRecords;
  /** The `main` agent's default model without any `@profile` (what a model-less job runs on), or null. */
  defaultModel: string | null;
  isPoolProfile: (profileId: string) => boolean;
  /** Only jobs the box already adopted (the pool's accounts are out of the gateway). */
  onlyAdopted?: boolean;
  /** A job with no `agentId` runs on `main` (core's default agent is `main`). */
  defaultIsMain?: boolean;
  /** Jobs not to ask about this time (their update was refused lately). */
  skip?: ReadonlySet<string>;
  now: number;
}

export interface CronBindingRun {
  /** Refusals per job, kept by the caller across passes (the gateway's process store). */
  refused?: CronRefusals;
  /** The profiles the gateway holds now: a job recorded on one that left is never held back by a refusal. */
  heldProfiles?: ReadonlySet<string>;
}

/**
 * Which jobs to adopt onto `target`, and how. Pure: the box's records and
 * `cron.list` in, the updates out.
 */
export function planCronBindings(input: CronPlanInput): CronBindingPlan[] {
  const { target, records, defaultModel, isPoolProfile, now } = input;
  const plans: CronBindingPlan[] = [];
  for (const job of input.jobs) {
    if (input.skip?.has(job.id)) continue;
    if (job.kind !== "agentTurn" || job.sessionTarget === "main") continue;
    if (job.agentId !== null ? job.agentId !== "main" : input.defaultIsMain === false) continue;
    const record: CronBindingRecord | undefined = records[job.id];
    // The model is the one the box left: what it adopted is still its to move.
    const ours = !!record && record.model === job.model;
    if (input.onlyAdopted && !ours) continue;
    const original = ours ? (record.original ?? (record.inherits ? null : record.model)) : job.model;
    const { base: defaultBase } = defaultModel ? splitModelRef(defaultModel) : { base: "" };
    // A model-less job, or one the box left pinned to the default because
    // its clear did not land — or whose record a crash lost after the pin.
    const pinnedDefault = !ours && job.model !== null && defaultModel !== null
      && (() => { const ref = splitModelRef(job.model as string); return ref.base === defaultBase && ref.profileId !== null && isPoolProfile(ref.profileId); })()
      && record?.inherits === true;
    const inherits = job.model === null || (ours && record.inherits) || pinnedDefault;
    if (target === null) {
      if (!ours) continue;
      // Given back: no model left on a model-less job, the model it had on any other.
      const back = record.inherits ? null : (record.original ?? null);
      if (job.model === back) {
        plans.push({ job, steps: [], inherits: record.inherits, original: back, retry: false, release: true });
      } else {
        plans.push({ job, steps: [back], inherits: record.inherits, original: back, retry: false, release: true });
      }
      continue;
    }
    let adopt: string;
    if (inherits) {
      if (defaultModel === null || !isAnthropicModel(defaultBase)) continue;
      adopt = `${defaultBase}@${target.profileId}`;
    } else {
      const { base, profileId } = splitModelRef(job.model as string);
      if (!isAnthropicModel(base)) continue;
      // An account the owner chose for this job, not one of the pool's.
      if (profileId !== null && !isPoolProfile(profileId) && !ours) continue;
      adopt = `${base}@${target.profileId}`;
    }
    const lastRun = job.lastRunAtMs ?? 0;
    const failed = job.lastStatus === "error" && !!job.lastError && BINDING_FAILURE_RE.test(job.lastError) && lastRun > (record?.at ?? 0);
    const current = !!record && (ours || pinnedDefault)
      && record.profileId === target.profileId
      && record.authorization === target.authorization
      && (record.revision === null || job.revision === null || record.revision === job.revision || pinnedDefault);
    const retry = failed && job.enabled && now - lastRun <= BINDING_RETRY_WINDOW_MS
      && (record?.retriedAt === undefined || now - record.retriedAt > BINDING_RETRY_WINDOW_MS);
    const originalOf = inherits ? null : original;
    if (current && !failed) {
      // Bound, but a model-less job's clear is still owed.
      if (inherits && job.model !== null) plans.push({ job, steps: [null], inherits, original: originalOf, retry: false });
      continue;
    }
    plans.push({ job, steps: inherits ? [adopt, null] : [adopt], inherits, original: originalOf, retry });
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
  /** Jobs given back when the pool left. */
  released: number;
  /** Jobs whose update core refused or that could not be asked: tried again on a later pass. */
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

/** Every page of `cron.list`, disabled jobs too; `complete` is false when a page said there was more and it could not be read. */
async function listAll(call: CronBindingDeps["call"]): Promise<{ jobs: CronJobDefinition[]; complete: boolean }> {
  const jobs: CronJobDefinition[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const reply = await call("cron.list", { includeDisabled: true, includeDeliveryPreviews: false, limit: LIST_PAGE, offset });
    const got = parseCronDefinitions(reply);
    jobs.push(...got);
    const next = num(reply?.nextOffset);
    if (reply?.hasMore !== true || next === null || next <= offset || got.length === 0) return { jobs, complete: reply?.hasMore !== true };
    offset = next;
  }
  return { jobs, complete: false };
}

/** Refusals when the caller keeps none (per module copy: the gateway passes its process store's). */
const ownRefusals: CronRefusals = new Map();

/** Test seam: forget which jobs core refused. */
export function _resetCronBindingForTests(): void {
  ownRefusals.clear();
}

/**
 * Adopt every job that needs it onto `target` (or, with none, give back the
 * ones the box adopted). Never throws: what could not be done is counted as
 * owed and planned again on a later pass.
 */
export async function bindCronsToTarget(
  deps: CronBindingDeps,
  input: Omit<CronPlanInput, "jobs" | "records" | "now" | "skip"> & CronBindingRun & { now?: number },
): Promise<CronBindingResult> {
  const refusedAt = input.refused ?? ownRefusals;
  const now = input.now ?? Date.now();
  const result: CronBindingResult = { bound: 0, released: 0, owed: 0, rerun: 0, unread: false };
  let listed: { jobs: CronJobDefinition[]; complete: boolean };
  try {
    listed = await listAll(deps.call);
  } catch {
    return { ...result, unread: true };
  }
  const { jobs } = listed;
  let records: CronBindingRecords;
  try {
    records = { ...(await deps.readRecords()) };
  } catch {
    records = {};
  }
  let dirty = false;
  const save = async () => {
    try {
      await deps.writeRecords(records);
      dirty = false;
    } catch (err) {
      console.error("[anthropic-cron-binding] could not record which accounts the automations were given:", err instanceof Error ? err.message : err);
    }
  };
  // Records of jobs that are gone — only when the whole list was read.
  if (listed.complete) {
    for (const id of Object.keys(records)) {
      if (!jobs.some((j) => j.id === id)) {
        delete records[id];
        dirty = true;
      }
    }
  }
  const skip = new Set([...refusedAt].filter(([id, r]) => {
    if (r.count < 2 || now - r.at >= REFUSED_BACKOFF_MS) return false;
    const on = records[id]?.profileId;
    return !(on && input.heldProfiles && !input.heldProfiles.has(on));
  }).map(([id]) => id));
  const { refused: _refused, heldProfiles: _held, ...planInput } = input;
  const plans = planCronBindings({ ...planInput, jobs, records, skip, now });
  for (const plan of plans) {
    const { job } = plan;
    if (plan.release && plan.steps.length === 0) {
      delete records[job.id];
      dirty = true;
      result.released += 1;
      continue;
    }
    const before = records[job.id];
    const adopting = plan.steps[0] !== null && !plan.release;
    if (adopting && input.target) {
      // Written BEFORE the first update: one core takes but whose answer is
      // lost (a timeout, a restart) is still known as the box's own next time
      // — a model-less job pinned to its default is cleared, not kept pinned.
      records[job.id] = {
        profileId: input.target.profileId,
        authorization: input.target.authorization,
        inherits: plan.inherits,
        model: plan.steps[0],
        original: plan.original,
        revision: null,
        at: now,
        ...(before?.retriedAt !== undefined ? { retriedAt: before.retriedAt } : {}),
      };
      await save();
    }
    let model: string | null = job.model;
    let revision: string | null = job.revision;
    let landed = 0;
    for (const step of plan.steps) {
      try {
        const reply = await deps.call("cron.update", {
          id: job.id,
          ...(revision ? { expectedConfigRevision: revision } : {}),
          patch: { payload: { kind: "agentTurn", model: step } },
        });
        model = step;
        revision = revisionOf(reply);
        landed += 1;
      } catch (err) {
        refusedAt.set(job.id, { at: now, count: (refusedAt.get(job.id)?.count ?? 0) + 1 });
        console.error(`[anthropic-cron-binding] core did not take automation ${job.id}'s account (${step === null ? "clearing the model" : step}):`, err instanceof Error ? err.message : err);
        break;
      }
    }
    if (landed === plan.steps.length) refusedAt.delete(job.id);
    else result.owed += 1;
    if (plan.release) {
      if (landed === plan.steps.length) {
        delete records[job.id];
        dirty = true;
        result.released += 1;
      }
      continue;
    }
    // Nothing core took — or nothing it said it took. An adoption's
    // provisional record stays: had the first step landed unseen, the job's
    // model now matches it and the next pass finishes from there; had it not,
    // the job does not match and is planned whole again. A clear's record is
    // left as it was.
    if (landed === 0) continue;
    if (adopting) result.bound += 1;
    const base = records[job.id] ?? before;
    records[job.id] = {
      profileId: adopting && input.target ? input.target.profileId : (base?.profileId ?? input.target?.profileId ?? ""),
      authorization: adopting && input.target ? input.target.authorization : (base?.authorization ?? input.target?.authorization ?? null),
      inherits: plan.inherits,
      model,
      original: plan.original,
      revision,
      at: adopting ? now : (base?.at ?? now),
      ...(base?.retriedAt !== undefined ? { retriedAt: base.retriedAt } : {}),
    };
    dirty = true;
    if (plan.retry && adopting) {
      // Once in a window, whether or not core starts it: a run that keeps
      // failing is not forced again every minute.
      records[job.id].retriedAt = now;
      try {
        await deps.call("cron.run", { id: job.id, mode: "force" });
        result.rerun += 1;
      } catch (err) {
        console.error(`[anthropic-cron-binding] could not run automation ${job.id} again after adopting its account:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (dirty) await save();
  if (result.bound > 0 || result.owed > 0 || result.released > 0) {
    const on = input.target ? `on ${input.target.profileId}` : "given back";
    console.error(`[anthropic-cron-binding] ${result.bound + result.released} automation(s) ${on}${result.owed > 0 ? `, ${result.owed} still owed` : ""}${result.rerun > 0 ? `, ${result.rerun} lost run(s) started again` : ""}`);
  }
  return result;
}
