import { NextResponse } from "next/server";
import { removeRunWorktreeFor } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → remove the run's own copy of the project; answers the record.
 *
 * A run works in a git worktree of its own (src/lib/coding-run-worktree.ts),
 * and the settle removes it when the branch was merged home or the run left
 * nothing on it. Anything else stays on disk — a merge that conflicted, a
 * project the owner had moved to another branch, a pull request still open —
 * because those are commits nothing else has, and a settle that deleted them
 * would be unrecoverable. This is the owner's answer to a copy they no longer
 * need: the FILES go, the branch stays, so the work is still reachable with
 * `git checkout clawbox/<runId>`.
 *
 * Refused while any run is still working in that copy — "stop it first" — and
 * for a run that worked in the project folder itself, which has no copy to
 * remove.
 *
 * The session check, the `id` alias, the 404 and the owner gate are the
 * factory's; see coding-agent-route.ts for why the agent's bearer gets a 403
 * on a run the owner started.
 */
export const POST = runLifecycleRoute({
  verb: "remove the copy of the project for",
  act: async (id) => NextResponse.json({ run: await removeRunWorktreeFor(id) }),
});
