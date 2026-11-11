export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { ExternalEngineRefusal, selectExternalEngine } from "@/lib/external-engine-ops";
import { withLocalAiTransitionLock } from "@/lib/local-ai-transition-lock";

/**
 * POST /setup-api/local-ai/external/select (owner only, TASK-2376): make the
 * external AI engine that is already set up the chat's model on the active
 * harness. The first-boot wizard's "Continue with <model>" when an engine is
 * connected — no llama.cpp or Ollama is installed or started, and nothing is
 * probed. 404 `not_configured` when there is no engine.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) return unauthorized;
  try {
    // Under the Local AI transition lock (not the provider-change lock, which
    // chat/model's own POST takes inside).
    const outcome = await withLocalAiTransitionLock(() => selectExternalEngine());
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    if (err instanceof ExternalEngineRefusal) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("[external-engine] select failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Selecting the external engine failed" }, { status: 500 });
  }
}
