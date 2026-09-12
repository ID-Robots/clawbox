import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { listRuns, recordDeployPromotion, resolveProjectScope } from "@/lib/coding-agent";
import { readVercelLink, resolveVercelAuth } from "@/lib/vercel-link";
import { promoteDeployment } from "@/lib/vercel";
import { VercelLinkError } from "@/lib/vercel-state";

export const dynamic = "force-dynamic";

/**
 * Put one deployment in front of a project's users.
 *
 * THE ONE ACTION IN THIS FEATURE THAT CHANGES WHAT THE WORLD SEES, and the
 * whole of its design follows from that:
 *
 *  - OWNER ONLY, AND SAME ORIGIN. The MCP bearer is refused outright. A tool
 *    that could promote would let a prompt-injected agent ship its own work to
 *    a project's production domain — the single worst thing available anywhere
 *    in the coding agent — and the origin check stops another page in the
 *    owner's browser from doing it while they read it.
 *  - EXPLICIT CONFIRMATION. `confirm: true` in the body, refused without it.
 *    Not because a stray request could otherwise arrive past the two gates
 *    above, but because the button and the route then agree about what the
 *    gesture IS: the card asks, and the answer travels with the request rather
 *    than being a property of having clicked something.
 *  - NEVER AUTOMATIC. Nothing in src/lib/coding-agent.ts calls the Vercel
 *    promote endpoint — the runner can only RECORD a promotion
 *    (`recordDeployPromotion`), never cause one. A green preview does not
 *    promote itself, whatever the checks say.
 *
 * POST { runId, deploymentId, confirm: true } → the run, with the promotion on
 * its deployment record.
 *
 * The `deploymentId` is required and checked against the record rather than
 * taken as the thing to promote: the owner is agreeing to the build the card
 * showed them, and a watcher that moved on to a newer deployment between the
 * page load and the click must not have the click apply to the new one.
 */

function refuse(status: number, code: string, error: string) {
  return NextResponse.json({ error, kind: code, code }, { status });
}

/** A body here is two ids and a flag. */
const MAX_BODY_BYTES = 2_048;

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Promoting a deployment to production needs a signed-in browser session. This ClawBox never does it on its own, and its assistant cannot do it at all.");
  }
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "A deployment can only be promoted from this ClawBox's own pages.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(413, "too_large", "That request is larger than a promotion can be.");
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return refuse(400, "invalid_body", "That is not a promotion.");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "invalid_body", "That is not a promotion.");
  }

  // NOT an authorization check, and deliberately AFTER the two that are: the
  // owner's session and the origin have already decided whether this request
  // may act at all, and neither is anything a caller can assert. This is the
  // owner's INTENT, echoed so that the card's question and the route agree
  // about what the gesture is — a caller that omits it is refused, and a caller
  // that sends it has gained nothing it did not already have.
  if (body.confirm !== true) {
    return refuse(400, "not_confirmed", "A promotion has to be confirmed: it points this project's production traffic at that build.");
  }
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const deploymentId = typeof body.deploymentId === "string" ? body.deploymentId.trim() : "";
  if (!runId || !deploymentId) {
    return refuse(400, "invalid_body", "A promotion names the run and the deployment.");
  }

  const run = listRuns().find((r) => r.id === runId);
  if (!run) return refuse(404, "not_found", "There is no run with that id on this ClawBox.");
  const state = run.vercel;
  if (!state?.deploymentId) {
    return refuse(409, "no_deployment", "This run has no Vercel deployment to promote.");
  }
  if (state.deploymentId !== deploymentId) {
    // See the header: the owner agreed to the build they were shown.
    return refuse(409, "stale_deployment", "That is not this run's current deployment any more. Reload the run and look again before promoting.");
  }
  if (state.phase !== "ready") {
    return refuse(409, "not_ready", "Only a deployment that finished building can be promoted.");
  }

  try {
    const scope = await resolveProjectScope({ projectId: run.projectId, directory: run.directory });
    if (!scope) return refuse(409, "no_project", "This run is not in a project, so there is no Vercel link for it.");
    const link = await readVercelLink(scope);
    if (!link) return refuse(409, "not_linked", "No Vercel project is attached to this project any more.");
    const auth = await resolveVercelAuth(link, scope);

    // The RECORD's own id, never the caller's string — they were just proved
    // equal, and what reaches Vercel should be the value this box wrote rather
    // than the one that arrived.
    const promoted = await promoteDeployment(auth, link.projectId, state.deploymentId);
    if (!promoted.ok) {
      // Vercel's own kind travels as the code, so the card can tell "your token
      // expired" from "the house internet is down" without reading English.
      return NextResponse.json(
        { error: promoted.detail, kind: promoted.kind, code: promoted.kind },
        // 404 for a deployment Vercel says is not there; everything else is a
        // 502, because the request was fine and the far side is not.
        { status: promoted.kind === "not_found" ? 404 : 502 },
      );
    }

    const updated = recordDeployPromotion(run.id, {
      deploymentId: state.deploymentId,
      url: state.url,
      at: Date.now(),
      // The only actor this box writes: the route the MCP bearer cannot reach.
      by: "owner",
    });
    return NextResponse.json({ ok: true, vercel: updated?.vercel ?? null });
  } catch (err) {
    if (err instanceof VercelLinkError) {
      return NextResponse.json({ error: err.message, kind: "invalid", code: err.code }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not promote that deployment" },
      { status: 500 },
    );
  }
}
