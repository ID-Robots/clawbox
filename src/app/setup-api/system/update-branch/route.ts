import { NextResponse } from "next/server";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { CLAWBOX_ROOT } from "@/lib/runtime-paths";

export const dynamic = "force-dynamic";

const PROJECT_DIR = CLAWBOX_ROOT;
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");
const SAFE_BRANCH = /^[A-Za-z0-9._\-/]+$/;

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
