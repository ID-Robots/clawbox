import { NextResponse } from "next/server";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { isSafeBranch } from "@/lib/update-branch";

export const dynamic = "force-dynamic";

const PROJECT_DIR = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");

function isEnoent(err: unknown): boolean {
  return !!(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

export async function GET() {
  try {
    const branch = (await readFile(UPDATE_BRANCH_FILE, "utf-8")).trim();
    return NextResponse.json({ branch: branch || null });
  } catch (err) {
    if (isEnoent(err)) return NextResponse.json({ branch: null });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read update branch" },
      { status: 500 },
    );
  }
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
      return NextResponse.json({ success: true, branch: null });
    }

    // Shared with the updater and mirrored by install.sh — a value accepted
    // here but refused there does not error, it silently resolves to `main`.
    if (typeof branch !== "string" || !isSafeBranch(branch)) {
      return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
    }

    await writeFile(UPDATE_BRANCH_FILE, branch + "\n", "utf-8");
    return NextResponse.json({ success: true, branch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set update branch" },
      { status: 500 },
    );
  }
}
