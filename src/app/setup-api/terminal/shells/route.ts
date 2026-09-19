import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { DEFAULT_SHELL, availableShells, readEtcShells } from "@/lib/terminal-shells";

export const dynamic = "force-dynamic";

// GET /setup-api/terminal/shells
//
// The shells the Terminal's settings sheet offers as the default for a new
// tab: those /etc/shells lists that are installed here, one per binary, and
// which one a tab gets when none is chosen. Only a list — the PTY server
// checks the request again when it spawns (scripts/terminal-launch.mjs).
export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return NextResponse.json({ shells: availableShells(readEtcShells()), defaultShell: DEFAULT_SHELL });
}
