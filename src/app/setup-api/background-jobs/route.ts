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
  let body: { id?: unknown; enabled?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; enabled?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const id = IDS.find((candidate) => candidate === body.id);
  if (!id || typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }

  let status;
  try {
    status = await setBackgroundJob(id, body.enabled);
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
