import { NextResponse } from "next/server";
import { callGatewayRpc } from "@/lib/openclaw-config";
import { readPrimaryModelRef, switchChatModelAutomatically } from "@/lib/automatic-model-switch";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { forgetPickOfUnavailableModel } from "@/lib/explicit-model-pick";
import {
  markModelUnavailable,
  readChoosableModels,
  readUnavailableModelIds,
} from "@/lib/provider-model-availability";
import {
  handleModelFallback,
  type ModelFallbackDeps,
  type ModelFallbackOutcome,
} from "@/lib/provider-model-fallback";

export const dynamic = "force-dynamic";

/**
 * /setup-api/ai-models/model-fallback — the chat saying "this turn is stuck on
 * a model this account cannot run".
 *
 * The chat sees the core's retry frames for a rate limit, or its
 * `model_not_found` error; the server does not. So the chat hands the run over
 * and this route lets the box act on it (src/lib/provider-model-fallback.ts):
 * confirm a 429 states a limit of ZERO from the gateway's own log, stop the
 * core's retry loop, move the chat to the next newest model and send the turn
 * again, once. A 429 that is an ordinary throttle is answered `handled: false`
 * and the core's retry goes on as before.
 *
 * OWNER-ONLY AND OUR PAGE ONLY, like /setup-api/anthropic/failure: a report
 * stops a run and changes the box's model, and the MCP bearer or another site
 * must not be able to do that with a made-up refusal. That gate is the whole
 * of it: a zero limit is confirmed from the gateway's log, OR from the
 * provider's words the chat forwards (`evidence` — the core passes a short
 * refusal through on its frames), so a signed-in page can claim one. It gains
 * nothing it could not do through `/setup-api/chat/model` and Stop.
 */

function refusal(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

/** How long the chat waits before it is told "moving" rather than "moved". */
const ANSWER_WITHIN_MS = 20_000;

export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) return refusal("Reporting a stuck turn needs a signed-in browser session.", "owner_only", 403);
  if (!isSameOriginRequest(request)) return refusal("A stuck turn can only be reported from this ClawBox's own pages.", "cross_origin", 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json() as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refusal("Invalid request body.", "invalid", 400);
  }

  let decided: ModelFallbackOutcome | null = null;
  const deps: ModelFallbackDeps = {
    logsTail: (params) => callGatewayRpc("logs.tail", params, { timeoutMs: 5_000 }),
    gatewayCall: (method, params) => callGatewayRpc(method, params),
    switchModel: switchChatModelAutomatically,
    readPrimary: readPrimaryModelRef,
    readModels: readChoosableModels,
    readUnavailable: (provider) => readUnavailableModelIds(provider),
    markUnavailable: (provider, modelId, reason) => markModelUnavailable(provider, modelId, reason),
    forgetPick: forgetPickOfUnavailableModel,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onDecided: (outcome) => { decided = outcome; },
  };
  const work = handleModelFallback({
    provider: body.provider,
    model: body.model,
    reason: body.reason,
    evidence: body.evidence,
    sessionKey: body.sessionKey,
    runId: body.runId,
    message: body.message,
  }, deps).catch((err: unknown): ModelFallbackOutcome => {
    console.error("[model-fallback] could not act on a stuck turn:", err instanceof Error ? err.message : err);
    return { handled: false };
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ANSWER_WITHIN_MS);
  });
  const result: ModelFallbackOutcome | "late" = await Promise.race([work, late]);
  if (timer) clearTimeout(timer);
  if (result === "late") {
    const snapshot = decided as ModelFallbackOutcome | null;
    return NextResponse.json(snapshot ? { ...snapshot, pending: true } : { handled: false });
  }
  return NextResponse.json(result);
}
