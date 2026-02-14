import { NextResponse } from "next/server";
import { startUpdate, isUpdateCompleted } from "@/lib/updater";

export async function POST() {
  try {
    const alreadyDone = await isUpdateCompleted();
    if (alreadyDone) {
      return NextResponse.json({ started: false, already_completed: true });
    }

    const result = startUpdate();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start update" },
      { status: 500 }
    );
  }
}
