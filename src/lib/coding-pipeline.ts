/**
 * The delivery pipeline: prompt → build → review → improvement → deploy a
 * preview → verify it → deploy production → verify it → done.
 *
 * WHAT THIS IS FOR. Every stage of that already existed on this box and each
 * one ended on its own: a run settled, the automatic review pass settled, a
 * deployment settled, and nothing joined them up. The owner asked for the whole
 * thing to run "auto from start to finish" (2026-09-13), which is not another
 * stage — it is the ORDER, the evidence at each step, and one honest answer at
 * the end.
 *
 * WHAT IS PURE HERE, AND WHY. This module is the machine and nothing else: no
 * `fs`, no `child_process`, no `fetch`. The run page imports it to draw the
 * stage strip, the MCP server imports it to report a stage, and the driver in
 * ./coding-agent imports it to decide what happens next — three consumers that
 * must agree exactly about what "improvement failed" means. The side-effecting
 * halves are ./coding-pipeline-verify (the looking) and the driver (the doing),
 * split the way ./coding-deliverable and ./coding-deliverable-check are split,
 * for the same reason: a client component that imported `fs` fails the build.
 *
 * THE ONE RULE THE WHOLE THING EXISTS FOR. A pipeline is `complete` only when
 * the last verification PASSED. Not when a model said it was done, not when
 * Vercel answered `READY`, and not when a stage could not be checked. Every
 * transition below is written so that the only path to `complete` runs through
 * a verification this box made itself.
 */

/**
 * The stages, in the order the owner named them.
 *
 * A list rather than a union written by hand, for the reason `RUN_STATUSES` is
 * one: the type is derived from it, the persisted allow-list is it, and the
 * strip the app draws is it. A stage added to one and not the other used to be
 * exactly the shape of the bug that silently dropped records.
 */
export const PIPELINE_STAGES = [
  "build",
  "review",
  "improvement",
  "deploy_preview",
  "verify_preview",
  "deploy_production",
  "verify_production",
  "complete",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * What one stage is doing.
 *
 * `skipped` and `failed` are deliberately different endings and neither is
 * `passed`: a review that found nothing to fix SKIPS improvement, and saying
 * "passed" over a stage that never ran would be the box claiming work it did
 * not do. `waiting_owner` is the production gate and only ever that.
 */
export const PIPELINE_STAGE_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "waiting_owner",
] as const;

export type PipelineStageState = (typeof PIPELINE_STAGE_STATES)[number];

export function isPipelineStageState(value: unknown): value is PipelineStageState {
  return typeof value === "string" && (PIPELINE_STAGE_STATES as readonly string[]).includes(value);
}

/**
 * The pipeline as a whole.
 *
 * `blocked` is its own ending and not a kind of `failed`: it means the box
 * could not run a stage because something is not set up (no Vercel project
 * attached, a token it cannot open, no way to check a page), which is the
 * owner's to fix and says nothing about the work. `failed` means a stage ran
 * and did not pass.
 */
export const PIPELINE_STATUSES = ["running", "waiting_owner", "complete", "failed", "blocked", "stopped"] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return typeof value === "string" && (PIPELINE_STATUSES as readonly string[]).includes(value);
}

/** Over, one way or another — nothing else will happen on its own. */
export function isPipelineSettled(status: PipelineStatus): boolean {
  return status === "complete" || status === "failed" || status === "blocked" || status === "stopped";
}

/** Still this box's to carry on with, or the owner's to press a button on. */
export function isPipelineLive(pipeline: PipelineState | null | undefined): boolean {
  return pipeline != null && !isPipelineSettled(pipeline.status);
}

/**
 * One thing a stage left behind.
 *
 * `ref` is a handle a surface can act on — a run id, a deployment id, a URL, an
 * evidence file's name — and `detail` is the sentence beside it. Both bounded,
 * because the run record is read back on every boot and polled by two UIs, and
 * a stage that recorded a build log would become a megabyte of run record.
 */
export interface PipelineEvidence {
  kind: "run" | "deployment" | "url" | "screenshot" | "note";
  ref: string | null;
  detail: string;
  at: number;
}

export const EVIDENCE_KINDS: readonly PipelineEvidence["kind"][] = ["run", "deployment", "url", "screenshot", "note"];

/** The longest sentence a stage or a piece of evidence will carry. */
export const MAX_PIPELINE_DETAIL_CHARS = 400;
/** The longest handle: a URL is the biggest of them. */
export const MAX_PIPELINE_REF_CHARS = 512;
/** Per stage, newest last. A verification files a screenshot and a note each lap. */
export const MAX_EVIDENCE_PER_STAGE = 12;

