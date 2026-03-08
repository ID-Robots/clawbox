import { NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const PROJECT_DIR = "/home/clawbox/clawbox";
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");
const SAFE_BRANCH = /^[A-Za-z0-9._\-/]+$/;

export async function GET() {
  try {
    const branch = (await readFile(UPDATE_BRANCH_FILE, "utf-8")).trim();
    return NextResponse.json({ branch: branch || null });
  } catch {
    return NextResponse.json({ branch: null });
  }
}

export async function POST(request: Request) {
  try {
    const { branch } = await request.json();

    if (branch === null || branch === "") {
      // Clear the pinned branch (revert to default behavior)
      const { unlink } = await import("fs/promises");
      await unlink(UPDATE_BRANCH_FILE).catch(() => {});
      return NextResponse.json({ success: true, branch: null });
    }

    if (typeof branch !== "string" || !SAFE_BRANCH.test(branch)) {
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
