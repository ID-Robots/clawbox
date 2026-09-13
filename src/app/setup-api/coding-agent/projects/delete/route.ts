import { NextResponse } from "next/server";
import { declaredTooLong, readJsonObject } from "@/lib/bounded-json";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { listProjects } from "@/lib/coding-agent";
import {
  deleteProject,
  previewProjectDelete,
  ProjectDeleteError,
  PROJECT_DELETE_STATUS,
} from "@/lib/coding-project-delete";

export const dynamic = "force-dynamic";

/**
 * Remove one of the owner's project folders.
 *
 * THE ONE ACTION IN THIS FEATURE THAT TAKES THE OWNER'S OWN CODE AWAY, and the
 * whole of its design follows from that:
 *
 *  - OWNER ONLY, AND SAME ORIGIN, for BOTH verbs. The MCP bearer is refused
 *    outright, exactly as `vercel/promote` and `secrets` refuse it, and for the
 *    sharpest version of the same reason: middleware admits every /setup-api/*
 *    call on that bearer and the agent holds it, so a DELETE it could reach
 *    would let a prompt-injected run remove the folder it was asked to work in
 *    — or the one next to it. Nothing an unattended shell can be talked into
 *    doing may end with the owner's code gone. The origin check on top is what
 *    stops another page in the owner's browser from doing it while they read it.
 *    Even the read half is gated: the preview states a folder's size, its
 *    uncommitted files and which secrets are filed against it, and none of that
 *    is the agent's to enumerate.
 *
 *  - THE PROJECT IS NAMED TWICE. `folder` says which, and `confirm` must be
 *    that same name, byte for byte. Not a `confirm: true` boolean — for a
 *    removal the gesture has to carry WHICH thing it agreed to, so a dialog the
 *    owner opened over one project cannot post over another, and a request
 *    replayed from anywhere cannot mean "the current one".
 *
 *  - IT IS NOT A DELETE. The folder is moved into `data/deleted-projects/` with
 *    a timestamp on it and the answer says where it went; the retention rule
 *    lives in src/lib/coding-project-delete.ts and is stated there. Nothing in
 *    this route recursively removes anything.
 *
 *  - NEVER AUTOMATIC. Nothing in src/lib/coding-agent.ts calls this. A run that
 *    finishes, fails, or is told its project is finished with does not clear it
 *    up; the only caller is a person in a dialog.
 *
 * GET    ?folder=…&kind=…                     → the preview the dialog draws
 * DELETE { folder, kind?, confirm, force? }   → do it, and say where it went
 *
 * `force` clears ONE refusal — a folder with work that exists nowhere else —
 * and the UI offers it only after this route's own preview has listed what that
 * work is. Every other refusal is a fact about the box or the request, and no
 * flag in a body makes it untrue.
 *
 * The DELETE answers with the re-read projects listing beside its outcome, so
 * the app redraws from the box's own answer rather than from the row it hoped
 * had gone.
 */

function refuse(status: number, kind: string, error: string, code?: string) {
  return NextResponse.json({ error, kind, ...(code ? { code } : {}) }, { status });
}

/** The owner's session AND this box's own page — for reading as well as removing. */
async function guard(request: Request): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(request))) {
    return refuse(
      403,
      "owner_only",
      "Removing a project folder needs a signed-in browser session. This ClawBox never does it on its own, and its assistant cannot do it at all.",
      "owner_only",
    );
  }
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "A project folder can only be removed from this ClawBox's own pages.", "cross_origin");
  }
  return null;
}

/**
 * A refusal from the library, as an HTTP answer.
 *
 * The library's `code` travels beside the HTTP kind so the dialog can word each
 * one in the owner's language, and the box's own English sentence is what an
 * older page falls back to. The status table is the library's, so the route and
 * the tests cannot disagree about which refusals are the request's fault (400 /
 * 403) and which are the box's (500).
 */
function failed(err: unknown) {
  if (err instanceof ProjectDeleteError) {
    const status = PROJECT_DELETE_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.message, kind: err.code, code: err.code }, { status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Could not remove that project folder", kind: "failed" },
    { status: 500 },
  );
}

/**
 * The most this route will read before it decides anything.
 *
 * A body here is two folder names and two flags. `readJsonObject` meters what
 * actually arrives as well as what the caller declared, the way the secrets
 * route does, so a chunked body that announces nothing is still bounded.
 */
const MAX_BODY_BYTES = 4_096;
const TOO_LONG = "That request is larger than one project name can be.";

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await previewProjectDelete({
      folder: query.get("folder") ?? undefined,
      kind: query.get("kind") ?? undefined,
    }));
  } catch (err) {
    return failed(err);
  }
}

export async function DELETE(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  // Asked before the body is read at all, so an oversized request is refused at
  // the door rather than after this appliance has buffered it.
  if (declaredTooLong(request, MAX_BODY_BYTES)) return refuse(413, "invalid", TOO_LONG, "invalid");

  const query = new URL(request.url).searchParams;
  let folder: unknown = query.get("folder") ?? undefined;
  let kind: unknown = query.get("kind") ?? undefined;
  let confirm: unknown = query.get("confirm") ?? undefined;
  let force: unknown = query.get("force") === "true";
  // A DELETE may carry a body and not every client sends one, exactly as on the
  // secrets route: the query is read first so a caller that cannot send a body
  // still works, and the body wins when it names a folder, because that is the
  // shape the app itself posts.
  if (folder === undefined) {
    const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
    if (!read.ok) {
      return read.reason === "too_long"
        ? refuse(413, "invalid", TOO_LONG, "invalid")
        : refuse(400, "invalid", "Invalid body. Expected { folder, kind?, confirm, force? }.", "invalid");
    }
    folder = read.body?.folder;
    kind = read.body?.kind;
    confirm = read.body?.confirm;
    force = read.body?.force === true;
  }

  try {
    const outcome = await deleteProject({ folder, kind, confirm, force });
    // The NAME and where it went, never the owner's file list — this line goes
    // to the journal, which is a place a project's contents do not belong.
    console.error(
      `[coding-agent] project ${outcome.folder} moved to ${outcome.trashName} by the owner`
      + `${outcome.forced ? " (forced past unsaved work)" : ""}`,
    );
    // The re-read listing travels with the answer so the app redraws from the
    // box rather than from its own optimism. A listing that throws must not turn
    // a removal that WORKED into a 500, so its failure is an absent field.
    //
    // `projectsDirectory` and NOT `directory`: the outcome already carries a
    // `directory` — the folder that was REMOVED — and spreading the listing's
    // own root over it answered the owner's project folder as the place the
    // project had been (caught driving the live route). Two different facts,
    // two names.
    const projects = await listProjects().catch(() => null);
    return NextResponse.json({
      ...outcome,
      ...(projects ? { projects: projects.projects, projectsDirectory: projects.directory } : {}),
    });
  } catch (err) {
    return failed(err);
  }
}
