import { NextResponse } from "next/server";
import { unknownUpdateWhatsNew } from "@/lib/update-whats-new";
import { readUpdateWhatsNew } from "@/lib/update-whats-new-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET: the version this box's update installs and the Highlights of its
 * release notes, for the /updating screen's "What's new" panel (TASK-1205).
 * See `UpdateWhatsNew` in `@/lib/update-whats-new`.
 *
 * Read-only, and NEVER A 500. The panel is secondary to the step list, and
 * every failure here already has an answer the screen knows how to draw —
 * `source: "none"`, which it turns into its own highlights or one plain line
 * and a link to the release page.
 */
export async function GET() {
  try {
    return NextResponse.json(await readUpdateWhatsNew(), { headers: NO_STORE });
  } catch (err) {
    console.warn(
      "[update-whats-new] could not answer; the screen falls back:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(unknownUpdateWhatsNew(), { headers: NO_STORE });
  }
}
