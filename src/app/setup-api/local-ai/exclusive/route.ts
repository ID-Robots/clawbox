export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { get, set, setMany } from "@/lib/config-store";
import { readConfig, restartGateway, runOpenclawConfigSet } from "@/lib/openclaw-config";

const SAVED_PRIMARY_KEY = "local_only_saved_primary";
const SAVED_FALLBACKS_KEY = "local_only_saved_fallbacks";
const MODE_KEY = "local_only_mode";

// Route OpenClaw config mutations through the shared retry-aware helper.
// The gateway reload + gateway-pre-start.sh write the same config file
// concurrently, so a bare `openclaw config set` here can fail with
// ConfigMutationConflictError mid-toggle — leaving the primary model
// flipped but fallbacks still populated, and local_only_mode unset.
// That half-applied state is visible in the UI as a failed toggle while
// the user's chat actually continues routing to the cloud fallback.
async function setConfig(key: string, valueJson: string) {
  // Leave timeoutMs on the helper's default — the OpenClaw CLI takes
  // 10-12 s per invocation on Jetson, so tighter bounds here produced
  // spurious "timed out" errors that made Local-only mode fail to toggle.
  await runOpenclawConfigSet([key, valueJson, "--json"]);
}

export async function GET() {
  const enabled = !!(await get(MODE_KEY));
  return NextResponse.json({ enabled });
}

export async function POST(request: Request) {
  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  try {
    const currentMode = !!(await get(MODE_KEY));
    if (currentMode === body.enabled) {
      return NextResponse.json({ enabled: body.enabled });
    }

    if (body.enabled) {
      const localModel = (await get("local_ai_model")) as string | undefined;
      if (!localModel) {
        return NextResponse.json({ error: "Local AI is not configured" }, { status: 400 });
      }
      const config = await readConfig();
      const currentPrimary = config.agents?.defaults?.model?.primary ?? null;
      const currentFallbacks = config.agents?.defaults?.model?.fallbacks ?? [];
      if (currentPrimary && !currentPrimary.startsWith("llamacpp/") && !currentPrimary.startsWith("ollama/")) {
        await set(SAVED_PRIMARY_KEY, currentPrimary);
      }
      if (Array.isArray(currentFallbacks) && currentFallbacks.length > 0) {
        await set(SAVED_FALLBACKS_KEY, currentFallbacks);
      }
      await setConfig("agents.defaults.model.primary", JSON.stringify(localModel));
      await setConfig("agents.defaults.model.fallbacks", "[]");
      await set(MODE_KEY, true);
    } else {
      const savedPrimary = (await get(SAVED_PRIMARY_KEY)) as string | undefined;
      const savedFallbacks = (await get(SAVED_FALLBACKS_KEY)) as string[] | undefined;
      if (savedPrimary) {
        await setConfig("agents.defaults.model.primary", JSON.stringify(savedPrimary));
      }
      if (Array.isArray(savedFallbacks) && savedFallbacks.length > 0) {
        await setConfig("agents.defaults.model.fallbacks", JSON.stringify(savedFallbacks));
      }
      await setMany({
        [SAVED_PRIMARY_KEY]: undefined,
        [SAVED_FALLBACKS_KEY]: undefined,
        [MODE_KEY]: undefined,
      });
    }

    let restartWarning: string | undefined;
    try {
      await restartGateway();
    } catch (err) {
      restartWarning = err instanceof Error ? err.message : String(err);
      console.error("Failed to restart gateway after exclusive config change:", err);
    }

    return NextResponse.json({
      enabled: body.enabled,
      ...(restartWarning ? { warning: `Gateway restart failed: ${restartWarning}` } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to toggle local-only mode" },
      { status: 500 },
    );
  }
}
