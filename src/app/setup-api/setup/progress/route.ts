export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAll, set } from "@/lib/config-store";
import { parseSetupProgressStep } from "@/lib/setup-progress";

/**
 * What a caller may send: a step outside this wizard is a bad request.
 *
 * The value already on disk is read WITHOUT that bound (`parseSetupProgressStep`
 * on its own below), because a step persisted by a build with more screens than
 * this one is a box to be read, not one whose progress is rewound.
 */
function parseRequestedStep(value: unknown): number | null {
  return parseSetupProgressStep(value, true);
}

export async function POST(request: Request) {
  let body: { step?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestedStep = parseRequestedStep(body.step);
  if (requestedStep === null) {
    return NextResponse.json({ error: "Invalid setup step" }, { status: 400 });
  }

  try {
    const config = await getAll();
    const existingStep = parseSetupProgressStep(config.setup_progress_step);
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
