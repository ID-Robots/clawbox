export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAll, set } from "@/lib/config-store";

const MIN_STEP = 1;
const MAX_STEP = 6;

function parseStoredStep(value: unknown): number | null {
  const step = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(step)) return null;
  if (step < MIN_STEP || step > MAX_STEP) return null;
  return step;
}

export async function POST(request: Request) {
  let body: { step?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestedStep = parseStoredStep(body.step);
  if (requestedStep === null) {
    return NextResponse.json({ error: "Invalid setup step" }, { status: 400 });
  }

  try {
    const config = await getAll();
    const existingStep = parseStoredStep(config.setup_progress_step);
    const nextStep = existingStep === null ? requestedStep : Math.max(existingStep, requestedStep);
    await set("setup_progress_step", nextStep);
    return NextResponse.json({ success: true, step: nextStep });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save setup progress" },
      { status: 500 },
    );
  }
}
