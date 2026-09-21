import { NextResponse } from "next/server";
import { killRunLeftovers } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → end whatever a SETTLED run left running; answers the record.
 *
 * A run that finished naturally keeps its process group, on purpose: the
 * orientation guide tells a run to leave its app's server listening so the
 * desktop can reach it, and a settle that killed the group would break the one
 * pattern the device documents for a server-style project. What the run leaves
 * is recorded as `leftover` instead, and this is the gesture that ends it —
 * the owner's, from the run's page, once they no longer need the app running.
 *
 * A run still going is refused with "stop it instead": Stop already ends
 * everything a live run started, and two verbs for one act is the tie a
 * caller breaks wrongly. Idempotent otherwise — a group that is already gone
 * is the state the caller wanted.
 *
 * The session check, the `id` alias, the 404 and the owner gate are the
 * factory's; see coding-agent-route.ts for why the agent's bearer gets a 403
 * on a run the owner started.
 */
export const POST = runLifecycleRoute({
  verb: "kill",
  act: (id) => NextResponse.json({ run: killRunLeftovers(id) }),
});
