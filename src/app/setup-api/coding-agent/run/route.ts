import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, ExperienceChoiceError, MAX_TASK_CHARS, PipelineChoiceError, ProviderChoiceError, httpStatusForCodingError, startOrQueueRun } from "@/lib/coding-agent";
import { startTeam } from "@/lib/coding-team";
import { needsTeam } from "@/lib/coding-time-budget";
import { budgetAnswer, resolveStartBudget } from "@/lib/coding-time-budget-server";

export const dynamic = "force-dynamic";

/**
 * What only a single run can carry: a team takes a goal and a folder, so a
 * request naming any of these stays one run even with a long budget, rather
 * than reaching a team that would silently drop the files, the bar or the
 * account it asked for.
 */
const RUN_ONLY_FIELDS = ["inputs", "deliverable", "pipeline", "experience", "provider", "model"] as const;

/** Did the caller actually send this field? An empty list, `false` or `""` is not a request for anything. */
function sent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== "" && !(Array.isArray(v) && v.length === 0);
}

/**
 * POST { task, projectId? | directory?, resumeRunId?, provider?, model?,
 * deliverable?, pipeline?, inputs?, experience?, fixCi?, budget? } → start a
 * coding run — or, for a budget over 30 minutes, a coding TEAM.
 *
 * `budget` is how long the work may take (src/lib/coding-time-budget.ts): a
 * chip ("30m", "1h", "morning", "1d"), a length ("90m"), an end time (ISO
 * 8601; without an offset it is the box's local time), `{ preset: "custom",
 * end, start? }`, or "none" — the object shapes may add a spend ceiling,
 * `tokenCap`, and a budget over two hours without one takes the owner's
 * token cap. It beats a budget the task's words state ("you
 * have 2 hours", "work until tomorrow morning"), which beats the owner's
 * default (`coding_agent_default_budget`, never applied to a resume or a Fix
 * CI). One that is not a budget, ends in the past or is more than 14 days away
 * is 400 `invalid` with `code: "budget"` and a sentence saying what is taken.
 * The answer carries the resolved `timeBudget` (an absolute deadline) when
 * there is one; without one, the run and the answer are exactly as before.
 *
 * A budget LONGER than 30 minutes starts a coding team on the task instead
 * (`startTeam`): 202 `{ started, queued, team, routedToTeam: true, timeBudget }`.
 * Not for a resume or a Fix CI — they continue one run's session — and not for
 * a request carrying something only a run can (RUN_ONLY_FIELDS): that stays
 * one run with its budget, and the answer says so (`routedToTeam: false`,
 * `routeNote`).
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
    provider?: unknown; model?: unknown; deliverable?: unknown; pipeline?: unknown;
    inputs?: unknown; experience?: unknown; fixCi?: unknown; budget?: unknown;
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

  // Who is asking decides how the run is labelled, nothing more: an owner
  // clicking in Settings holds a cookie, the agent holds the bearer.
  const source = (await hasOwnerSession(request)) ? "owner" : "agent";

  // A continuation picks up one run's session: never a team, and never the
  // owner's default — only a budget it is given, or one its words state.
  const continuing = (typeof body.resumeRunId === "string" && body.resumeRunId !== "") || body.fixCi === true;
  const resolved = await resolveStartBudget({ explicit: body.budget, text: task, applyDefault: !continuing });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, kind: "invalid", code: "budget" }, { status: 400 });
  }
  const timeBudget = resolved.budget;
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const directory = typeof body.directory === "string" ? body.directory : null;
  let routeNote: string | null = null;
  if (timeBudget && needsTeam(timeBudget) && !continuing) {
    const runOnly = RUN_ONLY_FIELDS.filter((f) => sent(body[f]));
    if (runOnly.length) {
      routeNote = `A budget over 30 minutes normally starts a coding team, but this request names ${runOnly.join(", ")}, which only a single run carries — so it runs as one run with the budget.`;
    } else {
      try {
        const team = await startTeam({ goal: task, projectId, directory, source, timeBudget });
        const queued = team.status === "queued";
        console.error(`[coding-agent/run] a time budget over 30 minutes: started team ${team.id} instead of a run`);
        return NextResponse.json({ started: !queued, queued, team, routedToTeam: true, ...budgetAnswer(resolved) }, { status: 202 });
      } catch (err) {
        if (err instanceof CodingAgentError) {
          return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
        }
        console.error("[coding-agent/run] failed to start the team:", err instanceof Error ? err.message : err);
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Could not start the coding team" },
          { status: 500 },
        );
      }
    }
  }

  try {
    const { run, queued } = await startOrQueueRun({
      task,
      projectId,
      directory,
      resumeRunId: typeof body.resumeRunId === "string" ? body.resumeRunId : null,
      // Passed through untouched: startRun validates the pair, so this route
      // cannot accept a combination the MCP tool would refuse, or the reverse.
      provider: body.provider,
      model: body.model,
      source,
      // Passed through unvalidated ON PURPOSE: `startRun` reads it through the
      // one reader (`readDeliverableInput`), which is also what the draft route
      // uses, and throws `invalid` with the reason — so the two routes cannot
      // disagree about what this box accepts. `source` is what decides whether a
      // `command` deliverable is allowed; it is derived above from the owner's
      // cookie, never from the body.
      deliverable: body.deliverable,
      // Unvalidated for the same reason and by the same rule: `startRun` reads
      // it through `readPipelineInput`, which throws `invalid` with a stable
      // code rather than repairing, so a caller learns its request was refused
      // instead of getting a pipeline that checks something else. Absent, the
      // PROJECT's own default decides — which is why `undefined` has to survive
      // this line rather than being normalised to null.
      pipeline: body.pipeline,
      // Absolute paths of files this run is to be GIVEN. Passed through
      // unvalidated for the reason `deliverable` is: `startRun` reads the list
      // through the one reader and judges each path on its own, answering a
      // coded refusal per entry rather than losing the task over one of them.
      // The assistant needs this because it writes its generated media inside
      // its own state directory, which no run may read.
      inputs: body.inputs,
      // Unvalidated for the reason `pipeline` is: `startRun` reads it through
      // `readExperienceInput`, which refuses with a stable code, so nothing a
      // caller sent reaches the run's prompt before that reader has passed it.
      experience: body.experience,
      // Only ever `true` or absent: what failed is the box's to append, from
      // its own record of the named run — never the caller's.
      ...(body.fixCi === true ? { fixCi: true } : {}),
      // Resolved above, on the box's clock: an absolute deadline, frozen on the
      // record. Absent without one, so such a run starts exactly as before.
      ...(timeBudget ? { timeBudget } : {}),
    });
    return NextResponse.json(
      { started: !queued, queued, run, ...budgetAnswer(resolved), ...(routeNote ? { routedToTeam: false, routeNote } : {}) },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof CodingAgentError) {
      // The provider/model refusal carries a `code` beside the shared 400, so a
      // caller can tell "that pair is not on this box" from "that folder is not
      // allowed" — both are `kind: "invalid"`, and the MCP tool advises on the
      // wrong argument without it. Anything else answers exactly as before.
      const code = err instanceof ProviderChoiceError || err instanceof PipelineChoiceError || err instanceof ExperienceChoiceError
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
