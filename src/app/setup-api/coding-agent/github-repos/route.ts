import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { listGitHubRepos } from "@/lib/project-import";

export const dynamic = "force-dynamic";

/**
 * GET → { login, repos: [...], truncated } — the repositories the connected
 * GitHub account can see, newest push first, each flagged when it carries a
 * clawbox.json at its root, for the Coding Agent home's "Import from GitHub".
 *
 * OWNER-ONLY: the list names the owner's private repositories, and the
 * account is theirs, not the agent's — the agent has no business browsing it.
 */
export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json({ error: "Browsing GitHub needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  const out = await listGitHubRepos();
  if (!out.ok) {
    const status = out.reason === "not_connected" || out.reason === "no_gh" ? 409 : out.reason === "gh_unreachable" ? 503 : 500;
    return NextResponse.json({ error: out.detail, kind: out.reason }, { status });
  }
  return NextResponse.json({ login: out.login, repos: out.repos, truncated: out.truncated });
}