export interface PipelineStep {
  stage: PipelineStage;
  state: PipelineStageState;
  /** How many times this stage has been ENTERED. The loop's own counter is `round`. */
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** What happened, or why it did not. The owner's sentence, never a stack. */
  detail: string | null;
  evidence: PipelineEvidence[];
}

/**
 * What a verification LOOKS FOR.
 *
 * `expect` is the hard half: literal strings that must appear in what the
 * deployed page answered. When the caller named none, the screenshot's written
 * description is judged against the task instead (see ./coding-pipeline-verify)
 * — weaker, and the record says which of the two decided, because "the page
 * contains the word Invoice" and "a model thought the page looked right" are
 * not the same claim and must never be drawn as one.
 */
export interface PipelineVerify {
  /** The path fetched on the deployment. Always starts with "/". */
  path: string;
  expect: string[];
}

/** As many literal expectations as one verification will carry. */
export const MAX_EXPECTATIONS = 8;
export const MAX_EXPECTATION_CHARS = 200;
export const MAX_VERIFY_PATH_CHARS = 512;


/**
 * What a verification SAW — the types, here in the pure half.
 *
 * The looking itself is ./coding-pipeline-verify, which cannot be imported by a
 * client component (it reaches for `fs` and Playwright). The run page draws
 * this, so the shape has to live where the page can read it — the same split
 * ./coding-deliverable and ./coding-deliverable-check are written with.
 */

/** What decided the verdict: the caller's literal strings, or the vision model. */
export type VerificationJudge = "expectations" | "vision" | "none";

export interface VerificationExpectation {
  text: string;
  found: boolean;
}

export interface PipelineVerification {
  ok: boolean;
  /** The address that was actually fetched, path included. */
  url: string;
  /** What it answered, or null when the request never got a reply. */
  status: number | null;
  /** Why it failed, in the owner's-facing words. Null when it passed. */
  reason: string | null;
  /**
   * True when the page could not be CHECKED at all because something is gating
   * it — today, Vercel's own Deployment Protection login wall.
   *
   * Its own fact and not a kind of failure, because the two need opposite
   * things done: a page that is wrong goes back for improvement, while a page
   * nobody may see is a setting in the owner's Vercel account that no amount of
   * editing this folder fixes. Optional so a record written before this field
   * existed reads as "not blocked", which is what it was.
   */
  blocked?: boolean;
  judgedBy: VerificationJudge;
  expectations: VerificationExpectation[];
  /** The vision model's verdict, when it was asked. */
  vision: { verdict: "yes" | "no" | "unknown"; description: string | null; error: string | null } | null;
  /** The screenshot's file name in the run's evidence folder, when one was taken. */
  screenshot: string | null;
  checkedAt: number;
}

export function isVerificationJudge(value: unknown): value is VerificationJudge {
  return value === "expectations" || value === "vision" || value === "none";
}

/** Read a verification off an untrusted record, or null. Strict, like every parser here. */
export function parseVerification(raw: unknown): PipelineVerification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.ok !== "boolean" || typeof v.url !== "string" || !isVerificationJudge(v.judgedBy)) return null;
  const visionRaw = typeof v.vision === "object" && v.vision !== null ? (v.vision as Record<string, unknown>) : null;
  const verdict = visionRaw?.verdict;
  return {
    ok: v.ok,
    url: v.url.slice(0, MAX_PIPELINE_REF_CHARS),
    status: typeof v.status === "number" && Number.isFinite(v.status) ? v.status : null,
    reason: typeof v.reason === "string" ? v.reason.slice(0, MAX_PIPELINE_DETAIL_CHARS) : null,
    blocked: v.blocked === true,
    judgedBy: v.judgedBy,
    expectations: Array.isArray(v.expectations)
      ? v.expectations
        .filter((e): e is { text: string; found: boolean } =>
          typeof e === "object" && e !== null
          && typeof (e as Record<string, unknown>).text === "string"
          && typeof (e as Record<string, unknown>).found === "boolean")
        .slice(0, MAX_EXPECTATIONS)
        .map((e) => ({ text: e.text.slice(0, MAX_EXPECTATION_CHARS), found: e.found }))
      : [],
    vision: visionRaw && (verdict === "yes" || verdict === "no" || verdict === "unknown")
      ? {
        verdict,
        description: typeof visionRaw.description === "string" ? visionRaw.description.slice(0, MAX_PIPELINE_DETAIL_CHARS) : null,
        error: typeof visionRaw.error === "string" ? visionRaw.error.slice(0, MAX_PIPELINE_DETAIL_CHARS) : null,
      }
      : null,
    screenshot: typeof v.screenshot === "string" ? v.screenshot.slice(0, 128) : null,
    checkedAt: typeof v.checkedAt === "number" && Number.isFinite(v.checkedAt) ? v.checkedAt : 0,
  };
}

