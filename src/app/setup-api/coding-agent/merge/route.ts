import { NextResponse } from "next/server";
import { bringRunWorkHome } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → bring a settled run's work home: merge `clawbox/<runId>`
 * into the project folder it was asked to work in.
 *
 * WHY THE ROUTE EXISTS. A run works in a copy of the project (a git worktree
 * of its own) and the settle merges that branch back — conservatively, because
 * the project checkout is the owner's: not while the folder has uncommitted
 * changes of its own, not while it is on another branch, never through a
 * conflict. Each of those left the run saying `completed` with its work
 * reachable only as a branch name, and the only control on the card was
 * Remove copy. This is the owner's explicit "now bring it in".
 *
 * OWNER ONLY, AND SAME ORIGIN. Middleware admits every /setup-api/* call on the
 * MCP bearer, and this WRITES THE OWNER'S OWN PROJECT FOLDER — it moves a
 * branch the agent wrote into the tree the owner works in. That is the fence
 * `projects/import` and `permissions` carry, and neither half substitutes for
 * the other: the cookie is what keeps the agent out, the origin check is what
 * keeps another page on the owner's browser from merging while they read it.
 * The factory's own gate (a run the owner started is the owner's) runs first
 * and stays; this narrows it to the owner for EVERY run, agent-started
 * included.
 *
 * It never stashes, discards, forces or resets: a blocker that is still there
 * comes back as a 409 with the same `code` the record carries, so the card can
 * say what to do about it in the owner's language. The run record travels with
 * both answers, so the card redraws from the box's own answer.
 */
export const POST = runLifecycleRoute({
  verb: "bring the work home for",
  act: async (id, _body, request) => {
    if (!(await hasOwnerSession(request))) {
      return NextResponse.json(
        { error: "Bringing a run's work into the project needs a signed-in browser session.", kind: "owner_only", code: "owner_only" },
        { status: 403 },
      );
    }
    if (!isSameOriginRequest(request)) {
      return NextResponse.json(
        { error: "A run's work can only be brought home from this ClawBox's own pages.", kind: "cross_origin", code: "cross_origin" },
        { status: 403 },
      );
    }
    const outcome = await bringRunWorkHome(id);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: `Could not bring the work home: ${outcome.detail}.`, kind: "unmerged", code: outcome.reason, run: outcome.run },
        { status: 409 },
      );
    }
    return NextResponse.json({ merged: outcome.merged, base: outcome.base, commit: outcome.commit, run: outcome.run });
  },
});
