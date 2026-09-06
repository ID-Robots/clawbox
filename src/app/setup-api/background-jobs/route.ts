export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  applyBackgroundJobRestart,
  BackgroundJobError,
  readBackgroundJobs,
  setBackgroundJob,
  type BackgroundJobId,
} from "@/lib/background-jobs";
import { hasOwnerSession } from "@/lib/owner-session";

/**
 * The three background jobs and their switches (TASK-609).
 *
 * GET is readable by anything the middleware admits: it says which of the box's
 * own initiatives are running and names the harness key behind each, and there
 * is nothing in it the agent should not know about itself.
 *
 * POST is OWNER ONLY. Middleware admits the MCP bearer to `/setup-api`, and
 * these switches decide whether the box may message its owner unprompted and
 * spend his subscription on background work — the agent must not be able to
 * switch its own heartbeat back on, for the same reason it cannot open the
 * email approval gate or enable the coding agent.
 */

const IDS: BackgroundJobId[] = ["checkIns", "memoryReview", "skillLearning"];

export async function GET() {
  return NextResponse.json(await readBackgroundJobs(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
  }
  // `null`, `[]` and `"x"` are all valid JSON, and the cast changes nothing at
  // runtime, so reading `.id` off any of them threw out of the handler as an
  // unstructured 500 instead of the 400 this branch is for.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const asked = body as { id?: unknown; enabled?: unknown };
  const id = IDS.find((candidate) => candidate === asked.id);
  if (!id || typeof asked.enabled !== "boolean") {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }

  let status;
  try {
    status = await setBackgroundJob(id, asked.enabled);
  } catch (err) {
    if (err instanceof BackgroundJobError) {
      return NextResponse.json(
        { ok: false, code: err.code },
        { status: err.code === "unsupported" ? 409 : 502 },
      );
    }
    return NextResponse.json({ ok: false, code: "write_failed" }, { status: 502 });
  }

  // The config is already right; the restart is what makes it take effect NOW.
  // Reported rather than awaited into the verdict: a gateway that would not
  // come back does not make the setting untrue, and the panel says which of the
  // two happened instead of collapsing them into one green tick.
  const restarted = await applyBackgroundJobRestart(status.harness);
  return NextResponse.json({ ok: true, restarted, ...status });
}
