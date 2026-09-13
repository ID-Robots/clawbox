import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { hasValidSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { declaredTooLong, readJsonObject } from "@/lib/bounded-json";
import {
  approvePipelineProduction,
  CodingAgentError,
  getRun,
  httpStatusForCodingError,
  resolveProjectScope,
  resolveWorkingDirectory,
  stopRunPipeline,
} from "@/lib/coding-agent";
import { readPipelineDefault, setPipelineDefault } from "@/lib/coding-pipeline-store";

export const dynamic = "force-dynamic";

/**
 * The DELIVERY PIPELINE of one run, and the per-project default that makes one.
 *
 * WHAT THE OWNER ASKED FOR (2026-09-13): "From prompt -> coding agent -> review
 * -> improvement -> deploy dev -> review -> deploy prod -> review -> task
 * complete. The full run needs to be auto from start to finish." A pipeline is
 * therefore mostly something nobody touches: it is started with the run and it
 * drives itself. This route is the two moments a person is still in it — the
 * reading, and the one button.
 *
 * WHO MAY DO WHAT.
 *
 *  - GET is open to the owner's session AND to the MCP bearer. It is how the
 *    assistant answers "how is it going", it changes nothing, and everything in
 *    it — stage names, deployment ids, the addresses this box checked — was
 *    written by this box. No credential and no Vercel account name is in it.
 *  - POST `approve_production` carries the whole production fence, because that
 *    is exactly what it is: the owner's session, this box's own origin, and an
 *    explicit `confirm: true`. It is the "Deploy to production" button the
 *    pipeline waits on when the per-project auto switch is off, and letting the
 *    bearer press it would make that switch decorative.
 *  - POST `stop` is the owner's too, and same-origin with it: a page in their
 *    browser must not be able to call off a ship they are in the middle of.
 *  - PUT is the per-project DEFAULT — a standing consent for unattended runs to
 *    deploy — so it is owner-only and same-origin for the reason the secret
 *    store's master switch and the production switch both are: a tool that
 *    could turn it on would make the owner's answer temporary.
 *
 * GET  ?runId=…                            → { run, pipeline }
 * GET  ?projectId=…|?directory=…           → { scope, enabled }
 * POST { runId, action, confirm? }         → the re-read run
 * PUT  { projectId|directory, enabled }    → { scope, enabled }
 */

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, kind: code, code, ...extra }, { status });
}

/** A body here is a run id, an action and a flag. */
const MAX_BODY_BYTES = 4_096;
const TOO_LONG = "That request is larger than a pipeline request can be.";

function failed(err: unknown, what: string) {
  if (err instanceof CodingAgentError) {
    return NextResponse.json(
      { error: err.message, kind: err.kind, code: err.kind },
      { status: httpStatusForCodingError(err.kind) },
    );
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : what }, { status: 500 });
}

/** The project scope a request names, or the refusal that stopped it. */
async function scopeFor(input: { projectId: string | null; directory: string | null }) {
  const working = await resolveWorkingDirectory(input);
  const scope = await resolveProjectScope({ projectId: working.projectId, directory: working.directory });
  if (!scope) {
    return {
      ok: false as const,
      refusal: refuse(400, "no_project", "That folder is not one of this ClawBox's projects."),
    };
  }
  return { ok: true as const, scope };
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await hasValidSession(request))) {
    return refuse(401, "unauthorized", "Authentication required.");
  }
  if (declaredTooLong(request, MAX_BODY_BYTES)) return refuse(413, "too_large", TOO_LONG);
  const url = new URL(request.url);
  try {
    const runId = url.searchParams.get("runId");
    if (runId) {
      const run = getRun(runId);
      if (!run) return refuse(404, "not_found", "There is no run with that id on this ClawBox.");
      return NextResponse.json({
        run: { id: run.id, status: run.status, task: run.task },
        pipeline: run.pipeline,
      });
    }
    const project = await scopeFor({
      projectId: url.searchParams.get("projectId"),
      directory: url.searchParams.get("directory"),
    });
    if (!project.ok) return project.refusal;
    return NextResponse.json({ scope: project.scope, enabled: await readPipelineDefault(project.scope) });
  } catch (err) {
    return failed(err, "Could not read that delivery pipeline");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "A delivery pipeline is steered from a signed-in browser session on this ClawBox.");
  }
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "That can only be done from this ClawBox's own pages.");
  }
  const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "too_large", TOO_LONG) : refuse(400, "invalid_body", "That is not a pipeline request.");
  }
  const body = read.body;
  const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : null;
  if (!runId) return refuse(400, "invalid_body", "Name the run whose pipeline this is about.");

  try {
    if (body.action === "stop") {
      return NextResponse.json({ ok: true, run: stopRunPipeline(runId) });
    }
    if (body.action === "approve_production") {
      // The owner's INTENT, echoed. Not an authorization check and deliberately
      // after the ones that are — it is what makes the card's question and this
      // route agree about what the gesture is, exactly as the promote and
      // deploy routes document. A production deployment puts that build on the
      // project's own domain.
      if (body.confirm !== true) {
        return refuse(400, "not_confirmed", "Deploying to production has to be confirmed: it puts that build on the project's own domain.");
      }
      const run = await approvePipelineProduction(runId);
      return NextResponse.json({ ok: true, run });
    }
    return refuse(400, "invalid_action", "A pipeline is either approved for production or stopped.");
  } catch (err) {
    return failed(err, "Could not steer that delivery pipeline");
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Letting this ClawBox run the whole delivery flow by itself needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "That switch can only be changed from this ClawBox's own pages.");
  }
  const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "too_large", TOO_LONG) : refuse(400, "invalid_body", "That is not a setting.");
  }
  const body = read.body;
  if (typeof body.enabled !== "boolean") {
    return refuse(400, "invalid_body", "That switch is on or off.");
  }
  try {
    const project = await scopeFor({
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
    });
    if (!project.ok) return project.refusal;
    await setPipelineDefault(project.scope, body.enabled);
    return NextResponse.json({ scope: project.scope, enabled: await readPipelineDefault(project.scope) });
  } catch (err) {
    return failed(err, "Could not change that switch");
  }
}
