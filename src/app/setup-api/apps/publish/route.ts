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
 *   GET  [?projectId=<folder>[&directory=<path>]] — may this box publish (the portal's
 *        `canPublish`), the owner's apps already in the Store, and — for a
 *        project — the name, slug and next version the dialog starts from.
 *   POST { projectId, directory?, version, description?, iconUrl?, slug? } —
 *        `{ ok: true, app, created, storeUrl }` or
 *        `{ ok: false, code, message, field?, upgradeUrl?, retryable }`.
 *
 * The OWNER's route: their browser session from this box's own pages, or the
 * agent's MCP bearer (`app_publish`, which the owner asks for in chat) —
 * never another ClawBox user, who gets 403 `owner_only`. A project is found
 * through the Coding Agent's own listing by its folder name, so nothing but
 * one of the owner's projects can be packed and sent. A folder name can be
 * two projects (an owner's folder and a code project of the same name), so
 * the app's dialog also sends the row's `directory`, and a request naming
 * only a folder that is two projects is refused rather than guessed at —
 * publishing the wrong one puts it on a public store.
 */

const MAX_PROJECT_ID = 128;
const MAX_DIRECTORY = 4096;

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

/** The row's directory: undefined when not sent, null when sent and not one. */
function directoryFrom(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && value.length <= MAX_DIRECTORY && !value.includes("\0") ? value : null;
}

type Found = { ok: true; project: PublishableProject } | { ok: false; failure: PublishFailure };

async function findProject(projectId: string, directory: string | undefined): Promise<Found> {
  const { projects } = await listProjects();
  const matches = projects.filter((p) => p.folder === projectId && (directory === undefined || p.directory === directory));
  if (matches.length === 0) return { ok: false, failure: publishFailure("not_found") };
  if (matches.length > 1) {
    return {
      ok: false,
      failure: publishFailure(
        "invalid",
        `Two of your projects are named "${projectId}" — a folder and a code project. Name its directory as well, or publish it from its row in the Coding Agent app.`,
        { field: "projectId" },
      ),
    };
  }
  return { ok: true, project: { folder: matches[0].folder, directory: matches[0].directory } };
}

function failureResponse(failure: PublishFailure): NextResponse {
  const { status, ...body } = failure;
  return NextResponse.json(body, { status });
}

export async function GET(request: Request) {
  const blocked = await gate(request);
  if (blocked) return blocked;
  try {
    const query = new URL(request.url).searchParams;
    const raw = query.get("projectId");
    const projectId = raw === null ? null : projectIdFrom(raw);
    if (raw !== null && !projectId) return failureResponse(publishFailure("invalid", "Name the project by its folder.", { field: "projectId" }));
    const directory = directoryFrom(query.get("directory"));
    if (directory === null) return failureResponse(publishFailure("invalid", "The project's directory is not one.", { field: "directory" }));

    let project: Record<string, unknown> | undefined;
    if (projectId) {
      const found = await findProject(projectId, directory);
      if (!found.ok) return failureResponse(found.failure);
      const manifest = await readClawboxManifest(found.project.directory);
      if (!manifest) return failureResponse(publishFailure("no_manifest"));
      project = {
        projectId: found.project.folder,
        name: manifest.name,
        slug: manifestSlug(manifest, found.project.folder),
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
  const directory = directoryFrom(body.directory);
  if (directory === null) return failureResponse(publishFailure("invalid", "The project's directory is not one.", { field: "directory" }));

  try {
    const found = await findProject(projectId, directory);
    if (!found.ok) return failureResponse(found.failure);
    const outcome = await publishProject(projectId, { version: body.version.trim(), description, iconUrl, slug }, async () => found.project);
    if (!outcome.ok) return failureResponse(outcome);
    return NextResponse.json({ ok: true, app: outcome.app, created: outcome.created, storeUrl: outcome.storeUrl }, { status: outcome.created ? 201 : 200 });
  } catch (err) {
    console.error("[apps/publish] publish:", err instanceof Error ? err.message : err);
    return failureResponse(publishFailure("failed"));
  }
}