export interface PipelineState {
  stage: PipelineStage;
  status: PipelineStatus;
  steps: PipelineStep[];
  startedAt: number;
  endedAt: number | null;
  /**
   * How many times the work has been sent back for improvement, and the cap —
   * the owner's review-rounds setting, FROZEN when the pipeline started, for
   * the reason every other run setting is frozen: a loop whose cap moved under
   * it would be a different promise from the one the run started under.
   */
  round: number;
  maxRounds: number;
  /** The wall clock this pipeline may not run past, frozen at the start. */
  deadlineAt: number;
  verify: PipelineVerify;
  /** Does this pipeline go to production at all, or stop at a verified preview? */
  production: boolean;
  /**
   * When the OWNER approved the production deployment, for a pipeline that
   * stopped to ask.
   *
   * On the record rather than in the call that resumes it, because the stage is
   * re-entered by `resumePipelines` after a restart as well: a consent that
   * lived only in a route handler's stack would leave the pipeline asking the
   * per-project switch again and parking a second time, in front of an owner
   * who has already pressed the button.
   */
  productionApprovedAt: number | null;
  /** The stage that ended it, and why, for the one sentence a caller needs. */
  failure: { stage: PipelineStage; reason: string } | null;
  /**
   * Which stage sent the work back for the lap that is running now.
   *
   * RECORDED rather than worked out, because the improvement lap's whole
   * content depends on it — the nudge names this stage, and carries the
   * verification evidence only when a verification is what failed. The first
   * draft searched `steps` for a failed one, which is a guess: it picked the
   * first in stage ORDER (so a lap sent back by a deploy after an earlier
   * failed review was told to fix the review), and it could not tell a
   * verification belonging to THIS lap from one left on the record by the last.
   *
   * Null before the first lap and on a pipeline that never looped.
   */
  sentBackFrom: { stage: PipelineStage; reason: string } | null;
  /**
   * What the last verification saw — the whole of it, not a summary.
   *
   * Kept on the state rather than only as a piece of evidence because the
   * improvement lap is built from it: which expectations were missing, what the
   * page answered, and what the screenshot showed are exactly the facts a
   * harness needs and a one-line evidence detail has already thrown away.
   */
  lastVerification: PipelineVerification | null;
}

/**
 * How long a pipeline may run, wall clock, from the moment it started.
 *
 * Six hours: a build, a review pass, up to a few improvement laps and two
 * deployments on a Jetson, with room for a slow Vercel queue — and short
 * enough that a pipeline whose stage somehow never settles is over by the end
 * of the day rather than polling for a week. Checked at EVERY transition, so a
 * pipeline cannot pass it by standing still.
 */
export const PIPELINE_MAX_WALL_MS = 6 * 60 * 60_000;

/**
 * How many times one stage may be entered before the pipeline gives up on it.
 *
 * The second cap, and it is not the same as `maxRounds`: rounds bound the
 * review↔improvement LOOP, this bounds any single stage being re-entered — a
 * deployment that keeps being retried, a verification re-run by a restart. A
 * belt for the braces, so no arrangement of transitions can spin.
 */
export const MAX_STAGE_ATTEMPTS = 4;

/** What a stage did, as the driver reports it back. */
export type StageOutcome =
  | { kind: "passed"; detail?: string | null }
  | { kind: "skipped"; detail: string }
  /** The stage ran and did not pass. Whether that loops back is the machine's to say. */
  | { kind: "failed"; reason: string }
  /** The box could not run the stage at all — not configured, not reachable. */
  | { kind: "blocked"; reason: string }
  /** Only ever the production gate: the owner's switch is off. */
  | { kind: "waiting_owner"; reason: string };

/** What the driver should do next, once the machine has decided. */
export type PipelineTransition =
  | { action: "enter"; stage: PipelineStage }
  | { action: "wait" }
  | { action: "settled"; status: PipelineStatus };

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A step in its "never entered" shape. */
function blankStep(stage: PipelineStage): PipelineStep {
  return { stage, state: "pending", attempt: 0, startedAt: null, endedAt: null, detail: null, evidence: [] };
}

/** The steps a fresh pipeline starts with — one per stage, in order. */
export function blankSteps(): PipelineStep[] {
  return PIPELINE_STAGES.map(blankStep);
}

/** The step for `stage`, made if a record from an older build has none. */
export function stepFor(pipeline: PipelineState, stage: PipelineStage): PipelineStep {
  const found = pipeline.steps.find((s) => s.stage === stage);
  if (found) return found;
  const made = blankStep(stage);
  pipeline.steps.push(made);
  return made;
}

