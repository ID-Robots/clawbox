import { NextResponse } from "next/server";
import { ownerOnlyResponse, requireSession } from "@/lib/route-auth";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { listProjects } from "@/lib/coding-agent";
import { manifestSlug, readClawboxManifest } from "@/lib/clawbox-manifest";
import {
  bumpVersion,
  publishFailure,
  publishKind,
  publishProject,
  storePublishStatus,
  type PublishableProject,
  type PublishFailure,
} from "@/lib/store-publish";

export const dynamic = "force-dynamic";

/**
 * Publish a Coding Agent project that carries clawbox.json to the ClawBox
 * Store (src/lib/store-publish.ts).
 *
 *   GET  [?projectId=<folder>] — may this box publish (the portal's
 *        `canPublish`), the owner's apps already in the Store, and — for a
 *        project — the name, slug and next version the dialog starts from.
 *   POST { projectId, version, description?, iconUrl?, slug? } —
 *        `{ ok: true, app, created, storeUrl }` or
 *        `{ ok: false, code, message, field?, upgradeUrl?, retryable }`.
 *
 * The OWNER's route: their browser session from this box's own pages, or the
 * agent's MCP bearer (`app_publish`, which the owner asks for in chat) —
 * never another ClawBox user, who gets 403 `owner_only`. A project is found
 * through the Coding Agent's own listing by its folder name, so nothing but
 * one of the owner's projects can be packed and sent.
 */

const MAX_PROJECT_ID = 128;

async function gate(request: Request): Promise<NextResponse | null> {
  const denied = await requireSession(request);
  if (denied) return denied;
  const who = await personSession(request);
  if (who && !who.isOwner) return ownerOnlyResponse();
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, code: "cross_origin", message: "Publishing only works from this ClawBox's own pages." }, { status: 403 });
  }
  return null;
}

function projectIdFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= MAX_PROJECT_ID && !value.includes("/") && !value.includes("\0")
    ? value.trim()
    : null;
}

async function findProject(projectId: string): Promise<PublishableProject | null> {
  const { projects } = await listProjects();
  const project = projects.find((p) => p.folder === projectId) ?? null;
  return project ? { folder: project.folder, directory: project.directory } : null;
}

function failureResponse(failure: PublishFailure): NextResponse {
  const { status, ...body } = failure;
  return NextResponse.json(body, { status });
}

export async function GET(request: Request) {
  const blocked = await gate(request);
  if (blocked) return blocked;
  try {
    const raw = new URL(request.url).searchParams.get("projectId");
    const projectId = raw === null ? null : projectIdFrom(raw);
    if (raw !== null && !projectId) return failureResponse(publishFailure("invalid", "Name the project by its folder.", { field: "projectId" }));

    let project: Record<string, unknown> | undefined;
    if (projectId) {
      const found = await findProject(projectId);
      if (!found) return failureResponse(publishFailure("not_found"));
      const manifest = await readClawboxManifest(found.directory);
      if (!manifest) return failureResponse(publishFailure("no_manifest"));
      project = {
        projectId: found.folder,
        name: manifest.name,
        slug: manifestSlug(manifest, found.folder),
        description: manifest.description ?? "",
        kind: publishKind(manifest),
      };
    }
    const status = await storePublishStatus();
    if (project) {
      const slug = project.slug;
      const published = status.apps.find((app) => app.slug === slug) ?? null;
      const version = typeof published?.version === "string" ? published.version : null;
      project.published = version ? { version } : null;
      project.suggestedVersion = version ? bumpVersion(version) : "1.0.0";
    }
    return NextResponse.json({ ok: true, ...status, ...(project ? { project } : {}) });
  } catch (err) {
    console.error("[apps/publish] status:", err instanceof Error ? err.message : err);
    return failureResponse(publishFailure("failed", "Reading the publishing state failed on the box."));
  }
}

export async function POST(request: Request) {
  const blocked = await gate(request);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return failureResponse(publishFailure("invalid", "The request body must be a JSON object."));
  }
  const projectId = projectIdFrom(body.projectId);
  if (!projectId) return failureResponse(publishFailure("invalid", "Name the project by its folder.", { field: "projectId" }));
  const optional = (value: unknown): string | null | undefined => (typeof value === "string" ? value : value == null ? undefined : null);
  const description = optional(body.description);
  const iconUrl = optional(body.iconUrl);
  const slug = optional(body.slug);
  if (typeof body.version !== "string") return failureResponse(publishFailure("invalid", "Give the version as three numbers, like 1.0.0.", { field: "version" }));
  if (description === null) return failureResponse(publishFailure("invalid", "The description must be text.", { field: "description" }));
  if (iconUrl === null) return failureResponse(publishFailure("invalid", "The icon URL must be text.", { field: "iconUrl" }));
  if (slug === null) return failureResponse(publishFailure("invalid", "The slug must be text.", { field: "slug" }));

  try {
    const outcome = await publishProject(projectId, { version: body.version.trim(), description, iconUrl, slug }, findProject);
    if (!outcome.ok) return failureResponse(outcome);
    return NextResponse.json({ ok: true, app: outcome.app, created: outcome.created, storeUrl: outcome.storeUrl }, { status: outcome.created ? 201 : 200 });
  } catch (err) {
    console.error("[apps/publish] publish:", err instanceof Error ? err.message : err);
    return failureResponse(publishFailure("failed"));
  }
}
