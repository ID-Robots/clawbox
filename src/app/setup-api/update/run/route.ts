import { NextResponse } from "next/server";
import { startUpdate, isUpdateCompleted } from "@/lib/updater";

export async function POST(request: Request) {
  try {
    let force = false;
    try {
      const body = await request.json();
      force = !!body.force;
    } catch {
      // No body or invalid JSON — that's fine
    }

    if (!force) {
      const alreadyDone = await isUpdateCompleted();
      if (alreadyDone) {
        return NextResponse.json({ started: false, already_completed: true });
      }
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
