export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
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
  if (typeof asked.id !== "string" || asked.action !== "dismiss") {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const existing = getBackgroundTask(asked.id);
  if (!existing) return NextResponse.json({ ok: false, code: "unknown_task" }, { status: 404 });
  const task = dismissBackgroundTask(asked.id);
  if (!task) return NextResponse.json({ ok: false, code: "still_running" }, { status: 409 });
  return NextResponse.json({ ok: true, task });
}
