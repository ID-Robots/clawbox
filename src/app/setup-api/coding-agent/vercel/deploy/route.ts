import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { hasValidSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { declaredTooLong, readJsonObject } from "@/lib/bounded-json";
import {
  CodingAgentError,
  httpStatusForCodingError,
  listRuns,
  recordManualDeployment,
  resolveProjectScope,
  resolveWorkingDirectory,
} from "@/lib/coding-agent";
import { deployProject } from "@/lib/vercel-deploy";
import {
  newProjectDeploy,
  productionAllowance,
  readAutoProduction,
  readProjectDeploy,
  recordProjectDeploy,
  setAutoProduction,
  updateProjectDeploy,
  MAX_PRODUCTION_DEPLOYS,
  type ProjectDeployEntry,
} from "@/lib/vercel-deploy-store";
import { readDeployment, readProject } from "@/lib/vercel";
import { readVercelLink, resolveVercelAuth } from "@/lib/vercel-link";
import {
  decideDeployment,
  isDeployTarget,
  isProjectDeployPending,
  isVercelPending,
  VercelLinkError,
  type DeployActor,
  type DeployTarget,
  type ProjectDeploy,
} from "@/lib/vercel-state";

export const dynamic = "force-dynamic";

/**
 * Deploy a coding-agent project to Vercel — a preview to test, or production.
 *
 * WHO MAY DO WHAT, AND WHY THE TWO TARGETS ARE NOT THE SAME QUESTION.
 *
 *  - A PREVIEW is a throwaway address nobody but the owner has. The owner
 *    presses a button; the ASSISTANT may do it too, on the MCP bearer, because
 *    "build me something and let me look at it" is one gesture and a box that
 *    made the owner press a second button for the looking half would not be the
 *    thing that was asked for.
 *  - PRODUCTION is the project's real domain, in front of whoever uses it. From
 *    the owner it carries the promote route's whole fence: the session cookie,
 *    this box's own origin, and an explicit `confirm: true` that names the
 *    project in the question the card asked. From the AGENT it is refused
 *    outright UNLESS the owner has turned on `coding_vercel_auto_production`
 *    for THAT project — the standing permission, per project, off when absent
 *    (see ./vercel-deploy-store). With it on, the assistant may ship that one
 *    project without asking again, which is the automatic flow the owner asked
 *    for; with it off the refusal says where to turn it on rather than merely
 *    saying no.
 *
 * THE VERCEL PROJECT IS NEVER NAMED BY THE CALLER. Every verb here takes a
 * CODING project (`projectId` or `directory`, resolved by the same
 * `resolveProjectScope` the link and the secret store use) and looks the Vercel
 * project up from the owner's link. A prompt-injected agent therefore cannot
 * deploy to an account of its choosing, with the owner's token, however it
 * words the call.
 *
 * GET    ?projectId=…|?directory=…     → { scope, deploy, autoProduction, production }
 * POST   { projectId|directory, target, runId?, confirm? } → the deployment
 * PUT    { projectId|directory, autoProduction }           → the switch
 *
 * The GET refreshes a PENDING deployment from Vercel and stores what it
 * learned, which is what makes the project card show building → ready → error
 * without a second background watcher on the box: the card polls while it is
 * open and pending, and nothing is paid for when nobody is looking. A
 * deployment asked for ON A RUN is additionally written to the run record and
 * followed by the watcher that already exists (`recordManualDeployment`), so
 * the run's own card tells the same story.
 */

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, kind: code, code, ...extra }, { status });
}

/** A body here is a couple of identifiers and a flag. */
const MAX_BODY_BYTES = 4_096;
const TOO_LONG = "That request is larger than a deployment request can be.";

/** The project this request is about, or the refusal that stopped it. */
type Resolved =
  | { ok: true; scope: string; directory: string }
  | { ok: false; refusal: NextResponse };

