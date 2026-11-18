export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { AUDIT_READ_MAX, readAuditLog } from "@/lib/audit-log";
import { personSession } from "@/lib/owner-session";

/**
 * /setup-api/settings/audit-log — the box's sign-ins and administrator
 * actions (src/lib/audit-log.ts), newest first, for the OWNER's session only:
 * it names every user and where they signed in from. Read-only — there is no
 * way to change or delete a line through this box.
 *
 * GET `?limit=N` (1–1000, default 200) → `{ entries: AuditEntry[], more }`.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) {
    return NextResponse.json(
      { error: "Only the box owner can read the audit log.", code: "owner_only" },
      { status: 403, headers: NO_STORE },
    );
  }
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? "");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, AUDIT_READ_MAX) : 200;
  try {
    return NextResponse.json(await readAuditLog({ limit }), { headers: NO_STORE });
  } catch (err) {
    console.error("[audit-log] the audit log could not be read:", (err as NodeJS.ErrnoException)?.code ?? "error");
    return NextResponse.json(
      { error: "The audit log could not be read on this ClawBox.", code: "audit_log_unreadable" },
      { status: 500, headers: NO_STORE },
    );
  }
}