/**
 * Start a pipeline.
 *
 * `maxRounds` and `deadlineAt` are settled here and never read again from the
 * settings, which is the freezing this module's header promises.
 */
export function newPipeline(input: {
  verify: PipelineVerify;
  production: boolean;
  maxRounds: number;
  now?: number;
}): PipelineState {
  const now = input.now ?? Date.now();
  return {
    stage: "build",
    status: "running",
    steps: blankSteps(),
    startedAt: now,
    endedAt: null,
    round: 0,
    maxRounds: Math.max(0, Math.floor(input.maxRounds)),
    deadlineAt: now + PIPELINE_MAX_WALL_MS,
    verify: { path: input.verify.path, expect: [...input.verify.expect] },
    production: input.production,
    failure: null,
    sentBackFrom: null,
    productionApprovedAt: null,
    lastVerification: null,
  };
}

/** Mark a stage as begun. Bumps `attempt`, which is what MAX_STAGE_ATTEMPTS counts. */
export function enterStage(pipeline: PipelineState, stage: PipelineStage, now = Date.now()): PipelineStep {
  const step = stepFor(pipeline, stage);
  step.state = "running";
  step.attempt += 1;
  step.startedAt = step.startedAt ?? now;
  step.endedAt = null;
  step.detail = null;
  pipeline.stage = stage;
  return step;
}

/** File a piece of evidence against a stage, bounded and flattened. */
export function addEvidence(
  pipeline: PipelineState,
  stage: PipelineStage,
  evidence: Omit<PipelineEvidence, "at"> & { at?: number },
): void {
  const step = stepFor(pipeline, stage);
  step.evidence.push({
    kind: evidence.kind,
    ref: evidence.ref === null ? null : clamp(evidence.ref, MAX_PIPELINE_REF_CHARS),
    detail: clamp(evidence.detail, MAX_PIPELINE_DETAIL_CHARS),
    at: evidence.at ?? Date.now(),
  });
  if (step.evidence.length > MAX_EVIDENCE_PER_STAGE) {
    // The OLDEST go: the newest lap is the one a reader is looking at, and a
    // stage re-entered four times would otherwise show only its first attempt.
    step.evidence.splice(0, step.evidence.length - MAX_EVIDENCE_PER_STAGE);
  }
}

/**
 * The whole of the pipeline's decision-making: what one stage's outcome means.
 *
 * Written as ONE function taking the current state and an outcome, so every
 * path to an ending is visible in one place and the unit tests can walk them
 * without a run, a deployment or a Vercel account.
 *
 * THE ROUTING, AND THE ONE ASYMMETRY IN IT. A preview that will not build, or
 * one that builds and does not show what was asked for, goes back to
 * `improvement` — that is the loop the owner asked for, and the reason the
 * build log tail and the verification evidence are carried back with it. A
 * PRODUCTION stage that fails does NOT loop: it ends the pipeline, named. The
 * asymmetry is deliberate and is about what a retry COSTS. A preview is a
 * throwaway address; production is the project's own domain in front of whoever
 * uses it, and a box that answered a failed production deploy by building that
 * domain again, and again, would be spending the owner's standing permission on
 * a guess. The work is on disk, the reason is on the record, and Resume is one
 * press.
 */