async function projectFor(input: { projectId: string | null; directory: string | null }): Promise<Resolved> {
  const working = await resolveWorkingDirectory(input);
  const scope = await resolveProjectScope({ projectId: working.projectId, directory: working.directory });
  if (!scope) {
    return {
      ok: false,
      refusal: refuse(
        400,
        "no_project",
        "That folder is not one of this ClawBox's projects, so there is nothing to deploy.",
      ),
    };
  }
  return { ok: true, scope, directory: working.directory };
}

function failed(err: unknown, what: string) {
  if (err instanceof VercelLinkError) {
    return NextResponse.json({ error: err.message, kind: "invalid", code: err.code }, { status: 400 });
  }
  if (err instanceof CodingAgentError) {
    return NextResponse.json(
      { error: err.message, kind: err.kind, code: err.kind },
      { status: httpStatusForCodingError(err.kind) },
    );
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : what }, { status: 500 });
}

/**
 * What the GET and every write answer, so no surface reads a stale half.
 *
 * `linked` is here and not only on the link route because the deploy surfaces
 * have to decide whether to draw a button at all, and a card that offered
 * Deploy on a project with no Vercel project attached would be offering a
 * refusal. It is a config read, not an upstream call.
 */
async function payload(scope: string, entry: ProjectDeployEntry | null, autoProduction: boolean) {
  const allowance = productionAllowance(entry);
  return {
    scope,
    linked: (await readVercelLink(scope)) !== null,
    deploy: entry?.latest ?? null,
    autoProduction,
    production: { left: allowance.left, max: MAX_PRODUCTION_DEPLOYS, nextAt: allowance.nextAt },
  };
}

/**
 * The Vercel project itself — its name and the domain a production deploy
 * lands on — for the sentence the owner is asked before pressing it.
 *
 * Behind `?domain=1` and never on the poll, exactly as the link route's
 * `check=1` is: this is one call to another company's API, it is wanted once
 * when a card mounts, and a deployment that is building must not cost one every
 * few seconds. A failure is null rather than a refusal — the confirmation then
 * names the project and not the domain, which is a worse sentence and not a
 * broken page.
 */
async function projectFacts(scope: string): Promise<{ name: string | null; productionDomain: string | null } | null> {
  const link = await readVercelLink(scope);
  if (!link) return null;
  try {
    const auth = await resolveVercelAuth(link, scope);
    const project = await readProject(auth, link.projectId);
    if (!project.ok) return null;
    return { name: project.name, productionDomain: project.productionDomain };
  } catch {
    return null;
  }
}

/**
 * Ask Vercel what became of a deployment this box is still waiting on, and
 * store it.
 *
 * Only while it is PENDING, and only from a GET somebody actually made: an
 * upstream call per project page load would be the cost the link route's
 * `check=1` was split out to avoid, and a settled deployment has nothing left
 * to learn.
 */
async function refreshed(scope: string, entry: ProjectDeployEntry | null): Promise<ProjectDeployEntry | null> {
  const latest = entry?.latest;
  if (!latest || !isProjectDeployPending(latest) || !latest.deploymentId) return entry;
  const link = await readVercelLink(scope);
  if (!link) return entry;
  let auth;
  try {
    auth = await resolveVercelAuth(link, scope);
  } catch {
    // The token is gone or cannot be opened. That is not this deployment's
    // verdict, and writing one would turn "the box cannot look" into "your
    // build failed" — the distinction the whole phase set is built around.
    return entry;
  }
  const found = await readDeployment(auth, latest.deploymentId);
  if (!found.ok) return entry;
  const verdict = decideDeployment({
    deployment: found.deployment,
    waitedMs: Date.now() - latest.startedAt,
  });
  const change = verdict.action === "wait"
    ? {
      phase: "building" as const,
      readyState: found.deployment.readyState,
      url: found.deployment.url ?? latest.url,
      inspectorUrl: found.deployment.inspectorUrl ?? latest.inspectorUrl,
    }
    : {
      phase: verdict.phase,
      readyState: found.deployment.readyState,
      url: found.deployment.url ?? latest.url,
      inspectorUrl: found.deployment.inspectorUrl ?? latest.inspectorUrl,
      detail: verdict.detail,
      endedAt: Date.now(),
    };
  return (await updateProjectDeploy(scope, latest.deploymentId, change)) ?? entry;
}

