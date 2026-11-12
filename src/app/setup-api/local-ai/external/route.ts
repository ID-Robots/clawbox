export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { requireSession } from "@/lib/route-auth";
import { getActiveHarness } from "@/lib/harness";
import {
  HERMES_MIN_CONTEXT_WINDOW,
  parseExternalApiKey,
  validateExternalEngineInput,
} from "@/lib/external-engine-shared";
import {
  externalEngineView,
  probeExternalEngine,
  readExternalEngine,
  readExternalEngineKey,
  NO_KEY_PLACEHOLDER,
} from "@/lib/external-engine";
import { ExternalEngineRefusal, removeExternalEngine, saveExternalEngine } from "@/lib/external-engine-ops";
import { withLocalAiTransitionLock } from "@/lib/local-ai-transition-lock";

/**
 * Settings → Local AI → External engine (TASK-2376), owner only.
 *
 *   GET     the engine as configured (never the key: `apiKeySet` says one is
 *           on file); `?probe=1` adds a live `GET {base}/models` answer.
 *   POST    save: validate the fields, probe the endpoint, then make it the
 *           box's Local AI and the chat's model on the ACTIVE harness.
 *   DELETE  remove: take it out and put the previous Local AI back.
 *
 * The probe without a save is `POST /setup-api/local-ai/external/test`.
 */

function refusal(err: unknown, fallback: string) {
  if (err instanceof ExternalEngineRefusal) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error(`[external-engine] ${fallback}:`, err instanceof Error ? err.message : err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) return unauthorized;
  const [record, harness, localOnly] = await Promise.all([
    readExternalEngine(),
    getActiveHarness(),
    get("local_only_mode").catch(() => false),
  ]);
  const view = externalEngineView(record);
  let status: Record<string, unknown> | undefined;
  if (record && new URL(request.url).searchParams.get("probe") === "1") {
    const key = readExternalEngineKey();
    const probe = await probeExternalEngine({
      baseUrl: record.baseUrl,
      apiKey: key === NO_KEY_PLACEHOLDER ? null : key,
      modelId: record.modelId,
    });
    status = probe.ok
      ? { reachable: true, modelListed: true, latencyMs: probe.latencyMs }
      : { reachable: probe.code !== "unreachable", modelListed: false, code: probe.code, error: probe.error };
  }
  return NextResponse.json(
    {
      ...view,
      activeHarness: harness,
      localOnlyMode: !!localOnly,
      hermesMinContextWindow: HERMES_MIN_CONTEXT_WINDOW,
      // What the Hermes edition does not take from these fields: it has no
      // per-provider output cap or image switch (it decides vision itself), and
      // no reasoning switch either — its custom-provider profile sends the
      // chat's level as `reasoning_effort` on every turn (`none` for Off).
      unsupported: harness === "hermes" ? ["maxTokens", "imageInput", "reasoning"] : [],
      ...(status ? { status } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const valid = validateExternalEngineInput(body);
  if (!valid.ok) return NextResponse.json({ error: valid.error, code: valid.code, field: valid.field }, { status: 400 });
  const key = parseExternalApiKey(body.apiKey);
  if (!key.ok) return NextResponse.json({ error: key.error, code: "invalid_api_key", field: "apiKey" }, { status: 400 });
  try {
    // Under the Local AI transition lock (one save, remove or Local-only
    // switch at a time), NOT the provider-change lock: the save ends in
    // chat/model's own POST, which takes that one itself.
    const outcome = await withLocalAiTransitionLock(() => saveExternalEngine({
      settings: valid.value,
      apiKey: key.key,
      clearApiKey: body.clearApiKey === true,
    }));
    return NextResponse.json({
      success: true,
      ...externalEngineView(outcome.record),
      activeHarness: outcome.harness,
      models: outcome.models,
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    });
  } catch (err) {
    return refusal(err, "Saving the external engine failed");
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) return unauthorized;
  try {
    const outcome = await withLocalAiTransitionLock(() => removeExternalEngine());
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return refusal(err, "Removing the external engine failed");
  }
}
