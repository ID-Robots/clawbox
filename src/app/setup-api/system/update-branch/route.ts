import { NextResponse } from "next/server";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "@/lib/runtime-path";
import { isSafeBranch } from "@/lib/update-branch";
import {
  checkBranchHarnessDowngrade,
  invalidateVersionCache,
  resolveEffectiveUpdateBranch,
  type EffectiveUpdateBranch,
} from "@/lib/updater";
import {
  HARNESS_DOWNGRADE_CODE,
  HARNESS_DOWNGRADE_OVERRIDE_FLAG,
  harnessDowngradeMessage,
  type HarnessDowngradeDetail,
} from "@/lib/harness-downgrade";

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

/**
 * Would following `branch` install an older harness than the one that wrote
 * this box's data? Asked BEFORE the branch is recorded, so a refusal leaves the
 * box exactly as it was (src/lib/harness-downgrade.ts). Best-effort like the
 * effective branch: a check that cannot run is no evidence, and the update
 * asks again before it changes anything.
 */
async function downgradeTo(branch: string): Promise<HarnessDowngradeDetail | null> {
  try {
    return await checkBranchHarnessDowngrade(branch);
  } catch {
    return null;
  }
}

/** 409 with the English sentence and the detail the screen says in the owner's language. */
function refuseDowngrade(detail: HarnessDowngradeDetail) {
  return NextResponse.json(
    { error: harnessDowngradeMessage(detail, "branch"), code: HARNESS_DOWNGRADE_CODE, downgrade: detail },
    { status: 409 },
  );
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
    const body = await request.json();
    const { branch } = body;
    // "Back up and switch anyway": the branch is recorded; the update that
    // follows it still refuses until it is given the same override, which is
    // when the backup is taken (src/lib/updater.ts).
    const allowDowngrade = body?.[HARNESS_DOWNGRADE_OVERRIDE_FLAG] === true;

    if (branch === null || branch === "") {
      // Clear the pinned branch (revert to default behavior). Where that lands
      // is only known once the pin is gone — the checkout's branch, or main —
      // so the pin is put back when that branch would move a harness backwards.
      let previous: string | null = null;
      try {
        previous = await readFile(UPDATE_BRANCH_FILE, "utf-8");
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      try {
        await unlink(UPDATE_BRANCH_FILE);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      const effective = await effectiveBranch();
      if (previous !== null && previous.trim() && effective && !allowDowngrade) {
        const detail = await downgradeTo(effective.branch);
        if (detail) {
          await writeFile(UPDATE_BRANCH_FILE, previous, "utf-8");
          return refuseDowngrade(detail);
        }
      }
      // The cached update verdict was for the branch just cleared; a good
      // answer is held for 30 min (VERSION_INFO_GOOD_TTL), so drop it.
      invalidateVersionCache();
      return NextResponse.json({ success: true, branch: null, effective });
    }

    // Shared with the updater and mirrored by install.sh — a value accepted
    // here but refused there does not error, it silently resolves to `main`.
    if (typeof branch !== "string" || !isSafeBranch(branch)) {
      return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
    }

    if (!allowDowngrade) {
      const detail = await downgradeTo(branch);
      if (detail) return refuseDowngrade(detail);
    }

    await writeFile(UPDATE_BRANCH_FILE, branch + "\n", "utf-8");
    // Same as the clear above: the next version poll must look at THIS branch.
    invalidateVersionCache();
    return NextResponse.json({ success: true, branch, effective: await effectiveBranch() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set update branch" },
      { status: 500 },
    );
  }
}
