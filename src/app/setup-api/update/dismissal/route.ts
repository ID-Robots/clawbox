import { NextResponse } from "next/server";
import { sqliteGet, sqliteSet, sqliteDelete } from "@/lib/sqlite-store";

export const dynamic = "force-dynamic";

const KEY = "update:dismissed-versions";
const MAX_FINGERPRINT_LENGTH = 200;

/**
 * GET — read the most recent dismissed-version fingerprint
 *  ("clawboxTarget|openclawTarget"). Used by the desktop to suppress the
 *  "new version available" notification until the next bump.
 */
export async function GET() {
  try {
    return NextResponse.json({ fingerprint: await sqliteGet(KEY) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read dismissal" },
      { status: 500 },
    );
  }
}

/**
 * POST — persist a new dismissal fingerprint, or clear it when omitted.
 */
export async function POST(request: Request) {
  let body: { fingerprint?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (body.fingerprint == null) {
      await sqliteDelete(KEY);
    } else {
      if (typeof body.fingerprint !== "string" || body.fingerprint.length > MAX_FINGERPRINT_LENGTH) {
        return NextResponse.json({ error: "Invalid fingerprint" }, { status: 400 });
      }
      await sqliteSet(KEY, body.fingerprint);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write dismissal" },
      { status: 500 },
    );
  }
}
