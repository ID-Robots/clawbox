import { NextResponse } from "next/server";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "@/lib/runtime-path";
import { isSafeBranch } from "@/lib/update-branch";
import { resolveEffectiveUpdateBranch, type EffectiveUpdateBranch } from "@/lib/updater";

export const dynamic = "force-dynamic";

const PROJECT_DIR = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");

function isEnoent(err: unknown): boolean {
  return !!(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

/**
 * The branch this box actually follows — what Advanced options shows beside
 * the recorded one, so a box with nothing recorded says "main" rather than
 * leaving its owner to guess what to enter (TASK-1213).
 *
 * Best-effort: the recorded branch is the answer this route exists for, and a
 * git hiccup working out the effective one must not turn it into a 500.
 */
async function effectiveBranch(): Promise<EffectiveUpdateBranch | null> {
  try {
    return await resolveEffectiveUpdateBranch(PROJECT_DIR);
  } catch {
    return null;
  }
}

export async function GET() {
  let branch: string | null;
  try {
    branch = (await readFile(UPDATE_BRANCH_FILE, "utf-8")).trim() || null;
  } catch (err) {
    if (!isEnoent(err)) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to read update branch" },
        { status: 500 },
      );
    }
    branch = null;
  }
  return NextResponse.json({ branch, effective: await effectiveBranch() });
}

export async function POST(request: Request) {
  try {
    const { branch } = await request.json();

    if (branch === null || branch === "") {
      // Clear the pinned branch (revert to default behavior)
      try {
        await unlink(UPDATE_BRANCH_FILE);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      return NextResponse.json({ success: true, branch: null, effective: await effectiveBranch() });
    }

    // Shared with the updater and mirrored by install.sh — a value accepted
    // here but refused there does not error, it silently resolves to `main`.
    if (typeof branch !== "string" || !isSafeBranch(branch)) {
      return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
    }

    await writeFile(UPDATE_BRANCH_FILE, branch + "\n", "utf-8");
    return NextResponse.json({ success: true, branch, effective: await effectiveBranch() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set update branch" },
      { status: 500 },
    );
  }
}
