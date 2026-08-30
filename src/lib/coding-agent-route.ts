/**
 * The shape shared by every route that acts on ONE existing coding run —
 * stop, pause, resume, start-a-draft, discard-a-draft.
 *
 * Each of those used to spell out the same ten steps by hand (session, JSON,
 * the id and its alias, 404, the owner gate, the error mapping), and they had
 * already drifted: two mapped a CodingAgentError to 404-or-500 while three
 * had the full table. One factory, so the next such route cannot drift.
 *
 * THE OWNER GATE. Every route here is agent-callable — the agent started its
 * runs, the agent may end them — with the in-handler gate every
 * state-changing route carries: a run the OWNER started is the owner's, and
 * the agent's bearer gets a 403 for it whatever state it is in, so a
 * prompt-injected "stop that" cannot cut short (or restart) work the person
 * at the desk asked for. The gate is applied by SOURCE alone, ahead of any
 * state check: the library's own rules then answer 400/409 for an action the
 * run's state does not allow. An owner's cookie passes both checks.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, getRun, httpStatusForCodingError } from "@/lib/coding-agent";

/**
 * The run id a request names: `runId` is the documented field, matching the
 * run route's `resumeRunId`; `id` is accepted as an alias — the shape these
 * routes launched with — so nothing already calling them breaks. Trimmed;
 * "" when neither is a string.
 */
export function readRunId(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const b = body as { runId?: unknown; id?: unknown };
  const raw = typeof b.runId === "string" ? b.runId : typeof b.id === "string" ? b.id : "";
  return raw.trim();
}

export interface RunLifecycleRoute {
  /** The verb of the refusal and the fallback error: "stop", "pause", … */
  verb: string;
  /** What the refusal calls the record. A draft is "the owner's", a run "was started by the owner". */
  noun?: "run" | "draft";
  /** Where the id travels: the JSON body (POST) or `?runId=` (DELETE). */
  idFrom?: "body" | "query";
  /** The action itself, once the run exists and the caller may touch it. Answers the response. */
  act: (id: string) => Promise<NextResponse> | NextResponse;
}

/** Build the handler: requireSession → id → 404 → owner gate → act → error mapping. */
export function runLifecycleRoute({ verb, noun = "run", idFrom = "body", act }: RunLifecycleRoute): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const unauthorized = await requireSession(request);
    if (unauthorized) return unauthorized;

    let id: string;
    if (idFrom === "query") {
      id = (new URL(request.url).searchParams.get("runId") ?? "").trim();
    } else {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }
      id = readRunId(body);
    }
    if (!id) return NextResponse.json({ error: "A run id is required." }, { status: 400 });

    try {
      const run = getRun(id);
      if (!run) {
        return NextResponse.json({ error: "There is no coding run with that id.", kind: "not_found" }, { status: 404 });
      }
      if (run.source === "owner" && !(await hasOwnerSession(request))) {
        const whose = noun === "draft" ? "That draft is the owner's" : "That run was started by the owner";
        return NextResponse.json({ error: `${whose}; only they can ${verb} it.`, kind: "owner_only" }, { status: 403 });
      }
      return await act(id);
    } catch (err) {
      if (err instanceof CodingAgentError) {
        return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : `Could not ${verb} the coding run` },
        { status: 500 },
      );
    }
  };
}
