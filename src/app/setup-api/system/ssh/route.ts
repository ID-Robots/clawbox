import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { padResponseTime } from "@/lib/login-rate-limit";
import {
  checkReproveLockout,
  lockoutBuckets,
  reproveOwnerPassword,
} from "@/lib/password-reprove";
import { hasOwnerPassword } from "@/lib/system-password";
import { get } from "@/lib/config-store";
import { isSshActive, requestSshPolicy } from "@/lib/ssh-policy";

export const dynamic = "force-dynamic";

// Settings → System → Remote access (SSH). SSH is off by default; only the
// owner turns it on, and only once an owner password exists (install.sh's
// step_ssh_policy refuses `enable` otherwise, whatever this route says).
//
// OWNER COOKIE ONLY, and same-origin for the write — the users route's guard.
// Not another ClawBox user, and not the MCP bearer: opening a remote shell on
// the box is the owner's decision and never a tool call. Both directions also
// re-prove the current password, on the same throttle and response-time pad
// as the factory reset, because the switch changes who can reach the box.

function ownerOnly(): NextResponse {
  return NextResponse.json({ error: "Only the box owner can change remote access.", code: "owner_only" }, { status: 403 });
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return ownerOnly();
  // The config flag first, as the credentials route does: on an owned box the
  // shadow check would run unix_chkpwd with the legacy password on every
  // Settings visit and leave a failed-password line in auth.log each time.
  // The flag only ever unlocks the DISPLAY here; enabling is decided root-side.
  const ownerFromFlag = !!(await get("password_configured"));
  const [enabled, owner] = await Promise.all([
    isSshActive(),
    ownerFromFlag ? Promise.resolve(true as const) : hasOwnerPassword(),
  ]);
  return NextResponse.json(
    { enabled, ownerPassword: owner === true },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  if (!(await hasOwnerSession(request))) {
    await padResponseTime(startedAt);
    return ownerOnly();
  }
  if (!isSameOriginRequest(request)) {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Cross-origin request refused.", code: "cross_origin" }, { status: 403 });
  }

  const buckets = lockoutBuckets(request);
  const locked = await checkReproveLockout(buckets, startedAt);
  if (locked) return locked;

  let body: { enabled?: unknown; currentPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "`enabled` must be true or false", code: "invalid_request" }, { status: 400 });
  }
  const password = typeof body.currentPassword === "string" ? body.currentPassword : "";

  const refused = await reproveOwnerPassword(password, buckets, startedAt);
  if (refused) return refused;

  if (body.enabled && (await hasOwnerPassword()) !== true) {
    await padResponseTime(startedAt);
    return NextResponse.json(
      { error: "Set a password for the box before turning on SSH.", code: "no_owner_password" },
      { status: 409 },
    );
  }

  try {
    await requestSshPolicy(body.enabled ? "enable" : "disable");
  } catch (err) {
    console.error("[ssh] policy change failed:", err instanceof Error ? err.message : err);
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Could not change remote access.", code: "step_failed" }, { status: 500 });
  }
  await padResponseTime(startedAt);
  return NextResponse.json({ enabled: await isSshActive() });
}
