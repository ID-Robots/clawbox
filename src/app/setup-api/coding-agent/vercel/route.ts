import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { CodingAgentError, httpStatusForCodingError, resolveProjectScope } from "@/lib/coding-agent";
import {
  checkVercelReadiness,
  deleteVercelLink,
  readVercelLink,
  setVercelLink,
} from "@/lib/vercel-link";
import { VercelLinkError } from "@/lib/vercel-state";

export const dynamic = "force-dynamic";

/**
 * The owner's Vercel link for one coding-agent project: which Vercel project
 * its runs deploy to, and which stored secret holds the token.
 *
 * OWNER ONLY, AND SAME ORIGIN FOR THE WRITES — the fence
 * `coding-agent/permissions` and `coding-agent/secrets` carry, for the same
 * reason. Middleware admits every /setup-api/* call on the MCP bearer and the
 * agent holds that bearer: a POST it could make would let a prompt-injected
 * agent point this project's deploys at a Vercel project of its own choosing,
 * with the owner's token, and a DELETE would let it quietly switch the owner's
 * deployments off. The origin check on top keeps another page in the owner's
 * browser from doing either while they read it.
 *
 * READING IS OWNER-ONLY TOO. Nothing here answers with a token — the link
 * carries only the NAME of a secret — but the shape of what a box deploys and
 * to whose account is the owner's, and the agent has no need for it: what it
 * legitimately needs is on the run record, which `runs` already answers.
 *
 * GET    ?projectId=… | ?directory=…            → { scope, link, readiness }
 * GET    …&check=1                              → the readiness asked of Vercel
 * POST   { projectId|directory, vercelProjectId, teamId?, tokenSecretName }
 * DELETE ?projectId=… | ?directory=…            → detach
 *
 * WHY THE READINESS CHECK IS BEHIND `check=1` AND NOT ALWAYS DONE. It is two
 * calls to another company's API, and this route is read every time a project
 * page opens. The page asks for it once, deliberately, and shows "checking…"
 * while it happens; the plain GET is a config read and costs nothing.
 */

function refuse(status: number, kind: string, error: string, code?: string) {
  return NextResponse.json({ error, kind, ...(code ? { code } : {}) }, { status });
}

/** Owner session, and — for the writes — this box's own page. */
async function guard(request: Request, write: boolean): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Reading or changing this ClawBox's Vercel links needs a signed-in browser session.", "owner_only");
  }
  if (write && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "Vercel links can only be changed from this ClawBox's own pages.", "cross_origin");
  }
  return null;
}

/**
 * The project this request is about, as the ONE identity the secret store and
 * the link store share (`resolveProjectScope`).
 *
 * A folder that is not a project answers `no_project` rather than being filed
 * under something invented: a link has to be findable again by the run that
 * needs it, and a run's project is resolved by that same function.
 */
type Scope = { ok: true; scope: string } | { ok: false; refusal: NextResponse };

async function scopeFor(input: { projectId: string | null; directory: string | null }): Promise<Scope> {
  const scope = await resolveProjectScope(input);
  if (!scope) {
    return {
      ok: false,
      refusal: refuse(
        400,
        "no_project",
        "That folder is not one of this ClawBox's projects, so there is nothing to attach a Vercel project to.",
        "no_project",
      ),
    };
  }
  return { ok: true, scope };
}

function failed(err: unknown) {
  if (err instanceof VercelLinkError) {
    const status = err.code === "link_unreadable" || err.code === "link_unwritable" ? 500 : 400;
    return NextResponse.json({ error: err.message, kind: "invalid", code: err.code }, { status });
  }
  if (err instanceof CodingAgentError) {
    return NextResponse.json(
      { error: err.message, kind: err.kind, code: err.kind },
      { status: httpStatusForCodingError(err.kind) },
    );
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Could not change this ClawBox's Vercel link" },
    { status: 500 },
  );
}

/**
 * The most this route will read.
 *
 * A body here is four short identifiers. Nothing about a link is long, and a
 * request that announces more than this has no business being buffered — the
 * check the secrets route arrived at in review, applied here from the start.
 */
const MAX_BODY_BYTES = 4_096;

function declaredTooLong(request: Request): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await guard(request, false);
  if (denied) return denied;
  const url = new URL(request.url);
  try {
    const resolved = await scopeFor({
      projectId: url.searchParams.get("projectId"),
      directory: url.searchParams.get("directory"),
    });
    if (!resolved.ok) return resolved.refusal;
    const link = await readVercelLink(resolved.scope);
    if (!url.searchParams.has("check")) {
      return NextResponse.json({ scope: resolved.scope, link, readiness: null });
    }
    return NextResponse.json({
      scope: resolved.scope,
      link,
      readiness: await checkVercelReadiness(resolved.scope),
    });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await guard(request, true);
  if (denied) return denied;
  if (declaredTooLong(request)) {
    return refuse(413, "too_large", "That request is larger than one Vercel link can be.", "too_large");
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return refuse(400, "invalid", "That is not a Vercel link.", "invalid_body");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "invalid", "That is not a Vercel link.", "invalid_body");
  }
  try {
    const resolved = await scopeFor({
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
    });
    if (!resolved.ok) return resolved.refusal;
    const link = await setVercelLink({
      scope: resolved.scope,
      // `vercelProjectId`, deliberately not `projectId`: this route's
      // `projectId` is already the CODING-AGENT project, and one name for two
      // ids is how a link ends up attached to itself.
      projectId: body.vercelProjectId,
      teamId: body.teamId,
      tokenSecretName: body.tokenSecretName,
    });
    // The write answers the box's own re-read, checked against Vercel, so the
    // card renders what is true rather than what it hoped for — and the owner
    // learns at the moment they attach that the token is wrong, rather than
    // when a run's build silently never appears.
    return NextResponse.json({
      scope: resolved.scope,
      link,
      readiness: await checkVercelReadiness(resolved.scope),
    });
  } catch (err) {
    return failed(err);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await guard(request, true);
  if (denied) return denied;
  const url = new URL(request.url);
  try {
    const resolved = await scopeFor({
      projectId: url.searchParams.get("projectId"),
      directory: url.searchParams.get("directory"),
    });
    if (!resolved.ok) return resolved.refusal;
    const removed = await deleteVercelLink(resolved.scope);
    // The stored TOKEN is deliberately left alone: it is the owner's secret,
    // it may be box-wide or used by another project, and a detach that deleted
    // a credential would be a destructive act nobody asked for.
    return NextResponse.json({ scope: resolved.scope, link: null, readiness: null, removed });
  } catch (err) {
    return failed(err);
  }
}
