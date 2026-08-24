import { NextResponse } from "next/server";
import { collectBuildIdentity } from "@/lib/build-identity";

export const dynamic = "force-dynamic";

/**
 * What this box is really running: the commit the deployed build was made
 * from, the commit checked out on disk, the tested branch it is pinned to,
 * and whether those three agree.
 *
 * Auth-gated by src/middleware.ts like every other /setup-api/* route.
 *
 * Cached briefly because the About screen and the drift banner both poll it
 * and each miss costs a handful of `git` subprocesses; 30s is short enough
 * that a rebuild is reflected before anyone can act on the old answer.
 */
const CACHE_TTL_MS = 30_000;

let cached: { at: number; body: Awaited<ReturnType<typeof collectBuildIdentity>> } | null = null;

export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    if (force || !cached || Date.now() - cached.at > CACHE_TTL_MS) {
      cached = { at: Date.now(), body: await collectBuildIdentity() };
    }
    return NextResponse.json(cached.body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read build identity" },
      { status: 500 },
    );
  }
}
