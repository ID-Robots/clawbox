import { NextResponse } from "next/server";
import { listProjects } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * GET → { directory, projects: [...] } — every folder with a git history of
 * its own directly inside the owner's project folder, and every code project
 * under data/code-projects (where the New app wizard's handoff lands), newest
 * commit first, each with its name, last commit, which of the two it is,
 * whether it is on the desktop and its newest run. `directory` is the owner's
 * folder alone, null when none is set, so the app can say that in words
 * instead of showing an empty list.
 *
 * Read-only, and middleware's cookie-or-bearer gate is the whole gate for it,
 * exactly as for /runs: the assistant is allowed to know what projects exist
 * — that is how it names one to work in.
 */
export async function GET() {
  try {
    return NextResponse.json(await listProjects());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the projects" },
      { status: 500 },
    );
  }
}