export function decidePipeline(
  pipeline: PipelineState,
  stage: PipelineStage,
  outcome: StageOutcome,
  now = Date.now(),
): PipelineTransition {
  // The wall clock, first and on every transition — including the ones that
  // would have passed. A pipeline past its budget is over whatever the stage
  // just said, because the next stage would start outside it.
  if (now > pipeline.deadlineAt) {
    return fail(pipeline, stage, `The pipeline ran out of its ${Math.round(PIPELINE_MAX_WALL_MS / 3_600_000)}-hour budget at the ${stageNoun(stage)} stage.`, now);
  }

  if (outcome.kind === "blocked") {
    const step = stepFor(pipeline, stage);
    step.state = "failed";
    step.endedAt = now;
    step.detail = clamp(outcome.reason, MAX_PIPELINE_DETAIL_CHARS);
    pipeline.status = "blocked";
    pipeline.endedAt = now;
    pipeline.failure = { stage, reason: step.detail };
    return { action: "settled", status: "blocked" };
  }

  if (outcome.kind === "waiting_owner") {
    const step = stepFor(pipeline, stage);
    step.state = "waiting_owner";
    step.endedAt = null;
    step.detail = clamp(outcome.reason, MAX_PIPELINE_DETAIL_CHARS);
    pipeline.status = "waiting_owner";
    return { action: "wait" };
  }

  if (outcome.kind === "skipped") {
    const step = stepFor(pipeline, stage);
    step.state = "skipped";
    step.endedAt = now;
    step.detail = clamp(outcome.detail, MAX_PIPELINE_DETAIL_CHARS);
    return next(pipeline, afterPass(pipeline, stage), now);
  }

  if (outcome.kind === "passed") {
    const step = stepFor(pipeline, stage);
    step.state = "passed";
    step.endedAt = now;
    step.detail = outcome.detail ? clamp(outcome.detail, MAX_PIPELINE_DETAIL_CHARS) : null;
    const after = afterPass(pipeline, stage);
    if (after === "complete") {
      stepFor(pipeline, "complete").state = "passed";
      stepFor(pipeline, "complete").startedAt = now;
      stepFor(pipeline, "complete").endedAt = now;
      pipeline.stage = "complete";
      pipeline.status = "complete";
      pipeline.endedAt = now;
      return { action: "settled", status: "complete" };
    }
    return next(pipeline, after, now);
  }

  // Failed.
  const step = stepFor(pipeline, stage);
  step.state = "failed";
  step.endedAt = now;
  step.detail = clamp(outcome.reason, MAX_PIPELINE_DETAIL_CHARS);

  if (!loopsBack(stage)) {
    return fail(pipeline, stage, step.detail, now);
  }
  if (pipeline.round >= pipeline.maxRounds) {
    // The EXPLANATION is what this sentence exists for, so it is what must
    // survive: `step.detail` is already at the cap, and appending to it put the
    // whole "that was the last round" half past the clamp — leaving the owner a
    // failure with no reason why the box stopped trying.
    const why = pipeline.maxRounds === 0
      ? "No improvement rounds are allowed on this ClawBox, so it was not sent back."
      : `That was the last of ${pipeline.maxRounds} improvement round(s).`;
    const room = MAX_PIPELINE_DETAIL_CHARS - why.length - 1;
    return fail(pipeline, stage, `${clamp(step.detail ?? "", Math.max(0, room))} ${why}`.trim(), now);
  }
  pipeline.round += 1;
  pipeline.sentBackFrom = { stage, reason: step.detail };
  return next(pipeline, "improvement", now);
}

/**
 * Which failures are the loop's, and which end it.
 *
 * `build` is not one: a run that failed outright has no work to improve, and
 * the harness's own retry has already had its go. `improvement` is not one
 * either — a fix turn that could not run is not fixed by another fix turn.
 * Production is not one, for the reason `decidePipeline`'s header gives.
 */
function loopsBack(stage: PipelineStage): boolean {
  return stage === "review" || stage === "deploy_preview" || stage === "verify_preview";
}

/** The stage that follows a stage that PASSED (or was skipped). */
function afterPass(pipeline: PipelineState, stage: PipelineStage): PipelineStage {
  switch (stage) {
    case "build": return "review";
    // The loop's other half: an improvement lap is reviewed before it is
    // deployed, which is what "loops back to review" means.
    case "improvement": return "review";
    case "review": return "deploy_preview";
    case "deploy_preview": return "verify_preview";
    case "verify_preview": return pipeline.production ? "deploy_production" : "complete";
    case "deploy_production": return "verify_production";
    case "verify_production": return "complete";
    case "complete": return "complete";
  }
}

/** Enter the next stage, unless it has been entered too many times already. */
function next(pipeline: PipelineState, stage: PipelineStage, now: number): PipelineTransition {
  const step = stepFor(pipeline, stage);
  if (step.attempt >= MAX_STAGE_ATTEMPTS) {
    return fail(pipeline, stage, `The ${stageNoun(stage)} stage was tried ${step.attempt} times and this ClawBox stopped there.`, now);
  }
  pipeline.stage = stage;
  // Left `pending`: the DRIVER marks it running when it has actually started
  // the stage, because a stage recorded as running that nothing is doing is
  // exactly what a restart cannot tell from one that is.
  return { action: "enter", stage };
}

function fail(pipeline: PipelineState, stage: PipelineStage, reason: string, now: number): PipelineTransition {
  const said = clamp(reason, MAX_PIPELINE_DETAIL_CHARS);
  const step = stepFor(pipeline, stage);
  if (step.state !== "failed") {
    step.state = "failed";
    step.endedAt = now;
    step.detail = said;
  }
  pipeline.stage = stage;
  pipeline.status = "failed";
  pipeline.endedAt = now;
  pipeline.failure = { stage, reason: said };
  return { action: "settled", status: "failed" };
}

