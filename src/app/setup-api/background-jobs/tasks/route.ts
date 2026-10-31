export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  cancelBackgroundTask,
  dismissBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
} from "@/lib/background-tasks";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * The long work Settings started, as the server is running it
 * (src/lib/background-tasks.ts) — the desktop's corner card and a reopened
 * Settings both read this. Beside `/setup-api/background-jobs`, which is the
 * harness's own recurring jobs; these are the box's one-off ones.
 *
 * GET              every kept task, newest first (`?kind=` / `?group=` narrow it)
 * GET ?id=<id>     one task, with its whole log ring
 * POST {id, action: "dismiss"}   hide an ENDED task's card (a person's browser, same origin)
 * POST {id, action: "cancel"}    stop a RUNNING task whose work can stop safely
 *                                 (`cancellable`); it ends `cancelled`. 409
 *                                 `not_running` / `not_cancellable` otherwise.
 *
 * Both writes are a person's: the agent holds the MCP bearer the middleware
 * also admits here, and stopping (or hiding) the owner's install is not its
 * call to make.
 *
 * Any signed-in person reads it: every ClawBox user gets the owner's desktop,
 * and the card is that desktop's. The list carries only the last lines of each
 * log, so a poll every two seconds stays small.
 */

const LIST_LOG_LINES = 40;

export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const task = getBackgroundTask(id);
    if (!task) return NextResponse.json({ error: "No such task.", code: "unknown_task" }, { status: 404 });
    return NextResponse.json({ task }, { headers: { "Cache-Control": "no-store" } });
  }
  const kind = url.searchParams.get("kind") ?? undefined;
  const group = url.searchParams.get("group") ?? undefined;
  const tasks = listBackgroundTasks({ kind, group }).map((task) => ({
    ...task,
    log: task.log.slice(-LIST_LOG_LINES),
  }));
  return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasPersonSession(req))) {
    return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, code: "cross_origin" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const asked = body as { id?: unknown; action?: unknown };
  if (typeof asked.id !== "string" || (asked.action !== "dismiss" && asked.action !== "cancel")) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const existing = getBackgroundTask(asked.id);
  if (!existing) return NextResponse.json({ ok: false, code: "unknown_task" }, { status: 404 });
  if (asked.action === "cancel") {
    const cancelled = cancelBackgroundTask(asked.id);
    if (!cancelled.ok) {
      return NextResponse.json({ ok: false, code: cancelled.code }, { status: cancelled.code === "unknown_task" ? 404 : 409 });
    }
    return NextResponse.json({ ok: true, task: cancelled.task });
  }
  const task = dismissBackgroundTask(asked.id);
  if (!task) return NextResponse.json({ ok: false, code: "still_running" }, { status: 409 });
  return NextResponse.json({ ok: true, task });
}