export async function GET(request: Request): Promise<NextResponse> {
  // Cookie OR bearer: what this answers is what the box already deployed, and
  // the assistant is a legitimate reader of it — it is how a tool call that
  // started a deploy says how the build went. Nothing here is a credential and
  // nothing here changes.
  if (!(await hasValidSession(request))) {
    return refuse(401, "unauthorized", "Authentication required.");
  }
  if (declaredTooLong(request, MAX_BODY_BYTES)) return refuse(413, "too_large", TOO_LONG);
  const url = new URL(request.url);
  try {
    const project = await projectFor({
      projectId: url.searchParams.get("projectId"),
      directory: url.searchParams.get("directory"),
    });
    if (!project.ok) return project.refusal;
    const entry = await refreshed(project.scope, await readProjectDeploy(project.scope));
    return NextResponse.json({
      ...(await payload(project.scope, entry, await readAutoProduction(project.scope))),
      project: url.searchParams.has("domain") ? await projectFacts(project.scope) : null,
    });
  } catch (err) {
    return failed(err, "Could not read this ClawBox's deployments");
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  // The consent for an unattended production deploy. OWNER ONLY and SAME
  // ORIGIN, for the reason the secret store's master switch has both: a tool
  // that could turn this on would make the owner's answer temporary, and a
  // page in their browser must not be able to turn it on while they read it.
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Letting the assistant deploy to production needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "That switch can only be changed from this ClawBox's own pages.");
  }
  const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "too_large", TOO_LONG) : refuse(400, "invalid_body", "That is not a setting.");
  }
  const body = read.body;
  if (typeof body.autoProduction !== "boolean") {
    return refuse(400, "invalid_body", "That switch is on or off.");
  }
  try {
    const project = await projectFor({
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
    });
    if (!project.ok) return project.refusal;
    await setAutoProduction(project.scope, body.autoProduction);
    const entry = await readProjectDeploy(project.scope);
    return NextResponse.json(await payload(project.scope, entry, await readAutoProduction(project.scope)));
  } catch (err) {
    return failed(err, "Could not change that switch");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await hasValidSession(request))) {
    return refuse(401, "unauthorized", "Authentication required.");
  }
  const owner = await hasOwnerSession(request);
  const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "too_large", TOO_LONG) : refuse(400, "invalid_body", "That is not a deployment request.");
  }
  const body = read.body;
  if (!isDeployTarget(body.target)) {
    return refuse(400, "invalid_target", "A deployment is either a preview or production.");
  }
  const target: DeployTarget = body.target;
  const by: DeployActor = owner ? "owner" : "agent";

  // The ORIGIN check applies to the owner's own writes, never to the agent's:
  // the MCP server sends no Origin at all, and `isSameOriginRequest` waves a
  // header-less caller through — so this is a cross-site fence around the
  // browser, which is the only party it can protect.
  if (owner && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "A deployment can only be started from this ClawBox's own pages.");
  }

  try {
    const project = await projectFor({
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
    });
    if (!project.ok) return project.refusal;
    const { scope, directory } = project;

    // The run this deploy belongs to, when it was pressed on one. Checked
    // before anything is sent, so a bad id is a refusal rather than a
    // deployment nobody can find again.
    const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : null;
    let branch: string | null = null;
    if (runId) {
      const run = listRuns().find((r) => r.id === runId);
      if (!run) return refuse(404, "not_found", "There is no run with that id on this ClawBox.");
      if (isVercelPending(run.vercel)) {
        // Refused rather than overwritten: the record that would be lost is the
        // one telling the owner a build is running right now.
        return refuse(409, "deploy_in_flight", "This run already has a deployment that is still building. Wait for it, or look at it on Vercel.");
      }
      branch = run.vercel?.branch ?? run.pr?.branch ?? null;
    }

    if (target === "production") {
      if (owner) {
        // The owner's INTENT, echoed. Not an authorization check and
        // deliberately after the ones that are — it is what makes the card's
        // question and the route agree about what the gesture is, exactly as
        // the promote route documents.
        if (body.confirm !== true) {
          return refuse(400, "not_confirmed", "A production deployment has to be confirmed: it puts that build on the project's own domain.");
        }
      } else if (!(await readAutoProduction(scope))) {
        return refuse(
          403,
          "auto_production_off",
          "This ClawBox does not let its assistant deploy this project to production. The owner can turn that on for this project in the Coding Agent app, on the project's page, under Vercel deploys — until then, deploy a preview and ask them to press the production button.",
        );
      }
    }

    // The rate limit, on the TARGET rather than on who asked: a bound on how
    // often this box rebuilds a domain other people are using is not a
    // statement about whether the owner is trusted, and an owner who really
    // means it has the Vercel dashboard. It is the loop it stops.
    const existing = await readProjectDeploy(scope);
    if (target === "production") {
      const allowance = productionAllowance(existing);
      if (allowance.left <= 0) {
        return refuse(
          429,
          "rate_limited",
          `This project has had ${MAX_PRODUCTION_DEPLOYS} production deployments in the last hour, which is as many as this ClawBox makes. Wait, or deploy it from Vercel.`,
          { nextAt: allowance.nextAt },
        );
      }
    }

    const made = await deployProject({
      scope,
      directory,
      target,
      gitRef: branch,
      // Shown on Vercel's own build page. The scope is the owner's own project
      // name and the run id is this box's; neither is a path or a credential.
      meta: { clawbox: "1", clawboxProject: scope, ...(runId ? { clawboxRun: runId } : {}) },
    });
    if (!made.ok) {
      return NextResponse.json(
        { error: made.detail, kind: made.code, code: made.code },
        // A refusal Vercel spoke is a 502 — the request was fine and the far
        // side is not — while everything this box decided is the caller's to
        // fix and answers 400.
        { status: made.code === "not_found" ? 404 : UPSTREAM_CODES.has(made.code) ? 502 : 400 },
      );
    }

    const deploy: ProjectDeploy = newProjectDeploy({
      target,
      projectId: made.projectId,
      teamId: made.teamId,
      deploymentId: made.deployment.id,
      readyState: made.deployment.readyState,
      url: made.deployment.url,
      inspectorUrl: made.deployment.inspectorUrl,
      source: made.source,
      gitRef: made.gitRef,
      fileCount: made.fileCount,
      by,
      runId,
    });
    const entry = await recordProjectDeploy(scope, deploy);
    // And on the RUN, when there is one: the same deployment, followed by the
    // watcher that already draws building → ready → failed on a run's card.
    //
    // It CANNOT be allowed to fail the answer. By this line the deployment is
    // real and building on somebody's account; a 500 here would have the caller
    // retry and deploy it a second time, which for `production` means building
    // a live domain twice because a disk write on the Jetson hiccupped. The
    // project record above is what the card reads either way.
    if (runId) {
      try {
        recordManualDeployment(runId, {
          deployment: made.deployment,
          projectId: made.projectId,
          teamId: made.teamId,
          target,
          branch: made.gitRef,
        });
      } catch (err) {
        console.error(`[vercel-deploy] ${runId} not recorded on the run:`, err instanceof Error ? err.message : err);
      }
    }
    return NextResponse.json({
      ok: true,
      ...(await payload(scope, entry, await readAutoProduction(scope))),
      // What the caller cannot see from the record, and needs in order to say
      // something true about the deploy: whether the folder's own ignore rules
      // decided what went up, and what was left out.
      usedGit: made.usedGit,
      skipped: made.skipped,
    });
  } catch (err) {
    return failed(err, "Could not deploy that project");
  }
}

/** Refusals that came from VERCEL rather than from this box. */
const UPSTREAM_CODES = new Set(["network", "auth", "rate", "upstream", "refused"]);