/**
 * The stage's name in English, for the sentences this module writes.
 *
 * English on purpose and not a locale key: these end up in `failure.reason`,
 * which the MCP server reads back to an agent and which is the floor the app
 * falls through to. The app words the STAGE itself from `PIPELINE_STAGES` in
 * the owner's language (see `codingAgent.pipelineStage.*`), so nothing a
 * person reads depends on this string.
 */
export function stageNoun(stage: PipelineStage): string {
  switch (stage) {
    case "build": return "build";
    case "review": return "review";
    case "improvement": return "improvement";
    case "deploy_preview": return "preview deployment";
    case "verify_preview": return "preview verification";
    case "deploy_production": return "production deployment";
    case "verify_production": return "production verification";
    case "complete": return "completion";
  }
}

/** End a live pipeline because the owner ended the run. */
export function stopPipeline(pipeline: PipelineState, reason: string, now = Date.now()): void {
  if (isPipelineSettled(pipeline.status)) return;
  const step = stepFor(pipeline, pipeline.stage);
  if (step.state === "running" || step.state === "waiting_owner") {
    step.state = "failed";
    step.endedAt = now;
    step.detail = clamp(reason, MAX_PIPELINE_DETAIL_CHARS);
  }
  pipeline.status = "stopped";
  pipeline.endedAt = now;
  pipeline.failure = { stage: pipeline.stage, reason: clamp(reason, MAX_PIPELINE_DETAIL_CHARS) };
}

// ─── What a caller may ask for, and what comes back off disk ────────────────

/** Why a pipeline request was refused, with a stable code beside the sentence. */
export type PipelineInputRefusal =
  | "not_an_object"
  | "bad_path"
  | "bad_expect"
  | "too_many_expect"
  | "bad_production";

export interface PipelineInput {
  verify: PipelineVerify;
  production: boolean;
}

/**
 * What a caller asked for: nothing, a refusal, or a pipeline.
 *
 * A RESULT rather than a throw, the shape `readDeliverableInput` answers in and
 * for its reason: this is read inside `startRun`, whose caller maps a refusal
 * to a 400 with the code beside it, and an exception type would have to be
 * caught and translated at every door instead.
 */
export type PipelineInputResult =
  | null
  | { ok: false; code: PipelineInputRefusal; error: string }
  | { ok: true; pipeline: PipelineInput };

/** What a caller gets when they ask for a pipeline and say nothing else. */
export function defaultPipelineInput(): PipelineInput {
  return { verify: { path: "/", expect: [] }, production: true };
}

function refusePipelineInput(code: PipelineInputRefusal, error: string): PipelineInputResult {
  return { ok: false, code, error };
}

/**
 * Read a caller's pipeline request.
 *
 * Refuses with a stable code rather than repairing, the rule this codebase
 * holds every caller-facing parser to: a bar this box cannot honour is refused
 * at the door, so the caller learns what was wrong instead of getting a
 * pipeline that checks something else. `true` is the shorthand for "the usual
 * one"; `null`/`undefined` means the caller said nothing at all, which is what
 * lets the project's own default decide.
 */
export function readPipelineInput(raw: unknown): PipelineInputResult {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { ok: true, pipeline: defaultPipelineInput() };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return refusePipelineInput("not_an_object", "A delivery pipeline is either true or an object saying what to check.");
  }
  const v = raw as Record<string, unknown>;
  if (v.enabled === false) return null;

  let path = "/";
  if (v.path !== undefined && v.path !== null) {
    if (typeof v.path !== "string") {
      return refusePipelineInput("bad_path", "The path to check is a string like \"/\" or \"/invoices\".");
    }
    const trimmed = v.path.trim();
    if (trimmed && !trimmed.startsWith("/")) {
      return refusePipelineInput("bad_path", "The path to check has to start with \"/\" — it is a path on the deployment, not a whole address.");
    }
    // `//other.example/` starts with a slash and IS a whole address once it is
    // resolved against an origin, so a verification would have gone looking at
    // somebody else's site and judged the owner's deployment on what it found.
    if (trimmed.startsWith("//")) {
      return refusePipelineInput("bad_path", "The path to check is a path on the deployment, not an address of its own.");
    }
    if (trimmed.length > MAX_VERIFY_PATH_CHARS) {
      return refusePipelineInput("bad_path", `That path is longer than ${MAX_VERIFY_PATH_CHARS} characters.`);
    }
    path = trimmed || "/";
  }

  const expect: string[] = [];
  if (v.expect !== undefined && v.expect !== null) {
    if (!Array.isArray(v.expect)) {
      return refusePipelineInput("bad_expect", "What to look for is a list of strings the page must contain.");
    }
    if (v.expect.length > MAX_EXPECTATIONS) {
      return refusePipelineInput("too_many_expect", `A verification checks at most ${MAX_EXPECTATIONS} things.`);
    }
    for (const item of v.expect) {
      if (typeof item !== "string" || !item.trim()) {
        return refusePipelineInput("bad_expect", "Each thing to look for is a non-empty string.");
      }
      if (item.length > MAX_EXPECTATION_CHARS) {
        return refusePipelineInput("bad_expect", `Each thing to look for is at most ${MAX_EXPECTATION_CHARS} characters.`);
      }
      expect.push(item.trim());
    }
  }

  let production = true;
  if (v.production !== undefined && v.production !== null) {
    if (typeof v.production !== "boolean") {
      return refusePipelineInput("bad_production", "Whether to go to production is on or off.");
    }
    production = v.production;
  }

  return { ok: true, pipeline: { verify: { path, expect }, production } };
}

