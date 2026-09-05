import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { listProjects } from "@/lib/coding-agent";
import { readClawboxManifest } from "@/lib/clawbox-manifest";
import { registerServerApp } from "@/lib/app-proxy";

export const dynamic = "force-dynamic";

/**
 * POST { directory } — put one of the owner's projects on the desktop from
 * its clawbox.json: the icon opens `/apps/<folder>/`, which the box proxies
 * to the port the manifest names, once the project's own server is found
 * listening there (src/lib/app-proxy.ts — the check is what keeps a
 * manifest from pointing the proxy at some other service on the box).
 *
 * OWNER-ONLY and OUR PAGE ONLY: this decides what the box serves to whoever
 * reaches it, and a run's settle does the same only for the project the
 * run just worked in.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json({ error: "Adding an app to the desktop needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Adding an app only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const directory = typeof body === "object" && body !== null && typeof (body as { directory?: unknown }).directory === "string"
    ? (body as { directory: string }).directory
    : null;
  if (!directory) return NextResponse.json({ error: "Name the project's folder.", kind: "invalid" }, { status: 400 });

  // One of the owner's projects, as the listing knows them — never an
  // arbitrary folder.
  const { projects } = await listProjects();
  const project = projects.find((p) => p.directory === directory) ?? null;
  if (!project) return NextResponse.json({ error: "That folder is not one of your projects.", kind: "not_found" }, { status: 404 });
  const manifest = await readClawboxManifest(project.directory);
  if (!manifest?.port) return NextResponse.json({ error: "The project's clawbox.json names no port to serve.", kind: "no_port" }, { status: 409 });

  const outcome = await registerServerApp({ id: project.folder, directory: project.directory, manifest });
  if (!outcome.ok) return NextResponse.json({ error: outcome.detail, kind: outcome.reason }, { status: outcome.reason === "failed" ? 500 : 409 });
  return NextResponse.json({ ok: true, folder: project.folder, url: `/apps/${project.folder}/` });
}
