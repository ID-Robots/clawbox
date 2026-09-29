import { NextResponse } from "next/server";
import { getSystemUsername } from "@/lib/auth";
import { UserAdminError, createUser, listUsers, removeUser } from "@/lib/clawbox-users";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { sessionIdentity } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

// Settings → Users (TASK-1256): list, create and remove the box's ClawBox
// users, each a real Linux account (src/lib/clawbox-users.ts).
//
// OWNER COOKIE ONLY, and same-origin for the writes — the harness/swap guard.
// Not another ClawBox user: they are not the box's administrator. Not the MCP
// bearer middleware also admits to /setup-api: creating an OS account with a
// password, or deleting one with its home folder, is the owner's decision and
// never a tool call a prompt could talk the assistant into.

function ownerOnly(): NextResponse {
  return NextResponse.json({ error: "Only the box owner can manage users.", code: "owner_only" }, { status: 403 });
}

function crossOrigin(): NextResponse {
  return NextResponse.json({ error: "Cross-origin request refused.", code: "cross_origin" }, { status: 403 });
}

function refusal(err: unknown): NextResponse {
  if (err instanceof UserAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("[users] unexpected failure:", err);
  return NextResponse.json({ error: "Something went wrong managing users.", code: "internal" }, { status: 500 });
}

async function listing(request: Request) {
  const [users, me] = await Promise.all([listUsers(), sessionIdentity(request)]);
  return {
    owner: { username: getSystemUsername() },
    users: users.map((u) => ({ username: u.username, createdAt: u.createdAt })),
    currentUser: me?.username ?? getSystemUsername(),
  };
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return ownerOnly();
  try {
    return NextResponse.json(await listing(request), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return refusal(err);
  }
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return ownerOnly();
  if (!isSameOriginRequest(request)) return crossOrigin();
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  try {
    const created = await createUser(body?.username, body?.password);
    return NextResponse.json(
      { user: { username: created.username, createdAt: created.createdAt }, ...(await listing(request)) },
      { status: 201 },
    );
  } catch (err) {
    return refusal(err);
  }
}

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) return ownerOnly();
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
