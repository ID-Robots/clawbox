import { NextResponse } from "next/server";
import { getSystemUsername } from "@/lib/auth";
import { listUsers } from "@/lib/clawbox-users";
import { isTunnelRequest } from "@/lib/host-allowlist";

export const dynamic = "force-dynamic";

// Who can sign in here — the /login page's user picker (TASK-1256).
//
// Anonymous by design: it is asked before anyone has signed in, and /login-api
// is a public prefix in middleware. What it says is kept to what a desktop OS's
// own login screen shows:
//
//   * a box with no users besides the owner answers `multiUser: false` and
//     nothing else, so a single-user box's login page looks exactly as it did
//     and does not even name its owner;
//   * on the LAN a multi-user box lists its usernames, owner first;
//   * over the remote-access tunnel (CF-Connecting-IP, which only survives
//     scripts/proxy-peer.js on a loopback peer) it lists NOBODY — the page asks
//     for a username instead, so the internet is not handed the account names.
//
// Never a password hint, a creation date or anything else from the registry.
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  let users: Awaited<ReturnType<typeof listUsers>>;
  try {
    users = await listUsers();
  } catch {
    users = [];
  }
  if (users.length === 0) {
    return NextResponse.json({ multiUser: false }, { headers });
  }
  if (isTunnelRequest(request.headers)) {
    return NextResponse.json({ multiUser: true, users: null }, { headers });
  }
  return NextResponse.json(
    {
      multiUser: true,
      users: [
        { username: getSystemUsername(), owner: true },
        ...users.map((u) => ({ username: u.username, owner: false })),
      ],
    },
    { headers },
  );
}
