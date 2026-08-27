import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { backupToGitHub, disconnectGitHub, githubStatus } from "@/lib/coding-github";
import { CodingAgentError, resolveWorkingDirectory } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * GET  → whether a GitHub account is connected, and the command that connects
 *        one. Read-only, so middleware's cookie-or-bearer gate is the whole
 *        gate: the assistant needs to know whether a backup is even possible
 *        before offering one.
 *
 * POST { projectId | directory } → push that folder to GitHub, creating a
 *        PRIVATE repository the first time.
 *
 * POST is OWNER-ONLY. A push sends the folder's contents to a server outside
 * the house, and it is not reversible in the way a local commit is — a secret
 * a run wrote into a file by mistake is on GitHub the moment it is pushed,
 * private repo or not. The owner decides that, not a task that may itself
 * have come from an email or a web page.
 *
 * DELETE → disconnect the account. Owner-only for the same reason as the
 *        switch: the agent must not be able to change the owner's credentials,
 *        in either direction.
 *
 * No token is ever handled here. gh holds the credential and lends it to git;
 * this route only asks gh whether it has one.
 */
export async function GET() {
  try {
    return NextResponse.json(await githubStatus());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the GitHub connection" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Disconnecting GitHub needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const out = await disconnectGitHub();
  if (!out.ok) return NextResponse.json({ error: out.detail ?? "Could not disconnect" }, { status: 500 });
  console.error("[coding-agent] GitHub disconnected by the owner");
  return NextResponse.json(await githubStatus());
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Backing up to GitHub needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  // Same guard as the enable route: a JSON string or number is valid JSON
  // and reading fields off it must answer 400, not crash into a 500.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = body as { projectId?: unknown; directory?: unknown };

  try {
    // The same resolver a run uses, so a backup cannot reach a folder a run
    // could not have worked in.
    const { directory } = await resolveWorkingDirectory({
      projectId: typeof fields.projectId === "string" ? fields.projectId : null,
      directory: typeof fields.directory === "string" ? fields.directory : null,
    });
    const outcome = await backupToGitHub(directory);
    if (!outcome.pushed) {
      return NextResponse.json({ error: outcome.detail ?? outcome.reason, kind: outcome.reason }, { status: 409 });
    }
    console.error(`[coding-agent] backed up ${directory} to ${outcome.repo}${outcome.created ? " (new repo)" : ""}`);
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: err.kind === "not_found" ? 404 : 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not back up to GitHub" },
      { status: 500 },
    );
  }
}
