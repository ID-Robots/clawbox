export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  DbMaintenanceScheduleError,
  readDbMaintenanceStatus,
  startDbMaintenance,
  writeDbMaintenanceSchedule,
} from "@/lib/openclaw-db-maintenance";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * OpenClaw agent database maintenance (Settings → System).
 *
 * GET: the databases' sizes, which ones a run would compact, whether one is
 * running, the last run and the nightly schedule.
 * POST `{action: "run"}`: start a run now — it stops the gateway only once
 * the core says it is idle, and only when a database needs it.
 * POST `{action: "schedule", enabled?, time?}`: the nightly check's switch and
 * local `HH:MM`.
 *
 * OWNER ONLY, on the owner's own pages: a run stops the gateway, and the
 * middleware admits the agent's MCP bearer to every /setup-api route — the
 * agent must not be able to take its own gateway down.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function ownerOnly() {
  return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403, headers: NO_STORE });
}

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) return ownerOnly();
  try {
    return NextResponse.json({ ok: true, ...(await readDbMaintenanceStatus()) }, { headers: NO_STORE });
  } catch (err) {
    console.warn("[db-maintenance] status failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, code: "status_failed" }, { status: 502, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req)) || !isSameOriginRequest(req)) return ownerOnly();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  const asked = body as { action?: unknown; enabled?: unknown; time?: unknown };

  if (asked.action === "run") {
    const start = await startDbMaintenance("manual");
    if (start.started) {
      return NextResponse.json({ ok: true, started: true, survivesRestart: start.survivesRestart }, { status: 202, headers: NO_STORE });
    }
    const status = start.code === "spawn_failed" ? 502 : 409;
    return NextResponse.json({ ok: false, code: start.code }, { status, headers: NO_STORE });
  }

  if (asked.action === "schedule") {
    try {
      const schedule = await writeDbMaintenanceSchedule({ enabled: asked.enabled, time: asked.time });
      const scheduler = await import("@/lib/openclaw-db-maintenance-scheduler");
      await scheduler.refresh();
      return NextResponse.json({ ok: true, schedule, nextRunAt: scheduler.nextRunAtMs() || null }, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof DbMaintenanceScheduleError) {
        return NextResponse.json({ ok: false, code: "bad_request", error: err.message }, { status: 400, headers: NO_STORE });
      }
      return NextResponse.json({ ok: false, code: "write_failed" }, { status: 502, headers: NO_STORE });
    }
  }

  return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400, headers: NO_STORE });
}