function parseEvidence(raw: unknown): PipelineEvidence[] {
  if (!Array.isArray(raw)) return [];
  const out: PipelineEvidence[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.kind !== "string" || !EVIDENCE_KINDS.includes(e.kind as PipelineEvidence["kind"])) continue;
    if (typeof e.detail !== "string") continue;
    out.push({
      kind: e.kind as PipelineEvidence["kind"],
      ref: typeof e.ref === "string" ? clamp(e.ref, MAX_PIPELINE_REF_CHARS) : null,
      detail: clamp(e.detail, MAX_PIPELINE_DETAIL_CHARS),
      at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : 0,
    });
    if (out.length >= MAX_EVIDENCE_PER_STAGE) break;
  }
  return out;
}

function parseStep(raw: unknown): PipelineStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!isPipelineStage(s.stage) || !isPipelineStageState(s.state)) return null;
  return {
    stage: s.stage,
    state: s.state,
    attempt: typeof s.attempt === "number" && Number.isFinite(s.attempt) && s.attempt >= 0 ? Math.floor(s.attempt) : 0,
    startedAt: typeof s.startedAt === "number" && Number.isFinite(s.startedAt) ? s.startedAt : null,
    endedAt: typeof s.endedAt === "number" && Number.isFinite(s.endedAt) ? s.endedAt : null,
    detail: typeof s.detail === "string" ? clamp(s.detail, MAX_PIPELINE_DETAIL_CHARS) : null,
    evidence: parseEvidence(s.evidence),
  };
}

/**
 * Read a pipeline off an untrusted record, or null.
 *
 * Strict, and the ONLY parser, held to `parsePauseReason`'s rule: a
 * hand-edited runs file, or one written by a newer build that added a stage,
 * degrades to "no pipeline" rather than to a pipeline this code cannot drive.
 * A run with no pipeline settles exactly as it always did, which is the safe
 * direction to fall.
 */
export function parsePipeline(raw: unknown): PipelineState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (!isPipelineStage(p.stage) || !isPipelineStatus(p.status)) return null;
  if (typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt)) return null;

  const steps = Array.isArray(p.steps) ? p.steps.map(parseStep).filter((s): s is PipelineStep => s !== null) : [];
  // A stage the record has no step for is filled in as `pending` rather than
  // left out: every reader indexes by stage, and a missing one would be a strip
  // with a hole in it.
  const byStage = new Map(steps.map((s) => [s.stage, s]));
  const merged = PIPELINE_STAGES.map((stage) => byStage.get(stage) ?? blankStep(stage));

  const verifyRaw = typeof p.verify === "object" && p.verify !== null ? (p.verify as Record<string, unknown>) : {};
  const expect = Array.isArray(verifyRaw.expect)
    ? verifyRaw.expect
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, MAX_EXPECTATIONS)
      .map((x) => x.trim().slice(0, MAX_EXPECTATION_CHARS))
    : [];
  // The same cut `readPipelineInput` makes, because a hand-edited record is
  // exactly where a protocol-relative path would be planted.
  const path = typeof verifyRaw.path === "string"
    && verifyRaw.path.startsWith("/")
    && !verifyRaw.path.startsWith("//")
    ? verifyRaw.path.slice(0, MAX_VERIFY_PATH_CHARS)
    : "/";

  const readStageReason = (raw: unknown): { stage: PipelineStage; reason: string } | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const v = raw as Record<string, unknown>;
    return isPipelineStage(v.stage) && typeof v.reason === "string"
      ? { stage: v.stage, reason: clamp(v.reason, MAX_PIPELINE_DETAIL_CHARS) }
      : null;
  };
  const failure = readStageReason(p.failure);
  const sentBack = readStageReason(p.sentBackFrom);

  const startedAt = p.startedAt;
  return {
    stage: p.stage,
    status: p.status,
    steps: merged,
    startedAt,
    endedAt: typeof p.endedAt === "number" && Number.isFinite(p.endedAt) ? p.endedAt : null,
    round: typeof p.round === "number" && Number.isFinite(p.round) && p.round >= 0 ? Math.floor(p.round) : 0,
    maxRounds: typeof p.maxRounds === "number" && Number.isFinite(p.maxRounds) && p.maxRounds >= 0 ? Math.floor(p.maxRounds) : 0,
    // A record with no deadline predates the field, or was hand-edited. The
    // budget is measured from the pipeline's own start either way, which is the
    // honest reading and cannot be extended by rewriting the file.
    deadlineAt: typeof p.deadlineAt === "number" && Number.isFinite(p.deadlineAt)
      ? Math.min(p.deadlineAt, startedAt + PIPELINE_MAX_WALL_MS)
      : startedAt + PIPELINE_MAX_WALL_MS,
    verify: { path, expect },
    production: p.production !== false,
    failure,
    sentBackFrom: sentBack,
    productionApprovedAt: typeof p.productionApprovedAt === "number" && Number.isFinite(p.productionApprovedAt)
      ? p.productionApprovedAt
      : null,
    lastVerification: parseVerification(p.lastVerification),
  };
}

