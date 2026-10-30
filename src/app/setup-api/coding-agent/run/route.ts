import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasPersonSession } from "@/lib/owner-session";
import { CodingAgentError, ExperienceChoiceError, MAX_TASK_CHARS, ProviderChoiceError, httpStatusForCodingError, newRunId, startOrQueueRun } from "@/lib/coding-agent";
import { effortRefusal, isOfferedEffort } from "@/lib/coding-effort";
import { pushPendingAction } from "@/lib/pending-actions";

export const dynamic = "force-dynamic";

/**
 * POST { task, projectId? | directory?, resumeRunId?, provider?, model?,
 * effort?, deliverable?, inputs?, experience?, fixCi? } → start a coding run.
 *
 * `effort` is the per-request override of the owner's effort setting
 * (Settings → Coding Agent): one of OFFERED_EFFORT_LEVELS (`low`, `xhigh`,
 * `max`, `ultracode`), validated HERE — 400 `invalid` with `code: "effort"`
 * naming the levels — and again in `startRun`, where it stands in for the
 * owner's setting and nothing more: a reading role's cap and the read-only
 * clamp still apply after it. The Create card's Ultracode toggle asks the
 * assistant to pass it (`coding_agent_run`'s `effort`).
 *
 * `fixCi: true` with `resumeRunId` is a "Fix CI" continuation: the run named
 * had its pull request fail its checks (the record's `ci`), and the box
 * appends what failed — the checks, the failing tests, the files, the tail of
 * the failed jobs' logs — to `task`. Refused (400 `invalid`) without such a
 * failure on record, for a failure a Fix CI was already started from, and past
 * the chain's MAX_CI_FIX_ATTEMPTS.
 *
 * `experience` is what the training cluster's dispatcher selected from its
 * experience store for this task — exactly the JSON its
 * `scripts/query-store.mjs` prints, `{ rules: [{ id, rule, applies, evidence?,
 * score? }], skill? }`. The box renders it into the run's system prompt as a
 * delimited block (src/lib/coding-experience.ts) and records which rules
 * reached it on the run as `experience: { ruleIds, skill, chars }`. A
 * malformed one is 400 `invalid` with a `code`; absent or null, the run starts
 * exactly as it did before the field existed. A resume without one carries
 * the block of the run it resumes.
 *
 * `inputs` names files this run is to be given — the pictures the assistant
 * generated for the task, an attachment that arrived in chat. The device copies
 * them into a folder the run may read (src/lib/coding-run-inputs.ts), because
 * the assistant's own media tree sits inside a credential store denied to every
 * run. A path the box will not copy costs that asset and nothing else: the
 * answer's run record carries what landed and what did not.
 *
 * `provider` and `model` are the per-run override of the owner's default
 * account (Settings → Coding Agent). They are validated together, by the one
 * resolver the MCP tool also uses (src/lib/coding-provider.ts), so a model the
 * box would refuse is refused in the same words wherever it arrives — 400,
 * naming what may be used instead. A run against a provider with no credential
 * is 409 `not_ready`, the same answer a missing harness gives, because both
 * are a sentence for the owner rather than something to retry.
 *
 * Answers 202 immediately with the run record; the work continues in the
 * background and is polled through GET /setup-api/coding-agent/runs. When the
 * box is already running every run the owner allows, the run is QUEUED rather
 * than refused (`startOrQueueRun`): 202 `{ started: false, queued: true, run }`,
 * the record in status `queued` with its `queued.position`, started by the box
 * itself in order as runs end — across a restart too. The MCP
 * client's default timeout is 8 s and OpenClaw reaps the MCP process after
 * ten idle minutes, so holding this request open for the run was never an
 * option.
 *
 * Agent-callable (bearer or cookie), but re-checked in-handler: starting a
 * process that edits files is a state change, and TASK-443's rule is that
 * every such route carries its own gate. The owner's consent is the switch
 * this route enforces — when it is off the answer is 409 (see
 * httpStatusForCodingError for the mapping, and why 409).
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: {
    task?: unknown; projectId?: unknown; directory?: unknown; resumeRunId?: unknown;
    provider?: unknown; model?: unknown; effort?: unknown; deliverable?: unknown;
    inputs?: unknown; experience?: unknown; fixCi?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const task = typeof body.task === "string" ? body.task : "";
  if (!task.trim()) {
    return NextResponse.json({ error: "A task is required.", kind: "invalid" }, { status: 400 });
  }
  if (task.length > MAX_TASK_CHARS) {
    return NextResponse.json(
      { error: `The task is too long: at most ${MAX_TASK_CHARS} characters.`, kind: "invalid" },
      { status: 413 },
    );
  }
  // A level this box does not offer is refused before anything is read or
  // held, with a `code` so the MCP tool advises on the right argument.
  if (body.effort !== undefined && body.effort !== null && !isOfferedEffort(body.effort)) {
    return NextResponse.json({ error: effortRefusal(body.effort), kind: "invalid", code: "effort" }, { status: 400 });
  }

  // Who is asking decides how the run is labelled, nothing more: an owner
  // clicking in Settings holds a cookie, the agent holds the bearer.
  const source = (await hasPersonSession(request)) ? "owner" : "agent";

  // The id the run will carry, named now: the runs list shows this start
  // under it from this moment (startOrQueueRun announces it before its first
  // await), and every open desktop is told at once — before the worktree, the
  // account and the spawn, which used to be all the owner waited through with
  // nothing on screen. The desktop only nudges its poll on it.
  const runId = newRunId();
  notifyDesktop({ type: "coding_run", phase: "starting", runId }, `coding-run-start:${runId}`);

  try {
    const { run, queued } = await startOrQueueRun({
      runId,
      task,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
      resumeRunId: typeof body.resumeRunId === "string" ? body.resumeRunId : null,
      // Passed through untouched: startRun validates the pair, so this route
      // cannot accept a combination the MCP tool would refuse, or the reverse.
      provider: body.provider,
      model: body.model,
      // Validated above; `startRun` checks it once more and applies it where
      // the owner's effort is read, before the role caps and the read-only clamp.
      ...(body.effort !== undefined && body.effort !== null ? { effort: body.effort } : {}),
      source,
      // Passed through unvalidated ON PURPOSE: `startRun` reads it through the
      // one reader (`readDeliverableInput`), which is also what the draft route
      // uses, and throws `invalid` with the reason — so the two routes cannot
      // disagree about what this box accepts. `source` is what decides whether a
      // `command` deliverable is allowed; it is derived above from the owner's
      // cookie, never from the body.
      deliverable: body.deliverable,
      // Absolute paths of files this run is to be GIVEN. Passed through
      // unvalidated for the reason `deliverable` is: `startRun` reads the list
      // through the one reader and judges each path on its own, answering a
      // coded refusal per entry rather than losing the task over one of them.
      // The assistant needs this because it writes its generated media inside
      // its own state directory, which no run may read.
      inputs: body.inputs,
      // Unvalidated for the reason `deliverable` is: `startRun` reads it through
      // `readExperienceInput`, which refuses with a stable code, so nothing a
      // caller sent reaches the run's prompt before that reader has passed it.
      experience: body.experience,
      // Only ever `true` or absent: what failed is the box's to append, from
      // its own record of the named run — never the caller's.
      ...(body.fixCi === true ? { fixCi: true } : {}),
    });
    // Every open desktop hears that a run began — the ROUTE says so, not the
    // MCP tool, so a run started from another device, the owner's own click
    // or the review pass shows up as a chat card within one poll. The
    // desktop only nudges its poll on it; the run record stays the truth.
    notifyDesktop(
      { type: "coding_run", phase: queued ? "queued" : "started", runId: run.id, projectId: run.projectId, ...(run.team ? { teamId: run.team.id } : {}) },
      `coding-run:${run.id}`,
    );
    return NextResponse.json({ started: !queued, queued, run }, { status: 202 });
  } catch (err) {
    // The start the desktops were told of will not happen: they re-read, and
    // the runs list's `starting` says why (startOrQueueRun listed it failed).
    notifyDesktop({ type: "coding_run", phase: "failed", runId }, `coding-run-failed:${runId}`);
    if (err instanceof CodingAgentError) {
      // The provider/model refusal carries a `code` beside the shared 400, so a
      // caller can tell "that pair is not on this box" from "that folder is not
      // allowed" — both are `kind: "invalid"`, and the MCP tool advises on the
      // wrong argument without it. Anything else answers exactly as before.
      const code = err instanceof ProviderChoiceError || err instanceof ExperienceChoiceError
        ? { code: err.code }
        : {};
      return NextResponse.json({ error: err.message, kind: err.kind, ...code }, { status: httpStatusForCodingError(err.kind) });
    }
    console.error("[coding-agent/run] failed to start:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not start the coding run" },
      { status: 500 },
    );
  }
}

/** One notice on the desktop ring, fire-and-forget: a notice that fails is logged, never the start's failure. */
function notifyDesktop(action: Record<string, unknown>, id: string): void {
  void pushPendingAction(action, id).catch((err: unknown) => {
    console.error("[coding-agent/run] desktop notice failed:", err instanceof Error ? err.message : err);
  });
}
