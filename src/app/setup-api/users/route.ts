import { NextResponse } from "next/server";
import { getSystemUsername } from "@/lib/auth";
import { UserAdminError, createUser, listUsers, removeUser, userHelperAvailable } from "@/lib/clawbox-users";
import { rootStepRepairCommand } from "@/lib/root-step-runner";
import { isolateUserChats } from "@/lib/user-chats";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { sessionIdentity } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

// Settings → Users: list, create and remove the box's ClawBox users, each a
// real Linux account (src/lib/clawbox-users.ts).
//
// A PERSON'S COOKIE ONLY — the owner's or any other ClawBox user's, who all get
// the owner's Settings — and same-origin for the writes, the harness/swap
// guard. Never the MCP bearer middleware also admits to /setup-api: creating
// an OS account with a password, or deleting one with its home folder, is a
// person's decision and never a tool call a prompt could talk the assistant
// into. The owner's own account is the exception for everyone: it cannot be
// removed (`cannot_remove_owner`), and nobody removes the account they are
// signed in as.

function ownerOnly(): NextResponse {
  return NextResponse.json({ error: "Users are managed from a signed-in person's own session.", code: "owner_only" }, { status: 403 });
}

function crossOrigin(): NextResponse {
  return NextResponse.json({ error: "Cross-origin request refused.", code: "cross_origin" }, { status: 403 });
}

function refusal(err: unknown): NextResponse {
  if (err instanceof UserAdminError) {
    // `detail` is the box's own reason (the root step's "Error:" line, the
    // password already cut out of it) and `repairCommand` the one Terminal
    // command that fixes a root side older than this build: the panel shows
    // both under its translated sentence instead of a bare "try again".
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.repairCommand ? { repairCommand: err.repairCommand } : {}),
      },
      { status: err.status },
    );
  }
  console.error("[users] unexpected failure:", err);
  return NextResponse.json({ error: "Something went wrong managing users.", code: "internal" }, { status: 500 });
}

async function listing(request: Request) {
  const [users, me, helperOk] = await Promise.all([listUsers(), sessionIdentity(request), userHelperAvailable()]);
  return {
    owner: { username: getSystemUsername() },
    users: users.map((u) => ({ username: u.username, createdAt: u.createdAt })),
    currentUser: me?.username ?? getSystemUsername(),
    // Whether a second user could sign in on this box right now: the sign-in
    // helper and its grant are what an x64 PC lacked until its one-time repair.
    signIn: helperOk ? { available: true } : { available: false, repairCommand: rootStepRepairCommand() },
  };
}

export async function GET(request: Request) {
  if (!(await hasPersonSession(request))) return ownerOnly();
  try {
    return NextResponse.json(await listing(request), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return refusal(err);
  }
}

export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) return ownerOnly();
  if (!isSameOriginRequest(request)) return crossOrigin();
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  try {
    const created = await createUser(body?.username, body?.password);
    // The box now has more than one person: keep the assistant's own session
    // tools to each person's conversations (src/lib/user-chats.ts). Not
    // awaited — the account exists either way, and the native config write
    // can take a few seconds when the gateway is not up to take it.
    void isolateUserChats();
    return NextResponse.json(
      { user: { username: created.username, createdAt: created.createdAt }, ...(await listing(request)) },
      { status: 201 },
    );
  } catch (err) {
    return refusal(err);
  }
}

export async function DELETE(request: Request) {
  if (!(await hasPersonSession(request))) return ownerOnly();
  if (!isSameOriginRequest(request)) return crossOrigin();
  let body: { username?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  if (typeof body?.username !== "string" || !body.username) {
    return NextResponse.json({ error: "username is required", code: "invalid_username" }, { status: 400 });
  }
  try {
    const me = await sessionIdentity(request);
    await removeUser(body.username, { currentUser: me?.username ?? getSystemUsername() });
    return NextResponse.json({ removed: body.username, ...(await listing(request)) });
  } catch (err) {
    return refusal(err);
  }
}