/** A deep copy, for the records the runs list hands out. */
export function clonePipeline(pipeline: PipelineState): PipelineState {
  return {
    ...pipeline,
    steps: pipeline.steps.map((s) => ({ ...s, evidence: s.evidence.map((e) => ({ ...e })) })),
    verify: { path: pipeline.verify.path, expect: [...pipeline.verify.expect] },
    failure: pipeline.failure ? { ...pipeline.failure } : null,
    sentBackFrom: pipeline.sentBackFrom ? { ...pipeline.sentBackFrom } : null,
    lastVerification: pipeline.lastVerification
      ? {
        ...pipeline.lastVerification,
        expectations: pipeline.lastVerification.expectations.map((e) => ({ ...e })),
        vision: pipeline.lastVerification.vision ? { ...pipeline.lastVerification.vision } : null,
      }
      : null,
  };
}

// ─── What the harness is told when the work comes back ──────────────────────

/**
 * The nudge that starts an improvement lap.
 *
 * It lands in the run's OWN session, which still holds everything it did the
 * first time, so it says "do not start over" for the reason `completionNudge`
 * and `buildDeployFeedback` both say it. What it adds is the EVIDENCE: the
 * brief's rule for a failed verification is that the build log tail AND what
 * the check actually saw go back with it, because "the deploy failed" on its
 * own is the sentence a harness cannot act on.
 *
 * It carries no deploy verb and no URL to call, for the reason
 * `buildDeployFeedback` carries none: the box owns the deploying, the run owns
 * the code, and a run that could deploy its own work is a run that could put it
 * in front of a project's users.
 */
export function improvementNudge(input: {
  stage: PipelineStage;
  reason: string;
  round: number;
  maxRounds: number;
  /** The end of the failed build's log, when a deployment is what failed. */
  buildLog?: string | null;
  /** What the check saw, when a verification is what failed. */
  verification?: {
    url: string;
    status: number | null;
    missing: readonly string[];
    description: string | null;
  } | null;
}): string {
  const lines = [
    `The delivery pipeline sent this work back at the ${stageNoun(input.stage)} stage.`,
    "",
    `What went wrong: ${input.reason}`,
  ];

  if (input.verification) {
    const v = input.verification;
    lines.push(
      "",
      "What this ClawBox checked:",
      `- Address: ${v.url}`,
      ...(v.status !== null ? [`- It answered: HTTP ${v.status}`] : ["- It did not answer."]),
      ...(v.missing.length ? [`- Not found on the page: ${v.missing.map((m) => `"${m}"`).join(", ")}`] : []),
      ...(v.description ? ["", "What the page looks like, described from a screenshot:", "", v.description] : []),
    );
  }

  if (input.buildLog && input.buildLog.trim()) {
    lines.push("", "The end of the build log:", "", "```", input.buildLog.trim(), "```");
  }

  lines.push(
    "",
    "Fix the cause in this folder and commit it. This is your own session: do not start the task over,",
    "and do not redo work that already landed.",
    "Do not try to deploy, promote or call Vercel yourself — this ClawBox deploys and checks again by itself once you finish.",
    "If it is not something you can fix from this folder (a missing environment variable on Vercel, a paid feature,",
    "a wrong project setting), do not guess: say exactly what is missing and finish.",
    `This is improvement round ${input.round} of ${input.maxRounds}.`,
  );
  return lines.join("\n");
}
